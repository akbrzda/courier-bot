// grafik.js

const { google } = require("googleapis");
const moment = require("moment-timezone");
const winston = require("winston");

// Настройка логгера
const logger = winston.createLogger({ level: "info", transports: [new winston.transports.Console()] });

// База курьеров: ключ — chatId, значение — { name, status }
const couriers = require("./users.json");

// Инициализация Google Sheets API
const auth = new google.auth.GoogleAuth({ keyFile: "creds.json", scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

// Карта дней недели
const DAY_MAP_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function isScheduleSubmissionAllowed() {
  const now = moment().tz("Asia/Yekaterinburg");
  const day = now.isoWeekday(); // 1=Пн ... 7=Вс
  const time = now.format("HH:mm");
  logger.info(`[Окно приёма] День: ${day}, Время: ${time}`);
  if (
    // Четверг с 22:00 до 23:59
    (day === 4 && time >= "22:00") ||
    // Пятница (весь день)
    day === 5 ||
    // Суббота (весь день)
    day === 6 ||
    // Воскресенье до 12:00
    (day === 7 && time < "12:00")
  ) {
    logger.info("Разрешено отправлять график.");
    return true;
  }
  logger.info("Запрет на отправку графика!");
  return false;
}

/**
 * Вычисляет границы недели (понедельник – воскресенье).
 * @param {boolean} nextWeek — true для следующей недели, false для текущей.
 */
function getWeekBounds(nextWeek = false) {
  const now = moment().tz("asia/yekaterinburg");
  const mon = now
    .clone()
    .startOf("isoWeek")
    .add(nextWeek ? 1 : 0, "weeks");
  const sun = mon.clone().add(6, "days");
  logger.info(`Week bounds nextWeek=${nextWeek} from=${mon.format()} to=${sun.format()}`);
  return { from: mon, to: sun };
}

/**
 * Проверяет наличие листа с указанным названием.
 */
async function sheetExists(spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return meta.data.sheets.some((sh) => sh.properties.title === title);
}

/**
 * Дублирует лист предыдущего периода и очищает данные строк ниже заголовков,
 * а также обновляет шапку с датами и днями недели.
 */
async function duplicateWeekSheet(spreadsheetId, sourceTitle, newTitle, from, to) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sourceSheet = meta.data.sheets.find((sh) => sh.properties.title === sourceTitle);
  if (!sourceSheet) throw new Error(`Source sheet ${sourceTitle} not found`);

  // Копируем лист
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ duplicateSheet: { sourceSheetId: sourceSheet.properties.sheetId, newSheetName: newTitle } }] },
  });

  // Очищаем данные с 4-й строки (A4:Z)
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${newTitle}'!A4:Z` });

  // Формируем новые значения шапки (A1:I2)
  const dates = [];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = from.clone().add(i, "days");
    dates.push(d.format("DD.MM"));
    days.push(DAY_MAP_SHORT[i].toLowerCase());
  }
  const values = [
    ["№ п/п", "ФИО", ...dates],
    ["", "", ...days],
  ];

  // Обновляем шапку новыми датами
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${newTitle}'!A1:I2`,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

/**
 * Создаёт новый лист и заполняет заголовки дат и дней.
 */
