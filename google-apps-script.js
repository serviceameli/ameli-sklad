// ═══════════════════════════════════════════════════════════════
//  AMELI RENTAL — СКЛАД: Google Apps Script v5
//  Терминология: визит = один приезд, может содержать N заказов
// ═══════════════════════════════════════════════════════════════

const SHEET_IMPORT  = 'заказы';
const SHEET_LOG     = 'log';
const SHEET_WORKERS = 'workers';
const SHEET_DRAFTS  = 'drafts';

// ════════════════════════════════════
//  GET
// ════════════════════════════════════
function doGet(e) {
  const action = e.parameter.action || 'getData';
  if (action === 'getData') {
    return jsonResponse({
      workers: getWorkers(),
      orders:  getTodayOrders(),
      processedToday: getProcessedTodayIds(), // ID заказов уже обработанных сегодня
    });
  }
  if (action === 'getAll') {
    return jsonResponse({ shifts: getAllShifts(), orders: getTodayOrders() });
  }
  return jsonResponse({ error: 'Unknown action' });
}

// Возвращает объект {issued: [...], returned: [...]} с ID заказов
// которые уже были выданы или возвращены сегодня согласно логу
function getProcessedTodayIds() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log || log.getLastRow() < 2) return { issued: [], returned: [] };

  const tz    = 'Europe/Moscow';
  const today = Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy');
  const rows  = log.getRange(2, 1, log.getLastRow()-1, 18).getValues();

  const issued   = new Set();
  const returned = new Set();

  rows.forEach(r => {
    // Дата смены в r[0] может быть строкой или объектом Date
    let shiftDate = '';
    if (r[0] instanceof Date) {
      shiftDate = Utilities.formatDate(r[0], tz, 'dd.MM.yyyy');
    } else {
      shiftDate = r[0] ? r[0].toString().trim() : '';
    }
    if (shiftDate !== today) return;

    const operation = r[7] ? r[7].toString().trim() : '';
    // Заказ в r[10] = Первый заказ (одна строка на заказ)
    // Но также проверяем r[8] = Заказы (все) — там через запятую
    const allOrdersStr = r[8] ? r[8].toString().trim() : '';
    const orderIds = allOrdersStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s && s !== '(нет в списке)');

    if (!orderIds.length) return;

    const isIssue  = ['Выдача','Получение (наш)','Получение+Возврат'].includes(operation);
    const isReturn = ['Возврат','Возврат (наш)','Получение+Возврат'].includes(operation);

    orderIds.forEach(id => {
      if (isIssue)  issued.add(id);
      if (isReturn) returned.add(id);
    });
  });

  return { issued: [...issued], returned: [...returned] };
}

// Отладка — запустите вручную если processedToday пустой
function debugProcessedToday() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  const tz  = 'Europe/Moscow';
  const today = Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy');

  if (!log || log.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('Лог пустой!'); return;
  }
  const rows = log.getRange(2, 1, Math.min(log.getLastRow()-1, 10), 18).getValues();
  let msg = `Сегодня: ${today}\n\nПервые строки лога:\n`;
  rows.forEach((r,i) => {
    const d = r[0] instanceof Date ? Utilities.formatDate(r[0],tz,'dd.MM.yyyy') : r[0];
    msg += `\n${i+1}. Дата="${d}" Операция="${r[7]}" Заказы="${r[8]}"`;
  });
  const result = getProcessedTodayIds();
  msg += `\n\nРезультат: issued=${JSON.stringify(result.issued)} returned=${JSON.stringify(result.returned)}`;
  SpreadsheetApp.getUi().alert(msg);
}

