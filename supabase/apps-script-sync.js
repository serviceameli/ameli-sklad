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
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'patch',
    contentType: 'application/json',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, Prefer: 'return=minimal' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('PATCH ' + path + ' → ' + code + ': ' + resp.getContentText().slice(0, 200));
}

function _sbDelete(cfg, path) {
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'delete',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('DELETE ' + path + ' → ' + code + ': ' + resp.getContentText().slice(0, 200));
}

function _sbRpc(cfg, name, body) {
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + name, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('RPC ' + name + ' → ' + code + ': ' + resp.getContentText().slice(0, 300));
  var text = resp.getContentText();
  return text ? JSON.parse(text) : { ok: true };
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
  var result = [], seen = {};
  rows.forEach(function(o) {
    var id = o.order_no, iss = o.issue_date || '', ret = o.return_date || '';
    if (!id || seen[id] || returnedSet[id] || o.source_active === false) return;
    seen[id] = true;
    var sameDay = !!iss && iss === ret;
    var type = null, overdue = false;
    if (!issuedSet[id] && iss && iss <= today) {
      type = 'issue'; overdue = iss < today;
    } else if (issuedSet[id] && !returnedSet[id] && ret && ret <= today) {
      type = 'return'; overdue = ret < today;
    }
    if (type) result.push(_ext(_baseOf(o), {
      type: type, sameDay: sameDay, overdue: overdue,
      overdueType: overdue ? type : null, lifecycle: type === 'issue' ? 'awaiting_issue' : 'with_client'
    }));
  });
  return result;
}

function _ext(obj, extra) {
  var r = {}; for (var k in obj) r[k] = obj[k]; for (var k in extra) r[k] = extra[k]; return r;
}

// ─── getData: для страницы кладовщика ────────────────────────

