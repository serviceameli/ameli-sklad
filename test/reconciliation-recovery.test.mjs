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

function payload(eventId, orderId, operation, date, time) {
  return {
    clientEventId: eventId,
    clientShiftId: 'recovery-shift',
    worker: 'Тестовый кладовщик',
    shiftStart: `${date}T06:00:00Z`,
    shiftDate: date,
    isNight: 'День',
    entry: {
      visitor: 'client', operation, date, time, timeAuto: time,
      timestamp: `${date}T${time}:00+03:00`, night: 'День',
      orders: [{ id: orderId, operation }]
    }
  };
}

async function prepare() {
  const db = new PGlite();
  await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
  await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));
  await db.exec(read('supabase/migrations/202607140003_reconciliation_overdue_only.sql'));
  return db;
}

test('reconciliation exposes real visit dates and safe exact correction candidates', async () => {
  const db = await prepare();
  try {
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, client, issue_date, return_date, manual_hidden) values
        ('26-A-000945 (F)', 'Алена Иванова', '2026-07-18', '2026-07-19', true),
        ('26-A-001944 (F)', 'Надежда Пращикина', '2026-07-18', '2026-07-19', false),
        ('26-A-002061', 'Анастасия Королева', '2026-07-17', '2026-07-19', true),
        ('26-A-002053', 'Оксана Антонова', '2026-07-18', '2026-07-19', true),
        ('26-A-002062', 'Скрытая выдача', '2026-07-19', '2026-07-20', true),
        ('26-A-002063', 'Выдача после возврата', '2026-07-18', '2026-07-19', false);

      insert into public.shifts(id, worker, shift_date, start_at) values
        ('10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', '2026-07-16', '2026-07-16T06:00:00Z');

      insert into public.visits(id, shift_id, worker, visitor, operation, visit_date, visit_time, is_other, comment) values
        ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-19', '06:53', true, 'Анна Иванова 26-а-000945'),
        ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-19', '06:56', true, 'Надежда 26-A-001944'),
        ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-18', '09:58', true, 'Королева 26-а-002061'),
        ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-18', '09:05', true, 'Оксана 26-А-002053'),
        ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-19', '07:24', true, 'Оксана 26-A-002053'),
        ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-19', '08:00', true, 'Скрытая 26-A-002062'),
        ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-19', '09:00', true, 'Поздняя 26-A-002063');

      insert into public.visit_orders(visit_id, order_no, operation) values
        ('20000000-0000-0000-0000-000000000001', null, 'return'),
        ('20000000-0000-0000-0000-000000000002', null, 'return'),
        ('20000000-0000-0000-0000-000000000003', null, 'issue'),
        ('20000000-0000-0000-0000-000000000004', null, 'return'),
        ('20000000-0000-0000-0000-000000000005', null, 'return'),
        ('20000000-0000-0000-0000-000000000006', null, 'issue'),
        ('20000000-0000-0000-0000-000000000007', null, 'issue');

      insert into public.visits(id, worker, visitor, operation, visit_date, visit_time) values
        ('30000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-18', '10:00'),
        ('30000000-0000-0000-0000-000000000002', 'Тестовый кладовщик', 'client', 'return', '2026-07-19', '10:00'),
        ('30000000-0000-0000-0000-000000000003', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-17', '10:00'),
        ('30000000-0000-0000-0000-000000000004', 'Тестовый кладовщик', 'client', 'return', '2026-07-18', '10:00');
      insert into public.visit_orders(visit_id, order_no, operation) values
        ('30000000-0000-0000-0000-000000000001', '26-A-001944 (F)', 'issue'),
        ('30000000-0000-0000-0000-000000000002', '26-A-001944 (F)', 'return'),
        ('30000000-0000-0000-0000-000000000003', '26-A-002061', 'issue'),
        ('30000000-0000-0000-0000-000000000004', '26-A-002063', 'return');
    `);

    await db.exec(read('supabase/migrations/202607220001_reconciliation_recovery.sql'));
    const snapshot = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-22'], ['date']);

    const hiddenVisit = snapshot.unmatchedVisits.find(v => v.visitKey === '20000000-0000-0000-0000-000000000001');
    assert.equal(hiddenVisit.visitDate, '2026-07-19');
    assert.equal(hiddenVisit.shiftDate, '2026-07-16');
    assert.equal(hiddenVisit.suggestedOrderId, '26-A-000945 (F)');
    assert.equal(hiddenVisit.suggestionExact, true);
    assert.equal(snapshot.linkCandidates.some(c => c.id === '26-A-000945 (F)'), false,
      'operational candidates must still exclude a manually hidden order');

    const byOrder = Object.fromEntries(snapshot.correctionCandidates.map(c => [c.id, c]));
    assert.equal(byOrder['26-A-000945 (F)'].manualHidden, true);
    assert.equal(byOrder['26-A-000945 (F)'].correctionMode, 'seed_issue_and_link_return');
    assert.equal(byOrder['26-A-000945 (F)'].canApply, true);
    assert.equal(byOrder['26-A-001944 (F)'].correctionMode, 'duplicate_existing_operation');
    assert.equal(byOrder['26-A-001944 (F)'].canApply, false);
    assert.equal(byOrder['26-A-002061'].correctionMode, 'duplicate_existing_operation');
    assert.equal(byOrder['26-A-002061'].canApply, false);
    assert.equal(byOrder['26-A-002062'].correctionMode, 'restore_before_link');
    assert.equal(byOrder['26-A-002062'].canApply, false);
    assert.equal(byOrder['26-A-002063'].correctionMode, 'chronology_conflict');
    assert.equal(byOrder['26-A-002063'].canApply, false);
    assert.equal(byOrder['26-A-002053'].duplicateUnmatchedCount, 2);
    assert.equal(byOrder['26-A-002053'].requiresDuplicateConfirmation, true);

    const correctionPayload = {
      visitId: '20000000-0000-0000-0000-000000000005',
      orderId: '26-A-002053',
      reason: 'Подтверждено менеджером по первичным данным',
      actor: 'manager-dashboard',
      expectedVisitDate: '2026-07-19',
      expectedVisitTime: '07:24',
      baselineIssueDate: '2026-07-18',
      baselineIssueTime: '09:00',
      confirmDuplicate: false
    };
    await assert.rejects(
      rpc(db, 'apply_warehouse_manager_correction', [JSON.stringify(correctionPayload)], ['jsonb']),
      /Duplicate confirmation is required/
    );

    correctionPayload.confirmDuplicate = true;
    const corrected = await rpc(db, 'apply_warehouse_manager_correction', [JSON.stringify(correctionPayload)], ['jsonb']);
    assert.equal(corrected.correctionMode, 'seed_issue_and_link_return');
    assert.equal(corrected.baselineCreated, true);
    assert.equal((await db.query(`select manual_hidden from public.orders where order_no='26-A-002053'`)).rows[0].manual_hidden, true);

    const audit = await db.query(`select worker, operation, visit_date::text, visit_time, is_correction,
        correction_reason, correction_actor, shift_id
      from public.visits where id=$1`, [corrected.baselineVisitId]);
    assert.deepEqual(audit.rows[0], {
      worker: 'Система', operation: 'issue', visit_date: '2026-07-18', visit_time: '09:00', is_correction: true,
      correction_reason: correctionPayload.reason, correction_actor: correctionPayload.actor, shift_id: null
    });
    assert.deepEqual((await db.query(`select issued, returned from public.order_status where order_no='26-A-002053'`)).rows[0],
      { issued: true, returned: true });

    const secondDuplicate = { ...correctionPayload,
      visitId: '20000000-0000-0000-0000-000000000004',
      expectedVisitDate: '2026-07-18', expectedVisitTime: '09:05', confirmDuplicate: true };
    await assert.rejects(
      rpc(db, 'apply_warehouse_manager_correction', [JSON.stringify(secondDuplicate)], ['jsonb']),
      /already has a linked return operation/
    );
    assert.equal((await db.query(`select count(*)::int n from public.visit_orders
      where order_no='26-A-002053' and operation='return'`)).rows[0].n, 1,
      'confirmDuplicate must never create a second linked operation');

    await assert.rejects(
      rpc(db, 'apply_warehouse_manager_correction', [JSON.stringify({
        visitId: '20000000-0000-0000-0000-000000000006', orderId: '26-A-002062',
        reason: 'Проверка скрытой выдачи', actor: 'manager-dashboard',
        expectedVisitDate: '2026-07-19', expectedVisitTime: '08:00'
      })], ['jsonb']),
      /is hidden; restore it before linking an issue/
    );
    await assert.rejects(
      rpc(db, 'apply_warehouse_manager_correction', [JSON.stringify({
        visitId: '20000000-0000-0000-0000-000000000007', orderId: '26-A-002063',
        reason: 'Проверка хронологии', actor: 'manager-dashboard',
        expectedVisitDate: '2026-07-19', expectedVisitTime: '09:00'
      })], ['jsonb']),
      /issue cannot be recorded after return/
    );
  } finally {
    await db.close();
  }
});

test('ordinary record and link reject chronology conflicts in both directions', async () => {
  const db = await prepare();
  try {
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, issue_date, return_date) values
        ('ISSUE-AFTER-RETURN', '2026-07-19', '2026-07-20'),
        ('RETURN-BEFORE-ISSUE', '2026-07-19', '2026-07-20'),
        ('RECORD-ISSUE-LATE', '2026-07-19', '2026-07-20'),
        ('RECORD-RETURN-EARLY', '2026-07-19', '2026-07-20'),
        ('UNDATED-BASELINE', '2026-07-18', '2026-07-20');
      insert into public.orders(order_no, issue_date, return_date, manual_hidden) values
        ('HIDDEN-STALE-ISSUE', '2026-07-19', '2026-07-20', true),
        ('HIDDEN-OPEN-RETURN', '2026-07-18', '2026-07-20', true);
      insert into public.shifts(id, worker, shift_date, start_at) values
        ('40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', '2026-07-18', '2026-07-18T06:00:00Z');
      insert into public.visits(id, shift_id, worker, visitor, operation, visit_date, visit_time, is_other, comment) values
        ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-19', '09:00', false, ''),
        ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-20', '09:00', true, ''),
        ('50000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-20', '09:00', false, ''),
        ('50000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-19', '09:00', true, ''),
        ('50000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-19', '09:00', false, ''),
        ('50000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-20', '09:00', false, ''),
        ('50000000-0000-0000-0000-000000000007', null, 'Система', null, 'issue', null, null, false, 'Начальное состояние'),
        ('50000000-0000-0000-0000-000000000008', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-19', '10:00', true, ''),
        ('50000000-0000-0000-0000-000000000009', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'issue',  '2026-07-18', '10:00', false, ''),
        ('50000000-0000-0000-0000-000000000010', '40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client', 'return', '2026-07-20', '10:00', true, '');
      insert into public.visit_orders(visit_id, order_no, operation) values
        ('50000000-0000-0000-0000-000000000001', 'ISSUE-AFTER-RETURN', 'return'),
        ('50000000-0000-0000-0000-000000000002', null, 'issue'),
        ('50000000-0000-0000-0000-000000000003', 'RETURN-BEFORE-ISSUE', 'issue'),
        ('50000000-0000-0000-0000-000000000004', null, 'return'),
        ('50000000-0000-0000-0000-000000000005', 'RECORD-ISSUE-LATE', 'return'),
        ('50000000-0000-0000-0000-000000000006', 'RECORD-RETURN-EARLY', 'issue'),
        ('50000000-0000-0000-0000-000000000007', 'UNDATED-BASELINE', 'issue'),
        ('50000000-0000-0000-0000-000000000008', null, 'issue'),
        ('50000000-0000-0000-0000-000000000009', 'HIDDEN-OPEN-RETURN', 'issue'),
        ('50000000-0000-0000-0000-000000000010', null, 'return');
    `);
    await db.exec(read('supabase/migrations/202607220001_reconciliation_recovery.sql'));

    const baselineReturn = await db.query(`insert into public.visits(
      shift_id, worker, visitor, operation, visit_date, visit_time, is_other)
      values ('40000000-0000-0000-0000-000000000001', 'Тестовый кладовщик', 'client',
        'return', '2026-07-20', '11:00', false) returning id`);
    await db.query(`insert into public.visit_orders(visit_id, order_no, operation)
      values ($1, 'UNDATED-BASELINE', 'return')`, [baselineReturn.rows[0].id]);

    await assert.rejects(
      rpc(db, 'link_warehouse_visit', [
        '50000000-0000-0000-0000-000000000002',
        JSON.stringify([{ orderId: 'ISSUE-AFTER-RETURN', operation: 'issue' }])
      ], ['uuid', 'jsonb']),
      /issue cannot be recorded after return/
    );
    await assert.rejects(
      rpc(db, 'link_warehouse_visit', [
        '50000000-0000-0000-0000-000000000004',
        JSON.stringify([{ orderId: 'RETURN-BEFORE-ISSUE', operation: 'return' }])
      ], ['uuid', 'jsonb']),
      /cannot be returned before issue/
    );
    await assert.rejects(
      rpc(db, 'link_warehouse_visit', [
        '50000000-0000-0000-0000-000000000008',
        JSON.stringify([{ orderId: 'HIDDEN-STALE-ISSUE', operation: 'issue' }])
      ], ['uuid', 'jsonb']),
      /is hidden; restore it before linking an issue/
    );
    const hiddenReturn = await rpc(db, 'link_warehouse_visit', [
      '50000000-0000-0000-0000-000000000010',
      JSON.stringify([{ orderId: 'HIDDEN-OPEN-RETURN', operation: 'return' }])
    ], ['uuid', 'jsonb']);
    assert.equal(hiddenReturn.linked, 1, 'a hidden open rental must still be returnable');

    const draft = { worker: 'Тестовый кладовщик', clientShiftId: 'recovery-shift',
      shiftStart: '2026-07-20T06:00:00Z', shiftDate: '2026-07-20', visits: [] };
    await rpc(db, 'save_warehouse_draft', [JSON.stringify(draft)], ['jsonb']);

    await assert.rejects(
      rpc(db, 'record_warehouse_visit', [JSON.stringify(payload(
        'record-issue-late', 'RECORD-ISSUE-LATE', 'issue', '2026-07-20', '10:00'
      ))], ['jsonb']),
      /issue cannot be recorded after return/
    );
    const earlyReturn = payload(
      'record-return-early', 'RECORD-RETURN-EARLY', 'return', '2026-07-19', '10:00'
    );
    earlyReturn.shiftStart = draft.shiftStart;
    earlyReturn.shiftDate = draft.shiftDate;
    await assert.rejects(
      rpc(db, 'record_warehouse_visit', [JSON.stringify(earlyReturn)], ['jsonb']),
      /cannot be returned before issue/
    );
  } finally {
    await db.close();
  }
});

