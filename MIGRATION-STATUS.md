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

## ✅ Страница кладовщика — тестовый дубль (17 июня 2026, сессия 3)

- **workers** перенесены в Supabase (7 кладовщиков).
- **api.js** расширен write-методами: `getData`, `addVisit`, `deleteVisit`, `saveDraft`, `clearDraft`, `closeShift`.
- **`test/warehouse-staff.html`** создан — копия боевой страницы, все `fetch(SCRIPT_URL)` заменены на `WHApi.*`.
- Проверено в браузере: welcome-экран, загрузка заказов из Supabase, открытие смены, `addVisit` записывает в БД (визит появился, счётчик обновился), удаление работает.

Публичный URL: `https://serviceameli.github.io/ameli-sklad/test/warehouse-staff.html?worker=Имя+Фамилия`

## ✅ Боевые страницы переключены на Supabase (17 июня 2026, сессия 4)

- **`api.js`**: реализованы `getUnmatched` и `linkVisit` (вкладка «Сверка» дашборда полностью на Supabase).
- **`warehouse-dashboard.html`**: `confirmLink` переведён с прямого `fetch(SCRIPT_URL)` на `WHApi.linkVisit`.
- **`config.js`**: `SCRIPT_URL = 'YOUR_SCRIPT_URL'` — боевые страницы теперь читают/пишут через `api.js` → Supabase.
- Проверено локально: дашборд показывает реальные заказы, страница кладовщика загружает данные.

## Следующий шаг

**Миграция завершена.** Оба инстанса (кладовщик + дашборд) работают на Supabase. Опциональные доработки:
- Убрать `test/` папку с дублями страниц (теперь боевые = тестовые).
- Убрать Apps Script логику `google-apps-script.js` или оставить как архив.
- Настроить автосинхронизацию заказов (Apps Script `syncOrdersOnce` → триггер раз в день).

## Мелкие хвосты
- Кэш браузера: если страница показывает старые данные — Cmd+Shift+R.

## Файлы проекта (новые)
`migration-plan-supabase.md`, `api.js`, `config.js` (обновлён), `supabase/supabase-schema.sql`, `supabase/rls-policies.sql`, `supabase/apps-script-sync.js`, `supabase/apps-script-sync-quick.js`, `test/supabase-test.html`, `test/warehouse-dashboard.html`.
