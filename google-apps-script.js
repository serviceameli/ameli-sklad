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
  // e.parameter уже декодирован — повторный decodeURIComponent ломал имена с «%»
  const workerName = e.parameter.worker || null;

  if (action === 'getData') {
    const processedOrders = getProcessedOrderIds();
    const issuedSet   = new Set(processedOrders.issued);
    const returnedSet = new Set(processedOrders.returned);
    const todayOrders    = getTodayOrders();
    const overdueOrders  = getOverdueOrders(issuedSet, returnedSet);
    // Объединяем: сегодняшние приоритетнее (уже есть в todayOrders — не дублируем)
    const todayIds = new Set(todayOrders.map(o => o.id));
    const orders = [...todayOrders, ...overdueOrders.filter(o => !todayIds.has(o.id))];
    const resp = {
      workers:        getWorkers(),
      orders,
      processedOrders,
    };
    // Если передан worker — добавляем его черновик (для восстановления смены с любого устройства)
    if (workerName) {
      resp.draft = getWorkerDraft(workerName);
    }
    return jsonResponse(resp);
  }
  if (action === 'getAll') {
    // Дашборду тоже нужна просрочка — собираем заказы так же, как в getData
    const processedOrders = getProcessedOrderIds();
    const issuedSet   = new Set(processedOrders.issued);
    const returnedSet = new Set(processedOrders.returned);
    const todayOrders   = getTodayOrders();
    const overdueOrders = getOverdueOrders(issuedSet, returnedSet);
    const todayIds = new Set(todayOrders.map(o => o.id));
    const orders = [...todayOrders, ...overdueOrders.filter(o => !todayIds.has(o.id))];
    return jsonResponse({ shifts: getAllShifts(), orders, processedOrders });
  }
  if (action === 'getUnmatched') {
    return jsonResponse(getUnmatchedData());
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
  // Кэш на 20 сек — getData опрашивается каждые 15 сек с каждого устройства,
  // а полный скан лога с ростом данных станет дорогим (квоты Apps Script)
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get('processedOrders');
    if (hit) return JSON.parse(hit);
  } catch (e) {}

  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log || log.getLastRow() < 2) return { issued: [], returned: [], issuedBy: {}, returnedBy: {}, otherVisits: [] };

  const rows = log.getRange(2, 1, log.getLastRow()-1, 18).getValues();

  const issued     = new Set();
  const returned   = new Set();
  const issuedBy   = {};  // orderId → workerName
  const returnedBy = {};
  const otherVisits = [];

  const visitorKey = {'Клиент':'client','Курьер Яндекс':'yandex','Наш курьер':'our'};
  const operationKey = {'Выдача':'issue','Выдача (наш)':'issue','Получение (наш)':'issue','Возврат':'return','Возврат (наш)':'return','Выдача и возврат':'both','Выдача+Возврат (наш)':'both','Получение+Возврат':'both'};

  rows.forEach(r => {
    const workerName   = r[3] ? r[3].toString().trim() : '';
    const operation    = r[7] ? r[7].toString().trim() : '';
    const allOrdersStr = r[8] ? r[8].toString().trim() : '';
    const firstOrder   = r[10] ? r[10].toString().trim() : '';
    const orderIds = allOrdersStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s && s !== '(нет в списке)');

    // «Не из списка» визит: нет реальных заказов, первый заказ = '(нет в списке)'
    if (!orderIds.length && firstOrder === '(нет в списке)') {
      otherVisits.push({
        visitor:   visitorKey[r[6] ? r[6].toString().trim() : ''] || 'client',
        operation: operationKey[operation] || 'issue',
        time:      r[14] ? (r[14] instanceof Date ? Utilities.formatDate(r[14], 'Europe/Moscow', 'HH:mm') : r[14].toString().trim()) : '',
        comment:   r[17] ? r[17].toString().trim() : '',
        worker:    workerName
      });
      return;
    }

    if (!orderIds.length) return;

    const isIssue  = ['Выдача','Выдача и возврат','Выдача (наш)','Выдача+Возврат (наш)','Получение (наш)','Получение+Возврат'].includes(operation);
    const isReturn = ['Возврат','Выдача и возврат','Возврат (наш)','Выдача+Возврат (наш)','Получение+Возврат'].includes(operation);

    orderIds.forEach(id => {
      if (isIssue)  { issued.add(id);   issuedBy[id]   = workerName; }
      if (isReturn) { returned.add(id); returnedBy[id] = workerName; }
    });
  });

  const result = { issued: [...issued], returned: [...returned], issuedBy, returnedBy, otherVisits };
  try { cache.put('processedOrders', JSON.stringify(result), 20); } catch (e) {} // >100KB — просто без кэша
  return result;
}

