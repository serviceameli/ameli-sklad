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

function orderHeaders() {
  const h = Array(31).fill('');
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

function inlineScript(file) {
  const html = read(file);
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function frontendContext(file, extra = {}) {
  const { initialStorage = {}, ...contextExtra } = extra;
  const storage = new Map(Object.entries(initialStorage));
  const localStorage = {
    get length() { return storage.size; },
    key: index => [...storage.keys()][index] ?? null,
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {}, value: '', innerHTML: '', textContent: '', disabled: false,
      querySelectorAll: () => [], querySelector: () => null, insertAdjacentHTML(_where, html) { this.innerHTML += html; }
    });
    return elements.get(id);
  };
  const context = {
    console, Date, JSON, Math, Set, Map, Promise, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage,
    location: { search: '' }, navigator: { onLine: true },
    crypto: { randomUUID: () => 'test-uuid' },
    document: {
      addEventListener() {},
      getElementById: element,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => element(`created-${elements.size}`)
    },
    window: { addEventListener() {}, scrollTo() {}, confirm: () => true },
    Blob: class {}, URL: { createObjectURL: () => 'blob:test' },
    ...contextExtra
  };
  context.globalThis = context;
  context.window.window = context.window;
  Object.assign(context.window, context);
  vm.createContext(context);
  // Страница сама запускает init(). В unit-тестах вызываем только проверяемые
  // функции, иначе фоновая загрузка продолжает жить после завершения теста.
  vm.runInContext(inlineScript(file).replace(/^init\(\);\s*$/gm, ''), context);
  return { context, storage, elements, element };
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

test('an inactive source row still waits for return after issue', () => {
  const c = appsContext();
  const order = { order_no: '111', issue_date: '2026-07-15', return_date: '2026-07-17', source_active: false };
  assert.equal(c._buildOrders([order], '2026-07-17', {}, {}).length, 0,
    'an inactive unissued row must not become a new task');
  assert.equal(c._buildOrders([order], '2026-07-17', {111:true}, {})[0].type, 'return');
  const returnedToday=c._buildVisibleOrders([order], '2026-07-17', {111:true}, {111:true}, {}, {111:true});
  assert.equal(returnedToday[0].processedTodayReturn, true);
});

test('an unresolved historical order is quarantined from warehouse tasks', () => {
  const c = appsContext();
  const order = { order_no: 'AMB', issue_date: '2026-07-15', return_date: '2026-07-17',
    source_active: true, lifecycle_ambiguous: true };
  assert.equal(c._buildOrders([order], '2026-07-18', {}, {}).length, 0);
  assert.equal(c._buildOrders([order], '2026-07-18', {AMB:true}, {}).length, 0);
});

test('processed order stays visible today but not as a new order tomorrow', () => {
  const c = appsContext();
  const order = { order_no: '111', issue_date: '2026-07-15', return_date: '2026-07-17', source_active: true };
  const today = c._buildVisibleOrders([order], '2026-07-15', {111:true}, {}, {111:true}, {});
  assert.equal(today.length, 1);
  assert.equal(today[0].processedTodayIssue, true);
  assert.equal(today[0].type, 'issue');
  assert.equal(c._buildVisibleOrders([order], '2026-07-16', {111:true}, {}, {}, {}).length, 0);
  assert.equal(c._buildVisibleOrders([order], '2026-07-17', {111:true}, {}, {}, {})[0].type, 'return');
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
  const header = orderHeaders();
  const row = (issue, ret, client) => {
    const r = Array(31).fill('');
    r[0] = ' 111 '; r[2] = new Date(issue); r[4] = new Date(ret); r[16] = client; return r;
  };
  const values = [row('2026-07-15T00:00:00Z','2026-07-16T00:00:00Z','Клиент'), row('2026-07-16T00:00:00Z','2026-07-17T00:00:00Z','Клиент')];
  const response = { getResponseCode: () => 204, getContentText: () => '' };
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, ...values]) }) },
    UrlFetchApp: { fetch: (url, options) => { requests.push({url, options}); return response; } }
  });
  const result = c.syncOrders();
  const upsert = requests.find(x => x.options.method === 'post');
  const deactivate = requests.find(x => x.options.method === 'patch');
  const rows = JSON.parse(upsert.options.payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_no, '111');
  assert.equal(rows[0].issue_date, '2026-07-15');
  assert.equal(rows[0].return_date, '2026-07-17');
  assert.equal(rows[0].source_row_count, 2);
  assert.ok(rows[0].source_sync_id);
  assert.ok(deactivate.url.length < 500, 'deactivation must not contain every order number');
  assert.match(deactivate.url, /source_sync_id/);
  assert.equal(result.duplicateRowsMerged, 1);
});

test('Sheets sync resolves reordered columns by their headers', () => {
  const requests = [];
  const header = ['Объем, м3', 'Работник', 'Клиент', 'Возврат, дата',
    'Номер заказа', 'Получение, дата', 'Компания', 'Статус',
    'Возврат, время', 'Получение, время'];
  const row = [0.5, 'Максим Асадулин', 'Елена Горяйнова', new Date('2026-07-17T00:00:00Z'),
    '26-A-000772', new Date('2026-07-15T00:00:00Z'), 'sweet william', 'В работе', '18:00', '10:00'];
  const response = { getResponseCode: () => 204, getContentText: () => '' };
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, row]) }) },
    UrlFetchApp: { fetch: (url, options) => { requests.push({url, options}); return response; } }
  });

  const result = c.syncOrders();
  const payload = JSON.parse(requests.find(x => x.options.method === 'post').options.payload)[0];
  assert.equal(result.headerRow, 1);
  assert.equal(payload.order_no, '26-A-000772');
  assert.equal(payload.client, 'Елена Горяйнова');
  assert.equal(payload.delivery_worker, 'Максим Асадулин');
  assert.equal(payload.company, 'sweet william');
  assert.equal(payload.issue_date, '2026-07-15');
  assert.equal(payload.return_date, '2026-07-17');
  assert.notEqual(payload.client, '0.5');
});

test('Sheets sync finds headers after preamble rows', () => {
  const requests = [];
  const header = orderHeaders();
  const row = Array(31).fill('');
  row[0] = '111'; row[2] = '15.07.2026'; row[4] = '17.07.2026';
  row[16] = 'Анна Иванова';
  const response = { getResponseCode: () => 204, getContentText: () => '' };
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([
      ['Экспорт заказов'], ['Номер заказа'], header, row
    ]) }) },
    UrlFetchApp: { fetch: (url, options) => { requests.push({url, options}); return response; } }
  });

  const result = c.syncOrders();
  assert.equal(result.headerRow, 3);
  assert.equal(result.synced, 1);
  const payload = JSON.parse(requests.find(x => x.options.method === 'post').options.payload)[0];
  assert.deepEqual(payload.raw.sourceRows, [4]);
});

test('Sheets sync rejects a missing required header before any write', () => {
  let fetches = 0;
  const header = orderHeaders();
  header[22] = '';
  const row = Array(31).fill('');
  row[0] = '111'; row[2] = '15.07.2026'; row[4] = '17.07.2026'; row[16] = 'Клиент';
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, row]) }) },
    UrlFetchApp: { fetch: () => { fetches++; throw new Error('must not fetch'); } }
  });
  assert.throws(() => c.syncOrders(), /обязательные колонки.*Работник/i);
  assert.equal(fetches, 0);
});

