-- Safe only before any duplicate classification has been recorded. Once audit
-- data exists, retain the migration and use a forward repair instead.

begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

lock table
  public.warehouse_event_receipts,
  public.drafts,
  public.visit_orders,
  public.visits
in access exclusive mode;

do $preflight_duplicate_rollback$
begin
  if exists (
    select 1 from public.visits
    where is_duplicate = true
       or duplicate_reason is not null
       or duplicate_actor is not null
       or duplicate_marked_at is not null
       or duplicate_order_no is not null
       or duplicate_of_visit_id is not null
  ) then
    raise exception 'Duplicate rollback aborted: audit data already exists';
  end if;
end
$preflight_duplicate_rollback$;

drop trigger if exists visit_orders_duplicate_guard on public.visit_orders;
drop function if exists public.warehouse_reject_duplicate_order_link();
drop function if exists public.mark_warehouse_visit_duplicate(jsonb);

do $restore_duplicate_snapshots$
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
        E'select 1 from public.visit_orders unresolved\n            join public.visits unresolved_visit on unresolved_visit.id = unresolved.visit_id\n            where unresolved.order_no = o.order_no and unresolved.operation is null\n              and unresolved_visit.is_duplicate = false',
        E'select 1 from public.visit_orders unresolved\n            where unresolved.order_no = o.order_no and unresolved.operation is null'
      ),
      'where is_other = true and is_duplicate = false and visit_date = p_today',
      'where is_other = true and visit_date = p_today'
    ),
    E'select vo.id, vo.visit_id, vo.operation\n        from public.visit_orders vo\n        join public.visits v on v.id = vo.visit_id\n        where vo.order_no is null and v.is_duplicate = false',
    E'select id, visit_id, operation\n        from public.visit_orders\n        where order_no is null'
  );
  v_rewritten := replace(
    v_rewritten,
    E'    ''excludedVisitIds'', coalesce((\n      select jsonb_agg(v.id order by v.id)\n      from public.visits v\n      where p_worker is not null and v.worker = p_worker and v.is_duplicate = true\n    ), ''[]''::jsonb),\n    ''excludedClientEventIds'', coalesce((\n      select jsonb_agg(v.client_event_id order by v.client_event_id)\n      from public.visits v\n      where p_worker is not null and v.worker = p_worker and v.is_duplicate = true\n        and v.client_event_id is not null\n    ), ''[]''::jsonb),\n    ''todayEvents'', coalesce((',
    E'    ''todayEvents'', coalesce(('
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for warehouse_staff_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_dashboard_snapshot(date)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      replace(
        v_definition,
        E'select 1 from public.visit_orders unresolved\n                 join public.visits unresolved_visit on unresolved_visit.id = unresolved.visit_id\n                 where unresolved.order_no = o.order_no and unresolved.operation is null\n                   and unresolved_visit.is_duplicate = false',
        E'select 1 from public.visit_orders unresolved\n                 where unresolved.order_no = o.order_no and unresolved.operation is null'
      ),
      'where is_duplicate = false and visit_date >= p_from_date',
      'where visit_date >= p_from_date'
    ),
    'where v.is_duplicate = false and v.visit_date >= p_from_date',
    'where v.visit_date >= p_from_date'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for warehouse_dashboard_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_worker_history_snapshot(text)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    'where v.worker = p_worker and v.is_duplicate = false',
    'where v.worker = p_worker'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for warehouse_worker_history_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_reconciliation_snapshot(date)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      replace(
        v_definition,
        E'select vo.order_no, array_agg(vo.visit_id order by vo.visit_id) as unresolved_visit_ids\n    from public.visit_orders vo\n    join public.visits v on v.id = vo.visit_id\n    where vo.order_no is not null and vo.operation is null and v.is_duplicate = false\n    group by vo.order_no',
        E'select order_no, array_agg(visit_id order by visit_id) as unresolved_visit_ids\n    from public.visit_orders\n    where order_no is not null and operation is null\n    group by order_no'
      ),
      E'where vo.order_no is not null\n      and v.is_duplicate = false\n      and public.warehouse_effective_operation(v.operation, vo.operation) is not null',
      E'where vo.order_no is not null\n      and public.warehouse_effective_operation(v.operation, vo.operation) is not null'
    ),
    'where v.is_other = true and v.is_duplicate = false',
    'where v.is_other = true'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for warehouse_reconciliation_snapshot';
  end if;
  execute v_rewritten;

  v_signature := 'public.apply_warehouse_manager_correction(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      replace(
        v_definition,
        E'if not found then raise exception ''Visit % not found'', v_visit_id; end if;\n  if v_visit.is_duplicate then\n    raise exception ''Visit % is marked as duplicate'', v_visit_id;\n  end if;\n  if not v_visit.is_other then',
        E'if not found then raise exception ''Visit % not found'', v_visit_id; end if;\n  if not v_visit.is_other then'
      ),
      E'where v.is_other = true\n    and v.is_duplicate = false\n    and public.warehouse_exact_order_key(v.comment)',
      E'where v.is_other = true\n    and public.warehouse_exact_order_key(v.comment)'
    ),
    'where vo.order_no = v_order_no and v.is_duplicate = false;',
    'where vo.order_no = v_order_no;'
  );
  v_rewritten := replace(
    v_rewritten,
    E'if exists (select 1 from public.visit_orders unresolved\n    join public.visits unresolved_visit on unresolved_visit.id = unresolved.visit_id\n    where unresolved.order_no = v_order_no and unresolved.operation is null\n      and unresolved_visit.is_duplicate = false) then',
    'if exists (select 1 from public.visit_orders where order_no = v_order_no and operation is null) then'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for apply_warehouse_manager_correction';
  end if;
  execute v_rewritten;

  v_signature := 'public.link_warehouse_visit(uuid,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      v_definition,
      E'if not found then raise exception ''Visit % not found'', p_visit_id; end if;\n  if v_visit.is_duplicate then\n    raise exception ''Visit % is marked as duplicate'', p_visit_id;\n  end if;\n  if not v_visit.is_other then',
      E'if not found then raise exception ''Visit % not found'', p_visit_id; end if;\n  if not v_visit.is_other then'
    ),
    'where vo.order_no = v_order_no and v.is_duplicate = false;',
    'where vo.order_no = v_order_no;'
  );
  v_rewritten := replace(
    v_rewritten,
    E'where unresolved.order_no = v_order_no and unresolved.operation is null\n        and exists (select 1 from public.visits unresolved_visit\n          where unresolved_visit.id = unresolved.visit_id and unresolved_visit.is_duplicate = false)',
    'where unresolved.order_no = v_order_no and unresolved.operation is null'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for link_warehouse_visit';
  end if;
  execute v_rewritten;

  v_signature := 'public.record_warehouse_visit(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    replace(
      v_definition,
      'where vo.order_no = v_order_no and v.is_duplicate = false;',
      'where vo.order_no = v_order_no;'
    ),
    E'where unresolved.order_no = v_order_no and unresolved.operation is null\n          and exists (select 1 from public.visits unresolved_visit\n            where unresolved_visit.id = unresolved.visit_id and unresolved_visit.is_duplicate = false)',
    'where unresolved.order_no = v_order_no and unresolved.operation is null'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for record_warehouse_visit';
  end if;
  execute v_rewritten;

  v_signature := 'public.save_warehouse_draft(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    E'    and not exists (\n      select 1 from public.visits duplicate_visit\n      where duplicate_visit.id::text = nullif(x.value->>''visitId'', '''')\n        and duplicate_visit.is_duplicate = true\n    )\n    and not exists (\n      -- При переносе офлайн-черновика',
    E'    and not exists (\n      -- При переносе офлайн-черновика'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for save_warehouse_draft';
  end if;
  execute v_rewritten;

  v_signature := 'public.warehouse_validate_event_chronology()'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    'where vo.order_no = new.order_no and v.is_duplicate = false',
    'where vo.order_no = new.order_no'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for warehouse_validate_event_chronology';
  end if;
  execute v_rewritten;

  v_signature := 'public.delete_warehouse_visit(uuid,text)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    'where vo.order_no = v_order.order_no and vo.visit_id <> v_visit.id and v.is_duplicate = false;',
    'where vo.order_no = v_order.order_no and vo.visit_id <> v_visit.id;'
  );
  v_rewritten := replace(
    v_rewritten,
    E'if v_visit.is_duplicate then\n    raise exception ''Visit % is marked as duplicate and cannot be deleted'', v_visit.id;\n  end if;\n\n  if v_event_id is not null and v_visit.client_event_id is distinct from v_event_id then',
    'if v_event_id is not null and v_visit.client_event_id is distinct from v_event_id then'
  );
  v_rewritten := replace(
    v_rewritten,
    E'  if exists (\n    select 1 from public.visits duplicate_visit\n    where duplicate_visit.is_duplicate = true\n      and duplicate_visit.duplicate_of_visit_id = v_visit.id\n  ) then\n    raise exception ''Visit % is the canonical visit for a duplicate audit and cannot be deleted'', v_visit.id;\n  end if;\n\n  -- Serialize lifecycle changes with add/link and prevent deleting the last\n  -- issue while a return remains recorded.',
    E'  -- Serialize lifecycle changes with add/link and prevent deleting the last\n  -- issue while a return remains recorded.'
  );
  if v_rewritten = v_definition or position('is_duplicate' in v_rewritten) > 0 then
    raise exception 'Duplicate rollback failed for delete_warehouse_visit';
  end if;
  execute v_rewritten;
end
$restore_duplicate_snapshots$;

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

drop index if exists public.visits_duplicate_marked_at_idx;
alter table public.visits drop constraint if exists visits_duplicate_audit_check;
alter table public.visits
  drop column if exists duplicate_of_visit_id,
  drop column if exists duplicate_order_no,
  drop column if exists duplicate_marked_at,
  drop column if exists duplicate_actor,
  drop column if exists duplicate_reason,
  drop column if exists is_duplicate;

commit;