// Сброс кэша после любой записи в лог
function invalidateProcessedCache() {
  try { CacheService.getScriptCache().remove('processedOrders'); } catch (e) {}
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
  const result = getProcessedOrderIds();
  msg += `\n\nРезультат: issued=${JSON.stringify(result.issued)} returned=${JSON.stringify(result.returned)}`;
  SpreadsheetApp.getUi().alert(msg);
}

// ════════════════════════════════════
//  POST
// ════════════════════════════════════
function doPost(e) {
  // Lock против гонок: одновременные closeShift (удаление+перезапись строк)
  // и addVisit от разных кладовщиков сдвигают индексы строк друг у друга
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
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
      invalidateProcessedCache();
      return jsonResponse({ success: true, type: 'visit' });
    }

    // Удаление одного визита по shiftStart + worker + timeAuto
    if (data.action === 'deleteVisit') {
      deleteVisitRows(log, data.shiftStart, data.worker, data.timeAuto);
      invalidateProcessedCache();
      return jsonResponse({ success: true, type: 'deleteVisit' });
    }

    // Привязка визита «нет в списке» к реальным заказам (вкладка Сверка)
    if (data.action === 'linkVisit') {
      const res = linkVisitToOrders(ss, log, data.visitKey, data.orderIds || []);
      invalidateProcessedCache();
      return jsonResponse(res);
    }

    // Закрытие смены: удалить ранее записанные строки этой смены, записать заново
    if (data.action === 'closeShift' || data.action === undefined) {
      deleteShiftRows(log, data.shiftStart, data.worker);

      const entries = data.entries || [];
      if (!entries.length) {
        log.appendRow([data.shiftDate,data.shiftStart,data.shiftEnd,data.worker,data.isNight,0,'','','',0,'','','','','','','','','']);
      } else {
        entries.forEach(entry => writeEntryToLog(log, data, entry));
      }

      updateOrderStatuses(ss, entries);
      clearDraft(ss, data.worker);
      invalidateProcessedCache();
      return jsonResponse({ success: true, rows: entries.length });
    }

    // Неизвестный action — раньше проваливался в closeShift и писал мусор в лог
    return jsonResponse({ success: false, error: 'Unknown action: ' + data.action });

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function ensureLogHeader(log) {
  if (log.getLastRow() === 0) {
    log.appendRow([
      'Дата смены','Начало смены (UTC)','Конец смены (UTC)','Кладовщик','День/Ночь','Всего визитов',
      'Кто приехал','Операция',
      'Все заказы визита','Кол-во заказов',
      'Номер заказа','Клиент заказа','Дата возврата','Доставка',
      'Время визита (МСК)','Время внесения (МСК)','Время суток','Комментарий','Дата визита'
    ]);
    log.getRange(1,1,1,19).setBackground('#1A1A1A').setFontColor('#fff').setFontWeight('bold');
    log.setFrozenRows(1);
  } else if (!log.getRange(1,19).getValue()) {
    // Миграция существующего лога: добавляем 19-ю колонку «Дата визита»
    log.getRange(1,19).setValue('Дата визита').setBackground('#1A1A1A').setFontColor('#fff').setFontWeight('bold');
  }
}

function writeEntryToLog(log, data, entry) {
  if (!entry || !entry.visitor) return; // не писать пустые строки
  const visitDate = entry.date || ''; // выбранная дата визита (yyyy-mm-dd), кол. 19
  const entryOrders = entry.orders || [];
  if (!entryOrders.length) {
    log.appendRow([
      data.shiftDate, data.shiftStart, data.shiftEnd||'',
      data.worker, data.isNight, data.totalEntries||0,
      visitorLabel(entry.visitor), operationLabel(entry.operation),
      '', 0, '', '', '', '',
      entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||'', visitDate
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
        entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||'', visitDate
      ]);
    } else {
      log.appendRow([
        data.shiftDate, data.shiftStart, data.shiftEnd||'',
        data.worker, data.isNight, data.totalEntries||0,
        visitorLabel(entry.visitor), operationLabel(entry.operation),
        allIds, validCount, order.id, order.client||'', order.returnDate||'', order.delivery||'',
        entry.time||'', entry.timeAuto||'', entry.night||'', entry.comment||'', visitDate
      ]);
    }
  });
}

