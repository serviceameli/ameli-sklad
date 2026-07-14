-- One order number is one rental lifecycle.
-- This migration intentionally does not change RLS, grants or authorization.

begin;

alter table public.orders
  add column if not exists source_active boolean not null default true,
  add column if not exists source_row_count integer not null default 1,
  add column if not exists source_sync_id text,
  add column if not exists manual_hidden boolean not null default false;

-- Production had a legacy soft-delete column. Preserve that decision in the
-- new read model without requiring the column in fresh installations.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'deleted_at'
  ) then
    execute 'update public.orders set manual_hidden = true where deleted_at is not null';
  end if;
end
$$;

create index if not exists orders_source_sync_idx on public.orders (source_sync_id);

alter table public.shifts
  add column if not exists client_shift_id text;

alter table public.visits
  add column if not exists client_event_id text;

create table if not exists public.warehouse_event_receipts (
  client_event_id text primary key,
  visit_id uuid references public.visits(id) on delete set null,
  status text not null check (status in ('active', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.visit_orders
  add column if not exists operation text;

alter table public.visit_orders drop constraint if exists visit_orders_operation_check;
alter table public.visit_orders
  add constraint visit_orders_operation_check
  check (operation is null or operation in ('issue', 'return'));

create or replace function public.warehouse_effective_operation(
  p_visit_operation text,
  p_order_operation text
)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_order_operation in ('issue', 'return') then p_order_operation
    when p_visit_operation in ('issue', 'pickup', 'Выдача', 'Получение (наш)') then 'issue'
    when p_visit_operation in ('return', 'dropoff', 'Возврат', 'Возврат (наш)') then 'return'
    else null
  end
$$;

create or replace function public.warehouse_safe_timestamptz(p_value text)
returns timestamptz
language plpgsql
immutable
parallel safe
as $$
begin
  return nullif(p_value, '')::timestamptz;
exception when others then
  return null;
end;
$$;

update public.visit_orders vo
set operation = public.warehouse_effective_operation(v.operation, null)
from public.visits v
where v.id = vo.visit_id
  and vo.operation is null
  and public.warehouse_effective_operation(v.operation, null) is not null;

-- Old mixed visits have no reliable per-order operation. Keep their links,
-- ignore them in lifecycle state and surface the visit in reconciliation.
update public.visits v
set is_other = true
where v.operation in ('both', 'Выдача и возврат', 'Получение+Возврат')
  and exists (
    select 1 from public.visit_orders vo
    where vo.visit_id = v.id and vo.order_no is not null and vo.operation is null
  );

-- Fail before creating uniqueness constraints if historical data changed
-- after the dry-run. Nothing is deleted or guessed here.
do $$
begin
  if exists (
    select 1 from public.shifts
    where worker is not null and start_at is not null
    group by worker, start_at having count(*) > 1
  ) then
    raise exception 'Migration preflight: duplicate shifts(worker,start_at) require manual review';
  end if;
  if exists (
    select 1 from public.visit_orders
    where visit_id is not null and order_no is not null
    group by visit_id, order_no having count(*) > 1
  ) then
    raise exception 'Migration preflight: duplicate visit_orders(visit_id,order_no) require manual review';
  end if;
end
$$;

create unique index if not exists shifts_client_shift_id_uidx
  on public.shifts (client_shift_id) where client_shift_id is not null;

create unique index if not exists shifts_worker_start_uidx
  on public.shifts (worker, start_at)
  where worker is not null and start_at is not null;

create unique index if not exists visits_client_event_id_uidx
  on public.visits (client_event_id) where client_event_id is not null;

-- Attach old server drafts to their already-recorded visits. Matching is
-- deliberately exact and unique; ambiguous rows remain untouched. This lets
-- the new client revalidate a restored visit without creating a duplicate.
with draft_items as (
  select d.worker, item.value as item, item.ordinality as ord,
         public.warehouse_safe_timestamptz(d.data->>'shiftStart') as shift_start
  from public.drafts d
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(d.data->'visits') = 'array'
         then d.data->'visits' else '[]'::jsonb end
  ) with ordinality item(value, ordinality)
), candidates as (
  select di.worker, di.ord, v.id,
         count(*) over (partition by di.worker, di.ord) as candidate_count
  from draft_items di
  join public.shifts s on s.worker = di.worker and s.start_at = di.shift_start
  join public.visits v on v.shift_id = s.id
    and v.visitor is not distinct from di.item->>'visitor'
    and coalesce(public.warehouse_effective_operation(v.operation, null), v.operation)
        is not distinct from
        coalesce(public.warehouse_effective_operation(di.item->>'operation', null), di.item->>'operation')
    and v.visit_date is not distinct from nullif(di.item->>'date', '')::date
    and v.visit_time is not distinct from coalesce(nullif(di.item->>'time', ''), nullif(di.item->>'timeAuto', ''))
    and coalesce(v.comment, '') = coalesce(di.item->>'comment', '')
  where coalesce((
          select array_agg(
            case when x.value->>'id' = '__other__' then '' else coalesce(x.value->>'id', '') end
            order by case when x.value->>'id' = '__other__' then '' else coalesce(x.value->>'id', '') end
          )
          from jsonb_array_elements(coalesce(di.item->'orders', '[]'::jsonb)) x(value)
        ), array[]::text[])
        = coalesce((
          select array_agg(coalesce(vo.order_no, '') order by coalesce(vo.order_no, ''))
          from public.visit_orders vo where vo.visit_id = v.id
        ), array[]::text[])
), matches as (
  select worker, ord, id from candidates where candidate_count = 1
), tagged as (
  update public.visits v
  set client_event_id = coalesce(v.client_event_id, 'visit-migrated-' || v.id::text)
  from matches m
  where v.id = m.id
  returning v.id, v.client_event_id
), resolved as (
  select m.worker, m.ord, t.id, t.client_event_id
  from matches m join tagged t on t.id = m.id
), rebuilt_drafts as (
  select d.worker, jsonb_agg(
    case when r.id is null then item.value
         else item.value || jsonb_build_object(
           'clientEventId', r.client_event_id,
           'visitId', r.id
         ) end
    order by item.ordinality
  ) as visits
  from public.drafts d
  cross join lateral jsonb_array_elements(d.data->'visits')
    with ordinality item(value, ordinality)
  left join resolved r on r.worker = d.worker and r.ord = item.ordinality
  where jsonb_typeof(d.data->'visits') = 'array'
  group by d.worker
)
update public.drafts d
set data = jsonb_set(d.data, '{visits}', rebuilt.visits, true)
from rebuilt_drafts rebuilt
where d.worker = rebuilt.worker
  and rebuilt.visits is not null
  and exists (select 1 from resolved r where r.worker = d.worker);

insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
select client_event_id, id, 'active'
from public.visits
where client_event_id is not null
on conflict (client_event_id) do update
set visit_id = excluded.visit_id,
    status = 'active',
    updated_at = now();

create unique index if not exists visit_orders_visit_order_uidx
  on public.visit_orders (visit_id, order_no) where order_no is not null;

create index if not exists visit_orders_order_operation_idx
  on public.visit_orders (order_no, operation) where order_no is not null;

create or replace view public.order_status
with (security_invoker = true)
as
select
  vo.order_no,
  coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'), false) as issued,
  coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'return'), false) as returned,
  (array_agg(v.worker order by v.entered_at desc)
    filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'))[1] as issued_by,
  (array_agg(v.worker order by v.entered_at desc)
    filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'return'))[1] as returned_by,
  (array_agg(v.id order by v.entered_at desc)
    filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'))[1] as issued_visit_id,
  (array_agg(v.id order by v.entered_at desc)
    filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'return'))[1] as returned_visit_id