async function createWeekSheet(spreadsheetId, { from, to }) {
  const title = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 30, columnCount: 10 } } } }] },
  });
  const dates = [];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = from.clone().add(i, "days");
    dates.push(d.format("DD.MM"));
    days.push(DAY_MAP_SHORT[i].toLowerCase());
  }
  const values = [
    ["№ п/п", "ФИО", ...dates],
    ["", "", ...days],
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1:I2`,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
  return title;
}

/**
 * Приветствует курьера и приглашает прислать график,
 * создавая лист для следующей недели при необходимости.
 */
async function ensureWeekSheetAndAsk(spreadsheetId, chatId, telegram, withPrompt = true) {
  /*   if (!isScheduleSubmissionAllowed()) {
    await telegram.sendMessage(chatId, "График можно отправить только с 22:00 четверга и до 12:00 воскресенья.");
    return;
  } */
  const { from, to } = getWeekBounds(true);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const prev = getWeekBounds(false);
  const prevTitle = `${prev.from.format("DD.MM")}-${prev.to.format("DD.MM")}`;
  if (!(await sheetExists(spreadsheetId, sheetName))) {
    if (await sheetExists(spreadsheetId, prevTitle)) {
      await duplicateWeekSheet(spreadsheetId, prevTitle, sheetName, from, to);
    } else {
      await createWeekSheet(spreadsheetId, { from, to });
    }
  }
  if (withPrompt) {
    const prompt = `📅 Пришлите ваш график на период *${from.format("DD.MM")}–${to.format("DD.MM")}* в формате:\n\nПн: 10-23\nВт: 10-23\n…`;
    await telegram.sendMessage(chatId, prompt, { parse_mode: "Markdown" });
  }
  return sheetName;
}

/**
 * Парсит текст с расписанием курьера.
 */
function parseSchedule(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const hours = Array(7).fill("вых");
  for (const line of lines) {
    const [dayPart, time] = line.split(":").map((p) => p.trim());
    const idx = DAY_MAP_SHORT.indexOf(dayPart);
    if (idx === -1) throw new Error(`Непонятный день: ${dayPart}`);
    hours[idx] = time;
  }
  return hours;
}

/**
 * Читает ФИО из базы по chatId и добавляет строку с расписанием.
 * Отслеживает дубли на основе столбца B.
 */
async function parseAndAppend(spreadsheetId, sheetName, text, chatId) {
  const courier = couriers[String(chatId)];
  if (!courier || courier.status !== "approved") {
    throw new Error("У вас нет доступа к добавлению графика.");
  }
  const fio = courier.name;
  // Проверяем дублирование: читаем столбец B начиная с 3-й строки
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B4:B`,
  });
  const names = (existing.data.values || []).map((r) => r[0]);
  if (names.includes(fio)) {
    throw new Error("Вы уже отправили график на этот период. Чтобы его просмотреть, нажмите кнопку 'Посмотреть график'.");
  }
  // Определяем ПП (порядковый номер)
  const pp = names.length + 1;
  // Парсим и добавляем новую запись
  const hours = parseSchedule(text);
  const row = [pp, fio, ...hours];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A4:I`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] },
  });
}

/**
 * Отправляет сохранённый график в чат.
 */
async function showSchedule(spreadsheetId, chatId, telegram, nextWeek = false, isAdmin = false, fio = null) {
  const { from, to } = getWeekBounds(nextWeek);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A4:I27` });
  const rows = res.data.values || [];

  let text = `📋 График на период *${from.format("DD.MM")}–${to.format("DD.MM")}*:\n\n`;

  if (isAdmin) {
    if (!rows.length) {
      await telegram.sendMessage(chatId, "Ещё нет записей в графике.");
      return;
    }
    for (const r of rows) {
      if (!r[1]) continue;
      const times = r
        .slice(2, 9)
        .map((t, i) => `${DAY_MAP_SHORT[i]}: ${t}`)
        .join("\n");
      text += `*${r[1]}*\n${times}\n\n`;
    }
  } else {
    const myRow = rows.find((r) => r[1] === fio);
    if (!myRow) {
      await telegram.sendMessage(chatId, "Ваш график на этот период не найден.");
      return;
    }
    text += myRow
      .slice(2, 9)
      .map((t, i) => `${DAY_MAP_SHORT[i]}: ${t}`)
      .join("\n");
  }
  await telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function upsertSchedule(spreadsheetId, sheetName, text, chatId, telegram) {
  // Проверка временного окна, доступа и т.д. — как в parseAndAppend

  const courier = couriers[String(chatId)];
  if (!courier || courier.status !== "approved") {
    await telegram.sendMessage(chatId, "У вас нет доступа к изменению графика.");
    return;
  }
  const fio = courier.name;

  // Получаем диапазон расписаний
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B4:B27`,
  });
  const rows = res.data.values || [];

  // Находим первую строку с этим ФИО
  let rowIdx = null;
  let names = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0]) names.push(rows[i][0]);
    if (rows[i] && rows[i][0] === fio) rowIdx = 4 + i;
  }

  // Определяем ПП (порядковый номер)
  let pp = null;
  if (rowIdx !== null) {
    // Если курьер уже есть — взять старый ПП
    const ppRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A${rowIdx}:A${rowIdx}`,
    });
    pp = (ppRes.data.values && ppRes.data.values[0] && ppRes.data.values[0][0]) || names.length; // если вдруг пусто, взять длину names
  } else {
    // Если нет — добавить в первую пустую строку
    for (let i = 0; i < 24; i++) {
      if (!rows[i] || !rows[i][0]) {
        rowIdx = 4 + i;
        break;
      }
    }
    if (rowIdx === null) {
      await telegram.sendMessage(chatId, "Нет свободных строк для добавления графика!");
      return;
    }
    pp = names.length + 1;
  }

  // Парсим и добавляем/обновляем запись
  const hours = parseSchedule(text);
  const row = [pp, fio, ...hours];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A${rowIdx}:I${rowIdx}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] },
  });
}

module.exports = { ensureWeekSheetAndAsk, parseAndAppend, showSchedule, upsertSchedule };