// Удаляет ВСЕ строки визита по shiftStart + worker + timeAuto (col 15, 0-based).
// Визит с несколькими заказами пишется в несколько строк — удалять нужно все,
// иначе остаются строки-сироты и заказы продолжают числиться обработанными.
function deleteVisitRows(log, shiftStart, worker, timeAuto) {
  if (log.getLastRow() < 2) return;
  const tz = 'Europe/Moscow';
  const vals = log.getRange(2, 1, log.getLastRow()-1, 16).getValues();
  for (let i = vals.length-1; i >= 0; i--) { // с конца — индексы не съезжают
    const storedStart = vals[i][1] instanceof Date
      ? vals[i][1].toISOString()
      : vals[i][1].toString();
    const storedWorker   = vals[i][3].toString().trim();
    const storedTimeAuto = vals[i][15]
      ? (vals[i][15] instanceof Date ? Utilities.formatDate(vals[i][15], tz, 'HH:mm') : vals[i][15].toString().trim())
      : '';
    if (storedStart === shiftStart && storedWorker === worker && storedTimeAuto === timeAuto) {
      log.deleteRow(i+2);
    }
  }
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
//  OVERDUE ORDERS
//  Заказы прошлых дней, которые не обработали вовремя
// ════════════════════════════════════
// ════════════════════════════════════
//  ПРОСРОЧЕННЫЕ ЗАКАЗЫ
// ════════════════════════════════════

// Читает просрочку из двух источников:
// 1. Лист заказы — пока заказ там ещё есть (сегодня или уже ушёл но ещё не убрали)
// 2. Лог — записи «Просрочен - не выдан» / «Просрочен - не возвращён» + Выдача без Возврата
function getOverdueOrders(issuedSet, returnedSet) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const tz  = 'Europe/Moscow';
  // ⚠️ Сравниваем даты ТОЛЬКО в формате yyyy-MM-dd: строки "dd.MM.yyyy"
  // сравниваются лексикографически и ломаются на границе месяца ("31.05" > "10.06")
  const todayISO = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const result = [];
  const seen   = new Set(); // orderId_type

  // --- 1. Из листа заказы ---
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (sheet && sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow()-1, 20).getValues();
    data.forEach(r => {
      if (!r[0]) return;
      const orderId    = r[0].toString().trim();
      const issueDate  = r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'dd.MM.yyyy') : '';
      const returnDate = r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'dd.MM.yyyy') : '';
      const issueISO   = r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'yyyy-MM-dd') : '';
      const returnISO  = r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'yyyy-MM-dd') : '';
      const client     = r[16] ? r[16].toString().trim() : '';
      const delivery   = r[19] ? 'Наша доставка' : 'Самовывоз';

      if (issueISO && issueISO < todayISO && !issuedSet.has(orderId) && !seen.has(orderId+'_i')) {
        result.push({ id:orderId, client, issueDate, returnDate, delivery, type:'issue', sameDay:issueDate===returnDate, overdue:true });
        seen.add(orderId+'_i');
      } else if (returnISO && returnISO < todayISO && issuedSet.has(orderId) && !returnedSet.has(orderId) && !seen.has(orderId+'_r')) {
        result.push({ id:orderId, client, issueDate, returnDate, delivery, type:'return', sameDay:false, overdue:true });
        seen.add(orderId+'_r');
      }
    });
  }

  // --- 2. Из лога: Просрочен-записи + Выдача без Возврата ---
  const log = ss.getSheetByName(SHEET_LOG);
  if (log && log.getLastRow() >= 2) {
    const rows = log.getRange(2, 1, log.getLastRow()-1, 14).getValues();

    // Собираем сводку по каждому orderId из лога
    const logMap = {}; // orderId → {issued, returned, returnDate, client, delivery, notIssuedRecorded, notReturnedRecorded}
    rows.forEach(r => {
      const op       = r[7]  ? r[7].toString().trim()  : '';
      const orderId  = r[10] ? r[10].toString().trim() : '';
      const client   = r[11] ? r[11].toString().trim() : '';
      // Sheets мог сконвертировать дату в Date-объект — нормализуем в dd.MM.yyyy
      const retDate  = r[12] ? (r[12] instanceof Date ? Utilities.formatDate(r[12], 'Europe/Moscow', 'dd.MM.yyyy') : r[12].toString().trim()) : '';
      const delivery = r[13] ? r[13].toString().trim() : '';
      if (!orderId || orderId === '(нет в списке)') return;

      if (!logMap[orderId]) logMap[orderId] = { issued:false, returned:false, returnDate:'', client:'', delivery:'', notIssuedRecorded:false, notReturnedRecorded:false };
      const m = logMap[orderId];

      const isIssue  = ['Выдача','Выдача и возврат','Выдача (наш)','Выдача+Возврат (наш)','Получение (наш)','Получение+Возврат'].includes(op);
      const isReturn = ['Возврат','Выдача и возврат','Возврат (наш)','Выдача+Возврат (наш)','Получение+Возврат'].includes(op);

      if (isIssue)  { m.issued   = true; if(retDate)  m.returnDate = retDate; if(client) m.client = client; if(delivery) m.delivery = delivery; }
      if (isReturn) { m.returned = true; }
      if (op === 'Просрочен - не выдан')      m.notIssuedRecorded   = true;
      if (op === 'Просрочен - не возвращён')  m.notReturnedRecorded = true;
    });

    Object.entries(logMap).forEach(([orderId, m]) => {
      // Просрочен-запись без последующей Выдачи
      if (m.notIssuedRecorded && !m.issued && !seen.has(orderId+'_i')) {
        result.push({ id:orderId, client:m.client, returnDate:m.returnDate, delivery:m.delivery, type:'issue', sameDay:false, overdue:true });
        seen.add(orderId+'_i');
      }
      // Просрочен-запись без последующего Возврата
      if (m.notReturnedRecorded && !m.returned && !seen.has(orderId+'_r')) {
        result.push({ id:orderId, client:m.client, returnDate:m.returnDate, delivery:m.delivery, type:'return', sameDay:false, overdue:true });
        seen.add(orderId+'_r');
      }
      // Выдача с просроченным returnDate без Возврата (даже без Просрочен-записи)
      if (m.issued && !m.returned && m.returnDate && dateKey(m.returnDate) && dateKey(m.returnDate) < todayISO && !seen.has(orderId+'_r')) {
        result.push({ id:orderId, client:m.client, returnDate:m.returnDate, delivery:m.delivery, type:'return', sameDay:false, overdue:true });
        seen.add(orderId+'_r');
      }
    });
  }

  return result;
}

