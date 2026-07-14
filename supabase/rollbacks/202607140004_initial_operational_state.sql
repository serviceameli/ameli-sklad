-- Roll back the 2026-07-14 opening state only before new warehouse activity begins.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';

lock table
  public.warehouse_event_receipts,
  public.drafts,
  public.visit_orders,
  public.visits,
  public.shifts,
  public.orders
in access exclusive mode;

create temp table _baseline_rollback_drafts_before on commit drop as
select
  count(*)::bigint as row_count,
  md5(coalesce(jsonb_agg(to_jsonb(d) order by d.worker), '[]'::jsonb)::text) as row_hash
from public.drafts d;

do $preflight$
begin
  if (select count(*) from public.orders) <> 45
     or exists (select 1 from public.shifts)
     or (select count(*) from public.visits) <> 4
     or (select count(*) from public.visit_orders) <> 4
     or (select count(*) from public.order_status
         where issued = true and returned = false and issued_by = 'Система') <> 4
     or (select count(*) from public.orders where manual_hidden = true) <> 7
     or (select count(*) from public.warehouse_event_receipts) <> 7
     or (select count(*) from public.warehouse_event_receipts
         where client_event_id like 'baseline-reset-20260714-%'
           and status = 'active' and visit_id is not null) <> 4
  then
    raise exception 'Initial state rollback aborted: new warehouse activity or changed baseline detected';
  end if;
end
$preflight$;

delete from public.warehouse_event_receipts
where client_event_id like 'baseline-reset-20260714-%';

delete from public.visits
where id in (
  '7b877c90-fa8f-470e-89a0-9ed199b196e5'::uuid,
  '6300c0f5-f9e4-4a81-bead-8d4bb09a722b'::uuid,
  '99ee9716-1f67-46cb-8c62-1b314ee8e2bc'::uuid,
  'c54f550e-36c8-4460-bd06-1c38250ed88d'::uuid
);

update public.orders
set manual_hidden = false
where order_no in (
  '26-A-000838',
  '26-A-001832',
  '26-A-000645',
  '26-A-001978 (F)',
  '26-A-001783 (F)',
  '26-A-001630 (F)',
  '26-A-001979 (F)'
);

do $verify$
begin
  if exists (select 1 from public.orders where manual_hidden = true)
     or exists (select 1 from public.shifts)
     or exists (select 1 from public.visits)
     or exists (select 1 from public.visit_orders)
     or exists (select 1 from public.order_status)
     or (select count(*) from public.warehouse_event_receipts) <> 3
     or exists (
       select 1 from public.warehouse_event_receipts
       where status <> 'deleted' or visit_id is not null
     )
  then
    raise exception 'Initial state rollback verification failed';
  end if;

  if (select count(*) from public.drafts)
       <> (select row_count from _baseline_rollback_drafts_before)
     or (select md5(coalesce(jsonb_agg(to_jsonb(d) order by d.worker), '[]'::jsonb)::text)
         from public.drafts d)
       is distinct from (select row_hash from _baseline_rollback_drafts_before)
  then
    raise exception 'Initial state rollback verification failed: drafts changed';
  end if;
end
$verify$;

commit;
