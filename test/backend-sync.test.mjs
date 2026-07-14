import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../supabase/apps-script-sync.js', import.meta.url), 'utf8');

function context(extra = {}) {
  const c = {
    Date, JSON, encodeURIComponent,
    Utilities: {
      formatDate(value, _tz, format) {
        const date = value instanceof Date ? value : new Date(value);
        if (format === 'yyyy-MM-dd') return date.toISOString().slice(0, 10);
        if (format === 'HH:mm') return date.toISOString().slice(11, 16);
        throw new Error(`Unsupported format ${format}`);
      },
      getUuid: () => 'sync-test-id'
    },
    ...extra
  };
  vm.createContext(c);
  vm.runInContext(source, c);
  return c;
}

test('Sheets batch upsert uses one fixed JSON shape for filled and blank dates', () => {
  const requests = [];
  const filled = Array(21).fill('');
  filled[0] = '111';
  filled[2] = new Date('2026-07-15T00:00:00Z');
  filled[4] = new Date('2026-07-17T00:00:00Z');
  const blank = Array(21).fill('');
  blank[0] = '222';
  blank[16] = 'Клиент без дат';
  const response = { getResponseCode: () => 204, getContentText: () => '' };
  const c = context({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({
      getLastRow: () => 3, getLastColumn: () => 21,
      getRange: () => ({ getValues: () => [filled, blank] })
    }) }) },
    UrlFetchApp: { fetch: (url, options) => { requests.push({ url, options }); return response; } }
  });

  assert.equal(c.syncOrders().synced, 2);
  const rows = JSON.parse(requests.find(request => request.options.method === 'post').options.payload);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort());
  assert.equal(rows[1].issue_date, null);
  assert.equal(rows[1].issue_time, '');
  assert.equal(rows[1].return_date, null);
  assert.equal(rows[1].return_time, '');
});

test('fallback pagination always adds a unique stable order', () => {
  const c = context();
  const paths = [];
  c._sbGet = (_cfg, path) => { paths.push(path); return []; };
  c._sbGetAll({}, 'visits?select=*&order=visit_date.desc');
  assert.match(paths[0], /order=visit_date\.desc,id\.asc/);

  paths.length = 0;
  c._sbGetAll({}, 'orders?select=*');
  assert.match(paths[0], /order=order_no\.asc/);
});

test('RPC transport errors retry, while database constraints do not', () => {
  const offline = context({ UrlFetchApp: { fetch: () => { throw new Error('timeout'); } } });
  assert.throws(() => offline._sbRpc({ url: 'https://example.test', key: 'key' }, 'record_warehouse_visit', {}),
    error => error.retryable === true && /ошибка соединения/.test(error.message));

  const response = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () => JSON.stringify(body)
  });
  const constraint = context({ UrlFetchApp: { fetch: () => response(409, { code: '23505', message: 'duplicate' }) } });
  assert.throws(() => constraint._sbRpc({ url: 'https://example.test', key: 'key' }, 'record_warehouse_visit', {}),
    error => error.retryable === false);

  const overloaded = context({ UrlFetchApp: { fetch: () => response(503, { code: '53300', message: 'too many connections' }) } });
  assert.throws(() => overloaded._sbRpc({ url: 'https://example.test', key: 'key' }, 'record_warehouse_visit', {}),
    error => error.retryable === true);
});

test('reconciliation backend consumes one snapshot and exposes duplicate counts', () => {
  const c = context();
  const calls = [];
  c._sbRpc = (_cfg, name) => {
    calls.push(name);
    return {
      unmatchedVisits: [{ visitKey: 'v1', shiftDate: '2026-07-15', time: '10:00', orders: [] }],
      lifecycleViolations: [{ id: '111', issueDate: '2026-07-15', returnDate: '2026-07-17', category: 'duplicate_issue', issueCount: 2, returnCount: 0 }],
      linkCandidates: [{ id: 'FUTURE', issueDate: '2026-08-01', returnDate: '2026-08-03', orderType: 'issue' }]
    };
  };
  const result = c._getUnmatched({});
  assert.deepEqual(calls, ['warehouse_reconciliation_snapshot']);
  assert.equal(result.unlistedOrders[0].category, 'duplicate_issue');
  assert.equal(result.unlistedOrders[0].issueCount, 2);
  assert.equal(result.linkCandidates[0].id, 'FUTURE');
  assert.equal(result.linkCandidates[0].orderType, 'issue');
});

test('today return counters ignore a historical return without an issue', () => {
  const c = context();
  const valid = c._returnsWithIssue({ bad: true, good: true }, { good: true });
  assert.equal(valid.good, true);
  assert.equal(valid.bad, undefined);
});