test('Sheets sync rejects duplicate normalized headers before any write', () => {
  let fetches = 0;
  const header = orderHeaders();
  header.push('  клиент\u00a0');
  const row = Array(header.length).fill('');
  row[0] = '111'; row[2] = '15.07.2026'; row[4] = '17.07.2026'; row[16] = 'Клиент';
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, row]) }) },
    UrlFetchApp: { fetch: () => { fetches++; throw new Error('must not fetch'); } }
  });
  assert.throws(() => c.syncOrders(), /Колонки найдены несколько раз.*Клиент/i);
  assert.equal(fetches, 0);
});

test('Sheets sync rejects numeric or blank clients before any write', () => {
  for (const badClient of [0.5, '']) {
    let fetches = 0;
    const header = orderHeaders();
    const row = Array(31).fill('');
    row[0] = '111'; row[2] = '15.07.2026'; row[4] = '17.07.2026'; row[16] = badClient;
    const c = appsContext({
      PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, row]) }) },
      UrlFetchApp: { fetch: () => { fetches++; throw new Error('must not fetch'); } }
    });
    assert.throws(() => c.syncOrders(), /строке 2.*Клиент/i);
    assert.equal(fetches, 0);
  }
});

test('Sheets sync rejects reversed dates and conflicting duplicate clients', () => {
  const makeContext = rows => {
    let fetches = 0;
    const c = appsContext({
      PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix(rows) }) },
      UrlFetchApp: { fetch: () => { fetches++; throw new Error('must not fetch'); } }
    });
    return { c, getFetches: () => fetches };
  };
  const reversed = Array(31).fill('');
  reversed[0] = '111'; reversed[2] = '18.07.2026'; reversed[4] = '17.07.2026'; reversed[16] = 'Клиент';
  const first = makeContext([orderHeaders(), reversed]);
  assert.throws(() => first.c.syncOrders(), /дата выдачи.*позже даты возврата/i);
  assert.equal(first.getFetches(), 0);

  const duplicate = client => {
    const row = Array(31).fill('');
    row[0] = '111'; row[2] = '15.07.2026'; row[4] = '17.07.2026'; row[16] = client;
    return row;
  };
  const second = makeContext([orderHeaders(), duplicate('Анна'), duplicate('Мария')]);
  assert.throws(() => second.c.syncOrders(), /повторяется с разными клиентами/i);
  assert.equal(second.getFetches(), 0);
});

test('Sheets sync rejects an invalid date instead of replacing it with today', () => {
  let fetches = 0;
  const header = orderHeaders();
  const row = Array(31).fill(''); row[0] = '111'; row[2] = 'not-a-date';
  row[4] = new Date('2026-07-17T00:00:00Z'); row[16] = 'Клиент';
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, row]) }) },
    UrlFetchApp: { fetch: () => { fetches++; throw new Error('must not fetch'); } }
  });
  assert.throws(() => c.syncOrders(), /Неверная дата/);
  assert.equal(fetches, 0);
});

test('Sheets sync rejects a zero date before any write', () => {
  let fetches = 0;
  const header = orderHeaders();
  const row = Array(31).fill('');
  row[0] = '111'; row[2] = 0; row[4] = '17.07.2026'; row[16] = 'Клиент';
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, row]) }) },
    UrlFetchApp: { fetch: () => { fetches++; throw new Error('must not fetch'); } }
  });
  assert.throws(() => c.syncOrders(), /Неверная дата.*строке 2/i);
  assert.equal(fetches, 0);
});

test('Sheets sync rejects an impossible calendar date', () => {
  const header = orderHeaders();
  const row = Array(31).fill(''); row[0] = '111'; row[2] = '31.02.2026';
  row[4] = '17.07.2026'; row[16] = 'Клиент';
  const c = appsContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SUPABASE_URL' ? 'https://example.test' : 'key' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetMatrix([header, row]) }) }
  });
  assert.throws(() => c.syncOrders(), /Неверная дата/);
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
  assert.match(sql, /link_warehouse_visit/);
  assert.match(sql, /save_warehouse_draft/);
  assert.match(sql, /clear_warehouse_draft/);
  assert.match(sql, /warehouse_staff_snapshot/);
  assert.match(sql, /warehouse_dashboard_snapshot/);
  assert.match(sql, /warehouse_reconciliation_snapshot/);
  assert.match(sql, /warehouse_worker_history_snapshot/);
  assert.match(sql, /warehouse_backup_snapshot/);
  assert.match(sql, /warehouse_merge_draft_visits/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /warehouse_effective_operation/);
  assert.match(sql, /warehouse_event_receipts/);
  assert.match(sql, /status = 'deleted'/);
  assert.match(sql, /issue cannot be deleted while its return exists/);
  assert.match(sql, /end_at = coalesce\(public\.shifts\.end_at, excluded\.end_at\)/);
  assert.match(sql, /v_saved_at timestamptz := clock_timestamp\(\)/);
  assert.match(sql, /Shift is already closed/);
  assert.match(sql, /Shift has unrecorded draft visits/);
  assert.doesNotMatch(sql, /coalesce\(vo\.operation, v\.operation\) in \('issue', 'both'\)/);
  assert.match(read('supabase/migrations/202607130002_remove_confirmed_retry_duplicates.sql'), /safe_exact/);
});