from public.visit_orders vo
join public.visits v on v.id = vo.visit_id
where vo.order_no is not null
group by vo.order_no;

create or replace view public.warehouse_order_events
with (security_invoker = true)
as
select
  vo.visit_id,
  vo.order_no,
  public.warehouse_effective_operation(v.operation, vo.operation) as operation,
  v.visit_date
from public.visit_orders vo
join public.visits v on v.id = vo.visit_id
where vo.order_no is not null;

-- Read models are returned by one SQL statement so the UI never combines
-- rows from different database snapshots while a visit is being written.
create or replace function public.warehouse_staff_snapshot(
  p_worker text default null,
  p_today date default current_date,
  p_other_since date default current_date - 2
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'workers', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.name)
      from (select name from public.workers where active = true) x
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.order_no)
      from (
        select o.order_no, o.client, o.company, o.issue_date, o.issue_time,
               o.return_date, o.return_time, o.delivery_worker, o.site_status,
               o.source_active, o.manual_hidden, false as lifecycle_ambiguous
        from public.orders o
        left join public.order_status os on os.order_no = o.order_no
        where o.manual_hidden = false
          and (
            o.source_active = true
            or (coalesce(os.issued, false) and not coalesce(os.returned, false))
            or exists (
              select 1 from public.warehouse_order_events today_event
              where today_event.order_no = o.order_no and today_event.visit_date = p_today
            )
          )
          and not exists (
            select 1 from public.visit_orders unresolved
            where unresolved.order_no = o.order_no and unresolved.operation is null
          )
      ) x
    ), '[]'::jsonb),
    'statuses', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.order_no)
      from (
        select order_no, issued, returned, issued_by, returned_by
        from public.order_status
      ) x
    ), '[]'::jsonb),
    'draft', (
      select d.data from public.drafts d
      where p_worker is not null and d.worker = p_worker
      limit 1
    ),
    'otherRows', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.visit_date, x.visit_time, x.id)
      from (
        select id, visitor, operation, visit_time, visit_date, worker, comment
        from public.visits
        where is_other = true and visit_date = p_today
      ) x
    ), '[]'::jsonb),
    'otherLinks', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.visit_id, x.id)
      from (
        select id, visit_id, operation
        from public.visit_orders
        where order_no is null
      ) x
    ), '[]'::jsonb),
    'todayEvents', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.order_no, x.operation, x.visit_id)
      from (
        select visit_id, order_no, operation
        from public.warehouse_order_events
        where visit_date = p_today
      ) x
    ), '[]'::jsonb)
  )
$$;

