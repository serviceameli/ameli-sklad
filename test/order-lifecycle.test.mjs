import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');

function appsContext(extra = {}) {
  const context = {
    console,
    Date,
    JSON,
    encodeURIComponent,
    Utilities: {
      formatDate(value, _tz, format) {
        const d = value instanceof Date ? value : new Date(value);
        if (format === 'yyyy-MM-dd') return d.toISOString().slice(0, 10);
        if (format === 'HH:mm') return d.toISOString().slice(11, 16);
        throw new Error(`Unsupported format ${format}`);
      }
    },
    ...extra
  };
  vm.createContext(context);
  vm.runInContext(read('supabase/apps-script-sync.js'), context);
  return context;
}

test('issued order never becomes a new issue on the next day', () => {
  const c = appsContext();
  const order = { order_no: '111', issue_date: '2026-07-15', return_date: '2026-07-17', source_active: true };
  assert.equal(c._buildOrders([order], '2026-07-15', {}, {})[0].type, 'issue');
  assert.equal(c._buildOrders([order], '2026-07-16', {111:true}, {}).length, 0);
  assert.equal(c._buildOrders([order], '2026-07-17', {111:true}, {})[0].type, 'return');
  assert.equal(c._buildOrders([order], '2026-07-18', {111:true}, {})[0].overdueType, 'return');
  assert.equal(c._buildOrders([order], '2026-07-18', {111:true}, {111:true}).length, 0);
});

test('same-day order advances issue -> return -> done', () => {
  const c = appsContext();
  const order = { order_no: '222', issue_date: '2026-07-15', return_date: '2026-07-15', source_active: true };
  assert.equal(c._buildOrders([order], '2026-07-15', {}, {})[0].type, 'issue');
  assert.equal(c._buildOrders([order], '2026-07-15', {222:true}, {})[0].type, 'return');
  assert.equal(c._buildOrders([order], '2026-07-15', {222:true}, {222:true}).length, 0);
});

test('Sheets sync merges duplicate order rows into one rental', () => {
  const requests = [];
  const header = Array(31).fill('');
  const row = (issue, ret, client) => {
    const r = Array(31).fill('');
    r[0] = ' 111 '; r[2] = new Date(issue); r[4] = new Date(ret); r[16] = client; return r;
  };
  const values = [row('2026-07-15T00:00:00Z','2026-07-16T00:00:00Z','Первый'), row('2026-07-16T00:00:00Z','2026-07-17T00:00:00Z','Последний')];
  const response = { getResponseCode: () => 204, getContentText: () => '' };
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({
      getLastRow: () => 3, getLastColumn: () => header.length,
      getRange: () => ({ getValues: () => values })
    }) }) },
    UrlFetchApp: { fetch: (url, options) => { requests.push({url, options}); return response; } }
  });
  const result = c.syncOrders();
  const upsert = requests.find(x => x.options.method === 'post');
  const rows = JSON.parse(upsert.options.payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_no, '111');
  assert.equal(rows[0].issue_date, '2026-07-15');
  assert.equal(rows[0].return_date, '2026-07-17');
  assert.equal(rows[0].source_row_count, 2);
  assert.equal(result.duplicateRowsMerged, 1);
});

test('client API rejects a server error envelope', async () => {
  const context = {
    window: {}, SUPABASE_URL: 'https://example.test', SUPABASE_KEY: 'key', SYNC_URL: 'https://script.test',
    Set, Date, Promise, URLSearchParams, encodeURIComponent,
    fetch: async () => ({ ok: true, json: async () => ({ ok: false, error: 'database failed' }) })
  };
  context.window.supabase = { createClient: () => ({ from: () => ({}) }) };
  vm.createContext(context);
  vm.runInContext(read('api.js'), context);
  await assert.rejects(context.window.WHApi.getData(), /database failed/);
});

test('schema provides atomic idempotency and per-order operations', () => {
  const sql = read('supabase/migrations/202607130001_order_lifecycle.sql');
  assert.match(sql, /visits_client_event_id_uidx/);
  assert.match(sql, /record_warehouse_visit/);
  assert.match(sql, /add column if not exists operation text/);
  assert.match(sql, /delete_warehouse_visit/);
});

test('frontend queue removes items by stable clientEventId', () => {
  const staff = read('warehouse-staff.html');
  assert.match(staff, /clientEventId:newClientId\('visit'\)/);
  assert.match(staff, /x\.clientEventId!==eventId/);
  assert.doesNotMatch(staff, /findIndex\(x=>x\.entry&&p\.entry&&x\.entry\.timeAuto/);
});
