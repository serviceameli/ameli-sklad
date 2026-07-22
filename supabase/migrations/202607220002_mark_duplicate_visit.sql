-- Preserve manager-confirmed duplicate visits for audit while excluding them
-- from operational reconciliation, statistics and rental lifecycle state.
-- This migration intentionally does not change RLS, grants or authorization.

begin;

alter table public.visits
  add column if not exists is_duplicate boolean not null default false,
  add column if not exists duplicate_reason text,
  add column if not exists duplicate_actor text,
  add column if not exists duplicate_marked_at timestamptz,
  add column if not exists duplicate_order_no text,
  add column if not exists duplicate_of_visit_id uuid;

alter table public.visits drop constraint if exists visits_duplicate_of_visit_id_fkey;
alter table public.visits
  add constraint visits_duplicate_of_visit_id_fkey
  foreign key (duplicate_of_visit_id) references public.visits(id)
  on delete no action deferrable initially immediate;

alter table public.visits drop constraint if exists visits_duplicate_audit_check;
alter table public.visits
  add constraint visits_duplicate_audit_check check (
    not is_duplicate
    or (
      nullif(trim(duplicate_reason), '') is not null
      and char_length(trim(duplicate_reason)) >= 6
      and nullif(trim(duplicate_actor), '') is not null
      and duplicate_marked_at is not null
      and nullif(trim(duplicate_order_no), '') is not null
    )
  );

create index if not exists visits_duplicate_marked_at_idx
  on public.visits (duplicate_marked_at) where is_duplicate = true;

-- Lifecycle state must never consume a row classified as a duplicate. Raw
-- rows remain available through warehouse_backup_snapshot and direct audit.
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
where vo.order_no is not null and v.is_duplicate = false
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
where vo.order_no is not null and v.is_duplicate = false;

