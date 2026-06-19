// ═══════════════════════════════════════════════════════════════
//  AMELI RENTAL — СКЛАД: слой доступа к данным
//  Все запросы идут через Apps Script (SYNC_URL) — обход CORS.
//  GET  → SYNC_URL?action=...  (без заголовков, без preflight)
//  POST → SYNC_URL с Content-Type:text/plain (простой запрос, без preflight)
//  Требует: config.js (SUPABASE_URL, SUPABASE_KEY, SYNC_URL)
// ═══════════════════════════════════════════════════════════════
(function (global) {

  // ── GET через Apps Script (нет CORS preflight) ──
  function asGet(action, params) {
    var url = SYNC_URL + '?action=' + encodeURIComponent(action);
    if (params) {
      Object.keys(params).forEach(function(k) {
        if (params[k] != null) url += '&' + k + '=' + encodeURIComponent(params[k]);
      });
    }
    return fetch(url, { credentials: 'omit' }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── POST через Apps Script (Content-Type:text/plain — нет preflight) ──
  function asPost(body) {
    return fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      credentials: 'omit'
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── sfetch: прямой GET к Supabase (для дашборда, второстепенных запросов) ──
  function sfetch(table, query) {
    var url = SUPABASE_URL + '/rest/v1/' + table + '?' + query + '&apikey=' + encodeURIComponent(SUPABASE_KEY);
    return fetch(url, { credentials: 'omit' }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + table);
      return r.json();
    });
  }

  // ── supabase-js клиент — только для вторичных операций дашборда ──
  var _client = null;
  function client() {
    if (!_client) _client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { reconnectAfterMs: function() { return 999999999; } }
    });
    return _client;
  }

  // ── Хелперы ──────────────────────────────────────────────────

  function mskToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  }

  function ddmmyyyy(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
  }

  function isoDate(ddmm) {
    if (!ddmm) return mskToday();
    if (/^\d{4}-\d{2}-\d{2}/.test(ddmm)) return ddmm.slice(0, 10);
    var m = ddmm.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
    return mskToday();
  }

  function fmtVisitTime(v) {
    if (!v) return '';
    var s = v.toString().trim();
    if (s.startsWith('1899-12-')) {
      var d = new Date(s);
      return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    }
    var m = s.match(/^(\d{1,2}):(\d{2})/);
    return m ? m[1].padStart(2, '0') + ':' + m[2] : s;
  }

  // ── getData: для страницы кладовщика ─────────────────────────
  function getData(worker) {
    return asGet('getData', { worker: worker || null });
  }

  // ── getAll: для дашборда ──────────────────────────────────────
  function getAll(fromDate) {
    return asGet('getAll', { fromDate: fromDate || null });
  }

  // ── addVisit: через Apps Script (обновляет order_status) ─────
  function addVisit(payload) {
    return asPost({ action: 'addVisit',
      worker: payload.worker, shiftStart: payload.shiftStart,
      shiftDate: payload.shiftDate, isNight: payload.isNight,
      entry: payload.entry });
  }

  // ── deleteVisit ───────────────────────────────────────────────
  function deleteVisit(payload) {
    return asPost({ action: 'deleteVisit',
      worker: payload.worker, shiftStart: payload.shiftStart,
      timeAuto: payload.timeAuto });
  }

  // ── saveDraft ─────────────────────────────────────────────────
  function saveDraft(payload) {
    return asPost({ action: 'saveDraft', worker: payload.worker,
      shiftDate: payload.shiftDate, shiftStart: payload.shiftStart,
      isNight: payload.isNight, visits: payload.visits || payload.entries,
      savedAt: payload.savedAt || new Date().toISOString() });
  }

  // ── clearDraft ────────────────────────────────────────────────
  function clearDraft(worker) {
    if (!worker) return Promise.resolve();
    return asPost({ action: 'clearDraft', worker: worker });
  }

  // ── closeShift ────────────────────────────────────────────────
  function closeShift(payload) {
    return asPost({ action: 'closeShift',
      worker: payload.worker, shiftStart: payload.shiftStart,
      shiftEnd: payload.shiftEnd });
  }

  // ── Синхронизация Sheets → Supabase ──────────────────────────
  function syncOrders() {
    if (typeof SYNC_URL === 'undefined' || !SYNC_URL) throw new Error('SYNC_URL не задан');
    return fetch(SYNC_URL + '?action=syncOrders', { credentials: 'omit' })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  // ── Сверка (дашборд) — прямой Supabase sfetch ────────────────
  function getUnmatched() {
    var today = mskToday();
    var sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    return Promise.all([
      sfetch('visits', 'select=*&is_other=eq.true&visit_date=gte.' + sevenDaysAgo),
      sfetch('visit_orders', 'select=*'),
      sfetch('shifts', 'select=*'),
      sfetch('orders', 'select=*'),
      sfetch('order_status', 'select=*')
    ]).then(function(res) {
      var visits = res[0], vorders = res[1], shifts = res[2], orders = res[3], statuses = res[4];
      var shiftById = {}, voByVisit = {};
      shifts.forEach(function(s) { shiftById[s.id] = s; });
      vorders.forEach(function(o) {
        if (!voByVisit[o.visit_id]) voByVisit[o.visit_id] = [];
        voByVisit[o.visit_id].push(o);
      });
      var issuedSet = new Set(), returnedSet = new Set();
      statuses.forEach(function(r) {
        if (r.issued) issuedSet.add(r.order_no);
        if (r.returned) returnedSet.add(r.order_no);
      });
      var unmatchedVisits = visits.map(function(v) {
        var s = shiftById[v.shift_id] || {};
        return {
          visitKey: v.id, shiftDate: s.shift_date || v.visit_date || '',
          time: fmtVisitTime(v.visit_time), worker: v.worker || s.worker || '',
          isNight: v.is_night ? 'Ночь' : 'День', visitor: v.visitor || '',
          operation: v.operation || '', comment: v.comment || '',
          orders: (voByVisit[v.id] || []).filter(function(o) { return o.order_no; }).map(function(o) { return { id: o.order_no }; })
        };
      });
      var unlistedOrders = orders.filter(function(o) {
        var iss = o.issue_date || '', ret = o.return_date || '';
        var inRange = (iss >= sevenDaysAgo && iss <= today) || (ret >= sevenDaysAgo && ret <= today);
        return inRange && (!issuedSet.has(o.order_no) || (issuedSet.has(o.order_no) && !returnedSet.has(o.order_no)));
      }).map(function(o) {
        return { id: o.order_no, client: o.client || '',
          issueDate: ddmmyyyy(o.issue_date), returnDate: ddmmyyyy(o.return_date),
          orderType: issuedSet.has(o.order_no) ? 'return' : 'issue' };
      });
      return { unmatchedVisits: unmatchedVisits, unlistedOrders: unlistedOrders };
    });
  }

  // ── linkVisit (дашборд) ───────────────────────────────────────
  function linkVisit(payload) {
    var sb = client();
    var visitKey = payload.visitKey, orderIds = payload.orderIds;
    if (!visitKey || !orderIds || !orderIds.length) return Promise.resolve({ success: false });
    return sfetch('orders', 'select=order_no,client,return_date,delivery_worker&order_no=in.(' + orderIds.join(',') + ')')
      .then(function(ordRows) {
        var ordMap = {};
        ordRows.forEach(function(o) { ordMap[o.order_no] = o; });
        var toInsert = orderIds.map(function(id) { return {
          visit_id: visitKey, order_no: id,
          client_snapshot: ordMap[id] ? ordMap[id].client || '' : '',
          return_date_snapshot: ordMap[id] ? ordMap[id].return_date || null : null,
          delivery_snapshot: ordMap[id] && ordMap[id].delivery_worker ? 'Наша доставка' : 'Самовывоз'
        }; });
        return sb.from('visit_orders').insert(toInsert);
      }).then(function(ins) {
        if (ins && ins.error) return { success: false, error: ins.error.message };
        return client().from('visits').update({ is_other: false }).eq('id', visitKey);
      }).then(function() { return { success: true, linked: orderIds.length }; });
  }

  // ── deleteOrder (дашборд) ─────────────────────────────────────
  function deleteOrder(orderId) {
    return client().from('orders').delete().eq('order_no', orderId)
      .then(function(res) { if (res.error) throw res.error; return { success: true }; });
  }

  // ── Управление кладовщиками (дашборд) ────────────────────────
  function getWorkers() {
    return sfetch('workers', 'select=name,active&order=name.asc');
  }

  function addWorker(name) {
    return client().from('workers').insert({ name: name.trim(), active: true })
      .then(function(res) { if (res.error) throw res.error; return { success: true }; });
  }

  function setWorkerActive(name, active) {
    return client().from('workers').update({ active: active }).eq('name', name)
      .then(function(res) { if (res.error) throw res.error; return { success: true }; });
  }

  function getWorkerHistory(workerName) {
    var wEnc = encodeURIComponent(workerName);
    return Promise.all([
      sfetch('shifts', 'select=*&worker=eq.' + wEnc + '&order=start_at.desc'),
      sfetch('visits', 'select=*&worker=eq.' + wEnc),
      sfetch('visit_orders', 'select=*')
    ]).then(function(res) {
      var shifts = res[0], visits = res[1], vorders = res[2];
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
          time: fmtVisitTime(v.visit_time), date: v.visit_date,
          comment: v.comment || '', isOther: !!v.is_other,
          orders: (voByVisit[v.id] || []).filter(function(o) { return o.order_no; }).map(function(o) {
            return { id: o.order_no, client: o.client_snapshot || '',
              returnDate: o.return_date_snapshot || '', delivery: o.delivery_snapshot || '' };
          })
        }; })
      }; });
    });
  }

  global.WHApi = {
    getData, getAll, getUnmatched, linkVisit,
    addVisit, deleteVisit, saveDraft, clearDraft, closeShift,
    deleteOrder, syncOrders, getWorkers, addWorker, setWorkerActive, getWorkerHistory
  };
})(window);