// Записывает незакрытые заказы ВЧЕРАШНЕГО дня в лог как «Просрочен».
// Триггер запускается в 00:00–01:00 МСК — на тот момент «сегодня» уже новый день,
// поэтому проверяем вчерашнюю дату (раньше тут было === today, и в полночь
// заказы наступившего дня ошибочно помечались просроченными).
function recordOverdueOrders() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (!log || !sheet || sheet.getLastRow() < 2) return;

  const tz    = 'Europe/Moscow';
  const yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), tz, 'dd.MM.yyyy');
  const now   = Utilities.formatDate(new Date(), tz, 'HH:mm');
  const ts    = new Date().toISOString();

  const processed   = getProcessedOrderIds();
  const issuedSet   = new Set(processed.issued);
  const returnedSet = new Set(processed.returned);

  // Уже записанные в лог как просроченные — не дублируем
  const alreadyLogged = new Set();
  if (log.getLastRow() >= 2) {
    log.getRange(2, 1, log.getLastRow()-1, 11).getValues().forEach(r => {
      const op  = r[7]  ? r[7].toString().trim()  : '';
      const id  = r[10] ? r[10].toString().trim() : '';
      if (op === 'Просрочен - не выдан')     alreadyLogged.add(id + '_i');
      if (op === 'Просрочен - не возвращён') alreadyLogged.add(id + '_r');
    });
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow()-1, 20).getValues();
  data.forEach(r => {
    if (!r[0]) return;
    const orderId    = r[0].toString().trim();
    const issueDate  = r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'dd.MM.yyyy') : '';
    const returnDate = r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'dd.MM.yyyy') : '';
    const client     = r[16] ? r[16].toString().trim() : '';
    const delivery   = r[19] ? 'Наша доставка' : 'Самовывоз';

    if (issueDate === yesterday && !issuedSet.has(orderId) && !alreadyLogged.has(orderId+'_i')) {
      log.appendRow([yesterday, ts, '', 'Система', 'Авто', 0, '', 'Просрочен - не выдан',
        orderId, 1, orderId, client, returnDate, delivery, now, now, '', '', '']);
    }
    if (returnDate === yesterday && issuedSet.has(orderId) && !returnedSet.has(orderId) && !alreadyLogged.has(orderId+'_r')) {
      log.appendRow([yesterday, ts, '', 'Система', 'Авто', 0, '', 'Просрочен - не возвращён',
        orderId, 1, orderId, client, returnDate, delivery, now, now, '', '', '']);
    }
  });
  invalidateProcessedCache();
}

