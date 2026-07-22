#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleName = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = await import(moduleName);
const backupFile = process.argv[2];
if (!backupFile) throw new Error('Usage: node scripts/verify-duplicate-backup.mjs <backup-json>');

const root = new URL('../', import.meta.url);
const sql = file => fs.readFileSync(new URL(file, root), 'utf8');
const envelope = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
const backup = envelope?.rows?.[0]?.backup || envelope?.backup || envelope;
const tables = ['orders', 'workers', 'shifts', 'visits', 'visit_orders', 'drafts', 'warehouse_event_receipts'];
const db = new PGlite();

async function counts() {
  return Object.fromEntries(await Promise.all(tables.map(async table => {
    const result = await db.query(`select count(*)::int as n from public.${table}`);
    return [table, result.rows[0].n];
  })));
}

async function snapshot() {
  const result = await db.query(
    `select public.warehouse_reconciliation_snapshot('2026-07-22'::date) as value`
  );
  return result.rows[0].value;
}

try {
  await db.exec(sql('supabase/migrations/202607120000_base_schema.sql'));
  await db.exec(sql('supabase/migrations/202607130001_order_lifecycle.sql'));
  await db.exec(sql('supabase/migrations/202607140001_reset_epoch_guard.sql'));
  await db.exec(sql('supabase/migrations/202607140003_reconciliation_overdue_only.sql'));
  await db.exec(sql('supabase/migrations/202607220001_reconciliation_recovery.sql'));

  // The backup is a point-in-time image, not a sequence of live writes. Restore
  // historical rows without replaying the current chronology guard row by row;
  // the guard is enabled again before migration and behavior checks begin.
  await db.exec('alter table public.visit_orders disable trigger user');

  const expected = {};
  for (const table of tables) {
    const rows = Array.isArray(backup[table]) ? backup[table] : [];
    expected[table] = rows.length;
    if (rows.length) {
      await db.query(
        `insert into public.${table}
         select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
        [JSON.stringify(rows)]
      );
    }
  }
  await db.exec('alter table public.visit_orders enable trigger user');
  assert.deepEqual(await counts(), expected, 'production backup must restore without row loss');

  const before = await snapshot();
  await db.exec(sql('supabase/migrations/202607220002_mark_duplicate_visit.sql'));
  assert.deepEqual(await counts(), expected, 'migration must not change business row counts');
  const migrated = await snapshot();
  assert.equal(migrated.unmatchedVisits.length, before.unmatchedVisits.length);

  await db.exec(sql('supabase/rollbacks/202607220002_mark_duplicate_visit.sql'));
  assert.deepEqual(await counts(), expected, 'rollback must preserve business rows before audit exists');
  await db.exec(sql('supabase/migrations/202607220002_mark_duplicate_visit.sql'));

  const liveSnapshot = await snapshot();
  const candidate = liveSnapshot.correctionCandidates.find(
    row => row.correctionMode === 'duplicate_existing_operation'
  );
  assert.ok(candidate, 'production snapshot must contain a proven duplicate candidate');
  const visit = liveSnapshot.unmatchedVisits.find(row => row.visitKey === candidate.visitKey);
  assert.ok(visit, 'duplicate candidate must have its unmatched visit');

  const marked = await db.query(
    `select public.mark_warehouse_visit_duplicate($1::jsonb) as value`,
    [JSON.stringify({
      visitId: visit.visitKey,
      orderId: candidate.id,
      reason: 'Dry-run подтверждённого дубля',
      actor: 'Автоматическая проверка',
      expectedVisitDate: visit.visitDate,
      expectedVisitTime: visit.time,
      expectedOperation: candidate.operation,
      confirmDuplicate: true
    })]
  );
  assert.equal(marked.rows[0].value.excluded, true);
  assert.deepEqual(await counts(), expected, 'marking a duplicate must preserve every raw row');
  const afterMark = await snapshot();
  assert.equal(afterMark.unmatchedVisits.length, liveSnapshot.unmatchedVisits.length - 1);
  assert.equal(afterMark.unmatchedVisits.some(row => row.visitKey === visit.visitKey), false);

  console.log(JSON.stringify({
    backupFile,
    counts: expected,
    unmatchedBefore: before.unmatchedVisits.length,
    duplicateCandidates: before.correctionCandidates
      .filter(row => row.correctionMode === 'duplicate_existing_operation')
      .map(row => row.id),
    simulatedOrder: candidate.id,
    simulatedVisit: visit.visitKey,
    unmatchedAfterSimulation: afterMark.unmatchedVisits.length
  }, null, 2));
} finally {
  await db.close();
}