// ════════════════════════════════════
//  POST
// ════════════════════════════════════
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss   = SpreadsheetApp.getActiveSpreadsheet();

    if (data.isDraft === true) {
      saveDraft(ss, data);
      return jsonResponse({ success: true, type: 'draft' });
    }

    const log = getOrCreateSheet(ss, SHEET_LOG);
    if (log.getLastRow() === 0) {
      log.appendRow([
        'Дата смены','Начало смены (UTC)','Конец смены (UTC)','Кладовщик','День/Ночь','Всего визитов',
        'Кто приехал','Операция',
        'Все заказы визита','Кол-во заказов',
        'Номер заказа','Клиент заказа','Дата возврата','Доставка',
        'Время визита (МСК)','Время внесения (МСК)','Время суток','Комментарий'
      ]);
      log.getRange(1,1,1,18).setBackground('#1A1A1A').setFontColor('#fff').setFontWeight('bold');
      log.setFrozenRows(1);
    }

    const entries = data.entries || [];
    if (!entries.length) {
      log.appendRow([data.shiftDate,data.shiftStart,data.shiftEnd,data.worker,data.isNight,0,'','','',0,'','','','','','','','']);
    } else {
      entries.forEach(entry => {
        const entryOrders = entry.orders || [];
        // Write ONE ROW PER ORDER within the visit so every order gets its own log line
        // This allows proper status updates for each order
        if (!entryOrders.length) {
          // Visit without orders from list
          log.appendRow([
            data.shiftDate, data.shiftStart, data.shiftEnd,
            data.worker, data.isNight, data.totalEntries,
            visitorLabel(entry.visitor), operationLabel(entry.operation),
            '', 0, '', '', '', '',
            entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||''
          ]);
        } else {
          const allIds = entryOrders.filter(o=>o.id&&o.id!=='__other__').map(o=>o.id).join(', ');
          const validCount = entryOrders.filter(o=>o.id&&o.id!=='__other__').length;
          entryOrders.forEach(order => {
            if (!order.id || order.id === '__other__') {
              log.appendRow([
                data.shiftDate, data.shiftStart, data.shiftEnd,
                data.worker, data.isNight, data.totalEntries,
                visitorLabel(entry.visitor), operationLabel(entry.operation),
                allIds, validCount,
                '(нет в списке)', '', '', '',
                entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||''
              ]);
            } else {
              log.appendRow([
                data.shiftDate, data.shiftStart, data.shiftEnd,
                data.worker, data.isNight, data.totalEntries,
                visitorLabel(entry.visitor), operationLabel(entry.operation),
                allIds, validCount,
                order.id, order.client||'', order.returnDate||'', order.delivery||'',
                entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||''
              ]);
            }
          });
        }
      });
    }

    // Update statuses for ALL orders in this submission
    updateOrderStatuses(ss, entries);
    clearDraft(ss, data.worker);
    return jsonResponse({ success: true, rows: entries.length });

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// ════════════════════════════════════
//  WORKERS
// ════════════════════════════════════
function getWorkers() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_WORKERS);
  if (!sheet || sheet.getLastRow() < 2) {
    return ['Оля','Тамилла','Максим','Гоша','Алевтина','Наташа'].map(n=>({name:n}));
  }
  return sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues()
    .filter(r=>r[0]).map(r=>({name:r[0].toString().trim()}));
}

// ════════════════════════════════════
//  ORDERS TODAY
//  Логика: статус определяется ТОЛЬКО по датам
//  - issueDate = сегодня → показываем как «К выдаче»
//  - returnDate = сегодня (и issueDate ≠ сегодня) → показываем как «К возврату»
//  - все остальные дни → не показываем вообще
//  Статус из таблицы сайта ИГНОРИРУЕМ
// ════════════════════════════════════
function getTodayOrders() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const tz    = 'Europe/Moscow';
  const today = Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy');
  const data  = sheet.getRange(2, 1, sheet.getLastRow()-1, 20).getValues();
  const result = [];

  data.forEach(r => {
    if (!r[0]) return;
    const orderId    = r[0].toString().trim();
    const siteStatus = r[6].toString().trim();
    const issueDate  = r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'dd.MM.yyyy') : '';
    const returnDate = r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'dd.MM.yyyy') : '';
    const worker     = r[19] ? r[19].toString().trim() : '';
    const delivery   = worker ? 'Наша доставка' : 'Самовывоз';
    const issueTime  = parseTimeRange(r[3]);
    const returnTime = parseTimeRange(r[5]);

    if (issueDate === today) {
      // Выдача сегодня → показываем к выдаче, статус всегда pending
      result.push({
        id: orderId, client: r[16].toString().trim(), company: r[18].toString().trim(),
        issueDate, issueTime, returnDate, returnTime,
        delivery, worker,
        status: 'pending',  // статус из сайта не используем
        siteStatus,
        type: 'issue'
      });
    } else if (returnDate === today && issueDate !== today) {
      // Возврат сегодня (заказ уже у клиента) → показываем к возврату
      result.push({
        id: orderId, client: r[16].toString().trim(), company: r[18].toString().trim(),
        issueDate, issueTime, returnDate, returnTime,
        delivery, worker,
        status: 'pending',  // статус из сайта не используем
        siteStatus,
        type: 'return'
      });
    }
    // Все остальные случаи — не показываем
  });
  return result;
}