test('frontend queue removes items by stable clientEventId', () => {
  const staff = read('warehouse-staff.html');
  assert.match(staff, /clientEventId:newClientId\('visit'\)/);
  assert.match(staff, /x\.clientEventId!==eventId/);
  assert.doesNotMatch(staff, /findIndex\(x=>x\.entry&&p\.entry&&x\.entry\.timeAuto/);
});

test('client data epoch clears only operational local state before queue recovery', async () => {
  let addVisitCalls = 0;
  const pending = JSON.stringify([{ clientEventId: 'old-event', worker: 'Склад', shiftStart: '2026-07-01T06:00:00.000Z', entry: {} }]);
  const { context, storage } = frontendContext('warehouse-staff.html', {
    initialStorage: {
      wh_draft: '{}',
      'wh_draft_Иван': '{}',
      wh_draft_conflict: '{}',
      'wh_draft_conflict_Иван': '{}',
      wh_pending_visits: pending,
      wh_visit_acks: '{}',
      wh_shifts: '[]',
      'wh_auth_Иван': '1',
      unrelated_key: 'keep'
    },
    WHApi: { addVisit: async () => { addVisitCalls++; return { visitId: 'unexpected' }; } }
  });

  for (const key of ['wh_draft', 'wh_draft_Иван', 'wh_draft_conflict',
    'wh_draft_conflict_Иван', 'wh_pending_visits', 'wh_visit_acks', 'wh_shifts']) {
    assert.equal(storage.has(key), false, `${key} must be cleared`);
  }
  assert.equal(storage.get('wh_auth_Иван'), '1');
  assert.equal(storage.get('unrelated_key'), 'keep');
  assert.equal(storage.get('wh_data_epoch'), '2026-07-14-full-reset-v1');
  assert.equal(await context.flushPendingVisits(), true);
  assert.equal(addVisitCalls, 0);
});

test('client data epoch is one-shot and a stale marker triggers the next cleanup', () => {
  const { context, storage } = frontendContext('warehouse-staff.html', {
    initialStorage: { wh_data_epoch: 'previous-epoch', 'wh_draft_Иван': '{}', 'wh_auth_Иван': '1' }
  });
  assert.equal(storage.has('wh_draft_Иван'), false);
  assert.equal(storage.get('wh_data_epoch'), '2026-07-14-full-reset-v1');

  storage.set('wh_draft_Иван', '{"new":true}');
  assert.equal(context.applyClientDataEpoch(), false);
  assert.equal(storage.get('wh_draft_Иван'), '{"new":true}');
  assert.equal(storage.get('wh_auth_Иван'), '1');
});

test('client data reset runs before init can flush the offline queue', () => {
  const staff = read('warehouse-staff.html');
  const resetCall = staff.indexOf('applyClientDataEpoch();');
  const initDefinition = staff.indexOf('async function init()');
  const firstFlush = staff.indexOf('flushPendingVisits();', initDefinition);
  assert.ok(resetCall >= 0 && resetCall < initDefinition);
  assert.ok(resetCall < firstFlush);
});

test('legacy offline queue gets one deterministic persisted event id', () => {
  const { context, storage } = frontendContext('warehouse-staff.html', { WHApi: { addVisit: async () => ({ visitId: 'v1' }) } });
  const payload = { worker: 'Склад', shiftStart: '2026-07-15T06:00:00Z', entry: {
    visitor: 'client', operation: 'issue', date: '2026-07-15', time: '10:00', timeAuto: '10:01',
    timestamp: '2026-07-15T07:01:00Z', orders: [{ id: '111', operation: 'issue' }]
  } };
  storage.set('wh_pending_visits', JSON.stringify([structuredClone(payload), structuredClone(payload)]));
  const queue = context.readPendingVisits();
  assert.equal(queue.length, 1);
  assert.match(queue[0].clientEventId, /^visit-legacy-/);
  assert.equal(JSON.parse(storage.get('wh_pending_visits'))[0].clientEventId, queue[0].clientEventId);
  assert.equal(context.readPendingVisits()[0].clientEventId, queue[0].clientEventId);
});

test('mixed visit keeps a manual operation for an unlisted order', () => {
  const { context } = frontendContext('warehouse-staff.html');
  vm.runInContext(`
    pendingOrders=[{id:'111',type:'issue'},{id:'222',type:'return'},{id:'__other__',type:null}];
    operation='return';
    serverIssuedToday=new Set(); serverReturnedToday=new Set(); visits=[];
  `, context);
  assert.equal(context.getEffectiveOperation(), 'both');
  const staff = read('warehouse-staff.html');
  assert.match(staff, /o\.id==='__other__' \? operation/);
});

test('a restored draft resends every unacknowledged visit idempotently', async () => {
  const sent = [];
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    addVisit: async payload => { sent.push(payload); return { visitId: 'server-v1', shiftId: 'server-s1' }; },
    saveDraft: async () => ({ ok: true })
  } });
  vm.runInContext(`
    worker='Склад'; shiftStart=new Date('2026-07-15T06:00:00Z'); clientShiftId='shift-1';
    visits=[{clientEventId:'visit-1',visitor:'client',operation:'issue',orders:[{id:'111',operation:'issue'}],date:'2026-07-15',time:'10:00',timeAuto:'10:01',ts:'2026-07-15T07:01:00Z',night:false}];
  `, context);
  context.enqueueRestoredVisits();
  assert.equal(await context.flushPendingVisits(true), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].clientEventId, 'visit-1');
  assert.equal(vm.runInContext('visits[0].visitId', context), 'server-v1');
});

test('a restored acknowledged visit is revalidated and a server tombstone removes it', async () => {
  const sent = [];
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    addVisit: async payload => { sent.push(payload.clientEventId); return { deleted: true, idempotent: true }; },
    saveDraft: async () => ({ ok: true })
  } });
  Object.assign(context, { __noop() {}, __save: () => Promise.resolve() });
  vm.runInContext(`
    renderTable=__noop;updateOrdersBar=__noop;renderOrderCards=__noop;populateOrders=__noop;saveDraft=__save;
    worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';
    visits=[{clientEventId:'visit-deleted',visitId:'old-server-id',visitor:'client',operation:'issue',orders:[{id:'111',operation:'issue'}],date:'2026-07-15',time:'10:00',timeAuto:'10:01',ts:'2026-07-15T07:01:00Z',night:false}];
  `, context);
  context.enqueueRestoredVisits();
  assert.equal(await context.flushPendingVisits(true), true);
  assert.deepEqual(sent, ['visit-deleted']);
  assert.equal(vm.runInContext('visits.length', context), 0);
});

test('a permanent server error is visible and is not retried forever', async () => {
  let calls = 0;
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    addVisit: async () => { calls++; const e = new Error('Order 111 is already issued'); e.retryable = false; throw e; }
  } });
  vm.runInContext(`worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';visits=[];`, context);
  context.queuePendingVisit({clientEventId:'visit-bad',clientShiftId:'shift-1',worker:'Склад',shiftStart:'2026-07-15T06:00:00.000Z',entry:{}}, false);
  assert.equal(await context.flushPendingVisits(true), false);
  assert.equal(await context.flushPendingVisits(true), false);
  assert.equal(calls, 1);
  assert.match(context.readPendingVisits()[0]._blockedError, /already issued/);
});

test('a permanently rejected visit is excluded from optimistic lifecycle status', async () => {
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    addVisit: async () => { const error = new Error('return before issue'); error.retryable = false; throw error; },
    saveDraft: async () => ({ ok: true })
  } });
  Object.assign(context, { __noop() {} });
  vm.runInContext(`
    renderTable=__noop;updateOrdersBar=__noop;renderOrderCards=__noop;populateOrders=__noop;
    worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';
    serverIssuedToday=new Set();serverReturnedToday=new Set();
    visits=[{clientEventId:'visit-bad-return',visitor:'client',operation:'return',orders:[{id:'111',operation:'return'}],date:'2026-07-15',time:'10:00',timeAuto:'10:00',ts:'2026-07-15T07:00:00Z',night:false}];
  `, context);
  context.queuePendingVisit(context.buildVisitPayload(vm.runInContext('visits[0]', context)), false);
  assert.equal(await context.flushPendingVisits(true), false);
  assert.equal(vm.runInContext('visits[0].syncBlocked', context), true);
  assert.equal(context.getSessionStatuses().returnedIds.has('111'), false);
});

test('draft serialization removes an in-flight delete flag', async () => {
  const { context, storage } = frontendContext('warehouse-staff.html', { WHApi: { saveDraft: async () => ({ ok: true }) } });
  vm.runInContext(`
    worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';
    visits=[{_deleting:true,clientEventId:'visit-1',visitor:'client',operation:'issue',orders:[],date:'2026-07-15',time:'10:00',timeAuto:'10:00'}];
  `, context);
  await context.saveDraft();
  const stored = JSON.parse(storage.get('wh_draft_Склад'));
  assert.equal(Object.hasOwn(stored.visits[0], '_deleting'), false);
  const normalized = context.normalizeDraft({ worker: 'Склад', shiftStart: '2026-07-15T06:00:00Z', visits: stored.visits });
  assert.equal(Object.hasOwn(normalized.visits[0], '_deleting'), false);
});

