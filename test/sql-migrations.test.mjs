import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleName = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = await import(moduleName);
const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');

async function rpc(db, name, args, casts) {
  const params = args.map((_, i) => `$${i + 1}::${casts[i]}`).join(',');
  const result = await db.query(`select public.${name}(${params}) as value`, args);
  return result.rows[0].value;
}

function visitPayload(eventId, orderId, operation, time) {
  return {
    clientEventId: eventId,
    clientShiftId: 'shift-test',
    worker: 'Тестовый кладовщик',
    shiftStart: '2026-07-15T06:00:00Z',
    shiftDate: '2026-07-15',
    isNight: 'День',
    entry: {
      visitor: 'client', operation, date: '2026-07-15', time,
      timeAuto: time, timestamp: `2026-07-15T${time}:00+03:00`, night: 'День',
      orders: [{ id: orderId, operation, returnDate: '2026-07-17' }]
    }
  };
}

test('SQL migrations enforce one idempotent rental lifecycle', async () => {
  const db = new PGlite();
  try {
    await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
    await db.exec(`alter table public.orders add column deleted_at timestamptz;
      insert into public.orders(order_no, issue_date, return_date, deleted_at)
      values ('LEGACY-HIDDEN', '2026-07-15', '2026-07-17', now());`);
    await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));
    await db.exec(read('supabase/migrations/202607130002_remove_confirmed_retry_duplicates.sql'));
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, issue_date, return_date) values
        ('111', '2026-07-15', '2026-07-17'),
        ('333', '2026-07-15', '2026-07-17');
    `);
    assert.equal((await db.query(`select manual_hidden from public.orders
      where order_no='LEGACY-HIDDEN'`)).rows[0].manual_hidden, true);

    const issue = visitPayload('event-issue-111', '111', 'issue', '10:00');
    const first = await rpc(db, 'record_warehouse_visit', [JSON.stringify(issue)], ['jsonb']);
    const retry = await rpc(db, 'record_warehouse_visit', [JSON.stringify(issue)], ['jsonb']);
    assert.equal(first.idempotent, false);
    assert.equal(retry.idempotent, true);
    assert.equal((await db.query(`select count(*)::int as n from public.visits`)).rows[0].n, 1);

    const returned = await rpc(db, 'record_warehouse_visit',
      [JSON.stringify(visitPayload('event-return-111', '111', 'return', '11:00'))], ['jsonb']);
    const state = (await db.query(`select issued, returned from public.order_status where order_no='111'`)).rows[0];
    assert.deepEqual(state, { issued: true, returned: true });

    await assert.rejects(
      rpc(db, 'delete_warehouse_visit', [first.visitId, 'event-issue-111'], ['uuid', 'text']),
      /issue cannot be deleted while its return exists/
    );
    await rpc(db, 'delete_warehouse_visit', [returned.visitId, 'event-return-111'], ['uuid', 'text']);
    await rpc(db, 'delete_warehouse_visit', [null, 'event-issue-111'], ['uuid', 'text']);
    const tombstoneRetry = await rpc(db, 'record_warehouse_visit', [JSON.stringify(issue)], ['jsonb']);
    assert.equal(tombstoneRetry.idempotent, true);
    assert.equal(tombstoneRetry.deleted, true);
    assert.equal((await db.query(`select count(*)::int as n from public.visits`)).rows[0].n, 0);

    await assert.rejects(
      rpc(db, 'record_warehouse_visit',
        [JSON.stringify(visitPayload('event-return-333', '333', 'return', '12:00'))], ['jsonb']),
      /cannot be returned before issue/
    );

    const shift = await db.query(`insert into public.shifts(worker,shift_date,start_at)
      values ('Тестовый кладовщик','2026-07-16','2026-07-16T06:00:00Z') returning id`);
    const unmatched = await db.query(`insert into public.visits(shift_id,worker,visitor,operation,visit_date,visit_time,is_other)
      values ($1,'Тестовый кладовщик','client','return','2026-07-16','10:00',true) returning id`, [shift.rows[0].id]);
    await db.query(`insert into public.visit_orders(visit_id,order_no,operation) values ($1,null,'return')`, [unmatched.rows[0].id]);
    await assert.rejects(
      rpc(db, 'link_warehouse_visit',
        [unmatched.rows[0].id, JSON.stringify([{ orderId: '333', operation: 'return' }])], ['uuid', 'jsonb']),
      /cannot be returned before issue/
    );

    const staffSnapshot = await rpc(db, 'warehouse_staff_snapshot',
      ['Тестовый кладовщик', '2026-07-15', '2026-07-13'], ['text', 'date', 'date']);
    assert.deepEqual(staffSnapshot.workers.map(row => row.name), ['Тестовый кладовщик']);
    assert.deepEqual(staffSnapshot.orders.map(row => row.order_no), ['111', '333']);

    const oldShift = await db.query(`insert into public.shifts(worker,shift_date,start_at)
      values ('Тестовый кладовщик','2026-07-01','2026-07-01T06:00:00Z') returning id`);
    const lateVisit = await db.query(`insert into public.visits(shift_id,worker,visitor,operation,visit_date,visit_time)
      values ($1,'Тестовый кладовщик','client','issue','2026-07-15','13:00') returning id`, [oldShift.rows[0].id]);
    const dashboardSnapshot = await rpc(db, 'warehouse_dashboard_snapshot', ['2026-07-15'], ['date']);
    assert.ok(dashboardSnapshot.shifts.some(row => row.id === oldShift.rows[0].id));
    assert.ok(dashboardSnapshot.visits.some(row => row.id === lateVisit.rows[0].id));

    await rpc(db, 'clear_warehouse_draft',
      ['Тестовый кладовщик', 'shift-test', null], ['text', 'text', 'timestamptz']);
    const newerDraft = { worker: 'Тестовый кладовщик', clientShiftId: 'shift-newer',
      shiftStart: '2026-07-18T06:00:00Z', visits: [] };
    await rpc(db, 'save_warehouse_draft', [JSON.stringify(newerDraft)], ['jsonb']);
    const staleClear = await rpc(db, 'clear_warehouse_draft',
      ['Тестовый кладовщик', 'shift-older', '2026-07-17T06:00:00Z'], ['text', 'text', 'timestamptz']);
    assert.equal(staleClear.stale, true);
    assert.equal((await db.query(`select count(*)::int as n from public.drafts
      where worker='Тестовый кладовщик'`)).rows[0].n, 1);
    const matchingClear = await rpc(db, 'clear_warehouse_draft',
      ['Тестовый кладовщик', 'shift-newer', null], ['text', 'text', 'timestamptz']);
    assert.equal(matchingClear.deleted, true);

    const close1 = { worker: 'Тестовый кладовщик', clientShiftId: 'shift-close', shiftStart: '2026-07-17T06:00:00Z', shiftEnd: '2026-07-17T12:00:00Z', shiftDate: '2026-07-17', isNight: 'День' };
    const close2 = { ...close1, shiftEnd: '2026-07-17T14:00:00Z' };
    await rpc(db, 'close_warehouse_shift', [JSON.stringify(close1)], ['jsonb']);
    const repeatedClose = await rpc(db, 'close_warehouse_shift', [JSON.stringify(close2)], ['jsonb']);
    const end = (await db.query(`select end_at from public.shifts where client_shift_id='shift-close'`)).rows[0].end_at;
    assert.equal(repeatedClose.idempotent, true);
    assert.equal(new Date(end).toISOString(), '2026-07-17T12:00:00.000Z');
  } finally {
    await db.close();
  }
});

test('legacy ambiguity is quarantined and open inactive rentals still await return', async () => {
  const db = new PGlite();
  try {
    await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, issue_date, return_date, source_active) values
        ('AMB', '2026-07-15', '2026-07-17', true),
        ('INACTIVE-OPEN', '2026-07-15', '2026-07-17', false),
        ('CONTRADICT', '2026-07-20', '2026-07-22', true),
        ('CROSS', '2026-07-20', '2026-07-22', true);
      insert into public.shifts(id,worker,shift_date,start_at,end_at)
      values ('00000000-0000-0000-0000-000000000010','Тестовый кладовщик','2026-07-15','2026-07-15T05:00:00Z','2026-07-15T12:00:00Z');
      insert into public.visits(id,shift_id,worker,visitor,operation,visit_date,visit_time)
      values
        ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000010','Тестовый кладовщик','client','both','2026-07-15','09:00'),
        ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000010','Тестовый кладовщик','client','issue','2026-07-15','09:05');
      insert into public.visit_orders(visit_id,order_no,operation) values
        ('00000000-0000-0000-0000-000000000011','AMB',null),
        ('00000000-0000-0000-0000-000000000012','INACTIVE-OPEN',null);
    `);
    await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));

    const staffOpen = await rpc(db, 'warehouse_staff_snapshot',
      ['Тестовый кладовщик', '2026-07-17', '2026-07-15'], ['text', 'date', 'date']);
    const openIds = new Set(staffOpen.orders.map(row => row.order_no));
    assert.equal(openIds.has('AMB'), false, 'unresolved mixed history must stay out of warehouse tasks');
    assert.equal(openIds.has('INACTIVE-OPEN'), true, 'issued rental must survive disappearance from source export');

    await db.exec(`
      insert into public.visits(id,shift_id,worker,visitor,operation,visit_date,visit_time)
      values ('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000010',
        'Тестовый кладовщик','client','return','2026-07-17','11:00');
      insert into public.visit_orders(visit_id,order_no,operation)
      values ('00000000-0000-0000-0000-000000000013','INACTIVE-OPEN','return');
    `);
    const staffReturnedToday = await rpc(db, 'warehouse_staff_snapshot',
      ['Тестовый кладовщик', '2026-07-17', '2026-07-15'], ['text', 'date', 'date']);
    assert.equal(staffReturnedToday.orders.some(row => row.order_no === 'INACTIVE-OPEN'), true,
      'an inactive order returned today must remain available for the today counter');

    const reconciliation = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-17'], ['date']);
    const ambiguous = reconciliation.lifecycleViolations.find(row => row.id === 'AMB');
    assert.equal(ambiguous.category, 'ambiguous_operation');
    assert.equal(ambiguous.ambiguous, true);
    assert.equal(reconciliation.linkCandidates.some(row => row.id === 'AMB'), false,
      'ambiguous history must stay read-only until a dedicated correction workflow exists');

    const activeShift = { worker: 'Тестовый кладовщик', clientShiftId: 'active-shift',
      shiftStart: '2026-07-20T06:00:00Z', shiftDate: '2026-07-20', visits: [] };
    await rpc(db, 'save_warehouse_draft', [JSON.stringify(activeShift)], ['jsonb']);

    const ambiguousPayload = visitPayload('ambiguous-new', 'AMB', 'issue', '10:00');
    Object.assign(ambiguousPayload, { clientShiftId: activeShift.clientShiftId,
      shiftStart: activeShift.shiftStart, shiftDate: activeShift.shiftDate });
    ambiguousPayload.entry.date = activeShift.shiftDate;
    await assert.rejects(
      rpc(db, 'record_warehouse_visit', [JSON.stringify(ambiguousPayload)], ['jsonb']),
      /unresolved historical operation/
    );

    const contradictory = visitPayload('contradictory', 'CONTRADICT', 'issue', '10:05');
    Object.assign(contradictory, { clientShiftId: activeShift.clientShiftId,
      shiftStart: activeShift.shiftStart, shiftDate: activeShift.shiftDate });
    contradictory.entry.date = activeShift.shiftDate;
    contradictory.entry.orders[0].operation = 'return';
    await assert.rejects(
      rpc(db, 'record_warehouse_visit', [JSON.stringify(contradictory)], ['jsonb']),
      /operation conflicts with visit operation/
    );

    const foreignVisit = await db.query(`insert into public.visits(
      shift_id,worker,visitor,operation,visit_date,visit_time,is_other)
      values ('00000000-0000-0000-0000-000000000010','Тестовый кладовщик','client','issue','2026-07-15','09:10',true)
      returning id`);
    await db.query(`insert into public.visit_orders(visit_id,order_no,operation)
      values ($1,null,'issue')`, [foreignVisit.rows[0].id]);
    await assert.rejects(rpc(db, 'link_warehouse_visit', [
      foreignVisit.rows[0].id,
      JSON.stringify([{ orderId: 'AMB', operation: 'issue' }])
    ], ['uuid', 'jsonb']), /unresolved operation belongs to another visit/);

    await rpc(db, 'link_warehouse_visit', [
      '00000000-0000-0000-0000-000000000011',
      JSON.stringify([{ orderId: 'AMB', operation: 'issue' }])
    ], ['uuid', 'jsonb']);
    const resolved = await db.query(`select operation from public.visit_orders
      where visit_id='00000000-0000-0000-0000-000000000011' and order_no='AMB'`);
    assert.equal(resolved.rows[0].operation, 'issue');

    const cross = visitPayload('cross-event', 'CROSS', 'issue', '10:10');
    Object.assign(cross, { clientShiftId: activeShift.clientShiftId,
      shiftStart: activeShift.shiftStart, shiftDate: activeShift.shiftDate });
    cross.entry.date = activeShift.shiftDate;
    await rpc(db, 'record_warehouse_visit', [JSON.stringify(cross)], ['jsonb']);
    await rpc(db, 'close_warehouse_shift', [JSON.stringify({ ...activeShift,
      shiftEnd: '2026-07-20T12:00:00Z', isNight: 'День' })], ['jsonb']);

    const nextDraft = { worker: 'Тестовый кладовщик', clientShiftId: 'next-shift',
      shiftStart: '2026-07-21T06:00:00Z', shiftDate: '2026-07-21', visits: [
        { clientEventId: 'cross-event', visitor: 'client', operation: 'issue', date: '2026-07-20', time: '10:10', orders: [] },
        { clientEventId: 'fresh-event', visitor: 'client', operation: 'issue', date: '2026-07-21', time: '10:11', orders: [] }
      ] };
    const filtered = await rpc(db, 'save_warehouse_draft', [JSON.stringify(nextDraft)], ['jsonb']);
    assert.deepEqual(filtered.draft.visits.map(v => v.clientEventId), ['fresh-event'],
      'an acknowledged event from the old shift must not be adopted visually');
  } finally {
    await db.close();
  }
});

