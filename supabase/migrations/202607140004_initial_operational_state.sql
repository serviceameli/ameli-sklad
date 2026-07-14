-- Establish the opening state after the intentional 2026-07-14 data reset.
-- Seven already completed rentals stay in the source sheet but are hidden from
-- warehouse tasks. Four rentals already with clients receive system-only issue
-- events without a shift, so they wait for return without affecting timesheets.

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

create temp table _baseline_drafts_before on commit drop as
select
  count(*)::bigint as row_count,
  md5(coalesce(jsonb_agg(to_jsonb(d) order by d.worker), '[]'::jsonb)::text) as row_hash
from public.drafts d;

do $preflight$
begin
  if (select count(*) from public.orders) <> 45
     or (select count(*) from public.workers) <> 8
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
    raise exception 'Initial state aborted: live counts differ from the verified post-sync state';
  end if;

  if (select count(*)
      from public.orders o
      join (values
        ('26-A-000838',     date '2026-07-12', date '2026-07-13', 'Выполнен'),
        ('26-A-001832',     date '2026-07-12', date '2026-07-13', 'Выполнен'),
        ('26-A-000645',     date '2026-07-12', date '2026-07-13', 'Выполнен'),
        ('26-A-001978 (F)', date '2026-07-12', date '2026-07-13', 'Выполнен'),
        ('26-A-001783 (F)', date '2026-07-12', date '2026-07-13', 'Выполнен'),
        ('26-A-001630 (F)', date '2026-07-12', date '2026-07-12', 'Выполнен'),
        ('26-A-001979 (F)', date '2026-07-13', date '2026-07-13', 'Выполнен')
      ) expected(order_no, issue_date, return_date, site_status)
        on expected.order_no = o.order_no
       and expected.issue_date = o.issue_date
       and expected.return_date = o.return_date
       and expected.site_status = o.site_status
      where o.source_active = true and o.manual_hidden = false) <> 7
  then
    raise exception 'Initial state aborted: completed rental preflight failed';
  end if;

  if (select count(*)
      from public.orders o
      join (values
        ('26-A-001965 (F)', date '2026-07-12', date '2026-07-14', 'В работе'),
        ('26-A-001885',     date '2026-07-12', date '2026-07-14', 'В работе'),
        ('26-A-001727',     date '2026-07-13', date '2026-07-14', 'В работе'),
        ('26-A-001999 (F)', date '2026-07-13', date '2026-07-15', 'В работе')
      ) expected(order_no, issue_date, return_date, site_status)
        on expected.order_no = o.order_no
       and expected.issue_date = o.issue_date
       and expected.return_date = o.return_date
       and expected.site_status = o.site_status
      where o.source_active = true and o.manual_hidden = false) <> 4
  then
    raise exception 'Initial state aborted: active rental preflight failed';
  end if;

  if exists (select 1 from public.orders where manual_hidden = true)
     or exists (
       select 1 from public.warehouse_event_receipts
       where client_event_id like 'baseline-reset-20260714-%'
     )
  then
    raise exception 'Initial state aborted: baseline was already applied';
  end if;
end
$preflight$;

update public.orders
set manual_hidden = true
where order_no in (
  '26-A-000838',
  '26-A-001832',
  '26-A-000645',
  '26-A-001978 (F)',
  '26-A-001783 (F)',
  '26-A-001630 (F)',
  '26-A-001979 (F)'
);

insert into public.visits(
  id, shift_id, worker, visitor, operation, visit_date, visit_time,
  is_night, is_other, comment, entered_at, client_event_id
)
select
  baseline.visit_id,
  null,
  'Система',
  null,
  'issue',
  null,
  null,
  false,
  false,
  'Начальное состояние после очистки 14.07.2026: заказ уже был у клиента',
  clock_timestamp(),
  baseline.client_event_id
from (values
  ('7b877c90-fa8f-470e-89a0-9ed199b196e5'::uuid, '26-A-001965 (F)', 'baseline-reset-20260714-001965f'),
  ('6300c0f5-f9e4-4a81-bead-8d4bb09a722b'::uuid, '26-A-001885',     'baseline-reset-20260714-001885'),
  ('99ee9716-1f67-46cb-8c62-1b314ee8e2bc'::uuid, '26-A-001727',     'baseline-reset-20260714-001727'),
  ('c54f550e-36c8-4460-bd06-1c38250ed88d'::uuid, '26-A-001999 (F)', 'baseline-reset-20260714-001999f')
) baseline(visit_id, order_no, client_event_id)
join public.orders o on o.order_no = baseline.order_no;

insert into public.visit_orders(
  visit_id, order_no, operation, client_snapshot,
  return_date_snapshot, delivery_snapshot
)
select
  baseline.visit_id,
  o.order_no,
  'issue',
  coalesce(o.client, ''),
  o.return_date,
  case when nullif(o.delivery_worker, '') is null then 'Самовывоз' else 'Наша доставка' end
from (values
  ('7b877c90-fa8f-470e-89a0-9ed199b196e5'::uuid, '26-A-001965 (F)'),
  ('6300c0f5-f9e4-4a81-bead-8d4bb09a722b'::uuid, '26-A-001885'),
  ('99ee9716-1f67-46cb-8c62-1b314ee8e2bc'::uuid, '26-A-001727'),
  ('c54f550e-36c8-4460-bd06-1c38250ed88d'::uuid, '26-A-001999 (F)')
) baseline(visit_id, order_no)
join public.orders o on o.order_no = baseline.order_no;

insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
select client_event_id, id, 'active'
from public.visits
where id in (
  '7b877c90-fa8f-470e-89a0-9ed199b196e5'::uuid,
  '6300c0f5-f9e4-4a81-bead-8d4bb09a722b'::uuid,
  '99ee9716-1f67-46cb-8c62-1b314ee8e2bc'::uuid,
  'c54f550e-36c8-4460-bd06-1c38250ed88d'::uuid
);

do $verify$
declare
  v_reconciliation jsonb;
begin
  if (select count(*) from public.orders where manual_hidden = true) <> 7
     or exists (select 1 from public.shifts)
     or (select count(*) from public.visits) <> 4
     or (select count(*) from public.visit_orders) <> 4
     or (select count(*) from public.order_status
         where issued = true and returned = false and issued_by = 'Система') <> 4
     or (select count(*) from public.warehouse_event_receipts) <> 7
     or (select count(*) from public.warehouse_event_receipts
         where status = 'active' and visit_id is not null) <> 4
  then
    raise exception 'Initial state verification failed';
  end if;

  if (select count(*) from public.drafts)
       <> (select row_count from _baseline_drafts_before)
     or (select md5(coalesce(jsonb_agg(to_jsonb(d) order by d.worker), '[]'::jsonb)::text)
         from public.drafts d)
       is distinct from (select row_hash from _baseline_drafts_before)
  then
    raise exception 'Initial state verification failed: drafts changed';
  end if;

  v_reconciliation := public.warehouse_reconciliation_snapshot(date '2026-07-14');
  if jsonb_array_length(v_reconciliation->'lifecycleViolations') <> 0
  then
    raise exception 'Initial state verification failed: unexpected lifecycle violations';
  end if;
end
$verify$;

commit;
