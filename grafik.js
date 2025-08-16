const { google } = require("googleapis");
const moment = require("moment-timezone");
const winston = require("winston");
const { pool } = require("./db");

const logger = winston.createLogger({ level: "info", transports: [new winston.transports.Console()] });

async function getUserByIdDb(userId) {
  const [rows] = await pool.query("SELECT id, name, status FROM users WHERE id=? LIMIT 1", [userId]);
  return rows[0] || null;
}

// Инициализация Google Sheets API
const auth = new google.auth.GoogleAuth({
  keyFile: "creds.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const DAY_MAP_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

// Проверка окна отправки графика
function isScheduleSubmissionAllowed() {
  const now = moment().tz("Asia/Yekaterinburg");
  const day = now.isoWeekday(); // 1=Пн ... 7=Вс
  const time = now.format("HH:mm");
  logger.info(`[Окно приёма] День: ${day}, Время: ${time}`);
  if (
    (day === 4 && time >= "22:00") ||
    day === 5 ||
    day === 6 ||
    (day === 7 && time < "12:00")
  ) {
    logger.info("Разрешено отправлять график.");
    return true;
  }
  logger.info("Запрет на отправку графика!");
  return false;
}

// Получение границ недели
function getWeekBounds(nextWeek = false) {
  const now = moment().tz("Asia/Yekaterinburg");
  const mon = now.clone().startOf("isoWeek").add(nextWeek ? 1 : 0, "weeks");
  const sun = mon.clone().add(6, "days");
  logger.info(`Week bounds nextWeek=${nextWeek} from=${mon.format()} to=${sun.format()}`);
  return { from: mon, to: sun };
}

// Проверка наличия листа
async function sheetExists(spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return meta.data.sheets.some((sh) => sh.properties.title === title);
}

// Дублирование листа
async function duplicateWeekSheet(spreadsheetId, sourceTitle, newTitle, from, to) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sourceSheet = meta.data.sheets.find((sh) => sh.properties.title === sourceTitle);
  if (!sourceSheet) throw new Error(`Source sheet ${sourceTitle} not found`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ duplicateSheet: { sourceSheetId: sourceSheet.properties.sheetId, newSheetName: newTitle } }] },
  });

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${newTitle}'!A4:Z` });

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
    range: `'${newTitle}'!A1:I2`,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

// Создание нового листа
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

// Подготовка листа для графика
async function ensureWeekSheetAndAsk(spreadsheetId, chatId, telegram, withPrompt = true, nextWeek = true) {
 /* if (!isScheduleSubmissionAllowed()) {
    await telegram.sendMessage(chatId, "График можно отправлять только с 22:00 четверга и до 12:00 воскресенья.");
    return;
  }*/
  const { from, to } = getWeekBounds(nextWeek);
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

  return sheetName;
}

// Парсер расписания
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

// Добавление расписания
async function parseAndAppend(spreadsheetId, sheetName, text, chatId) {
  const courier = await getUserByIdDb(String(chatId));
  if (!courier || courier.status !== "approved") {
    throw new Error("У вас нет доступа к добавлению графика.");
  }
  const fio = courier.name;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B4:B`,
  });
  const names = (existing.data.values || []).map((r) => r[0]);
  if (names.includes(fio)) {
    throw new Error("Вы уже отправили график на этот период. Чтобы его просмотреть, нажмите кнопку 'Посмотреть график'.");
  }
  const pp = names.length + 1;
  const hours = parseSchedule(text);
  const row = [pp, fio, ...hours];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A4:I`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] },
  });
}