create or replace function public.warehouse_dashboard_snapshot(
  p_from_date date default current_date - 90
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'shifts', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.shift_date desc, x.start_at desc, x.id)
      from (
        select * from public.shifts
        where shift_date >= p_from_date - 1
           or id in (
             select distinct shift_id from public.visits
             where visit_date >= p_from_date and shift_id is not null
           )
      ) x
    ), '[]'::jsonb),
    'visits', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.visit_date, x.visit_time, x.id)
      from (
        select * from public.visits
        where visit_date >= p_from_date
      ) x
    ), '[]'::jsonb),
    'visitOrders', coalesce((
      select jsonb_agg(to_jsonb(vo) order by vo.visit_id, vo.id)
      from public.visit_orders vo
      join public.visits v on v.id = vo.visit_id
      where v.visit_date >= p_from_date
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.order_no)
      from (
        select o.order_no, o.client, o.company, o.issue_date, o.issue_time,
               o.return_date, o.return_time, o.delivery_worker, o.site_status,
               o.source_active, o.manual_hidden,
               exists (
                 select 1 from public.visit_orders unresolved
                 where unresolved.order_no = o.order_no and unresolved.operation is null
               ) as lifecycle_ambiguous
        from public.orders o
        left join public.order_status os on os.order_no = o.order_no
        where o.source_active = true
           or o.manual_hidden = true
           or (coalesce(os.issued, false) and not coalesce(os.returned, false))
           or exists (
             select 1 from public.warehouse_order_events period_event
             where period_event.order_no = o.order_no and period_event.visit_date >= p_from_date
           )
      ) x
    ), '[]'::jsonb),
    'statuses', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.order_no)
      from (
        select order_no, issued, returned, issued_by, returned_by
        from public.order_status
      ) x
    ), '[]'::jsonb)
  )
$$;

-- One statement for the whole reconciliation screen. Event counts are kept
-- here because the boolean order_status view cannot reveal historical
-- duplicate issues/returns or a return recorded before the issue.
create or replace function public.warehouse_reconciliation_snapshot(
  p_today date default current_date
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with ambiguous_orders as (
    select order_no, array_agg(visit_id order by visit_id) as unresolved_visit_ids
    from public.visit_orders
    where order_no is not null and operation is null
    group by order_no
  ), event_rows as (
    select
      vo.order_no,
      public.warehouse_effective_operation(v.operation, vo.operation) as operation,
      case
        when v.visit_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
          then v.visit_date::timestamp + v.visit_time::time
        else v.visit_date::timestamp
      end as event_at
    from public.visit_orders vo
    join public.visits v on v.id = vo.visit_id
    where vo.order_no is not null
      and public.warehouse_effective_operation(v.operation, vo.operation) is not null
  ), event_state as (
    select
      order_no,
      count(*) filter (where operation = 'issue')::integer as issue_count,
      count(*) filter (where operation = 'return')::integer as return_count,
      min(event_at) filter (where operation = 'issue') as first_issue_at,
      min(event_at) filter (where operation = 'return') as first_return_at
    from event_rows
    group by order_no
  ), classified as (
    select
      o.order_no,
      o.client,
      o.issue_date,
      o.return_date,
      (a.order_no is not null) as lifecycle_ambiguous,
      coalesce(a.unresolved_visit_ids, array[]::uuid[]) as unresolved_visit_ids,
      coalesce(es.issue_count, 0) as issue_count,
      coalesce(es.return_count, 0) as return_count,
      case
        when a.order_no is not null then 'ambiguous_operation'
        when coalesce(es.return_count, 0) > 0 and coalesce(es.issue_count, 0) = 0
          then 'inconsistent'
        when coalesce(es.issue_count, 0) > 1 then 'duplicate_issue'
        when coalesce(es.return_count, 0) > 1 then 'duplicate_return'
        when es.first_return_at is not null and es.first_issue_at is not null
             and es.first_return_at < es.first_issue_at then 'return_before_issue'
        when coalesce(es.issue_count, 0) = 0 and o.issue_date is not null and o.issue_date <= p_today
          then 'missing_issue'
        when coalesce(es.issue_count, 0) > 0 and coalesce(es.return_count, 0) = 0
             and o.return_date is not null and o.return_date <= p_today
          then 'missing_return'
        else null
      end as category
    from public.orders o
    left join event_state es on es.order_no = o.order_no
    left join ambiguous_orders a on a.order_no = o.order_no
    where (o.source_active = true
           or (coalesce(es.issue_count, 0) > 0 and coalesce(es.return_count, 0) = 0)
           or a.order_no is not null)
      and (o.manual_hidden = false or a.order_no is not null)
  )
  select jsonb_build_object(
    'unmatchedVisits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'visitKey', v.id,
        'shiftDate', coalesce(s.shift_date, v.visit_date),
        'time', v.visit_time,
        'worker', coalesce(v.worker, s.worker, ''),
        'isNight', case when v.is_night then 'Ночь' else 'День' end,
        'visitor', v.visitor,
        'operation', v.operation,
        'comment', coalesce(v.comment, ''),
        'orders', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', vo.order_no,
            'operation', public.warehouse_effective_operation(v.operation, vo.operation)
          ) order by vo.order_no)
          from public.visit_orders vo
          where vo.visit_id = v.id and vo.order_no is not null
        ), '[]'::jsonb)
      ) order by v.visit_date desc, v.visit_time desc, v.id)
      from public.visits v
      left join public.shifts s on s.id = v.shift_id
      where v.is_other = true
    ), '[]'::jsonb),
    'linkCandidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.order_no,
        'client', coalesce(c.client, ''),
        'issueDate', c.issue_date,
        'returnDate', c.return_date,
        'orderType', case
          when c.issue_count = 0 then 'issue'
          when c.return_count = 0 then 'return'
          else null
        end,
        'ambiguous', c.lifecycle_ambiguous,
        'unresolvedVisitIds', c.unresolved_visit_ids
      ) order by c.issue_date nulls last, c.return_date nulls last, c.order_no)
      from classified c
      where not c.lifecycle_ambiguous
        and (c.issue_count = 0 or c.return_count = 0)
    ), '[]'::jsonb),
    'lifecycleViolations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.order_no,
        'client', coalesce(c.client, ''),
        'issueDate', c.issue_date,
        'returnDate', c.return_date,
        'category', c.category,
        'issueCount', c.issue_count,
        'returnCount', c.return_count,
        'ambiguous', c.lifecycle_ambiguous,
        'orderType', case
          when c.category = 'missing_return' then 'return'
          when c.category in ('missing_issue', 'inconsistent') then 'issue'
          else null
        end
      ) order by c.return_date nulls last, c.issue_date nulls last, c.order_no)
      from classified c where c.category is not null
    ), '[]'::jsonb)
  )
