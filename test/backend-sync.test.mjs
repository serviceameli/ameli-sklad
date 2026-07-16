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

function orderHeaders() {
  const h = Array(23).fill('');
  h[0] = 'Номер заказа';
  h[2] = 'Получение, дата';
  h[3] = 'Получение, время';
  h[4] = 'Возврат, дата';
  h[5] = 'Возврат, время';
  h[6] = 'Статус';
  h[16] = 'Клиент';
  h[18] = 'Компания';
  h[22] = 'Работник';
  return h;
}

function sheetMatrix(rows) {
  const width = Math.max(...rows.map(row => row.length));
  const matrix = rows.map(row => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  return {
    getLastRow: () => matrix.length,
    getLastColumn: () => width,
    getRange(row, column, rowCount, columnCount) {
      return { getValues: () => matrix.slice(row - 1, row - 1 + rowCount)
        .map(values => values.slice(column - 1, column - 1 + columnCount)) };
    }
  };
}

test('Sheets batch upsert uses one fixed JSON shape with blank optional cells', () => {
  const requests = [];
  const filled = Array(23).fill('');
  filled[0] = '111';
  filled[2] = new Date('2026-07-15T00:00:00Z');
  filled[4] = new Date('2026-07-17T00:00:00Z');
  filled[16] = 'Первый клиент';
  filled[18] = 'Компания';
  filled[22] = 'Курьер';
  const blankOptional = Array(23).fill('');
  blankOptional[0] = '222';
  blankOptional[2] = new Date('2026-07-18T00:00:00Z');
  blankOptional[4] = new Date('2026-07-19T00:00:00Z');
  blankOptional[16] = 'Второй клиент';
  const response = { getResponseCode: () => 204, getContentText: () => '' };
  const c = context({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () =>
      sheetMatrix([orderHeaders(), filled, blankOptional]) }) },
    UrlFetchApp: { fetch: (url, options) => { requests.push({ url, options }); return response; } }
  });

  assert.equal(c.syncOrders().synced, 2);
  const rows = JSON.parse(requests.find(request => request.options.method === 'post').options.payload);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort());
  assert.equal(rows[1].issue_date, '2026-07-18');
  assert.equal(rows[1].issue_time, '');
  assert.equal(rows[1].return_date, '2026-07-19');
  assert.equal(rows[1].return_time, '');
  assert.equal(rows[1].company, '');
  assert.equal(rows[1].delivery_worker, '');
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

test('write barrier rejects tabs opened before the full reset', () => {
  const c = context();
  assert.doesNotThrow(() => c._requireDataEpoch({ dataEpoch: '2026-07-14-full-reset-v1' }));
  assert.throws(
    () => c._requireDataEpoch({ dataEpoch: 'old-page' }),
    error => error.retryable === false && /устарела/.test(error.message)
  );
  assert.throws(
    () => c._requireDataEpoch({}),
    error => error.retryable === false && /откройте ссылку заново/.test(error.message)
  );
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
