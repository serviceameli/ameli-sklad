-- ═══════════════════════════════════════════════════════════════
--  AMELI RENTAL — СКЛАД: схема базы данных Supabase
--  Вставить целиком в Supabase → SQL Editor → Run.
--  Идемпотентно: можно прогонять повторно (drop ... if exists).
-- ═══════════════════════════════════════════════════════════════

-- ── ЗАКАЗЫ ──────────────────────────────────────────────────────
-- Заливаются из Google-таблицы «заказы» скриптом синхронизации, в одну сторону.
-- Источник истины — сайт/таблица. Склад их только читает.
create table if not exists orders (
  order_no        text primary key,        -- номер заказа (кол. 0 в листе)
  client          text,                     -- клиент (кол. 16)
  company         text,                     -- компания (кол. 18)
  issue_date      date,                      -- дата выдачи (кол. 2)
  issue_time      text,                      -- время выдачи как в таблице (кол. 3)
  return_date     date,                      -- дата возврата (кол. 4)
  return_time     text,                      -- время возврата (кол. 5)
  delivery_worker text,                      -- работник доставки (кол. 19); пусто → самовывоз
  site_status     text,                      -- статус сайта (кол. G) — ТОЛЬКО для менеджеров, склад не читает
  raw             jsonb,                     -- полная строка на всякий случай
  synced_at       timestamptz default now()
);

create index if not exists orders_issue_date_idx  on orders (issue_date);
create index if not exists orders_return_date_idx on orders (return_date);

-- ── КЛАДОВЩИКИ ─────────────────────────────────────────────────
create table if not exists workers (
  name   text primary key,
  pin    text,
  link   text,
  active boolean default true
);

-- ── СМЕНЫ ──────────────────────────────────────────────────────
create table if not exists shifts (
  id         uuid primary key default gen_random_uuid(),
  worker     text,                            -- имя кладовщика (просто текст, без FK — история может содержать уволенных)
  shift_date date,
  start_at   timestamptz,
  end_at     timestamptz,
  is_night   boolean
);

create index if not exists shifts_worker_idx on shifts (worker);
create index if not exists shifts_date_idx   on shifts (shift_date);

-- ── ВИЗИТЫ ─────────────────────────────────────────────────────
-- ОДНА запись на визит (не на заказ!). Заказы визита — в visit_orders.
create table if not exists visits (
  id         uuid primary key default gen_random_uuid(),
  shift_id   uuid references shifts(id) on delete cascade,
  worker     text,
  visitor    text,                           -- 'client' | 'yandex' | 'our'
  operation  text,                           -- 'issue' | 'return' | 'both'
  visit_date date,                            -- выбранная дата визита (бывш. кол. 19)
  visit_time text,                            -- HH:mm
  is_night   boolean,                         -- считается от visit_time
  is_other   boolean default false,           -- «нет в списке»
  comment    text,
  entered_at timestamptz default now()
);

create index if not exists visits_shift_idx on visits (shift_id);
create index if not exists visits_date_idx  on visits (visit_date);

-- ── ЗАКАЗЫ ВНУТРИ ВИЗИТА (связь визит ↔ заказ) ─────────────────
-- on delete cascade: удалил визит → ушли все его заказы. Багов-сирот нет.
create table if not exists visit_orders (
  id                   uuid primary key default gen_random_uuid(),
  visit_id             uuid references visits(id) on delete cascade,
  order_no             text,                  -- ссылка на orders.order_no (null для «нет в списке»)
  client_snapshot      text,                  -- снимок на момент визита
  return_date_snapshot date,
  delivery_snapshot    text
);

create index if not exists visit_orders_visit_idx on visit_orders (visit_id);
create index if not exists visit_orders_order_idx on visit_orders (order_no);

-- ── ЧЕРНОВИКИ НЕЗАКРЫТЫХ СМЕН ──────────────────────────────────
create table if not exists drafts (
  worker   text primary key,
  data     jsonb,
  saved_at timestamptz default now()
);

-- ── ВЬЮХА СТАТУСОВ ЗАКАЗОВ (замена getProcessedOrderIds) ───────
-- Кто выдан/возвращён и кем — индексированным запросом, без скана всего лога.
drop view if exists order_status;
create view order_status as
select
  vo.order_no,
  bool_or(v.operation in ('issue','both'))  as issued,
  bool_or(v.operation in ('return','both')) as returned,
  max(case when v.operation in ('issue','both')  then v.worker end) as issued_by,
  max(case when v.operation in ('return','both') then v.worker end) as returned_by
from visit_orders vo
join visits v on v.id = vo.visit_id
where vo.order_no is not null
group by vo.order_no;

-- ── ГРАНТЫ ДЛЯ REST/PostgREST ──────────────────────────────────
-- Обязательно для проектов, созданных после 30.05.2026.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant select on order_status to anon, authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
--  RLS (Row Level Security)
--  На время теста оставляем ВЫКЛЮЧЕННЫМ (доступ по anon-ключу).
--  Перед боевым запуском раскомментировать блок ниже, чтобы включить
--  RLS и базовые политики. Сейчас закомментировано намеренно.
-- ═══════════════════════════════════════════════════════════════
-- alter table orders       enable row level security;
-- alter table workers      enable row level security;
-- alter table shifts       enable row level security;
-- alter table visits       enable row level security;
-- alter table visit_orders enable row level security;
-- alter table drafts       enable row level security;
--
-- create policy anon_all_orders       on orders       for all to anon using (true) with check (true);
-- create policy anon_all_workers      on workers      for all to anon using (true) with check (true);
-- create policy anon_all_shifts       on shifts       for all to anon using (true) with check (true);
-- create policy anon_all_visits       on visits       for all to anon using (true) with check (true);
-- create policy anon_all_visit_orders on visit_orders for all to anon using (true) with check (true);
-- create policy anon_all_drafts       on drafts       for all to anon using (true) with check (true);