// ════════════════════════════════════
//  ALL SHIFTS (for dashboard)
// ════════════════════════════════════
function getAllShifts() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log || log.getLastRow() < 2) return [];

  const rows = log.getRange(2,1,log.getLastRow()-1,18).getValues();
  // Group by shift key (date+worker+day/night)
  const map = {};

  rows.forEach(r => {
    const key = `${r[0]}_${r[3]}_${r[4]}`;
    if (!map[key]) {
      map[key] = {
        shiftDate: r[0], shiftStart: r[1], shiftEnd: r[2],
        worker: r[3], isNight: r[4], totalEntries: Number(r[5])||0,
        entries: []
      };
    }

    if (r[6]) {
      // Group rows that belong to the same visit (same time+visitor+operation)
      const visitKey = `${r[14]}_${r[6]}_${r[7]}`;
      let visit = map[key].entries.find(e => e._visitKey === visitKey);
      if (!visit) {
        visit = {
          _visitKey: visitKey,
          visitor:   reverseVisitor(r[6]),
          operation: reverseOperation(r[7]),
          orders: [],
          time:    r[14], timeAuto: r[15],
          night:   r[16], comment:  r[17],
          timestamp: r[1],
        };
        map[key].entries.push(visit);
      }
      // Add order to this visit
      if (r[10] && r[10] !== '(нет в списке)') {
        visit.orders.push({ id: r[10], client: r[11]||'', returnDate: r[12]||'', delivery: r[13]||'' });
      }
    }
  });

  // Clean up internal key
  Object.values(map).forEach(s => s.entries.forEach(e => delete e._visitKey));
  return Object.values(map);
}

// ════════════════════════════════════
//  UPDATE ORDER STATUSES
// ════════════════════════════════════
function updateOrderStatuses(ss, entries) {
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (!sheet || sheet.getLastRow() < 2) return;

  // Собираем ID всех обработанных заказов (и выдача и возврат)
  const processed = new Set();
  entries.forEach(e => {
    const isIssue  = ['issue','pickup'].includes(e.operation);
    const isReturn = ['return','dropoff','both'].includes(e.operation);
    if (!isIssue && !isReturn) return;
    (e.orders||[]).forEach(o => {
      if (o.id && o.id !== '__other__') processed.add(o.id.trim());
    });
  });
  if (!processed.size) return;

  const ids = sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues();
  ids.forEach((row,i) => {
    if (processed.has(row[0].toString().trim())) {
      sheet.getRange(i+2, 7).setValue('Выполнен');
    }
  });
}

// ════════════════════════════════════
//  DRAFTS
// ════════════════════════════════════
function saveDraft(ss, data) {
  const sheet = getOrCreateSheet(ss, SHEET_DRAFTS);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Кладовщик','Сохранено','Записей','Данные JSON']);
    sheet.getRange(1,1,1,4).setBackground('#333').setFontColor('#fff').setFontWeight('bold');
  }
  const vals = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues() : [];
  let found = -1;
  vals.forEach((r,i) => { if(r[0]===data.worker) found=i+2; });
  const row = [data.worker, new Date().toLocaleString('ru'), data.totalEntries||0, JSON.stringify(data)];
  if (found > 0) sheet.getRange(found,1,1,4).setValues([row]);
  else sheet.appendRow(row);
}

