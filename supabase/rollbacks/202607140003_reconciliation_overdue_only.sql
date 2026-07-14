-- Restore same-day missing events as reconciliation violations.

begin;

do $rollback_reconciliation$
declare
  v_signature regprocedure := 'public.warehouse_reconciliation_snapshot(date)'::regprocedure;
  v_definition text;
  v_rewritten text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if v_definition is null then
    raise exception 'Reconciliation rollback failed: function not found';
  end if;

  if position('o.issue_date <= p_today' in v_definition) > 0
     and position('o.return_date <= p_today' in v_definition) > 0 then
    return;
  end if;
  if position('o.issue_date < p_today' in v_definition) = 0
     or position('o.return_date < p_today' in v_definition) = 0 then
    raise exception 'Reconciliation rollback failed: expected predicates not found';
  end if;

  v_rewritten := replace(
    replace(v_definition, 'o.issue_date < p_today', 'o.issue_date <= p_today'),
    'o.return_date < p_today', 'o.return_date <= p_today'
  );
  execute v_rewritten;
end
$rollback_reconciliation$;

do $verify_reconciliation$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.warehouse_reconciliation_snapshot(date)'::regprocedure)
  into v_definition;
  if position('o.issue_date <= p_today' in v_definition) = 0
     or position('o.return_date <= p_today' in v_definition) = 0
     or position('o.issue_date < p_today' in v_definition) > 0
     or position('o.return_date < p_today' in v_definition) > 0 then
    raise exception 'Reconciliation rollback verification failed';
  end if;
end
$verify_reconciliation$;

commit;