test('SQL closes races, merges device drafts and reports historical violations', async () => {
  const db = new PGlite();
  try {
    await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
    await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, issue_date, return_date) values
        ('CLOSE', '2026-07-15', '2026-07-17'),
        ('LINK', '2026-07-15', '2026-07-17'),
        ('DUP-I', '2026-07-15', '2026-07-17'),
        ('DUP-R', '2026-07-15', '2026-07-17'),
        ('SEQ', '2026-07-15', '2026-07-17'),
        ('FUTURE', '2026-08-01', '2026-08-03');
    `);

    const draftA = { worker: 'Тестовый кладовщик', clientShiftId: 'draft-shift',
      shiftStart: '2026-07-18T06:00:00Z', savedAt: '2099-01-01T00:00:00Z',
      visits: [{ clientEventId: 'draft-a', visitor: 'client', operation: 'issue', date: '2026-07-18', time: '10:00', orders: [] }] };
    const draftB = { ...draftA, savedAt: '2000-01-01T00:00:00Z',
      visits: [{ clientEventId: 'draft-b', visitor: 'client', operation: 'issue', date: '2026-07-18', time: '10:01', orders: [] }] };
    await rpc(db, 'save_warehouse_draft', [JSON.stringify(draftA)], ['jsonb']);
    const merged = await rpc(db, 'save_warehouse_draft', [JSON.stringify(draftB)], ['jsonb']);
    assert.deepEqual(new Set(merged.draft.visits.map(v => v.clientEventId)), new Set(['draft-a', 'draft-b']));
    assert.notEqual(merged.draft.savedAt, draftA.savedAt, 'server time must replace a future device clock');

    await db.query(`insert into public.workers(name, active) values ('Legacy кладовщик', true)`);
    const legacyVisit = { visitor: 'client', operation: 'issue', date: '2026-07-18',
      time: '09:00', timeAuto: '09:00', comment: '', orders: [{ id: 'CLOSE', operation: 'issue' }] };
    const legacyDraft = { worker: 'Legacy кладовщик', clientShiftId: 'legacy-shift',
      shiftStart: '2026-07-18T05:00:00Z', visits: [legacyVisit] };
    await rpc(db, 'save_warehouse_draft', [JSON.stringify(legacyDraft)], ['jsonb']);
    const upgradedLegacy = await rpc(db, 'save_warehouse_draft', [JSON.stringify({
      ...legacyDraft, visits: [{ ...legacyVisit, clientEventId: 'legacy-upgraded' }]
    })], ['jsonb']);
    assert.equal(upgradedLegacy.draft.visits.length, 1,
      'adding a stable id must upgrade, not duplicate, an otherwise identical legacy visit');
    assert.equal(upgradedLegacy.draft.visits[0].clientEventId, 'legacy-upgraded');

    const blockedClose = { worker: 'Тестовый кладовщик', clientShiftId: 'draft-shift',
      shiftStart: '2026-07-18T06:00:00Z', shiftEnd: '2026-07-18T12:00:00Z', shiftDate: '2026-07-18', isNight: 'День' };
    await assert.rejects(rpc(db, 'close_warehouse_shift', [JSON.stringify(blockedClose)], ['jsonb']), /unrecorded draft visits/);
    await rpc(db, 'delete_warehouse_visit', [null, 'draft-a'], ['uuid', 'text']);
    await rpc(db, 'delete_warehouse_visit', [null, 'draft-b'], ['uuid', 'text']);
    await rpc(db, 'close_warehouse_shift', [JSON.stringify(blockedClose)], ['jsonb']);

    const closedPayload = visitPayload('closed-existing', 'CLOSE', 'issue', '10:00');
    closedPayload.shiftStart = '2026-07-19T06:00:00Z';
    closedPayload.shiftDate = '2026-07-19';
    closedPayload.clientShiftId = 'closed-shift';
    closedPayload.entry.date = '2026-07-19';
    const recorded = await rpc(db, 'record_warehouse_visit', [JSON.stringify(closedPayload)], ['jsonb']);
    await rpc(db, 'close_warehouse_shift', [JSON.stringify({ worker: closedPayload.worker,
      clientShiftId: closedPayload.clientShiftId, shiftStart: closedPayload.shiftStart,
      shiftEnd: '2026-07-19T12:00:00Z', shiftDate: closedPayload.shiftDate, isNight: 'День' })], ['jsonb']);
    const replay = await rpc(db, 'record_warehouse_visit', [JSON.stringify(closedPayload)], ['jsonb']);
    assert.equal(replay.visitId, recorded.visitId);
    const late = structuredClone(closedPayload); late.clientEventId = 'closed-late';
    await assert.rejects(rpc(db, 'record_warehouse_visit', [JSON.stringify(late)], ['jsonb']), /Shift is already closed/);

    const linkShift = await db.query(`insert into public.shifts(worker,shift_date,start_at)
      values ('Тестовый кладовщик','2026-07-16','2026-07-16T06:00:00Z') returning id`);
    const linkVisit = await db.query(`insert into public.visits(shift_id,worker,visitor,operation,visit_date,visit_time,is_other)
      values ($1,'Тестовый кладовщик','client','issue','2026-07-16','10:00',true) returning id`, [linkShift.rows[0].id]);
    await db.query(`insert into public.visit_orders(visit_id,order_no,operation) values ($1,null,'issue')`, [linkVisit.rows[0].id]);
    await rpc(db, 'link_warehouse_visit', [linkVisit.rows[0].id, JSON.stringify([{ orderId: 'LINK', operation: 'issue' }])], ['uuid', 'jsonb']);
    await assert.rejects(
      rpc(db, 'link_warehouse_visit', [linkVisit.rows[0].id, JSON.stringify([{ orderId: 'SEQ', operation: 'issue' }])], ['uuid', 'jsonb']),
      /already reconciled/
    );

    const legacyShift = await db.query(`insert into public.shifts(worker,shift_date,start_at)
      values ('Тестовый кладовщик','2026-07-15','2026-07-15T05:00:00Z') returning id`);
    const oldUnmatched = await db.query(`insert into public.visits(shift_id,worker,visitor,operation,visit_date,visit_time,is_other)
      values ($1,'Тестовый кладовщик','client','issue','2026-06-01','08:00',true) returning id`, [legacyShift.rows[0].id]);
    await db.query(`insert into public.visit_orders(visit_id,order_no,operation) values ($1,null,'issue')`, [oldUnmatched.rows[0].id]);
    const addLegacy = async (orderNo, operation, time) => {
      const visit = await db.query(`insert into public.visits(shift_id,worker,visitor,operation,visit_date,visit_time)
        values ($1,'Тестовый кладовщик','client',$2,'2026-07-15',$3) returning id`, [legacyShift.rows[0].id, operation, time]);
      await db.query(`insert into public.visit_orders(visit_id,order_no,operation) values ($1,$2,$3)`, [visit.rows[0].id, orderNo, operation]);
    };
    await addLegacy('DUP-I', 'issue', '09:00'); await addLegacy('DUP-I', 'issue', '09:01');
    await addLegacy('DUP-R', 'issue', '09:00'); await addLegacy('DUP-R', 'return', '10:00'); await addLegacy('DUP-R', 'return', '10:01');
    await addLegacy('SEQ', 'return', '08:00'); await addLegacy('SEQ', 'issue', '11:00');
    const reconciliation = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-17'], ['date']);
    assert.ok(reconciliation.unmatchedVisits.some(row => row.visitKey === oldUnmatched.rows[0].id));
    const category = Object.fromEntries(reconciliation.lifecycleViolations.map(row => [row.id, row.category]));
    assert.equal(category['DUP-I'], 'duplicate_issue');
    assert.equal(category['DUP-R'], 'duplicate_return');
    assert.equal(category.SEQ, 'return_before_issue');
    assert.equal(reconciliation.linkCandidates.find(row => row.id === 'FUTURE').orderType, 'issue');

    const history = await rpc(db, 'warehouse_worker_history_snapshot', ['Тестовый кладовщик'], ['text']);
    assert.ok(history.shifts.length > 0 && history.visits.length > 0 && history.visitOrders.length > 0);
    const backup = await rpc(db, 'warehouse_backup_snapshot', [], []);
    assert.equal(backup.orders.length, 6);
    assert.ok(Array.isArray(backup.warehouse_event_receipts));
  } finally {
    await db.close();
  }
});

test('an active draft reserves one worker shift without blocking idempotent replay', async () => {
  const db = new PGlite();
  try {
    await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
    await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, issue_date, return_date) values
        ('RES-A', '2026-07-20', '2026-07-22'),
        ('RES-B', '2026-07-21', '2026-07-23');
      -- Legacy open rows must not reserve the worker indefinitely.
      insert into public.shifts(worker, shift_date, start_at)
      values ('Тестовый кладовщик', '2026-06-01', '2026-06-01T06:00:00Z');
    `);

    const shiftA = {
      worker: 'Тестовый кладовщик', clientShiftId: 'reserved-shift-a',
      shiftStart: '2026-07-20T06:00:00Z', shiftDate: '2026-07-20', visits: []
    };
    const eventA = visitPayload('reserved-event-a', 'RES-A', 'issue', '10:00');
    Object.assign(eventA, {
      clientShiftId: shiftA.clientShiftId,
      shiftStart: shiftA.shiftStart,
      shiftDate: shiftA.shiftDate
    });
    eventA.entry.date = shiftA.shiftDate;
    eventA.entry.timestamp = '2026-07-20T10:00:00+03:00';
    eventA.entry.orders[0].returnDate = '2026-07-22';
    const recordedA = await rpc(db, 'record_warehouse_visit', [JSON.stringify(eventA)], ['jsonb']);
    assert.equal(recordedA.idempotent, false, 'the reserved shift itself must be writable');
    const claimedDraft = (await db.query(`select data from public.drafts
      where worker='Тестовый кладовщик'`)).rows[0].data;
    assert.equal(claimedDraft.shiftStart, shiftA.shiftStart,
      'an offline event must atomically claim the worker reservation');

    const shiftB = {
      worker: 'Тестовый кладовщик', clientShiftId: 'reserved-shift-b',
      shiftStart: '2026-07-21T06:00:00Z', shiftDate: '2026-07-21', visits: []
    };
    const eventB = visitPayload('reserved-event-b', 'RES-B', 'issue', '11:00');
    Object.assign(eventB, {
      clientShiftId: shiftB.clientShiftId,
      shiftStart: shiftB.shiftStart,
      shiftDate: shiftB.shiftDate
    });
    eventB.entry.date = shiftB.shiftDate;
    eventB.entry.timestamp = '2026-07-21T11:00:00+03:00';
    eventB.entry.orders[0].returnDate = '2026-07-23';

    await assert.rejects(
      rpc(db, 'record_warehouse_visit', [JSON.stringify(eventB)], ['jsonb']),
      /already has another active shift/
    );
    assert.equal((await db.query(`select count(*)::int as n from public.visits
      where client_event_id='reserved-event-b'`)).rows[0].n, 0);

    await rpc(db, 'close_warehouse_shift', [JSON.stringify({
      ...shiftA, shiftEnd: '2026-07-20T12:00:00Z', isNight: 'День'
    })], ['jsonb']);
    const reservedB = await rpc(db, 'save_warehouse_draft', [JSON.stringify(shiftB)], ['jsonb']);
    assert.equal(reservedB.ignored, false);
    const recordedB = await rpc(db, 'record_warehouse_visit', [JSON.stringify(eventB)], ['jsonb']);
    assert.equal(recordedB.idempotent, false);

    // A retry is acknowledged before the current reservation is checked.
    const replayA = await rpc(db, 'record_warehouse_visit', [JSON.stringify(eventA)], ['jsonb']);
    assert.equal(replayA.idempotent, true);
    assert.equal(replayA.visitId, recordedA.visitId);
    assert.equal((await db.query(`select count(*)::int as n from public.visits
      where client_event_id in ('reserved-event-a','reserved-event-b')`)).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

test('reset epoch blocks stale payload writes at the database boundary', async () => {
  const db = new PGlite();
  try {
    await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
    await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));
    await db.exec(read('supabase/migrations/202607140001_reset_epoch_guard.sql'));
    await db.exec(read('supabase/migrations/202607140001_reset_epoch_guard.sql'));
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, issue_date, return_date)
      values ('EPOCH-1', '2026-07-20', '2026-07-22');
    `);

    const draft = {
      worker: 'Тестовый кладовщик', clientShiftId: 'epoch-shift',
      shiftStart: '2026-07-20T06:00:00Z', shiftDate: '2026-07-20', visits: []
    };
    await assert.rejects(
      rpc(db, 'save_warehouse_draft', [JSON.stringify(draft)], ['jsonb']),
      /Страница склада устарела/
    );
    await rpc(db, 'save_warehouse_draft', [JSON.stringify({
      ...draft, dataEpoch: '2026-07-14-full-reset-v1'
    })], ['jsonb']);

    const visit = visitPayload('epoch-event', 'EPOCH-1', 'issue', '10:00');
    Object.assign(visit, {
      clientShiftId: draft.clientShiftId,
      shiftStart: draft.shiftStart,
      shiftDate: draft.shiftDate
    });
    visit.entry.date = draft.shiftDate;
    visit.entry.orders[0].returnDate = '2026-07-22';
    await assert.rejects(
      rpc(db, 'record_warehouse_visit', [JSON.stringify(visit)], ['jsonb']),
      /Страница склада устарела/
    );
    await rpc(db, 'record_warehouse_visit', [JSON.stringify({
      ...visit, dataEpoch: '2026-07-14-full-reset-v1'
    })], ['jsonb']);

    const close = {
      ...draft, shiftEnd: '2026-07-20T12:00:00Z', isNight: 'День'
    };
    await assert.rejects(
      rpc(db, 'close_warehouse_shift', [JSON.stringify(close)], ['jsonb']),
      /Страница склада устарела/
    );
    const closed = await rpc(db, 'close_warehouse_shift', [JSON.stringify({
      ...close, dataEpoch: '2026-07-14-full-reset-v1'
    })], ['jsonb']);
    assert.equal(closed.ok, true);

    await db.exec(read('supabase/rollbacks/202607140001_reset_epoch_guard.sql'));
    const guard = await db.query(`select to_regprocedure(
      'public.warehouse_assert_data_epoch(jsonb)') as value`);
    assert.equal(guard.rows[0].value, null);
    const definitions = await db.query(`
      select lower(pg_get_functiondef(signature)) as definition
      from unnest(array[
        'public.record_warehouse_visit(jsonb)'::regprocedure,
        'public.save_warehouse_draft(jsonb)'::regprocedure,
        'public.close_warehouse_shift(jsonb)'::regprocedure
      ]) signature
    `);
    assert.equal(definitions.rows.some(row =>
      row.definition.includes('warehouse_assert_data_epoch(p_payload)')), false);
  } finally {
    await db.close();
  }
});

test('reconciliation treats today tasks as planned work, not violations', async () => {
  const db = new PGlite();
  try {
    await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
    await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));
    await db.exec(read('supabase/migrations/202607140003_reconciliation_overdue_only.sql'));
    await db.exec(read('supabase/migrations/202607140003_reconciliation_overdue_only.sql'));
    await db.exec(`
      insert into public.orders(order_no, issue_date, return_date) values
        ('TODAY-ISSUE', '2026-07-17', '2026-07-18'),
        ('OVERDUE-ISSUE', '2026-07-16', '2026-07-18'),
        ('TODAY-RETURN', '2026-07-16', '2026-07-17'),
        ('OVERDUE-RETURN', '2026-07-15', '2026-07-16');
      insert into public.visits(id, worker, visitor, operation, comment) values
        ('00000000-0000-0000-0000-000000000201', 'Система', 'client', 'issue', 'baseline'),
        ('00000000-0000-0000-0000-000000000202', 'Система', 'client', 'issue', 'baseline');
      insert into public.visit_orders(visit_id, order_no, operation) values
        ('00000000-0000-0000-0000-000000000201', 'TODAY-RETURN', 'issue'),
        ('00000000-0000-0000-0000-000000000202', 'OVERDUE-RETURN', 'issue');
    `);

    const reconciliation = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-17'], ['date']);
    const category = Object.fromEntries(
      reconciliation.lifecycleViolations.map(row => [row.id, row.category])
    );
    assert.equal(category['TODAY-ISSUE'], undefined);
    assert.equal(category['TODAY-RETURN'], undefined);
    assert.equal(category['OVERDUE-ISSUE'], 'missing_issue');
    assert.equal(category['OVERDUE-RETURN'], 'missing_return');

    await db.exec(read('supabase/rollbacks/202607140003_reconciliation_overdue_only.sql'));
    const legacy = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-17'], ['date']);
    const legacyIds = new Set(legacy.lifecycleViolations.map(row => row.id));
    assert.equal(legacyIds.has('TODAY-ISSUE'), true);
    assert.equal(legacyIds.has('TODAY-RETURN'), true);
  } finally {
    await db.close();
  }
});