// Создаёт триггер 00:00–01:00 МСК (atHour(0)). Запустить один раз вручную.
function setupOverdueTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'recordOverdueOrders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('recordOverdueOrders')
    .timeBased().atHour(0).everyDays(1).inTimezone('Europe/Moscow').create();
}

// ════════════════════════════════════
//  ALL SHIFTS (for dashboard)
// ════════════════════════════════════
function getAllShifts() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log || log.getLastRow() < 2) return [];

  const tz = 'Europe/Moscow';
  const rows = log.getRange(2,1,log.getLastRow()-1,19).getValues();
  // Группируем по shiftStart+worker: уникально для каждой смены.
  // Старый ключ дата+работник+день/ночь сливал две смены одного дня в одну.
  const map = {};

  rows.forEach(r => {
    const workerName = r[3] ? r[3].toString().trim() : '';
    // Служебные записи «Система» (автопросрочка) — не смены, в дашборд не отдаём
    if (!workerName || workerName === 'Система') return;

    const startKey = r[1] instanceof Date ? r[1].toISOString() : (r[1]||'').toString();
    const key = `${startKey}_${workerName}`;
    if (!map[key]) {
      // shiftDate (r[0]) может быть Date-объектом если Sheets хранит как дату — форматируем в dd.MM.yyyy
      const shiftDateFmt = r[0] instanceof Date
        ? Utilities.formatDate(r[0], tz, 'dd.MM.yyyy')
        : (r[0]||'').toString();
      map[key] = {
        shiftDate: shiftDateFmt, shiftStart: r[1], shiftEnd: r[2],
        worker: workerName, isNight: r[4], totalEntries: Number(r[5])||0,
        entries: []
      };
    }

    if (r[6]) {
      // Строки одного визита: время + время внесения + посетитель + операция
      // r[14] и r[15] могут быть Date-объектами (Excel-эпоха 1899-12-30) если ячейка
      // отформатирована как «Время» в Sheets — форматируем принудительно как HH:mm
      const fmtTime = v => v ? (v instanceof Date ? Utilities.formatDate(v, tz, 'HH:mm') : v.toString().trim()) : '';
      const timeVal     = fmtTime(r[14]);
      const timeAutoVal = fmtTime(r[15]);
      const visitKey = `${timeVal}_${timeAutoVal}_${r[6]}_${r[7]}`;
      let visit = map[key].entries.find(e => e._visitKey === visitKey);
      if (!visit) {
        visit = {
          _visitKey: visitKey,
          visitor:   reverseVisitor(r[6]),
          operation: reverseOperation(r[7]),
          orders: [],
          time:    timeVal, timeAuto: timeAutoVal,
          night:   r[16], comment:  r[17],
          date:    dateKey(r[18]) || '', // дата визита (кол. 19), yyyy-mm-dd
          timestamp: r[1],
        };
        map[key].entries.push(visit);
      }
      // Add order to this visit
      if (r[10] && r[10] !== '(нет в списке)') {
        visit.orders.push({ id: r[10], client: r[11]||'', returnDate: r[12]||'', delivery: r[13]||'' });
      } else if (r[10] === '(нет в списке)') {
        visit.isOther = true;
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

// Любое представление даты (Date | dd.MM.yyyy | yyyy-mm-dd) → 'yyyy-mm-dd' для сравнения.
// Пустая строка если распарсить не удалось.
function dateKey(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Europe/Moscow', 'yyyy-MM-dd');
  const s = v.toString().trim();
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) return m1[3] + '-' + ('0'+m1[2]).slice(-2) + '-' + ('0'+m1[1]).slice(-2);
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return m2[1] + '-' + m2[2] + '-' + m2[3];
  return '';
}

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
//  СВЕРКА: визиты «нет в списке» ↔ заказы
// ════════════════════════════════════

// Визиты «нет в списке» за последние 7 дней + заказы этих дней без записей в логе.
// Используется вкладкой «Сверка» дашборда (?action=getUnmatched).
function getUnmatchedData() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  const tz  = 'Europe/Moscow';
  const DAYS_BACK = 7;
  const cutoffISO = Utilities.formatDate(new Date(Date.now() - DAYS_BACK*86400000), tz, 'yyyy-MM-dd');
  const todayISO  = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const unmatchedVisits = [];

  if (log && log.getLastRow() >= 2) {
    const rows = log.getRange(2, 1, log.getLastRow()-1, 19).getValues();
    rows.forEach(r => {
      const workerName = r[3] ? r[3].toString().trim() : '';
      if (!workerName || workerName === 'Система') return;
      const firstOrder = r[10] ? r[10].toString().trim() : '';
      if (firstOrder !== '(нет в списке)') return;
      const dISO = dateKey(r[18]) || dateKey(r[0]);
      if (dISO && dISO < cutoffISO) return;

      const shiftStartISO = r[1] instanceof Date ? r[1].toISOString() : (r[1]||'').toString();
      const timeAuto = r[15] ? (r[15] instanceof Date ? Utilities.formatDate(r[15], tz, 'HH:mm') : r[15].toString().trim()) : '';
      const allIds = (r[8]||'').toString().split(',').map(s=>s.trim()).filter(s=>s && s!=='(нет в списке)');
      unmatchedVisits.push({
        visitKey:  shiftStartISO + '|' + workerName + '|' + timeAuto,
        shiftDate: r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'dd.MM.yyyy') : (r[0]||'').toString(),
        worker:    workerName,
        isNight:   r[4] ? r[4].toString().trim() : '',
        visitor:   {'Клиент':'client','Курьер Яндекс':'yandex','Наш курьер':'our'}[(r[6]||'').toString().trim()] || 'client',
        operation: (r[7]||'').toString().trim(),
        time:      r[14] ? (r[14] instanceof Date ? Utilities.formatDate(r[14], tz, 'HH:mm') : r[14].toString().trim()) : '',
        comment:   (r[17]||'').toString().trim(),
        orders:    allIds.map(id => ({ id }))
      });
    });
  }

  // Заказы последних 7 дней, по которым нет ни одной записи в логе
  const processed   = getProcessedOrderIds();
  const issuedSet   = new Set(processed.issued);
  const returnedSet = new Set(processed.returned);
  const unlistedOrders = [];
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (sheet && sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow()-1, 20).getValues();
    data.forEach(r => {
      if (!r[0]) return;
      const orderId = r[0].toString().trim();
      if (issuedSet.has(orderId) || returnedSet.has(orderId)) return;
      const issISO = r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'yyyy-MM-dd') : '';
      const retISO = r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'yyyy-MM-dd') : '';
      const recent = (issISO && issISO >= cutoffISO && issISO <= todayISO)
                  || (retISO && retISO >= cutoffISO && retISO <= todayISO);
      if (!recent) return;
      unlistedOrders.push({
        id:         orderId,
        client:     r[16] ? r[16].toString().trim() : '',
        issueDate:  r[2] ? Utilities.formatDate(parseDate(r[2]), tz, 'dd.MM.yyyy') : '',
        returnDate: r[4] ? Utilities.formatDate(parseDate(r[4]), tz, 'dd.MM.yyyy') : ''
      });
    });
  }

  return { unmatchedVisits, unlistedOrders };
}