test('a newer local draft inherits server ids for the same legacy visit', () => {
  const { context } = frontendContext('warehouse-staff.html');
  const visit = { visitor: 'client', operation: 'issue', date: '2026-07-15', time: '10:00',
    timeAuto: '10:00', comment: '', orders: [{ id: '111', operation: 'issue' }] };
  const local = { worker: 'Склад', shiftStart: '2026-07-15T06:00:00Z', savedAt: '2026-07-15T10:00:01Z', visits: [structuredClone(visit)] };
  const server = { worker: 'Склад', shiftStart: '2026-07-15T06:00:00Z', savedAt: '2026-07-15T10:00:00Z',
    visits: [{ ...structuredClone(visit), clientEventId: 'visit-migrated', visitId: 'server-visit' }] };
  const chosen = context.pickNewestDraft(JSON.stringify(local), server);
  assert.equal(chosen.visits[0].clientEventId, 'visit-migrated');
  assert.equal(chosen.visits[0].visitId, 'server-visit');
});

test('in-memory queue still blocks closing when localStorage write fails', () => {
  const brokenStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  const { context } = frontendContext('warehouse-staff.html', { localStorage: brokenStorage });
  context.queuePendingVisit({clientEventId:'visit-memory',worker:'Склад',shiftStart:'2026-07-15T06:00:00.000Z',entry:{}}, false);
  assert.equal(context.readPendingVisits().length, 1);
  assert.equal(context.readPendingVisits()[0].clientEventId, 'visit-memory');
});

test('parallel deletes remove local visits by event id, not stale array index', async () => {
  const deferred = new Map();
  const calls = [];
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    deleteVisit: payload => { calls.push(payload.clientEventId); return new Promise(resolve => deferred.set(payload.clientEventId, resolve)); }
  } });
  Object.assign(context, {
    __confirm: async () => true, __noop() {}, __save: () => Promise.resolve(), __refresh: async () => {}
  });
  vm.runInContext(`
    stConfirm=__confirm;renderTable=__noop;updateOrdersBar=__noop;renderOrderCards=__noop;populateOrders=__noop;
    saveDraft=__save;refreshOrdersFromServer=__refresh;
  `, context);
  vm.runInContext(`
    worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';
    visits=[
      {clientEventId:'visit-a',visitId:'server-a',visitor:'client',operation:'issue',orders:[],date:'2026-07-15',time:'10:00',timeAuto:'10:01'},
      {clientEventId:'visit-b',visitId:'server-b',visitor:'client',operation:'issue',orders:[],date:'2026-07-15',time:'10:02',timeAuto:'10:03'}
    ];
  `, context);
  const first = context.delVisit(0);
  const second = context.delVisit(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(new Set(calls), new Set(['visit-a','visit-b']));
  deferred.get('visit-b')({ ok: true }); await second;
  assert.deepEqual(Array.from(vm.runInContext('visits.map(v=>v.clientEventId)', context)), ['visit-a']);
  deferred.get('visit-a')({ ok: true }); await first;
  assert.equal(vm.runInContext('visits.length', context), 0);
});

test('starting a new shift from view-only clears the closed shift visits', async () => {
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    getData: async () => ({ orders: [], processedOrders: {} }),
    saveDraft: async () => ({ ok: true, ignored: false })
  } });
  Object.assign(context, { __noop() {}, __asyncNoop: async () => {}, __save: () => Promise.resolve() });
  vm.runInContext(`
    showScreen=__noop;switchShiftTab=__noop;renderPendingOrders=__noop;setVisitor=__noop;
    updateDateLabel=__noop;updateShiftInfoCard=__noop;startAutosave=__noop;startOrdersRefresh=__noop;
    refreshOrdersFromServer=__asyncNoop;saveDraft=__save;
    worker='Склад';viewOnlyMode=true;visits=[{clientEventId:'old-visit'}];
  `, context);
  await context.startShiftFromViewOnly();
  assert.equal(vm.runInContext('visits.length', context), 0);
  assert.match(vm.runInContext('clientShiftId', context), /^shift-/);
});

test('a corrupt local shift history cannot strand an already closed server shift', async () => {
  let successPayload = null;
  const { context, storage } = frontendContext('warehouse-staff.html', { WHApi: {
    getData: async () => ({ draft: null }), closeShift: async () => ({ ok: true })
  } });
  Object.assign(context, {
    __true: async () => true, __wait: async () => {}, __noop() {},
    __success: payload => { successPayload = payload; }
  });
  storage.set('wh_shifts', '{broken json');
  storage.set('wh_draft_Склад', '{}');
  vm.runInContext(`
    flushPendingVisits=__true;waitForDraftSaves=__wait;stopAutosave=__noop;stopOrdersRefresh=__noop;
    showSuccess=__success;worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';visits=[];
  `, context);
  await context.confirmSubmit();
  assert.equal(successPayload.clientShiftId, 'shift-1');
  assert.equal(storage.has('wh_draft_Склад'), false);
  assert.equal(JSON.parse(storage.get('wh_shifts')).length, 1);
});

test('dashboard counts processed real orders today and ignores ambiguous mixed operations', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`
    todayOrders=[{id:'111',type:'issue',client:'Client',issueDate:'15.07.2026',returnDate:'17.07.2026',processedTodayIssue:true}];
    serverProcessed={issued:['111'],returned:[],issuedToday:['111'],returnedToday:[],otherVisits:[]};
    allVisits=[];
  `, context);
  context.renderOrders();
  assert.match(element('ordersSummary').innerHTML, /\u0412ыдано сегодня<\/div><div class="sc-n">1</);
  assert.equal(context.orderOperation({ operation: 'both' }, { operation: null }), null);
});

test('dashboard keeps completed same-day rentals visible', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`
    archivedOrders=[];allVisits=[];
    todayOrders=[{id:'222',type:'issue',sameDay:true,client:'Client',issueDate:'15.07.2026',returnDate:'15.07.2026',processedTodayIssue:true,processedTodayReturn:true}];
    serverProcessed={issued:['222'],returned:['222'],issuedToday:['222'],returnedToday:['222'],otherVisits:[]};
  `, context);
  context.renderOrders();
  assert.match(element('ordersContent').innerHTML, /Завершены сегодня/);
  assert.match(element('ordersContent').innerHTML, /222/);
});

test('dashboard preserves the last successful snapshot after a refresh error', async () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} }, WHApi: {
    getAll: async () => { throw new Error('offline'); }, getUnmatched: async () => ({ unmatchedVisits: [], unlistedOrders: [] })
  } });
  Object.assign(context, { renderAll() {}, updateLinkBadge() {} });
  vm.runInContext(`allShifts=[];todayOrders=[{id:'keep-me'}];archivedOrders=[];`, context);
  await context.loadData();
  assert.equal(vm.runInContext('todayOrders[0].id', context), 'keep-me');
  assert.match(element('rfts').textContent, /Ошибка загрузки/);
});