// Обновление расписания (замена)
async function upsertSchedule(spreadsheetId, sheetName, text, chatId, telegram) {
  const courier = await getUserByIdDb(String(chatId));
  if (!courier || courier.status !== "approved") {
    await telegram.sendMessage(chatId, "У вас нет доступа к изменению графика.");
    return;
  }
  const fio = courier.name;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B4:B27`,
  });
  const rows = res.data.values || [];

  let rowIdx = null;
  let names = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0]) names.push(rows[i][0]);
    if (rows[i] && rows[i][0] === fio) rowIdx = 4 + i;
  }

  let pp = null;
  if (rowIdx !== null) {
    const ppRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A${rowIdx}:A${rowIdx}`,
    });
    pp = (ppRes.data.values && ppRes.data.values[0] && ppRes.data.values[0][0]) || names.length;
  } else {
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

  const hours = parseSchedule(text);
  const row = [pp, fio, ...hours];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A${rowIdx}:I${rowIdx}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] },
  });
}

// Обновление расписания по ФИО (для админа)
async function upsertScheduleForFio(spreadsheetId, sheetName, text, fio, telegram, chatIdForErrors) {
  if (!fio || !fio.trim()) {
    await telegram.sendMessage(chatIdForErrors, "Не указано ФИО для изменения графика.");
    return;
  }
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B4:B27`,
  });
  const rows = res.data.values || [];

  let rowIdx = null;
  let names = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0]) names.push(rows[i][0]);
    if (rows[i] && rows[i][0] === fio) rowIdx = 4 + i;
  }

  let pp = null;
  if (rowIdx !== null) {
    const ppRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A${rowIdx}:A${rowIdx}`,
    });
    pp = (ppRes.data.values && ppRes.data.values[0] && ppRes.data.values[0][0]) || names.length;
  } else {
    for (let i = 0; i < 24; i++) {
      if (!rows[i] || !rows[i][0]) {
        rowIdx = 4 + i;
        break;
      }
    }
    if (rowIdx === null) {
      await telegram.sendMessage(chatIdForErrors, "Нет свободных строк для добавления графика!");
      return;
    }
    pp = names.length + 1;
  }

  const hours = parseSchedule(text);
  const row = [pp, fio, ...hours];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A${rowIdx}:I${rowIdx}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] },
  });
}

// ====================== НОВОЕ =======================
// Получить график для юзера (строкой, для editMessageText)
async function getScheduleText(spreadsheetId, userId, nextWeek = false) {
  const { from, to } = getWeekBounds(nextWeek);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A4:I27` });
  const rows = res.data.values || [];
  let text = `📋 График на период *${from.format("DD.MM")}–${to.format("DD.MM")}*:\n\n`;
  const user = await getUserByIdDb(String(userId));
  const fio = user?.name;
  if (!fio) {
    return "❌ Вы не зарегистрированы как курьер. Пройдите регистрацию /start";
  }
  const myRow = rows.find((r) => r[1] === fio);
  if (!myRow) {
    return "Ваш график на этот период не найден.";
  }
  text += myRow
    .slice(2, 9)
    .map((t, i) => `${DAY_MAP_SHORT[i]}: ${t}`)
    .join("\n");
  return text;
}

// Получить график для админа (все курьеры на выбранную неделю)
async function getAdminScheduleText(spreadsheetId, nextWeek = false) {
  const { from, to } = getWeekBounds(nextWeek);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A4:I27` });
  const rows = res.data.values || [];
  let text = `📋 График всех курьеров на период *${from.format("DD.MM")}–${to.format("DD.MM")}*:\n\n`;
  if (!rows.length) return "Ещё нет записей в графике.";
  for (const r of rows) {
    if (!r[1]) continue;
    const times = r.slice(2, 9).map((t, i) => `${DAY_MAP_SHORT[i]}: ${t}`).join("\n");
    text += `*${r[1]}*\n${times}\n\n`;
  }
  return text;
}

module.exports = {
  ensureWeekSheetAndAsk,
  parseAndAppend,
  upsertSchedule,
  upsertScheduleForFio,
  getScheduleText,
  getAdminScheduleText,
  isScheduleSubmissionAllowed,
  getWeekBounds,
  sheetExists,
  createWeekSheet,
  duplicateWeekSheet,
};
