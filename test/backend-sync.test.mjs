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
      unmatchedVisits: [{ visitKey: 'v1', visitDate: '2026-07-19', shiftDate: '2026-07-15', time: '10:00',
        suggestedOrderId: '111', suggestionAmbiguous: false, orders: [] }],
      lifecycleViolations: [{ id: '111', issueDate: '2026-07-15', returnDate: '2026-07-17', category: 'duplicate_issue', issueCount: 2, returnCount: 0 }],
      linkCandidates: [{ id: 'FUTURE', issueDate: '2026-08-01', returnDate: '2026-08-03', orderType: 'issue' }],
      correctionCandidates: [{ visitKey: 'v1', id: '111', client: 'Клиент', issueDate: '2026-07-15',
        returnDate: '2026-07-19', operation: 'return', manualHidden: true, correctionMode: 'seed_issue_and_link_return', canApply: true }]
    };
  };
  const result = c._getUnmatched({});
  assert.deepEqual(calls, ['warehouse_reconciliation_snapshot']);
  assert.equal(result.unlistedOrders[0].category, 'duplicate_issue');
  assert.equal(result.unlistedOrders[0].issueCount, 2);
  assert.equal(result.linkCandidates[0].id, 'FUTURE');
  assert.equal(result.linkCandidates[0].orderType, 'issue');
  assert.equal(result.unmatchedVisits[0].visitDate, '2026-07-19');
  assert.equal(result.unmatchedVisits[0].shiftDate, '2026-07-15');
  assert.equal(result.unmatchedVisits[0].suggestedOrderId, '111');
  assert.equal(result.unmatchedVisits[0].suggestionAmbiguous, false);
  assert.equal(result.correctionCandidates[0].visitKey, 'v1');
  assert.equal(result.correctionCandidates[0].issueDate, '15.07.2026');
  assert.equal(result.correctionCandidates[0].returnDate, '19.07.2026');
  assert.equal(result.correctionCandidates[0].correctionMode, 'seed_issue_and_link_return');
});

test('staff backend passes durable duplicate tombstones with safe empty fallbacks', () => {
  const c = context();
  c._sbRpc = () => ({
    workers: [], orders: [], statuses: [], otherRows: [], otherLinks: [], todayEvents: [],
    excludedVisitIds: ['visit-duplicate', 'visit-legacy'],
    excludedClientEventIds: ['event-duplicate']
  });
  const result = c._getData({}, 'Тестовый кладовщик');
  assert.deepEqual(result.excludedVisitIds, ['visit-duplicate', 'visit-legacy']);
  assert.deepEqual(result.excludedClientEventIds, ['event-duplicate']);

  c._sbRpc = () => ({});
  const fallback = c._getData({}, 'Тестовый кладовщик');
  assert.deepEqual(Array.from(fallback.excludedVisitIds), []);
  assert.deepEqual(Array.from(fallback.excludedClientEventIds), []);
});

test('manager correction sends only the documented payload and returns the RPC result', () => {
  const c = context();
  let call;
  c._sbRpc = (_cfg, name, body) => {
    call = { name, body };
    return { ok: true, linked: true, baselineCreated: true, correctionMode: 'seed_issue_and_link_return' };
  };

  const result = c._applyManagerCorrection({}, {
    action: 'applyManagerCorrection', dataEpoch: 'ignored-by-helper',
    visitId: ' visit-1 ', orderId: ' 111 ', reason: ' Проверено ', actor: ' Менеджер ',
    expectedVisitDate: '19.07.2026', expectedVisitTime: '7:05',
    baselineIssueDate: '18.07.2026', baselineIssueTime: '09:15', confirmDuplicate: false
  });

  assert.equal(call.name, 'apply_warehouse_manager_correction');
  assert.deepEqual(JSON.parse(JSON.stringify(call.body)), { p_payload: {
    visitId: 'visit-1', orderId: '111', reason: 'Проверено', actor: 'Менеджер',
    expectedVisitDate: '2026-07-19', expectedVisitTime: '07:05',
    baselineIssueDate: '2026-07-18', baselineIssueTime: '09:15', confirmDuplicate: false
  }});
  assert.equal(result.ok, true);
  assert.equal(result.baselineCreated, true);
});

