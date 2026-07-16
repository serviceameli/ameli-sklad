-- One-time correction for visit snapshots written while syncOrders read the
-- wrong delivery-worker column. The old value for every row was «Самовывоз»;
-- the exact ids below make the repair and a manual rollback deterministic.

begin;

do $$
declare
  v_unsafe text;
begin
  with fixes(id, order_no, worker) as (values
    ('2aad5dd3-6efa-4d31-b5a4-3399890985dd'::uuid, '26-A-001727', 'Евгений Бец'),
    ('ce41218e-a434-4eed-a4ee-4ac5fd0d03be'::uuid, '26-A-001727', 'Евгений Бец'),
    ('3f800308-93dc-4a36-969c-e30164818889'::uuid, '26-A-001970', 'Ислам Абдуганиев')
  )
  select string_agg(f.id::text, ', ' order by f.id)
  into v_unsafe
  from fixes f
  left join public.visit_orders vo on vo.id = f.id and vo.order_no = f.order_no
  left join public.orders o on o.order_no = f.order_no
  where vo.id is null
     or vo.delivery_snapshot not in ('Самовывоз', 'Наша доставка')
     or o.delivery_worker <> f.worker;

  if v_unsafe is not null then
    raise exception 'Delivery repair stopped; unexpected rows: %', v_unsafe;
  end if;
end
$$;

with fixes(id, order_no) as (values
  ('2aad5dd3-6efa-4d31-b5a4-3399890985dd'::uuid, '26-A-001727'),
  ('ce41218e-a434-4eed-a4ee-4ac5fd0d03be'::uuid, '26-A-001727'),
  ('3f800308-93dc-4a36-969c-e30164818889'::uuid, '26-A-001970')
)
update public.visit_orders vo
set delivery_snapshot = 'Наша доставка'
from fixes f
where vo.id = f.id
  and vo.order_no = f.order_no
  and vo.delivery_snapshot = 'Самовывоз';

do $$
declare
  v_mismatch text;
begin
  with fixes(id) as (values
    ('2aad5dd3-6efa-4d31-b5a4-3399890985dd'::uuid),
    ('ce41218e-a434-4eed-a4ee-4ac5fd0d03be'::uuid),
    ('3f800308-93dc-4a36-969c-e30164818889'::uuid)
  )
  select string_agg(f.id::text, ', ' order by f.id)
  into v_mismatch
  from fixes f
  join public.visit_orders vo using (id)
  where vo.delivery_snapshot <> 'Наша доставка';

  if v_mismatch is not null then
    raise exception 'Delivery repair verification failed for: %', v_mismatch;
  end if;
end
$$;

commit;