test('dashboard rendering does not hide a refresh error behind a fresh timestamp', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  element('dateFrom').value='2026-07-01';element('dateTo').value='2026-07-14';
  element('rfts').textContent='⚠️ Ошибка загрузки — показаны последние данные';
  vm.runInContext(`allVisits=[];`, context);
  context.renderStats();
  assert.match(element('rfts').textContent, /Ошибка загрузки/);
});

test('dashboard ignores an older loadData response that finishes last', async () => {
  const resolvers = [];
  const { context } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} }, WHApi: {
    getAll: () => new Promise(resolve => resolvers.push(resolve)),
    getUnmatched: async () => ({ unmatchedVisits: [], unlistedOrders: [] })
  } });
  Object.assign(context, { renderAll() {}, updateLinkBadge() {}, renderLinkTab() {} });
  const payload = id => ({
    shifts: [], orders: [{ id }], archivedOrders: [],
    processedOrders: { issued: [], returned: [], issuedToday: [], returnedToday: [], otherVisits: [] }
  });

  const older = context.loadData();
  const newer = context.loadData();
  assert.equal(resolvers.length, 2);
  resolvers[1](payload('newer'));
  await newer;
  resolvers[0](payload('older'));
  await older;

  assert.equal(vm.runInContext('todayOrders[0].id', context), 'newer');
});

test('dashboard ignores an older reconciliation response that finishes last', async () => {
  const resolvers = [];
  const { context } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} }, WHApi: {
    getUnmatched: () => new Promise(resolve => resolvers.push(resolve))
  } });
  Object.assign(context, { renderLinkTab() {}, updateLinkBadge() {} });

  const older = context.loadUnmatched();
  const newer = context.loadUnmatched();
  resolvers[1]({ unmatchedVisits: [{ visitKey: 'newer' }], unlistedOrders: [] });
  await newer;
  resolvers[0]({ unmatchedVisits: [{ visitKey: 'older' }], unlistedOrders: [] });
  await older;

  assert.equal(vm.runInContext('unmatchedData.unmatchedVisits[0].visitKey', context), 'newer');
});

test('reconciliation badge counts visits and lifecycle violations', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`unmatchedData={unmatchedVisits:[{visitKey:'v1'}],unlistedOrders:[{id:'1'},{id:'2'}]};`, context);
  context.updateLinkBadge();

  assert.equal(element('linkBadge').textContent, 3);
  assert.equal(element('linkBadge').style.display, 'inline');
  assert.match(element('linkNotifTitle').textContent, /1 несвязанный визит/);
  assert.match(element('linkNotifTitle').textContent, /2 нарушения жизненного цикла/);
});

test('reconciliation badge marks stale data after a refresh error', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`unmatchedData={unmatchedVisits:[{visitKey:'old'}],unlistedOrders:[],linkCandidates:[]};unmatchedLoadError=new Error('offline');`, context);
  context.updateLinkBadge();
  assert.equal(element('linkBadge').textContent, '!');
  assert.match(element('linkNotifTitle').textContent, /Ошибка обновления/);
});

test('background reconciliation failure updates the visible badge', async () => {
  let badgeUpdates = 0;
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} }, WHApi: {
    getAll: async () => ({ shifts: [], orders: [], archivedOrders: [], processedOrders: {} }),
    getUnmatched: async () => { throw new Error('offline'); }
  } });
  Object.assign(context, { renderAll() {}, updateLinkBadge() {
    badgeUpdates++;
    element('linkBadge').textContent = '!';
  } });
  await context.loadData();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(badgeUpdates, 1);
  assert.equal(element('linkBadge').textContent, '!');
});

test('reconciliation keeps previous rows visible after a refresh error', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`unmatchedData={
    unmatchedVisits:[{visitKey:'old',shiftDate:'2026-07-14',time:'10:00',worker:'Склад',operation:'issue',orders:[]}],
    unlistedOrders:[],linkCandidates:[]
  };unmatchedLoadError=new Error('offline');`, context);
  context.renderLinkTab();
  assert.match(element('linkContent').innerHTML, /предыдущие данные/);
  assert.match(element('linkContent').innerHTML, /visit-card/);
});

test('journal reports its total and reveals more rows explicitly', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`
    allVisits=Array.from({length:350},(_,i)=>({
      dateISO:todayMsk(),time:'10:00',ordersArr:[],isOther:false,isNight:false,
      worker:'Worker',visitor:'client',operation:'issue',comment:'',id:String(i)
    }));
    logPeriod=7;logVisibleLimit=LOG_PAGE_SIZE;
  `, context);

  context.renderLog();
  assert.match(element('logPager').innerHTML, /Показано 300 из 350/);
  assert.match(element('logPager').innerHTML, /Показать ещё/);
  assert.equal((element('logTbody').innerHTML.match(/<tr>/g) || []).length, 300);

  context.showMoreLog();
  assert.match(element('logPager').innerHTML, /Показано 350 из 350/);
  assert.doesNotMatch(element('logPager').innerHTML, /Показать ещё/);
  assert.equal((element('logTbody').innerHTML.match(/<tr>/g) || []).length, 350);
});

test('CSV escaping neutralizes spreadsheet formulas', () => {
  const { context } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  assert.equal(context.csvEsc('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(context.csvEsc('  @command'), "'  @command");
  assert.equal(context.csvEsc('+1+2'), "'+1+2");
  assert.equal(context.csvEsc('normal'), 'normal');
  assert.equal(context.csvEsc('=1;2'), '"\'=1;2"');
});

test('client delete can target an in-flight visit by stable event id', async () => {
  let body;
  const context = {
    window: {}, SUPABASE_URL: 'https://example.test', SUPABASE_KEY: 'key', SYNC_URL: 'https://script.test',
    Set, Date, Promise, URLSearchParams, encodeURIComponent,
    fetch: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true }) }; }
  };
  context.window.supabase = { createClient: () => ({ from: () => ({}) }) };
  vm.createContext(context); vm.runInContext(read('api.js'), context);
  await context.window.WHApi.deleteVisit({ clientEventId: 'visit-123' });
  assert.equal(body.action, 'deleteVisit');
  assert.equal(body.clientEventId, 'visit-123');
});

test('client clears only the intended draft generation', async () => {
  let body;
  const context = {
    window: {}, SUPABASE_URL: 'https://example.test', SUPABASE_KEY: 'key', SYNC_URL: 'https://script.test',
    Set, Date, Promise, URLSearchParams, encodeURIComponent,
    fetch: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true }) }; }
  };
  context.window.supabase = { createClient: () => ({ from: () => ({}) }) };
  vm.createContext(context); vm.runInContext(read('api.js'), context);
  await context.window.WHApi.clearDraft({ worker: 'Склад', clientShiftId: 'shift-new', shiftStart: '2026-07-15T06:00:00Z' });
  assert.deepEqual(body, {
    action: 'clearDraft', worker: 'Склад', clientShiftId: 'shift-new', shiftStart: '2026-07-15T06:00:00Z',
    dataEpoch: '2026-07-14-full-reset-v1'
  });
  assert.equal(context.window.WAREHOUSE_DATA_EPOCH, '2026-07-14-full-reset-v1');
});

