# План миграции склада на Supabase

> Цель: перенести хранение данных с Google Sheets на нормальную базу (Supabase / PostgreSQL),
> сохранив привычный процесс менеджера (заказы по-прежнему уходят в Google-таблицу) и сделав
> переход поэтапным — так, чтобы на каждом шаге была рабочая система и быстрый откат.

Дата составления: 17 июня 2026.
Статус: план, к реализации не приступали.

---

## 1. Зачем переезжаем

Сейчас Google Sheets используется как база данных, и почти все проблемы с «кривой записью» —
это следствие именно этого, а не случайные баги (полный разбор — в `code-review-2026-06-10.md`):

| Проблема сейчас | Причина (Sheets) | Что в нормальной БД |
|---|---|---|
| Даты ломаются на границе месяца | Сравнение строк `dd.MM.yyyy` | Тип `date`, сравнение корректно всегда |
| После удаления визита остаются «сироты» | Один визит = несколько строк | Одна запись `visit` + каскадное удаление связей |
| Гонки при одновременной записи | Удаление по номеру строки `deleteRow(i)` | Удаление по первичному ключу, транзакции |
| Зоопарк `parseDate / dateKey / toISOString` | Sheets сам конвертирует типы | Типы фиксированы схемой |
| Скан всего лога каждые 15 сек, упор в квоты | Нет индексов и запросов | Индексированные запросы / SQL-вьюхи |

Примерно 80% кода `google-apps-script.js` — это обход ограничений Sheets. После миграции он исчезает.

---

## 2. Архитектура после миграции

```
                    (без изменений для менеджера)
   Сайт ──экспорт──▶ Google-таблица «заказы» ──┐
                                               │ синхронизация (только заказы, в одну сторону)
                                               ▼
                                    ┌──────────────────────┐
   Кладовщик (телефон) ────────────▶│      SUPABASE         │
   Дашборд руководителя ───────────▶│  (PostgreSQL + API)   │
                                    └──────────────────────┘
```

Ключевые принципы:

1. **Менеджер ничего не замечает.** Он по-прежнему льёт актуальные заказы в Google-таблицу.
2. **Синхронизация строго в одну сторону:** таблица → Supabase, и только для заказов.
   Складские данные (визиты, смены, черновики) живут **только в Supabase** и никогда не уезжают обратно в Sheets.
   Именно двусторонний обмен и превращение таблицы в «базу» сейчас и даёт кашу.
3. **Заказы синхронизируются автоматически 1–2 раза в день** + кнопка «Синхронизировать» в дашборде для ручного запуска.
4. **Apps Script остаётся, но усыхает до одной задачи** — читать лист «заказы» и заливать его в Supabase. Всё остальное (визиты, смены, статусы, просрочка) — на стороне БД и фронтенда.

---

## 3. Выбор и аккаунт Supabase

- Тариф: **Free** — для склада хватит с запасом (500 МБ БД ≈ миллионы строк, 2 проекта, 50k активных пользователей).
- **Важно про «засыпание»:** бесплатный проект ставится на паузу после **7 дней без запросов**. У нас склад работает ежедневно + синк 1–2 раза в день — проект не уснёт. Если вдруг простой (праздники) — разбудить можно вручную из панели Supabase.
- **Важно про новые проекты (после 30 мая 2026):** для доступа к данным через REST (PostgREST) нужно явно прописать Postgres-гранты. Это разовая настройка, см. SQL в разделе 4.4.
- Клиент на фронтенде: **supabase-js** через CDN (проще, есть realtime) либо обычный `fetch` к REST. Рекомендация — supabase-js.

---

## 4. Схема базы данных

Идея: визит хранится **одной записью**, а его заказы — в отдельной связанной таблице. Это убирает
главный источник кривой записи (визит-в-несколько-строк) и даёт каскадное удаление.

### 4.1. Таблицы

