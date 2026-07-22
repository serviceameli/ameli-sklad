-- Safe manager-assisted recovery for exact unmatched visit/order matches.
-- Access control is deliberately unchanged; authorization remains in the existing bridge.

begin;

alter table public.visits
  add column if not exists is_correction boolean not null default false,
  add column if not exists correction_reason text,
  add column if not exists correction_actor text,
  add column if not exists corrected_at timestamptz;

create or replace function public.warehouse_visit_event_at(
  p_visit_date date,
  p_visit_time text
)
returns timestamp
language sql
immutable
parallel safe
as $$
  select case
    when p_visit_date is null then null
    when p_visit_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
      then p_visit_date::timestamp + p_visit_time::time
    else p_visit_date::timestamp
  end
$$;

-- Extract normalized rental numbers from either an order id or free-form text.
-- The warehouse export sometimes uses Cyrillic А and sometimes Latin A; comments
-- also commonly omit the optional "(F)" suffix. The base number is therefore
-- the matching key, but a match is only actionable when it resolves to one row.
create or replace function public.warehouse_order_keys(p_value text)
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(array_agg(distinct regexp_replace((m.part)[1], '[[:space:]]', '', 'g') order by regexp_replace((m.part)[1], '[[:space:]]', '', 'g')), array[]::text[])
  from regexp_matches(
    translate(upper(coalesce(p_value, '')), 'А', 'A'),
    '([0-9]{2}[[:space:]]*-[[:space:]]*A[[:space:]]*-[[:space:]]*[0-9]{6})',
    'g'
  ) as m(part)
$$;

