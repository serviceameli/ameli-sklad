-- One order number is one rental lifecycle.
-- This migration intentionally does not change RLS or authorization.

alter table public.orders
  add column if not exists source_active boolean not null default true,
  add column if not exists source_row_count integer not null default 1;

alter table public.shifts
  add column if not exists client_shift_id text;

create unique index if not exists shifts_client_shift_id_uidx
  on public.shifts (client_shift_id) where client_shift_id is not null;

create unique index if not exists shifts_worker_start_uidx
  on public.shifts (worker, start_at);

alter table public.visits
  add column if not exists client_event_id text;

create unique index if not exists visits_client_event_id_uidx
  on public.visits (client_event_id) where client_event_id is not null;

alter table public.visit_orders
  add column if not exists operation text;

alter table public.visit_orders drop constraint if exists visit_orders_operation_check;
alter table public.visit_orders
  add constraint visit_orders_operation_check
  check (operation is null or operation in ('issue', 'return'));

update public.visit_orders vo
set operation = v.operation
from public.visits v
where v.id = vo.visit_id
  and vo.operation is null
  and v.operation in ('issue', 'return');

create unique index if not exists visit_orders_visit_order_uidx
  on public.visit_orders (visit_id, order_no) where order_no is not null;

create or replace view public.order_status as
select
  vo.order_no,
  bool_or(coalesce(vo.operation, v.operation) in ('issue', 'both')) as issued,
  bool_or(coalesce(vo.operation, v.operation) in ('return', 'both')) as returned,
  (array_agg(v.worker order by v.entered_at desc)
    filter (where coalesce(vo.operation, v.operation) in ('issue', 'both')))[1] as issued_by,
  (array_agg(v.worker order by v.entered_at desc)
    filter (where coalesce(vo.operation, v.operation) in ('return', 'both')))[1] as returned_by,
  (array_agg(v.id order by v.entered_at desc)
    filter (where coalesce(vo.operation, v.operation) in ('issue', 'both')))[1] as issued_visit_id,
  (array_agg(v.id order by v.entered_at desc)
    filter (where coalesce(vo.operation, v.operation) in ('return', 'both')))[1] as returned_visit_id
from public.visit_orders vo
join public.visits v on v.id = vo.visit_id
where vo.order_no is not null
group by vo.order_no;

create or replace function public.record_warehouse_visit(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_event_id text := nullif(trim(p_payload->>'clientEventId'), '');
  v_worker text := nullif(trim(p_payload->>'worker'), '');
  v_shift_start timestamptz := (p_payload->>'shiftStart')::timestamptz;
  v_shift_date date := (p_payload->>'shiftDate')::date;
  v_shift_id uuid;
  v_visit_id uuid;
  v_entry jsonb := p_payload->'entry';
  v_order jsonb;
  v_operation text;
begin
  if v_event_id is null or v_worker is null or v_entry is null then
    raise exception 'clientEventId, worker and entry are required';
  end if;

  select id into v_visit_id from public.visits where client_event_id = v_event_id;
  if v_visit_id is not null then
    select shift_id into v_shift_id from public.visits where id = v_visit_id;
    return jsonb_build_object('ok', true, 'idempotent', true,
      'visitId', v_visit_id, 'shiftId', v_shift_id);
  end if;

  insert into public.shifts(worker, shift_date, start_at, is_night, client_shift_id)
  values (v_worker, v_shift_date, v_shift_start,
          coalesce((p_payload->>'isNight') in ('Ночь', 'true'), false),
          nullif(trim(p_payload->>'clientShiftId'), ''))
  on conflict (worker, start_at) do update
    set shift_date = excluded.shift_date,
        client_shift_id = coalesce(public.shifts.client_shift_id, excluded.client_shift_id)
  returning id into v_shift_id;

  insert into public.visits(
    shift_id, worker, visitor, operation, visit_date, visit_time,
    is_night, is_other, comment, entered_at, client_event_id
  ) values (
    v_shift_id, v_worker, v_entry->>'visitor', coalesce(v_entry->>'operation', 'issue'),
    coalesce(nullif(v_entry->>'date', '')::date, v_shift_date),
    coalesce(v_entry->>'time', v_entry->>'timeAuto', ''),
    coalesce((v_entry->>'night') = 'Ночь', false),
    exists(select 1 from jsonb_array_elements(coalesce(v_entry->'orders', '[]'::jsonb)) x
           where x->>'id' = '__other__'),
    coalesce(v_entry->>'comment', ''), now(), v_event_id
  ) returning id into v_visit_id;

  for v_order in select value from jsonb_array_elements(coalesce(v_entry->'orders', '[]'::jsonb))
  loop
    v_operation := coalesce(nullif(v_order->>'operation', ''), nullif(v_order->>'type', ''), v_entry->>'operation');
    if v_operation = 'both' then
      raise exception 'Each order in a mixed visit must have issue or return operation';
    end if;
    insert into public.visit_orders(
      visit_id, order_no, operation, client_snapshot,
      return_date_snapshot, delivery_snapshot
    ) values (
      v_visit_id,
      case when v_order->>'id' = '__other__' then null else v_order->>'id' end,
      case when v_operation in ('issue', 'return') then v_operation else null end,
      coalesce(v_order->>'client', v_entry->>'orderClient', ''),
      nullif(v_order->>'returnDate', '')::date,
      coalesce(v_order->>'delivery', v_entry->>'orderDelivery', '')
    );
  end loop;

  return jsonb_build_object('ok', true, 'idempotent', false,
    'visitId', v_visit_id, 'shiftId', v_shift_id);
exception
  when unique_violation then
    if v_event_id is not null then
      select id, shift_id into v_visit_id, v_shift_id
      from public.visits where client_event_id = v_event_id;
      if v_visit_id is not null then
        return jsonb_build_object('ok', true, 'idempotent', true,
          'visitId', v_visit_id, 'shiftId', v_shift_id);
      end if;
    end if;
    raise;
end;
$$;

create or replace function public.delete_warehouse_visit(p_visit_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.visits where id = p_visit_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Visit % not found', p_visit_id;
  end if;
  return jsonb_build_object('ok', true, 'deletedVisitId', p_visit_id);
end;
$$;

create or replace function public.close_warehouse_shift(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_shift_id uuid;
begin
  update public.shifts
  set end_at = (p_payload->>'shiftEnd')::timestamptz
  where worker = p_payload->>'worker'
    and start_at = (p_payload->>'shiftStart')::timestamptz
  returning id into v_shift_id;

  if v_shift_id is null then
    insert into public.shifts(worker, shift_date, start_at, end_at, is_night, client_shift_id)
    values (p_payload->>'worker', (p_payload->>'shiftDate')::date,
            (p_payload->>'shiftStart')::timestamptz, (p_payload->>'shiftEnd')::timestamptz,
            coalesce((p_payload->>'isNight') in ('Ночь', 'true'), false),
            nullif(trim(p_payload->>'clientShiftId'), ''))
    returning id into v_shift_id;
  end if;

  delete from public.drafts where worker = p_payload->>'worker';
  return jsonb_build_object('ok', true, 'shiftId', v_shift_id);
end;
$$;