```sql
-- Заказы. Заливаются из Google-таблицы, в одну сторону. Источник истины — сайт/таблица.
create table orders (
  order_no     text primary key,          -- номер заказа (кол. 0 в листе)
  client       text,                       -- клиент (кол. 16)
  company      text,                       -- компания (кол. 18)
  issue_date   date,                        -- дата выдачи (кол. 2)
  issue_time   text,                        -- время выдачи, как в таблице (кол. 3)
  return_date  date,                        -- дата возврата (кол. 4)
  return_time  text,                        -- время возврата (кол. 5)
  delivery_worker text,                     -- работник доставки (кол. 19); пусто → самовывоз
  site_status  text,                        -- статус сайта (кол. 6/G) — ТОЛЬКО для менеджеров, склад не читает
  raw          jsonb,                       -- полная строка на всякий случай
  synced_at    timestamptz default now()
);

-- Кладовщики (бывший лист workers)
create table workers (
  name    text primary key,
  pin     text,
  link    text,
  active  boolean default true
);

-- Смены
create table shifts (
  id         uuid primary key default gen_random_uuid(),
  worker     text references workers(name),
  shift_date date,
  start_at   timestamptz,
  end_at     timestamptz,
  is_night   boolean
);

-- Визиты: ОДНА запись на визит (не на заказ!)
create table visits (
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

-- Заказы внутри визита: связь визит ↔ заказ
create table visit_orders (
  id         uuid primary key default gen_random_uuid(),
  visit_id   uuid references visits(id) on delete cascade,  -- ← удалил визит = ушли все его заказы
  order_no   text,                            -- ссылка на orders.order_no (может быть null для «нет в списке»)
  -- снимки на момент визита (заказ в orders мог измениться/удалиться):
  client_snapshot      text,
  return_date_snapshot date,
  delivery_snapshot    text
);

-- Черновики незакрытых смен
create table drafts (
  worker   text primary key references workers(name),
  data     jsonb,
  saved_at timestamptz default now()
);
```

### 4.2. Что это решает

- **`on delete cascade` на `visit_orders`** — удаление визита одним запросом убирает все его заказы. Багов-сирот больше нет.
- **`date`-типы** — сравнения дат корректны, костыли `parseDate/dateKey` не нужны.
- **Первичные ключи** — удаление/обновление по `id`, без подсчёта номеров строк и гонок.
- **Снимки в `visit_orders`** — даже если заказ изменится в `orders`, история визита не поедет.

### 4.3. Вьюха статусов (замена `getProcessedOrderIds`)

Вместо скана всего лога — индексированный запрос:

```sql
create view order_status as
select
  vo.order_no,
  bool_or(v.operation in ('issue','both')) as issued,
  bool_or(v.operation in ('return','both')) as returned,
  max(case when v.operation in ('issue','both') then v.worker end) as issued_by,
  max(case when v.operation in ('return','both') then v.worker end) as returned_by
from visit_orders vo
join visits v on v.id = vo.visit_id
where vo.order_no is not null
group by vo.order_no;
```

Фронтенд берёт `issued/returned` отсюда — быстро, без квот Apps Script.

### 4.4. Гранты для REST (разовая настройка, проект создан после 30.05.2026)

```sql
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant select on order_status to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
```

### 4.5. Безопасность (RLS)

Фронтенд лежит на GitHub Pages — он публичный, поэтому в него попадает только **anon-ключ** (не service_role).
Включаем Row Level Security и политики под нужные операции. `service_role`-ключ хранится **только в Apps Script**
(в Script Properties), на клиент не попадает. Для небольшого внутреннего инструмента это достаточный уровень;
при желании позже можно добавить вход по логину.

---

## 5. Синхронизация заказов Sheets → Supabase

### 5.1. Логика

Apps Script читает лист «заказы», превращает строки в объекты и делает **upsert** в таблицу `orders`
по `order_no`. Upsert = «обнови, если есть; добавь, если нет» — повторный экспорт не плодит дубли, а обновляет заказ.

