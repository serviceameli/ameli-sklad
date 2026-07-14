-- Generated from the 2026-07-13 read-only dry-run backup.
-- Every UUID below is an exact technical retry: same shift, worker, visitor,
-- operation, visit date/time, order links and comment. The canonical earliest
-- row is retained. For Shponkina 26-A-001585, the three shadow "other" rows
-- are removed because a linked canonical return exists in the same shift.
-- Ambiguous historical "both" visits are intentionally untouched.

do $$
declare
  v_deleted integer;
begin
  with candidate_ids(id) as (
    select unnest(array[
  '05dee71c-fd72-4dfd-988c-fad6d7557905'::uuid,
  '0f5ab985-83f3-40b0-9f23-14b1c53ac78a'::uuid,
  '0f79cf1a-cc79-414f-8756-b9dc3f9acab3'::uuid,
  '1ad323d3-9c26-400b-9082-b2138dbfcc86'::uuid,
  '1f5b92fd-a550-4f0e-9f0a-73502f68e2b6'::uuid,
  '250bdf96-c355-40ce-a653-be29e9fd5e8a'::uuid,
  '2744cf85-95dc-4942-8f82-d9eef70a834f'::uuid,
  '27e9ccbb-eab4-4870-b506-93377cb25a99'::uuid,
  '2a9b9ced-bf70-4d04-99c5-023fdc1411cf'::uuid,
  '2cc8a050-e162-4a51-8fc0-af4f3cb9b661'::uuid,
  '2e100770-ca21-4a04-be3e-91d35000bf3b'::uuid,
  '2f070cd1-cf78-43b1-8721-1671828c2d76'::uuid,
  '356853af-0988-47be-bc87-73e18226d3f4'::uuid,
  '3bd7c864-5ee0-434b-b217-9f231b35c0e2'::uuid,
  '3d97fa16-bf8d-444f-a886-3dccb541798d'::uuid,
  '41d66329-7c52-41c6-8119-3a7eb161e341'::uuid,
  '43857a7c-417f-4f2a-8935-c4af34489592'::uuid,
  '4ad9b42e-4a43-415b-93a5-023269f0ae4a'::uuid,
  '5245533a-c689-416c-9536-095422bd58d5'::uuid,
  '5254b350-1117-406c-ad8f-f5299c298a5e'::uuid,
  '60e5671a-4fa8-48de-9ba2-86669686df87'::uuid,
  '617f9de3-52f3-4065-a9b5-93e34a401dcb'::uuid,
  '67c311c4-354a-4c17-b11b-38b554c78c0a'::uuid,
  '7001a949-262b-4d6a-a156-3b13f3bdf895'::uuid,
  '82555193-ca8e-48d6-8f43-caec7c617700'::uuid,
  '8462fb48-405d-41a5-a2ea-f5927aa015b0'::uuid,
  '8a02f040-ed93-40be-9335-81dbeca4eb80'::uuid,
  '8ac8ae39-cea8-45f3-9ed3-ba245b8e36e1'::uuid,
  '8bfc2be8-5ff5-41cf-946b-85b62139d0de'::uuid,
  '8da38df4-657f-4d66-b66d-c55865f2ecc0'::uuid,
  '8f953936-6ed7-4c21-899d-c8a6991338dd'::uuid,
  '94089cf5-03c1-4790-8180-289272dd208d'::uuid,
  '972054d9-a8e0-430c-8296-c8fac2d89c13'::uuid,
  '9d7bbc20-c7b1-4239-b649-6078fd05ce91'::uuid,
  '9e223ae9-bae2-4017-9133-306c33903226'::uuid,
  '9f6fba44-18d8-4c03-89fc-3517d5ce5f3c'::uuid,
  'a13f82e5-aa4b-487d-aa6a-00d51be66de3'::uuid,
  'a7e173be-1543-4aac-8489-4157e54372db'::uuid,
  'b4d40133-1b1f-4aca-83ae-ca9603c7ceb0'::uuid,
  'b711779c-2d52-44fe-b8a9-1594487ea128'::uuid,
  'b73f3e3e-d0c2-49e9-8433-5c6b17e60919'::uuid,
  'b8292cf6-9f21-45d7-b75c-6f200d0165f3'::uuid,
  'bd3fcbfb-9fff-4846-ba2e-dbc956a09d96'::uuid,
  'bf489af2-655c-4c73-b96f-83df42c19074'::uuid,
  'c9a44769-b76e-473e-a6b8-a1995fef00ec'::uuid,
  'ca490b73-fba9-408d-8247-4aa97267f1cf'::uuid,
  'd641370c-441b-4fa8-8b82-d992a3d905bd'::uuid,
  'ddbe6b63-0c3d-407b-8681-fe31170e32c4'::uuid,
  'e7f93d64-70c2-4c68-b20f-46f8576df2f8'::uuid,
  'ec36b738-2db7-4a79-bf28-2f0791d201ca'::uuid,
  'ef8a2db1-6014-41a5-af41-48d8594673cc'::uuid,
      'f1de48d2-da2c-41b0-bbf8-67713d3ca479'::uuid
    ])
  ),
  safe_exact as (
    select candidate.id
    from candidate_ids candidate
    join public.visits v on v.id = candidate.id
    where v.client_event_id is null
      and exists (
        select 1
        from public.visits keep
        where keep.id <> v.id
          and not exists (select 1 from candidate_ids c2 where c2.id = keep.id)
          and keep.entered_at <= v.entered_at
          and keep.shift_id is not distinct from v.shift_id
          and keep.worker is not distinct from v.worker
          and keep.visitor is not distinct from v.visitor
          and keep.operation is not distinct from v.operation
          and keep.visit_date is not distinct from v.visit_date
          and keep.visit_time is not distinct from v.visit_time
          and coalesce(keep.comment, '') = coalesce(v.comment, '')
          and (
            select coalesce(array_agg(
              coalesce(vo.order_no, '') || '|' || coalesce(vo.operation, '') || '|' ||
              coalesce(vo.client_snapshot, '') || '|' || coalesce(vo.return_date_snapshot::text, '') || '|' ||
              coalesce(vo.delivery_snapshot, '') order by vo.order_no nulls first, vo.id
            ), array[]::text[])
            from public.visit_orders vo where vo.visit_id = keep.id
          ) = (
            select coalesce(array_agg(
              coalesce(vo.order_no, '') || '|' || coalesce(vo.operation, '') || '|' ||
              coalesce(vo.client_snapshot, '') || '|' || coalesce(vo.return_date_snapshot::text, '') || '|' ||
              coalesce(vo.delivery_snapshot, '') order by vo.order_no nulls first, vo.id
            ), array[]::text[])
            from public.visit_orders vo where vo.visit_id = v.id
          )
      )
  ),
  safe_shadow as (
    select candidate.id
    from candidate_ids candidate
    join public.visits v on v.id = candidate.id
    where v.client_event_id is null
      and v.is_other
      and exists (
        select 1
        from public.visits keep
        where not keep.is_other
          and keep.shift_id is not distinct from v.shift_id
          and keep.worker is not distinct from v.worker
          and keep.visitor is not distinct from v.visitor
          and keep.operation is not distinct from v.operation
          and keep.visit_date is not distinct from v.visit_date
          and keep.visit_time is not distinct from v.visit_time
          and coalesce(keep.comment, '') = coalesce(v.comment, '')
          and exists (
            select 1 from public.visit_orders vo
            where vo.visit_id = keep.id and vo.order_no is not null
          )
      )
  ),
  safe_ids as (
    select id from safe_exact
    union
    select id from safe_shadow
  )
  delete from public.visits v
  using safe_ids safe
  where v.id = safe.id;

  get diagnostics v_deleted = row_count;
  raise notice 'Deleted % confirmed retry visits; changed candidates were left untouched', v_deleted;
  if v_deleted not in (0, 52) then
    raise exception 'Expected 52 unchanged candidates (or 0 on rerun), got %. Cleanup rolled back for review.', v_deleted;
  end if;
end
$$;
