// ═══════════════════════════════════════════════════════════════
//  AMELI RENTAL — СКЛАД: слой доступа к данным (Supabase)
//  Отдаёт ровно тот же формат, что и Apps Script (getAll / getUnmatched),
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
  // yyyy-mm-dd → dd.mm.yyyy (для отображения, как в Apps Script)
  function ddmmyyyy(iso) {
    if (!iso) return '';
    const p = iso.split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
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

  // ── Публичный API ──
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

  // Заглушка под вкладку «Сверка» — реализуем при переносе истории
  async function getUnmatched() {
    return { unmatchedVisits: [], unlistedOrders: [] };
  }

  global.WHApi = { getAll, getUnmatched, _client: client };
})(window);
