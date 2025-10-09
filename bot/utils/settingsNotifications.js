const { pendingSettingsNotifications } = require("../state");

function getRequestEntry(key) {
  return pendingSettingsNotifications.get(key) || null;
}

function setRequestEntry(key, payload = {}) {
  const entry = { payload: { ...payload }, messages: [] };
  pendingSettingsNotifications.set(key, entry);
  return entry;
}

function appendMessageToEntry(key, messageInfo) {
  if (!messageInfo || !messageInfo.chatId || !messageInfo.messageId) return;
  const entry = pendingSettingsNotifications.get(key);
  if (!entry) {
    pendingSettingsNotifications.set(key, { payload: {}, messages: [messageInfo] });
    return;
  }
  entry.messages.push(messageInfo);
}

async function clearRequestEntry(bot, key, options = {}) {
  const entry = pendingSettingsNotifications.get(key);
  if (!entry) return;
  const skipChatId = options?.skip?.chatId ? String(options.skip.chatId) : null;
  const skipMessageId = options?.skip?.messageId ?? null;
  for (const msg of entry.messages || []) {
    if (!msg || !msg.chatId || !msg.messageId) continue;
    const chatIdStr = String(msg.chatId);
    if (skipChatId && chatIdStr === skipChatId && skipMessageId === msg.messageId) {
      continue;
    }
    try {
      await bot.telegram.deleteMessage(chatIdStr, msg.messageId);
    } catch (err) {
      if (err?.response?.error_code !== 400) {
        console.warn("Не удалось удалить сообщение запроса настроек:", err.message);
      }
    }
  }
  pendingSettingsNotifications.delete(key);
}

function normalizeRecipientId(recipient) {
  if (!recipient) return null;
  if (typeof recipient === "object" && recipient.id) return String(recipient.id);
  return String(recipient);
}

async function notifyRecipients(bot, key, recipients, message, keyboard = null, opts = {}) {
  const delivered = [];
  for (const recipient of recipients) {
    const chatId = normalizeRecipientId(recipient);
    if (!chatId) continue;
    try {
      const sendOptions = keyboard ? { reply_markup: keyboard.reply_markup } : undefined;
      const sent = await bot.telegram.sendMessage(chatId, message, sendOptions);
      if (sent?.message_id) {
        appendMessageToEntry(key, { chatId, messageId: sent.message_id });
      }
      delivered.push(chatId);
    } catch (err) {
      if (typeof opts.onError === "function") {
        await opts.onError(err, chatId);
      } else {
        console.error("Не удалось отправить уведомление о запросе настроек:", err.message);
      }
    }
  }
  return delivered;
}

module.exports = {
  getRequestEntry,
  setRequestEntry,
  appendMessageToEntry,
  clearRequestEntry,
  notifyRecipients,
};
