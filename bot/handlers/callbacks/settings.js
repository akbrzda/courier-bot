const { hasBranchManagerRights, isAdminId, getBranchLabel } = require("../../context");
const { logAction, logError } = require("../../../services/logger");
const { getUserById, updateUserName, updateUserBranch } = require("../../../services/users");
const { getRequestEntry, clearRequestEntry } = require("../../utils/settingsNotifications");

async function handleSettingsCallbacks({ bot, ctx, data, userId }) {
  if (!data.startsWith("settings:")) {
    return false;
  }

  if (data.startsWith("settings:name:")) {
    const [, , action, targetId] = data.split(":");
    if (!action || !targetId) {
      await ctx.answerCbQuery("Некорректный запрос");
      return true;
    }

    const requestKey = `name:${targetId}`;
    const entry = getRequestEntry(requestKey);
    if (!entry) {
      await ctx.answerCbQuery("Запрос уже обработан");
      return true;
    }

    const targetUser = await getUserById(targetId);
    if (!targetUser) {
      await clearRequestEntry(bot, requestKey);
      await ctx.answerCbQuery("Пользователь не найден");
      return true;
    }

    const actingUser = ctx.state?.currentUser || (await getUserById(userId));
    const isAdminCtx = isAdminId(userId, actingUser);
    const isBranchManagerCtx = hasBranchManagerRights(actingUser);
    const targetBranch = entry.payload?.branchId || targetUser.branch || null;
    if (!isAdminCtx && (!isBranchManagerCtx || !actingUser?.branch || actingUser.branch !== targetBranch)) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }

    const actingInfo = {
      name:
        actingUser?.name ||
        (ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно"),
      username: ctx.from.username,
    };

    const actingChatId = ctx.callbackQuery?.message?.chat?.id ?? null;
    const actingMessageId = ctx.callbackQuery?.message?.message_id ?? null;
    const canEditMessage = actingChatId !== null && actingMessageId !== null;
    const clearOptions = canEditMessage ? { skip: { chatId: actingChatId, messageId: actingMessageId } } : undefined;

    if (action === "approve") {
      try {
        const newName = entry.payload?.requestedName;
        if (!newName) throw new Error("Не указано новое ФИО");
        await updateUserName(targetId, newName);
        await logAction(
          bot,
          "Смена ФИО подтверждена",
          userId,
          actingInfo,
          {
            targetId,
            newName,
          },
          "Авторизация"
        );
        await clearRequestEntry(bot, requestKey, clearOptions);
        if (canEditMessage) {
          await ctx.editMessageText(`✅ Запрос на смену ФИО для ${entry.payload?.requesterName || "пользователя"} одобрен.`);
        } else {
          await ctx.reply(`✅ Запрос на смену ФИО для ${entry.payload?.requesterName || "пользователя"} одобрен.`);
        }
        await bot.telegram.sendMessage(
          String(targetId),
          `✅ Ваш запрос на смену ФИО одобрен.
Новое ФИО: ${newName}`
        );
        await ctx.answerCbQuery("Готово");
      } catch (err) {
        await logError(bot, err, userId, actingInfo, "Подтверждение смены ФИО");
        await ctx.answerCbQuery("Ошибка обработки");
      }
    } else if (action === "reject") {
      try {
        await logAction(
          bot,
          "Смена ФИО отклонена",
          userId,
          actingInfo,
          {
            targetId,
            requestedName: entry.payload?.requestedName,
          },
          "Авторизация"
        );
        await clearRequestEntry(bot, requestKey, clearOptions);
        if (canEditMessage) {
          await ctx.editMessageText(`❌ Запрос на смену ФИО для ${entry.payload?.requesterName || "пользователя"} отклонён.`);
        } else {
          await ctx.reply(`❌ Запрос на смену ФИО для ${entry.payload?.requesterName || "пользователя"} отклонён.`);
        }
        await bot.telegram.sendMessage(String(targetId), "❌ Ваш запрос на смену ФИО отклонён. Свяжитесь с руководителем для уточнения деталей.");
        await ctx.answerCbQuery("Отклонено");
      } catch (err) {
        await logError(bot, err, userId, actingInfo, "Отклонение смены ФИО");
        await ctx.answerCbQuery("Ошибка обработки");
      }
    } else {
      await ctx.answerCbQuery("Неизвестное действие");
    }
    return true;
  }

  if (data.startsWith("settings:branch:")) {
    const parts = data.split(":");
    const action = parts[2];
    const targetId = parts[3];
    const requestedBranch = parts[4] || null;
    if (!action || !targetId || !requestedBranch) {
      await ctx.answerCbQuery("Некорректный запрос");
      return true;
    }

    const requestKey = `branch:${targetId}`;
    const entry = getRequestEntry(requestKey);
    if (!entry) {
      await ctx.answerCbQuery("Запрос уже обработан");
      return true;
    }

    if (entry.payload?.requestedBranch !== requestedBranch) {
      await ctx.answerCbQuery("Данные запроса изменились, запрос обновлён");
      return true;
    }

    const targetUser = await getUserById(targetId);
    if (!targetUser) {
      await clearRequestEntry(bot, requestKey);
      await ctx.answerCbQuery("Пользователь не найден");
      return true;
    }

    const actingUser = ctx.state?.currentUser || (await getUserById(userId));
    const isAdminCtx = isAdminId(userId, actingUser);
    const isBranchManagerCtx = hasBranchManagerRights(actingUser);
    if (!isAdminCtx && (!isBranchManagerCtx || !actingUser?.branch || actingUser.branch !== requestedBranch)) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }

    const actingInfo = {
      name:
        actingUser?.name ||
        (ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно"),
      username: ctx.from.username,
    };

    const actingChatId = ctx.callbackQuery?.message?.chat?.id ?? null;
    const actingMessageId = ctx.callbackQuery?.message?.message_id ?? null;
    const canEditMessage = actingChatId !== null && actingMessageId !== null;
    const clearOptions = canEditMessage ? { skip: { chatId: actingChatId, messageId: actingMessageId } } : undefined;

    if (action === "approve") {
      try {
        await updateUserBranch(targetId, requestedBranch);
        await logAction(
          bot,
          "Смена филиала подтверждена",
          userId,
          actingInfo,
          {
            targetId,
            from: entry.payload?.currentBranch || null,
            to: requestedBranch,
          },
          "Авторизация"
        );
        await clearRequestEntry(bot, requestKey, clearOptions);
        if (canEditMessage) {
          await ctx.editMessageText(`✅ Запрос на смену филиала для ${entry.payload?.requesterName || "пользователя"} одобрен.`);
        } else {
          await ctx.reply(`✅ Запрос на смену филиала для ${entry.payload?.requesterName || "пользователя"} одобрен.`);
        }
        await bot.telegram.sendMessage(
          String(targetId),
          `✅ Ваш запрос на смену филиала одобрен.
Новый филиал: ${entry.payload?.requestedBranchLabel || getBranchLabel(requestedBranch)}`
        );
        await ctx.answerCbQuery("Готово");
      } catch (err) {
        await logError(bot, err, userId, actingInfo, "Подтверждение смены филиала");
        await ctx.answerCbQuery("Ошибка обработки");
      }
    } else if (action === "reject") {
      try {
        await logAction(
          bot,
          "Смена филиала отклонена",
          userId,
          actingInfo,
          {
            targetId,
            from: entry.payload?.currentBranch || null,
            to: requestedBranch,
          },
          "Авторизация"
        );
        await clearRequestEntry(bot, requestKey, clearOptions);
        if (canEditMessage) {
          await ctx.editMessageText(`❌ Запрос на смену филиала для ${entry.payload?.requesterName || "пользователя"} отклонён.`);
        } else {
          await ctx.reply(`❌ Запрос на смену филиала для ${entry.payload?.requesterName || "пользователя"} отклонён.`);
        }
        await bot.telegram.sendMessage(
          String(targetId),
          "❌ Ваш запрос на смену филиала отклонён. Свяжитесь с руководителем для уточнения деталей."
        );
        await ctx.answerCbQuery("Отклонено");
      } catch (err) {
        await logError(bot, err, userId, actingInfo, "Отклонение смены филиала");
        await ctx.answerCbQuery("Ошибка обработки");
      }
    } else {
      await ctx.answerCbQuery("Неизвестное действие");
    }
    return true;
  }

  return false;
}

module.exports = {
  handleSettingsCallbacks,
};