// Привязывает визит «нет в списке» к реальным заказам:
// перезаписывает строку лога данными первого заказа, для остальных вставляет копии строк.
// visitKey = shiftStartISO|worker|timeAuto (из getUnmatchedData).
function linkVisitToOrders(ss, log, visitKey, orderIds) {
  if (!visitKey || !orderIds || !orderIds.length) return { success:false, error:'Нет visitKey или заказов' };
  const parts = visitKey.split('|');
  if (parts.length < 3) return { success:false, error:'Неверный visitKey' };
  const keyStart = parts[0], keyWorker = parts[1], keyTimeAuto = parts[2];
  if (log.getLastRow() < 2) return { success:false, error:'Лог пуст' };

  const tz = 'Europe/Moscow';
  const vals = log.getRange(2, 1, log.getLastRow()-1, 19).getValues();
  let rowIdx = -1;
  for (let i = 0; i < vals.length; i++) {
    const storedStart  = vals[i][1] instanceof Date ? vals[i][1].toISOString() : (vals[i][1]||'').toString();
    const storedWorker = (vals[i][3]||'').toString().trim();
    const storedTA     = vals[i][15] ? (vals[i][15] instanceof Date ? Utilities.formatDate(vals[i][15], tz, 'HH:mm') : vals[i][15].toString().trim()) : '';
    const firstOrder   = (vals[i][10]||'').toString().trim();
    if (storedStart === keyStart && storedWorker === keyWorker && storedTA === keyTimeAuto && firstOrder === '(нет в списке)') {
      rowIdx = i; break;
    }
  }
  if (rowIdx < 0) return { success:false, error:'Визит не найден в логе' };

  // Данные заказов из листа «заказы»
  const info = {};
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow()-1, 20).getValues().forEach(r => {
      if (!r[0]) return;
      const id = r[0].toString().trim();
      if (orderIds.indexOf(id) < 0) return;
      info[id] = {
        client:     r[16] ? r[16].toString().trim() : '',
        returnDate: r[4]  ? Utilities.formatDate(parseDate(r[4]), tz, 'dd.MM.yyyy') : '',
        delivery:   r[19] && r[19].toString().trim() ? 'Наша доставка' : 'Самовывоз'
      };
    });
  }

  const sheetRow = rowIdx + 2;
  const base = vals[rowIdx].slice();
  const allIds = orderIds.join(', ');
  orderIds.forEach((id, n) => {
    const inf = info[id] || { client:'', returnDate:'', delivery:'' };
    const row = base.slice();
    row[8] = allIds; row[9] = orderIds.length;
    row[10] = id; row[11] = inf.client; row[12] = inf.returnDate; row[13] = inf.delivery;
    if (n === 0) {
      log.getRange(sheetRow, 1, 1, 19).setValues([row]);
    } else {
      log.insertRowAfter(sheetRow + n - 1);
      log.getRange(sheetRow + n, 1, 1, 19).setValues([row]);
    }
  });
  return { success:true, linked: orderIds.length };
}