```javascript
// Apps Script — единственная оставшаяся задача
const SUPABASE_URL = 'https://<project>.supabase.co';
// service_role-ключ хранить в PropertiesService, НЕ в коде в открытом виде
const SERVICE_KEY = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY');

function syncOrders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('заказы');
  if (!sheet || sheet.getLastRow() < 2) return { synced: 0 };

  const tz = 'Europe/Moscow';
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 20).getValues();
  const rows = data.filter(r => r[0]).map(r => ({
    order_no:        r[0].toString().trim(),
    client:          r[16] ? r[16].toString().trim() : '',
    company:         r[18] ? r[18].toString().trim() : '',
    issue_date:      r[2] ? Utilities.formatDate(parseDate(r[2]),  tz, 'yyyy-MM-dd') : null,
    issue_time:      r[3] ? r[3].toString().trim() : '',
    return_date:     r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'yyyy-MM-dd') : null,
    return_time:     r[5] ? r[5].toString().trim() : '',
    delivery_worker: r[19] ? r[19].toString().trim() : '',
    site_status:     r[6] ? r[6].toString().trim() : '',
    synced_at:       new Date().toISOString()
  }));

  // Upsert батчем через REST PostgREST
  const resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/orders?on_conflict=order_no', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  return { synced: rows.length, code: resp.getResponseCode() };
}
```

`parseDate()` остаётся из текущего скрипта.

### 5.2. Расписание (1–2 раза в день)

Триггер по времени, как уже сделано для просрочки:

```javascript
function setupSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncOrders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  // Например, в 08:00 и 14:00 МСК
  ScriptApp.newTrigger('syncOrders').timeBased().atHour(8).everyDays(1).inTimezone('Europe/Moscow').create();
  ScriptApp.newTrigger('syncOrders').timeBased().atHour(14).everyDays(1).inTimezone('Europe/Moscow').create();
}
```

### 5.3. Кнопка «Синхронизировать» в дашборде

Apps Script публикует веб-доступ (как сейчас), но теперь обрабатывает лишь один экшен:

```javascript
function doGet(e) {
  if ((e.parameter.action || '') === 'syncOrders') {
    return ContentService
      .createTextOutput(JSON.stringify(syncOrders()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

В `warehouse-dashboard.html` добавляется кнопка, которая дёргает `SCRIPT_URL + '?action=syncOrders'`,
показывает «Синхронизировано: N заказов» и перезагружает данные из Supabase.

> Альтернатива без Apps Script — связки Make/Zapier/n8n или фоновая задача на стороне Supabase,
> но раз скрипт уже написан, это самый простой и бесплатный путь.

---

## 6. Изменения во фронтенде

Чтобы переход был безопасным, всю работу с данными выносим в **один слой** — новый файл `api.js`.
Сейчас обращения к `SCRIPT_URL` разбросаны по обоим HTML (видно по `fetch(SCRIPT_URL...)`).
Соберём их за единым интерфейсом — тогда смена бэкенда происходит в одном месте, а не правкой десятков мест.

```javascript
// api.js — единая точка доступа к данным
const BACKEND = 'apps_script';   // 'apps_script' | 'supabase' — переключатель для безопасного перехода