create or replace function public.warehouse_exact_order_key(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when cardinality(public.warehouse_order_keys(p_value)) = 1
      then (public.warehouse_order_keys(p_value))[1]
    else null
  end
$$;

-- Enforce event chronology even when an issue is added after a return already
-- exists. record_warehouse_visit/link_warehouse_visit already reject the other
-- direction; this trigger closes both paths and also protects direct SQL writes.
create or replace function public.warehouse_validate_event_chronology()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_operation text;
  v_event_at timestamp;
  v_conflict_at timestamp;
  v_has_undated_conflict boolean;
  v_has_prior_issue boolean;
begin
  if new.order_no is null then return new; end if;

  select
    public.warehouse_effective_operation(v.operation, new.operation),
    public.warehouse_visit_event_at(v.visit_date, v.visit_time)
  into v_operation, v_event_at
  from public.visits v
  where v.id = new.visit_id;

  if v_operation not in ('issue', 'return') or v_event_at is null then
    return new;
  end if;

  if v_operation = 'issue' then
    select
      min(public.warehouse_visit_event_at(v.visit_date, v.visit_time)),
      coalesce(bool_or(public.warehouse_visit_event_at(v.visit_date, v.visit_time) is null), false)
    into v_conflict_at, v_has_undated_conflict
    from public.visit_orders vo
    join public.visits v on v.id = vo.visit_id
    where vo.order_no = new.order_no
      and (tg_op <> 'UPDATE' or vo.id <> new.id)
      and public.warehouse_effective_operation(v.operation, vo.operation) = 'return';

    if v_has_undated_conflict or (v_conflict_at is not null and v_event_at > v_conflict_at) then
      raise exception 'Order % issue cannot be recorded after return', new.order_no;
    end if;
  else
    select coalesce(bool_or(
      public.warehouse_visit_event_at(v.visit_date, v.visit_time) is null
      or public.warehouse_visit_event_at(v.visit_date, v.visit_time) <= v_event_at
    ), false)
    into v_has_prior_issue
    from public.visit_orders vo
    join public.visits v on v.id = vo.visit_id
    where vo.order_no = new.order_no
      and (tg_op <> 'UPDATE' or vo.id <> new.id)
      and public.warehouse_effective_operation(v.operation, vo.operation) = 'issue';

    if not v_has_prior_issue then
      raise exception 'Order % cannot be returned before issue', new.order_no;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists visit_orders_chronology_guard on public.visit_orders;
create trigger visit_orders_chronology_guard
before insert or update of visit_id, order_no, operation on public.visit_orders
for each row execute function public.warehouse_validate_event_chronology();

create or replace function public.warehouse_reconciliation_snapshot(
  p_today date default current_date
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with normalized_orders as (
    select
      o.*,
      public.warehouse_exact_order_key(o.order_no) as order_key,
      count(*) over (partition by public.warehouse_exact_order_key(o.order_no)) as key_count
    from public.orders o
  ), ambiguous_orders as (
    select order_no, array_agg(visit_id order by visit_id) as unresolved_visit_ids
    from public.visit_orders
    where order_no is not null and operation is null
    group by order_no
  ), event_rows as (
    select
      vo.order_no,
      public.warehouse_effective_operation(v.operation, vo.operation) as operation,
      public.warehouse_visit_event_at(v.visit_date, v.visit_time) as event_at
    from public.visit_orders vo
    join public.visits v on v.id = vo.visit_id
    where vo.order_no is not null
      and public.warehouse_effective_operation(v.operation, vo.operation) is not null
  ), event_state as (
    select
      order_no,
      count(*) filter (where operation = 'issue')::integer as issue_count,
      count(*) filter (where operation = 'return')::integer as return_count,
      min(event_at) filter (where operation = 'issue') as first_issue_at,
      min(event_at) filter (where operation = 'return') as first_return_at,
      coalesce(bool_or(event_at is null) filter (where operation = 'issue'), false) as issue_has_undated
    from event_rows
    group by order_no
  ), classified_all as (
    select
      o.order_no,
      o.client,
      o.issue_date,
      o.return_date,
      o.manual_hidden,
      o.source_active,
      (a.order_no is not null) as lifecycle_ambiguous,
      coalesce(a.unresolved_visit_ids, array[]::uuid[]) as unresolved_visit_ids,
      coalesce(es.issue_count, 0) as issue_count,
      coalesce(es.return_count, 0) as return_count,
      es.first_issue_at,
      es.first_return_at,
      coalesce(es.issue_has_undated, false) as issue_has_undated,
      case
        when a.order_no is not null then 'ambiguous_operation'
        when coalesce(es.return_count, 0) > 0 and coalesce(es.issue_count, 0) = 0 then 'inconsistent'
        when coalesce(es.issue_count, 0) > 1 then 'duplicate_issue'
        when coalesce(es.return_count, 0) > 1 then 'duplicate_return'
        when es.first_return_at is not null and es.first_issue_at is not null
             and es.first_return_at < es.first_issue_at then 'return_before_issue'
        when coalesce(es.issue_count, 0) = 0 and o.issue_date is not null and o.issue_date < p_today then 'missing_issue'
        when coalesce(es.issue_count, 0) > 0 and coalesce(es.return_count, 0) = 0
             and o.return_date is not null and o.return_date < p_today then 'missing_return'
        else null
      end as category
    from public.orders o
    left join event_state es on es.order_no = o.order_no
    left join ambiguous_orders a on a.order_no = o.order_no
  ), classified as (
    select * from classified_all c
    where (c.source_active = true
           or (c.issue_count > 0 and c.return_count = 0)
           or c.lifecycle_ambiguous)
      and (c.manual_hidden = false or c.lifecycle_ambiguous)
  ), unmatched_suggestions as (
    select
      v.id as visit_id,
      public.warehouse_exact_order_key(v.comment) as comment_key,
      case
        when public.warehouse_exact_order_key(v.comment) is not null
         and count(no.order_no) = 1
          then min(no.order_no)
        else null
      end as suggested_order_id,
      case
        when cardinality(public.warehouse_order_keys(v.comment)) > 1 then true
        when public.warehouse_exact_order_key(v.comment) is not null and count(no.order_no) <> 1 then true
        else false
      end as suggestion_ambiguous,
      count(no.order_no)::integer as suggestion_match_count
    from public.visits v
    left join normalized_orders no
      on no.order_key = public.warehouse_exact_order_key(v.comment)
    where v.is_other = true
    group by v.id, v.comment
  ), correction_rows as (
    select
      v.id as visit_key,
      s.suggested_order_id,
      o.client,
      o.issue_date,
      o.return_date,
      o.manual_hidden,
      public.warehouse_effective_operation(v.operation, null) as operation,
      coalesce(c.issue_count, 0) as issue_count,
      coalesce(c.return_count, 0) as return_count,
      coalesce(c.lifecycle_ambiguous, false) as lifecycle_ambiguous,
      public.warehouse_visit_event_at(v.visit_date, v.visit_time) as visit_event_at,
      c.first_issue_at,
      c.first_return_at,
      c.issue_has_undated,
      count(*) over (partition by s.suggested_order_id) as duplicate_unmatched_count
    from unmatched_suggestions s
    join public.visits v on v.id = s.visit_id
    join public.orders o on o.order_no = s.suggested_order_id
    left join classified_all c on c.order_no = o.order_no
    where s.suggested_order_id is not null and not s.suggestion_ambiguous
  )
  select jsonb_build_object(
    'unmatchedVisits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'visitKey', v.id,
        'visitDate', v.visit_date,
        'shiftDate', s.shift_date,
        'time', v.visit_time,
        'worker', coalesce(v.worker, s.worker, ''),
        'isNight', case when v.is_night then 'Ночь' else 'День' end,
        'visitor', v.visitor,
        'operation', v.operation,
        'comment', coalesce(v.comment, ''),
        'suggestedOrderId', us.suggested_order_id,
        'suggestionExact', us.suggested_order_id is not null and not us.suggestion_ambiguous,
        'suggestionAmbiguous', us.suggestion_ambiguous,
        'suggestionMatchCount', us.suggestion_match_count,
        'orders', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', vo.order_no,
            'operation', public.warehouse_effective_operation(v.operation, vo.operation)
          ) order by vo.order_no)
          from public.visit_orders vo
          where vo.visit_id = v.id and vo.order_no is not null
        ), '[]'::jsonb)
      ) order by v.visit_date desc, v.visit_time desc, v.id)
      from public.visits v
      left join public.shifts s on s.id = v.shift_id
      left join unmatched_suggestions us on us.visit_id = v.id
      where v.is_other = true
    ), '[]'::jsonb),
    'linkCandidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.order_no,
        'client', coalesce(c.client, ''),
        'issueDate', c.issue_date,
        'returnDate', c.return_date,
        'orderType', case when c.issue_count = 0 then 'issue' when c.return_count = 0 then 'return' else null end,
        'ambiguous', c.lifecycle_ambiguous,
        'unresolvedVisitIds', c.unresolved_visit_ids
      ) order by c.issue_date nulls last, c.return_date nulls last, c.order_no)
      from classified c
      where not c.lifecycle_ambiguous and (c.issue_count = 0 or c.return_count = 0)
    ), '[]'::jsonb),
    'correctionCandidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'visitKey', r.visit_key,
        'id', r.suggested_order_id,
        'client', coalesce(r.client, ''),
        'issueDate', r.issue_date,
        'returnDate', r.return_date,
        'operation', r.operation,
        'manualHidden', r.manual_hidden,
        'issueCount', r.issue_count,
        'returnCount', r.return_count,
        'duplicateUnmatchedCount', r.duplicate_unmatched_count,
        'requiresDuplicateConfirmation', r.duplicate_unmatched_count > 1
          or (r.operation = 'issue' and r.issue_count > 0)
          or (r.operation = 'return' and r.return_count > 0),
        'correctionMode', case
          when (r.operation = 'issue' and r.issue_count > 0)
            or (r.operation = 'return' and r.return_count > 0) then 'duplicate_existing_operation'
          when r.operation = 'issue' and r.manual_hidden then 'restore_before_link'
          when r.operation = 'issue' and r.return_count > 0
               and (r.first_return_at is null or r.visit_event_at > r.first_return_at)
            then 'chronology_conflict'
          when r.operation = 'return' and r.issue_count = 0 then 'seed_issue_and_link_return'
          else 'link'
        end,
        'canApply', coalesce(r.operation in ('issue', 'return'), false)
          and not r.lifecycle_ambiguous
          and not (r.operation = 'issue' and r.issue_count > 0)
          and not (r.operation = 'return' and r.return_count > 0)
          and not (r.operation = 'issue' and r.manual_hidden)
          and not (r.operation = 'issue' and r.return_count > 0
                   and (r.first_return_at is null or r.visit_event_at > r.first_return_at))
          and not (r.operation = 'return' and r.issue_count > 0
                   and not r.issue_has_undated
                   and (r.first_issue_at is null or r.first_issue_at > r.visit_event_at))
      ) order by r.visit_key)
      from correction_rows r
    ), '[]'::jsonb),
    'lifecycleViolations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.order_no,
        'client', coalesce(c.client, ''),
        'issueDate', c.issue_date,
        'returnDate', c.return_date,
        'category', c.category,
        'issueCount', c.issue_count,
        'returnCount', c.return_count,
        'ambiguous', c.lifecycle_ambiguous,
        'orderType', case
          when c.category = 'missing_return' then 'return'
          when c.category in ('missing_issue', 'inconsistent') then 'issue'
          else null
        end
      ) order by c.return_date nulls last, c.issue_date nulls last, c.order_no)
      from classified c where c.category is not null
    ), '[]'::jsonb)
  )
