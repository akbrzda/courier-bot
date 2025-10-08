const { google } = require("googleapis");
const { BRANCHES, REPORT_SHEET_ID } = require("../config");
const { getUserById } = require("../services/users");

function escapeHtml(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseDate(str) {
  if (!str || typeof str !== "string" || !str.includes(".")) return null;
  const [day, month, year] = str.split(".");
  return new Date(`${month}/${day}/${year}`);
}

function getPreviousWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const currentMonday = new Date(now);
  currentMonday.setDate(now.getDate() - ((day + 6) % 7));
  const lastMonday = new Date(currentMonday);
  lastMonday.setDate(currentMonday.getDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  lastMonday.setHours(0, 0, 0, 0);
  lastSunday.setHours(23, 59, 59, 999);
  return { fromDate: lastMonday, toDate: lastSunday };
}

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { fromDate: monday, toDate: sunday };
}

async function sendReportText(userId, period, customRangeInput) {
  const user = await getUserById(userId);
  if (!user || user.status !== "approved") {
    return "❌ Доступ запрещен. Пройдите регистрацию /start";
  }
  if (!REPORT_SHEET_ID) {
    throw new Error("Не указан идентификатор таблицы с табелями (SHEET_ID)");
  }
  const fullName = user.name.trim().toLowerCase();
  const auth = new google.auth.GoogleAuth({
    keyFile: "creds.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const sheetNames = BRANCHES.map((branch) => branch.label);

  let allRows = [];
  for (const sheetName of sheetNames) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: REPORT_SHEET_ID,
      range: `${sheetName}!A2:Z`,
    });
    if (res.data.values) allRows.push(...res.data.values);
  }
  const rows = allRows;

  if (period === "today" || period === "yesterday") {
    const today = new Date();
    const target = new Date(today);
    if (period === "yesterday") target.setDate(today.getDate() - 1);
    const targetStr = target.toLocaleDateString("ru-RU");

    const match = rows.find((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDateStr = r[1];
      const rowDate = parseDate(rowDateStr);
      return rowName === fullName && rowDate?.toLocaleDateString("ru-RU") === targetStr;
    });
    if (!match) {
      return `Данных за ${period === "today" ? "сегодня" : "вчера"} нет.`;
    }
    const [, date, , , , , , hours, km, orders, , , , times, nps, , , , , , , zaezd1, zaezd2, salary] = match;
    const totalZaezd = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
    return (
      `<b>📅 ${escapeHtml(date)}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>\n\n` +
      `• Отработано: <b>${escapeHtml(hours)}</b>\n` +
      `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
      `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezd)}</b>\n` +
      `• Сумма: <b>${escapeHtml(salary)}</b> ₽`
    );
  }

  if (period === "last_week") {
    const { fromDate, toDate } = getPreviousWeekRange();
    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDateStr = r[1];
      const rowDate = parseDate(rowDateStr);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return `Нет данных за прошлую неделю (${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let times = "",
      rating = "";
    let message =
      `<b>📅 Табель за прошлую неделю</b>\n` +
      `Период: <b>${fromDate.toLocaleDateString("ru-RU")} – ${toDate.toLocaleDateString("ru-RU")}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const totalZaezd = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      message +=
        `\n\n📆 <b>${escapeHtml(date)}</b>\n` +
        `• Отработано: <b>${escapeHtml(hours)}</b> ч\n` +
        `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
        `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
        `• Заезды: <b>${escapeHtml(totalZaezd)}</b>\n` +
        `• Сумма: <b>${escapeHtml(salary)}</b> ₽`;
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0, 10);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += totalZaezd;
      times = time;
      rating = nps;
    }
    message +=
      `\n\n<b>ИТОГО</b>\n` +
      `• Отработано: <b>${escapeHtml(totalHours)}</b> ч\n` +
      `• Пробег: <b>${escapeHtml(totalKm)}</b> км\n` +
      `• Заказов: <b>${escapeHtml(totalOrders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezdy)}</b>\n` +
      `• Заработано: <b>${escapeHtml(totalSalary.toFixed(2))}</b> ₽\n` +
      `• Рейтинг: <b>${escapeHtml(rating)}</b>\n` +
      `• Среднее время: <b>${escapeHtml(times)}</b> мин`;
    return message;
  }

  if (period === "current_week") {
    const { fromDate, toDate } = getCurrentWeekRange();
    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDate = parseDate(r[1]);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return `Нет данных за текущую неделю (${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let times = "",
      rating = "";
    let message =
      `<b>📅 Табель за текущую неделю</b>\n` +
      `Период: <b>${fromDate.toLocaleDateString("ru-RU")} – ${toDate.toLocaleDateString("ru-RU")}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const totalZaezd = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      message +=
        `\n\n📆 <b>${escapeHtml(date)}</b>\n` +
        `• Отработано: <b>${escapeHtml(hours)}</b> ч\n` +
        `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
        `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
        `• Заезды: <b>${escapeHtml(totalZaezd)}</b>\n` +
        `• Сумма: <b>${escapeHtml(salary)}</b> ₽`;
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0, 10);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += totalZaezd;
      times = time;
      rating = nps;
    }
    message +=
      `\n\n<b>ИТОГО</b>\n` +
      `• Отработано: <b>${escapeHtml(totalHours)}</b> ч\n` +
      `• Пробег: <b>${escapeHtml(totalKm)}</b> км\n` +
      `• Заказов: <b>${escapeHtml(totalOrders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezdy)}</b>\n` +
      `• Заработано: <b>${escapeHtml(totalSalary.toFixed(2))}</b> ₽\n` +
      `• Рейтинг: <b>${escapeHtml(rating)}</b>\n` +
      `• Среднее время: <b>${escapeHtml(times)}</b> мин`;
    return message;
  }

  if (period === "current_month" || period === "last_month") {
    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    if (period === "last_month") {
      fromDate.setMonth(fromDate.getMonth() - 1);
      toDate.setMonth(toDate.getMonth() - 1);
      toDate.setDate(new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate());
    }
    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);
    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDate = parseDate(r[1]);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return `Нет данных за ${period === "current_month" ? "текущий" : "прошлый"} месяц (${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let lastTime = "",
      lastRating = "";
    let message =
      `<b>📅 Табель за ${period === "current_month" ? "текущий" : "прошлый"} месяц</b>\n` +
      `Период: <b>${fromDate.toLocaleDateString("ru-RU")} – ${toDate.toLocaleDateString("ru-RU")}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const zaezdy = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      message +=
        `\n\n📆 <b>${escapeHtml(date)}</b>\n` +
        `• Отработано: <b>${escapeHtml(hours)}</b> ч\n` +
        `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
        `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
        `• Заезды: <b>${escapeHtml(zaezdy)}</b>\n` +
        `• Сумма: <b>${escapeHtml(salary)}</b> ₽`;
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0, 10);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += zaezdy;
      lastTime = time;
      lastRating = nps;
    }
    message +=
      `\n\n<b>ИТОГО</b>\n` +
      `• Отработано: <b>${escapeHtml(totalHours)}</b> ч\n` +
      `• Пробег: <b>${escapeHtml(totalKm)}</b> км\n` +
      `• Заказов: <b>${escapeHtml(totalOrders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezdy)}</b>\n` +
      `• Заработано: <b>${escapeHtml(totalSalary.toFixed(2))}</b> ₽\n` +
      `• Рейтинг: <b>${escapeHtml(lastRating)}</b>\n` +
      `• Среднее время: <b>${escapeHtml(lastTime)}</b> мин`;
    return message;
  }

  if (period === "custom") {
    if (!customRangeInput || !/\d{2}\.\d{2}\.\d{4}-\d{2}\.\d{2}\.\d{4}/.test(customRangeInput)) {
      throw new Error("Некорректный формат. Используйте ДД.ММ.ГГГГ-ДД.ММ.ГГГГ");
    }
    const [fromStr, toStr] = customRangeInput.split("-");
    const fromDate = parseDate(fromStr);
    const toDate = parseDate(toStr);
    if (!fromDate || !toDate || fromDate > toDate) {
      throw new Error("Некорректные даты в периоде");
    }
    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);
    const daysInRange = Math.floor((toDate - fromDate) / (24 * 60 * 60 * 1000)) + 1;
    const summarizeOnly = daysInRange > 7;
    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDate = parseDate(r[1]);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return `Нет данных за период (${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let lastTime = "",
      lastRating = "";
    let message =
      `<b>📅 Табель за период</b>\n` +
      `Период: <b>${fromDate.toLocaleDateString("ru-RU")} – ${toDate.toLocaleDateString("ru-RU")}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const zaezdy = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      if (!summarizeOnly) {
        message +=
          `\n\n📆 <b>${escapeHtml(date)}</b>\n` +
          `• Отработано: <b>${escapeHtml(hours)}</b> ч\n` +
          `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
          `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
          `• Заезды: <b>${escapeHtml(zaezdy)}</b>\n` +
          `• Сумма: <b>${escapeHtml(salary)}</b> ₽`;
      }
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0, 10);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += zaezdy;
      lastTime = time;
      lastRating = nps;
    }
    message +=
      `\n\n<b>ИТОГО</b>\n` +
      `• Отработано: <b>${escapeHtml(totalHours)}</b> ч\n` +
      `• Пробег: <b>${escapeHtml(totalKm)}</b> км\n` +
      `• Заказов: <b>${escapeHtml(totalOrders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezdy)}</b>\n` +
      `• Заработано: <b>${escapeHtml(totalSalary.toFixed(2))}</b> ₽\n` +
      `• Рейтинг: <b>${escapeHtml(lastRating)}</b>\n` +
      `• Среднее время: <b>${escapeHtml(lastTime)}</b> мин`;
    return message;
  }

  throw new Error("Неизвестный период");
}

module.exports = {
  sendReportText,
  escapeHtml,
  parseDate,
  getPreviousWeekRange,
  getCurrentWeekRange,
};
