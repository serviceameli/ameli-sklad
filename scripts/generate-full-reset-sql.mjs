#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [backupDirArg, resetFileArg, rollbackFileArg] = process.argv.slice(2);
if (!backupDirArg || !resetFileArg || !rollbackFileArg) {
  throw new Error(
    'Usage: node scripts/generate-full-reset-sql.mjs ' +
    '<backup-directory> <reset.sql> <rollback.sql>'
  );
}

const backupDir = path.resolve(backupDirArg);
const resetFile = path.resolve(resetFileArg);
const rollbackFile = path.resolve(rollbackFileArg);
const tableNames = [
  'orders',
  'workers',
  'shifts',
  'visits',
  'visit_orders',
  'drafts',
  'order_status',
  'warehouse_event_receipts'
];

const manifestPath = path.join(backupDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error(`Backup manifest not found: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!String(manifest.consistency || '').includes('single PostgreSQL statement')) {
  throw new Error('Full reset requires a single-PostgreSQL-statement atomic backup');
}

const snapshot = {};
for (const table of tableNames) snapshot[table] = readVerifiedArray(table);

validateUnique(snapshot.orders, 'order_no', 'orders');
validateUnique(snapshot.workers, 'name', 'workers');
validateUnique(snapshot.shifts, 'id', 'shifts');
validateUnique(snapshot.visits, 'id', 'visits');
validateUnique(snapshot.visit_orders, 'id', 'visit_orders');
validateUnique(snapshot.drafts, 'worker', 'drafts');
validateUnique(snapshot.warehouse_event_receipts, 'client_event_id', 'warehouse_event_receipts');
validateRelations(snapshot);

const counts = Object.fromEntries(tableNames.map(name => [name, snapshot[name].length]));
const tombstoneIds = collectTombstoneIds(snapshot);
const expectedSnapshot = dollarJson('full_reset_snapshot', snapshot);
const expectedWorkers = dollarJson('full_reset_workers', snapshot.workers);
const expectedTombstones = dollarJson('full_reset_tombstones', tombstoneIds);
const sourceName = path.basename(backupDir).replace(/[^a-zA-Z0-9_.-]/g, '_');

const resetSql = `-- Generated full operational reset.
-- Source backup: ${sourceName}
-- The warehouse must remain write-frozen until all post-checks pass.
-- workers, functions, views and the durable retry ledger are preserved.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';

lock table
  public.workers,
  public.warehouse_event_receipts,
  public.drafts,
  public.visit_orders,
  public.visits,
  public.shifts,
  public.orders
in access exclusive mode;

do $preflight$
begin
  if (select count(*) from public.orders) <> ${counts.orders}
     or (select count(*) from public.workers) <> ${counts.workers}
     or (select count(*) from public.shifts) <> ${counts.shifts}
     or (select count(*) from public.visits) <> ${counts.visits}
     or (select count(*) from public.visit_orders) <> ${counts.visit_orders}
     or (select count(*) from public.drafts) <> ${counts.drafts}
     or (select count(*) from public.order_status) <> ${counts.order_status}
     or (select count(*) from public.warehouse_event_receipts) <> ${counts.warehouse_event_receipts}
  then
    raise exception 'Full reset aborted: live row counts differ from the atomic backup';
  end if;

  if public.warehouse_backup_snapshot() is distinct from ${expectedSnapshot}::jsonb then
    raise exception 'Full reset aborted: live rows differ from the atomic backup';
  end if;
end
$preflight$;

create temp table _full_reset_preserved on commit drop as
select
  count(*)::bigint as workers_count,
  md5(coalesce(jsonb_agg(to_jsonb(w) order by w.name), '[]'::jsonb)::text) as workers_hash
from public.workers w;

create temp table _full_reset_event_ids (
  client_event_id text primary key
) on commit drop;

insert into _full_reset_event_ids(client_event_id)
select client_event_id
from public.warehouse_event_receipts
on conflict do nothing;

insert into _full_reset_event_ids(client_event_id)
select nullif(trim(client_event_id), '')
from public.visits
where nullif(trim(client_event_id), '') is not null
on conflict do nothing;

insert into _full_reset_event_ids(client_event_id)
select nullif(trim(item.value->>'clientEventId'), '')
from public.drafts d
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(d.data->'visits') = 'array'
       then d.data->'visits' else '[]'::jsonb end
) item(value)
where nullif(trim(item.value->>'clientEventId'), '') is not null
on conflict do nothing;

insert into public.warehouse_event_receipts as target
  (client_event_id, visit_id, status, created_at, updated_at)
select client_event_id, null, 'deleted', clock_timestamp(), clock_timestamp()
from _full_reset_event_ids
on conflict (client_event_id) do update
set visit_id = null,
    status = 'deleted',
    updated_at = case
      when target.status = 'deleted' and target.visit_id is null then target.updated_at
      else excluded.updated_at
    end;

delete from public.drafts;
delete from public.visit_orders;
delete from public.visits;
delete from public.shifts;
delete from public.orders;

do $verify$
declare
  v_workers_count bigint;
  v_workers_hash text;
  v_expected_workers_count bigint;
  v_expected_workers_hash text;
begin
  if exists (select 1 from public.orders)
     or exists (select 1 from public.shifts)
     or exists (select 1 from public.visits)
     or exists (select 1 from public.visit_orders)
     or exists (select 1 from public.drafts)
     or exists (select 1 from public.order_status)
  then
    raise exception 'Full reset verification failed: operational rows remain';
  end if;

  if exists (
    select 1 from public.warehouse_event_receipts
    where status <> 'deleted' or visit_id is not null
  ) or (select count(*) from public.warehouse_event_receipts)
       <> (select count(*) from _full_reset_event_ids)
  then
    raise exception 'Full reset verification failed: retry tombstones are incomplete';
  end if;

  select workers_count, workers_hash
  into v_expected_workers_count, v_expected_workers_hash
  from _full_reset_preserved;
  select count(*)::bigint,
         md5(coalesce(jsonb_agg(to_jsonb(w) order by w.name), '[]'::jsonb)::text)
  into v_workers_count, v_workers_hash
  from public.workers w;
  if v_workers_count <> v_expected_workers_count
     or v_workers_hash is distinct from v_expected_workers_hash
  then
    raise exception 'Full reset verification failed: workers changed';
  end if;
end
$verify$;

commit;
`;

const rollbackSql = `-- Generated exact rollback for a full operational reset.
-- Source backup: ${sourceName}
-- Run only before the warehouse is reopened. It deliberately aborts if new data exists.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';

lock table
  public.workers,
  public.warehouse_event_receipts,
  public.drafts,
  public.visit_orders,
  public.visits,
  public.shifts,
  public.orders
in access exclusive mode;

do $rollback_preflight$
begin
  if exists (select 1 from public.orders)
     or exists (select 1 from public.shifts)
     or exists (select 1 from public.visits)
     or exists (select 1 from public.visit_orders)
     or exists (select 1 from public.drafts)
     or exists (select 1 from public.order_status)
  then
    raise exception 'Full reset rollback aborted: new operational data exists';
  end if;

  if coalesce((
       select jsonb_agg(to_jsonb(w) order by w.name) from public.workers w
     ), '[]'::jsonb) is distinct from ${expectedWorkers}::jsonb
  then
    raise exception 'Full reset rollback aborted: workers changed';
  end if;

  if exists (
       select 1 from public.warehouse_event_receipts
       where status <> 'deleted' or visit_id is not null
     )
     or coalesce((
       select jsonb_agg(client_event_id order by client_event_id)
       from public.warehouse_event_receipts
     ), '[]'::jsonb) is distinct from ${expectedTombstones}::jsonb
  then
    raise exception 'Full reset rollback aborted: retry ledger changed after reset';
  end if;
end
$rollback_preflight$;

delete from public.warehouse_event_receipts;

insert into public.orders
select * from jsonb_populate_recordset(null::public.orders,
  ${dollarJson('restore_orders', snapshot.orders)}::jsonb);

insert into public.shifts
select * from jsonb_populate_recordset(null::public.shifts,
  ${dollarJson('restore_shifts', snapshot.shifts)}::jsonb);

insert into public.visits
select * from jsonb_populate_recordset(null::public.visits,
  ${dollarJson('restore_visits', snapshot.visits)}::jsonb);

insert into public.visit_orders
select * from jsonb_populate_recordset(null::public.visit_orders,
  ${dollarJson('restore_visit_orders', snapshot.visit_orders)}::jsonb);

insert into public.drafts
select * from jsonb_populate_recordset(null::public.drafts,
  ${dollarJson('restore_drafts', snapshot.drafts)}::jsonb);

insert into public.warehouse_event_receipts
select * from jsonb_populate_recordset(null::public.warehouse_event_receipts,
  ${dollarJson('restore_receipts', snapshot.warehouse_event_receipts)}::jsonb);

do $rollback_verify$
begin
  if (select count(*) from public.orders) <> ${counts.orders}
     or (select count(*) from public.workers) <> ${counts.workers}
     or (select count(*) from public.shifts) <> ${counts.shifts}
     or (select count(*) from public.visits) <> ${counts.visits}
     or (select count(*) from public.visit_orders) <> ${counts.visit_orders}
     or (select count(*) from public.drafts) <> ${counts.drafts}
     or (select count(*) from public.order_status) <> ${counts.order_status}
     or (select count(*) from public.warehouse_event_receipts) <> ${counts.warehouse_event_receipts}
  then
    raise exception 'Full reset rollback verification failed: restored counts differ';
  end if;

  if public.warehouse_backup_snapshot() is distinct from ${expectedSnapshot}::jsonb then
    raise exception 'Full reset rollback verification failed: restored rows differ';
  end if;
end
$rollback_verify$;

commit;
`;

fs.mkdirSync(path.dirname(resetFile), { recursive: true });
fs.mkdirSync(path.dirname(rollbackFile), { recursive: true });
fs.writeFileSync(resetFile, resetSql);
fs.writeFileSync(rollbackFile, rollbackSql);

console.log(JSON.stringify({
  backupDir,
  resetFile,
  rollbackFile,
  counts,
  tombstones: tombstoneIds.length,
  resetSha256: sha256(resetSql),
  rollbackSha256: sha256(rollbackSql)
}, null, 2));

function readVerifiedArray(name) {
  const filename = `${name}.json`;
  const file = path.join(backupDir, filename);
  if (!fs.existsSync(file)) throw new Error(`Backup file not found: ${file}`);
  const raw = fs.readFileSync(file);
  const metadata = manifest.files?.[filename];
  if (!metadata?.sha256) throw new Error(`Manifest SHA-256 missing for ${filename}`);
  const actualHash = sha256(raw);
  if (actualHash !== metadata.sha256) {
    throw new Error(`${filename} SHA-256 mismatch: ${actualHash} != ${metadata.sha256}`);
  }
  const rows = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(rows)) throw new Error(`${filename} must contain a JSON array`);
  if (metadata.rows !== undefined && metadata.rows !== rows.length) {
    throw new Error(`${filename} row count mismatch: ${rows.length} != ${metadata.rows}`);
  }
  return rows;
}

function validateUnique(rows, key, table) {
  const seen = new Set();
  for (const row of rows) {
    const value = row?.[key];
    if (value === null || value === undefined || value === '') {
      throw new Error(`${table}.${key} contains an empty primary key`);
    }
    if (seen.has(value)) throw new Error(`${table}.${key} contains duplicate ${value}`);
    seen.add(value);
  }
}

function validateRelations(data) {
  const shiftIds = new Set(data.shifts.map(row => row.id));
  const visitIds = new Set(data.visits.map(row => row.id));
  for (const visit of data.visits) {
    if (visit.shift_id && !shiftIds.has(visit.shift_id)) {
      throw new Error(`visits.${visit.id} refers to missing shift ${visit.shift_id}`);
    }
  }
  for (const link of data.visit_orders) {
    if (link.visit_id && !visitIds.has(link.visit_id)) {
      throw new Error(`visit_orders.${link.id} refers to missing visit ${link.visit_id}`);
    }
  }
  for (const receipt of data.warehouse_event_receipts) {
    if (receipt.visit_id && !visitIds.has(receipt.visit_id)) {
      throw new Error(`receipt ${receipt.client_event_id} refers to missing visit ${receipt.visit_id}`);
    }
  }
}

function collectTombstoneIds(data) {
  const ids = new Set();
  for (const receipt of data.warehouse_event_receipts) addId(receipt.client_event_id);
  for (const visit of data.visits) addId(visit.client_event_id);
  for (const draft of data.drafts) {
    const visits = Array.isArray(draft?.data?.visits) ? draft.data.visits : [];
    for (const visit of visits) addId(visit?.clientEventId);
  }
  return [...ids].sort();

  function addId(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id) ids.add(id);
  }
}

function dollarJson(label, value) {
  const json = JSON.stringify(value);
  let suffix = '';
  while (json.includes(`$${label}${suffix}$`)) suffix += '_x';
  const tag = `$${label}${suffix}$`;
  return `${tag}${json}${tag}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