$$;

create or replace function public.warehouse_worker_history_snapshot(p_worker text)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'shifts', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.start_at desc, s.id)
      from public.shifts s where s.worker = p_worker
    ), '[]'::jsonb),
    'visits', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.visit_date, v.visit_time, v.id)
      from public.visits v where v.worker = p_worker
    ), '[]'::jsonb),
    'visitOrders', coalesce((
      select jsonb_agg(to_jsonb(vo) order by vo.visit_id, vo.id)
      from public.visit_orders vo
      join public.visits v on v.id = vo.visit_id
      where v.worker = p_worker
    ), '[]'::jsonb)
  )
$$;

-- After this structural migration and before cleanup, backups can be exported
-- from one PostgreSQL statement/snapshot instead of several independent GETs.
create or replace function public.warehouse_backup_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.order_no) from public.orders x), '[]'::jsonb),
    'workers', coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from public.workers x), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.shifts x), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.visits x), '[]'::jsonb),
    'visit_orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.visit_orders x), '[]'::jsonb),
    'drafts', coalesce((select jsonb_agg(to_jsonb(x) order by x.worker) from public.drafts x), '[]'::jsonb),
    'order_status', coalesce((select jsonb_agg(to_jsonb(x) order by x.order_no) from public.order_status x), '[]'::jsonb),
    'warehouse_event_receipts', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.client_event_id) from public.warehouse_event_receipts x
    ), '[]'::jsonb)
  )
$$;

