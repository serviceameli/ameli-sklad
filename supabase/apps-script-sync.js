// ═══════════════════════════════════════════════════════════════
//  AMELI RENTAL — СКЛАД: Apps Script прокси + синхронизация
//
//  GET  ?action=getData&worker=ИмяФамилия  → данные для кладовщика
//  GET  ?action=getAll&fromDate=yyyy-mm-dd → данные для дашборда
//  GET  ?action=syncOrders                 → синхронизация Sheets→Supabase
//  POST body=JSON, Content-Type:text/plain → записи (addVisit, saveDraft, …)
//
//  Script Properties (Project Settings → Script Properties):
//    SUPABASE_URL         = https://xkqaipggklmgussjphkp.supabase.co
//    SUPABASE_SERVICE_KEY = <service_role ключ>  (НЕ anon!)
//
//  После изменений: Deploy → New deployment → Web app
//  → обновить SYNC_URL в config.js
// ═══════════════════════════════════════════════════════════════

function _cfg() {
  var p = PropertiesService.getScriptProperties();
  return { url: p.getProperty('SUPABASE_URL'), key: p.getProperty('SUPABASE_SERVICE_KEY') };
}

// ─── Supabase REST хелперы ────────────────────────────────────

function _sbGet(cfg, path) {
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'get',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('GET ' + path + ' → ' + code + ': ' + resp.getContentText().slice(0, 200));
  var text = resp.getContentText();
  return text ? JSON.parse(text) : [];
}

function _sbPost(cfg, table, body, prefer) {
  var rows = Array.isArray(body) ? body : [body];
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + table, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: prefer || 'return=minimal'
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('POST ' + table + ' → ' + code + ': ' + resp.getContentText().slice(0, 200));
  var text = resp.getContentText();
  return (prefer && prefer.indexOf('representation') >= 0 && text) ? JSON.parse(text) : null;
}

function _sbUpsert(cfg, table, body, onConflict) {
  var rows = Array.isArray(body) ? body : [body];
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('UPSERT ' + table + ' → ' + code + ': ' + resp.getContentText().slice(0, 200));
}

function _sbPatch(cfg, path, body) {
  UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'patch',
    contentType: 'application/json',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, Prefer: 'return=minimal' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
}

function _sbDelete(cfg, path) {
  UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'delete',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true
  });
}

// ─── Дата-хелперы ────────────────────────────────────────────

function mskToday() {
  return Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd');
}

function _dateNDaysAgo(n) {
  return Utilities.formatDate(new Date(Date.now() - n * 86400000), 'Europe/Moscow', 'yyyy-MM-dd');
}

function _ddmmyyyy(iso) {
  if (!iso) return '';
  var p = iso.split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
}

function _isoDate(val) {
  if (!val) return mskToday();
  var s = val.toString().trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return mskToday();
}

function _fmtTime(v) {
  if (!v) return '';
  var s = v.toString().trim();
  if (s.startsWith('1899-12-')) {
    return Utilities.formatDate(new Date(s), 'Europe/Moscow', 'HH:mm');
  }
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : s;
}

function parseDate(val) {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  var s = val.toString().trim();
  var m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  var m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  var n = Number(s);
  if (!isNaN(n) && n > 40000) return new Date((n - 25569) * 86400000);
  return new Date();
}

// ─── Логика заказов ──────────────────────────────────────────

function _baseOf(o) {
  return {
    id: o.order_no, client: o.client || '', company: o.company || '',
    issueDate: _ddmmyyyy(o.issue_date), issueTime: o.issue_time || '',
    returnDate: _ddmmyyyy(o.return_date), returnTime: o.return_time || '',
    delivery: o.delivery_worker ? 'Наша доставка' : 'Самовывоз',
    worker: o.delivery_worker || ''
  };
}

function _buildOrders(rows, today, issuedSet, returnedSet) {
  var todayList = [], overdue = [], seen = {}, todayIds = {};
  rows.forEach(function(o) {
    var iss = o.issue_date || '', ret = o.return_date || '', b = _baseOf(o);
    if (iss === today && ret === today) todayList.push(_ext(b, { type: 'issue', sameDay: true }));
    else if (iss === today)            todayList.push(_ext(b, { type: 'issue', sameDay: false }));
    else if (ret === today)            todayList.push(_ext(b, { type: 'return', sameDay: false }));
  });
  todayList.forEach(function(o) { todayIds[o.id] = true; });
  rows.forEach(function(o) {
    var id = o.order_no, iss = o.issue_date || '', ret = o.return_date || '', b = _baseOf(o);
    if (iss && iss < today && !issuedSet[id] && !seen[id + '_i']) {
      overdue.push(_ext(b, { type: 'issue', sameDay: iss === ret, overdue: true }));
      seen[id + '_i'] = true;
    } else if (ret && ret < today && issuedSet[id] && !returnedSet[id] && !seen[id + '_r']) {
      overdue.push(_ext(b, { type: 'return', sameDay: false, overdue: true }));
      seen[id + '_r'] = true;
    }
  });
  return todayList.concat(overdue.filter(function(o) { return !todayIds[o.id]; }));
}