const Api = {
  getData(worker)        { /* ... */ },   // заказы дня + статусы + черновик
  getAll()               { /* ... */ },   // для дашборда: смены + заказы
  addVisit(visit)        { /* ... */ },
  deleteVisit(key)       { /* ... */ },
  closeShift(shift)      { /* ... */ },
  saveDraft(draft)       { /* ... */ },
  getUnmatched()         { /* ... */ },
  linkVisit(key, ids)    { /* ... */ },
};
```

Внутри каждого метода — ветка по `BACKEND`. Вся бизнес-логика статусов
(`getEffectiveOrderType`, «к выдаче / к возврату / просрочка», sameDay) **сохраняется как есть** —
меняется только, откуда берутся и куда пишутся данные.

Преимущества записи через Supabase напрямую:
- запись подтверждается (сейчас POST идут `no-cors` fire-and-forget — визит может молча потеряться);
- можно включить **realtime**: дашборд и страница заказов обновляются сами, без опроса каждые 15 сек.

---

## 7. Перенос истории из лога

Лист `log` (19 колонок) разово конвертируется в `shifts` + `visits` + `visit_orders` скриптом:
группируем строки по `shiftStart+worker` → смены; по `время+timeAuto+посетитель+операция` → визиты;
каждая строка с заказом → запись в `visit_orders`. Логика группировки уже есть в `getAllShifts()` — берём её за основу.

Решение по объёму истории — см. открытые вопросы (всё переносить или начать с чистого листа).

---

## 8. Поэтапный план — чтобы ничего не сломалось

Главный принцип: **старая система (Sheets + Apps Script) остаётся полностью рабочей до самого конца.**
Переключение бэкенда — это флаг `BACKEND` в `api.js`. Откат на любом шаге = вернуть флаг обратно.

| Фаза | Что делаем | Риск для текущей работы | Откат |
|---|---|---|---|
| **0. Подготовка** | Создать проект Supabase, накатить схему (раздел 4), завести ключи | Нет — живой системы не касаемся | — |
| **1. Синк заказов** | Добавить `syncOrders` в Apps Script, прогнать вручную, сверить `orders` с листом | Нет — фронтенд по-прежнему читает из Sheets | Удалить функцию |
| **2. Слой `api.js`** | Завести `api.js`, провести оба HTML через него, флаг = `apps_script` | Поведение идентично текущему | git revert |
| **3. Бэкенд Supabase** | Реализовать ветку `supabase` в `api.js`, перенести историю лога, тестировать на копии | Нет — прод-флаг ещё `apps_script` | — |
| **4. Переключение** | Флаг → `supabase` сначала в дашборде, сверить цифры; затем на странице кладовщика | Появляется только после флага; сразу видно при проверке | Вернуть флаг `apps_script` |
| **5. Чистка** | Оставить в Apps Script только `syncOrders`; лист `log` держать как бэкап ещё N недель | Минимальный | Старый код в git-истории |

Параллельная работа в фазах 1–4: заказы в Supabase уже синкаются, но склад продолжает писать в Sheets,
пока флаг не переключён. Это даёт спокойно сверить данные до перехода.

---

## 9. Кто делает миграцию

Работа — это многофайловые правки + git + локальное тестирование (фазы 2–4).
Это удобно делать в **Claude Code** (правки по нескольким файлам, коммиты, прогон тестов в цикле) —
либо здесь, в этой сессии: инструменты для файлов, bash и git доступны.

Рекомендация: фазы 0–1 (Supabase + синк) можно сделать прямо здесь; фазы 2–4 (хирургия по коду фронтенда)
эффективнее в Claude Code. Финальное решение — за тобой.

После любых правок Apps Script: новый деплой → новый URL → обновить `config.js` (как и сейчас).

---

## 10. Открытые вопросы (с рекомендациями по умолчанию)

1. **Клиент БД:** supabase-js (CDN) или сырой REST? → *рекомендую supabase-js* (чище + realtime).
2. **Realtime или оставить опрос?** → *рекомендую realtime* для дашборда, опрос убрать.
3. **История лога:** переносить всю или начать с чистого листа, оставив Sheets как архив? → *рекомендую перенести всю* (скрипт несложный).
4. **Доступ:** anon-ключ + RLS сейчас, вход по логину — позже? → *рекомендую так*.
5. **Время автосинка:** 08:00 и 14:00 МСК подходят? → *по умолчанию эти два слота*.

---

## 11. Чек-лист готовности к старту

- [ ] Создан проект Supabase, сохранены URL + anon-ключ + service_role-ключ
- [ ] Накатана схема (раздел 4) и гранты (4.4)
- [ ] `syncOrders` залит в Apps Script, service-ключ в Script Properties
- [ ] Ручной прогон `syncOrders` → `orders` совпадает с листом «заказы»
- [ ] Настроены триггеры расписания + кнопка в дашборде
- [ ] `api.js` заведён, оба HTML проведены через него (флаг `apps_script`)
- [ ] Реализована ветка `supabase`, перенесена история
- [ ] Сверка цифр дашборда старый vs новый бэкенд
- [ ] Переключение флага, наблюдение, чистка