create or replace function public.record_warehouse_visit(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_event_id text := nullif(trim(p_payload->>'clientEventId'), '');
  v_worker text := nullif(trim(p_payload->>'worker'), '');
  v_shift_start timestamptz;
  v_shift_date date;
  v_shift_id uuid;
  v_visit_id uuid;
  v_shift_end timestamptz;
  v_reserved_shift_start timestamptz;
  v_entry jsonb := p_payload->'entry';
  v_visit_operation text;
  v_visit_time text;
  v_order jsonb;
  v_order_no text;
  v_operation text;
  v_issued boolean;
  v_returned boolean;
  v_event_status text;
begin
  if v_event_id is null or v_worker is null or v_entry is null
     or jsonb_typeof(v_entry) <> 'object' then
    raise exception 'clientEventId, worker and entry are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_event_id, 2));

  select status, visit_id into v_event_status, v_visit_id
  from public.warehouse_event_receipts
  where client_event_id = v_event_id;
  if found then
    select shift_id into v_shift_id from public.visits where id = v_visit_id;
    return jsonb_build_object('ok', true, 'idempotent', true,
      'deleted', v_event_status = 'deleted' or v_visit_id is null,
      'visitId', v_visit_id, 'shiftId', v_shift_id);
  end if;

  select id, shift_id into v_visit_id, v_shift_id
  from public.visits where client_event_id = v_event_id;
  if v_visit_id is not null then
    insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
    values (v_event_id, v_visit_id, 'active')
    on conflict (client_event_id) do nothing;
    return jsonb_build_object('ok', true, 'idempotent', true,
      'visitId', v_visit_id, 'shiftId', v_shift_id);
  end if;

  v_shift_start := nullif(p_payload->>'shiftStart', '')::timestamptz;
  v_shift_date := nullif(p_payload->>'shiftDate', '')::date;
  if v_shift_start is null or v_shift_date is null then
    raise exception 'shiftStart and shiftDate are required';
  end if;

  -- The current draft is the server-side reservation for one active shift per
  -- worker. Historical open shifts are deliberately ignored: unlike a draft,
  -- they may simply be stale rows left by the legacy implementation.
  perform pg_advisory_xact_lock(hashtextextended(v_worker, 1));
  select public.warehouse_safe_timestamptz(d.data->>'shiftStart')
  into v_reserved_shift_start
  from public.drafts d
  where d.worker = v_worker
  for update;

  if found then
    if v_reserved_shift_start is distinct from v_shift_start
       and not exists (
         select 1 from public.shifts s
         where s.worker = v_worker
           and s.start_at = v_reserved_shift_start
           and s.end_at is not null
       ) then
      raise exception 'Worker % already has another active shift', v_worker;
    end if;
  else
    -- If an offline event reaches the server before its draft autosave, the
    -- event atomically claims the worker reservation. A second device cannot
    -- slip another shift into this gap.
    insert into public.drafts(worker, data, saved_at)
    values (
      v_worker,
      jsonb_build_object(
        'worker', v_worker,
        'shiftStart', p_payload->>'shiftStart',
        'clientShiftId', nullif(trim(p_payload->>'clientShiftId'), ''),
        'visits', '[]'::jsonb,
        'savedAt', clock_timestamp()
      ),
      clock_timestamp()
    );
    v_reserved_shift_start := v_shift_start;
  end if;

  if jsonb_typeof(coalesce(v_entry->'orders', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(v_entry->'orders', '[]'::jsonb)) = 0 then
    raise exception 'At least one order is required';
  end if;

  v_visit_operation := case
    when v_entry->>'operation' in ('issue', 'pickup') then 'issue'
    when v_entry->>'operation' in ('return', 'dropoff') then 'return'
    when v_entry->>'operation' = 'both' then 'both'
    else null
  end;
  if v_visit_operation is null then
    raise exception 'Unknown visit operation: %', v_entry->>'operation';
  end if;
  if coalesce(v_entry->>'visitor', '') not in ('client', 'yandex', 'our') then
    raise exception 'Unknown visitor type: %', v_entry->>'visitor';
  end if;
  v_visit_time := coalesce(nullif(v_entry->>'time', ''), nullif(v_entry->>'timeAuto', ''));
  if v_visit_time is null or v_visit_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Visit time must be HH:MM';
  end if;

  insert into public.shifts(worker, shift_date, start_at, is_night, client_shift_id)
  values (v_worker, v_shift_date, v_shift_start,
          coalesce((p_payload->>'isNight') in ('Ночь', 'true'), false),
          nullif(trim(p_payload->>'clientShiftId'), ''))
  on conflict (worker, start_at) where worker is not null and start_at is not null
  do update set
    shift_date = excluded.shift_date,
    client_shift_id = coalesce(public.shifts.client_shift_id, excluded.client_shift_id)
  returning id, end_at into v_shift_id, v_shift_end;

  if v_shift_end is not null then
    raise exception 'Shift is already closed';
  end if;

  insert into public.visits(
    shift_id, worker, visitor, operation, visit_date, visit_time,
    is_night, is_other, comment, entered_at, client_event_id
  ) values (
    v_shift_id, v_worker, v_entry->>'visitor', v_visit_operation,
    coalesce(nullif(v_entry->>'date', '')::date, v_shift_date),
    v_visit_time,
    coalesce((v_entry->>'night') = 'Ночь', false),
    exists(select 1 from jsonb_array_elements(coalesce(v_entry->'orders', '[]'::jsonb)) x
           where x->>'id' = '__other__'),
    coalesce(v_entry->>'comment', ''), now(), v_event_id
  ) returning id into v_visit_id;

  for v_order in
    select value
    from jsonb_array_elements(coalesce(v_entry->'orders', '[]'::jsonb))
    order by value->>'id'
  loop
    v_order_no := nullif(trim(v_order->>'id'), '');
    if v_order_no is null then raise exception 'Order id is required'; end if;

    v_operation := case
      when coalesce(nullif(v_order->>'operation', ''), nullif(v_order->>'type', ''), v_visit_operation)
           in ('issue', 'pickup') then 'issue'
      when coalesce(nullif(v_order->>'operation', ''), nullif(v_order->>'type', ''), v_visit_operation)
           in ('return', 'dropoff') then 'return'
      else null
    end;
    if v_operation is null then
      raise exception 'Each order in a mixed visit must have issue or return operation';
    end if;
    if v_visit_operation <> 'both' and v_operation <> v_visit_operation then
      raise exception 'Order % operation conflicts with visit operation', v_order_no;
    end if;

    if v_order_no <> '__other__' then
      if not exists (select 1 from public.orders where order_no = v_order_no) then
        raise exception 'Order % not found', v_order_no;
      end if;

      perform pg_advisory_xact_lock(hashtextextended(v_order_no, 0));
      if exists (
        select 1 from public.visit_orders unresolved
        where unresolved.order_no = v_order_no and unresolved.operation is null
      ) then
        raise exception 'Order % has an unresolved historical operation; reconcile it first', v_order_no;
      end if;
      select
        coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'), false),
        coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'return'), false)
      into v_issued, v_returned
      from public.visit_orders vo
      join public.visits v on v.id = vo.visit_id
      where vo.order_no = v_order_no;

      if v_operation = 'issue' and v_issued then
        raise exception 'Order % is already issued', v_order_no;
      elsif v_operation = 'return' and not v_issued then
        raise exception 'Order % cannot be returned before issue', v_order_no;
      elsif v_operation = 'return' and v_returned then
        raise exception 'Order % is already returned', v_order_no;
      end if;
    end if;

    insert into public.visit_orders(
      visit_id, order_no, operation, client_snapshot,
      return_date_snapshot, delivery_snapshot
    ) values (
      v_visit_id,
      case when v_order_no = '__other__' then null else v_order_no end,
      v_operation,
      coalesce(v_order->>'client', v_entry->>'orderClient', ''),
      nullif(v_order->>'returnDate', '')::date,
      coalesce(v_order->>'delivery', v_entry->>'orderDelivery', '')
    );
  end loop;

  insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
  values (v_event_id, v_visit_id, 'active');

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

drop function if exists public.delete_warehouse_visit(uuid);

