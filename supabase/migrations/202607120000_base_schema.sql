-- Structural bootstrap for a new project.
-- Existing production tables are left unchanged; lifecycle changes are in the next migration.
-- Access policies and grants are intentionally out of scope.

create table if not exists public.orders (
  order_no text primary key,
  client text,
  company text,
  issue_date date,
  issue_time text,
  return_date date,
  return_time text,
  delivery_worker text,
  site_status text,
  raw jsonb,
  synced_at timestamptz default now(),
  source_active boolean not null default true,
  source_row_count integer not null default 1,
  source_sync_id text,
  manual_hidden boolean not null default false
);

create table if not exists public.workers (
  name text primary key,
  pin text,
  link text,
  active boolean default true
);

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  worker text,
  shift_date date,
  start_at timestamptz,
  end_at timestamptz,
  is_night boolean,
  client_shift_id text
);

create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid references public.shifts(id) on delete cascade,
  worker text,
  visitor text,
  operation text,
  visit_date date,
  visit_time text,
  is_night boolean,
  is_other boolean default false,
  comment text,
  entered_at timestamptz default now(),
  client_event_id text
);

create table if not exists public.visit_orders (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid references public.visits(id) on delete cascade,
  order_no text,
  client_snapshot text,
  return_date_snapshot date,
  delivery_snapshot text,
  operation text
);

create table if not exists public.drafts (
  worker text primary key,
  data jsonb,
  saved_at timestamptz default now()
);

-- Durable idempotency ledger. A deleted client event remains a tombstone so
-- an old offline retry cannot recreate the visit.
create table if not exists public.warehouse_event_receipts (
  client_event_id text primary key,
  visit_id uuid references public.visits(id) on delete set null,
  status text not null check (status in ('active', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_issue_date_idx on public.orders (issue_date);
create index if not exists orders_return_date_idx on public.orders (return_date);
create index if not exists shifts_worker_idx on public.shifts (worker);
create index if not exists shifts_date_idx on public.shifts (shift_date);
create index if not exists visits_shift_idx on public.visits (shift_id);
create index if not exists visits_date_idx on public.visits (visit_date);
create index if not exists visit_orders_visit_idx on public.visit_orders (visit_id);
create index if not exists visit_orders_order_idx on public.visit_orders (order_no);
