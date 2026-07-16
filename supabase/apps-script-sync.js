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

// Записи от вкладок, открытых до полного сброса, не должны восстанавливать
// старые смены, черновики и офлайн-визиты.
var WAREHOUSE_DATA_EPOCH = '2026-07-14-full-reset-v1';

function _requireDataEpoch(payload) {
  if (!payload || payload.dataEpoch !== WAREHOUSE_DATA_EPOCH) {
    var err = new Error('Страница склада устарела. Закройте её и откройте ссылку заново.');
    err.retryable = false;
    throw err;
  }
}

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

function _sbGetAll(cfg, path) {
  var table = path.split('?')[0];
  var stableKey = {
    visits: 'id', visit_orders: 'id', shifts: 'id', orders: 'order_no',
    order_status: 'order_no', workers: 'name', drafts: 'worker'
  }[table];
  if (stableKey) {
    var orderMatch = path.match(/([?&]order=)([^&]*)/);
    if (orderMatch) {
      if (orderMatch[2].split(',').every(function(part) { return part.split('.')[0] !== stableKey; })) {
        path = path.replace(orderMatch[0], orderMatch[1] + orderMatch[2] + ',' + stableKey + '.asc');
      }
    } else {
      path += (path.indexOf('?') >= 0 ? '&' : '?') + 'order=' + stableKey + '.asc';
    }
  }
  var result = [], offset = 0, pageSize = 1000;
  while (true) {
    var page = _sbGet(cfg, path + (path.indexOf('?') >= 0 ? '&' : '?') +
      'limit=' + pageSize + '&offset=' + offset);
    result = result.concat(page);
    if (page.length < pageSize) return result;
    offset += pageSize;
  }
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

function _rpcRetryable(httpCode, responseBody) {
  var pgCode = '';
  try { pgCode = JSON.parse(responseBody || '{}').code || ''; } catch (e) {}
  // Constraint/data errors never heal after a retry. Serialization, lock,
  // resource and connection failures can be retried with the same event id.
  if (/^23/.test(pgCode)) return false;
  if (/^(40001|40P01|55P03|57014|08|53|57P0[123])/.test(pgCode)) return true;
  return httpCode === 408 || httpCode === 425 || httpCode === 429 || httpCode >= 500;
}

function _sbRpc(cfg, name, body) {
  var resp;
  try {
    resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + name, {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (fetchError) {
    var transportError = new Error('RPC ' + name + ': ошибка соединения: ' + fetchError);
    transportError.retryable = true;
    throw transportError;
  }
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    var responseBody = resp.getContentText();
    var err = new Error('RPC ' + name + ' → ' + code + ': ' + responseBody.slice(0, 300));
    err.retryable = _rpcRetryable(code, responseBody);
    throw err;
  }
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

function _dateBefore(iso, days) {
  var p = iso.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() - days);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function _ddmmyyyy(iso) {
  if (!iso) return '';
  var p = iso.split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
}

function _validYmd(y, m, d) {
  var date = new Date(Date.UTC(+y, +m - 1, +d));
  return date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d;
}

function _isoDate(val, label) {
  if (!val) return mskToday();
  var s = val.toString().trim();
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (iso && _validYmd(iso[1], iso[2], iso[3])) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m && _validYmd(m[3], m[2], m[1])) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  throw new Error('Неверная дата' + (label ? ' «' + label + '»' : '') + ': ' + val);
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
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  var s = val.toString().trim();
  var m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  var m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  var n = Number(s);
  if (!isNaN(n) && n > 40000) return new Date((n - 25569) * 86400000);
  return null;
}

function _sheetDate(val, tz, rowNo, label) {
  if (val == null || String(val).trim() === '') return null;
  var raw = val.toString().trim();
  var dm = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  var im = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if ((dm && !_validYmd(dm[3], dm[2], dm[1])) || (im && !_validYmd(im[1], im[2], im[3]))) {
    throw new Error('Неверная дата «' + label + '» в строке ' + rowNo + ': ' + val);
  }
  var d = parseDate(val);
  if (!d || isNaN(d.getTime())) {
    throw new Error('Неверная дата «' + label + '» в строке ' + rowNo + ': ' + val);
  }
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function _sheetTime(val, tz) {
  if (!val) return '';
  if (val instanceof Date && !isNaN(val.getTime())) return Utilities.formatDate(val, tz, 'HH:mm');
  var s = val.toString().trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m && +m[1] <= 23 && +m[2] <= 59) return ('0' + m[1]).slice(-2) + ':' + m[2];
  throw new Error('Неверное время в таблице: ' + val);
}

function _normOperation(value) {
  if (value === 'issue' || value === 'pickup') return 'issue';
  if (value === 'return' || value === 'dropoff') return 'return';
  return null;
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
    var openRental = !!issuedSet[id] && !returnedSet[id];
    if (!id || seen[id] || returnedSet[id] || o.manual_hidden === true || o.lifecycle_ambiguous === true) return;
    // Исчезновение строки из следующего экспорта не закрывает уже выданную
    // аренду: она остаётся у клиента до явного возврата.
    if (o.source_active === false && !openRental) return;
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

function _buildVisibleOrders(rows, today, issuedSet, returnedSet, issuedTodaySet, returnedTodaySet) {
  var result = _buildOrders(rows, today, issuedSet, returnedSet);
  var byId = {};
  result.forEach(function(o) { byId[o.id] = o; });
  rows.forEach(function(o) {
    var id = o.order_no;
    var issuedToday = !!issuedTodaySet[id];
    var returnedToday = !!returnedTodaySet[id] && !!issuedSet[id];
    var openRental = !!issuedSet[id] && !returnedSet[id];
    if (!id || o.manual_hidden === true || o.lifecycle_ambiguous === true) return;
    if (o.source_active === false && !openRental && !issuedToday && !returnedToday) return;
    if (!issuedToday && !returnedToday) return;
    var item = byId[id];
    if (!item) {
      item = _ext(_baseOf(o), {
        type: returnedToday ? 'return' : 'issue',
        sameDay: !!o.issue_date && o.issue_date === o.return_date,
        overdue: false, overdueType: null,
        lifecycle: returnedToday ? 'returned' : 'issued'
      });
      result.push(item); byId[id] = item;
    }
    item.processedTodayIssue = issuedToday;
    item.processedTodayReturn = returnedToday;
  });
  return result;
}

function _processedOnDate(visits, links, date) {
  var visitById = {}, issued = {}, returned = {};
  visits.forEach(function(v) { if (v.visit_date === date) visitById[v.id] = v; });
  links.forEach(function(vo) {
    if (!vo.order_no || !visitById[vo.visit_id]) return;
    var op = _normOperation(vo.operation) || _normOperation(visitById[vo.visit_id].operation);
    if (op === 'issue') issued[vo.order_no] = true;
    if (op === 'return') returned[vo.order_no] = true;
  });
  return { issued: issued, returned: returned };
}

function _processedEvents(events) {
  var issued = {}, returned = {};
  events.forEach(function(e) {
    if (e.operation === 'issue') issued[e.order_no] = true;
    if (e.operation === 'return') returned[e.order_no] = true;
  });
  return { issued: issued, returned: returned };
}

function _returnsWithIssue(returned, issued) {
  var valid = {};
  Object.keys(returned || {}).forEach(function(id) {
    if (issued && issued[id]) valid[id] = true;
  });
  return valid;
}

function _ext(obj, extra) {
  var r = {}; for (var k in obj) r[k] = obj[k]; for (var k in extra) r[k] = extra[k]; return r;
}

// ─── getData: для страницы кладовщика ────────────────────────

function _getData(cfg, worker) {
  var today = mskToday();
  var snapshot = _sbRpc(cfg, 'warehouse_staff_snapshot', {
    p_worker: worker || null,
    p_today: today,
    p_other_since: today
  });
  var workers = snapshot.workers || [];
  var orders = snapshot.orders || [];
  var statuses = snapshot.statuses || [];
  var otherRows = snapshot.otherRows || [];
  var otherLinks = snapshot.otherLinks || [];
  var todayEvents = snapshot.todayEvents || [];

  var issuedSet = {}, returnedSet = {}, issuedBy = {}, returnedBy = {};
  statuses.forEach(function(r) {
    if (r.issued)   { issuedSet[r.order_no] = true;   if (r.issued_by)   issuedBy[r.order_no]   = r.issued_by;   }
    if (r.returned) { returnedSet[r.order_no] = true; if (r.returned_by) returnedBy[r.order_no] = r.returned_by; }
  });

  var todayProcessed = _processedEvents(todayEvents);
  var validTodayReturns = _returnsWithIssue(todayProcessed.returned, issuedSet);
  return {
    workers: workers.map(function(w) { return { name: w.name }; }),
    orders: _buildVisibleOrders(orders, today, issuedSet, returnedSet, todayProcessed.issued, validTodayReturns),
    processedOrders: {
      issued: Object.keys(issuedSet), returned: Object.keys(returnedSet),
      issuedToday: Object.keys(todayProcessed.issued), returnedToday: Object.keys(validTodayReturns),
      issuedBy: issuedBy, returnedBy: returnedBy,
      otherVisits: otherRows.filter(function(v) {
        return otherLinks.some(function(link) { return link.visit_id === v.id; });
      }).map(function(v) {
        var link = otherLinks.find(function(item) { return item.visit_id === v.id; });
        return { id: v.id, visitId: v.id, visitor: v.visitor, operation: link && link.operation || v.operation, time: _fmtTime(v.visit_time),
                 date: v.visit_date, worker: v.worker, comment: v.comment || '' };
      })
    },
    draft: snapshot.draft || null
  };
}

function _getUnmatched(cfg) {
  var snapshot = _sbRpc(cfg, 'warehouse_reconciliation_snapshot', { p_today: mskToday() });
  return {
    unmatchedVisits: (snapshot.unmatchedVisits || []).map(function(v) {
      return {
        visitKey: v.visitKey, shiftDate: v.shiftDate || '',
        time: _fmtTime(v.time), worker: v.worker || '',
        isNight: v.isNight || 'День', visitor: v.visitor || '',
        operation: v.operation || '', comment: v.comment || '',
        orders: v.orders || []
      };
    }),
    unlistedOrders: (snapshot.lifecycleViolations || []).map(function(o) {
      return {
        id: o.id, client: o.client || '',
        issueDate: _ddmmyyyy(o.issueDate), returnDate: _ddmmyyyy(o.returnDate),
        category: o.category, orderType: o.orderType || null,
        issueCount: Number(o.issueCount || 0), returnCount: Number(o.returnCount || 0),
        ambiguous: o.ambiguous === true
      };
    }),
    linkCandidates: (snapshot.linkCandidates || []).map(function(o) {
      return {
        id: o.id, client: o.client || '',
        issueDate: _ddmmyyyy(o.issueDate), returnDate: _ddmmyyyy(o.returnDate),
        orderType: o.orderType || null, ambiguous: o.ambiguous === true,
        unresolvedVisitIds: Array.isArray(o.unresolvedVisitIds) ? o.unresolvedVisitIds : []
      };
    })
  };
}

function _getWorkerHistory(cfg, worker) {
  if (!worker) throw new Error('worker is required');
  var snapshot = _sbRpc(cfg, 'warehouse_worker_history_snapshot', { p_worker: worker });
  var shifts = snapshot.shifts || [], visits = snapshot.visits || [], vorders = snapshot.visitOrders || [];
  var voByVisit = {}, visByShift = {};
  vorders.forEach(function(o) {
    if (!voByVisit[o.visit_id]) voByVisit[o.visit_id] = [];
    voByVisit[o.visit_id].push(o);
  });
  visits.forEach(function(v) {
    if (!visByShift[v.shift_id]) visByShift[v.shift_id] = [];
    visByShift[v.shift_id].push(v);
  });
  return shifts.map(function(s) { return {
    id: s.id, shiftDate: s.shift_date, shiftStart: s.start_at, shiftEnd: s.end_at,
    isNight: s.is_night ? 'Ночь' : 'День',
    entries: (visByShift[s.id] || []).map(function(v) { return {
      visitor: v.visitor, operation: v.operation,
      time: _fmtTime(v.visit_time), date: v.visit_date,
      comment: v.comment || '', isOther: !!v.is_other,
      orders: (voByVisit[v.id] || []).filter(function(o) { return o.order_no; }).map(function(o) {
        return { id: o.order_no, operation: o.operation || _normOperation(v.operation), client: o.client_snapshot || '',
          returnDate: o.return_date_snapshot || '', delivery: o.delivery_snapshot || '' };
      })
    }; })
  }; });
}

// ─── getAll: для дашборда ────────────────────────────────────

function _getAll(cfg, fromDate) {
  var today  = mskToday();
  var cutoff = fromDate || _dateNDaysAgo(90);
  var snapshot = _sbRpc(cfg, 'warehouse_dashboard_snapshot', { p_from_date: cutoff });
  // Ночная смена, начавшаяся накануне периода, уже включена RPC-функцией.
  var shifts = snapshot.shifts || [];
  var visits = snapshot.visits || [];
  var vorders = snapshot.visitOrders || [];
  var orders = snapshot.orders || [];
  var statuses = snapshot.statuses || [];

  var voByVisit = {}, visByShift = {};
  vorders.forEach(function(o) {
    if (!voByVisit[o.visit_id]) voByVisit[o.visit_id] = [];
    voByVisit[o.visit_id].push(o);
  });
  var visitById = {};
  visits.forEach(function(v) {
    visitById[v.id] = v;
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
        var visitLinks = voByVisit[v.id] || [];
        var otherLink = visitLinks.find(function(o) { return !o.order_no; });
        return {
          id: v.id, visitId: v.id, shiftId: s.id,
          visitor: v.visitor, operation: v.operation, timestamp: s.start_at,
          time: _fmtTime(v.visit_time), timeAuto: _fmtTime(v.visit_time),
          night: v.is_night ? 'Ночь' : 'День', comment: v.comment || '',
          date: v.visit_date || '', isOther: !!v.is_other,
          otherOperation: otherLink && otherLink.operation || null,
          orders: visitLinks.filter(function(o) { return o.order_no; }).map(function(o) {
            return { id: o.order_no,
                     operation: o.operation || _normOperation(v.operation),
                     needsReview: !o.operation && !_normOperation(v.operation), client: o.client_snapshot || '',
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

  var todayProcessed = _processedOnDate(visits, vorders, today);
  var issuedTodaySet = todayProcessed.issued;
  var returnedTodaySet = _returnsWithIssue(todayProcessed.returned, issuedSet);
  var dashboardOrders = _buildVisibleOrders(orders, today, issuedSet, returnedSet, issuedTodaySet, returnedTodaySet);

  return {
    shifts: builtShifts,
    orders: dashboardOrders,
    archivedOrders: orders.filter(function(o) { return o.manual_hidden === true; }).map(_baseOf),
    processedOrders: {
      issued: Object.keys(issuedSet), returned: Object.keys(returnedSet),
      issuedBy: issuedBy, returnedBy: returnedBy,
      issuedToday: Object.keys(issuedTodaySet), returnedToday: Object.keys(returnedTodaySet),
      otherVisits: []
    }
  };
}

// ─── addVisit: записать визит + обновить order_status ────────

function _addVisit(cfg, payload) {
  if (!payload.clientEventId) throw new Error('clientEventId is required');
  if (!payload.entry || typeof payload.entry !== 'object') throw new Error('entry is required');
  payload.shiftDate = _isoDate(payload.shiftDate, 'дата смены');
  payload.entry.date = _isoDate(payload.entry.date || payload.shiftDate, 'дата визита');
  (payload.entry.orders || []).forEach(function(o) {
    if (o.returnDate) o.returnDate = _isoDate(o.returnDate, 'дата возврата');
    if (!o.operation) o.operation = o.type || payload.entry.operation;
  });
  return _sbRpc(cfg, 'record_warehouse_visit', { p_payload: payload });
}

// ─── deleteVisit ─────────────────────────────────────────────

function _deleteVisit(cfg, payload) {
  if (!payload.visitId && !payload.clientEventId) throw new Error('visitId or clientEventId is required');
  return _sbRpc(cfg, 'delete_warehouse_visit', {
    p_visit_id: payload.visitId || null,
    p_client_event_id: payload.clientEventId || null
  });
}

// ─── linkVisit: привязать «нет в списке» к заказам ──────────

function _linkVisit(cfg, payload) {
  if (!payload.visitId || !payload.orderIds || !payload.orderIds.length) {
    throw new Error('visitId and orderIds are required');
  }
  var links = payload.orderIds.map(function(id) {
    var op = payload.operations && payload.operations[id];
    if (op !== 'issue' && op !== 'return') {
      throw new Error('Неясная операция для заказа ' + id);
    }
    return { orderId: id, operation: op };
  });
  return _sbRpc(cfg, 'link_warehouse_visit', {
    p_visit_id: payload.visitId,
    p_links: links
  });
}

// ─── saveDraft / clearDraft ───────────────────────────────────

function _saveDraft(cfg, payload) {
  if (!payload.worker || !payload.shiftStart) throw new Error('worker and shiftStart are required');
  return _sbRpc(cfg, 'save_warehouse_draft', { p_payload: payload });
}

function _clearDraft(cfg, payload) {
  if (!payload.worker || (!payload.clientShiftId && !payload.shiftStart)) {
    throw new Error('worker and clientShiftId or shiftStart are required');
  }
  return _sbRpc(cfg, 'clear_warehouse_draft', {
    p_worker: payload.worker,
    p_client_shift_id: payload.clientShiftId || null,
    p_shift_start: payload.shiftStart || null
  });
}

// ─── closeShift ──────────────────────────────────────────────

function _closeShift(cfg, payload) {
  payload.shiftDate = _isoDate(payload.shiftDate, 'дата смены');
  return _sbRpc(cfg, 'close_warehouse_shift', { p_payload: payload });
}

// ─── syncOrders: Sheets → Supabase ───────────────────────────

function _normalizeOrderHeader(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/[.:;]+$/g, '');
}

function _orderHeaderSpecs() {
  return [
    { key: 'orderNo', label: 'Номер заказа', required: true,
      aliases: ['номер заказа', '№ заказа', 'заказ №', 'номер заказа №',
        'номер/№ заказа', 'id заказа', 'order id', 'order no'] },
    { key: 'issueDate', label: 'Получение, дата', required: true,
      aliases: ['получение,дата', 'получение дата', 'дата получения',
        'выдача,дата', 'выдача дата', 'дата выдачи'] },
    { key: 'issueTime', label: 'Получение, время', required: false,
      aliases: ['получение,время', 'время получения', 'выдача,время', 'время выдачи'] },
    { key: 'returnDate', label: 'Возврат, дата', required: true,
      aliases: ['возврат,дата', 'возврат дата', 'дата возврата'] },
    { key: 'returnTime', label: 'Возврат, время', required: false,
      aliases: ['возврат,время', 'время возврата'] },
    { key: 'siteStatus', label: 'Статус', required: false,
      aliases: ['статус', 'статус заказа'] },
    { key: 'client', label: 'Клиент', required: true,
      aliases: ['клиент', 'имя клиента', 'фио клиента', 'заказчик'] },
    { key: 'company', label: 'Компания', required: false,
      aliases: ['компания', 'организация', 'компания клиента'] },
    { key: 'deliveryWorker', label: 'Работник', required: true,
      aliases: ['работник', 'работник доставки', 'курьер доставки',
        'исполнитель доставки'] }
  ];
}

function _resolveOrderSheetLayout(headerRows) {
  var specs = _orderHeaderSpecs();
  var candidates = [];

  (headerRows || []).forEach(function(values, rowIndex) {
    var normalized = values.map(_normalizeOrderHeader);
    var columns = {}, names = {}, duplicates = {}, score = 0;
    specs.forEach(function(spec) {
      var aliases = spec.aliases.map(_normalizeOrderHeader);
      var found = [];
      normalized.forEach(function(header, columnIndex) {
        if (header && aliases.indexOf(header) >= 0) found.push(columnIndex);
      });
      if (found.length) {
        score++;
        columns[spec.key] = found[0];
        names[spec.key] = String(values[found[0]] == null ? '' : values[found[0]]).trim();
        if (found.length > 1) duplicates[spec.key] = found.length;
      }
    });
    candidates.push({ headerRow: rowIndex + 1, headers: values, columns: columns,
      names: names, duplicates: duplicates, score: score });
  });

  if (!candidates.length) throw new Error('Не удалось прочитать строку заголовков листа «заказы»');
  var complete = candidates.filter(function(candidate) {
    return specs.every(function(spec) {
      return !spec.required || candidate.columns[spec.key] != null;
    });
  });
  if (complete.length > 1) {
    throw new Error('Найдено несколько строк с полным набором заголовков: ' +
      complete.map(function(candidate) { return candidate.headerRow; }).join(', ') +
      '. Оставьте одну строку заголовков; синхронизация отменена.');
  }
  var best = complete[0] || candidates.sort(function(a, b) {
    return b.score - a.score || a.headerRow - b.headerRow;
  })[0];
  var missing = specs.filter(function(spec) {
    return spec.required && best.columns[spec.key] == null;
  }).map(function(spec) { return '«' + spec.label + '»'; });
  if (missing.length) {
    throw new Error('Не найдены обязательные колонки: ' + missing.join(', ') +
      '. Синхронизация отменена, данные не изменены.');
  }
  var ambiguous = specs.filter(function(spec) {
    return best.duplicates[spec.key];
  }).map(function(spec) { return '«' + spec.label + '»'; });
  if (ambiguous.length) {
    throw new Error('Колонки найдены несколько раз: ' + ambiguous.join(', ') +
      '. Оставьте по одному заголовку; синхронизация отменена.');
  }
  return best;
}

function _orderCell(row, columnIndex) {
  return columnIndex == null ? '' : row[columnIndex];
}

function _orderText(row, columnIndex) {
  var value = _orderCell(row, columnIndex);
  return value == null ? '' : String(value).trim();
}

function _clientText(row, columnIndex, sheetRow) {
  var value = _orderCell(row, columnIndex);
  var text = value == null ? '' : String(value).trim();
  if (text && (typeof value === 'number' || /^[+-]?\d+(?:[.,]\d+)?$/.test(text))) {
    throw new Error('В строке ' + sheetRow + ' в колонке «Клиент» найдено число «' + text +
      '». Похоже, столбцы вставлены со смещением; синхронизация отменена.');
  }
  return text;
}

function _requiredOrderValue(value, label, sheetRow) {
  if (value == null || String(value).trim() === '') {
    throw new Error('В строке ' + sheetRow + ' не заполнена колонка «' + label +
      '». Синхронизация отменена, данные не изменены.');
  }
  return value;
}

function _normalizedOrderText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function syncOrders() {
  var cfg = _cfg();
  if (!cfg.url || !cfg.key) return { ok: false, error: 'Не заданы SUPABASE_URL / SUPABASE_SERVICE_KEY' };
  var lock = typeof LockService !== 'undefined' ? LockService.getScriptLock() : null;
  if (lock && !lock.tryLock(30000)) return { ok: false, error: 'Синхронизация уже выполняется' };

  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('заказы');
    if (!sheet) {
      throw new Error('Лист «заказы» не найден. Синхронизация отменена, данные не изменены.');
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 1 || lastColumn < 1) {
      throw new Error('Лист «заказы» пуст. Синхронизация отменена, данные не изменены.');
    }
    var headerScan = sheet.getRange(1, 1, Math.min(lastRow, 10), lastColumn).getValues();
    var layout = _resolveOrderSheetLayout(headerScan);
    if (lastRow <= layout.headerRow) return { ok: true, synced: 0, headerRow: layout.headerRow };

    var tz = 'Europe/Moscow';
    var data = sheet.getRange(layout.headerRow + 1, 1,
      lastRow - layout.headerRow, lastColumn).getValues();
    var sourceRows = data.filter(function(r) {
      return _orderText(r, layout.columns.orderNo);
    });
    var grouped = {};
    data.forEach(function(r, idx) {
      var rawOrderNo = _orderText(r, layout.columns.orderNo);
      if (!rawOrderNo) return;
      var sheetRow = layout.headerRow + idx + 1;
      var orderNo = rawOrderNo.toUpperCase().replace(/[–—]/g, '-');
      var client = _clientText(r, layout.columns.client, sheetRow);
      _requiredOrderValue(client, 'Клиент', sheetRow);
      var issueDate = _sheetDate(_requiredOrderValue(
        _orderCell(r, layout.columns.issueDate), 'Получение, дата', sheetRow),
        tz, sheetRow, 'выдача');
      var returnDate = _sheetDate(_requiredOrderValue(
        _orderCell(r, layout.columns.returnDate), 'Возврат, дата', sheetRow),
        tz, sheetRow, 'возврат');
      if (issueDate > returnDate) {
        throw new Error('В строке ' + sheetRow + ' дата выдачи ' + issueDate +
          ' позже даты возврата ' + returnDate + '. Синхронизация отменена.');
      }
      var issueTime = _sheetTime(_orderCell(r, layout.columns.issueTime), tz);
      var returnTime = _sheetTime(_orderCell(r, layout.columns.returnTime), tz);
      var row = grouped[orderNo] || {
        order_no: orderNo,
        client: '', company: '',
        issue_date: null, issue_time: '',
        return_date: null, return_time: '',
        delivery_worker: '', site_status: '', raw: null,
        source_row_count: 0, source_active: true, source_rows: []
      };
      if (row.client && _normalizedOrderText(row.client) !== _normalizedOrderText(client)) {
        throw new Error('Заказ «' + orderNo + '» повторяется с разными клиентами: «' +
          row.client + '» и «' + client + '» (строки ' + row.source_rows[0] +
          ' и ' + sheetRow + '). Синхронизация отменена.');
      }
      var deliveryWorker = _orderText(r, layout.columns.deliveryWorker);
      if (row.delivery_worker && deliveryWorker &&
          _normalizedOrderText(row.delivery_worker) !== _normalizedOrderText(deliveryWorker)) {
        throw new Error('Заказ «' + orderNo + '» повторяется с разными работниками доставки: «' +
          row.delivery_worker + '» и «' + deliveryWorker + '». Синхронизация отменена.');
      }
      row.source_row_count++;
      row.source_rows.push(sheetRow);
      row.client = client || row.client || '';
      row.company = _orderText(r, layout.columns.company) || row.company || '';
      if (issueDate && (!row.issue_date || issueDate < row.issue_date)) {
        row.issue_date = issueDate; row.issue_time = issueTime;
      } else if (issueDate === row.issue_date && !row.issue_time) {
        row.issue_time = issueTime;
      }
      if (returnDate && (!row.return_date || returnDate > row.return_date)) {
        row.return_date = returnDate; row.return_time = returnTime;
      } else if (returnDate === row.return_date && !row.return_time) {
        row.return_time = returnTime;
      }
      row.delivery_worker = deliveryWorker || row.delivery_worker || '';
      row.site_status = _orderText(r, layout.columns.siteStatus) || row.site_status || '';
      row.raw = { canonical: r, columns: layout.names, sourceRows: row.source_rows };
      grouped[orderNo] = row;
    });
    if (!sourceRows.length) return { ok: true, synced: 0 };

    var syncId = Utilities.getUuid ? Utilities.getUuid() : String(new Date().getTime());
    var syncedAt = new Date().toISOString();
    var rows = Object.keys(grouped).map(function(orderNo) {
      var row = grouped[orderNo];
      delete row.source_rows;
      row.source_sync_id = syncId;
      row.synced_at = syncedAt;
      return row;
    });

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
    if (lastCode < 200 || lastCode >= 300) {
      return { ok: false, synced: synced, code: lastCode, error: lastBody };
    }

    var staleFilter = encodeURIComponent('(source_sync_id.is.null,source_sync_id.neq.' + syncId + ')');
    _sbPatch(cfg, 'orders?or=' + staleFilter, { source_active: false });
    return { ok: true, synced: synced, sourceRows: sourceRows.length,
             duplicateRowsMerged: sourceRows.length - rows.length,
             headerRow: layout.headerRow, columns: layout.names };
  } finally {
    if (lock) lock.releaseLock();
  }
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
    if      (action === 'getData')          result = _getData(cfg, e.parameter.worker || null);
    else if (action === 'getAll')           result = _getAll(cfg, e.parameter.fromDate || null);
    else if (action === 'getUnmatched')     result = _getUnmatched(cfg);
    else if (action === 'getWorkerHistory') result = _getWorkerHistory(cfg, e.parameter.worker || null);
    else if (action === 'syncOrders')       result = syncOrders();
    else                              throw new Error('Unknown action: ' + action);
  } catch(err) {
    result = { ok: false, error: err.toString(), retryable: err.retryable === true };
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
    if (['addVisit', 'saveDraft', 'clearDraft', 'closeShift', 'deleteVisit', 'linkVisit'].indexOf(action) < 0) {
      throw new Error('Unknown action: ' + action);
    }
    _requireDataEpoch(payload);
    if      (action === 'addVisit')   result = _addVisit(cfg, payload);
    else if (action === 'saveDraft')  result = _saveDraft(cfg, payload);
    else if (action === 'clearDraft') result = _clearDraft(cfg, payload);
    else if (action === 'closeShift') result = _closeShift(cfg, payload);
    else if (action === 'deleteVisit')result = _deleteVisit(cfg, payload);
    else if (action === 'linkVisit')  result = _linkVisit(cfg, payload);
  } catch(err) {
    result = { ok: false, error: err.toString(), retryable: err.retryable === true };
  }
  if (result && result.ok === undefined) result = { ok: true, data: result };
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