create or replace function public.delete_warehouse_visit(
  p_visit_id uuid default null,
  p_client_event_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_visit public.visits%rowtype;
  v_deleted_id uuid;
  v_event_id text := nullif(trim(p_client_event_id), '');
  v_order record;
  v_other_issue boolean;
  v_other_return boolean;
  v_visit_found boolean := false;
begin
  if p_visit_id is null and v_event_id is null then
    raise exception 'visitId or clientEventId is required';
  end if;

  if v_event_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_event_id, 2));
  end if;

  if p_visit_id is not null then
    select * into v_visit from public.visits where id = p_visit_id for update;
    v_visit_found := found;
  end if;
  if not v_visit_found and v_event_id is not null then
    select * into v_visit from public.visits where client_event_id = v_event_id for update;
    v_visit_found := found;
  end if;

  if not v_visit_found then
    if v_event_id is not null then
      insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
      values (v_event_id, null, 'deleted')
      on conflict (client_event_id) do update
      set visit_id = null, status = 'deleted', updated_at = now();
    end if;
    return jsonb_build_object('ok', true, 'deletedVisitId', p_visit_id,
      'alreadyDeleted', true);
  end if;

  if v_event_id is not null and v_visit.client_event_id is distinct from v_event_id then
    raise exception 'visitId and clientEventId refer to different visits';
  end if;
  v_event_id := coalesce(v_event_id, v_visit.client_event_id);
  if v_event_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_event_id, 2));
  end if;

  -- Serialize lifecycle changes with add/link and prevent deleting the last
  -- issue while a return remains recorded.
  for v_order in
    select vo.order_no,
           public.warehouse_effective_operation(v_visit.operation, vo.operation) as operation
    from public.visit_orders vo
    where vo.visit_id = v_visit.id and vo.order_no is not null
    order by vo.order_no
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_order.order_no, 0));
    if v_order.operation = 'issue' then
      select
        coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'), false),
        coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'return'), false)
      into v_other_issue, v_other_return
      from public.visit_orders vo
      join public.visits v on v.id = vo.visit_id
      where vo.order_no = v_order.order_no and vo.visit_id <> v_visit.id;

      if v_other_return and not v_other_issue then
        raise exception 'Order % issue cannot be deleted while its return exists', v_order.order_no;
      end if;
    end if;
  end loop;

  delete from public.visits where id = v_visit.id returning id into v_deleted_id;

  if v_event_id is not null then
    insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
    values (v_event_id, null, 'deleted')
    on conflict (client_event_id) do update
    set visit_id = null, status = 'deleted', updated_at = now();
  end if;

  return jsonb_build_object(
    'ok', true,
    'deletedVisitId', coalesce(v_deleted_id, p_visit_id),
    'alreadyDeleted', v_deleted_id is null
  );
end;
$$;

create or replace function public.warehouse_draft_visit_fingerprint(p_visit jsonb)
returns text
language sql
immutable
parallel safe
as $$
  select md5(jsonb_build_array(
    p_visit->>'visitor', p_visit->>'operation', p_visit->>'date',
    p_visit->>'time', p_visit->>'timeAuto', p_visit->>'comment',
    coalesce(p_visit->'orders', '[]'::jsonb)
  )::text)
$$;

create or replace function public.warehouse_draft_visit_key(p_visit jsonb)
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(
    nullif(p_visit->>'clientEventId', ''),
    nullif(p_visit->>'visitId', ''),
    'legacy-' || public.warehouse_draft_visit_fingerprint(p_visit)
  )
$$;

create or replace function public.warehouse_merge_draft_visits(
  p_existing jsonb,
  p_incoming jsonb
)
returns jsonb
language plpgsql
immutable
parallel safe
as $$
declare
  v_result jsonb := '[]'::jsonb;
  v_item jsonb;
  v_old jsonb;
  v_merged jsonb;
  v_key text;
  v_index integer;
begin
  for v_item in select value from jsonb_array_elements(
    case when jsonb_typeof(p_existing) = 'array' then p_existing else '[]'::jsonb end
  ) loop
    v_result := v_result || jsonb_build_array(v_item);
  end loop;

  for v_item in select value from jsonb_array_elements(
    case when jsonb_typeof(p_incoming) = 'array' then p_incoming else '[]'::jsonb end
  ) loop
    v_key := public.warehouse_draft_visit_key(v_item);
    select ordinality::integer - 1 into v_index
    from jsonb_array_elements(v_result) with ordinality x(value, ordinality)
    where public.warehouse_draft_visit_key(x.value) = v_key
       or (
         (nullif(x.value->>'clientEventId', '') is null
          or nullif(v_item->>'clientEventId', '') is null)
         and public.warehouse_draft_visit_fingerprint(x.value)
             = public.warehouse_draft_visit_fingerprint(v_item)
       )
    limit 1;

    if v_index is null then
      v_result := v_result || jsonb_build_array(v_item);
    else
      v_old := v_result->v_index;
      v_merged := v_old || v_item;
      if nullif(v_merged->>'clientEventId', '') is null and nullif(v_old->>'clientEventId', '') is not null then
        v_merged := v_merged || jsonb_build_object('clientEventId', v_old->>'clientEventId');
      end if;
      if nullif(v_merged->>'visitId', '') is null and nullif(v_old->>'visitId', '') is not null then
        v_merged := v_merged || jsonb_build_object('visitId', v_old->>'visitId');
      end if;
      if nullif(v_merged->>'shiftId', '') is null and nullif(v_old->>'shiftId', '') is not null then
        v_merged := v_merged || jsonb_build_object('shiftId', v_old->>'shiftId');
      end if;
      if nullif(v_merged->>'visitId', '') is null
         and ((v_old->>'syncBlocked') = 'true' or (v_item->>'syncBlocked') = 'true') then
        v_merged := v_merged || jsonb_build_object(
          'syncBlocked', true,
          'syncError', coalesce(nullif(v_item->>'syncError', ''), v_old->>'syncError')
        );
      end if;
      v_result := jsonb_set(v_result, array[v_index::text], v_merged, false);
    end if;
  end loop;
  return v_result;
end;
$$;

