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

async function prepare() {
  const db = new PGlite();
  await db.exec(read('supabase/migrations/202607120000_base_schema.sql'));
  await db.exec(read('supabase/migrations/202607130001_order_lifecycle.sql'));
  await db.exec(read('supabase/migrations/202607140001_reset_epoch_guard.sql'));
  await db.exec(read('supabase/migrations/202607140003_reconciliation_overdue_only.sql'));
  await db.exec(read('supabase/migrations/202607220001_reconciliation_recovery.sql'));
  return db;
}

function duplicatePayload(overrides = {}) {
  return {
    visitId: '62000000-0000-0000-0000-000000000002',
    orderId: '26-A-001944 (F)',
    reason: 'Повторная запись подтверждена менеджером',
    actor: 'Менеджер склада',
    expectedVisitDate: '2026-07-19',
    expectedVisitTime: '06:56',
    expectedOperation: 'return',
    confirmDuplicate: true,
    ...overrides
  };
}

test('manager duplicate marking preserves audit and excludes the visit everywhere operational', async () => {
  const db = await prepare();
  try {
    await db.exec(`
      insert into public.workers(name, active) values ('Тестовый кладовщик', true);
      insert into public.orders(order_no, client, issue_date, return_date) values
        ('26-A-001944 (F)', 'Надежда Пращикина', '2026-07-18', '2026-07-19'),
        ('26-A-002053', 'Оксана Антонова', '2026-07-18', '2026-07-19');
      insert into public.shifts(id, worker, shift_date, start_at) values
        ('61000000-0000-0000-0000-000000000001', 'Тестовый кладовщик',
          '2026-07-16', '2026-07-16T06:00:00Z');
      insert into public.visits(id, shift_id, worker, visitor, operation, visit_date, visit_time, is_other, comment, client_event_id) values
        ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001',
          'Тестовый кладовщик', 'client', 'issue', '2026-07-18', '10:00', false, '', null),
        ('62000000-0000-0000-0000-000000000003', '61000000-0000-0000-0000-000000000001',
          'Тестовый кладовщик', 'client', 'return', '2026-07-19', '06:50', false, '', null),
        ('62000000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000001',
          'Тестовый кладовщик', 'client', 'return', '2026-07-19', '06:56', true,
          'Надежда Пращикина 26-а-001944', 'duplicate-client-event'),
        ('62000000-0000-0000-0000-000000000004', '61000000-0000-0000-0000-000000000001',
          'Тестовый кладовщик', 'client', 'return', '2026-07-19', '07:24', true,
          'Оксана Антонова 26-A-002053', null);
      insert into public.visit_orders(visit_id, order_no, operation) values
        ('62000000-0000-0000-0000-000000000001', '26-A-001944 (F)', 'issue'),
        ('62000000-0000-0000-0000-000000000003', '26-A-001944 (F)', 'return'),
        ('62000000-0000-0000-0000-000000000002', null, 'return'),
        ('62000000-0000-0000-0000-000000000004', null, 'return');
      insert into public.warehouse_event_receipts(client_event_id, visit_id, status)
      values ('duplicate-client-event', '62000000-0000-0000-0000-000000000002', 'active');
      insert into public.drafts(worker, data) values ('Тестовый кладовщик',
        '{"worker":"Тестовый кладовщик","shiftStart":"2026-07-16T06:00:00Z","clientShiftId":"shift-test","visits":[{"clientEventId":"duplicate-client-event","visitId":"62000000-0000-0000-0000-000000000002"},{"clientEventId":"keep-event"}]}'::jsonb);
    `);
    await db.exec(read('supabase/migrations/202607220002_mark_duplicate_visit.sql'));

    const before = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-22'], ['date']);
    const candidate = before.correctionCandidates.find(row => row.visitKey === duplicatePayload().visitId);
    assert.equal(candidate.correctionMode, 'duplicate_existing_operation');
    assert.equal(candidate.canApply, false);

    await assert.rejects(
      rpc(db, 'mark_warehouse_visit_duplicate', [JSON.stringify(duplicatePayload({ reason: 'мало' }))], ['jsonb']),
      /at least 6/
    );
    await assert.rejects(
      rpc(db, 'mark_warehouse_visit_duplicate', [JSON.stringify(duplicatePayload({ confirmDuplicate: false }))], ['jsonb']),
      /confirmDuplicate=true/
    );
    await assert.rejects(
      rpc(db, 'mark_warehouse_visit_duplicate', [JSON.stringify(duplicatePayload({ expectedOperation: 'issue' }))], ['jsonb']),
      /operation changed/
    );
    await assert.rejects(
      rpc(db, 'mark_warehouse_visit_duplicate', [JSON.stringify(duplicatePayload({ expectedVisitTime: '07:00' }))], ['jsonb']),
      /Visit changed/
    );
    await assert.rejects(
      rpc(db, 'mark_warehouse_visit_duplicate', [JSON.stringify(duplicatePayload({
        originalVisitId: '62000000-0000-0000-0000-000000000001'
      }))], ['jsonb']),
      /not an active return event/
    );
    await assert.rejects(
      rpc(db, 'mark_warehouse_visit_duplicate', [JSON.stringify(duplicatePayload({
        visitId: '62000000-0000-0000-0000-000000000004', orderId: '26-A-002053',
        expectedVisitTime: '07:24'
      }))], ['jsonb']),
      /has no active linked return operation/
    );

    const marked = await rpc(db, 'mark_warehouse_visit_duplicate',
      [JSON.stringify(duplicatePayload())], ['jsonb']);
    assert.equal(marked.idempotent, false);
    assert.equal(marked.excluded, true);
    assert.equal(marked.originalVisitId, '62000000-0000-0000-0000-000000000003');

    const raw = await db.query(`select is_other, is_duplicate, duplicate_reason, duplicate_actor,
        duplicate_marked_at, duplicate_order_no, duplicate_of_visit_id
      from public.visits where id=$1`, [duplicatePayload().visitId]);
    assert.equal(raw.rows[0].is_other, true);
    assert.equal(raw.rows[0].is_duplicate, true);
    assert.equal(raw.rows[0].duplicate_reason, duplicatePayload().reason);
    assert.equal(raw.rows[0].duplicate_actor, duplicatePayload().actor);
    assert.equal(raw.rows[0].duplicate_order_no, duplicatePayload().orderId);
    assert.equal(raw.rows[0].duplicate_of_visit_id, marked.originalVisitId);
    assert.ok(raw.rows[0].duplicate_marked_at);

    assert.deepEqual((await db.query(`select visit_id, status from public.warehouse_event_receipts
      where client_event_id='duplicate-client-event'`)).rows[0], {
      visit_id: duplicatePayload().visitId, status: 'deleted'
    });
    const draft = (await db.query(`select data from public.drafts
      where worker='Тестовый кладовщик'`)).rows[0].data;
    assert.deepEqual(draft.visits.map(item => item.clientEventId), ['keep-event']);
    const offlineRetry = await rpc(db, 'record_warehouse_visit', [JSON.stringify({
      dataEpoch: '2026-07-14-full-reset-v1', clientEventId: 'duplicate-client-event',
      worker: 'Тестовый кладовщик', entry: {}
    })], ['jsonb']);
    assert.equal(offlineRetry.idempotent, true);
    assert.equal(offlineRetry.deleted, true);
    assert.equal((await db.query(`select count(*)::int n from public.visits
      where client_event_id='duplicate-client-event'`)).rows[0].n, 1);

    const retry = await rpc(db, 'mark_warehouse_visit_duplicate',
      [JSON.stringify(duplicatePayload())], ['jsonb']);
    assert.equal(retry.idempotent, true);
    assert.equal(new Date(retry.markedAt).toISOString(), new Date(marked.markedAt).toISOString());

    const reconciliation = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-22'], ['date']);
    assert.equal(reconciliation.unmatchedVisits.some(row => row.visitKey === duplicatePayload().visitId), false);
    assert.equal(reconciliation.correctionCandidates.some(row => row.visitKey === duplicatePayload().visitId), false);

    const staff = await rpc(db, 'warehouse_staff_snapshot',
      ['Тестовый кладовщик', '2026-07-19', '2026-07-17'], ['text', 'date', 'date']);
    assert.equal(staff.otherRows.some(row => row.id === duplicatePayload().visitId), false);
    assert.equal(staff.otherLinks.some(row => row.visit_id === duplicatePayload().visitId), false);
    assert.deepEqual(staff.excludedVisitIds, [duplicatePayload().visitId]);
    assert.deepEqual(staff.excludedClientEventIds, ['duplicate-client-event']);
    const anonymousStaff = await rpc(db, 'warehouse_staff_snapshot',
      [null, '2026-07-19', '2026-07-17'], ['text', 'date', 'date']);
    assert.deepEqual(anonymousStaff.excludedVisitIds, []);
    assert.deepEqual(anonymousStaff.excludedClientEventIds, []);

    await db.exec(`update public.visits set
      is_duplicate=true,
      duplicate_reason='Проверка legacy tombstone',
      duplicate_actor='Миграционный тест',
      duplicate_marked_at=now(),
      duplicate_order_no='26-A-002053'
      where id='62000000-0000-0000-0000-000000000004'`);
    const staffWithLegacy = await rpc(db, 'warehouse_staff_snapshot',
      ['Тестовый кладовщик', '2026-07-19', '2026-07-17'], ['text', 'date', 'date']);
    assert.deepEqual(new Set(staffWithLegacy.excludedVisitIds), new Set([
      duplicatePayload().visitId, '62000000-0000-0000-0000-000000000004'
    ]));
    assert.deepEqual(staffWithLegacy.excludedClientEventIds, ['duplicate-client-event'],
      'legacy duplicate without a client event must still be exposed by visit id');

    const saved = await rpc(db, 'save_warehouse_draft', [JSON.stringify({
      dataEpoch: '2026-07-14-full-reset-v1', worker: 'Тестовый кладовщик',
      shiftStart: '2026-07-16T06:00:00Z', clientShiftId: 'shift-test',
      visits: [
        { clientEventId: 'duplicate-client-event', visitId: duplicatePayload().visitId },
        { clientEventId: 'legacy-local-event', visitId: '62000000-0000-0000-0000-000000000004' },
        { clientEventId: 'keep-event' }
      ]
    })], ['jsonb']);
    assert.deepEqual(saved.draft.visits.map(item => item.clientEventId), ['keep-event']);

    const markDefinition = (await db.query(`select pg_get_functiondef(
      'public.mark_warehouse_visit_duplicate(jsonb)'::regprocedure) as value`)).rows[0].value;
    assert.ok(markDefinition.indexOf('pg_advisory_xact_lock(hashtextextended(v_visit.worker, 1))')
      > markDefinition.indexOf('for update'));
    assert.match(markDefinition, /where d\.worker = v_visit\.worker/);

    const dashboard = await rpc(db, 'warehouse_dashboard_snapshot', ['2026-07-18'], ['date']);
    assert.equal(dashboard.visits.some(row => row.id === duplicatePayload().visitId), false);
    assert.equal(dashboard.visitOrders.some(row => row.visit_id === duplicatePayload().visitId), false);

    const history = await rpc(db, 'warehouse_worker_history_snapshot', ['Тестовый кладовщик'], ['text']);
    assert.equal(history.visits.some(row => row.id === duplicatePayload().visitId), false);
    assert.equal(history.visitOrders.some(row => row.visit_id === duplicatePayload().visitId), false);

    assert.deepEqual((await db.query(`select issued, returned from public.order_status
      where order_no='26-A-001944 (F)'`)).rows[0], { issued: true, returned: true });
    const backup = await rpc(db, 'warehouse_backup_snapshot', [], []);
    assert.equal(backup.visits.find(row => row.id === duplicatePayload().visitId).is_duplicate, true,
      'raw backup must retain the audit row');

    await assert.rejects(
      rpc(db, 'link_warehouse_visit', [duplicatePayload().visitId,
        JSON.stringify([{ orderId: duplicatePayload().orderId, operation: 'return' }])], ['uuid', 'jsonb']),
      /marked as duplicate/
    );
    await assert.rejects(
      rpc(db, 'apply_warehouse_manager_correction', [JSON.stringify({
        visitId: duplicatePayload().visitId, orderId: duplicatePayload().orderId,
        reason: 'Повторная коррекция', actor: 'Менеджер', expectedVisitDate: '2026-07-19',
        expectedVisitTime: '06:56'
      })], ['jsonb']),
      /marked as duplicate/
    );
    await assert.rejects(
      rpc(db, 'delete_warehouse_visit', [duplicatePayload().visitId, 'duplicate-client-event'], ['uuid', 'text']),
      /marked as duplicate and cannot be deleted/
    );
    await assert.rejects(
      rpc(db, 'delete_warehouse_visit', [marked.originalVisitId, null], ['uuid', 'text']),
      /canonical visit for a duplicate audit and cannot be deleted/
    );
    await assert.rejects(
      db.query(`delete from public.visits where id=$1`, [marked.originalVisitId]),
      /foreign key constraint/
    );
    const duplicateFk = (await db.query(`select confdeltype, condeferrable
      from pg_constraint where conname='visits_duplicate_of_visit_id_fkey'`)).rows[0];
    assert.deepEqual(duplicateFk, { confdeltype: 'a', condeferrable: true });
    await assert.rejects(
      db.exec(read('supabase/rollbacks/202607220002_mark_duplicate_visit.sql')),
      /audit data already exists/
    );
  } finally {
    await db.close();
  }
});

