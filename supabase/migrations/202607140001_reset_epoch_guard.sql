-- Reject writes from warehouse tabs that were opened before the full reset.
-- This is a data-version barrier only; it does not change RLS or authorization.

begin;

create or replace function public.warehouse_assert_data_epoch(p_payload jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if coalesce(nullif(trim(p_payload->>'dataEpoch'), ''), '')
       <> '2026-07-14-full-reset-v1' then
    raise exception 'Страница склада устарела. Закройте её и откройте ссылку заново.'
      using errcode = 'P0001';
  end if;
end
$$;

do $install_epoch_guard$
declare
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
  v_call constant text := 'perform public.warehouse_assert_data_epoch(p_payload);';
begin
  foreach v_signature in array array[
    'public.record_warehouse_visit(jsonb)'::regprocedure,
    'public.save_warehouse_draft(jsonb)'::regprocedure,
    'public.close_warehouse_shift(jsonb)'::regprocedure
  ]
  loop
    select pg_get_functiondef(v_signature) into v_definition;
    if v_definition is null then
      raise exception 'Epoch guard preflight failed: function % not found', v_signature;
    end if;
    if position(v_call in lower(v_definition)) > 0 then
      continue;
    end if;

    v_rewritten := regexp_replace(
      v_definition,
      E'\nbegin\n',
      E'\nbegin\n  perform public.warehouse_assert_data_epoch(p_payload);\n'
    );
    if v_rewritten = v_definition
       or position(v_call in lower(v_rewritten)) = 0 then
      raise exception 'Epoch guard could not patch function % safely', v_signature;
    end if;
    execute v_rewritten;
  end loop;
end
$install_epoch_guard$;

do $verify_epoch_guard$
declare
  v_signature regprocedure;
  v_definition text;
  v_call constant text := 'perform public.warehouse_assert_data_epoch(p_payload);';
begin
  foreach v_signature in array array[
    'public.record_warehouse_visit(jsonb)'::regprocedure,
    'public.save_warehouse_draft(jsonb)'::regprocedure,
    'public.close_warehouse_shift(jsonb)'::regprocedure
  ]
  loop
    select lower(pg_get_functiondef(v_signature)) into v_definition;
    if position(v_call in v_definition) = 0 then
      raise exception 'Epoch guard verification failed for %', v_signature;
    end if;
  end loop;
end
$verify_epoch_guard$;

commit;
