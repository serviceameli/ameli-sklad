#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node scripts/audit-backup.mjs <backup-directory>');
const read = name => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const visits = read('visits');
const links = read('visit_orders');
const orders = read('orders');
const statuses = read('order_status');
const shifts = read('shifts');
const today = process.argv[3] || new Date().toISOString().slice(0, 10);

const linksByVisit = new Map();
for (const link of links) {
  if (!linksByVisit.has(link.visit_id)) linksByVisit.set(link.visit_id, []);
  linksByVisit.get(link.visit_id).push(link);
}
const signature = (v, includeOrders = true) => JSON.stringify([
  v.shift_id, v.worker, v.visitor, v.operation, v.visit_date, v.visit_time,
  includeOrders ? (linksByVisit.get(v.id) || []).map(x => x.order_no).sort() : null,
  (v.comment || '').trim()
]);
const groupBy = fn => visits.reduce((m, v) => {
  const key = fn(v); if (!m.has(key)) m.set(key, []); m.get(key).push(v); return m;
}, new Map());

const exactGroups = [...groupBy(v => signature(v)).values()].filter(g => g.length > 1);
const deleteIds = new Set();
for (const group of exactGroups) {
  group.sort((a, b) => a.entered_at.localeCompare(b.entered_at));
  group.slice(1).forEach(v => deleteIds.add(v.id));
}

const shadowGroups = [];
for (const group of groupBy(v => signature(v, false)).values()) {
  const linked = group.filter(v => !v.is_other && (linksByVisit.get(v.id) || []).some(x => x.order_no));
  const shadows = group.filter(v => v.is_other);
  if (linked.length && shadows.length) {
    shadowGroups.push({ linked, shadows });
    shadows.forEach(v => deleteIds.add(v.id));
  }
}

const ambiguousBoth = visits.filter(v => v.operation === 'both')
  .map(v => ({ visit: v, links: linksByVisit.get(v.id) || [] }))
  .filter(x => x.links.some(link => !link.operation));

const duplicateShifts = [...shifts.reduce((m, s) => {
  if (!s.worker || !s.start_at) return m;
  const key = `${s.worker}\u0000${s.start_at}`;
  if (!m.has(key)) m.set(key, []); m.get(key).push(s.id); return m;
}, new Map()).entries()].filter(([, ids]) => ids.length > 1);

const duplicateVisitOrderPairs = [...links.reduce((m, link) => {
  if (!link.visit_id || !link.order_no) return m;
  const key = `${link.visit_id}\u0000${link.order_no}`;
  if (!m.has(key)) m.set(key, []); m.get(key).push(link.id); return m;
}, new Map()).entries()].filter(([, ids]) => ids.length > 1);
const openShifts = shifts.filter(shift => !shift.end_at).map(shift => ({
  shiftId: shift.id, worker: shift.worker, startAt: shift.start_at
}));

const keptVisits = new Map(visits.filter(v => !deleteIds.has(v.id)).map(v => [v.id, v]));
const lifecycleOps = new Map();
for (const link of links) {
  const visit = keptVisits.get(link.visit_id);
  if (!visit || !link.order_no) continue;
  const operation = link.operation || (['issue', 'return'].includes(visit.operation) ? visit.operation : null);
  if (!operation) continue;
  const key = `${link.order_no}\u0000${operation}`;
  if (!lifecycleOps.has(key)) lifecycleOps.set(key, new Set());
  lifecycleOps.get(key).add(visit.id);
}
const duplicateLifecycleOperations = [...lifecycleOps.entries()]
  .filter(([, ids]) => ids.size > 1)
  .map(([key, ids]) => {
    const [orderNo, operation] = key.split('\u0000');
    return { orderNo, operation, visitIds: [...ids] };
  });
const byStatus = new Map(statuses.map(s => [s.order_no, s]));
const lifecycle = { missing_issue: [], missing_return: [], inconsistent: [] };
for (const order of orders) {
  const status = byStatus.get(order.order_no) || {};
  if (status.returned && !status.issued) lifecycle.inconsistent.push(order.order_no);
  else if (!status.issued && order.issue_date && order.issue_date <= today) lifecycle.missing_issue.push(order.order_no);
  else if (status.issued && !status.returned && order.return_date && order.return_date <= today) lifecycle.missing_return.push(order.order_no);
}

const result = {
  generatedAt: new Date().toISOString(), today,
  counts: { orders: orders.length, visits: visits.length, visitOrders: links.length,
    exactDuplicateGroups: exactGroups.length,
    technicalRetryRowsToDelete: deleteIds.size,
    shadowGroups: shadowGroups.length,
    ambiguousBothVisits: ambiguousBoth.length,
    openShifts: openShifts.length,
    duplicateShifts: duplicateShifts.length,
    duplicateVisitOrderPairs: duplicateVisitOrderPairs.length,
    duplicateLifecycleOperations: duplicateLifecycleOperations.length,
    ...Object.fromEntries(Object.entries(lifecycle).map(([k, v]) => [k, v.length])) },
  deleteVisitIds: [...deleteIds].sort(),
  ambiguousBoth: ambiguousBoth.map(x => ({ visitId: x.visit.id, worker: x.visit.worker,
    visitDate: x.visit.visit_date, visitTime: x.visit.visit_time,
    orderIds: x.links.map(l => l.order_no).filter(Boolean) })),
  duplicateShifts: duplicateShifts.map(([key, ids]) => ({
    worker: key.split('\u0000')[0], startAt: key.split('\u0000')[1], shiftIds: ids
  })),
  duplicateVisitOrderPairs: duplicateVisitOrderPairs.map(([key, ids]) => ({
    visitId: key.split('\u0000')[0], orderNo: key.split('\u0000')[1], linkIds: ids
  })),
  openShifts,
  duplicateLifecycleOperations,
  lifecycle
};
console.log(JSON.stringify(result, null, 2));