test('duplicate lifecycle rows are ignored by status, reconciliation and chronology', async () => {
  const db = await prepare();
  try {
    await db.exec(`
      insert into public.orders(order_no, issue_date, return_date)
      values ('26-A-008888', '2026-07-19', '2026-07-20');
      insert into public.visits(id, worker, visitor, operation, visit_date, visit_time, is_other, comment)
      values
        ('71000000-0000-0000-0000-000000000001', 'Старый', 'client', 'issue',
          '2026-07-19', '08:00', false, 'ошибочная строка'),
        ('71000000-0000-0000-0000-000000000002', 'Менеджер', 'client', 'issue',
          '2026-07-20', '09:00', true, 'Выдача 26-A-008888');
      insert into public.visit_orders(visit_id, order_no, operation) values
        ('71000000-0000-0000-0000-000000000001', '26-A-008888', 'issue'),
        ('71000000-0000-0000-0000-000000000002', null, 'issue');
    `);
    await db.exec(read('supabase/migrations/202607220002_mark_duplicate_visit.sql'));
    await db.exec(`update public.visits set
      is_duplicate=true,
      duplicate_reason='Подтверждённая старая ошибка',
      duplicate_actor='Миграционный тест',
      duplicate_marked_at=now(),
      duplicate_order_no='26-A-008888'
      where id='71000000-0000-0000-0000-000000000001'`);

    const linked = await rpc(db, 'link_warehouse_visit', [
      '71000000-0000-0000-0000-000000000002',
      JSON.stringify([{ orderId: '26-A-008888', operation: 'issue' }])
    ], ['uuid', 'jsonb']);
    assert.equal(linked.linked, 1, 'a duplicate issue must not block the real issue lifecycle');
    assert.deepEqual((await db.query(`select issued, returned from public.order_status
      where order_no='26-A-008888'`)).rows[0], { issued: true, returned: false });

    const reconciliation = await rpc(db, 'warehouse_reconciliation_snapshot', ['2026-07-22'], ['date']);
    const violation = reconciliation.lifecycleViolations.find(row => row.id === '26-A-008888');
    assert.equal(violation.category, 'missing_return');
    assert.equal(violation.issueCount, 1);
    assert.equal(violation.returnCount, 0);
  } finally {
    await db.close();
  }
});

test('duplicate rollback is reversible before audit data exists', async () => {
  const rollbackSql = read('supabase/rollbacks/202607220002_mark_duplicate_visit.sql');
  const lockAt = rollbackSql.indexOf('lock table');
  const preflightAt = rollbackSql.indexOf('do $preflight_duplicate_rollback$');
  assert.ok(lockAt >= 0 && lockAt < preflightAt,
    'rollback must lock all mutable audit tables before checking for audit rows');
  assert.match(rollbackSql,
    /lock table\s+public\.warehouse_event_receipts,\s+public\.drafts,\s+public\.visit_orders,\s+public\.visits\s+in access exclusive mode;/s);
  const db = await prepare();
  try {
    await db.exec(`insert into public.orders(order_no) values ('26-A-009999')`);
    await db.exec(read('supabase/migrations/202607220002_mark_duplicate_visit.sql'));
    await db.exec(rollbackSql);

    assert.equal((await db.query(`select count(*)::int n from public.orders`)).rows[0].n, 1);
    assert.equal((await db.query(`select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name='visits' and column_name='is_duplicate'`)).rows[0].n, 0);
    assert.equal((await db.query(`select count(*)::int n from pg_proc
      where proname='mark_warehouse_visit_duplicate'`)).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
