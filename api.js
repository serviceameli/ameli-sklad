// ═══════════════════════════════════════════════════════════════
//  AMELI RENTAL — СКЛАД: слой доступа к данным (Supabase)
//  Отдаёт ровно тот же формат, что и Apps Script (getAll / getData / write),
//  чтобы дашборд и страница кладовщика работали без переписывания логики.
//  Требует: supabase-js (CDN) + config.js (SUPABASE_URL, SUPABASE_KEY).
// ═══════════════════════════════════════════════════════════════
(function (global) {
  let _client = null;
  function client() {
    if (!_client) _client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return _client;
  }

  // Сегодня по МСК в формате yyyy-mm-dd
  function mskToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  }
  // yyyy-mm-dd → dd.mm.yyyy (для отображения)
  function ddmmyyyy(iso) {
    if (!iso) return '';
    const p = iso.split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
  }
  // Нормализует visit_time: "HH:MM" → "HH:MM", "1899-12-29T22:05:43.000Z" → "01:05" (UTC+3)
  function fmtVisitTime(v) {
    if (!v) return '';
    const s = v.toString().trim();
    if (s.startsWith('1899-12-')) {
      const d = new Date(s);
      return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    }
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    return m ? m[1].padStart(2, '0') + ':' + m[2] : s;
  }

  // dd.mm.yyyy → yyyy-mm-dd
  function isoDate(ddmm) {
    if (!ddmm) return mskToday();
    if (/^\d{4}-\d{2}-\d{2}/.test(ddmm)) return ddmm.slice(0, 10);
    const m = ddmm.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
    return mskToday();
  }

  // ── orders: повторяет getTodayOrders + getOverdueOrders ──
  function buildOrders(rows, today, issuedSet, returnedSet) {
    const todayList = [], overdue = [], seen = new Set();
    const baseOf = o => ({
      id: o.order_no, client: o.client || '', company: o.company || '',
      issueDate: ddmmyyyy(o.issue_date), issueTime: o.issue_time || '',
      returnDate: ddmmyyyy(o.return_date), returnTime: o.return_time || '',
      delivery: o.delivery_worker ? 'Наша доставка' : 'Самовывоз',
      worker: o.delivery_worker || ''
    });

    rows.forEach(o => {
      const iss = o.issue_date || '', ret = o.return_date || '';
      if (iss === today && ret === today) todayList.push({ ...baseOf(o), type: 'issue', sameDay: true });
      else if (iss === today) todayList.push({ ...baseOf(o), type: 'issue', sameDay: false });
      else if (ret === today) todayList.push({ ...baseOf(o), type: 'return', sameDay: false });
    });

    const todayIds = new Set(todayList.map(o => o.id));

    rows.forEach(o => {
      const id = o.order_no, iss = o.issue_date || '', ret = o.return_date || '';
      if (iss && iss < today && !issuedSet.has(id) && !seen.has(id + '_i')) {
        overdue.push({ ...baseOf(o), type: 'issue', sameDay: iss === ret, overdue: true }); seen.add(id + '_i');
      } else if (ret && ret < today && issuedSet.has(id) && !returnedSet.has(id) && !seen.has(id + '_r')) {
        overdue.push({ ...baseOf(o), type: 'return', sameDay: false, overdue: true }); seen.add(id + '_r');
      }
    });

    return [...todayList, ...overdue.filter(o => !todayIds.has(o.id))];
  }

  // ── shifts: собирает смены с вложенными визитами (как getAllShifts) ──
  async function buildShifts(sb, fromDate) {
    // fromDate = 'yyyy-mm-dd' — нижняя граница (по shift_date). Если не задана — 90 дней
    const cutoff = fromDate || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const [sh, vi, vo] = await Promise.all([
      sb.from('shifts').select('*').gte('shift_date', cutoff),
      sb.from('visits').select('*').gte('visit_date', cutoff),
      sb.from('visit_orders').select('*')
    ]);
    const shifts = sh.data || [], visits = vi.data || [], vorders = vo.data || [];

    const voByVisit = {};
    vorders.forEach(o => { (voByVisit[o.visit_id] = voByVisit[o.visit_id] || []).push(o); });
    const visByShift = {};
    visits.forEach(v => { (visByShift[v.shift_id] = visByShift[v.shift_id] || []).push(v); });

    const entryOf = v => ({
      visitor: v.visitor, operation: v.operation,
      orders: (voByVisit[v.id] || []).filter(o => o.order_no).map(o => ({
        id: o.order_no, client: o.client_snapshot || '', returnDate: o.return_date_snapshot || '', delivery: o.delivery_snapshot || ''
      })),
      time: fmtVisitTime(v.visit_time), timeAuto: fmtVisitTime(v.visit_time),
      night: v.is_night ? 'Ночь' : 'День', comment: v.comment || '',
      date: v.visit_date || '', isOther: !!v.is_other
    });

    return shifts.map(s => ({
      shiftDate: s.shift_date, shiftStart: s.start_at, shiftEnd: s.end_at,
      worker: s.worker, isNight: s.is_night ? 'Ночь' : 'День',
      totalEntries: (visByShift[s.id] || []).length,
      entries: (visByShift[s.id] || []).map(v => ({ ...entryOf(v), timestamp: s.start_at }))
    }));
  }

  // ── getAll: для дашборда ──
  // fromDate — нижняя граница периода 'yyyy-mm-dd' (приходит из UI-селектора периода)
  async function getAll(fromDate) {
    const sb = client();
    const today = mskToday();
    const [ord, st, shifts] = await Promise.all([
      sb.from('orders').select('order_no,client,company,issue_date,issue_time,return_date,return_time,delivery_worker,site_status'),
      sb.from('order_status').select('order_no,issued,returned,issued_by,returned_by'),
      buildShifts(sb, fromDate)
    ]);

    const issuedSet = new Set(), returnedSet = new Set(), issuedBy = {}, returnedBy = {};
    (st.data || []).forEach(r => {
      if (r.issued) { issuedSet.add(r.order_no); if (r.issued_by) issuedBy[r.order_no] = r.issued_by; }
      if (r.returned) { returnedSet.add(r.order_no); if (r.returned_by) returnedBy[r.order_no] = r.returned_by; }
    });

    const orders = buildOrders(ord.data || [], today, issuedSet, returnedSet);
    return {
      shifts,
      orders,
      processedOrders: { issued: [...issuedSet], returned: [...returnedSet], issuedBy, returnedBy, otherVisits: [] }
    };
  }

  // ── getData: для страницы кладовщика (аналог Apps Script getData) ──
  async function getData(worker) {
    const sb = client();
    const today = mskToday();
    // Берём заказы только за последние 60 дней — снижает трафик на мобиле
    const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

    const [wk, ord, st, dr] = await Promise.all([
      sb.from('workers').select('name').eq('active', true),
      sb.from('orders').select('order_no,client,company,issue_date,issue_time,return_date,return_time,delivery_worker,site_status')
        .or(`issue_date.gte.${cutoff},return_date.gte.${cutoff}`),
      sb.from('order_status').select('order_no,issued,returned,issued_by,returned_by'),
      worker
        ? sb.from('drafts').select('data').eq('worker', worker).maybeSingle()
        : Promise.resolve({ data: null })
    ]);

    const issuedSet = new Set(), returnedSet = new Set(), issuedBy = {}, returnedBy = {};
    (st.data || []).forEach(r => {
      if (r.issued) { issuedSet.add(r.order_no); if (r.issued_by) issuedBy[r.order_no] = r.issued_by; }
      if (r.returned) { returnedSet.add(r.order_no); if (r.returned_by) returnedBy[r.order_no] = r.returned_by; }
    });

    const orders = buildOrders(ord.data || [], today, issuedSet, returnedSet);

    // «Не из списка» — визиты is_other за последние 2 дня (чтобы видеть их после закрытия смены)
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const otherQ = await sb.from('visits')
      .select('visitor,operation,visit_time,visit_date,worker,comment')
      .eq('is_other', true)
      .gte('visit_date', twoDaysAgo);
    const otherVisits = (otherQ.data || []).map(v => ({
      visitor: v.visitor, operation: v.operation,
      time: fmtVisitTime(v.visit_time), date: v.visit_date,
      worker: v.worker, comment: v.comment || ''
    }));

    return {
      workers: (wk.data || []).map(w => ({ name: w.name })),
      orders,
      processedOrders: {
        issued: [...issuedSet], returned: [...returnedSet],
        issuedBy, returnedBy, otherVisits
      },
      draft: dr.data ? dr.data.data : null
    };
  }

  // ── addVisit: записать визит (shift + visit + visit_orders) ──
  async function addVisit(payload) {
    const sb = client();
    const { shiftDate, shiftStart, worker, isNight, entry } = payload;
    const shiftDateISO = isoDate(shiftDate);

    // 1. Найти или создать смену
    let shiftId;
    const existing = await sb.from('shifts').select('id')
      .eq('worker', worker).eq('start_at', shiftStart).maybeSingle();
    if (existing.data) {
      shiftId = existing.data.id;
    } else {
      const ins = await sb.from('shifts').insert({
        worker, shift_date: shiftDateISO, start_at: shiftStart, is_night: isNight === 'Ночь'
      }).select('id').single();
      if (ins.error) throw ins.error;
      shiftId = ins.data.id;
    }

    // 2. Вставить визит
    const hasOther = (entry.orders || []).some(o => o.id === '__other__');
    const vis = await sb.from('visits').insert({
      shift_id: shiftId, worker,
      visitor:    entry.visitor,
      operation:  entry.operation,
      visit_date: entry.date ? isoDate(entry.date) : shiftDateISO,
      visit_time: entry.time || entry.timeAuto || '',
      is_night:   entry.night === 'Ночь',
      is_other:   hasOther,
      comment:    entry.comment || '',
      entered_at: new Date().toISOString()
    }).select('id').single();
    if (vis.error) throw vis.error;
    const visitId = vis.data.id;

    // 3. Вставить заказы визита
    const vorders = [];
    (entry.orders || []).forEach(o => {
      if (o.id === '__other__') {
        vorders.push({
          visit_id: visitId, order_no: null,
          client_snapshot: entry.orderClient || '',
          return_date_snapshot: null,
          delivery_snapshot: entry.orderDelivery || ''
        });
      } else {
        vorders.push({
          visit_id: visitId, order_no: o.id,
          client_snapshot: o.client || '',
          return_date_snapshot: o.returnDate ? isoDate(o.returnDate) : null,
          delivery_snapshot: o.delivery || ''
        });
      }
    });
    if (vorders.length) {
      const vo = await sb.from('visit_orders').insert(vorders);
      if (vo.error) throw vo.error;
    }

    return { shiftId, visitId };
  }

  // ── deleteVisit: удалить визит по shiftStart + worker + timeAuto ──
  async function deleteVisit(payload) {
    const sb = client();
    const { shiftStart, worker, timeAuto } = payload;
    const sh = await sb.from('shifts').select('id')
      .eq('worker', worker).eq('start_at', shiftStart).maybeSingle();
    if (!sh.data) return;
    await sb.from('visits').delete()
      .eq('shift_id', sh.data.id).eq('visit_time', timeAuto);
  }

  // ── saveDraft: upsert в таблицу drafts ──
  async function saveDraft(payload) {
    const sb = client();
    const worker = payload.worker;
    if (!worker) return;
    await sb.from('drafts').upsert(
      { worker, data: payload, saved_at: new Date().toISOString() },
      { onConflict: 'worker' }
    );
  }

  // ── clearDraft: удалить черновик ──
  async function clearDraft(worker) {
    if (!worker) return;
    await client().from('drafts').delete().eq('worker', worker);
  }

  // ── closeShift: обновить end_at, удалить черновик ──
  async function closeShift(payload) {
    const sb = client();
    const { shiftStart, shiftEnd, worker } = payload;
    await Promise.all([
      sb.from('shifts').update({ end_at: shiftEnd })
        .eq('worker', worker).eq('start_at', shiftStart),
      sb.from('drafts').delete().eq('worker', worker)
    ]);
  }

  // Сверка: визиты is_other за 7 дней + заказы без записи в логе
  async function getUnmatched() {
    const sb = client();
    const today = mskToday();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const [vi, vo, sh, ord, st] = await Promise.all([
      sb.from('visits').select('*').eq('is_other', true).gte('visit_date', sevenDaysAgo),
      sb.from('visit_orders').select('*'),
      sb.from('shifts').select('*'),
      sb.from('orders').select('*'),
      sb.from('order_status').select('*')
    ]);

    const visits = vi.data || [], vorders = vo.data || [], shifts = sh.data || [];
    const orders = ord.data || [], statuses = st.data || [];

    const shiftById = {};
    shifts.forEach(s => { shiftById[s.id] = s; });

    const voByVisit = {};
    vorders.forEach(o => { (voByVisit[o.visit_id] = voByVisit[o.visit_id] || []).push(o); });

    const unmatchedVisits = visits.map(v => {
      const s = shiftById[v.shift_id] || {};
      const linkedOrders = (voByVisit[v.id] || []).filter(o => o.order_no).map(o => ({ id: o.order_no }));
      return {
        visitKey: v.id,
        shiftDate: s.shift_date || v.visit_date || '',
        time: fmtVisitTime(v.visit_time),
        worker: v.worker || s.worker || '',
        isNight: v.is_night ? 'Ночь' : 'День',
        visitor: v.visitor || '',
        operation: v.operation || '',
        comment: v.comment || '',
        orders: linkedOrders
      };
    });

    const issuedSet = new Set(), returnedSet = new Set();
    statuses.forEach(r => {
      if (r.issued) issuedSet.add(r.order_no);
      if (r.returned) returnedSet.add(r.order_no);
    });

    const unlistedOrders = orders.filter(o => {
      const iss = o.issue_date || '', ret = o.return_date || '';
      const inRange = (iss >= sevenDaysAgo && iss <= today) || (ret >= sevenDaysAgo && ret <= today);
      const notIssued   = inRange && !issuedSet.has(o.order_no);
      const notReturned = inRange && issuedSet.has(o.order_no) && !returnedSet.has(o.order_no);
      return notIssued || notReturned;
    }).map(o => {
      const issued   = issuedSet.has(o.order_no);
      const returned = returnedSet.has(o.order_no);
      const orderType = issued ? 'return' : 'issue';
      return {
        id: o.order_no, client: o.client || '',
        issueDate: ddmmyyyy(o.issue_date), returnDate: ddmmyyyy(o.return_date),
        orderType  // 'issue' = ещё не выдан, 'return' = выдан, ждёт возврата
      };
    });

    return { unmatchedVisits, unlistedOrders };
  }

  // Привязать визит «нет в списке» к заказам
  async function linkVisit(payload) {
    const sb = client();
    const { visitKey, orderIds } = payload;
    if (!visitKey || !orderIds || !orderIds.length) return { success: false, error: 'no data' };

    const vis = await sb.from('visits').select('id,shift_id').eq('id', visitKey).maybeSingle();
    if (!vis.data) return { success: false, error: 'visit not found' };

    const ordRows = await sb.from('orders').select('order_no,client,return_date,delivery_worker')
      .in('order_no', orderIds);
    const ordMap = {};
    (ordRows.data || []).forEach(o => { ordMap[o.order_no] = o; });

    const toInsert = orderIds.map(id => ({
      visit_id: visitKey,
      order_no: id,
      client_snapshot: ordMap[id]?.client || '',
      return_date_snapshot: ordMap[id]?.return_date || null,
      delivery_snapshot: ordMap[id]?.delivery_worker ? 'Наша доставка' : 'Самовывоз'
    }));

    const ins = await sb.from('visit_orders').insert(toInsert);
    if (ins.error) return { success: false, error: ins.error.message };

    // Обновить флаг is_other → false (визит теперь привязан)
    await sb.from('visits').update({ is_other: false }).eq('id', visitKey);

    return { success: true, linked: orderIds.length };
  }

  // Удалить заказ из таблицы orders
  async function deleteOrder(orderId) {
    const sb = client();
    const res = await sb.from('orders').delete().eq('order_no', orderId);
    if (res.error) throw res.error;
    return { success: true };
  }

  // Принудительная синхронизация Google Sheets → Supabase (через Apps Script)
  async function syncOrders() {
    if (typeof SYNC_URL === 'undefined' || !SYNC_URL) throw new Error('SYNC_URL не задан');
    const res = await fetch(SYNC_URL + '?action=syncOrders');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Список всех кладовщиков (включая архивных) для управления
  async function getWorkers() {
    const { data, error } = await client().from('workers').select('name,active').order('name');
    if (error) throw error;
    return data || [];
  }

  // Добавить кладовщика
  async function addWorker(name) {
    const { error } = await client().from('workers').insert({ name: name.trim(), active: true });
    if (error) throw error;
    return { success: true };
  }

  // Перевести кладовщика в архив (active=false) или восстановить (active=true)
  async function setWorkerActive(name, active) {
    const { error } = await client().from('workers').update({ active }).eq('name', name);
    if (error) throw error;
    return { success: true };
  }

  // История смен конкретного кладовщика с вложенными визитами
  async function getWorkerHistory(workerName) {
    const sb = client();
    const [sh, vi, vo] = await Promise.all([
      sb.from('shifts').select('*').eq('worker', workerName).order('start_at', { ascending: false }),
      sb.from('visits').select('*').eq('worker', workerName),
      sb.from('visit_orders').select('*')
    ]);
    const shifts = sh.data || [], visits = vi.data || [], vorders = vo.data || [];
    const voByVisit = {};
    vorders.forEach(o => { (voByVisit[o.visit_id] = voByVisit[o.visit_id] || []).push(o); });
    const visByShift = {};
    visits.forEach(v => { (visByShift[v.shift_id] = visByShift[v.shift_id] || []).push(v); });
    return shifts.map(s => ({
      id: s.id, shiftDate: s.shift_date, shiftStart: s.start_at, shiftEnd: s.end_at,
      isNight: s.is_night ? 'Ночь' : 'День',
      entries: (visByShift[s.id] || []).map(v => ({
        visitor: v.visitor, operation: v.operation,
        time: fmtVisitTime(v.visit_time), date: v.visit_date,
        comment: v.comment || '', isOther: !!v.is_other,
        orders: (voByVisit[v.id] || []).filter(o => o.order_no).map(o => ({
          id: o.order_no, client: o.client_snapshot || '',
          returnDate: o.return_date_snapshot || '', delivery: o.delivery_snapshot || ''
        }))
      }))
    }));
  }

  global.WHApi = { getAll, getData, getUnmatched, linkVisit, addVisit, deleteVisit, saveDraft, clearDraft, closeShift, deleteOrder, syncOrders, getWorkers, addWorker, setWorkerActive, getWorkerHistory };
})(window);
