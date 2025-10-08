const { Markup } = require("telegraf");
const { ADMIN_IDS, ROLES, SPREADSHEET_ID } = require("../../config");
const {
  getScheduleMenuInline,
  getReportMenuInline,
  getBackInlineMenu,
  getMainMenuInline,
  adminMenu,
} = require("../menus");
const {
  logTabReport,
  logError,
  logScheduleAction,
  logAction,
  logMessageSent,
} = require("../../services/logger");
const { getUserById } = require("../../services/users");
const {
  ensureWeekSheetAndAsk,
  parseAndAppend,
  upsertSchedule,
} = require("../../services/schedule");
const { sendReportText } = require("../reporting");

function registerTextHandlers(bot) {
  bot.on("text", async (ctx) => {
    ctx.session = ctx.session || {};
    const userId = ctx.from.id.toString();

    if (ctx.session.awaitingCustomReport) {
      ctx.session.awaitingCustomReport = false;
      const input = ctx.message.text.trim();
      const user = await getUserById(userId);
      const userInfo = {
        name: user?.name || "Неизвестно",
        username: user?.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };

      try {
        await logTabReport(bot, userId, userInfo, "custom", { customPeriod: input });
        const text = await sendReportText(userId, "custom", input);
        const msgId = ctx.session.lastReportMsgId;
        if (msgId) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            msgId,
            null,
            text,
            { parse_mode: "HTML", ...getBackInlineMenu("menu:report") }
          );
        } else {
          await ctx.reply(text, { parse_mode: "HTML", ...getReportMenuInline() });
        }
      } catch (e) {
        await logError(bot, e, userId, userInfo, `Запрос кастомного табеля за период: ${input}`);
        const msgId = ctx.session.lastReportMsgId;
        if (msgId) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            msgId,
            null,
            "❗ " + e.message,
            getBackInlineMenu("menu:report")
          );
        } else {
          await ctx.reply("❗ " + e.message, getReportMenuInline());
        }
      }
      return;
    }

    if (ctx.session.awaitingSupportMessage || ctx.session.supportChatActive) {
      const text = ctx.message.text?.trim();
      const user = await getUserById(userId);
      const userInfo = {
        name: user?.name || "Неизвестно",
        username: user?.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };

      if (!text) {
        await logAction(bot, "попытка отправки пустого сообщения в поддержку", userId, userInfo);
        return ctx.reply("Пустое сообщение. Отменено.", getMainMenuInline(ctx.state?.currentUser));
      }

      try {
        await logMessageSent(bot, userId, userInfo, "сообщение в поддержку", {
          messageLength: text.length,
          supportChatActive: ctx.session.supportChatActive,
        });

        for (const admin of ADMIN_IDS) {
          try {
            await bot.telegram.sendMessage(
              admin,
              `📥 Новое обращение от курьера:\n` +
                `👤 ${user ? user.name : userId} (ID: ${userId})\n\n` +
                `${text}`,
              Markup.inlineKeyboard([
                [Markup.button.callback(`✍️ Ответить ${user ? user.name : userId}`, `support_reply:${userId}`)],
              ])
            );
          } catch (e) {
            console.warn("Не удалось отправить обращение администратору", admin, e.message);
            await logError(bot, e, userId, userInfo, "Отправка сообщения администратору");
          }
        }
        if (!ctx.session.supportChatActive) {
          await ctx.reply("✅ Сообщение отправлено администратору. Ожидайте ответ.");
        }
      } catch (e) {
        await logError(bot, e, userId, userInfo, "Обработка сообщения в поддержку");
        await ctx.reply("❗ Не удалось отправить сообщение. Попробуйте позже.");
      }
      return;
    }

    if (ctx.session.awaitingSchedule && ctx.session.scheduleMode === "send") {
      ctx.session.awaitingSchedule = false;
      const user = await getUserById(userId);
      const userInfo = {
        name: user?.name || "Неизвестно",
        username: user?.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };

      try {
        await logScheduleAction(bot, userId, userInfo, "отправка графика", {
          scheduleText:
            ctx.message.text.trim().substring(0, 100) +
            (ctx.message.text.trim().length > 100 ? "..." : ""),
        });

        ctx.session.currentSheet = await ensureWeekSheetAndAsk(
          SPREADSHEET_ID,
          ctx.chat.id,
          ctx.telegram,
          false,
          !!ctx.session.scheduleNextWeek
        );
        await parseAndAppend(SPREADSHEET_ID, ctx.session.currentSheet, ctx.message.text.trim(), userId);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.session.lastInlineMsgId,
          null,
          "✅ График сохранён!",
          getScheduleMenuInline(ctx.state?.currentUser)
        );
      } catch (e) {
        await logError(bot, e, userId, userInfo, "Сохранение графика");
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.session.lastInlineMsgId,
          null,
          "❗ " + e.message,
          getScheduleMenuInline(ctx.state?.currentUser)
        );
      }
      return;
    }

    if (ctx.session.awaitingSchedule && ctx.session.scheduleMode === "edit") {
      ctx.session.awaitingSchedule = false;
      const user = await getUserById(userId);
      const userInfo = {
        name: user?.name || "Неизвестно",
        username: user?.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };

      try {
        await logScheduleAction(bot, userId, userInfo, "редактирование графика", {
          scheduleText:
            ctx.message.text.trim().substring(0, 100) +
            (ctx.message.text.trim().length > 100 ? "..." : ""),
        });

        ctx.session.currentSheet = await ensureWeekSheetAndAsk(
          SPREADSHEET_ID,
          ctx.chat.id,
          ctx.telegram,
          false,
          !!ctx.session.scheduleNextWeek
        );
        await upsertSchedule(
          SPREADSHEET_ID,
          ctx.session.currentSheet,
          ctx.message.text.trim(),
          userId,
          ctx.telegram
        );
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.session.lastInlineMsgId,
          null,
          "✅ График обновлён!",
          getScheduleMenuInline(ctx.state?.currentUser)
        );
      } catch (e) {
        await logError(bot, e, userId, userInfo, "Обновление графика");
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.session.lastInlineMsgId,
          null,
          "❗ " + e.message,
          getScheduleMenuInline(ctx.state?.currentUser)
        );
      }
      return;
    }

    if (ctx.session.awaitingSupportAdminReply) {
      const targetId = ctx.session.supportReplyTarget;
      ctx.session.awaitingSupportAdminReply = false;
      ctx.session.supportReplyTarget = null;
      const replyText = ctx.message.text?.trim();
      const adminInfo = {
        name:
          ctx.from.first_name && ctx.from.last_name
            ? `${ctx.from.first_name} ${ctx.from.last_name}`
            : ctx.from.first_name || ctx.from.username || "Неизвестно",
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };

      if (!replyText) {
        return ctx.reply("Пустой ответ. Отменено.", adminMenu());
      }

      try {
        await bot.telegram.sendMessage(String(targetId), `✉️ Сообщение от администратора:\n\n${replyText}`);
        await ctx.reply("✅ Ответ отправлен.", adminMenu());
      } catch (e) {
        await logError(bot, e, userId, adminInfo, "Отправка ответа в поддержку");
        await ctx.reply("❗ Не удалось отправить ответ пользователю.", adminMenu());
      }
      return;
    }
  });
}

module.exports = { registerTextHandlers };
