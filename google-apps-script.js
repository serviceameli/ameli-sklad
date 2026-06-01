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
  const action     = e.parameter.action || 'getData';
  const workerName = e.parameter.worker ? decodeURIComponent(e.parameter.worker) : null;

  if (action === 'getData') {
    const resp = {
      workers:        getWorkers(),
      orders:         getTodayOrders(),
      processedOrders: getProcessedOrderIds(),
    };
    // Если передан worker — добавляем его черновик (для восстановления смены с любого устройства)
    if (workerName) {
      resp.draft = getWorkerDraft(workerName);
    }
    return jsonResponse(resp);
  }
  if (action === 'getAll') {
    return jsonResponse({ shifts: getAllShifts(), orders: getTodayOrders() });
  }
  return jsonResponse({ error: 'Unknown action' });
}

// Возвращает черновик конкретного кладовщика из листа drafts, или null
function getWorkerDraft(workerName) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_DRAFTS);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const vals = sheet.getRange(2, 1, sheet.getLastRow()-1, 4).getValues();
  for (const r of vals) {
    if (r[0].toString().trim() === workerName && r[3]) {
      try { return JSON.parse(r[3].toString()); } catch(e) { return null; }
    }
  }
  return null;
}

// Возвращает {issued:[...], returned:[...]} — ID заказов которые когда-либо
// были выданы или возвращены согласно нашему логу визитов.
// Сканируем ВЕСЬ лог без фильтра по дате: ID заказов уникальны,
// и getTodayOrders всё равно показывает только заказы с датой = сегодня,
// поэтому «лишних» совпадений быть не может.
function getProcessedOrderIds() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log || log.getLastRow() < 2) return { issued: [], returned: [], issuedBy: {}, returnedBy: {} };

  const rows = log.getRange(2, 1, log.getLastRow()-1, 9).getValues();

  const issued     = new Set();
  const returned   = new Set();
  const issuedBy   = {};  // orderId → workerName
  const returnedBy = {};

  rows.forEach(r => {
    const workerName   = r[3] ? r[3].toString().trim() : '';
    const operation    = r[7] ? r[7].toString().trim() : '';
    const allOrdersStr = r[8] ? r[8].toString().trim() : '';
    const orderIds = allOrdersStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s && s !== '(нет в списке)');

    if (!orderIds.length) return;

    const isIssue  = ['Выдача','Выдача и возврат','Выдача (наш)','Выдача+Возврат (наш)','Получение (наш)','Получение+Возврат'].includes(operation);
    const isReturn = ['Возврат','Выдача и возврат','Возврат (наш)','Выдача+Возврат (наш)','Получение+Возврат'].includes(operation);

    orderIds.forEach(id => {
      if (isIssue)  { issued.add(id);   issuedBy[id]   = workerName; }
      if (isReturn) { returned.add(id); returnedBy[id] = workerName; }
    });
  });

  return { issued: [...issued], returned: [...returned], issuedBy, returnedBy };
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

    if (data.isDraft) {
      saveDraft(ss, data);
      return jsonResponse({ success: true, type: 'draft' });
    }

    const log = getOrCreateSheet(ss, SHEET_LOG);
    ensureLogHeader(log);

    // Немедленная запись одного визита (при нажатии "Добавить визит")
    if (data.action === 'addVisit') {
      writeEntryToLog(log, data, data.entry);
      updateOrderStatuses(ss, [data.entry]); // обновляем статус для менеджеров
      return jsonResponse({ success: true, type: 'visit' });
    }

    // Закрытие смены: удалить ранее записанные строки этой смены, записать заново
    deleteShiftRows(log, data.shiftStart, data.worker);

    const entries = data.entries || [];
    if (!entries.length) {
      log.appendRow([data.shiftDate,data.shiftStart,data.shiftEnd,data.worker,data.isNight,0,'','','',0,'','','','','','','','']);
    } else {
      entries.forEach(entry => writeEntryToLog(log, data, entry));
    }

    updateOrderStatuses(ss, entries);
    clearDraft(ss, data.worker);
    return jsonResponse({ success: true, rows: entries.length });

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function ensureLogHeader(log) {
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
}

function writeEntryToLog(log, data, entry) {
  if (!entry || !entry.visitor) return; // не писать пустые строки
  const entryOrders = entry.orders || [];
  if (!entryOrders.length) {
    log.appendRow([
      data.shiftDate, data.shiftStart, data.shiftEnd||'',
      data.worker, data.isNight, data.totalEntries||0,
      visitorLabel(entry.visitor), operationLabel(entry.operation),
      '', 0, '', '', '', '',
      entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||''
    ]);
    return;
  }
  const allIds     = entryOrders.filter(o=>o.id&&o.id!=='__other__').map(o=>o.id).join(', ');
  const validCount = entryOrders.filter(o=>o.id&&o.id!=='__other__').length;
  entryOrders.forEach(order => {
    if (!order.id || order.id === '__other__') {
      log.appendRow([
        data.shiftDate, data.shiftStart, data.shiftEnd||'',
        data.worker, data.isNight, data.totalEntries||0,
        visitorLabel(entry.visitor), operationLabel(entry.operation),
        allIds, validCount, '(нет в списке)', '', '', '',
        entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||''
      ]);
    } else {
      log.appendRow([
        data.shiftDate, data.shiftStart, data.shiftEnd||'',
        data.worker, data.isNight, data.totalEntries||0,
        visitorLabel(entry.visitor), operationLabel(entry.operation),
        allIds, validCount, order.id, order.client||'', order.returnDate||'', order.delivery||'',
        entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||''
      ]);
    }
  });
}

