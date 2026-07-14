#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  throw new Error('Usage: node scripts/backup-supabase-management.mjs <output-directory>');
}

const config = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const urlMatch = config.match(/const\s+SUPABASE_URL\s*=\s*['"]https:\/\/([^.]+)\.supabase\.co/);
if (!urlMatch) throw new Error('SUPABASE_URL not found in config.js');
const projectRef = urlMatch[1];
const tokenFile = path.join(os.homedir(), '.supabase', 'access-token');
const token = process.env.SUPABASE_ACCESS_TOKEN ||
  (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
if (!token) throw new Error('Supabase CLI access token not found; run supabase login first');

const query = `
select jsonb_build_object(
  'orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.order_no) from public.orders x), '[]'::jsonb),
  'workers', coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from public.workers x), '[]'::jsonb),
  'shifts', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.shifts x), '[]'::jsonb),
  'visits', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.visits x), '[]'::jsonb),
  'visit_orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.visit_orders x), '[]'::jsonb),
  'drafts', coalesce((select jsonb_agg(to_jsonb(x) order by x.worker) from public.drafts x), '[]'::jsonb),
  'order_status', coalesce((select jsonb_agg(to_jsonb(x) order by x.order_no) from public.order_status x), '[]'::jsonb),
  'catalog', jsonb_build_object(
    'columns', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.table_name, c.ordinal_position)
      from (
        select table_name, column_name, ordinal_position, data_type, udt_name,
               is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public'
      ) c
    ), '[]'::jsonb),
    'views', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.relname, 'definition', pg_get_viewdef(c.oid, true)) order by c.relname)
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
    ), '[]'::jsonb)
  )
) as snapshot
`;

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query/read-only`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query })
});
if (!response.ok) {
  throw new Error(`Supabase read-only backup failed: HTTP ${response.status} ${await response.text()}`);
}
const payload = await response.json();
const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.result) ? payload.result : []);
const snapshot = rows[0]?.snapshot;
if (!snapshot || typeof snapshot !== 'object') {
  throw new Error('Supabase read-only backup returned an unexpected response');
}

fs.mkdirSync(outDir, { recursive: true });
const manifest = {
  createdAt: new Date().toISOString(),
  projectRef,
  consistency: 'single PostgreSQL statement via Supabase Management API read-only endpoint',
  files: {}
};
for (const [name, value] of Object.entries(snapshot)) {
  const filename = `${name}.json`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, filename), body);
  manifest.files[filename] = {
    rows: Array.isArray(value) ? value.length : undefined,
    sha256: crypto.createHash('sha256').update(body).digest('hex')
  };
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