test('manager correction rejects incomplete or invalid optimistic-concurrency data', () => {
  const c = context();
  c._sbRpc = () => { throw new Error('RPC must not be called'); };
  const valid = {
    visitId: 'v1', orderId: '111', reason: 'Проверено', actor: 'Менеджер',
    expectedVisitDate: '2026-07-19', expectedVisitTime: '07:05'
  };
  assert.throws(() => c._applyManagerCorrection({}, { ...valid, expectedVisitDate: '' }), /expectedVisitDate is required/);
  assert.throws(() => c._applyManagerCorrection({}, { ...valid, expectedVisitTime: '25:90' }), /Неверное время/);
  assert.throws(() => c._applyManagerCorrection({}, { ...valid, baselineIssueDate: '2026-07-18' }), /must be provided together/);
});

test('manager correction preserves a semantic RPC error for the POST response', () => {
  const output = {};
  const c = context({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'configured' }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(value) {
        output.value = value;
        return { setMimeType() { return this; } };
      }
    }
  });
  c._sbRpc = () => ({ ok: false, error: 'Визит изменился, обновите сверку', retryable: false });
  c.doPost({ postData: { contents: JSON.stringify({
    action: 'applyManagerCorrection', dataEpoch: '2026-07-14-full-reset-v1',
    visitId: 'v1', orderId: '111', reason: 'Проверено', actor: 'Менеджер',
    expectedVisitDate: '2026-07-19', expectedVisitTime: '07:05'
  }) } });
  assert.deepEqual(JSON.parse(output.value), {
    ok: false, error: 'Визит изменился, обновите сверку', retryable: false
  });

  c._sbRpc = () => {
    const error = new Error('RPC apply_warehouse_manager_correction → 409: stale visit');
    error.retryable = false;
    throw error;
  };
  c.doPost({ postData: { contents: JSON.stringify({
    action: 'applyManagerCorrection', dataEpoch: '2026-07-14-full-reset-v1',
    visitId: 'v1', orderId: '111', reason: 'Проверено', actor: 'Менеджер',
    expectedVisitDate: '2026-07-19', expectedVisitTime: '07:05'
  }) } });
  const thrownEnvelope = JSON.parse(output.value);
  assert.equal(thrownEnvelope.ok, false);
  assert.equal(thrownEnvelope.retryable, false);
  assert.match(thrownEnvelope.error, /stale visit/);
});

test('duplicate marking sends the guarded optimistic payload to one RPC', () => {
  const c = context();
  let call;
  c._sbRpc = (_cfg, name, args) => {
    call = { name, args };
    return { ok: true, excluded: true, idempotent: false };
  };
  const result = c._markVisitDuplicate({}, {
    visitId: '62000000-0000-0000-0000-000000000002',
    orderId: '26-A-001944 (F)',
    reason: ' Повтор подтверждён ', actor: ' Менеджер ',
    expectedVisitDate: '19.07.2026', expectedVisitTime: '06:56',
    expectedOperation: 'dropoff', confirmDuplicate: true,
    originalVisitId: '62000000-0000-0000-0000-000000000003'
  });

  assert.equal(result.excluded, true);
  assert.equal(call.name, 'mark_warehouse_visit_duplicate');
  assert.deepEqual(JSON.parse(JSON.stringify(call.args.p_payload)), {
    visitId: '62000000-0000-0000-0000-000000000002',
    orderId: '26-A-001944 (F)', reason: 'Повтор подтверждён', actor: 'Менеджер',
    expectedVisitDate: '2026-07-19', expectedVisitTime: '06:56',
    expectedOperation: 'return', confirmDuplicate: true,
    originalVisitId: '62000000-0000-0000-0000-000000000003'
  });
});

test('duplicate marking rejects weak confirmation before transport', () => {
  const c = context();
  const valid = {
    visitId: 'v1', orderId: '26-A-001944 (F)', reason: 'Повтор подтверждён', actor: 'Менеджер',
    expectedVisitDate: '2026-07-19', expectedVisitTime: '06:56',
    expectedOperation: 'return', confirmDuplicate: true
  };
  assert.throws(() => c._markVisitDuplicate({}, { ...valid, reason: 'мало' }), /at least 6/);
  assert.throws(() => c._markVisitDuplicate({}, { ...valid, confirmDuplicate: false }), /confirmDuplicate=true/);
  assert.throws(() => c._markVisitDuplicate({}, { ...valid, expectedOperation: 'both' }), /issue or return/);
  assert.throws(() => c._markVisitDuplicate({}, { ...valid, expectedVisitTime: '25:61' }), /Неверное время/);
});

test('today return counters ignore a historical return without an issue', () => {
  const c = context();
  const valid = c._returnsWithIssue({ bad: true, good: true }, { good: true });
  assert.equal(valid.good, true);
  assert.equal(valid.bad, undefined);
});
