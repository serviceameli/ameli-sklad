-- Remove only the reset-epoch call inserted by the matching migration.

begin;

do $remove_epoch_guard$
declare
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
  v_pattern constant text := E'\n[[:space:]]*perform public\\.warehouse_assert_data_epoch\\(p_payload\\);\n';
begin
  foreach v_signature in array array[
    'public.record_warehouse_visit(jsonb)'::regprocedure,
    'public.save_warehouse_draft(jsonb)'::regprocedure,
    'public.close_warehouse_shift(jsonb)'::regprocedure
  ]
  loop
    select pg_get_functiondef(v_signature) into v_definition;
    if v_definition !~* v_pattern then
      raise exception 'Epoch guard rollback preflight failed for %', v_signature;
    end if;
    v_rewritten := regexp_replace(v_definition, v_pattern, E'\n', 'i');
    if v_rewritten = v_definition then
      raise exception 'Epoch guard rollback could not patch function % safely', v_signature;
    end if;
    execute v_rewritten;
  end loop;
end
$remove_epoch_guard$;

drop function public.warehouse_assert_data_epoch(jsonb);

commit;