$$;

create or replace function public.apply_warehouse_manager_correction(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_visit public.visits%rowtype;
  v_order public.orders%rowtype;
  v_visit_id uuid := nullif(trim(p_payload->>'visitId'), '')::uuid;
  v_order_no text := nullif(trim(p_payload->>'orderId'), '');
  v_reason text := nullif(trim(p_payload->>'reason'), '');
  v_actor text := nullif(trim(p_payload->>'actor'), '');
  v_expected_date date := nullif(p_payload->>'expectedVisitDate', '')::date;
  v_expected_time text := nullif(p_payload->>'expectedVisitTime', '');
  v_confirm_duplicate boolean := coalesce((p_payload->>'confirmDuplicate')::boolean, false);
  v_operation text;
  v_visit_at timestamp;
  v_baseline_date date;
  v_baseline_time text;
  v_baseline_at timestamp;
  v_baseline_visit_id uuid;
  v_issue_count integer;
  v_return_count integer;
  v_duplicate_unmatched_count integer;
  v_first_issue_at timestamp;
  v_first_return_at timestamp;
  v_issue_has_undated boolean;
  v_exact_order_no text;
  v_mode text;
  v_unresolved integer;
begin
  if v_visit_id is null or v_order_no is null or v_reason is null or v_actor is null
     or v_expected_date is null or v_expected_time is null then
    raise exception 'visitId, orderId, reason, actor, expectedVisitDate and expectedVisitTime are required';
  end if;
  if v_expected_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'expectedVisitTime must be HH:MM';
  end if;

  select * into v_visit from public.visits where id = v_visit_id for update;
  if not found then raise exception 'Visit % not found', v_visit_id; end if;
  if not v_visit.is_other then
    if exists (select 1 from public.visit_orders where visit_id = v_visit_id and order_no = v_order_no) then
      return jsonb_build_object('ok', true, 'idempotent', true, 'visitId', v_visit_id,
        'orderId', v_order_no, 'operation', public.warehouse_effective_operation(v_visit.operation, null));
    end if;
    raise exception 'Visit % is already reconciled', v_visit_id;
  end if;
  if v_visit.visit_date is distinct from v_expected_date
     or v_visit.visit_time is distinct from v_expected_time then
    raise exception 'Visit changed since reconciliation snapshot';
  end if;

  v_operation := public.warehouse_effective_operation(v_visit.operation, null);
  if v_operation not in ('issue', 'return') then
    raise exception 'Only issue or return visits can be corrected';
  end if;
  v_visit_at := public.warehouse_visit_event_at(v_visit.visit_date, v_visit.visit_time);

  select min(o.order_no) into v_exact_order_no
  from public.orders o
  where public.warehouse_exact_order_key(o.order_no) = public.warehouse_exact_order_key(v_visit.comment)
  having count(*) = 1;
  if v_exact_order_no is null or v_exact_order_no <> v_order_no then
    raise exception 'Order % is not the unique exact match from visit comment', v_order_no;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order_no, 0));
  select * into v_order from public.orders where order_no = v_order_no for update;
  if not found then raise exception 'Order % not found', v_order_no; end if;
  if v_operation = 'issue' and v_order.manual_hidden then
    raise exception 'Order % is hidden; restore it before linking an issue', v_order_no;
  end if;
  if exists (select 1 from public.visit_orders where order_no = v_order_no and operation is null) then
    raise exception 'Order % has an unresolved historical operation', v_order_no;
  end if;

  select
    count(*) filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'issue')::integer,
    count(*) filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'return')::integer,
    min(public.warehouse_visit_event_at(v.visit_date, v.visit_time))
      filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'),
    min(public.warehouse_visit_event_at(v.visit_date, v.visit_time))
      filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'return'),
    coalesce(bool_or(public.warehouse_visit_event_at(v.visit_date, v.visit_time) is null)
      filter (where public.warehouse_effective_operation(v.operation, vo.operation) = 'issue'), false)
  into v_issue_count, v_return_count, v_first_issue_at, v_first_return_at, v_issue_has_undated
  from public.visit_orders vo
  join public.visits v on v.id = vo.visit_id
  where vo.order_no = v_order_no;
  v_issue_count := coalesce(v_issue_count, 0);
  v_return_count := coalesce(v_return_count, 0);

  select count(*)::integer into v_duplicate_unmatched_count
  from public.visits v
  where v.is_other = true
    and public.warehouse_exact_order_key(v.comment) = public.warehouse_exact_order_key(v_order_no);

  if (v_operation = 'issue' and v_issue_count > 0)
     or (v_operation = 'return' and v_return_count > 0) then
    raise exception 'Order % already has a linked % operation', v_order_no, v_operation;
  end if;

  if v_duplicate_unmatched_count > 1 and not v_confirm_duplicate then
    raise exception 'Duplicate confirmation is required for order %', v_order_no;
  end if;

  if v_operation = 'issue' then
    v_mode := case when v_issue_count > 0 then 'duplicate_existing_operation' else 'link' end;
    if v_first_return_at is not null and v_visit_at > v_first_return_at then
      raise exception 'Order % issue cannot be recorded after return', v_order_no;
    end if;
  else
    v_mode := case
      when v_return_count > 0 then 'duplicate_existing_operation'
      when v_issue_count = 0 then 'seed_issue_and_link_return'
      else 'link'
    end;
    if v_issue_count > 0 and not v_issue_has_undated
       and (v_first_issue_at is null or v_first_issue_at > v_visit_at) then
      raise exception 'Order % cannot be returned before issue', v_order_no;
    end if;

    if v_issue_count = 0 then
      v_baseline_date := nullif(p_payload->>'baselineIssueDate', '')::date;
      v_baseline_time := nullif(p_payload->>'baselineIssueTime', '');
      if v_baseline_date is null or v_baseline_time is null then
        raise exception 'baselineIssueDate and baselineIssueTime are required';
      end if;
      if v_baseline_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'baselineIssueTime must be HH:MM';
      end if;
      v_baseline_at := public.warehouse_visit_event_at(v_baseline_date, v_baseline_time);
      if v_baseline_at > v_visit_at
         or (v_first_return_at is not null and v_baseline_at > v_first_return_at) then
        raise exception 'Historical issue must not be later than return';
      end if;

      insert into public.visits(
        shift_id, worker, visitor, operation, visit_date, visit_time,
        is_night, is_other, comment, entered_at, client_event_id,
        is_correction, correction_reason, correction_actor, corrected_at
      ) values (
        null, 'Система', null, 'issue', v_baseline_date, v_baseline_time,
        (v_baseline_time::time >= time '22:00' or v_baseline_time::time < time '09:00'),
        false, v_reason, clock_timestamp(),
        'manager-correction-baseline:' || v_visit_id::text || ':' || md5(v_order_no),
        true, v_reason, v_actor, clock_timestamp()
      )
      on conflict (client_event_id) where client_event_id is not null do update
        set correction_reason = excluded.correction_reason,
            correction_actor = excluded.correction_actor,
            corrected_at = excluded.corrected_at
      returning id into v_baseline_visit_id;

      insert into public.visit_orders(
        visit_id, order_no, operation, client_snapshot,
        return_date_snapshot, delivery_snapshot
      ) values (
        v_baseline_visit_id, v_order_no, 'issue', coalesce(v_order.client, ''),
        v_order.return_date,
        case when coalesce(v_order.delivery_worker, '') <> '' then 'Наша доставка' else 'Самовывоз' end
      ) on conflict (visit_id, order_no) where order_no is not null do nothing;
    end if;
  end if;

  insert into public.visit_orders(
    visit_id, order_no, operation, client_snapshot,
    return_date_snapshot, delivery_snapshot
  ) values (
    v_visit_id, v_order_no, v_operation, coalesce(v_order.client, ''),
    v_order.return_date,
    case when coalesce(v_order.delivery_worker, '') <> '' then 'Наша доставка' else 'Самовывоз' end
  ) on conflict (visit_id, order_no) where order_no is not null do update
    set operation = excluded.operation,
        client_snapshot = excluded.client_snapshot,
        return_date_snapshot = excluded.return_date_snapshot,
        delivery_snapshot = excluded.delivery_snapshot;

  select count(*) into v_unresolved
  from public.visit_orders
  where visit_id = v_visit_id and order_no is not null and operation is null;

  update public.visits
  set is_other = (v_unresolved > 0),
      is_correction = true,
      correction_reason = v_reason,
      correction_actor = v_actor,
      corrected_at = clock_timestamp()
  where id = v_visit_id;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'visitId', v_visit_id,
    'orderId', v_order_no,
    'operation', v_operation,
    'linked', true,
    'baselineCreated', v_baseline_visit_id is not null,
    'baselineVisitId', v_baseline_visit_id,
    'correctionMode', v_mode
  );
end;
$$;

commit;
