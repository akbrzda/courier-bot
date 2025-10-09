const { google } = require("googleapis");
const moment = require("moment-timezone");
const { TIMEZONE, TEMPLATE_SHEET_NAME } = require("../config");
const { getUserById } = require("./users");

const auth = new google.auth.GoogleAuth({
  keyFile: "creds.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const DAY_MAP_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const DAY_FULL_NAMES = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const OFF_VALUE_REGEX = /(вых|выход)/i;
const MARKDOWN_ESCAPE_REGEX = /([_*\[\]()~`>#+=|{}.!])/g;

function escapeMarkdown(value = "") {
  return String(value).replace(MARKDOWN_ESCAPE_REGEX, "\\$1");
}
function isScheduleSubmissionAllowed() {
  const now = moment().tz(TIMEZONE);
  const day = now.isoWeekday();
  const time = now.format("HH:mm");
  if ((day === 4 && time >= "22:00") || day === 5 || day === 6 || (day === 7 && time < "12:00")) {
    return true;
  }
  return false;
}

function getWeekBounds(nextWeek = false) {
  const now = moment().tz(TIMEZONE);
  const mon = now
    .clone()
    .startOf("isoWeek")
    .add(nextWeek ? 1 : 0, "weeks");
  const sun = mon.clone().add(6, "days");
  return { from: mon, to: sun };
}

async function sheetExists(spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return meta.data.sheets.some((sh) => sh.properties.title === title);
}

async function loadDataRows(spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A4:I27`,
  });
  return res.data.values || [];
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, attempts = 3, delay = 120) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await wait(delay);
    }
  }
  throw lastErr;
}

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

async function ensureWeekSheetAndAsk(spreadsheetId, chatId, telegram, withPrompt = true, nextWeek = true) {
  const { from, to } = getWeekBounds(nextWeek);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const prev = getWeekBounds(false);
  const prevTitle = `${prev.from.format("DD.MM")}-${prev.to.format("DD.MM")}`;
  if (!(await sheetExists(spreadsheetId, sheetName))) {
    if (TEMPLATE_SHEET_NAME && (await sheetExists(spreadsheetId, TEMPLATE_SHEET_NAME))) {
      await duplicateWeekSheet(spreadsheetId, TEMPLATE_SHEET_NAME, sheetName, from, to);
    } else {
      await createWeekSheet(spreadsheetId, { from, to });
    }
  }
  return sheetName;
}

function parseSchedule(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const hours = Array(7).fill("вых");

  // normalize short day keys to lowercase two-letter keys: пн, вт, ср, ...
  const shortKeys = DAY_MAP_SHORT.map((d) => d.toLowerCase().slice(0, 2));

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sep = line.indexOf(":");
    if (sep === -1) throw new Error(`Неправильный формат строки: ${line}`);
    const dayPartRaw = line.slice(0, sep).trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
    const time = line.slice(sep + 1).trim();

    const key = dayPartRaw.slice(0, 2);
    const idx = shortKeys.indexOf(key);
    if (idx === -1) throw new Error(`Непонятный день: ${dayPartRaw}`);
    hours[idx] = time || hours[idx];
  }

  return hours;
}

async function parseAndAppend(spreadsheetId, sheetName, text, chatId) {
  return await withRetry(
    async () => {
      const courier = await getUserById(String(chatId));
      if (!courier || courier.status !== "approved") {
        throw new Error("У вас нет доступа к добавлению графика.");
      }
      const fio = courier.name;
      const rows = await loadDataRows(spreadsheetId, sheetName);
      const names = rows.map((r) => (r && r[1] ? r[1] : undefined)).filter(Boolean);
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
    },
    3,
    150
  );
}

async function upsertSchedule(spreadsheetId, sheetName, text, chatId, telegram) {
  const courier = await getUserById(String(chatId));
  if (!courier || courier.status !== "approved") {
    await telegram.sendMessage(chatId, "У вас нет доступа к изменению графика.");
    return;
  }
  const fio = courier.name;
  const rows = await loadDataRows(spreadsheetId, sheetName);

  let rowIdx = null;
  let names = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0]) names.push(rows[i][0]);
    if (rows[i] && rows[i][0] === fio) rowIdx = 4 + i;
  }

  let pp = null;
  if (rowIdx !== null) {
    const rowVals = rows[rowIdx - 4] || [];
    pp = rowVals[0] || names.length;
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

async function upsertScheduleForFio(spreadsheetId, sheetName, text, fio, telegram, chatIdForErrors) {
  if (!fio || !fio.trim()) {
    await telegram.sendMessage(chatIdForErrors, "Не указано ФИО для изменения графика.");
    return;
  }
  const rows = await loadDataRows(spreadsheetId, sheetName);

  let rowIdx = null;
  let names = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0]) names.push(rows[i][0]);
    if (rows[i] && rows[i][0] === fio) rowIdx = 4 + i;
  }

  let pp = null;
  if (rowIdx !== null) {
    const rowVals = rows[rowIdx - 4] || [];
    pp = rowVals[0] || names.length;
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
async function getScheduleText(spreadsheetId, userId, nextWeek = false) {
  const { from, to } = getWeekBounds(nextWeek);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A4:I27` });
  const rows = res.data.values || [];
  let text = `📋 График на период *${from.format("DD.MM")}–${to.format("DD.MM")}*:\n\n`;
  const user = await getUserById(String(userId));
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

async function getAdminScheduleText(spreadsheetId, nextWeek = false) {
  const { from, to } = getWeekBounds(nextWeek);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A4:I27` });
  const rows = res.data.values || [];
  const dayBuckets = buildDayBuckets(rows);
  if (!dayBuckets.hasData) {
    return "Ещё нет записей в графике.";
  }
  const header = `📋 График всех курьеров на период *${from.format("DD.MM")}–${to.format("DD.MM")}*:\n`;
  return `${header}\n${formatBucketsByDay(dayBuckets.buckets)}`;
}

