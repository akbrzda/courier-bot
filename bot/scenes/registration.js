const { Scenes, Markup } = require("telegraf");
const { BRANCHES, ADMIN_IDS, ROLES } = require("../../config");
const { buildBranchKeyboard } = require("../menus");
const { pendingApprovalNotifications } = require("../state");
const { logAction, logError, logAuthAction } = require("../../services/logger");
const { upsertUserBasic, listUsersByRoleAndBranch } = require("../../services/users");

function createRegistrationScene(bot) {
  const registrationScene = new Scenes.BaseScene("registration");

  registrationScene.enter(async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.registration = { stage: "name" };
    await ctx.reply(
      "👋 Привет! Введите своё Имя и Фамилия для регистрации. Например, Иванов Иван. Обязательно, без отчества!",
      Markup.removeKeyboard()
    );
  });

  registrationScene.on("text", async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.session = ctx.session || {};
    const registrationState = ctx.session.registration || { stage: "name" };
    const name = ctx.message.text.trim();
    const userInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    if (registrationState.stage !== "name") {
      return await ctx.reply("Пожалуйста, выберите филиал, используя кнопки ниже.");
    }

    if (!name || name.length < 3) {
      await logAction(bot, "Попытка регистрации с некорректным ФИО", userId, userInfo, { enteredName: name });
      return await ctx.reply("❗ Пожалуйста, введите корректное ФИО (минимум 3 символа)");
    }

    try {
      ctx.session.registration = {
        stage: "branch",
        name,
      };

      await ctx.reply("Теперь выберите филиал, к которому вы относитесь:", buildBranchKeyboard("reg:branch"));
    } catch (err) {
      await logError(bot, err, userId, userInfo, "Обработка заявки на регистрацию");
      return await ctx.reply("⚠️ Произошла ошибка при отправке заявки. Попробуйте позже.");
    }
  });

  registrationScene.action(/^reg:branch_(.+)$/, async (ctx) => {
    const branchId = ctx.match[1];
    const branch = BRANCHES.find((b) => b.id === branchId);
    await ctx.answerCbQuery();
    if (!branch) {
      return ctx.reply("Выбрано неизвестное значение. Попробуйте снова.");
    }

    ctx.session = ctx.session || {};
    const registrationState = ctx.session.registration;
    if (!registrationState || registrationState.stage !== "branch" || !registrationState.name) {
      return ctx.reply("Пожалуйста, начните регистрацию заново командой /start.");
    }

    const userId = ctx.from.id.toString();
    const userInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    try {
      await upsertUserBasic(userId, {
        name: registrationState.name,
        status: "pending",
        username: ctx.from.username ? `@${ctx.from.username}` : null,
        first_name: ctx.from.first_name || null,
        last_name: ctx.from.last_name || null,
        branch: branch.id,
      });

      await logAuthAction(bot, userId, userInfo, "Подача заявки на регистрацию", {
        enteredName: registrationState.name,
        branch: branch.id,
      });

      const telegramUserInfo = ctx.from;
      const username = telegramUserInfo.username ? `@${telegramUserInfo.username}` : "не указан";
      const fullTelegramName = `${telegramUserInfo.first_name || ""} ${telegramUserInfo.last_name || ""}`.trim();

      for (const admin of ADMIN_IDS) {
        try {
          const sent = await bot.telegram.sendMessage(
            admin,
            `📥 Новая заявка на регистрацию:\n` +
              `👤 Введённое ФИО: ${registrationState.name}\n` +
              `🔹 Telegram: ${fullTelegramName} (${username})\n` +
              `🏢 Филиал: ${branch.label}\n` +
              `🆔 Telegram ID: ${userId}`,
            Markup.inlineKeyboard([
              Markup.button.callback(`✅ Подтвердить`, `approve_${userId}`),
              Markup.button.callback(`❌ Отклонить`, `reject_${userId}`),
            ])
          );
          if (sent?.message_id) {
            const current = pendingApprovalNotifications.get(userId) || [];
            current.push({ chatId: admin, messageId: sent.message_id });
            pendingApprovalNotifications.set(userId, current);
          }
        } catch (e) {
          console.warn("Не удалось отправить уведомление администратору", admin, e.message);
          await logError(bot, e, userId, userInfo, "Отправка уведомления администратору");
        }
      }

      try {
        const seniorManagers = await listUsersByRoleAndBranch(ROLES.SENIOR, branch.id);
        const logistManagers = await listUsersByRoleAndBranch(ROLES.LOGIST, branch.id);
        const branchManagers = [...seniorManagers, ...logistManagers];
        const notified = new Set();
        for (const manager of branchManagers) {
          if (!manager?.id || notified.has(manager.id)) continue;
          notified.add(manager.id);
          try {
            const sent = await bot.telegram.sendMessage(
              String(manager.id),
              `📥 Новая заявка в вашем филиале (${branch.label}):\n` +
                `👤 ${registrationState.name}\n` +
                `🔹 Telegram: ${fullTelegramName} (${username})\n` +
                `🆔 Telegram ID: ${userId}`,
              Markup.inlineKeyboard([
                Markup.button.callback(`✅ Подтвердить`, `approve_${userId}`),
                Markup.button.callback(`❌ Отклонить`, `reject_${userId}`),
              ])
            );
            if (sent?.message_id) {
              const current = pendingApprovalNotifications.get(userId) || [];
              current.push({ chatId: manager.id, messageId: sent.message_id });
              pendingApprovalNotifications.set(userId, current);
            }
          } catch (mgrErr) {
            await logError(bot, mgrErr, manager.id, manager, "Уведомление руководителю о заявке");
          }
        }
      } catch (mgrListErr) {
        await logError(bot, mgrListErr, "system", {}, "Получение списка руководителей филиала");
      }

      await ctx.reply("⏳ Заявка отправлена! Ожидайте подтверждения администратора.");
      ctx.session.registration = null;
      await ctx.scene.leave();
    } catch (err) {
      await logError(bot, err, userId, userInfo, "Обработка заявки на регистрацию");
      await ctx.reply("⚠️ Произошла ошибка при отправке заявки. Попробуйте позже.");
    }
  });

  registrationScene.on("message", async (ctx) => {
    await ctx.reply("Пожалуйста, введите только текст");
  });

  registrationScene.leave((ctx) => {
    if (ctx.session) {
      delete ctx.session.registration;
    }
  });

  return registrationScene;
}

module.exports = { createRegistrationScene };