test('same-shift drafts from two devices are merged without trusting client savedAt', () => {
  const { context } = frontendContext('warehouse-staff.html');
  const local = { worker: 'Склад', clientShiftId: 'shift-1', shiftStart: '2026-07-15T06:00:00Z',
    savedAt: '2099-01-01T00:00:00Z', visits: [{ clientEventId: 'local', visitor: 'client', operation: 'issue', date: '2026-07-15', time: '10:00', orders: [] }] };
  const server = { worker: 'Склад', clientShiftId: 'shift-1', shiftStart: '2026-07-15T06:00:00Z',
    savedAt: '2026-07-15T10:01:00Z', visits: [{ clientEventId: 'server', visitor: 'client', operation: 'return', date: '2026-07-15', time: '10:01', orders: [] }] };
  const merged = context.pickNewestDraft(JSON.stringify(local), server);
  assert.deepEqual(new Set(Array.from(merged.visits, v => v.clientEventId)), new Set(['local', 'server']));
  assert.equal(merged.savedAt, server.savedAt);
  const sameFields = { visitor: 'client', operation: 'issue', date: '2026-07-15', time: '11:00', orders: [] };
  assert.equal(context.mergeDraftVisits(
    [{ ...sameFields, clientEventId: 'device-a' }],
    [{ ...sameFields, clientEventId: 'device-b' }]
  ).length, 2, 'different stable ids must stay independently auditable');
  assert.equal(context.sameDraftShift(
    { worker: 'Склад', clientShiftId: 'legacy-a', shiftStart: '2026-07-15T06:00:00Z' },
    { worker: 'Склад', clientShiftId: 'legacy-b', shiftStart: '2026-07-15T06:00:00Z' }
  ), true, 'legacy devices fall back to worker and exact start time');
});

test('opening a shift waits for the server reservation before showing work UI', async () => {
  let resolveSave;
  const events = [];
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    saveDraft: () => { events.push('reserve'); return new Promise(resolve => { resolveSave = resolve; }); }
  } });
  Object.assign(context, {
    __show: () => events.push('show'), __noop() {}, __refresh: async () => {}
  });
  vm.runInContext(`
    worker='Склад';viewOnlyMode=true;showScreen=__show;updateShiftInfoCard=__noop;switchShiftTab=__noop;
    renderPendingOrders=__noop;setVisitor=__noop;updateDateLabel=__noop;
    refreshOrdersFromServer=__refresh;updateOrdersBar=__noop;renderOrderCards=__noop;
    startAutosave=__noop;startOrdersRefresh=__noop;
  `, context);
  const opening = context.startShift();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['reserve']);
  assert.equal(vm.runInContext('viewOnlyMode', context), true);
  resolveSave({ ok: true, ignored: false });
  await opening;
  assert.deepEqual(events, ['reserve', 'show']);
  assert.equal(vm.runInContext('viewOnlyMode', context), false);
});

test('a concurrent start restores the already reserved server shift', async () => {
  const existing = { worker: 'Склад', clientShiftId: 'server-shift',
    shiftStart: '2026-07-15T06:00:00Z', savedAt: '2099-07-15T06:01:00Z', visits: [] };
  let restored = null;
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    saveDraft: async () => ({ ok: true, ignored: true, reason: 'different active draft exists', draft: existing })
  } });
  Object.assign(context, { __restore: draft => { restored = draft; } });
  vm.runInContext(`worker='Склад';restoreShiftDirect=__restore;`, context);
  await context.startShift();
  assert.equal(restored.clientShiftId, 'server-shift');
  assert.equal(vm.runInContext('clientShiftId', context), 'shift-test-uuid');
});

test('an offline draft conflict is persistent and blocks further mutations', async () => {
  const server = { worker: 'Склад', clientShiftId: 'server-shift',
    shiftStart: '2026-07-15T06:00:00Z', savedAt: '2026-07-15T06:01:00Z', visits: [] };
  const { context, storage } = frontendContext('warehouse-staff.html', { WHApi: {
    saveDraft: async () => ({ ok: true, ignored: true, reason: 'different active draft exists', draft: server })
  } });
  Object.assign(context, { __noop() {} });
  vm.runInContext(`
    worker='Склад';shiftStart=new Date('2026-07-16T06:00:00Z');clientShiftId='offline-shift';
    visits=[{clientEventId:'offline-visit',visitor:'client',operation:'issue',date:'2026-07-16',time:'10:00',orders:[{id:'111',operation:'issue'}]}];
    renderTable=__noop;checkReady=__noop;
  `, context);
  const result=await context.saveDraft();
  assert.equal(result.ok, false);
  assert.equal(vm.runInContext('draftConflict!==null', context), true);
  assert.ok(storage.get('wh_draft_conflict_Склад'));
  assert.equal(context.shiftMutationBlocked(), true);
});

test('different local and server drafts preserve the local shift as a conflict', () => {
  const { context, storage } = frontendContext('warehouse-staff.html');
  const local = { worker: 'Склад', clientShiftId: 'local-shift', shiftStart: '2026-07-15T06:00:00Z',
    savedAt: '2026-07-15T07:00:00Z', visits: [{ clientEventId: 'local-event', visitor: 'client', operation: 'issue', date: '2026-07-15', time: '10:00', orders: [] }] };
  const server = { worker: 'Склад', clientShiftId: 'server-shift', shiftStart: '2026-07-16T06:00:00Z',
    savedAt: '2026-07-16T07:00:00Z', visits: [] };
  Object.assign(context, { __noop() {} });
  vm.runInContext(`worker='Склад';renderTable=__noop;checkReady=__noop;`, context);
  const chosen=context.pickDraftPreservingConflict(JSON.stringify(local), server);
  assert.equal(chosen.clientShiftId, 'server-shift');
  const saved=JSON.parse(storage.get('wh_draft_conflict_Склад'));
  assert.equal(saved.localDraft.visits[0].clientEventId, 'local-event');
  assert.equal(vm.runInContext('draftConflict!==null', context), true);
});

test('a remotely closed shift blocks this device even without a server draft', async () => {
  const { context } = frontendContext('warehouse-staff.html', { WHApi: {
    saveDraft: async () => ({ ok: true, ignored: true, reason: 'shift is already closed' })
  } });
  Object.assign(context, { __noop() {} });
  vm.runInContext(`
    worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='closed-shift';
    visits=[{clientEventId:'local-event',visitor:'client',operation:'issue',date:'2026-07-15',time:'10:00',orders:[]}];
    renderTable=__noop;checkReady=__noop;
  `, context);
  const result=await context.saveDraft();
  assert.equal(result.ok, false);
  assert.equal(vm.runInContext('draftConflict.closed', context), true);
  assert.equal(context.shiftMutationBlocked(), true);
});

