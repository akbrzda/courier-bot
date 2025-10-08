const moment = require("moment-timezone");
const { TIMEZONE } = require("../config");

const DEFAULT_ALLOWED = ["Табель", "График", "Авторизация"];
const allowedHashtags = process.env.LOG_ALLOWED_HASHTAGS
  ? process.env.LOG_ALLOWED_HASHTAGS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : DEFAULT_ALLOWED;

const LOG_TO_TOPIC = String(process.env.LOG_TO_TOPIC || "false").toLowerCase() === "true";
const LOG_GROUP_ID = process.env.LOG_GROUP_ID;
const LOG_TOPIC_ID = process.env.LOG_TOPIC_ID ? parseInt(process.env.LOG_TOPIC_ID, 10) : null;

// ---- custom log
function sendLog(bot, message, options = {}) {
  if (LOG_TO_TOPIC && LOG_GROUP_ID && LOG_TOPIC_ID) {
    const msgOptions = { message_thread_id: LOG_TOPIC_ID, ...options };
    bot.telegram.sendMessage(LOG_GROUP_ID, message, msgOptions).catch((err) => console.error("Failed to send log to topic:", err));
  }
}

// ---- custom error log
function sendError(bot, message) {
  console.error(message);
  if (LOG_TO_TOPIC && LOG_GROUP_ID && LOG_TOPIC_ID) {
    bot.telegram
      .sendMessage(LOG_GROUP_ID, `❌ Ошибка: ${message}`, { message_thread_id: LOG_TOPIC_ID })
      .catch((err) => console.error("Failed to send error to topic:", err));
  }
}

async function sendLogToGroup(bot, logMessage, hashtag = "Логи") {
  if (!LOG_GROUP_ID) return;

  if (!allowedHashtags.includes(hashtag)) return;

  try {
    const formattedMessage = `#${hashtag}\n\n${logMessage}`;
    sendLog(bot, formattedMessage, { parse_mode: "HTML" });
  } catch (error) {
    console.error(error.message);
  }
}

async function logAction(bot, action, userId, userInfo = {}, additionalData = {}, hashtag = "Логи") {
  const timestamp = moment().tz(TIMEZONE).format("DD.MM.YYYY | HH:mm");
  const groupMessage = `🕐 <b>${timestamp}</b>\n👤 <b>Пользователь:</b> ${userInfo.name || "Неизвестно"} (ID: ${
    userInfo.username || userId
  })\n📝 <b>Действие:</b> ${action}${Object.keys(additionalData).length ? `\n📊 <b>Данные:</b> ${JSON.stringify(additionalData, null, 2)}` : ""}`;
  await sendLogToGroup(bot, groupMessage, hashtag);
}

async function logTabReport(bot, userId, userInfo, period, additionalData = {}) {
  await logAction(bot, "Запрос табеля", userId, userInfo, { period, ...additionalData }, "Табель");
}

async function logScheduleAction(bot, userId, userInfo, action, additionalData = {}) {
  await logAction(bot, `График: ${action}`, userId, userInfo, additionalData, "График");
}

async function logAuthAction(bot, userId, userInfo, action, additionalData = {}) {
  await logAction(bot, `Авторизация: ${action}`, userId, userInfo, additionalData, "Авторизация");
}

async function logError(bot, error, userId, userInfo = {}, context = "") {
  // По умолчанию не шлём подробные ошибки в группу. Логи ошибок пишем в консоль.
  const timestamp = moment().tz(TIMEZONE).format("DD.MM.YYYY | HH:mm");
  const safeUser = userInfo && userInfo.name ? userInfo.name : "Неизвестно";
  const safeId = (userInfo && userInfo.username) || userId;
  const errMessage = String(error && error.message) || String(error);
  const contextShort = String(context).length > 200 ? String(context).slice(0, 200) + "..." : context;

  console.error(`[${timestamp}] ERROR for ${safeUser} (ID: ${safeId}) - ${contextShort} - ${errMessage}`);
  if (error && error.stack) console.error(error.stack);

  // Если явно разрешено через env, отправим краткое уведомление в группу (без стека)
  if (String(process.env.SEND_ERRORS_TO_GROUP || "false").toLowerCase() === "true") {
    const groupMessage = `❌ <b>ОШИБКА</b>\n🕐 <b>${timestamp}</b>\n👤 <b>Пользователь:</b> ${safeUser} (ID: ${safeId})\n📝 <b>Контекст:</b> ${contextShort}\n💥 <b>Ошибка:</b> ${errMessage}`;
    sendError(bot, groupMessage);
  }
}

async function logBotStart(bot, userId, userInfo, isAdmin = false) {
  await logAction(bot, "Запуск бота", userId, userInfo, { isAdmin }, "Авторизация");
}

async function logMenuNavigation(bot, userId, userInfo, menu, additionalData = {}) {
  await logAction(bot, `Навигация: ${menu}`, userId, userInfo, additionalData, "Логи");
}

async function logMessageSent(bot, userId, userInfo, messageType, additionalData = {}) {
  await logAction(bot, `Отправка: ${messageType}`, userId, userInfo, additionalData, "Логи");
}

module.exports = {
  logAction,
  logTabReport,
  logScheduleAction,
  logAuthAction,
  logError,
  logBotStart,
  logMenuNavigation,
  logMessageSent,
  sendLogToGroup,
  sendLog,
  sendError,
};