// Удаляет все строки лога принадлежащие данной смене (по shiftStart + worker).
// Google Sheets конвертирует ISO-строки в объекты Date, поэтому сравниваем через toISOString().
function deleteShiftRows(log, shiftStart, worker) {
  if (log.getLastRow() < 2) return;
  const vals = log.getRange(2, 1, log.getLastRow()-1, 4).getValues();
  for (let i = vals.length-1; i >= 0; i--) {
    const storedStart = vals[i][1] instanceof Date
      ? vals[i][1].toISOString()
      : vals[i][1].toString();
    if (storedStart === shiftStart && vals[i][3].toString() === worker) {
      log.deleteRow(i+2);
    }
  }
}

// ════════════════════════════════════
//  WORKERS
// ════════════════════════════════════
function getWorkers() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_WORKERS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  // Колонки: A = Имя, B = PIN, C = Ссылка, D = Активен (да/нет)
  return sheet.getRange(2,1,sheet.getLastRow()-1,4).getValues()
    .filter(r=>r[0])
    .filter(r=>r[3]===''||r[3].toString().toLowerCase()!=='нет') // фильтруем неактивных
    .map(r=>({name:r[0].toString().trim(), pin:r[1]?r[1].toString().trim():''}));
}

// ════════════════════════════════════
//  ORDERS TODAY
//  Показываем заказ ТОЛЬКО по датам:
//    issueDate == сегодня  → тип 'issue'  (к выдаче)
//    returnDate == сегодня → тип 'return' (к возврату)
//  ВАЖНО: колонка «Статус» из листа заказов (G) — это данные для менеджеров сайта,
//  наша система её НЕ читает и НЕ использует для логики.
//  Кто выдан/возвращён — определяем только из нашего лога визитов (getProcessedOrderIds).
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
    const issueDate  = r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'dd.MM.yyyy') : '';
    const returnDate = r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'dd.MM.yyyy') : '';
    const worker     = r[19] ? r[19].toString().trim() : '';
    const delivery   = worker ? 'Наша доставка' : 'Самовывоз';
    const issueTime  = parseTimeRange(r[3]);
    const returnTime = parseTimeRange(r[5]);

    if (issueDate === today && returnDate === today) {
      // Однодневная аренда: выдача и возврат в один день
      // Тип определяется фронтендом в зависимости от статуса выдачи
      result.push({
        id: orderId, client: r[16].toString().trim(), company: r[18].toString().trim(),
        issueDate, issueTime, returnDate, returnTime,
        delivery, worker, type: 'issue', sameDay: true
      });
    } else if (issueDate === today) {
      result.push({
        id: orderId, client: r[16].toString().trim(), company: r[18].toString().trim(),
        issueDate, issueTime, returnDate, returnTime,
        delivery, worker, type: 'issue', sameDay: false
      });
    } else if (returnDate === today) {
      result.push({
        id: orderId, client: r[16].toString().trim(), company: r[18].toString().trim(),
        issueDate, issueTime, returnDate, returnTime,
        delivery, worker, type: 'return', sameDay: false
      });
    }
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
function operationLabel(o){ return {issue:'Выдача',return:'Возврат',pickup:'Выдача',dropoff:'Возврат',both:'Выдача и возврат'}[o]||o||''; }
function reverseVisitor(s){ return {'Клиент':'client','Курьер Яндекс':'yandex','Наш курьер':'our'}[s]||s; }
function reverseOperation(s){ return {
  'Выдача':'issue','Возврат':'return','Выдача и возврат':'both',
  // Старые названия (обратная совместимость)
  'Выдача (наш)':'issue','Возврат (наш)':'return','Выдача+Возврат (наш)':'both',
  'Получение (наш)':'issue','Получение+Возврат':'both'
}[s]||s; }

// ════════════════════════════════════
//  ПЕРВИЧНАЯ НАСТРОЙКА — Run → setupSheets
// ════════════════════════════════════
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = getOrCreateSheet(ss, SHEET_WORKERS);
  if (ws.getLastRow() === 0) {
    ws.appendRow(['Имя кладовщика','PIN','Ссылка','Активен']);
    ws.getRange(1,1,1,4).setBackground('#1A1A1A').setFontColor('#fff').setFontWeight('bold');
    // Имена добавляйте вручную в таблицу — не храним их в коде
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