create or replace function public.save_warehouse_draft(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_worker text := nullif(trim(p_payload->>'worker'), '');
  v_shift_start timestamptz := nullif(p_payload->>'shiftStart', '')::timestamptz;
  v_saved_at timestamptz := clock_timestamp();
  v_data jsonb;
  v_existing jsonb;
  v_existing_start timestamptz;
  v_merged_visits jsonb;
begin
  if v_worker is null or v_shift_start is null then
    raise exception 'worker and shiftStart are required for draft';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_worker, 1));

  if exists (
    select 1 from public.shifts
    where worker = v_worker and start_at = v_shift_start and end_at is not null
  ) then
    return jsonb_build_object('ok', true, 'ignored', true, 'reason', 'shift is already closed');
  end if;

  select data into v_existing from public.drafts where worker = v_worker for update;
  if found then
    v_existing_start := public.warehouse_safe_timestamptz(v_existing->>'shiftStart');
    if v_existing_start is not null and v_existing_start > v_shift_start then
      return jsonb_build_object('ok', true, 'ignored', true,
        'reason', 'newer draft exists', 'draft', v_existing);
    end if;
    if v_existing_start is distinct from v_shift_start and not exists (
      select 1 from public.shifts
      where worker = v_worker and start_at = v_existing_start and end_at is not null
    ) then
      return jsonb_build_object('ok', true, 'ignored', true,
        'reason', 'different active draft exists', 'draft', v_existing);
    end if;
  end if;

  -- Same-shift saves are a union by stable event id. A stale snapshot from one
  -- device can no longer erase a visit captured on another device.
  v_merged_visits := public.warehouse_merge_draft_visits(
    case when v_existing_start = v_shift_start then v_existing->'visits' else '[]'::jsonb end,
    p_payload->'visits'
  );
  select coalesce(jsonb_agg(x.value order by x.ordinality), '[]'::jsonb)
  into v_merged_visits
  from jsonb_array_elements(v_merged_visits) with ordinality x(value, ordinality)
  where (
      nullif(x.value->>'clientEventId', '') is null
      or not exists (
        select 1 from public.warehouse_event_receipts r
        where r.client_event_id = x.value->>'clientEventId' and r.status = 'deleted'
      )
    )
    and not exists (
      -- При переносе офлайн-черновика не прикрепляем визуально событие,
      -- которое сервер уже записал в другую смену после потерянного ACK.
      select 1
      from public.warehouse_event_receipts r
      left join public.visits recorded on recorded.id = r.visit_id
      left join public.shifts recorded_shift on recorded_shift.id = recorded.shift_id
      where r.client_event_id = x.value->>'clientEventId'
        and r.status = 'active'
        and recorded_shift.start_at is distinct from v_shift_start
    );

  -- savedAt is always server time; an incorrect device clock cannot win.
  v_data := coalesce(v_existing, '{}'::jsonb) || p_payload || jsonb_build_object(
    'visits', v_merged_visits,
    'savedAt', v_saved_at
  );
  insert into public.drafts(worker, data, saved_at)
  values (v_worker, v_data, v_saved_at)
  on conflict (worker) do update set data = excluded.data, saved_at = excluded.saved_at;

  return jsonb_build_object('ok', true, 'ignored', false, 'draft', v_data);
end;
$$;

