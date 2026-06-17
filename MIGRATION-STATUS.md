# Статус миграции на Supabase — передача в новый чат

> Этот файл — точка передачи контекста. Новый чат должен прочитать его и `migration-plan-supabase.md`, затем продолжить.

Дата: 17 июня 2026.

## Что уже сделано и проверено

- **Supabase проект создан.** URL: `https://xkqaipggklmgussjphkp.supabase.co`. Публичный ключ (publishable) лежит в `config.js` (`SUPABASE_URL`, `SUPABASE_KEY`).
- **Схема применена** (SQL Editor): таблицы `orders`, `workers`, `shifts`, `visits`, `visit_orders`, `drafts` + вьюха `order_status`. Файл: `supabase/supabase-schema.sql`.
- **RLS-политики применены** (`supabase/rls-policies.sql`) — публичный ключ имеет полный доступ (этап теста).
- **Внешние ключи `shifts.worker` и `drafts.worker` удалены** (мешали переносу истории). Схема-файл уже поправлен.
- **Заказы синхронизированы** Google-таблица → `orders`: 83 из 83, проверено. В Apps Script (проект привязан к таблице, файл `sync.gs`) есть функция `syncOrdersOnce()`.
- **Слой данных `api.js`** написан — отдаёт дашборду формат `{shifts, orders, processedOrders}` из Supabase.
- **Дубль дашборда** `test/warehouse-dashboard.html` работает на реальных заказах. Опубликован на GitHub Pages: `https://serviceameli.github.io/ameli-sklad/test/warehouse-dashboard.html` (коммит `aa6f024`). Боевые страницы не тронуты.

## ✅ Перенос истории завершён (17 июня 2026, сессия 2)

`migrateHistory()` запущена в Apps Script (`sync.gs`). Журнал выполнения:
```
Перенесено — смен: 54, визитов: 134, заказов в визитах: 125
```

Проверено через REST API Supabase:
- `shifts`: 54
- `visits`: 134  
- `visit_orders`: 125

Тестовый дашборд `https://serviceameli.github.io/ameli-sklad/test/warehouse-dashboard.html` — все вкладки живые: Заказы сегодня, Статистика (134 визита / 125 заказов / 6 кладовщиков), Кладовщики с карточками.

## Следующий шаг

## Мелкие хвосты
- Перенести `workers` (лист `workers` → таблица `workers` в Supabase) — нужно для страницы кладовщика.
- Кэш браузера на `config.js`: если дубль показывает нули — жёсткое обновление Cmd+Shift+R.

## Дальнейшие шаги по плану (после истории)
- Перенести `workers` (лист → таблица `workers`) — нужно для страницы кладовщика.
- Собрать дубль страницы кладовщика `test/warehouse-staff.html` на `api.js` (чтение + запись визитов/смен/черновиков в Supabase).
- Реализовать запись в `api.js` (addVisit/closeShift/saveDraft/deleteVisit/linkVisit) и `getUnmatched`.
- Сверка → бесшовное переключение боевых страниц (флаг бэкенда) → чистка.

## Файлы проекта (новые)
`migration-plan-supabase.md`, `api.js`, `config.js` (обновлён), `supabase/supabase-schema.sql`, `supabase/rls-policies.sql`, `supabase/apps-script-sync.js`, `supabase/apps-script-sync-quick.js`, `test/supabase-test.html`, `test/warehouse-dashboard.html`.
