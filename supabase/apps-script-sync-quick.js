// ═══════════════════════════════════════════════════════════════
//  РАЗОВЫЙ ИМПОРТ заказов: Google-таблица «заказы» → Supabase orders
//  Упрощённая версия для первого запуска (без Script Properties).
//  Использует ПУБЛИЧНЫЙ ключ — для импорта это ок, т.к. политики
//  сейчас разрешают запись. Перед боевым запуском перейдём на
//  secret-ключ через Script Properties (см. apps-script-sync.js).
//
//  КАК ЗАПУСТИТЬ:
//  1. В таблице: Расширения → Apps Script.
//  2. Добавить файл (＋ → Скрипт), вставить этот код.
//  3. Сверху выбрать функцию syncOrdersOnce → Run.
//  4. При первом запуске Google попросит авторизацию — разрешить.
//  5. В логах (Просмотр → Логи) будет «Залито заказов: N».
// ═══════════════════════════════════════════════════════════════

function syncOrdersOnce() {
  const SUPABASE_URL = 'https://xkqaipggklmgussjphkp.supabase.co';
  const KEY = 'sb_publishable_h7zhxKris7gY8i-dxOvx4w__cxxPIRX';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('заказы');
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('Лист «заказы» пуст'); return; }

  const tz = 'Europe/Moscow';
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 20).getValues();

  const rows = data.filter(r => r[0]).map(r => ({
    order_no:        r[0].toString().trim(),
    client:          r[16] ? r[16].toString().trim() : '',
    company:         r[18] ? r[18].toString().trim() : '',
    issue_date:      r[2] ? Utilities.formatDate(parseDateQ(r[2]), tz, 'yyyy-MM-dd') : null,
    issue_time:      r[3] ? r[3].toString().trim() : '',
    return_date:     r[4] ? Utilities.formatDate(parseDateQ(r[4]), tz, 'yyyy-MM-dd') : null,
    return_time:     r[5] ? r[5].toString().trim() : '',
    delivery_worker: r[19] ? r[19].toString().trim() : '',
    site_status:     r[6] ? r[6].toString().trim() : '',
    synced_at:       new Date().toISOString()
  }));

  if (!rows.length) { Logger.log('Нет строк для импорта'); return; }

  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/orders?on_conflict=order_no', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        apikey: KEY,
        Authorization: 'Bearer ' + KEY,
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(batch),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) done += batch.length;
    else { Logger.log('Ошибка ' + code + ': ' + resp.getContentText()); break; }
  }
  Logger.log('Залито заказов: ' + done + ' из ' + rows.length);
}

function parseDateQ(val) {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  const s = val.toString().trim();
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  const n = Number(s);
  if (!isNaN(n) && n > 40000) return new Date((n - 25569) * 86400000);
  return new Date();
}