function _ext(obj, extra) {
  var r = {}; for (var k in obj) r[k] = obj[k]; for (var k in extra) r[k] = extra[k]; return r;
}

// ─── getData: для страницы кладовщика ────────────────────────

function _getData(cfg, worker) {
  var today = mskToday();
  var cutoff = _dateNDaysAgo(60);
  var twoDaysAgo = _dateNDaysAgo(2);

  var workers  = _sbGet(cfg, 'workers?select=name&active=eq.true');
  var orders   = _sbGet(cfg, 'orders?select=order_no,client,company,issue_date,issue_time,return_date,return_time,delivery_worker,site_status&or=(issue_date.gte.' + cutoff + ',return_date.gte.' + cutoff + ')');
  var statuses = _sbGet(cfg, 'order_status?select=order_no,issued,returned,issued_by,returned_by');
  var draftRows = worker ? _sbGet(cfg, 'drafts?select=data&worker=eq.' + encodeURIComponent(worker) + '&limit=1') : [];
  var otherRows = _sbGet(cfg, 'visits?select=visitor,operation,visit_time,visit_date,worker,comment&is_other=eq.true&visit_date=gte.' + twoDaysAgo);

  var issuedSet = {}, returnedSet = {}, issuedBy = {}, returnedBy = {};
  statuses.forEach(function(r) {
    if (r.issued)   { issuedSet[r.order_no] = true;   if (r.issued_by)   issuedBy[r.order_no]   = r.issued_by;   }
    if (r.returned) { returnedSet[r.order_no] = true; if (r.returned_by) returnedBy[r.order_no] = r.returned_by; }
  });

  return {
    workers: workers.map(function(w) { return { name: w.name }; }),
    orders: _buildOrders(orders, today, issuedSet, returnedSet),
    processedOrders: {
      issued: Object.keys(issuedSet), returned: Object.keys(returnedSet),
      issuedBy: issuedBy, returnedBy: returnedBy,
      otherVisits: otherRows.map(function(v) {
        return { visitor: v.visitor, operation: v.operation, time: _fmtTime(v.visit_time),
                 date: v.visit_date, worker: v.worker, comment: v.comment || '' };
      })
    },
    draft: draftRows.length > 0 ? draftRows[0].data : null
  };
}

// ─── getAll: для дашборда ────────────────────────────────────

function _getAll(cfg, fromDate) {
  var today  = mskToday();
  var cutoff = fromDate || _dateNDaysAgo(90);

  var shifts   = _sbGet(cfg, 'shifts?select=*&shift_date=gte.' + cutoff + '&order=shift_date.desc');
  var visits   = _sbGet(cfg, 'visits?select=*&visit_date=gte.' + cutoff);
  var vorders  = _sbGet(cfg, 'visit_orders?select=*');
  var orders   = _sbGet(cfg, 'orders?select=order_no,client,company,issue_date,issue_time,return_date,return_time,delivery_worker,site_status');
  var statuses = _sbGet(cfg, 'order_status?select=order_no,issued,returned,issued_by,returned_by');

  var voByVisit = {}, visByShift = {};
  vorders.forEach(function(o) {
    if (!voByVisit[o.visit_id]) voByVisit[o.visit_id] = [];
    voByVisit[o.visit_id].push(o);
  });
  visits.forEach(function(v) {
    if (!visByShift[v.shift_id]) visByShift[v.shift_id] = [];
    visByShift[v.shift_id].push(v);
  });

  var builtShifts = shifts.map(function(s) {
    var svs = visByShift[s.id] || [];
    return {
      shiftDate: s.shift_date, shiftStart: s.start_at, shiftEnd: s.end_at,
      worker: s.worker, isNight: s.is_night ? 'Ночь' : 'День',
      totalEntries: svs.length,
      entries: svs.map(function(v) {
        return {
          visitor: v.visitor, operation: v.operation, timestamp: s.start_at,
          time: _fmtTime(v.visit_time), timeAuto: _fmtTime(v.visit_time),
          night: v.is_night ? 'Ночь' : 'День', comment: v.comment || '',
          date: v.visit_date || '', isOther: !!v.is_other,
          orders: (voByVisit[v.id] || []).filter(function(o) { return o.order_no; }).map(function(o) {
            return { id: o.order_no, client: o.client_snapshot || '',
                     returnDate: o.return_date_snapshot || '', delivery: o.delivery_snapshot || '' };
          })
        };
      })
    };
  });

  var issuedSet = {}, returnedSet = {}, issuedBy = {}, returnedBy = {};
  statuses.forEach(function(r) {
    if (r.issued)   { issuedSet[r.order_no] = true;   if (r.issued_by)   issuedBy[r.order_no]   = r.issued_by;   }
    if (r.returned) { returnedSet[r.order_no] = true; if (r.returned_by) returnedBy[r.order_no] = r.returned_by; }
  });

  return {
    shifts: builtShifts,
    orders: _buildOrders(orders, today, issuedSet, returnedSet),
    processedOrders: {
      issued: Object.keys(issuedSet), returned: Object.keys(returnedSet),
      issuedBy: issuedBy, returnedBy: returnedBy, otherVisits: []
    }
  };
}