test('conflict merge transfers only visits not already acknowledged in another shift', async () => {
  let savedPayload=null;
  const active={worker:'Склад',clientShiftId:'active-shift',shiftStart:'2026-07-16T06:00:00Z',savedAt:'2026-07-16T07:00:00Z',visits:[]};
  const local={worker:'Склад',clientShiftId:'old-shift',shiftStart:'2026-07-15T06:00:00Z',savedAt:'2026-07-15T07:00:00Z',visits:[
    {clientEventId:'confirmed',visitId:'server-visit',visitor:'client',operation:'issue',date:'2026-07-15',time:'10:00',orders:[]},
    {visitor:'client',operation:'issue',date:'2026-07-15',time:'10:01',orders:[]}
  ]};
  const { context }=frontendContext('warehouse-staff.html',{WHApi:{
    getData:async()=>({draft:active}),
    saveDraft:async payload=>{savedPayload=payload;return {ok:true,ignored:false,draft:{...active,visits:payload.visits}};},
    addVisit:async()=>({visitId:'new-visit',shiftId:'new-shift'})
  }});
  Object.assign(context,{__noop(){}});
  vm.runInContext(`
    worker='Склад';draftConflict={serverDraft:${JSON.stringify(active)},localDraft:${JSON.stringify(local)},message:'conflict'};
    renderTable=__noop;updateOrdersBar=__noop;renderOrderCards=__noop;populateOrders=__noop;
    startAutosave=__noop;startOrdersRefresh=__noop;checkReady=__noop;
  `,context);
  await context.resolveDraftConflict();
  assert.equal(savedPayload.visits.length,1);
  assert.match(savedPayload.visits[0].clientEventId,/^visit-legacy-/);
  assert.deepEqual(Array.from(vm.runInContext('visits.map(v=>v.clientEventId)',context)),
    [savedPayload.visits[0].clientEventId]);
});

test('a draft conflict cannot delete the other device reservation or start another shift', async () => {
  let clearCalls=0, saveCalls=0;
  const { context, element }=frontendContext('warehouse-staff.html',{WHApi:{
    clearDraft:async()=>{clearCalls++;return {ok:true};},
    saveDraft:async()=>{saveCalls++;return {ok:true};}
  }});
  vm.runInContext(`worker='Склад';draftConflict={serverDraft:{},localDraft:{worker:'Склад',visits:[]},message:'conflict'};`,context);
  element('restoreBanner').dataset.draft=JSON.stringify({worker:'Склад',shiftStart:'2026-07-15T06:00:00Z',visits:[]});
  await context.discardDraft();
  await context.startShift();
  assert.equal(clearCalls,0);
  assert.equal(saveCalls,0);
});

test('a server draft on the shared worker screen can only be restored, not deleted', async () => {
  let clearCalls=0;
  const server={worker:'Склад',clientShiftId:'server-shift',shiftStart:'2026-07-15T06:00:00Z',savedAt:'2026-07-15T07:00:00Z',visits:[]};
  const { context, element }=frontendContext('warehouse-staff.html',{WHApi:{
    clearDraft:async()=>{clearCalls++;return {ok:true};}
  }});
  vm.runInContext(`worker='Склад';`,context);
  assert.equal(context.checkForDraft(server),true);
  assert.equal(element('restoreBanner').dataset.serverProtected,'1');
  await context.discardDraft();
  assert.equal(clearCalls,0);
});

test('selecting another worker does not inherit the previous worker conflict', async () => {
  const { context }=frontendContext('warehouse-staff.html',{WHApi:{
    getData:async()=>({orders:[],processedOrders:{},draft:null})
  }});
  Object.assign(context,{__noop(){}});
  vm.runInContext(`draftConflict={serverDraft:{},localDraft:{worker:'Первый',visits:[]},message:'conflict'};
    populateOrders=__noop;updateOrdersBar=__noop;`,context);
  await context.selWorker('Второй',{classList:{add(){}}});
  assert.equal(vm.runInContext('draftConflict',context),null);
});

test('malformed visit acknowledgements cannot turn a server success into a retry', () => {
  const { context, storage } = frontendContext('warehouse-staff.html');
  storage.set('wh_visit_acks', JSON.stringify({ bad: null, array: [], missing: { at: 1 } }));
  assert.deepEqual(Object.keys(context.readVisitAcks()), []);
  assert.doesNotThrow(() => context.recordVisitAck(
    { clientEventId: 'event-ok' }, { visitId: 'visit-ok', shiftId: 'shift-ok' }
  ));
  const ack=context.readVisitAcks()['event-ok'];
  assert.equal(ack.visitId, 'visit-ok');
  assert.equal(ack.shiftId, 'shift-ok');
  assert.equal(Number.isFinite(ack.at), true);
});

test('sequential backup fallback is fail-closed unless explicitly requested', () => {
  const script = read('scripts/backup-supabase.mjs');
  assert.match(script, /--allow-sequential/);
  assert.match(script, /Sequential REST backup is disabled by default/);
  assert.match(script, /if \(!atomicSnapshot && !allowSequential\)/);
});

test('queue survives malformed storage and preserves a permanent rejection on restore', () => {
  const { context, storage } = frontendContext('warehouse-staff.html');
  storage.set('wh_pending_visits', '{}');
  assert.deepEqual(Array.from(context.readPendingVisits()), []);
  storage.set('wh_pending_visits', JSON.stringify([{ clientEventId: 'blocked', worker: 'Склад', shiftStart: '2026-07-15T06:00:00Z', entry: {}, _blockedError: 'already issued' }]));
  context.queuePendingVisit({ clientEventId: 'blocked', worker: 'Склад', shiftStart: '2026-07-15T06:00:00Z', entry: {} }, false);
  assert.equal(context.readPendingVisits()[0]._blockedError, 'already issued');
});

test('a permanent queue error is restored into the visible visit state', () => {
  const { context, storage } = frontendContext('warehouse-staff.html');
  storage.set('wh_pending_visits', JSON.stringify([{ clientEventId: 'blocked', _blockedError: 'already issued' }]));
  vm.runInContext(`visits=[{clientEventId:'blocked',orders:[{id:'111',operation:'issue'}]}];`, context);
  context.applyStoredVisitAcks();
  assert.equal(vm.runInContext('visits[0].syncBlocked', context), true);
  assert.equal(vm.runInContext('visits[0].syncError', context), 'already issued');
  assert.equal(vm.runInContext('getSessionStatuses().issuedIds.has("111")', context), false);
});

test('a rejected return stays in the error section and blocks closing', () => {
  const { context, element }=frontendContext('warehouse-staff.html');
  vm.runInContext(`
    worker='Склад';serverIssuedToday=new Set(['111']);serverReturnedToday=new Set();
    visits=[{clientEventId:'blocked-return',visitor:'client',operation:'return',date:'2026-07-15',time:'10:00',timeAuto:'10:00',
      orders:[{id:'111',operation:'return'}],syncBlocked:true,syncError:'already returned'}];
  `,context);
  context.renderTable();
  assert.doesNotMatch(element('logBody').innerHTML,/lrow-done/);
  assert.equal(element('subBtn').disabled,true);
  assert.match(element('subHint').textContent,/ошибк/);
});

