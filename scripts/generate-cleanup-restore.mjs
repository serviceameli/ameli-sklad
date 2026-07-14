import fs from 'node:fs';
import path from 'node:path';

const backupDir = process.argv[2];
const outputFile = process.argv[3];
if (!backupDir || !outputFile) {
  throw new Error('Usage: node scripts/generate-cleanup-restore.mjs <backup-directory> <output.sql>');
}

const root = new URL('../', import.meta.url);
const cleanup = fs.readFileSync(new URL(
  'supabase/migrations/202607130002_remove_confirmed_retry_duplicates.sql', root
), 'utf8');
const candidateBlock = cleanup.match(/select unnest\(array\[(.*?)\]\)\s*\n\s*\),/s)?.[1];
if (!candidateBlock) throw new Error('Could not find cleanup candidate UUIDs');
const candidateIds = [...candidateBlock.matchAll(/'([0-9a-f-]{36})'::uuid/g)].map(match => match[1]);
if (candidateIds.length !== 52 || new Set(candidateIds).size !== 52) {
  throw new Error(`Expected 52 unique cleanup UUIDs, got ${candidateIds.length}`);
}

const read = name => JSON.parse(fs.readFileSync(path.join(backupDir, `${name}.json`), 'utf8'));
const wanted = new Set(candidateIds);
const visits = read('visits').filter(row => wanted.has(row.id));
const visitById = new Map(visits.map(row => [row.id, row]));
const visitOrders = read('visit_orders').filter(row => wanted.has(row.visit_id)).map(row => ({
  ...row,
  operation: effectiveOperation(visitById.get(row.visit_id)?.operation)
}));

if (visits.length !== 52) throw new Error(`Backup contains ${visits.length}/52 cleanup visits`);
if (visitOrders.length !== 52) throw new Error(`Backup contains ${visitOrders.length}/52 cleanup links`);
if (visitOrders.some(row => !row.operation)) throw new Error('A cleanup link has no deterministic operation');

const idsSql = candidateIds.map(id => `'${id}'::uuid`).join(',\n    ');
const visitsJson = dollarJson(visits);
const linksJson = dollarJson(visitOrders);
const sql = `-- Generated restore for the exact 52 cleanup candidates.
-- Source backup: ${path.basename(path.resolve(backupDir))}
-- Run only while warehouse writes are frozen.

begin;

do $$
begin
  if exists (select 1 from public.visits where id = any(array[
    ${idsSql}
  ])) then
    raise exception 'Restore aborted: one or more cleanup visits already exist';
  end if;
end
$$;

with restored as (
  select * from jsonb_populate_recordset(null::public.visits, $restore_visits$${visitsJson}$restore_visits$::jsonb)
)
insert into public.visits(
  id, shift_id, worker, visitor, operation, visit_date, visit_time,
  is_night, is_other, comment, entered_at, client_event_id
)
select id, shift_id, worker, visitor, operation, visit_date, visit_time,
       is_night, is_other, comment, entered_at, client_event_id
from restored;

with restored as (
  select * from jsonb_populate_recordset(null::public.visit_orders, $restore_links$${linksJson}$restore_links$::jsonb)
)
insert into public.visit_orders(
  id, visit_id, order_no, client_snapshot, return_date_snapshot,
  delivery_snapshot, operation
)
select id, visit_id, order_no, client_snapshot, return_date_snapshot,
       delivery_snapshot, operation
from restored;

do $$
declare
  restored_visits integer;
  restored_links integer;
begin
  select count(*) into restored_visits from public.visits where id = any(array[
    ${idsSql}
  ]);
  select count(*) into restored_links from public.visit_orders where visit_id = any(array[
    ${idsSql}
  ]);
  if restored_visits <> 52 or restored_links <> 52 then
    raise exception 'Restore verification failed: visits %, links %', restored_visits, restored_links;
  end if;
end
$$;

commit;
`;

fs.writeFileSync(outputFile, sql);
console.log(JSON.stringify({ outputFile, visits: visits.length, visitOrders: visitOrders.length }, null, 2));

function effectiveOperation(value) {
  if (['issue', 'pickup', 'Выдача', 'Получение (наш)'].includes(value)) return 'issue';
  if (['return', 'dropoff', 'Возврат', 'Возврат (наш)'].includes(value)) return 'return';
  return null;
}

function dollarJson(value) {
  const json = JSON.stringify(value);
  if (json.includes('$restore_')) throw new Error('Backup contains a reserved dollar-quote marker');
  return json;
}
