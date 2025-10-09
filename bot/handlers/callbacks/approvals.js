const { getUserById, setUserStatus, deleteUser } = require("../../../services/users");
const { getMainMenuInline } = require("../../menus");
const { hasBranchManagerRights, isAdminId } = require("../../context");
const { logAuthAction, logError } = require("../../../services/logger");
const { pendingApprovalNotifications } = require("../../state");

async function handleApprovalCallbacks({ bot, ctx, data, userId }) {
  if (!data.startsWith("approve_") && !data.startsWith("reject_")) {
    return false;
  }

  const idToChange = data.split("_")[1];
  const user = await getUserById(idToChange);
  const actingUser = ctx.state?.currentUser || (await getUserById(userId));
  const adminInfo = {
    name:
      ctx.from.first_name && ctx.from.last_name
        ? `${ctx.from.first_name} ${ctx.from.last_name}`
        : ctx.from.first_name || ctx.from.username || "Неизвестно",
    username: ctx.from.username,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
  };

  if (!user) {
    await ctx.answerCbQuery("Пользователь не найден");
    return true;
  }

  const isAdminCtx = ctx.state?.isAdmin ?? isAdminId(userId, actingUser);
  const isBranchManagerCtx = hasBranchManagerRights(actingUser);

  if (!isAdminCtx && !isBranchManagerCtx) {
    await ctx.answerCbQuery("⛔ Недостаточно прав");
    return true;
  }

  if (!isAdminCtx && isBranchManagerCtx) {
    const managerBranch = actingUser?.branch;
    if (!managerBranch) {
      await ctx.answerCbQuery("Назначьте филиал, чтобы обрабатывать заявки");
      return true;
    }
    if (user.branch && user.branch !== managerBranch) {
      await ctx.answerCbQuery("Это заявка другого филиала");
      return true;
    }
  }

  try {
    if (data.startsWith("approve_")) {
      await setUserStatus(idToChange, "approved");
      await logAuthAction(bot, idToChange, { name: user.name, username: user.username }, "подтверждение администратором", {
        adminId: userId,
        adminName: adminInfo.name,
      });

      await ctx.editMessageText(`✅ Курьер ${user.name} подтверждён.`);
      await ctx.answerCbQuery("Пользователь подтверждён");

      try {
        await bot.telegram.sendMessage(
          idToChange,
          `Ваша заявка одобрена!\nТеперь вам доступны все возможности нашего бота. Добро пожаловать :)\n\nВыберите действие:`,
          getMainMenuInline(user)
        );
      } catch (err) {
        console.error(`Не удалось отправить уведомление об одобрении курьеру ${idToChange}:`, err.message);
        await logError(bot, err, userId, adminInfo, "Отправка уведомления об одобрении");
      }
    }

    if (data.startsWith("reject_")) {
      await deleteUser(idToChange);
      await logAuthAction(bot, idToChange, { name: user.name, username: user.username }, "отклонение администратором", {
        adminId: userId,
        adminName: adminInfo.name,
      });

      await ctx.editMessageText(`❌ Заявка от ${user.name} отклонена.`);
      await ctx.answerCbQuery("Заявка отклонена");

      try {
        await bot.telegram.sendMessage(idToChange, `❌ Ваша заявка отклонена.`);
      } catch (err) {
        console.error(`Не удалось отправить уведомление об отказе курьеру ${idToChange}:`, err.message);
        await logError(bot, err, userId, adminInfo, "Отправка уведомления об отказе");
      }
    }

    const pending = pendingApprovalNotifications.get(idToChange);
    if (pending && pending.length) {
      for (const note of pending) {
        if (!note || !note.chatId || !note.messageId) continue;
        try {
          await bot.telegram.deleteMessage(String(note.chatId), note.messageId);
        } catch (delErr) {
          if (delErr?.response?.error_code !== 400) {
            console.warn("Не удалось удалить уведомление о заявке:", delErr.message);
          }
        }
      }
      pendingApprovalNotifications.delete(idToChange);
    }
  } catch (err) {
    await logError(bot, err, userId, adminInfo, "Обработка подтверждения/отклонения пользователя");
    await ctx.answerCbQuery("⚠️ Произошла ошибка");
    console.error("Ошибка при обработке подтверждения/отклонения:", err.message);
  }

  return true;
}

module.exports = {
  handleApprovalCallbacks,
};