async function getBranchScheduleText(spreadsheetId, branchId, branchLabel = "Филиал", nextWeek = false) {
  const { from, to } = getWeekBounds(nextWeek);
  const sheetName = `${from.format("DD.MM")}-${to.format("DD.MM")}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A4:I27` });
  const rows = res.data.values || [];

  const filteredRows = rows;

  const dayBuckets = buildDayBuckets(filteredRows);
  if (!dayBuckets.hasData) {
    return `В графике на период *${from.format("DD.MM")}–${to.format("DD.MM")}* нет записей.`;
  }

  const header = `📋 График филиала ${escapeMarkdown(branchLabel)} на период *${from.format("DD.MM")}–${to.format("DD.MM")}*:\n`;
  return `${header}\n${formatBucketsByDay(dayBuckets.buckets)}`;
}

function buildDayBuckets(rows) {
  const buckets = DAY_MAP_SHORT.map(() => ({
    working: [],
    off: [],
    unknown: [],
  }));

  for (const row of rows) {
    if (!row || !row[1]) continue;
    const name = String(row[1]).trim();
    if (!name) continue;

    for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
      const cellRaw = row[2 + dayIdx];
      const cell = cellRaw === undefined || cellRaw === null ? "" : String(cellRaw).trim();
      const bucket = buckets[dayIdx];

      if (!cell) {
        bucket.unknown.push(name);
        continue;
      }

      if (OFF_VALUE_REGEX.test(cell)) {
        bucket.off.push(name);
        continue;
      }

      bucket.working.push({ name, shift: cell });
    }
  }

  const hasData = buckets.some((bucket) => bucket.working.length || bucket.off.length || bucket.unknown.length);

  return { buckets, hasData };
}

function parseShiftStartMinutes(shift) {
  if (!shift) return Number.MAX_SAFE_INTEGER;
  const match = String(shift).match(/(\d{1,2})[:.]?(\d{2})?/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  if (Number.isNaN(hours) || hours < 0) return Number.MAX_SAFE_INTEGER;
  const clampedMinutes = Number.isNaN(minutes) || minutes < 0 ? 0 : Math.min(minutes, 59);
  return hours * 60 + clampedMinutes;
}

function formatBucketsByDay(buckets) {
  const sections = [];

  buckets.forEach((bucket, idx) => {
    bucket.working.sort((a, b) => {
      const diff = parseShiftStartMinutes(a.shift) - parseShiftStartMinutes(b.shift);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, "ru");
    });

    bucket.off.sort((a, b) => a.localeCompare(b, "ru"));
    bucket.unknown.sort((a, b) => a.localeCompare(b, "ru"));

    const lines = [];
    lines.push(`*${DAY_MAP_SHORT[idx]} (${DAY_FULL_NAMES[idx]})*`);

    lines.push(`Работают (${bucket.working.length}):`);
    if (bucket.working.length) {
      bucket.working.forEach(({ name, shift }, idx) => {
        lines.push(`${idx + 1}. ${escapeMarkdown(name)} — ${escapeMarkdown(shift)}`);
      });
    } else {
      lines.push("0. —");
    }

    lines.push(`\nВыходной (${bucket.off.length}):`);
    if (bucket.off.length) {
      bucket.off.forEach((name, idx) => {
        lines.push(`${idx + 1}. ${escapeMarkdown(name)}`);
      });
    } else {
      lines.push("0. —");
    }

    if (bucket.unknown.length) {
      lines.push(`Не указан (${bucket.unknown.length}):`);
      bucket.unknown.forEach((name, idx) => {
        lines.push(`${idx + 1}. ${escapeMarkdown(name)}`);
      });
    }

    sections.push(lines.join("\n"));
  });

  return sections.join("\n\n\n");
}

module.exports = {
  ensureWeekSheetAndAsk,
  parseAndAppend,
  upsertSchedule,
  upsertScheduleForFio,
  parseSchedule,
  getScheduleText,
  getAdminScheduleText,
  getBranchScheduleText,
  isScheduleSubmissionAllowed,
  getWeekBounds,
  sheetExists,
  createWeekSheet,
  duplicateWeekSheet,
};
