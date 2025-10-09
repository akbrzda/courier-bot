const { Markup } = require("telegraf");
const { BRANCHES, ROLES, SPREADSHEET_ID } = require("../../config");
const {
  ensureRoleState,
  computeAdminFlag,
  hasManagerRights,
  hasBranchManagerRights,
  getBranchLabel,
  getRoleLabel,
  getUserRole,
  isAdminId,
} = require("../context");
const { adminMenu, getMainMenuInline, createPaginatedKeyboard } = require("../menus");
const { logBotStart, logError, logAction, logScheduleAction, logTabReport } = require("../../services/logger");
const { getUserById, listApprovedUsers } = require("../../services/users");
const { getAllLinks, getAllTrainingMaterials } = require("../../services/content");
const {
  getScheduleText,
  getAdminScheduleText,
  getBranchScheduleText,
  getWeekBounds,
  isScheduleSubmissionAllowed,
} = require("../../services/schedule");
const { sendReportText } = require("../reporting");

function registerCommandHandlers(bot) {
  bot.start(async (ctx) => {
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
      ctx.state = ctx.state || {};
      const user = ctx.state.currentUser || (await getUserById(userId));
      ctx.state.currentUser = user;
      ctx.state.isAdmin = computeAdminFlag(userId, user);
      ctx.state.isManager = ctx.state.isAdmin || hasManagerRights(user);
      ctx.state.isBranchManager = hasBranchManagerRights(user);

      if (isAdminId(userId, user)) {
        await logBotStart(bot, userId, userInfo, true);
        return await ctx.reply("👋 Добро пожаловать, администратор!", adminMenu());
      }

      if (user?.status === "approved") {
        if (!user.branch) {
          ctx.session = ctx.session || {};
          ctx.session.branchPromptShown = true;
          await ctx.reply(
            "Чтобы продолжить работу, выберите филиал:",
            Markup.inlineKeyboard(BRANCHES.map((branch) => [Markup.button.callback(branch.label, `branch:select_${branch.id}`)]))
          );
          return;
        }
        await logBotStart(bot, userId, { ...userInfo, name: user.name });
        return await ctx.reply(`${user.name}, Вы сейчас находитесь в главном меню бота. Выберите действие:`, getMainMenuInline(user));
      }

      if (user?.status === "pending") {
        await logBotStart(bot, userId, { ...userInfo, name: user.name });
        return await ctx.reply("⏳ Ваша заявка на регистрацию рассматривается администратором.");
      }

      await logBotStart(bot, userId, userInfo);
      return await ctx.scene.enter("registration");
    } catch (error) {
      await logError(bot, error, userId, userInfo, "Обработка команды /start");
      throw error;
    }
  });

  bot.hears("👥 Список курьеров", async (ctx) => {
    const userId = ctx.from.id.toString();
    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    if (!isAdminId(userId, ctx.state.currentUser)) {
      await logAction(bot, "попытка доступа к списку курьеров без прав", userId, adminInfo);
      return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline(ctx.state.currentUser));
    }

    try {
      const approvedUsers = await listApprovedUsers();

      if (approvedUsers.length === 0) {
        return await ctx.reply("Нет зарегистрированных курьеров.", adminMenu());
      }

      let message = "📋 Список зарегистрированных курьеров:\n\n";
      approvedUsers.forEach((u, index) => {
        const secondary = u.username ? u.username : `ID:${u.id}`;
        const branchLabel = getBranchLabel(u.branch);
        const roleLabel = getRoleLabel(u.role);
        message += `${index + 1}. ${u.name} — ${roleLabel}\n`;
      });

      await ctx.reply(message, adminMenu());
    } catch (error) {
      await logError(bot, error, userId, adminInfo, "Получение списка курьеров");
      throw error;
    }
  });

  bot.hears("❌ Удалить курьера", async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    if (!ctx.state?.isAdmin) {
      await logAction(bot, "попытка удаления курьера без прав", userId, adminInfo);
      return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline(ctx.state.currentUser));
    }
    await ctx.scene.enter("deleteCourier");
  });

  bot.hears("✏️ Изменить ФИО курьера", async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    if (!ctx.state?.isAdmin) {
      await logAction(bot, "попытка входа в изменение ФИО без прав", userId, { username: ctx.from.username });
      return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline(ctx.state.currentUser));
    }
    return await ctx.scene.enter("changeCourierName");
  });

  bot.hears("📢 Рассылка", async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    if (!ctx.state?.isAdmin) {
      await logAction(bot, "попытка рассылки без прав", userId, adminInfo);
      return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline(ctx.state.currentUser));
    }

    await ctx.scene.enter("broadcast");
  });

  bot.hears("🔗 Управление ссылками", async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    if (!ctx.state?.isAdmin) {
      return await ctx.reply("⛔ Недостаточно прав");
    }

    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    await logAction(bot, "Открытие управления ссылками", userId, adminInfo, {}, "Логи");

    const links = await getAllLinks();
    ctx.session = ctx.session || {};
    ctx.session.linksAdminPage = 0;
    if (!links.length) {
      return await ctx.reply("📋 Список ссылок пуст", Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить", "admin:addLink")]]));
    }

    const keyboard = createPaginatedKeyboard(links, 0, 6, "links", true);
    await ctx.reply("🔗 Полезные ссылки:", keyboard);
  });

  bot.hears("📚 Управление обучением", async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    if (!ctx.state?.isAdmin) {
      return await ctx.reply("⛔ Недостаточно прав");
    }

    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    await logAction(bot, "Открытие управления обучением", userId, adminInfo, {}, "Логи");

    const materials = await getAllTrainingMaterials();
    ctx.session = ctx.session || {};
    ctx.session.trainingPage = 0;
    ctx.session.trainingViewMode = "admin";
    if (!materials.length) {
      return await ctx.reply(
        "📋 Список материалов пуст",
        Markup.inlineKeyboard([
          [Markup.button.callback("➕ Добавить", "training:add")],
          [Markup.button.callback("◀️ Назад", "menu:main")],
        ])
      );
    }

    const keyboard = createPaginatedKeyboard(materials, 0, 5, "training", true);
    await ctx.reply("📚 Обучение:", keyboard);
  });

  bot.hears("🎯 Назначить роль", async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    if (!ctx.state?.isAdmin) {
      return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline(ctx.state.currentUser));
    }
    return await ctx.scene.enter("assignRole");
  });

  bot.hears(["📋 График: текущая неделя", "📋 График: следующая неделя"], async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    if (!ctx.state?.isAdmin) {
      await logAction(bot, "попытка просмотра графика без прав", userId, adminInfo);
      return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline(ctx.state.currentUser));
    }
    const nextWeek = ctx.message.text.includes("следующая");
    try {
      await logScheduleAction(bot, userId, adminInfo, `админ просмотр графика ${nextWeek ? "следующей" : "текущей"} недели`, { nextWeek });
      const text = await getAdminScheduleText(SPREADSHEET_ID, nextWeek);
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (e) {
      await logError(bot, e, userId, adminInfo, `Просмотр графика ${nextWeek ? "следующей" : "текущей"} недели`);
      await ctx.reply("❗ " + e.message, adminMenu());
    }
  });
}

module.exports = { registerCommandHandlers };