-- Patch the existing snapshot functions in place. Each replacement is
-- preflighted so deployment fails closed if an earlier migration changed the
-- expected definition.
do $patch_duplicate_snapshots$
declare
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
begin
  v_signature := 'public.warehouse_staff_snapshot(text,date,date)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      replace(
        v_definition,
        E'select 1 from public.visit_orders unresolved\n            where unresolved.order_no = o.order_no and unresolved.operation is null',
        E'select 1 from public.visit_orders unresolved\n            join public.visits unresolved_visit on unresolved_visit.id = unresolved.visit_id\n            where unresolved.order_no = o.order_no and unresolved.operation is null\n              and unresolved_visit.is_duplicate = false'
      ),
      'where is_other = true and visit_date = p_today',
      'where is_other = true and is_duplicate = false and visit_date = p_today'
    ),
    E'select id, visit_id, operation\n        from public.visit_orders\n        where order_no is null',
    E'select vo.id, vo.visit_id, vo.operation\n        from public.visit_orders vo\n        join public.visits v on v.id = vo.visit_id\n        where vo.order_no is null and v.is_duplicate = false'
  );
  v_rewritten := replace(
    v_rewritten,
    E'    ''todayEvents'', coalesce((',
    E'    ''excludedVisitIds'', coalesce((\n      select jsonb_agg(v.id order by v.id)\n      from public.visits v\n      where p_worker is not null and v.worker = p_worker and v.is_duplicate = true\n    ), ''[]''::jsonb),\n    ''excludedClientEventIds'', coalesce((\n      select jsonb_agg(v.client_event_id order by v.client_event_id)\n      from public.visits v\n      where p_worker is not null and v.worker = p_worker and v.is_duplicate = true\n        and v.client_event_id is not null\n    ), ''[]''::jsonb),\n    ''todayEvents'', coalesce(('
  );
  if v_rewritten = v_definition
     or position('is_duplicate = false and visit_date = p_today' in v_rewritten) = 0
     or position('unresolved_visit.is_duplicate = false' in v_rewritten) = 0
     or position('vo.order_no is null and v.is_duplicate = false' in v_rewritten) = 0
     or position('''excludedVisitIds''' in v_rewritten) = 0
     or position('''excludedClientEventIds''' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for warehouse_staff_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_dashboard_snapshot(date)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      replace(
        v_definition,
        E'select 1 from public.visit_orders unresolved\n                 where unresolved.order_no = o.order_no and unresolved.operation is null',
        E'select 1 from public.visit_orders unresolved\n                 join public.visits unresolved_visit on unresolved_visit.id = unresolved.visit_id\n                 where unresolved.order_no = o.order_no and unresolved.operation is null\n                   and unresolved_visit.is_duplicate = false'
      ),
      'where visit_date >= p_from_date',
      'where is_duplicate = false and visit_date >= p_from_date'
    ),
    'where v.visit_date >= p_from_date',
    'where v.is_duplicate = false and v.visit_date >= p_from_date'
  );
  if v_rewritten = v_definition
     or position('where is_duplicate = false and visit_date >= p_from_date' in v_rewritten) = 0
     or position('unresolved_visit.is_duplicate = false' in v_rewritten) = 0
     or position('where v.is_duplicate = false and v.visit_date >= p_from_date' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for warehouse_dashboard_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_worker_history_snapshot(text)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    'where v.worker = p_worker',
    'where v.worker = p_worker and v.is_duplicate = false'
  );
  if v_rewritten = v_definition
     or position('where v.worker = p_worker and v.is_duplicate = false' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for warehouse_worker_history_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_reconciliation_snapshot(date)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      replace(
        v_definition,
        E'select order_no, array_agg(visit_id order by visit_id) as unresolved_visit_ids\n    from public.visit_orders\n    where order_no is not null and operation is null\n    group by order_no',
        E'select vo.order_no, array_agg(vo.visit_id order by vo.visit_id) as unresolved_visit_ids\n    from public.visit_orders vo\n    join public.visits v on v.id = vo.visit_id\n    where vo.order_no is not null and vo.operation is null and v.is_duplicate = false\n    group by vo.order_no'
      ),
      E'where vo.order_no is not null\n      and public.warehouse_effective_operation(v.operation, vo.operation) is not null',
      E'where vo.order_no is not null\n      and v.is_duplicate = false\n      and public.warehouse_effective_operation(v.operation, vo.operation) is not null'
    ),
    'where v.is_other = true',
    'where v.is_other = true and v.is_duplicate = false'
  );
  if v_rewritten = v_definition
     or position('and v.is_duplicate = false' in v_rewritten) = 0
     or position('vo.operation is null and v.is_duplicate = false' in v_rewritten) = 0
     or position('where v.is_other = true and v.is_duplicate = false' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for warehouse_reconciliation_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.apply_warehouse_manager_correction(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      replace(
        v_definition,
        E'if not found then raise exception ''Visit % not found'', v_visit_id; end if;\n  if not v_visit.is_other then',
        E'if not found then raise exception ''Visit % not found'', v_visit_id; end if;\n  if v_visit.is_duplicate then\n    raise exception ''Visit % is marked as duplicate'', v_visit_id;\n  end if;\n  if not v_visit.is_other then'
      ),
      E'where v.is_other = true\n    and public.warehouse_exact_order_key(v.comment)',
      E'where v.is_other = true\n    and v.is_duplicate = false\n    and public.warehouse_exact_order_key(v.comment)'
    ),
    'where vo.order_no = v_order_no;',
    'where vo.order_no = v_order_no and v.is_duplicate = false;'
  );
  v_rewritten := replace(
    v_rewritten,
    'if exists (select 1 from public.visit_orders where order_no = v_order_no and operation is null) then',
    E'if exists (select 1 from public.visit_orders unresolved\n    join public.visits unresolved_visit on unresolved_visit.id = unresolved.visit_id\n    where unresolved.order_no = v_order_no and unresolved.operation is null\n      and unresolved_visit.is_duplicate = false) then'
  );
  if v_rewritten = v_definition
     or position('Visit % is marked as duplicate' in v_rewritten) = 0
     or position('unresolved_visit.is_duplicate = false' in v_rewritten) = 0
     or position('and v.is_duplicate = false' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for apply_warehouse_manager_correction';
  end if;
  execute v_rewritten;

  v_signature := 'public.link_warehouse_visit(uuid,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      v_definition,
      E'if not found then raise exception ''Visit % not found'', p_visit_id; end if;\n  if not v_visit.is_other then',
      E'if not found then raise exception ''Visit % not found'', p_visit_id; end if;\n  if v_visit.is_duplicate then\n    raise exception ''Visit % is marked as duplicate'', p_visit_id;\n  end if;\n  if not v_visit.is_other then'
    ),
    'where vo.order_no = v_order_no;',
    'where vo.order_no = v_order_no and v.is_duplicate = false;'
  );
  v_rewritten := replace(
    v_rewritten,
    'where unresolved.order_no = v_order_no and unresolved.operation is null',
    E'where unresolved.order_no = v_order_no and unresolved.operation is null\n        and exists (select 1 from public.visits unresolved_visit\n          where unresolved_visit.id = unresolved.visit_id and unresolved_visit.is_duplicate = false)'
  );
  if v_rewritten = v_definition
     or position('Visit % is marked as duplicate' in v_rewritten) = 0
     or position('unresolved_visit.is_duplicate = false' in v_rewritten) = 0
     or position('and v.is_duplicate = false' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for link_warehouse_visit';
  end if;
  execute v_rewritten;

  v_signature := 'public.record_warehouse_visit(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      v_definition,
      'where vo.order_no = v_order_no;',
      'where vo.order_no = v_order_no and v.is_duplicate = false;'
    ),
    'where unresolved.order_no = v_order_no and unresolved.operation is null',
    E'where unresolved.order_no = v_order_no and unresolved.operation is null\n          and exists (select 1 from public.visits unresolved_visit\n            where unresolved_visit.id = unresolved.visit_id and unresolved_visit.is_duplicate = false)'
  );
  if v_rewritten = v_definition
     or position('unresolved_visit.is_duplicate = false' in v_rewritten) = 0
     or position('and v.is_duplicate = false' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for record_warehouse_visit';
  end if;
  execute v_rewritten;

  v_signature := 'public.save_warehouse_draft(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    E'    and not exists (\n      -- При переносе офлайн-черновика',
    E'    and not exists (\n      select 1 from public.visits duplicate_visit\n      where duplicate_visit.id::text = nullif(x.value->>''visitId'', '''')\n        and duplicate_visit.is_duplicate = true\n    )\n    and not exists (\n      -- При переносе офлайн-черновика'
  );
  if v_rewritten = v_definition
     or position('duplicate_visit.is_duplicate = true' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for save_warehouse_draft';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_validate_event_chronology()'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    'where vo.order_no = new.order_no',
    'where vo.order_no = new.order_no and v.is_duplicate = false'
  );
  if v_rewritten = v_definition
     or position('new.order_no and v.is_duplicate = false' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for warehouse_validate_event_chronology';
  end if;
  execute v_rewritten;

  v_signature := 'public.delete_warehouse_visit(uuid,text)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    'where vo.order_no = v_order.order_no and vo.visit_id <> v_visit.id;',
    'where vo.order_no = v_order.order_no and vo.visit_id <> v_visit.id and v.is_duplicate = false;'
  );
  v_rewritten := replace(
    v_rewritten,
    'if v_event_id is not null and v_visit.client_event_id is distinct from v_event_id then',
    E'if v_visit.is_duplicate then\n    raise exception ''Visit % is marked as duplicate and cannot be deleted'', v_visit.id;\n  end if;\n\n  if v_event_id is not null and v_visit.client_event_id is distinct from v_event_id then'
  );
  v_rewritten := replace(
    v_rewritten,
    E'  -- Serialize lifecycle changes with add/link and prevent deleting the last\n  -- issue while a return remains recorded.',
    E'  if exists (\n    select 1 from public.visits duplicate_visit\n    where duplicate_visit.is_duplicate = true\n      and duplicate_visit.duplicate_of_visit_id = v_visit.id\n  ) then\n    raise exception ''Visit % is the canonical visit for a duplicate audit and cannot be deleted'', v_visit.id;\n  end if;\n\n  -- Serialize lifecycle changes with add/link and prevent deleting the last\n  -- issue while a return remains recorded.'
  );
  if v_rewritten = v_definition
     or position('marked as duplicate and cannot be deleted' in v_rewritten) = 0
     or position('canonical visit for a duplicate audit' in v_rewritten) = 0
     or position('v.is_duplicate = false' in v_rewritten) = 0 then
    raise exception 'Duplicate migration preflight failed for delete_warehouse_visit';
  end if;
  execute v_rewritten;
end
$patch_duplicate_snapshots$;

-- A marked duplicate is audit-only and can never be linked into a lifecycle
-- later, even by direct SQL or an old dashboard tab.
create or replace function public.warehouse_reject_duplicate_order_link()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.order_no is not null and exists (
    select 1 from public.visits v
    where v.id = new.visit_id and v.is_duplicate = true
  ) then
    raise exception 'Visit % is marked as duplicate and cannot be linked', new.visit_id;
  end if;
  return new;
end;
$$;

drop trigger if exists visit_orders_duplicate_guard on public.visit_orders;
create trigger visit_orders_duplicate_guard
before insert or update of visit_id, order_no, operation on public.visit_orders
for each row execute function public.warehouse_reject_duplicate_order_link();

create or replace function public.mark_warehouse_visit_duplicate(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_visit public.visits%rowtype;
  v_visit_id uuid := nullif(trim(p_payload->>'visitId'), '')::uuid;
  v_order_no text := nullif(trim(p_payload->>'orderId'), '');
  v_reason text := nullif(trim(p_payload->>'reason'), '');
  v_actor text := nullif(trim(p_payload->>'actor'), '');
  v_expected_date date := nullif(p_payload->>'expectedVisitDate', '')::date;
  v_expected_time text := nullif(p_payload->>'expectedVisitTime', '');
  v_expected_operation text := case
    when p_payload->>'expectedOperation' in ('issue', 'pickup') then 'issue'
    when p_payload->>'expectedOperation' in ('return', 'dropoff') then 'return'
    else null
  end;
  v_confirm_duplicate boolean := coalesce((p_payload->>'confirmDuplicate')::boolean, false);
  v_requested_original uuid := nullif(trim(p_payload->>'originalVisitId'), '')::uuid;
  v_original_visit_id uuid;
  v_operation text;
  v_existing_count integer;
  v_exact_order_no text;
  v_marked_at timestamptz;
begin
  if v_visit_id is null or v_order_no is null or v_reason is null or v_actor is null
     or v_expected_date is null or v_expected_time is null or v_expected_operation is null then
    raise exception 'visitId, orderId, reason, actor, expectedVisitDate, expectedVisitTime and expectedOperation are required';
  end if;
  if char_length(v_reason) < 6 then
    raise exception 'reason must contain at least 6 characters';
  end if;
  if v_expected_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'expectedVisitTime must be HH:MM';
  end if;
  if not v_confirm_duplicate then
    raise exception 'confirmDuplicate=true is required';
  end if;
  if not exists (select 1 from public.orders o where o.order_no = v_order_no) then
    raise exception 'Order % not found', v_order_no;
  end if;

  select * into v_visit from public.visits where id = v_visit_id for update;
  if not found then raise exception 'Visit % not found', v_visit_id; end if;
  -- Serialize against save_warehouse_draft for this worker. Without the same
  -- lock a concurrent autosave could reintroduce the just-pruned visit or the
  -- prune could overwrite another device's newly saved visit.
  perform pg_advisory_xact_lock(hashtextextended(v_visit.worker, 1));
  if v_visit.visit_date is distinct from v_expected_date
     or v_visit.visit_time is distinct from v_expected_time then
    raise exception 'Visit changed since reconciliation snapshot';
  end if;

  v_operation := public.warehouse_effective_operation(v_visit.operation, null);
  if v_operation not in ('issue', 'return') then
    raise exception 'Only issue or return visits can be marked as duplicates';
  end if;
  if v_operation <> v_expected_operation then
    raise exception 'Visit operation changed since reconciliation snapshot';
  end if;

  if v_visit.is_duplicate then
    if v_visit.duplicate_order_no is distinct from v_order_no then
      raise exception 'Visit % is already marked as a duplicate of another order', v_visit_id;
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'visitId', v_visit.id,
      'orderId', v_visit.duplicate_order_no,
      'originalVisitId', v_visit.duplicate_of_visit_id,
      'markedAt', v_visit.duplicate_marked_at,
      'excluded', true
    );
  end if;
  if not v_visit.is_other then
    raise exception 'Visit % is not an unmatched visit', v_visit_id;
  end if;
  if exists (
    select 1 from public.visit_orders vo
    where vo.visit_id = v_visit_id and vo.order_no is not null
  ) then
    raise exception 'Visit % already has an order link and cannot be marked as an unmatched duplicate', v_visit_id;
  end if;

  -- The automatic path is exactly the existing duplicate_existing_operation
  -- candidate: one unique normalized order from the comment and an already
  -- linked active event with the same operation.
  select min(o.order_no) into v_exact_order_no
  from public.orders o
  where public.warehouse_exact_order_key(o.order_no) = public.warehouse_exact_order_key(v_visit.comment)
  having count(*) = 1;
  if v_exact_order_no is null or v_exact_order_no <> v_order_no then
    raise exception 'Order % is not the unique exact match from visit comment', v_order_no;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order_no, 0));
  select count(*)::integer,
         min(v.id::text)::uuid
  into v_existing_count, v_original_visit_id
  from public.visit_orders vo
  join public.visits v on v.id = vo.visit_id
  where vo.order_no = v_order_no
    and v.id <> v_visit_id
    and v.is_duplicate = false
    and public.warehouse_effective_operation(v.operation, vo.operation) = v_operation;

  if v_requested_original is not null then
    if not exists (
      select 1
      from public.visit_orders vo
      join public.visits v on v.id = vo.visit_id
      where v.id = v_requested_original
        and vo.order_no = v_order_no
        and v.is_duplicate = false
        and public.warehouse_effective_operation(v.operation, vo.operation) = v_operation
    ) then
      raise exception 'Original visit % is not an active % event for order %',
        v_requested_original, v_operation, v_order_no;
    end if;
    v_original_visit_id := v_requested_original;
  end if;

  if v_existing_count = 0 then
    raise exception 'Order % has no active linked % operation to mark this visit as its duplicate',
      v_order_no, v_operation;
  end if;

  update public.visits
  set is_duplicate = true,
      duplicate_reason = v_reason,
      duplicate_actor = v_actor,
      duplicate_marked_at = clock_timestamp(),
      duplicate_order_no = v_order_no,
      duplicate_of_visit_id = v_original_visit_id
  where id = v_visit_id and is_duplicate = false
  returning duplicate_marked_at into v_marked_at;

  if v_marked_at is null then
    raise exception 'Visit % duplicate state changed concurrently', v_visit_id;
  end if;

  -- Tombstone the stable client event without deleting the audit visit. This
  -- prevents an old offline retry or restored draft from recreating the row.
  if v_visit.client_event_id is not null then
    insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
    values (v_visit.client_event_id, v_visit_id, 'deleted')
    on conflict (client_event_id) do update
    set visit_id = excluded.visit_id,
        status = 'deleted',
        updated_at = clock_timestamp();
  end if;

  with rebuilt as (
    select d.worker,
           coalesce(jsonb_agg(item.value order by item.ordinality)
             filter (where not (
               coalesce(v_visit.client_event_id is not null
                and item.value->>'clientEventId' = v_visit.client_event_id, false)
               or coalesce(item.value->>'visitId' = v_visit_id::text, false)
             )), '[]'::jsonb) as visits
    from public.drafts d
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(d.data->'visits') = 'array'
           then d.data->'visits' else '[]'::jsonb end
    ) with ordinality item(value, ordinality)
    where d.worker = v_visit.worker
    group by d.worker
  )
  update public.drafts d
  set data = jsonb_set(d.data, '{visits}', rebuilt.visits, true),
      saved_at = clock_timestamp()
  from rebuilt
  where d.worker = rebuilt.worker
    and rebuilt.visits is distinct from d.data->'visits';

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'visitId', v_visit_id,
    'orderId', v_order_no,
    'originalVisitId', v_original_visit_id,
    'markedAt', v_marked_at,
    'excluded', true
  );
end;
$$;

commit;
