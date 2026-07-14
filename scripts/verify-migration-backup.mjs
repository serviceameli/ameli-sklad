import fs from 'node:fs';
import path from 'node:path';

const moduleName = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = await import(moduleName);
const backupDir = process.argv[2];
if (!backupDir) throw new Error('Usage: node scripts/verify-migration-backup.mjs <backup-directory>');

const root = new URL('../', import.meta.url);
const sql = file => fs.readFileSync(new URL(file, root), 'utf8');
const json = name => JSON.parse(fs.readFileSync(path.join(backupDir, `${name}.json`), 'utf8'));
const orderRows = json('orders');

const db = new PGlite();
async function load(table, columns, rows) {
  if (!rows.length) return;
  const names = columns.join(',');
  await db.query(
    `insert into public.${table}(${names}) select ${names}
     from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
    [JSON.stringify(rows)]
  );
}

try {
  await db.exec(sql('supabase/migrations/202607120000_base_schema.sql'));
  const hasLegacyDeletedAt = orderRows.some(row => Object.hasOwn(row, 'deleted_at'));
  if (hasLegacyDeletedAt) {
    await db.exec('alter table public.orders add column deleted_at timestamptz');
  }
  const orderColumns = ['order_no','client','company','issue_date','issue_time','return_date','return_time','delivery_worker','site_status','raw','synced_at'];
  if (hasLegacyDeletedAt) orderColumns.push('deleted_at');
  await load('orders', orderColumns, orderRows);
  await load('workers', ['name','pin','link','active'], json('workers'));
  await load('shifts', ['id','worker','shift_date','start_at','end_at','is_night'], json('shifts'));
  await load('visits', ['id','shift_id','worker','visitor','operation','visit_date','visit_time','is_night','is_other','comment','entered_at'], json('visits'));
  await load('visit_orders', ['id','visit_id','order_no','client_snapshot','return_date_snapshot','delivery_snapshot'], json('visit_orders'));
  await load('drafts', ['worker','data','saved_at'], json('drafts'));
  // Match the production relation type: order_status is already a view there.
  await db.exec(`create view public.order_status as
    select vo.order_no,
      bool_or(v.operation in ('issue','both')) as issued,
      bool_or(v.operation in ('return','both')) as returned,
      max(case when v.operation in ('issue','both') then v.worker end) as issued_by,
      max(case when v.operation in ('return','both') then v.worker end) as returned_by
    from public.visit_orders vo join public.visits v on v.id=vo.visit_id
    where vo.order_no is not null group by vo.order_no`);

  const before = (await db.query('select count(*)::int as n from public.visits')).rows[0].n;
  await db.exec(sql('supabase/migrations/202607130001_order_lifecycle.sql'));

  const expectedLegacyHidden = orderRows.filter(row => row.deleted_at != null).length;
  const migratedLegacyHidden = (await db.query(`select count(*)::int as n
    from public.orders where deleted_at is not null and manual_hidden=true`)).rows[0].n;
  assert(migratedLegacyHidden === expectedLegacyHidden,
    `expected ${expectedLegacyHidden} legacy soft-deleted orders to stay hidden, got ${migratedLegacyHidden}`);

  const ambiguousBeforeCleanup = await db.query(`
    select v.id, v.is_other, count(*) filter (where vo.operation is null)::int as unresolved
    from public.visits v join public.visit_orders vo on vo.visit_id=v.id
    where v.id in ('b5db4ff5-5e23-456f-aeff-4117489efe08','780cfb87-89d4-47d3-b347-12eeff321f6d')
    group by v.id,v.is_other order by v.id
  `);
  assert(ambiguousBeforeCleanup.rows.length === 2, 'two ambiguous visits must exist before cleanup');
  assert(ambiguousBeforeCleanup.rows.every(r => r.is_other && r.unresolved > 0), 'ambiguous visits must remain unresolved');
  const ambiguousOrderRows = await db.query(`select distinct order_no
    from public.visit_orders where order_no is not null and operation is null order by order_no`);
  const ambiguousOrderIds = ambiguousOrderRows.rows.map(row => row.order_no);
  assert(ambiguousOrderIds.length === 4, `expected 4 ambiguous linked orders, got ${ambiguousOrderIds.length}`);
  const staffSnapshot = (await db.query(`select public.warehouse_staff_snapshot(
    null, '2026-07-14'::date, '2026-07-12'::date) as value`)).rows[0].value;
  const staffOrderIds = new Set(staffSnapshot.orders.map(row => row.order_no));
  assert(ambiguousOrderIds.every(id => !staffOrderIds.has(id)),
    'ambiguous historical orders must be quarantined from warehouse tasks');
  const reconciliation = (await db.query(`select public.warehouse_reconciliation_snapshot(
    '2026-07-14'::date) as value`)).rows[0].value;
  const quarantinedIds = reconciliation.lifecycleViolations
    .filter(row => row.category === 'ambiguous_operation').map(row => row.id).sort();
  assert(JSON.stringify(quarantinedIds) === JSON.stringify([...ambiguousOrderIds].sort()),
    'every ambiguous order must be visible in reconciliation');
  const linkedDraftVisits = (await db.query(`select count(*)::int as n
    from public.drafts d cross join lateral jsonb_array_elements(d.data->'visits') v
    where nullif(v->>'clientEventId','') is not null and nullif(v->>'visitId','') is not null`)).rows[0].n;
  const activeReceipts = (await db.query(`select count(*)::int as n
    from public.warehouse_event_receipts where status='active'`)).rows[0].n;
  assert(linkedDraftVisits === 3, `expected 3 legacy draft visits to be linked, got ${linkedDraftVisits}`);
  assert(activeReceipts === 3, `expected 3 active receipts for legacy draft visits, got ${activeReceipts}`);

  await db.exec(sql('supabase/migrations/202607130002_remove_confirmed_retry_duplicates.sql'));
  const after = (await db.query('select count(*)::int as n from public.visits')).rows[0].n;
  const ambiguousAfter = (await db.query(`select count(*)::int as n from public.visits where id in
    ('b5db4ff5-5e23-456f-aeff-4117489efe08','780cfb87-89d4-47d3-b347-12eeff321f6d')`)).rows[0].n;
  const manualDuplicate = (await db.query(`select count(distinct v.id)::int as n
    from public.visits v join public.visit_orders vo on vo.visit_id=v.id
    where vo.order_no='26-A-001599' and vo.operation='issue'`)).rows[0].n;

  assert(before - after === 52, `expected 52 safe deletions, got ${before - after}`);
  assert(ambiguousAfter === 2, 'ambiguous visits must not be deleted');
  assert(manualDuplicate === 2, 'the disputed double issue must remain for manual review');
  console.log(JSON.stringify({ before, after, deleted: before - after,
    legacyDraftVisitsLinked: linkedDraftVisits, ambiguousKept: ambiguousAfter,
    disputedIssuesKept: manualDuplicate, legacyHiddenKept: migratedLegacyHidden,
    ambiguousOrdersQuarantined: ambiguousOrderIds.length }, null, 2));
} finally {
  await db.close();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