function clearDraft(ss, workerName) {
  const sheet = ss.getSheetByName(SHEET_DRAFTS);
  if (!sheet || sheet.getLastRow() < 2) return;
  const vals = sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues();
  for (let i = vals.length-1; i >= 0; i--) {
    if (vals[i][0] === workerName) sheet.deleteRow(i+2);
  }
}

// ════════════════════════════════════
//  HELPERS
// ════════════════════════════════════
function getOrCreateSheet(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
function jsonResponse(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function parseDate(val) {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  const s = val.toString().trim();
  // dd.mm.yyyy
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2]-1, +m1[1]);
  // yyyy-mm-dd
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(+m2[1], +m2[2]-1, +m2[3]);
  // Excel serial
  const n = Number(s);
  if (!isNaN(n) && n > 40000) return new Date((n-25569)*86400000);
  return new Date();
}

function parseTimeRange(val) {
  if (!val) return '';
  const m = val.toString().match(/^(\d{1,2}:\d{2})/);
  return m ? m[1] : '';
}

// Статус сайта → внутренний: issued = уже выдан/выполнен, pending = ещё ждёт
function mapStatus(s) {
  const issued = ['Выполнен'];
  return issued.includes(s) ? 'issued' : 'pending';
}

function visitorLabel(v)  { return {client:'Клиент',yandex:'Курьер Яндекс',our:'Наш курьер'}[v]||v||''; }
function operationLabel(o){ return {issue:'Выдача',return:'Возврат',pickup:'Получение (наш)',dropoff:'Возврат (наш)',both:'Получение+Возврат'}[o]||o||''; }
function reverseVisitor(s){ return {'Клиент':'client','Курьер Яндекс':'yandex','Наш курьер':'our'}[s]||s; }
function reverseOperation(s){ return {'Выдача':'issue','Возврат':'return','Получение (наш)':'pickup','Возврат (наш)':'dropoff','Получение+Возврат':'both'}[s]||s; }

// ════════════════════════════════════
//  ПЕРВИЧНАЯ НАСТРОЙКА — Run → setupSheets
// ════════════════════════════════════
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = getOrCreateSheet(ss, SHEET_WORKERS);
  if (ws.getLastRow() === 0) {
    ws.appendRow(['Имя кладовщика']);
    ws.getRange(1,1).setBackground('#1A1A1A').setFontColor('#fff').setFontWeight('bold');
    ['Оля','Тамилла','Максим','Гоша','Алевтина','Наташа'].forEach(n => ws.appendRow([n]));
  }
  getOrCreateSheet(ss, SHEET_LOG);
  getOrCreateSheet(ss, SHEET_DRAFTS);
  SpreadsheetApp.getUi().alert(
    '✅ Готово!\n\nЛисты: workers, log, drafts\n\n' +
    'Лист с заказами должен называться "заказы" (строчные!) — это лист из экспорта вашего сайта.\n\n' +
    'Для проверки запустите checkTodayOrders()'
  );
}

function checkTodayOrders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetNames = ss.getSheets().map(s=>s.getName()).join(', ');
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (!sheet) {
    SpreadsheetApp.getUi().alert(`❌ Лист "${SHEET_IMPORT}" не найден!\nДоступные: ${sheetNames}`);
    return;
  }
  const orders = getTodayOrders();
  const tz = 'Europe/Moscow';
  const today = Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy');
  SpreadsheetApp.getUi().alert(
    `✅ Лист "${SHEET_IMPORT}" (${sheet.getLastRow()} строк)\n\nЗаказы на ${today}:\n` +
    `К выдаче: ${orders.filter(o=>o.type==='issue').length}\n` +
    `К возврату: ${orders.filter(o=>o.type==='return').length}\n\n` +
    (orders.slice(0,8).map(o=>`${o.type==='issue'?'📦':'🔄'} ${o.id} · ${o.client}`).join('\n')||'Заказов нет')
  );
}