// ─── addVisit: записать визит + обновить order_status ────────

function _addVisit(cfg, payload) {
  var entry      = payload.entry;
  var worker     = payload.worker;
  var shiftStart = payload.shiftStart;
  var isNight    = payload.isNight;
  var shiftDateISO = _isoDate(payload.shiftDate);

  // 1. Найти или создать смену
  var existing = _sbGet(cfg, 'shifts?select=id&worker=eq.' + encodeURIComponent(worker) +
    '&start_at=eq.' + encodeURIComponent(shiftStart) + '&limit=1');
  var shiftId;
  if (existing.length > 0) {
    shiftId = existing[0].id;
  } else {
    var newShift = _sbPost(cfg, 'shifts', {
      worker: worker, shift_date: shiftDateISO, start_at: shiftStart, is_night: isNight === 'Ночь'
    }, 'return=representation');
    if (!newShift || !newShift[0]) throw new Error('Не удалось создать смену');
    shiftId = newShift[0].id;
  }

  // 2. Вставить визит
  var hasOther  = (entry.orders || []).some(function(o) { return o.id === '__other__'; });
  var visitDate = entry.date ? _isoDate(entry.date) : shiftDateISO;
  var newVisit  = _sbPost(cfg, 'visits', {
    shift_id: shiftId, worker: worker,
    visitor: entry.visitor, operation: entry.operation,
    visit_date: visitDate, visit_time: entry.time || entry.timeAuto || '',
    is_night: entry.night === 'Ночь', is_other: hasOther,
    comment: entry.comment || '', entered_at: new Date().toISOString()
  }, 'return=representation');
  if (!newVisit || !newVisit[0]) throw new Error('Не удалось создать визит');
  var visitId = newVisit[0].id;

  // 3. Вставить заказы визита
  var vorders = [];
  (entry.orders || []).forEach(function(o) {
    if (o.id === '__other__') {
      vorders.push({ visit_id: visitId, order_no: null,
        client_snapshot: entry.orderClient || '', return_date_snapshot: null,
        delivery_snapshot: entry.orderDelivery || '' });
    } else {
      vorders.push({ visit_id: visitId, order_no: o.id,
        client_snapshot: o.client || '',
        return_date_snapshot: o.returnDate ? _isoDate(o.returnDate) : null,
        delivery_snapshot: o.delivery || '' });
    }
  });
  if (vorders.length > 0) _sbPost(cfg, 'visit_orders', vorders, 'return=minimal');

  // 4. Обновить order_status (КРИТИЧНЫЙ ФИX: статусы обновляются сразу)
  var op = entry.operation;
  (entry.orders || []).forEach(function(o) {
    if (!o.id || o.id === '__other__') return;
    var orderOp = (op === 'both') ? (o.type || 'issue') : op;
    var upd;
    if (orderOp === 'issue')  upd = { order_no: o.id, issued: true,  issued_by: worker };
    if (orderOp === 'return') upd = { order_no: o.id, returned: true, returned_by: worker };
    if (upd) _sbUpsert(cfg, 'order_status', upd, 'order_no');
  });

  return { ok: true, shiftId: shiftId, visitId: visitId };
}

// ─── deleteVisit ─────────────────────────────────────────────