// ════════════════════════════════════
//  АРХИВАЦИЯ ЛОГА — запускать вручную по мере роста
// ════════════════════════════════════
// Переносит строки старше 6 месяцев в лист «log_архив», чтобы скан лога оставался быстрым.
// ⚠️ Заархивированные заказы исчезают из issued/returned — для заказов старше полугода это ок.
function archiveOldLog() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log || log.getLastRow() < 2) return;
  const tz = 'Europe/Moscow';
  const cutoffISO = Utilities.formatDate(new Date(Date.now() - 182*86400000), tz, 'yyyy-MM-dd');

  const archive = getOrCreateSheet(ss, 'log_архив');
  if (archive.getLastRow() === 0) {
    archive.appendRow(log.getRange(1, 1, 1, 19).getValues()[0]);
  }

  const vals = log.getRange(2, 1, log.getLastRow()-1, 19).getValues();
  let moved = 0;
  for (let i = vals.length-1; i >= 0; i--) {
    const dISO = dateKey(vals[i][0]);
    if (dISO && dISO < cutoffISO) {
      archive.appendRow(vals[i]);
      log.deleteRow(i+2);
      moved++;
    }
  }
  invalidateProcessedCache();
  try { SpreadsheetApp.getUi().alert('Перенесено строк в архив: ' + moved); } catch (e) {}
}

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
