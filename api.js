// ═══════════════════════════════════════════════════════════════
//  AMELI RENTAL — СКЛАД: слой доступа к данным
//  Все запросы идут через Apps Script (SYNC_URL) — обход CORS.
//  GET  → SYNC_URL?action=...  (без заголовков, без preflight)
//  POST → SYNC_URL с Content-Type:text/plain (простой запрос, без preflight)
//  Требует: config.js (SUPABASE_URL, SUPABASE_KEY, SYNC_URL)
// ═══════════════════════════════════════════════════════════════
(function (global) {

  function apiError(payload, fallback) {
    var msg = payload && (payload.error && (payload.error.message || payload.error) || payload.message);
    var err = new Error(msg || fallback || 'Ошибка сервера');
    // Старый деплой не присылал retryable; сетевой код сможет повторить его.
    err.retryable = payload && Object.prototype.hasOwnProperty.call(payload, 'retryable')
      ? payload.retryable === true : true;
    return err;
  }

  function unwrap(payload) {
    if (!payload || payload.ok === false || payload.error) throw apiError(payload);
    return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  }

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
    }).then(unwrap);
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
    }).then(unwrap);
  }

  // ── sfetch: прямой GET к Supabase (для дашборда, второстепенных запросов) ──
  function sfetch(table, query) {
    var url = SUPABASE_URL + '/rest/v1/' + table + '?' + query + '&apikey=' + encodeURIComponent(SUPABASE_KEY);
    return fetch(url, { credentials: 'omit' }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + table);
      return r.json();
    });
  }

  function sfetchAll(table, query) {
    var clean = String(query || '').replace(/(^|&)limit=\d+(&|$)/g, function(_m, a, b) {
      return a && b ? '&' : '';
    }).replace(/^&|&$/g, '');
    var stableKey = {
      visits: 'id', visit_orders: 'id', shifts: 'id', orders: 'order_no',
      order_status: 'order_no', workers: 'name', drafts: 'worker'
    }[table];
    if (stableKey) {
      var match = clean.match(/(^|&)order=([^&]*)/);
      if (match) {
        if (match[2].split(',').every(function(part) { return part.split('.')[0] !== stableKey; })) {
          clean = clean.replace(match[0], match[1] + 'order=' + match[2] + ',' + stableKey + '.asc');
        }
      } else {
        clean += (clean ? '&' : '') + 'order=' + stableKey + '.asc';
      }
    }
    var rows = [], offset = 0, size = 1000;
    function next() {
      var paged = clean + (clean ? '&' : '') + 'limit=' + size + '&offset=' + offset;
      return sfetch(table, paged).then(function(page) {
        rows = rows.concat(page);
        if (page.length < size) return rows;
        offset += size;
        return next();
      });
    }
    return next();
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
      clientEventId: payload.clientEventId,
      clientShiftId: payload.clientShiftId,
      worker: payload.worker, shiftStart: payload.shiftStart,
      shiftDate: payload.shiftDate, isNight: payload.isNight,
      entry: payload.entry });
  }

  // ── deleteVisit ───────────────────────────────────────────────
  function deleteVisit(payload) {
    return asPost({ action: 'deleteVisit',
      visitId: payload.visitId || null,
      clientEventId: payload.clientEventId || null });
  }

  // ── saveDraft ─────────────────────────────────────────────────
  function saveDraft(payload) {
    return asPost({ action: 'saveDraft', worker: payload.worker,
      shiftDate: payload.shiftDate, shiftStart: payload.shiftStart,
      clientShiftId: payload.clientShiftId,
      isNight: payload.isNight, visits: payload.visits || payload.entries,
      savedAt: payload.savedAt || new Date().toISOString() });
  }

  // ── clearDraft ────────────────────────────────────────────────
  function clearDraft(payload) {
    if (!payload || !payload.worker) return Promise.resolve();
    return asPost({ action: 'clearDraft', worker: payload.worker,
      clientShiftId: payload.clientShiftId || null,
      shiftStart: payload.shiftStart || null });
  }

  // ── closeShift ────────────────────────────────────────────────
  function closeShift(payload) {
    return asPost({ action: 'closeShift',
      worker: payload.worker, shiftStart: payload.shiftStart,
      shiftEnd: payload.shiftEnd, shiftDate: payload.shiftDate,
      isNight: payload.isNight, clientShiftId: payload.clientShiftId });
  }

  // ── Синхронизация Sheets → Supabase ──────────────────────────
  function syncOrders() {
    if (typeof SYNC_URL === 'undefined' || !SYNC_URL) throw new Error('SYNC_URL не задан');
    return fetch(SYNC_URL + '?action=syncOrders', { credentials: 'omit' })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(unwrap);
  }

  // ── Сверка (дашборд) — единый snapshot через Apps Script ─────
  function getUnmatched() {
    return asGet('getUnmatched');
  }

  // ── linkVisit (дашборд) ───────────────────────────────────────
  function linkVisit(payload) {
    var visitKey = payload.visitKey, orderIds = payload.orderIds;
    if (!visitKey || !orderIds || !orderIds.length) return Promise.resolve({ success: false });
    return asPost({ action: 'linkVisit', visitId: visitKey, orderIds: orderIds,
      operations: payload.operations || {} }).then(function(r) {
        return { success: true, linked: r.linked || orderIds.length, unresolved: r.unresolved || 0 };
      });
  }

  // ── deleteOrder (дашборд) ─────────────────────────────────────
  function deleteOrder(orderId) {
    return client().from('orders').update({ manual_hidden: true }).eq('order_no', orderId)
      .then(function(res) { if (res.error) throw res.error; return { success: true }; });
  }

  function restoreOrder(orderId) {
    return client().from('orders').update({ manual_hidden: false }).eq('order_no', orderId)
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
    return asGet('getWorkerHistory', { worker: workerName });
  }

  global.WHApi = {
    getData, getAll, getUnmatched, linkVisit,
    addVisit, deleteVisit, saveDraft, clearDraft, closeShift,
    deleteOrder, restoreOrder, syncOrders, getWorkers, addWorker, setWorkerActive, getWorkerHistory
  };
})(window);
