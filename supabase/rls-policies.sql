-- ═══════════════════════════════════════════════════════════════
--  AMELI RENTAL — СКЛАД: политики доступа (RLS)
--  В этом проекте Supabase RLS включён по умолчанию, поэтому без политик
--  блокируется и запись, и (при наличии данных) чтение.
--  Этот сниппет открывает доступ публичному ключу (anon) — достаточно
--  для внутреннего инструмента на этапе теста и запуска.
--  Вставить в Supabase → SQL Editor → Run. Идемпотентно.
--  Позже можно ужесточить (вход по логину) — структуру менять не придётся.
-- ═══════════════════════════════════════════════════════════════

-- На всякий случай убеждаемся, что RLS включён (если был выключен — не повредит)
alter table orders       enable row level security;
alter table workers      enable row level security;
alter table shifts       enable row level security;
alter table visits       enable row level security;
alter table visit_orders enable row level security;
alter table drafts       enable row level security;

-- Полный доступ для публичного ключа (anon) и авторизованных
do $$
declare t text;
begin
  foreach t in array array['orders','workers','shifts','visits','visit_orders','drafts']
  loop
    execute format('drop policy if exists %I on %I', 'anon_all_'||t, t);
    execute format(
      'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
      'anon_all_'||t, t
    );
  end loop;
end $$;
