// ═══════════════════════════════════════════════════════════════
//  AMELI RENTAL — СКЛАД: синхронизация Google Sheets → Supabase
//  Единственная задача оставшегося Apps Script: читать лист «заказы»
//  и заливать его в таблицу orders Supabase (upsert по order_no).
//
//  УСТАНОВКА:
//  1. Открыть проект Apps Script у таблицы заказов.
//  2. Вставить этот код (можно отдельным файлом).
//  3. Project Settings → Script Properties добавить:
//        SUPABASE_URL          = https://<project>.supabase.co
//        SUPABASE_SERVICE_KEY  = <service_role ключ>   (НЕ anon!)
//  4. Запустить один раз setupSyncTrigger() (создаст расписание).
//  5. Deploy → New deployment → Web app → скопировать URL для кнопки в дашборде.
//  ⚠️ service_role-ключ хранится ТОЛЬКО здесь, на клиент не попадает.
// ═══════════════════════════════════════════════════════════════

function _cfg() {
  const p = PropertiesService.getScriptProperties();
  return {
    url: p.getProperty('SUPABASE_URL'),
    key: p.getProperty('SUPABASE_SERVICE_KEY')
  };
}

// ── Основная синхронизация: лист «заказы» → таблица orders (upsert) ──
function syncOrders() {
  const cfg = _cfg();
  if (!cfg.url || !cfg.key) {
    return { ok: false, error: 'Не заданы SUPABASE_URL / SUPABASE_SERVICE_KEY в Script Properties' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('заказы');
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, synced: 0 };

  const tz   = 'Europe/Moscow';
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 20).getValues();

  const rows = data.filter(r => r[0]).map(r => ({
    order_no:        r[0].toString().trim(),
    client:          r[16] ? r[16].toString().trim() : '',
    company:         r[18] ? r[18].toString().trim() : '',
    issue_date:      r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'yyyy-MM-dd') : null,
    issue_time:      r[3] ? r[3].toString().trim() : '',
    return_date:     r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'yyyy-MM-dd') : null,
    return_time:     r[5] ? r[5].toString().trim() : '',
    delivery_worker: r[19] ? r[19].toString().trim() : '',
    site_status:     r[6] ? r[6].toString().trim() : '',
    synced_at:       new Date().toISOString()
  }));

  if (!rows.length) return { ok: true, synced: 0 };

  // Батчами по 500 — на случай больших листов
  let synced = 0, lastCode = 0, lastBody = '';
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/orders?on_conflict=order_no', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(batch),
      muteHttpExceptions: true
    });
    lastCode = resp.getResponseCode();
    lastBody = resp.getContentText();
    if (lastCode >= 200 && lastCode < 300) synced += batch.length;
    else break;
  }

  if (lastCode < 200 || lastCode >= 300) {
    return { ok: false, synced, code: lastCode, error: lastBody };
  }

  // Мягкое удаление: заказы которых больше нет в Sheets → deleted_at = now()
  const activeNos = rows.map(r => r.order_no);
  _softDeleteMissing(cfg, activeNos);

  return { ok: true, synced };
}

// Помечает deleted_at для заказов, которых нет в текущей выгрузке из Sheets
function _softDeleteMissing(cfg, activeNos) {
  // Сначала снимаем deleted_at у тех, кто вернулся (на всякий случай)
  UrlFetchApp.fetch(cfg.url + '/rest/v1/orders?deleted_at=not.is.null', {
    method: 'patch',
    contentType: 'application/json',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=minimal'
    },
    payload: JSON.stringify({ deleted_at: null }),
    muteHttpExceptions: true
  });

  // Получаем все order_no из базы
  const resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/orders?select=order_no&deleted_at=is.null', {
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return;
  const dbNos = JSON.parse(resp.getContentText()).map(r => r.order_no);
  const activeSet = new Set(activeNos);
  const toDelete = dbNos.filter(n => !activeSet.has(n));
  if (!toDelete.length) return;

  // Помечаем батчами по 100 (URL-лимит)
  const now = new Date().toISOString();
  for (let i = 0; i < toDelete.length; i += 100) {
    const batch = toDelete.slice(i, i + 100);
    const inFilter = 'in.(' + batch.map(n => '"' + n.replace(/"/g,'\\"') + '"').join(',') + ')';
    UrlFetchApp.fetch(cfg.url + '/rest/v1/orders?order_no=' + encodeURIComponent(inFilter), {
      method: 'patch',
      contentType: 'application/json',
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        Prefer: 'return=minimal'
      },
      payload: JSON.stringify({ deleted_at: now }),
      muteHttpExceptions: true
    });
  }
}

// ── Расписание: автосинк 1–2 раза в день ──
// Запустить ОДИН раз вручную из редактора Apps Script.
function setupSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncOrders')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // 08:00 и 14:00 МСК. Убрать второй вызов, если нужен 1 раз в день.
  ScriptApp.newTrigger('syncOrders').timeBased().atHour(8).everyDays(1).inTimezone('Europe/Moscow').create();
  ScriptApp.newTrigger('syncOrders').timeBased().atHour(14).everyDays(1).inTimezone('Europe/Moscow').create();
}

// ── Веб-доступ: кнопка «Синхронизировать» в дашборде дёргает ?action=syncOrders ──
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'syncOrders') {
    return ContentService.createTextOutput(JSON.stringify(syncOrders()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Хелпер дат (как в текущем скрипте) ──
function parseDate(val) {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  const s = val.toString().trim();
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);      // dd.mm.yyyy
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);             // yyyy-mm-dd
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  const n = Number(s);                                         // Excel serial
  if (!isNaN(n) && n > 40000) return new Date((n - 25569) * 86400000);
  return new Date();
}
