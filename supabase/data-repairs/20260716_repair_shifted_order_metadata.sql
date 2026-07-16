-- One-time repair for nine inactive rows imported from the short-lived export
-- layout where client/company/worker columns had shifted. The original values
-- remain in orders.raw, and this script stores the replaced fields there too.

begin;

do $$
declare
  v_unsafe text;
begin
  with fixes(order_no, bad_client, client, company, delivery_worker) as (values
    ('26-A-000860 (F)', '5.7', 'Анастасия Герден', 'masterskaya flora decora', 'Евгений Бец'),
    ('26-A-001552', '0.2', 'Дарья Нартова', 'Cooperteam.ru @cooper.wedding', ''),
    ('26-A-001955', '5', 'Алина Х', '', 'Ислам Абдуганиев'),
    ('26-A-001967', '0.1', 'Елена Алексеева', 'Flores-studio', ''),
    ('26-A-001992 (F)', '0.1', 'Александра Маслова', 'Студия декора "Сон в летнюю ночь"', ''),
    ('26-A-002029 (F)', '0.2', 'Татьяна Марусова', 'Save the date decor', ''),
    ('26-A-002033', '0.1', 'Анна Эрнандес', 'Shishka Decor', ''),
    ('26-A-002035', '3.6', 'Илья Гинкель', 'ВВ Декор', ''),
    ('26-A-002040', '0.1', 'Ксения Щикинова', 'Cooper Event', '')
  )
  select string_agg(o.order_no, ', ' order by o.order_no)
  into v_unsafe
  from public.orders o
  join fixes f using (order_no)
  where o.client = f.bad_client
    and (o.source_active or exists (
      select 1 from public.visit_orders vo where vo.order_no = o.order_no
    ));

  if v_unsafe is not null then
    raise exception 'Repair stopped: active or processed orders require manual review: %', v_unsafe;
  end if;
end
$$;

with fixes(order_no, bad_client, client, company, delivery_worker) as (values
  ('26-A-000860 (F)', '5.7', 'Анастасия Герден', 'masterskaya flora decora', 'Евгений Бец'),
  ('26-A-001552', '0.2', 'Дарья Нартова', 'Cooperteam.ru @cooper.wedding', ''),
  ('26-A-001955', '5', 'Алина Х', '', 'Ислам Абдуганиев'),
  ('26-A-001967', '0.1', 'Елена Алексеева', 'Flores-studio', ''),
  ('26-A-001992 (F)', '0.1', 'Александра Маслова', 'Студия декора "Сон в летнюю ночь"', ''),
  ('26-A-002029 (F)', '0.2', 'Татьяна Марусова', 'Save the date decor', ''),
  ('26-A-002033', '0.1', 'Анна Эрнандес', 'Shishka Decor', ''),
  ('26-A-002035', '3.6', 'Илья Гинкель', 'ВВ Декор', ''),
  ('26-A-002040', '0.1', 'Ксения Щикинова', 'Cooper Event', '')
)
update public.orders o
set client = f.client,
    company = f.company,
    delivery_worker = f.delivery_worker,
    raw = jsonb_set(
      coalesce(o.raw, '{}'::jsonb),
      '{metadataRepairBackup20260716}',
      jsonb_build_object(
        'client', o.client,
        'company', o.company,
        'delivery_worker', o.delivery_worker,
        'repaired_at', clock_timestamp()
      ),
      true
    )
from fixes f
where o.order_no = f.order_no
  and o.client = f.bad_client
  and not o.source_active
  and not exists (
    select 1 from public.visit_orders vo where vo.order_no = o.order_no
  );

do $$
declare
  v_mismatch text;
begin
  with fixes(order_no, client) as (values
    ('26-A-000860 (F)', 'Анастасия Герден'),
    ('26-A-001552', 'Дарья Нартова'),
    ('26-A-001955', 'Алина Х'),
    ('26-A-001967', 'Елена Алексеева'),
    ('26-A-001992 (F)', 'Александра Маслова'),
    ('26-A-002029 (F)', 'Татьяна Марусова'),
    ('26-A-002033', 'Анна Эрнандес'),
    ('26-A-002035', 'Илья Гинкель'),
    ('26-A-002040', 'Ксения Щикинова')
  )
  select string_agg(o.order_no, ', ' order by o.order_no)
  into v_mismatch
  from public.orders o
  join fixes f using (order_no)
  where o.client <> f.client;

  if v_mismatch is not null then
    raise exception 'Repair verification failed for: %', v_mismatch;
  end if;
end
$$;

commit;
