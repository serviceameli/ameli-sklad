#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const moduleName = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = await import(moduleName);
const [backupDirArg, resetFileArg, rollbackFileArg] = process.argv.slice(2);
if (!backupDirArg || !resetFileArg || !rollbackFileArg) {
  throw new Error(
    'Usage: node scripts/verify-full-reset.mjs ' +
    '<backup-directory> <reset.sql> <rollback.sql>'
  );
}

const backupDir = path.resolve(backupDirArg);
const resetFile = path.resolve(resetFileArg);
const rollbackFile = path.resolve(rollbackFileArg);
const root = new URL('../', import.meta.url);
const migration = file => fs.readFileSync(new URL(file, root), 'utf8');
const readRows = name => JSON.parse(fs.readFileSync(path.join(backupDir, `${name}.json`), 'utf8'));
const snapshot = {
  orders: readRows('orders'),
  workers: readRows('workers'),
  shifts: readRows('shifts'),
  visits: readRows('visits'),
  visit_orders: readRows('visit_orders'),
  drafts: readRows('drafts'),
  order_status: readRows('order_status'),
  warehouse_event_receipts: readRows('warehouse_event_receipts')
};
const resetSql = fs.readFileSync(resetFile, 'utf8');
const rollbackSql = fs.readFileSync(rollbackFile, 'utf8');
const expectedTombstones = collectTombstoneIds(snapshot);
const beforeHashes = hashSnapshot(snapshot);

const db = new PGlite();
try {
  await db.exec(migration('supabase/migrations/202607120000_base_schema.sql'));
  if (snapshot.orders.some(row => Object.hasOwn(row, 'deleted_at'))) {
    await db.exec('alter table public.orders add column if not exists deleted_at timestamptz');
  }
  await db.exec(migration('supabase/migrations/202607130001_order_lifecycle.sql'));

  await load('orders', snapshot.orders);
  await load('workers', snapshot.workers);
  await load('shifts', snapshot.shifts);
  await load('visits', snapshot.visits);
  await load('visit_orders', snapshot.visit_orders);
  await load('drafts', snapshot.drafts);
  await load('warehouse_event_receipts', snapshot.warehouse_event_receipts);

  const loadedSnapshot = await databaseSnapshot();
  assertSameSnapshot(loadedSnapshot, snapshot, 'production backup load');
  const schemaBefore = await schemaSignature();

  await db.exec(resetSql);

  const resetCounts = await counts();
  for (const table of ['orders', 'shifts', 'visits', 'visit_orders', 'drafts', 'order_status']) {
    assert(resetCounts[table] === 0, `reset left ${resetCounts[table]} rows in ${table}`);
  }
  assert(resetCounts.workers === snapshot.workers.length,
    `reset changed worker count: ${resetCounts.workers} != ${snapshot.workers.length}`);
  assert(resetCounts.warehouse_event_receipts === expectedTombstones.length,
    `reset tombstone count ${resetCounts.warehouse_event_receipts} != ${expectedTombstones.length}`);

  const resetWorkers = await rows('select * from public.workers order by name');
  assert(hash(resetWorkers) === hash(snapshot.workers), 'reset changed worker rows');
  const resetReceipts = await rows(`
    select client_event_id, visit_id, status
    from public.warehouse_event_receipts order by client_event_id
  `);
  assert(resetReceipts.every(row => row.status === 'deleted' && row.visit_id === null),
    'reset left a receipt active or linked to a deleted visit');
  assert(stableStringify(resetReceipts.map(row => row.client_event_id)) === stableStringify(expectedTombstones),
    'reset receipt IDs differ from the expected durable tombstone set');
  assert(stableStringify(await schemaSignature()) === stableStringify(schemaBefore),
    'reset changed functions or views');

  await db.exec(rollbackSql);

  const restoredSnapshot = await databaseSnapshot();
  assertSameSnapshot(restoredSnapshot, snapshot, 'rollback');
  const restoredHashes = hashSnapshot(restoredSnapshot);
  assert(stableStringify(restoredHashes) === stableStringify(beforeHashes),
    'rollback table hashes differ from the source backup');
  assert(stableStringify(await schemaSignature()) === stableStringify(schemaBefore),
    'rollback changed functions or views');

  console.log(JSON.stringify({
    backupDir,
    resetFile,
    rollbackFile,
    sourceCounts: Object.fromEntries(Object.entries(snapshot).map(([name, value]) => [name, value.length])),
    resetCounts,
    tombstones: expectedTombstones.length,
    workersPreserved: snapshot.workers.length,
    schemaObjectsPreserved: schemaBefore.length,
    rollbackExact: true,
    hashes: beforeHashes
  }, null, 2));
} finally {
  await db.close();
}

async function load(table, values) {
  if (!values.length) return;
  await db.query(
    `insert into public.${table}
     select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
    [JSON.stringify(values)]
  );
}

async function databaseSnapshot() {
  const result = await db.query('select public.warehouse_backup_snapshot() as value');
  return result.rows[0].value;
}

async function counts() {
  const result = await db.query(`
    select
      (select count(*)::integer from public.orders) as orders,
      (select count(*)::integer from public.workers) as workers,
      (select count(*)::integer from public.shifts) as shifts,
      (select count(*)::integer from public.visits) as visits,
      (select count(*)::integer from public.visit_orders) as visit_orders,
      (select count(*)::integer from public.drafts) as drafts,
      (select count(*)::integer from public.order_status) as order_status,
      (select count(*)::integer from public.warehouse_event_receipts) as warehouse_event_receipts
  `);
  return result.rows[0];
}

async function rows(query) {
  return (await db.query(query)).rows;
}

async function schemaSignature() {
  const result = await db.query(`
    select kind, name, definition_hash
    from (
      select 'function'::text as kind,
             p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
             md5(pg_get_functiondef(p.oid)) as definition_hash
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (p.proname like 'warehouse_%'
             or p.proname in ('record_warehouse_visit', 'delete_warehouse_visit',
                              'save_warehouse_draft', 'clear_warehouse_draft',
                              'link_warehouse_visit', 'close_warehouse_shift'))
      union all
      select 'view'::text as kind,
             c.relname as name,
             md5(pg_get_viewdef(c.oid, true)) as definition_hash
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and c.relname in ('order_status', 'warehouse_order_events')
    ) objects
    order by kind, name
  `);
  return result.rows;
}

function assertSameSnapshot(actual, expected, label) {
  for (const name of Object.keys(expected)) {
    const actualHash = hash(actual[name]);
    const expectedHash = hash(expected[name]);
    assert(actualHash === expectedHash,
      `${label}: ${name} hash ${actualHash} != ${expectedHash}`);
  }
}

function hashSnapshot(value) {
  return Object.fromEntries(Object.entries(value).map(([name, rowsValue]) => [name, hash(rowsValue)]));
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function collectTombstoneIds(data) {
  const ids = new Set();
  for (const receipt of data.warehouse_event_receipts) add(receipt.client_event_id);
  for (const visit of data.visits) add(visit.client_event_id);
  for (const draft of data.drafts) {
    const visits = Array.isArray(draft?.data?.visits) ? draft.data.visits : [];
    for (const visit of visits) add(visit?.clientEventId);
  }
  return [...ids].sort();

  function add(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id) ids.add(id);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
