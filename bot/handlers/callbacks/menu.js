const { Markup } = require("telegraf");
const { BRANCHES, ROLES, SPREADSHEET_ID, ADMIN_IDS } = require("../../../config");
const {
  ensureRoleState,
  getBranchLabel,
  getRoleLabel,
  getUserRole,
  canAccessReports,
  hasBranchManagerRights,
} = require("../../context");
const {
  getMainMenuInline,
  getReportMenuInline,
  getScheduleMenuInline,
  getBackInlineMenu,
} = require("../../menus");
const {
  logTabReport,
  logError,
  logScheduleAction,
  logAction,
} = require("../../../services/logger");
const {
  getUserById,
} = require("../../../services/users");
const {
  getScheduleText,
  getBranchScheduleText,
  getWeekBounds,
  isScheduleSubmissionAllowed,
} = require("../../../services/schedule");
const {
  setRequestEntry,
  clearRequestEntry,
  notifyRecipients,
} = require("../../utils/settingsNotifications");
const { sendReportText } = require("../../reporting");
const { SETTINGS_ALLOWED_ROLES } = require("./constants");
const { getManagersByBranch, displayUsername, dedupeUsers } = require("./shared");

async function handleMenuCallbacks({ bot, ctx, data, userId }) {
  const isMenuRelated =
    data.startsWith("menu:") ||
    data.startsWith("report:") ||
    data.startsWith("schedule:") ||
    data.startsWith("settings:") ||
    data.startsWith("support:");

  if (!isMenuRelated) {
    return false;
  }

  if (data === "support:start") {
    ctx.session = ctx.session || {};
    ctx.session.supportChatActive = true;
    await ctx.editMessageText(
      "Вы вошли в режим общения с администратором. Напишите сообщение.\n\nНажмите «Завершить диалог» чтобы выйти.",
      Markup.inlineKeyboard([
        [Markup.button.callback("✖️ Завершить диалог", "support:stop")],
        [Markup.button.callback("◀️ Назад", "menu:main")],
      ])
    );
    return true;
  }

  if (data === "support:stop") {
    ctx.session = ctx.session || {};
    ctx.session.supportChatActive = false;
    await ctx.answerCbQuery("Диалог завершён");
    try {
      await ctx.editMessageText("Диалог с администратором завершён.", getMainMenuInline(ctx.state.currentUser));
    } catch (_) {}
    return true;
  }

  if (data === "menu:main") {
    const user = await getUserById(userId);
    await ctx.editMessageText(
      `${user?.name || ""}, Вы сейчас находитесь в главном меню бота.\n\nВыберите действие:`,
      getMainMenuInline(user)
    );
    return true;
  }

  if (data === "menu:report") {
    if (!canAccessReports(ctx.state.currentUser)) {
      await ctx.answerCbQuery("Недоступно для вашей роли");
      return true;
    }
    await ctx.editMessageText(`Отчет по вашей заработной плате.\n\nВыберите действие:`, getReportMenuInline());
    return true;
  }

  if (data.startsWith("report:")) {
    if (!canAccessReports(ctx.state.currentUser)) {
      await ctx.answerCbQuery("Недоступно для вашей роли");
      return true;
    }
    const user = await getUserById(userId);
    const userInfo = {
      name: user?.name || "Неизвестно",
      username: user?.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    await ctx.editMessageText("⏳ Загружаю табель...", getBackInlineMenu("menu:report"));
    let period = null;
    if (data === "report:today") period = "today";
    if (data === "report:yesterday") period = "yesterday";
    if (data === "report:week_current") period = "current_week";
    if (data === "report:week_prev") period = "last_week";
    if (data === "report:month_current") period = "current_month";
    if (data === "report:month_prev") period = "last_month";

    try {
      if (data === "report:custom") {
        await logTabReport(bot, userId, userInfo, "custom", { action: "запрос ввода периода" });
        ctx.session = ctx.session || {};
        ctx.session.awaitingCustomReport = true;
        ctx.session.lastReportMsgId = ctx.callbackQuery.message.message_id;
        await ctx.editMessageText(
          "Введите период в формате ДД.ММ.ГГГГ-ДД.ММ.ГГГГ (например, 01.07.2025-15.07.2025)",
          getBackInlineMenu("menu:report")
        );
      } else {
        await logTabReport(bot, userId, userInfo, period);
        const text = await sendReportText(userId, period);
        await ctx.editMessageText(text, { parse_mode: "HTML", ...getBackInlineMenu("menu:report") });
      }
    } catch (e) {
      await logError(bot, e, userId, userInfo, `Запрос табеля за период: ${period}`);
      await ctx.editMessageText("❗ " + e.message, getBackInlineMenu("menu:report"));
    }
    return true;
  }

  if (data === "menu:schedule") {
    await ctx.editMessageText(`Просмотр и отправка графика.\n\nВыберите действие:`, getScheduleMenuInline(ctx.state.currentUser));
    return true;
  }

  if (data === "schedule:branch") {
    await ensureRoleState(ctx);
    if (!hasBranchManagerRights(ctx.state.currentUser)) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    const branchId = ctx.state.currentUser?.branch;
    const branchLabel = branchId ? getBranchLabel(branchId) : "Ваш филиал";
    await ctx.editMessageText(
      `Выберите период для филиала ${branchLabel}:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Текущая неделя", "schedule:branch_current")],
        [Markup.button.callback("Следующая неделя", "schedule:branch_next")],
        [Markup.button.callback("◀️ Назад", "menu:schedule")],
      ])
    );
    return true;
  }

  if (data === "schedule:branch_current" || data === "schedule:branch_next") {
    await ensureRoleState(ctx);
    if (!hasBranchManagerRights(ctx.state.currentUser)) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    const branchId = ctx.state.currentUser?.branch;
    const nextWeek = data.endsWith("next");
    const branchLabel = branchId ? getBranchLabel(branchId) : "Ваш филиал";
    await ctx.answerCbQuery();
    await ctx.editMessageText("⏳ Получаю график филиала...", getBackInlineMenu("menu:schedule"));
    try {
      await logScheduleAction(
        bot,
        userId,
        {
          name:
            ctx.state.currentUser?.name ||
            (ctx.from.first_name && ctx.from.last_name
              ? `${ctx.from.first_name} ${ctx.from.last_name}`
              : ctx.from.first_name || ctx.from.username || "Неизвестно"),
          username: ctx.from.username,
        },
        `просмотр графика филиала ${branchLabel}`,
        { branchId, nextWeek }
      );
      const scheduleText = await getBranchScheduleText(SPREADSHEET_ID, branchId || "", branchLabel, nextWeek);
      await ctx.editMessageText(scheduleText, {
        parse_mode: "Markdown",
        ...getBackInlineMenu("menu:schedule"),
      });
    } catch (e) {
      await ctx.editMessageText("❗ " + e.message, getBackInlineMenu("menu:schedule"));
    }
    return true;
  }

  if (data === "menu:settings") {
    await ensureRoleState(ctx);
    const role = getUserRole(ctx.state.currentUser);
    if (!SETTINGS_ALLOWED_ROLES.has(role)) {
      await ctx.answerCbQuery("Недоступно для вашей роли");
      return true;
    }
    await ctx.answerCbQuery();
    ctx.session = ctx.session || {};
    ctx.session.awaitingSettingsName = false;
    ctx.session.lastSettingsMessageId = null;
    await ctx.editMessageText(
      `⚙️ Раздел настроек.\n\nВаш текущий филиал: ${getBranchLabel(ctx.state.currentUser?.branch)}\nВаше текущее ФИО: ${
        ctx.state.currentUser?.name
      }\nВаша должность: ${getRoleLabel(getUserRole(ctx.state.currentUser))}\n\nВыберите действие:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🏢 Запросить смену филиала", "settings:change_branch")],
        [Markup.button.callback("✏️ Запросить смену ФИО", "settings:change_name")],
        [Markup.button.callback("✉️ Написать администратору", "support:start")],
        [Markup.button.callback("◀️ Назад", "menu:main")],
      ])
    );
    return true;
  }

  if (data === "settings:change_branch") {
    await ensureRoleState(ctx);
    const role = getUserRole(ctx.state.currentUser);
    if (!SETTINGS_ALLOWED_ROLES.has(role)) {
      await ctx.answerCbQuery("Недоступно для вашей роли");
      return true;
    }
    await ctx.answerCbQuery();
    const keyboard = BRANCHES.map((branch) => [Markup.button.callback(branch.label, `settings:branch_${branch.id}`)]);
    keyboard.push([Markup.button.callback("◀️ Назад", "menu:settings")]);
    await ctx.editMessageText("Выберите филиал, на который хотите перейти:", Markup.inlineKeyboard(keyboard));
    return true;
  }

  if (data === "settings:change_name") {
    await ensureRoleState(ctx);
    const role = getUserRole(ctx.state.currentUser);
    if (!SETTINGS_ALLOWED_ROLES.has(role)) {
      await ctx.answerCbQuery("Недоступно для вашей роли");
      return true;
    }
    await ctx.answerCbQuery();
    ctx.session = ctx.session || {};
    ctx.session.awaitingSettingsName = true;
    ctx.session.lastSettingsMessageId = ctx.callbackQuery?.message?.message_id || null;
    await ctx.editMessageText("Введите новое ФИО полностью (Имя Фамилия).", getBackInlineMenu("menu:settings"));
    return true;
  }

  if (data.startsWith("settings:branch_")) {
    await ensureRoleState(ctx);
    const role = getUserRole(ctx.state.currentUser);
    if (!SETTINGS_ALLOWED_ROLES.has(role)) {
      await ctx.answerCbQuery("Недоступно для вашей роли");
      return true;
    }
    const branchId = data.slice("settings:branch_".length);
    const branch = BRANCHES.find((b) => b.id === branchId);
    if (!branch) {
      await ctx.answerCbQuery("Неизвестный филиал");
      return true;
    }
    await ctx.answerCbQuery();
    ctx.session = ctx.session || {};
    ctx.session.awaitingSettingsName = false;
    const user = ctx.state?.currentUser || (await getUserById(userId));
    if (!user || user.status !== "approved") {
      await ctx.editMessageText("❗ Запрос доступен только подтверждённым пользователям.", getBackInlineMenu("menu:settings"));
      return true;
    }
    if (user.branch === branch.id) {
      await ctx.editMessageText("Вы уже закреплены за этим филиалом.", getBackInlineMenu("menu:settings"));
      return true;
    }
    const userInfo = {
      name:
        user?.name ||
        (ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно"),
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };
    const currentBranchLabel = getBranchLabel(user.branch);
    const usernameDisplay = displayUsername(user?.username || ctx.from.username);
    const notifyText =
      `⚙️ Запрос на смену филиала\n\n` +
      `👤 ${user?.name || userInfo.name} (${usernameDisplay})\n` +
      `Текущий филиал: ${currentBranchLabel}\n` +
      `Новый филиал: ${branch.label}\n` +
      `🆔 Telegram ID: ${userId}`;

    const key = `branch:${userId}`;
    await clearRequestEntry(bot, key);
    setRequestEntry(key, {
      requesterId: userId,
      requesterName: user?.name || userInfo.name,
      requesterUsername: usernameDisplay,
      currentBranch: user.branch || null,
      currentBranchLabel,
      requestedBranch: branch.id,
      requestedBranchLabel: branch.label,
      requestedAt: Date.now(),
    });

    const approvalKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Подтвердить", `settings:branch:approve:${userId}:${branch.id}`),
        Markup.button.callback("❌ Отклонить", `settings:branch:reject:${userId}:${branch.id}`),
      ],
    ]);

    const adminDelivered = await notifyRecipients(bot, key, ADMIN_IDS, notifyText, approvalKeyboard, {
      onError: async (err, chatId) => {
        await logError(bot, err, chatId, { name: "Администратор" }, "Уведомление о запросе смены филиала");
      },
    });

    let managerList = [];
    try {
      const targetManagers = await getManagersByBranch(branch.id);
      const currentManagers = user?.branch ? await getManagersByBranch(user.branch) : [];
      managerList = dedupeUsers([...targetManagers, ...currentManagers]).filter((mgr) => mgr?.id && String(mgr.id) !== userId);
    } catch (listErr) {
      await logError(bot, listErr, "system", {}, "Получение списка руководителей для смены филиала");
    }

    const managerDelivered = await notifyRecipients(bot, key, managerList, notifyText, approvalKeyboard, {
      onError: async (err, chatId) => {
        await logError(bot, err, chatId, {}, "Уведомление руководителю о запросе смены филиала");
      },
    });

    const logPayload = {
      from: user.branch || null,
      to: branch.id,
    };
    if (adminDelivered.length) logPayload.notifiedAdmins = adminDelivered;
    if (managerDelivered.length) logPayload.notifiedManagers = managerDelivered;

    await logAction(bot, "Запрос смены филиала", userId, userInfo, logPayload, "Авторизация");

    await ctx.editMessageText(
      "✅ Запрос на смену филиала отправлен. Ожидайте ответа руководителя или администратора.",
      getBackInlineMenu("menu:settings")
    );
    return true;
  }

  if (data === "schedule:view:current" || data === "schedule:view:next") {
    await ensureRoleState(ctx);
    if (getUserRole(ctx.state.currentUser) === ROLES.LOGIST) {
      await ctx.answerCbQuery("Доступен только график филиала");
      return true;
    }
    const user = await getUserById(userId);
    const userInfo = {
      name: user?.name || "Неизвестно",
      username: user?.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };
    const nextWeek = data.endsWith("next");

    await ctx.editMessageText("⏳ Получаю график...", getBackInlineMenu("menu:schedule"));
    try {
      await logScheduleAction(bot, userId, userInfo, `просмотр ${nextWeek ? "следующей" : "текущей"} недели`);
      const grafText = await getScheduleText(SPREADSHEET_ID, userId, nextWeek);
      await ctx.editMessageText(grafText, { parse_mode: "Markdown", ...getBackInlineMenu("menu:schedule") });
    } catch (e) {
      await logError(bot, e, userId, userInfo, `Просмотр графика ${nextWeek ? "следующей" : "текущей"} недели`);
      await ctx.editMessageText("❗ " + e.message, getBackInlineMenu("menu:schedule"));
    }
    return true;
  }

  if (data === "schedule:view") {
    await ensureRoleState(ctx);
    if (getUserRole(ctx.state.currentUser) === ROLES.LOGIST) {
      await ctx.answerCbQuery("Доступен только график филиала");
      return true;
    }
    await ctx.editMessageText(
      "Выберите неделю:",
      Markup.inlineKeyboard([
        [Markup.button.callback("Текущая неделя", "schedule:view:current")],
        [Markup.button.callback("Следующая неделя", "schedule:view:next")],
        [Markup.button.callback("◀️ Назад", "menu:schedule")],
      ])
    );
    return true;
  }

  if (data === "schedule:send") {
    await ensureRoleState(ctx);
    if (getUserRole(ctx.state.currentUser) === ROLES.LOGIST) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    const { from, to } = getWeekBounds(true);
    const user = await getUserById(userId);
    const userInfo = {
      name: user?.name || "Неизвестно",
      username: user?.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };
    if (!isScheduleSubmissionAllowed()) {
      await logScheduleAction(bot, userId, userInfo, "попытка отправки графика вне разрешенного времени");
      await ctx.editMessageText("График можно отправлять только с 22:00 четверга и до 12:00 воскресенья.", getBackInlineMenu("menu:schedule"));
      return true;
    }
    await logScheduleAction(bot, userId, userInfo, "запрос на отправку графика", {
      period: `${from.format("DD.MM")}–${to.format("DD.MM")}`,
    });
    const warn = `📅 Пришлите ваш график на период ${from.format("DD.MM")}–${to.format("DD.MM")} в формате:\n\nПн: 10-23\nВт: 10-23\n…`;
    await ctx.editMessageText(warn, getBackInlineMenu("menu:schedule"));
    ctx.session.awaitingSchedule = true;
    ctx.session.scheduleMode = "send";
    ctx.session.scheduleNextWeek = true;
    ctx.session.lastInlineMsgId = ctx.callbackQuery.message.message_id;
    return true;
  }

  return false;
}

module.exports = {
  handleMenuCallbacks,
};
