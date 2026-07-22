-- Roll back the reconciliation recovery schema only before any manager
-- correction has been applied. Business rows and access policies are preserved.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';

lock table public.visit_orders, public.visits, public.orders in access exclusive mode;

do $preflight$
begin
  if exists (
    select 1 from public.visits
    where is_correction = true
       or correction_reason is not null
       or correction_actor is not null
       or corrected_at is not null
  ) then
    raise exception 'Reconciliation recovery rollback aborted: manager corrections already exist';
  end if;
end
$preflight$;

create temp table _reconciliation_rollback_before on commit drop as
select
  (select count(*) from public.orders)::bigint as orders_count,
  (select count(*) from public.visits)::bigint as visits_count,
  (select count(*) from public.visit_orders)::bigint as visit_orders_count,
  (select md5(coalesce(jsonb_agg(
      to_jsonb(v) - array['is_correction','correction_reason','correction_actor','corrected_at']
      order by v.id
    ), '[]'::jsonb)::text) from public.visits v) as visits_hash;

drop function if exists public.apply_warehouse_manager_correction(jsonb);
drop trigger if exists visit_orders_chronology_guard on public.visit_orders;
drop function if exists public.warehouse_validate_event_chronology();

-- Restore the snapshot from 202607130001 with the overdue-only predicates
-- introduced by 202607140003.
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
        when coalesce(es.issue_count, 0) = 0 and o.issue_date is not null and o.issue_date < p_today
          then 'missing_issue'
        when coalesce(es.issue_count, 0) > 0 and coalesce(es.return_count, 0) = 0
             and o.return_date is not null and o.return_date < p_today
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

drop function if exists public.warehouse_exact_order_key(text);
drop function if exists public.warehouse_order_keys(text);
drop function if exists public.warehouse_visit_event_at(date, text);

alter table public.visits
  drop column if exists corrected_at,
  drop column if exists correction_actor,
  drop column if exists correction_reason,
  drop column if exists is_correction;

do $verify$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.warehouse_reconciliation_snapshot(date)'::regprocedure)
  into v_definition;

  if (select count(*) from public.orders)
       <> (select orders_count from _reconciliation_rollback_before)
     or (select count(*) from public.visits)
       <> (select visits_count from _reconciliation_rollback_before)
     or (select count(*) from public.visit_orders)
       <> (select visit_orders_count from _reconciliation_rollback_before)
     or (select md5(coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]'::jsonb)::text)
         from public.visits v)
       is distinct from (select visits_hash from _reconciliation_rollback_before)
     or to_regprocedure('public.apply_warehouse_manager_correction(jsonb)') is not null
     or exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'visits'
         and column_name in ('is_correction','correction_reason','correction_actor','corrected_at')
     )
     or position('correctionCandidates' in v_definition) > 0
     or position('o.issue_date < p_today' in v_definition) = 0
     or position('o.return_date < p_today' in v_definition) = 0
  then
    raise exception 'Reconciliation recovery rollback verification failed';
  end if;
end
$verify$;

commit;