create or replace function public.clear_warehouse_draft(
  p_worker text,
  p_client_shift_id text default null,
  p_shift_start timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_worker text := nullif(trim(p_worker), '');
  v_client_shift_id text := nullif(trim(p_client_shift_id), '');
  v_deleted integer;
begin
  if v_worker is null or (v_client_shift_id is null and p_shift_start is null) then
    raise exception 'worker and clientShiftId or shiftStart are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_worker, 1));
  delete from public.drafts
  where worker = v_worker
    and (
      (v_client_shift_id is not null and data->>'clientShiftId' = v_client_shift_id)
      or (p_shift_start is not null
          and public.warehouse_safe_timestamptz(data->>'shiftStart') = p_shift_start)
    );
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('ok', true, 'deleted', v_deleted > 0,
    'stale', v_deleted = 0);
end;
$$;

create or replace function public.link_warehouse_visit(
  p_visit_id uuid,
  p_links jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_visit public.visits%rowtype;
  v_link jsonb;
  v_order public.orders%rowtype;
  v_order_no text;
  v_operation text;
  v_visit_operation text;
  v_existing_operation text;
  v_issued boolean;
  v_returned boolean;
  v_linked integer := 0;
  v_unresolved integer := 0;
begin
  if p_visit_id is null or p_links is null or jsonb_typeof(p_links) <> 'array'
     or jsonb_array_length(p_links) = 0 then
    raise exception 'visitId and links are required';
  end if;

  select * into v_visit from public.visits where id = p_visit_id for update;
  if not found then raise exception 'Visit % not found', p_visit_id; end if;
  if not v_visit.is_other then
    raise exception 'Visit % is already reconciled', p_visit_id;
  end if;

  v_visit_operation := case
    when v_visit.operation in ('issue', 'pickup', 'Выдача', 'Получение (наш)') then 'issue'
    when v_visit.operation in ('return', 'dropoff', 'Возврат', 'Возврат (наш)') then 'return'
    when v_visit.operation in ('both', 'Выдача и возврат', 'Получение+Возврат') then 'both'
    else null
  end;
  if v_visit_operation is null then
    raise exception 'Unknown visit operation: %', v_visit.operation;
  end if;

  for v_link in select value from jsonb_array_elements(p_links) order by value->>'orderId'
  loop
    v_order_no := nullif(trim(v_link->>'orderId'), '');
    v_operation := nullif(v_link->>'operation', '');
    if v_order_no is null or v_operation not in ('issue', 'return') then
      raise exception 'Every link needs orderId and issue/return operation';
    end if;
    if v_visit_operation <> 'both' and v_operation <> v_visit_operation then
      raise exception 'Order % operation conflicts with visit operation', v_order_no;
    end if;

    select * into v_order from public.orders where order_no = v_order_no;
    if not found then raise exception 'Order % not found', v_order_no; end if;

    perform pg_advisory_xact_lock(hashtextextended(v_order_no, 0));
    if exists (
      select 1 from public.visit_orders unresolved
      where unresolved.order_no = v_order_no and unresolved.operation is null
    ) and not exists (
      select 1 from public.visit_orders current_unresolved
      where current_unresolved.order_no = v_order_no
        and current_unresolved.visit_id = p_visit_id
        and current_unresolved.operation is null
    ) then
      raise exception 'Order % unresolved operation belongs to another visit', v_order_no;
    end if;
    v_existing_operation := null;
    select operation into v_existing_operation
    from public.visit_orders
    where visit_id = p_visit_id and order_no = v_order_no;

    if v_existing_operation is not null and v_existing_operation <> v_operation then
      raise exception 'Order % already has another operation in this visit', v_order_no;
    end if;

    if v_existing_operation is null then
      select
        coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'), false),
        coalesce(bool_or(public.warehouse_effective_operation(v.operation, vo.operation) = 'return'), false)
      into v_issued, v_returned
      from public.visit_orders vo
      join public.visits v on v.id = vo.visit_id
      where vo.order_no = v_order_no;

      if v_operation = 'issue' and v_issued then
        raise exception 'Order % is already issued', v_order_no;
      elsif v_operation = 'return' and not v_issued then
        raise exception 'Order % cannot be returned before issue', v_order_no;
      elsif v_operation = 'return' and v_returned then
        raise exception 'Order % is already returned', v_order_no;
      end if;
    end if;

    insert into public.visit_orders(
      visit_id, order_no, operation, client_snapshot,
      return_date_snapshot, delivery_snapshot
    ) values (
      p_visit_id, v_order_no, v_operation, coalesce(v_order.client, ''),
      v_order.return_date,
      case when coalesce(v_order.delivery_worker, '') <> '' then 'Наша доставка' else 'Самовывоз' end
    )
    on conflict (visit_id, order_no) where order_no is not null do update
      set operation = excluded.operation,
          client_snapshot = excluded.client_snapshot,
          return_date_snapshot = excluded.return_date_snapshot,
          delivery_snapshot = excluded.delivery_snapshot;
    v_linked := v_linked + 1;
  end loop;

  select count(*) into v_unresolved
  from public.visit_orders
  where visit_id = p_visit_id and order_no is not null and operation is null;

  update public.visits set is_other = (v_unresolved > 0) where id = p_visit_id;
  return jsonb_build_object('ok', true, 'linked', v_linked, 'unresolved', v_unresolved);
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
  v_shift_start timestamptz := nullif(p_payload->>'shiftStart', '')::timestamptz;
  v_worker text := nullif(trim(p_payload->>'worker'), '');
  v_existing_end timestamptz;
begin
  if v_worker is null or v_shift_start is null or nullif(p_payload->>'shiftEnd', '') is null then
    raise exception 'worker, shiftStart and shiftEnd are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_worker, 1));

  select id, end_at into v_shift_id, v_existing_end
  from public.shifts
  where worker = v_worker and start_at = v_shift_start;

  if v_existing_end is not null then
    delete from public.drafts
    where worker = v_worker
      and (
        public.warehouse_safe_timestamptz(data->>'shiftStart') = v_shift_start
        or (nullif(data->>'clientShiftId', '') is not null
            and data->>'clientShiftId' = p_payload->>'clientShiftId')
      );
    return jsonb_build_object('ok', true, 'shiftId', v_shift_id, 'idempotent', true);
  end if;

  if exists (
    select 1
    from public.drafts d
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(d.data->'visits') = 'array'
           then d.data->'visits' else '[]'::jsonb end
    ) item(value)
    where d.worker = v_worker
      and public.warehouse_safe_timestamptz(d.data->>'shiftStart') = v_shift_start
      and (
        nullif(item.value->>'clientEventId', '') is null
        or not exists (
          select 1 from public.warehouse_event_receipts r
          where r.client_event_id = item.value->>'clientEventId'
            and r.status in ('active', 'deleted')
        )
      )
  ) then
    raise exception 'Shift has unrecorded draft visits';
  end if;

  insert into public.shifts(worker, shift_date, start_at, end_at, is_night, client_shift_id)
  values (v_worker, (p_payload->>'shiftDate')::date, v_shift_start,
          (p_payload->>'shiftEnd')::timestamptz,
          coalesce((p_payload->>'isNight') in ('Ночь', 'true'), false),
          nullif(trim(p_payload->>'clientShiftId'), ''))
  on conflict (worker, start_at) where worker is not null and start_at is not null
  do update set
    end_at = coalesce(public.shifts.end_at, excluded.end_at),
    client_shift_id = coalesce(public.shifts.client_shift_id, excluded.client_shift_id)
  returning id into v_shift_id;

  delete from public.drafts
  where worker = v_worker
    and (
      data->>'shiftStart' = p_payload->>'shiftStart'
      or (nullif(data->>'clientShiftId', '') is not null
          and data->>'clientShiftId' = p_payload->>'clientShiftId')
    );

  return jsonb_build_object('ok', true, 'shiftId', v_shift_id, 'idempotent', false);
end;
$$;

commit;
