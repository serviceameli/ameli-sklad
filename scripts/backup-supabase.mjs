import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const outDir = process.argv[2];
const allowSequential = process.argv.includes('--allow-sequential');
if (!outDir || outDir.startsWith('--')) {
  throw new Error('Usage: node scripts/backup-supabase.mjs <output-directory> [--allow-sequential]');
}

const config = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const value = name => {
  const match = config.match(new RegExp(`const\\s+${name}\\s*=\\s*['\"]([^'\"]+)`));
  if (!match) throw new Error(`${name} not found in config.js`);
  return match[1];
};
const url = value('SUPABASE_URL');
const key = value('SUPABASE_KEY');
const resources = ['orders','workers','shifts','visits','visit_orders','drafts','order_status','warehouse_event_receipts'];
const orderBy = {
  orders: 'order_no.asc', workers: 'name.asc', shifts: 'id.asc', visits: 'id.asc',
  visit_orders: 'id.asc', drafts: 'worker.asc', order_status: 'order_no.asc',
  warehouse_event_receipts: 'client_event_id.asc'
};

fs.mkdirSync(outDir, { recursive: true });
const manifest = { createdAt: new Date().toISOString(), source: url, files: {} };

let atomicSnapshot = null;
try {
  const response = await fetch(`${url}/rest/v1/rpc/warehouse_backup_snapshot`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (response.ok) {
    const candidate = await response.json();
    if (candidate && typeof candidate === 'object' && resources.every(name => Array.isArray(candidate[name]))) {
      atomicSnapshot = candidate;
    } else {
      manifest.atomicSnapshotUnavailable = 'RPC response is missing one or more required arrays';
    }
  } else manifest.atomicSnapshotUnavailable = `HTTP ${response.status}: structural migration not deployed yet`;
} catch (error) {
  manifest.atomicSnapshotUnavailable = String(error.message || error);
}
if (!atomicSnapshot && !allowSequential) {
  throw new Error(
    `Atomic backup RPC is unavailable (${manifest.atomicSnapshotUnavailable || 'unknown error'}). ` +
    'Sequential REST backup is disabled by default; use --allow-sequential only during an explicit write freeze.'
  );
}
manifest.consistency = atomicSnapshot
  ? 'single PostgreSQL statement snapshot'
  : 'sequential REST reads during operator-confirmed write freeze';
if (!atomicSnapshot) manifest.warning = 'Non-atomic fallback explicitly enabled with --allow-sequential';

for (const resource of resources) {
  const rows = atomicSnapshot && Array.isArray(atomicSnapshot[resource]) ? atomicSnapshot[resource] : [];
  if (!atomicSnapshot) {
    for (let offset = 0; ; offset += 1000) {
      const response = await fetch(`${url}/rest/v1/${resource}?select=*&order=${orderBy[resource]}&limit=1000&offset=${offset}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (response.status === 404 && resource === 'warehouse_event_receipts') {
        manifest.files[`${resource}.json`] = { unavailable: true, reason: 'table not deployed yet' };
        break;
      }
      if (!response.ok) throw new Error(`${resource}: HTTP ${response.status} ${await response.text()}`);
      const page = await response.json();
      rows.push(...page);
      if (page.length < 1000) break;
    }
  }
  if (manifest.files[`${resource}.json`]?.unavailable) continue;
  const body = JSON.stringify(rows, null, 2) + '\n';
  const filename = `${resource}.json`;
  fs.writeFileSync(path.join(outDir, filename), body);
  manifest.files[filename] = {
    rows: rows.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex')
  };
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