test('reconciliation recovery rollback restores the previous snapshot without changing business rows', async () => {
  const db = await prepare();
  try {
    await db.exec(`
      insert into public.orders(order_no, client, issue_date, return_date)
      values ('26-A-009999', 'Проверка отката', '2026-07-18', '2026-07-19');
      insert into public.visits(id, worker, operation, visit_date, visit_time, is_other, comment)
      values ('90000000-0000-0000-0000-000000000001', 'Проверка', 'return',
        '2026-07-19', '10:00', true, 'Проверка 26-A-009999');
      insert into public.visit_orders(visit_id, order_no, operation)
      values ('90000000-0000-0000-0000-000000000001', null, 'return');
    `);
    const before = await db.query(`select
      (select count(*)::int from public.orders) orders,
      (select count(*)::int from public.visits) visits,
      (select count(*)::int from public.visit_orders) links`);

    await db.exec(read('supabase/migrations/202607220001_reconciliation_recovery.sql'));
    const upgraded = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-22'], ['date']);
    assert.ok(Array.isArray(upgraded.correctionCandidates));

    await db.exec(read('supabase/rollbacks/202607220001_reconciliation_recovery.sql'));
    const after = await db.query(`select
      (select count(*)::int from public.orders) orders,
      (select count(*)::int from public.visits) visits,
      (select count(*)::int from public.visit_orders) links`);
    assert.deepEqual(after.rows[0], before.rows[0]);

    const rolledBack = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-22'], ['date']);
    assert.equal(Object.hasOwn(rolledBack, 'correctionCandidates'), false);
    assert.equal(rolledBack.unmatchedVisits[0].visitDate, undefined);
    assert.equal(rolledBack.unmatchedVisits[0].shiftDate, '2026-07-19');
    assert.equal((await db.query(`select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name='visits' and column_name like 'correction%'`)).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