function _getData(cfg, worker) {
  var today = mskToday();
  var twoDaysAgo = _dateNDaysAgo(2);

  var workers   = _sbGet(cfg, 'workers?select=name&active=eq.true');
  var orders    = _sbGet(cfg, 'orders?select=order_no,client,company,issue_date,issue_time,return_date,return_time,delivery_worker,site_status,source_active&source_active=eq.true&limit=10000');
  var statuses  = _sbGet(cfg, 'order_status?select=order_no,issued,returned,issued_by,returned_by&limit=10000');
  var draftRows = worker ? _sbGet(cfg, 'drafts?select=data&worker=eq.' + encodeURIComponent(worker) + '&limit=1') : [];
  var otherRows = _sbGet(cfg, 'visits?select=id,visitor,operation,visit_time,visit_date,worker,comment&is_other=eq.true&visit_date=gte.' + twoDaysAgo + '&limit=1000');

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
        return { id: v.id, visitId: v.id, visitor: v.visitor, operation: v.operation, time: _fmtTime(v.visit_time),
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

  var shifts   = _sbGet(cfg, 'shifts?select=*&shift_date=gte.' + cutoff + '&order=shift_date.desc&limit=5000');
  var visits   = _sbGet(cfg, 'visits?select=*&visit_date=gte.' + cutoff + '&limit=10000');
  var vorders  = _sbGet(cfg, 'visit_orders?select=*&limit=10000');
  var orders   = _sbGet(cfg, 'orders?select=order_no,client,company,issue_date,issue_time,return_date,return_time,delivery_worker,site_status,source_active&source_active=eq.true&limit=10000');
  var statuses = _sbGet(cfg, 'order_status?select=order_no,issued,returned,issued_by,returned_by&limit=10000');

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
      id: s.id, shiftId: s.id, shiftDate: s.shift_date, shiftStart: s.start_at, shiftEnd: s.end_at,
      worker: s.worker, isNight: s.is_night ? 'Ночь' : 'День',
      totalEntries: svs.length,
      entries: svs.map(function(v) {
        return {
          id: v.id, visitId: v.id,
          visitor: v.visitor, operation: v.operation, timestamp: s.start_at,
          time: _fmtTime(v.visit_time), timeAuto: _fmtTime(v.visit_time),
          night: v.is_night ? 'Ночь' : 'День', comment: v.comment || '',
          date: v.visit_date || '', isOther: !!v.is_other,
          orders: (voByVisit[v.id] || []).filter(function(o) { return o.order_no; }).map(function(o) {
            return { id: o.order_no, operation: o.operation || v.operation, client: o.client_snapshot || '',
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
  if (!payload.clientEventId) throw new Error('clientEventId is required');
  payload.shiftDate = _isoDate(payload.shiftDate);
  payload.entry.date = _isoDate(payload.entry.date || payload.shiftDate);
  (payload.entry.orders || []).forEach(function(o) {
    if (o.returnDate) o.returnDate = _isoDate(o.returnDate);
    if (!o.operation) o.operation = o.type || payload.entry.operation;
  });
  return _sbRpc(cfg, 'record_warehouse_visit', { p_payload: payload });
}

// ─── deleteVisit ─────────────────────────────────────────────

function _deleteVisit(cfg, payload) {
  if (!payload.visitId) throw new Error('visitId is required');
  return _sbRpc(cfg, 'delete_warehouse_visit', { p_visit_id: payload.visitId });
}

// ─── linkVisit: привязать «нет в списке» к заказам ──────────

function _linkVisit(cfg, payload) {
  if (!payload.visitId || !payload.orderIds || !payload.orderIds.length) {
    throw new Error('visitId and orderIds are required');
  }
  var visits = _sbGet(cfg, 'visits?select=id,operation,is_other&id=eq.' + encodeURIComponent(payload.visitId) + '&limit=1');
  if (!visits.length) throw new Error('Визит не найден');
  var visit = visits[0];
  var ids = payload.orderIds.map(function(id) { return '"' + id.replace(/"/g, '\\"') + '"'; });
  var orders = _sbGet(cfg, 'orders?select=order_no,client,return_date,delivery_worker&order_no=in.(' + encodeURIComponent(ids.join(',')) + ')&limit=1000');
  var byId = {};
  orders.forEach(function(o) { byId[o.order_no] = o; });
  var rows = payload.orderIds.map(function(id) {
    var o = byId[id];
    if (!o) throw new Error('Заказ не найден: ' + id);
    var op = payload.operations && payload.operations[id] || visit.operation;
    if (op !== 'issue' && op !== 'return') throw new Error('Неясная операция для заказа ' + id);
    return { visit_id: visit.id, order_no: id, operation: op,
      client_snapshot: o.client || '', return_date_snapshot: o.return_date || null,
      delivery_snapshot: o.delivery_worker ? 'Наша доставка' : 'Самовывоз' };
  });
  _sbPost(cfg, 'visit_orders', rows, 'return=minimal');
  _sbPatch(cfg, 'visits?id=eq.' + encodeURIComponent(visit.id), { is_other: false });
  return { ok: true, linked: rows.length };
}

// ─── saveDraft / clearDraft ───────────────────────────────────

function _saveDraft(cfg, payload) {
  if (!payload.worker) return { ok: false, error: 'no worker' };
  var current = _sbGet(cfg, 'drafts?select=saved_at&worker=eq.' + encodeURIComponent(payload.worker) + '&limit=1');
  var incoming = payload.savedAt || new Date().toISOString();
  if (current.length && current[0].saved_at && current[0].saved_at > incoming) {
    return { ok: true, ignored: true, reason: 'newer draft exists' };
  }
  _sbUpsert(cfg, 'drafts', { worker: payload.worker, data: payload, saved_at: incoming }, 'worker');
  return { ok: true };
}

function _clearDraft(cfg, worker) {
  if (!worker) return { ok: false, error: 'no worker' };
  _sbDelete(cfg, 'drafts?worker=eq.' + encodeURIComponent(worker));
  return { ok: true };
}

// ─── closeShift ──────────────────────────────────────────────

function _closeShift(cfg, payload) {
  payload.shiftDate = _isoDate(payload.shiftDate);
  return _sbRpc(cfg, 'close_warehouse_shift', { p_payload: payload });
}

// ─── syncOrders: Sheets → Supabase ───────────────────────────

function syncOrders() {
  var cfg = _cfg();
  if (!cfg.url || !cfg.key) return { ok: false, error: 'Не заданы SUPABASE_URL / SUPABASE_SERVICE_KEY' };

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('заказы');
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, synced: 0 };

  var tz   = 'Europe/Moscow';
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var grouped = {};
  data.filter(function(r) { return r[0]; }).forEach(function(r, idx) {
    var orderNo = r[0].toString().trim().toUpperCase().replace(/[–—]/g, '-');
    var issueDate = r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'yyyy-MM-dd') : null;
    var returnDate = r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'yyyy-MM-dd') : null;
    var row = grouped[orderNo] || {
      order_no: orderNo, source_row_count: 0, source_active: true, source_rows: []
    };
    row.source_row_count++;
    row.source_rows.push(idx + 2);
    row.client = r[16] ? r[16].toString().trim() : row.client || '';
    row.company = r[18] ? r[18].toString().trim() : row.company || '';
    row.issue_date = !row.issue_date || (issueDate && issueDate < row.issue_date) ? issueDate : row.issue_date;
    row.issue_time = r[3] ? r[3].toString().trim() : row.issue_time || '';
    row.return_date = !row.return_date || (returnDate && returnDate > row.return_date) ? returnDate : row.return_date;
    row.return_time = r[5] ? r[5].toString().trim() : row.return_time || '';
    row.delivery_worker = r[19] ? r[19].toString().trim() : row.delivery_worker || '';
    row.site_status = r[6] ? r[6].toString().trim() : row.site_status || '';
    row.raw = { canonical: r, sourceRows: row.source_rows };
    row.synced_at = new Date().toISOString();
    grouped[orderNo] = row;
  });
  var rows = Object.keys(grouped).map(function(orderNo) {
    var r = grouped[orderNo];
    delete r.source_rows;
    return r;
  });
  /* Legacy mapping kept intentionally out of lifecycle logic:
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
  }); */
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
  var ids = rows.map(function(r) { return '"' + r.order_no.replace(/"/g, '\\"') + '"'; });
  if (ids.length) _sbPatch(cfg, 'orders?order_no=not.in.(' + encodeURIComponent(ids.join(',')) + ')', { source_active: false });
  return { ok: true, synced: synced, sourceRows: data.filter(function(r) { return r[0]; }).length,
           duplicateRowsMerged: data.filter(function(r) { return r[0]; }).length - rows.length };
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
    else                              throw new Error('Unknown action: ' + action);
  } catch(err) {
    result = { ok: false, error: err.toString() };
  }
  if (result && result.ok === undefined) result = { ok: true, data: result };
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var cfg = _cfg();
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + err }))
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
    else if (action === 'linkVisit')  result = _linkVisit(cfg, payload);
    else                              throw new Error('Unknown action: ' + action);
  } catch(err) {
    result = { ok: false, error: err.toString() };
  }
  if (result && result.ok === undefined) result = { ok: true, data: result };
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
