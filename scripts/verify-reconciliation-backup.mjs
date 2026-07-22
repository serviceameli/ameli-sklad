#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const moduleName = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = await import(moduleName);
const backupDir = process.argv[2];
if (!backupDir) {
  throw new Error('Usage: node scripts/verify-reconciliation-backup.mjs <backup-directory>');
}

const root = new URL('../', import.meta.url);
const sql = file => fs.readFileSync(new URL(file, root), 'utf8');
const rows = name => JSON.parse(fs.readFileSync(path.join(backupDir, `${name}.json`), 'utf8'));
const tables = ['orders', 'workers', 'shifts', 'visits', 'visit_orders', 'drafts', 'warehouse_event_receipts'];
const db = new PGlite();

try {
  await db.exec(sql('supabase/migrations/202607120000_base_schema.sql'));
  await db.exec(sql('supabase/migrations/202607130001_order_lifecycle.sql'));
  await db.exec(sql('supabase/migrations/202607140001_reset_epoch_guard.sql'));
  await db.exec(sql('supabase/migrations/202607140003_reconciliation_overdue_only.sql'));

  const expected = {};
  for (const table of tables) {
    const data = rows(table);
    expected[table] = data.length;
    if (data.length) {
      await db.query(
        `insert into public.${table}
         select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
        [JSON.stringify(data)]
      );
    }
  }

  const counts = async () => Object.fromEntries(await Promise.all(tables.map(async table => {
    const result = await db.query(`select count(*)::int as n from public.${table}`);
    return [table, result.rows[0].n];
  })));
  assert.deepEqual(await counts(), expected, 'production backup must restore without row loss');

  await db.exec(sql('supabase/migrations/202607220001_reconciliation_recovery.sql'));
  assert.deepEqual(await counts(), expected, 'migration must not change business row counts');

  const snapshotResult = await db.query(
    `select public.warehouse_reconciliation_snapshot('2026-07-22'::date) as value`
  );
  const snapshot = snapshotResult.rows[0].value;
  assert.equal(snapshot.unmatchedVisits.length, 11);
  assert.ok(snapshot.unmatchedVisits.every(visit => visit.visitDate));
  assert.ok(snapshot.unmatchedVisits.some(visit => visit.visitDate !== visit.shiftDate));

  const candidate = (orderNo, visitKey) => snapshot.correctionCandidates.find(item =>
    item.id === orderNo && (!visitKey || item.visitKey === visitKey));
  assert.equal(candidate('26-A-001944 (F)').correctionMode, 'duplicate_existing_operation');
  assert.equal(candidate('26-A-001944 (F)').canApply, false);
  assert.equal(candidate('26-A-002061').correctionMode, 'duplicate_existing_operation');
  assert.equal(candidate('26-A-002061').canApply, false);
  const duplicatedReturn = snapshot.correctionCandidates.filter(item => item.id === '26-A-002053');
  assert.equal(duplicatedReturn.length, 2);
  assert.ok(duplicatedReturn.every(item => item.requiresDuplicateConfirmation));

  const dryRun = {
    backupDir,
    counts: expected,
    unmatchedVisits: snapshot.unmatchedVisits.length,
    correctionCandidates: snapshot.correctionCandidates.length,
    lifecycleViolations: snapshot.lifecycleViolations.length,
    shiftedVisitDates: snapshot.unmatchedVisits.filter(visit => visit.visitDate !== visit.shiftDate).length,
    blockedExistingOperationDuplicates: snapshot.correctionCandidates
      .filter(item => item.correctionMode === 'duplicate_existing_operation')
      .map(item => item.id),
    duplicateVisitChoices: [...new Set(snapshot.correctionCandidates
      .filter(item => item.duplicateUnmatchedCount > 1)
      .map(item => item.id))]
  };

  await db.exec(sql('supabase/rollbacks/202607220001_reconciliation_recovery.sql'));
  assert.deepEqual(await counts(), expected, 'rollback must preserve production business rows');
  console.log(JSON.stringify(dryRun, null, 2));
} finally {
  await db.close();
}