test('online recovery flushes the whole queue instead of treating the event as a filter', () => {
  assert.match(read('warehouse-staff.html'), /addEventListener\('online',\(\)=>\{flushPendingVisits\(\)/);
});

test('a blocked visit restored from the draft is not sent again', async () => {
  let calls = 0;
  const { context } = frontendContext('warehouse-staff.html', { WHApi: { addVisit: async () => { calls++; return {}; } } });
  vm.runInContext(`
    worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';
    visits=[{clientEventId:'blocked',visitor:'client',operation:'issue',date:'2026-07-15',time:'10:00',timeAuto:'10:00',orders:[{id:'111',operation:'issue'}],syncBlocked:true,syncError:'already issued'}];
  `, context);
  context.enqueueRestoredVisits();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(context.readPendingVisits()[0]._blockedError, 'already issued');
});

test('today counters exclude unlisted visits from another date', () => {
  const { context } = frontendContext('warehouse-staff.html');
  const today = context.todayMsk();
  vm.runInContext(`
    visits=[
      {clientEventId:'today-local',date:${JSON.stringify(today)},orders:[{id:'__other__'}]},
      {clientEventId:'old-local',date:'2000-01-01',orders:[{id:'__other__'}]}
    ];
    serverOtherVisits=[
      {clientEventId:'today-server',date:${JSON.stringify(today)}},
      {clientEventId:'old-server',date:'2000-01-01'}
    ];
  `, context);
  assert.deepEqual(new Set(Array.from(context.getOtherVisits(), v => v.clientEventId)), new Set(['today-local', 'today-server']));
});

test('closing freezes new visits and recovers cleanly from a refresh failure', async () => {
  const { context } = frontendContext('warehouse-staff.html', { WHApi: { getData: async () => { throw new Error('offline'); } } });
  vm.runInContext(`closingShift=true;visits=[];`, context);
  context.addVisit();
  assert.equal(vm.runInContext('visits.length', context), 0);

  vm.runInContext(`
    closingShift=false;worker='Склад';shiftStart=new Date('2026-07-15T06:00:00Z');clientShiftId='shift-1';visits=[];
  `, context);
  await context.confirmSubmit();
  assert.equal(vm.runInContext('closingShift', context), false);
});

test('stale draft clear loads the newer server draft and keeps start disabled', async () => {
  const fresh = { worker: 'Склад', clientShiftId: 'shift-new', shiftStart: '2026-07-16T06:00:00Z', savedAt: '2026-07-16T07:00:00Z', visits: [] };
  const { context, element } = frontendContext('warehouse-staff.html', { WHApi: {
    clearDraft: async () => ({ ok: true, stale: true }), getData: async () => ({ draft: fresh })
  } });
  const old = { worker: 'Склад', clientShiftId: 'shift-old', shiftStart: '2026-07-15T06:00:00Z', savedAt: '2026-07-15T07:00:00Z', visits: [] };
  vm.runInContext(`worker='Склад';`, context);
  element('restoreBanner').dataset.draft = JSON.stringify(old);
  await context.discardDraft();
  assert.equal(element('startBtn').disabled, true);
  assert.equal(JSON.parse(element('restoreBanner').dataset.draft).clientShiftId, 'shift-new');
  assert.equal(element('restoreBanner').dataset.serverProtected, '1');

  await context.discardDraft();
  assert.equal(element('restoreBanner').dataset.serverProtected, '1');
});

test('stale clear with no server draft treats the old local copy as already removed', async () => {
  const { context, element } = frontendContext('warehouse-staff.html', { WHApi: {
    clearDraft: async () => ({ ok: true, stale: true }), getData: async () => ({ draft: null })
  } });
  const old = { worker: 'Склад', clientShiftId: 'shift-old', shiftStart: '2026-07-15T06:00:00Z', savedAt: '2026-07-15T07:00:00Z', visits: [] };
  vm.runInContext(`worker='Склад';`, context);
  element('restoreBanner').dataset.draft = JSON.stringify(old);
  await context.discardDraft();
  assert.equal(element('startBtn').disabled, false);
  assert.equal(element('restoreBanner').dataset.serverProtected, '0');
});

test('reconciliation and worker history use one Apps Script snapshot request each', async () => {
  const urls = [];
  const context = {
    window: {}, SUPABASE_URL: 'https://example.test', SUPABASE_KEY: 'key', SYNC_URL: 'https://script.test',
    Set, Date, Promise, URLSearchParams, encodeURIComponent,
    fetch: async url => { urls.push(url); return { ok: true, json: async () => ({ ok: true, data: [] }) }; }
  };
  context.window.supabase = { createClient: () => ({ from: () => ({}) }) };
  vm.createContext(context); vm.runInContext(read('api.js'), context);
  await context.window.WHApi.getUnmatched();
  await context.window.WHApi.getWorkerHistory('Склад');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /action=getUnmatched/);
  assert.match(urls[1], /action=getWorkerHistory&worker=/);
});

test('dashboard explains duplicate lifecycle violations', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`unmatchedData={unmatchedVisits:[],unlistedOrders:[{id:'111',client:'Client',category:'duplicate_issue',issueCount:2,returnCount:0}]};unmatchedLoadError=null;`, context);
  context.renderLinkTab();
  assert.match(element('linkContent').innerHTML, /Повторная выдача/);
  assert.match(element('linkContent').innerHTML, /выдач 2/);
});

test('reconciliation can link a visit to a future compatible order', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`unmatchedData={
    unmatchedVisits:[{visitKey:'visit-future',shiftDate:'2026-07-14',time:'10:00',worker:'Склад',operation:'issue',orders:[]}],
    unlistedOrders:[],
    linkCandidates:[{id:'FUTURE',client:'Client',issueDate:'01.08.2026',returnDate:'03.08.2026',orderType:'issue'}]
  };`, context);
  context.openLinkModal('visit-future');
  assert.match(element('linkModalOrders').innerHTML, /FUTURE/);
  assert.match(element('linkModalOrders').innerHTML, /01\.08\.2026/);
});

test('mixed reconciliation visit uses only the lifecycle-compatible operation', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`unmatchedData={
    unmatchedVisits:[{visitKey:'mixed',shiftDate:'2026-07-14',time:'10:00',worker:'Склад',operation:'both',orders:[]}],
    unlistedOrders:[],
    linkCandidates:[{id:'ISSUE-NEXT',client:'Client',issueDate:'14.07.2026',returnDate:'16.07.2026',orderType:'issue'}]
  };`, context);
  context.openLinkModal('mixed');
  assert.match(element('linkModalOrders').innerHTML, /data-default-op="issue"/);
  assert.doesNotMatch(element('linkModalOrders').innerHTML, /link-op-btn/);
});

test('an ambiguous order stays read-only for every reconciliation visit', () => {
  const { context, element } = frontendContext('warehouse-dashboard.html', { Chart: class { destroy() {} } });
  vm.runInContext(`unmatchedData={
    unmatchedVisits:[
      {visitKey:'original',shiftDate:'2026-07-14',time:'10:00',worker:'Склад',operation:'both',orders:[]},
      {visitKey:'foreign',shiftDate:'2026-07-14',time:'10:01',worker:'Склад',operation:'issue',orders:[]}
    ],unlistedOrders:[],linkCandidates:[{
      id:'AMB',client:'Client',issueDate:'14.07.2026',returnDate:'16.07.2026',orderType:'issue',
      ambiguous:true,unresolvedVisitIds:['original']
    }]
  };`, context);
  context.openLinkModal('foreign');
  assert.doesNotMatch(element('linkModalOrders').innerHTML, /AMB/);
  context.openLinkModal('original');
  assert.doesNotMatch(element('linkModalOrders').innerHTML, /AMB/);
});