function _deleteVisit(cfg, payload) {
  var shifts = _sbGet(cfg, 'shifts?select=id&worker=eq.' + encodeURIComponent(payload.worker) +
    '&start_at=eq.' + encodeURIComponent(payload.shiftStart) + '&limit=1');
  if (!shifts.length) return { ok: false, error: 'shift not found' };
  _sbDelete(cfg, 'visits?shift_id=eq.' + shifts[0].id + '&visit_time=eq.' + encodeURIComponent(payload.timeAuto));
  return { ok: true };
}

// ─── saveDraft / clearDraft ───────────────────────────────────

function _saveDraft(cfg, payload) {
  if (!payload.worker) return { ok: false, error: 'no worker' };
  _sbUpsert(cfg, 'drafts', { worker: payload.worker, data: payload, saved_at: new Date().toISOString() }, 'worker');
  return { ok: true };
}

function _clearDraft(cfg, worker) {
  if (!worker) return { ok: false, error: 'no worker' };
  _sbDelete(cfg, 'drafts?worker=eq.' + encodeURIComponent(worker));
  return { ok: true };
}

// ─── closeShift ──────────────────────────────────────────────

function _closeShift(cfg, payload) {
  _sbPatch(cfg, 'shifts?worker=eq.' + encodeURIComponent(payload.worker) +
    '&start_at=eq.' + encodeURIComponent(payload.shiftStart), { end_at: payload.shiftEnd });
  _sbDelete(cfg, 'drafts?worker=eq.' + encodeURIComponent(payload.worker));
  return { ok: true };
}

// ─── syncOrders: Sheets → Supabase ───────────────────────────

function syncOrders() {
  var cfg = _cfg();
  if (!cfg.url || !cfg.key) return { ok: false, error: 'Не заданы SUPABASE_URL / SUPABASE_SERVICE_KEY' };

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('заказы');
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, synced: 0 };

  var tz   = 'Europe/Moscow';
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 20).getValues();
  var rows = data.filter(function(r) { return r[0]; }).map(function(r) {
    return {
      order_no:        r[0].toString().trim(),
      client:          r[16] ? r[16].toString().trim() : '',
      company:         r[18] ? r[18].toString().trim() : '',
      issue_date:      r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'yyyy-MM-dd') : null,
      issue_time:      r[3] ? r[3].toString().trim() : '',
      return_date:     r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'yyyy-MM-dd') : null,
      return_time:     r[5] ? r[5].toString().trim() : '',
      delivery_worker: r[19] ? r[19].toString().trim() : '',
      site_status:     r[6] ? r[6].toString().trim() : '',
      synced_at:       new Date().toISOString()
    };
  });
  if (!rows.length) return { ok: true, synced: 0 };

  var synced = 0, lastCode = 0, lastBody = '';
  for (var i = 0; i < rows.length; i += 500) {
    var batch = rows.slice(i, i + 500);
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/orders?on_conflict=order_no', {
      method: 'post', contentType: 'application/json',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
                 Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(batch), muteHttpExceptions: true
    });
    lastCode = resp.getResponseCode();
    lastBody = resp.getContentText();
    if (lastCode >= 200 && lastCode < 300) synced += batch.length; else break;
  }
  if (lastCode < 200 || lastCode >= 300) return { ok: false, synced: synced, code: lastCode, error: lastBody };
  return { ok: true, synced: synced };
}

function setupSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'syncOrders'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncOrders').timeBased().atHour(8).everyDays(1).inTimezone('Europe/Moscow').create();
  ScriptApp.newTrigger('syncOrders').timeBased().atHour(14).everyDays(1).inTimezone('Europe/Moscow').create();
}

// ─── Веб-обработчики ─────────────────────────────────────────

function doGet(e) {
  var cfg    = _cfg();
  var action = (e && e.parameter && e.parameter.action) || '';
  var result;
  try {
    if      (action === 'getData')    result = _getData(cfg, e.parameter.worker || null);
    else if (action === 'getAll')     result = _getAll(cfg, e.parameter.fromDate || null);
    else if (action === 'syncOrders') result = syncOrders();
    else                              result = { error: 'Unknown action: ' + action };
  } catch(err) {
    result = { error: err.toString() };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var cfg = _cfg();
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid JSON: ' + err }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var action = payload.action || '';
  var result;
  try {
    if      (action === 'addVisit')   result = _addVisit(cfg, payload);
    else if (action === 'saveDraft')  result = _saveDraft(cfg, payload);
    else if (action === 'clearDraft') result = _clearDraft(cfg, payload.worker);
    else if (action === 'closeShift') result = _closeShift(cfg, payload);
    else if (action === 'deleteVisit')result = _deleteVisit(cfg, payload);
    else                              result = { error: 'Unknown action: ' + action };
  } catch(err) {
    result = { error: err.toString() };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
