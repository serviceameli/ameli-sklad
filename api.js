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
  async function buildShifts(sb) {
    const [sh, vi, vo] = await Promise.all([
      sb.from('shifts').select('*'),
      sb.from('visits').select('*'),
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
      time: v.visit_time || '', timeAuto: v.visit_time || '',
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
  async function getAll() {
    const sb = client();
    const today = mskToday();
    const [ord, st, shifts] = await Promise.all([
      sb.from('orders').select('*'),
      sb.from('order_status').select('*'),
      buildShifts(sb)
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

    const [wk, ord, st, dr] = await Promise.all([
      sb.from('workers').select('name,pin').eq('active', true),
      sb.from('orders').select('*'),
      sb.from('order_status').select('*'),
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
      time: v.visit_time, date: v.visit_date,
      worker: v.worker, comment: v.comment || ''
    }));

    return {
      workers: (wk.data || []).map(w => ({ name: w.name, pin: w.pin })),
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

  // Заглушка под вкладку «Сверка» — реализуем позже
  async function getUnmatched() {
    return { unmatchedVisits: [], unlistedOrders: [] };
  }

  global.WHApi = { getAll, getData, getUnmatched, addVisit, deleteVisit, saveDraft, clearDraft, closeShift };
})(window);
