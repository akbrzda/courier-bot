const { Markup } = require("telegraf");
const { BRANCHES, ROLES, SPREADSHEET_ID, ADMIN_IDS } = require("../../config");
const {
  ensureRoleState,
  computeAdminFlag,
  hasManagerRights,
  hasBranchManagerRights,
  getBranchLabel,
  getRoleLabel,
  getUserRole,
  isAdminId,
  canAccessReports,
} = require("../context");
const { getMainMenuInline, getReportMenuInline, getScheduleMenuInline, getBackInlineMenu, createPaginatedKeyboard } = require("../menus");
const { logAction, logError, logScheduleAction, logTabReport, logAuthAction } = require("../../services/logger");
const {
  getUserById,
  setUserStatus,
  deleteUser,
  updateUserBranch,
  listUsersByRoleAndBranch,
  listUsersByRole,
  updateUserName,
} = require("../../services/users");
const { getScheduleText, getBranchScheduleText, getWeekBounds, isScheduleSubmissionAllowed } = require("../../services/schedule");
const { getAllLinks, getAllTrainingMaterials, getTrainingMaterialById, getLinkById } = require("../../services/content");
const { sendReportText } = require("../reporting");
const { pendingApprovalNotifications } = require("../state");
const { getRequestEntry, setRequestEntry, clearRequestEntry, notifyRecipients } = require("../utils/settingsNotifications");

const SETTINGS_ALLOWED_ROLES = new Set([ROLES.COURIER, ROLES.LOGIST, ROLES.SENIOR]);

function displayUsername(raw) {
  if (!raw) return "username не указан";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

async function getManagersByBranch(branchId) {
  if (branchId) {
    const senior = await listUsersByRoleAndBranch(ROLES.SENIOR, branchId);
    const logist = await listUsersByRoleAndBranch(ROLES.LOGIST, branchId);
    return [...senior, ...logist];
  }
  const seniorAll = await listUsersByRole(ROLES.SENIOR);
  const logistAll = await listUsersByRole(ROLES.LOGIST);
  return [...seniorAll, ...logistAll];
}

function dedupeUsers(users = []) {
  const map = new Map();
  for (const user of users) {
    if (!user || !user.id) continue;
    const idStr = String(user.id);
    if (!map.has(idStr)) {
      map.set(idStr, user);
    }
  }
  return Array.from(map.values());
}

function registerCallbackHandlers(bot) {
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id.toString();
    ctx.session = ctx.session || {};
    await ensureRoleState(ctx);

    if (data.startsWith("settings:name:")) {
      const [, , action, targetId] = data.split(":");
      if (!action || !targetId) {
        await ctx.answerCbQuery("Некорректный запрос");
        return;
      }

      const requestKey = `name:${targetId}`;
      const entry = getRequestEntry(requestKey);
      if (!entry) {
        await ctx.answerCbQuery("Запрос уже обработан");
        return;
      }

      const targetUser = await getUserById(targetId);
      if (!targetUser) {
        await clearRequestEntry(bot, requestKey);
        await ctx.answerCbQuery("Пользователь не найден");
        return;
      }

      const actingUser = ctx.state?.currentUser || (await getUserById(userId));
      const isAdminCtx = isAdminId(userId, actingUser);
      const isBranchManagerCtx = hasBranchManagerRights(actingUser);
      const targetBranch = entry.payload?.branchId || targetUser.branch || null;
      if (!isAdminCtx && (!isBranchManagerCtx || !actingUser?.branch || actingUser.branch !== targetBranch)) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
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
      return;
    }

    if (data.startsWith("settings:branch:")) {
      const parts = data.split(":");
      const action = parts[2];
      const targetId = parts[3];
      const requestedBranch = parts[4] || null;
      if (!action || !targetId || !requestedBranch) {
        await ctx.answerCbQuery("Некорректный запрос");
        return;
      }

      const requestKey = `branch:${targetId}`;
      const entry = getRequestEntry(requestKey);
      if (!entry) {
        await ctx.answerCbQuery("Запрос уже обработан");
        return;
      }

      if (entry.payload?.requestedBranch !== requestedBranch) {
        await ctx.answerCbQuery("Данные запроса изменились, запрос обновлён");
        return;
      }

      const targetUser = await getUserById(targetId);
      if (!targetUser) {
        await clearRequestEntry(bot, requestKey);
        await ctx.answerCbQuery("Пользователь не найден");
        return;
      }

      const actingUser = ctx.state?.currentUser || (await getUserById(userId));
      const isAdminCtx = isAdminId(userId, actingUser);
      const isBranchManagerCtx = hasBranchManagerRights(actingUser);
      if (!isAdminCtx && (!isBranchManagerCtx || !actingUser?.branch || actingUser.branch !== requestedBranch)) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
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
      return;
    }

    if (data.startsWith("branch:select_")) {
      const match = data.match(/^branch:select_(.+)$/);
      const branchId = match ? match[1] : null;
      const branch = BRANCHES.find((b) => b.id === branchId);
      if (!branch) {
        await ctx.answerCbQuery("Неизвестный филиал, попробуйте снова");
        return;
      }

      const user = ctx.state?.currentUser || (await getUserById(userId));
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

      await updateUserBranch(userId, branch.id);
      ctx.session.branchPromptShown = false;
      if (ctx.state) {
        ctx.state.currentUser = user ? { ...user, branch: branch.id } : null;
        ctx.state.isAdmin = computeAdminFlag(userId, ctx.state.currentUser);
        ctx.state.isManager = ctx.state.isAdmin || hasManagerRights(ctx.state.currentUser);
        ctx.state.isBranchManager = hasBranchManagerRights(ctx.state.currentUser);
      }

      await logAction(bot, "Выбор филиала", userId, userInfo, { branch: branch.id });

      await ctx.answerCbQuery("Филиал сохранён");
      try {
        await ctx.editMessageText(`Филиал установлен: ${branch.label}`);
      } catch (_) {}

      const displayName = user?.name || userInfo.name || "";

      if (user?.status === "approved") {
        await ctx.reply(`${displayName}, Вы сейчас находитесь в главном меню бота. Выберите действие:`, getMainMenuInline(ctx.state.currentUser));
      } else {
        await ctx.reply("Филиал сохранён. Ожидайте подтверждения администратора.");
      }
      return;
    }

    if (
      data.startsWith("menu:") ||
      data.startsWith("report:") ||
      data.startsWith("schedule:") ||
      data.startsWith("settings:") ||
      data.startsWith("support:") ||
      data.startsWith("links:") ||
      data.startsWith("training:")
    ) {
      if (data === "support:start") {
        ctx.session = ctx.session || {};
        ctx.session.supportChatActive = true;
        await ctx.editMessageText(
          "Вы вошли в режим общения с администратором. Напишите сообщение.\n\nНажмите «Завершить диалог» чтобы выйти.",
          Markup.inlineKeyboard([[Markup.button.callback("✖️ Завершить диалог", "support:stop")], [Markup.button.callback("◀️ Назад", "menu:main")]])
        );
        return;
      }
      if (data === "support:stop") {
        ctx.session = ctx.session || {};
        ctx.session.supportChatActive = false;
        await ctx.answerCbQuery("Диалог завершён");
        try {
          await ctx.editMessageText("Диалог с администратором завершён.", getMainMenuInline(ctx.state.currentUser));
        } catch (_) {}
        return;
      }
      if (data === "menu:main") {
        const user = await getUserById(userId);
        await ctx.editMessageText(`${user?.name || ""}, Вы сейчас находитесь в главном меню бота.\n\nВыберите действие:`, getMainMenuInline(user));
        return;
      }
      if (data === "menu:report") {
        if (!canAccessReports(ctx.state.currentUser)) {
          await ctx.answerCbQuery("Недоступно для вашей роли");
          return;
        }
        await ctx.editMessageText(`Отчет по вашей заработной плате.\n\nВыберите действие:`, getReportMenuInline());
        return;
      }
      if (data.startsWith("report:")) {
        if (!canAccessReports(ctx.state.currentUser)) {
          await ctx.answerCbQuery("Недоступно для вашей роли");
          return;
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
        return;
      }
      if (data === "menu:schedule") {
        await ctx.editMessageText(`Просмотр и отправка графика.\n\nВыберите действие:`, getScheduleMenuInline(ctx.state.currentUser));
        return;
      }
      if (data === "schedule:branch") {
        await ensureRoleState(ctx);
        if (!hasBranchManagerRights(ctx.state.currentUser)) {
          await ctx.answerCbQuery("⛔ Недостаточно прав");
          return;
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
        return;
      }
      if (data === "schedule:branch_current" || data === "schedule:branch_next") {
        await ensureRoleState(ctx);
        if (!hasBranchManagerRights(ctx.state.currentUser)) {
          await ctx.answerCbQuery("⛔ Недостаточно прав");
          return;
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
        return;
      }
      if (data === "menu:settings") {
        await ensureRoleState(ctx);
        const role = getUserRole(ctx.state.currentUser);
        if (!SETTINGS_ALLOWED_ROLES.has(role)) {
          await ctx.answerCbQuery("Недоступно для вашей роли");
          return;
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
        return;
      }
      if (data === "settings:change_branch") {
        await ensureRoleState(ctx);
        const role = getUserRole(ctx.state.currentUser);
        if (!SETTINGS_ALLOWED_ROLES.has(role)) {
          await ctx.answerCbQuery("Недоступно для вашей роли");
          return;
        }
        await ctx.answerCbQuery();
        const keyboard = BRANCHES.map((branch) => [Markup.button.callback(branch.label, `settings:branch_${branch.id}`)]);
        keyboard.push([Markup.button.callback("◀️ Назад", "menu:settings")]);
        await ctx.editMessageText("Выберите филиал, на который хотите перейти:", Markup.inlineKeyboard(keyboard));
        return;
      }
      if (data === "settings:change_name") {
        await ensureRoleState(ctx);
        const role = getUserRole(ctx.state.currentUser);
        if (!SETTINGS_ALLOWED_ROLES.has(role)) {
          await ctx.answerCbQuery("Недоступно для вашей роли");
          return;
        }
        await ctx.answerCbQuery();
        ctx.session = ctx.session || {};
        ctx.session.awaitingSettingsName = true;
        ctx.session.lastSettingsMessageId = ctx.callbackQuery?.message?.message_id || null;
        await ctx.editMessageText("Введите новое ФИО полностью (Имя Фамилия).", getBackInlineMenu("menu:settings"));
        return;
      }
      if (data.startsWith("settings:branch_")) {
        await ensureRoleState(ctx);
        const role = getUserRole(ctx.state.currentUser);
        if (!SETTINGS_ALLOWED_ROLES.has(role)) {
          await ctx.answerCbQuery("Недоступно для вашей роли");
          return;
        }
        const branchId = data.slice("settings:branch_".length);
        const branch = BRANCHES.find((b) => b.id === branchId);
        if (!branch) {
          await ctx.answerCbQuery("Неизвестный филиал");
          return;
        }
        await ctx.answerCbQuery();
        ctx.session = ctx.session || {};
        ctx.session.awaitingSettingsName = false;
        const user = ctx.state?.currentUser || (await getUserById(userId));
        if (!user || user.status !== "approved") {
          await ctx.editMessageText("❗ Запрос доступен только подтверждённым пользователям.", getBackInlineMenu("menu:settings"));
          return;
        }
        if (user.branch === branch.id) {
          await ctx.editMessageText("Вы уже закреплены за этим филиалом.", getBackInlineMenu("menu:settings"));
          return;
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
        return;
      }
      if (data === "menu:links") {
        try {
          const links = await getAllLinks();
          if (links.length === 0) {
            await ctx.editMessageText("Пока нет доступных ссылок.", getBackInlineMenu("menu:main"));
            return;
          }

          const user = await getUserById(userId);
          const userInfo = {
            name: user?.name || "Неизвестно",
            username: user?.username,
            first_name: ctx.from.first_name,
            last_name: ctx.from.last_name,
          };

          await logAction(bot, "Просмотр ссылок", userId, userInfo, {}, "Логи");

          const keyboardRows = links.map((link) => [Markup.button.url(link.title, link.url)]);
          keyboardRows.push([Markup.button.callback("◀️ Назад", "menu:main")]);

          await ctx.editMessageText("🔗 Актуальные ссылки:", Markup.inlineKeyboard(keyboardRows));
        } catch (e) {
          await ctx.answerCbQuery("Ошибка загрузки");
        }
        return;
      }
      if (data.startsWith("links:page_")) {
        await ensureRoleState(ctx);
        if (!ctx.state?.isAdmin) {
          await ctx.answerCbQuery("⛔ Недостаточно прав");
          return;
        }
        const rawPage = data.split("_")[1];
        const page = Number.parseInt(rawPage, 10);
        if (Number.isNaN(page) || page < 0) {
          await ctx.answerCbQuery("Некорректная страница");
          return;
        }
        try {
          const links = await getAllLinks();
          if (!links.length) {
            await ctx.editMessageText("📋 Список ссылок пуст", Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить", "links:add")]]));
            return;
          }
          ctx.session = ctx.session || {};
          ctx.session.linksAdminPage = page;
          await ctx.editMessageText("🔗 Полезные ссылки:", createPaginatedKeyboard(links, page, 6, "links", true));
          await ctx.answerCbQuery();
        } catch (err) {
          await ctx.answerCbQuery("Ошибка загрузки");
        }
        return;
      }
      if (data === "links:noop") {
        await ctx.answerCbQuery();
        return;
      }
      if (data.startsWith("links:view_")) {
        await ensureRoleState(ctx);
        if (!ctx.state?.isAdmin) {
          await ctx.answerCbQuery("⛔ Недостаточно прав");
          return;
        }
        const linkId = data.split("_")[1];
        try {
          const link = await getLinkById(linkId);
          if (!link) {
            await ctx.answerCbQuery("Ссылка не найдена");
            return;
          }
          const backPage = ctx.session?.linksAdminPage ?? 0;
          const keyboard = Markup.inlineKeyboard([
            [Markup.button.url("🔗 Открыть", link.url)],
            [Markup.button.callback("◀️ Назад", `links:page_${backPage}`)],
          ]);
          await ctx.editMessageText(`🔗 ${link.title}\n${link.url}`, keyboard);
          await ctx.answerCbQuery();
        } catch (err) {
          await ctx.answerCbQuery("Ошибка загрузки");
        }
        return;
      }

      if (data === "menu:training" || data.startsWith("training:page_")) {
        try {
          const materials = await getAllTrainingMaterials();
          const isAdmin = ctx.state?.isAdmin ?? isAdminId(userId, ctx.state?.currentUser);
          ctx.session = ctx.session || {};
          ctx.session.trainingPage = 0;
          ctx.session.trainingViewMode = isAdmin ? "admin" : "user";
          if (materials.length === 0) {
            if (isAdmin) {
              await ctx.editMessageText(
                "📋 Список материалов пуст",
                Markup.inlineKeyboard([
                  [Markup.button.callback("➕ Добавить", "training:add")],
                  [Markup.button.callback("◀️ Назад", "menu:main")],
                ])
              );
            } else {
              await ctx.editMessageText("Пока нет обучающих материалов.", getBackInlineMenu("menu:main"));
            }
            return;
          }
          const rawPage = data.startsWith("training:page_") ? data.split("_")[1] : "0";
          let page = Number.parseInt(rawPage, 10);
          if (Number.isNaN(page) || page < 0) page = 0;
          const itemsPerPage = 5;
          ctx.session.trainingPage = page;
          ctx.session.trainingViewMode = isAdmin ? "admin" : "user";

          const totalPages = Math.ceil(materials.length / itemsPerPage) || 1;
          if (page >= totalPages) {
            page = totalPages - 1;
            ctx.session.trainingPage = page;
          }

          await ctx.editMessageText("📚 Обучающие материалы:", createPaginatedKeyboard(materials, page, itemsPerPage, "training", isAdmin));
        } catch (e) {
          await ctx.answerCbQuery("Ошибка загрузки");
        }
        return;
      }
      if (data === "training:noop") {
        await ctx.answerCbQuery();
        return;
      }
      if (data === "admin:training_back") {
        await ctx.answerCbQuery();
        try {
          const materials = await getAllTrainingMaterials();
          if (materials.length === 0) {
            ctx.session = ctx.session || {};
            ctx.session.trainingPage = 0;
            ctx.session.trainingViewMode = "admin";
            await ctx.editMessageText(
              "📋 Список материалов пуст",
              Markup.inlineKeyboard([
                [Markup.button.callback("➕ Добавить", "training:add")],
                [Markup.button.callback("◀️ Назад", "menu:main")],
              ])
            );
            return;
          }
          const itemsPerPage = 5;
          ctx.session = ctx.session || {};
          const totalPages = Math.ceil(materials.length / itemsPerPage) || 1;
          let page = ctx.session.trainingPage ?? 0;
          if (page >= totalPages) page = totalPages - 1;
          if (page < 0) page = 0;
          ctx.session.trainingPage = page;
          ctx.session.trainingViewMode = "admin";
          await ctx.editMessageText("📚 Обучение:", createPaginatedKeyboard(materials, page, itemsPerPage, "training", true));
        } catch (err) {
          await ctx.editMessageText("Ошибка загрузки материалов", adminMenu());
        }
        return;
      }
      if (data.startsWith("training:view_")) {
        const matId = data.split("_")[1];
        try {
          const material = await getTrainingMaterialById(matId);
          if (!material) {
            await ctx.answerCbQuery("Материал не найден");
            return;
          }
          const user = await getUserById(userId);
          const userInfo = {
            name: user?.name || "Неизвестно",
            username: user?.username,
            first_name: ctx.from.first_name,
            last_name: ctx.from.last_name,
          };

          await logAction(bot, `Просмотр материала обучения: ${material.title}`, userId, userInfo, { materialId: matId }, "Логи");

          const text = `📚 *${material.title}*\n\n${material.content || ""}`;
          const isAdminView = ctx.state?.isAdmin ?? false;
          ctx.session = ctx.session || {};
          const sessionPage = ctx.session.trainingPage ?? 0;
          const sessionMode = ctx.session.trainingViewMode;
          const callbackBack =
            isAdminView && sessionMode === "admin" ? `training:page_${sessionPage}` : "menu:training";
          if (material.media_type === "photo" && material.media_url) {
            await ctx.answerCbQuery();
            try {
              await ctx.deleteMessage();
            } catch (err) {
              console.error("Не удалось удалить сообщение:", err.message);
            }
            try {
              await ctx.replyWithPhoto(material.media_url, {
                caption: text,
                parse_mode: "Markdown",
              });
            } catch (err) {
              await ctx.reply("Не удалось загрузить фото. Попробуйте позже.");
            }
          } else if (material.media_type === "link" && material.media_url) {
            const keyboard = [[Markup.button.url("🔗 Открыть ссылку", material.media_url)]];
            keyboard.push([Markup.button.callback("◀️ Назад", callbackBack)]);
            const markup = Markup.inlineKeyboard(keyboard);
            await ctx.editMessageText(text, {
              parse_mode: "Markdown",
              reply_markup: markup.reply_markup,
            });
          } else {
            const backMarkup = getBackInlineMenu(callbackBack);
            await ctx.editMessageText(text, {
              parse_mode: "Markdown",
              reply_markup: backMarkup.reply_markup,
            });
          }
        } catch (e) {
          console.error("Ошибка при просмотре материала:", e);
          await ctx.answerCbQuery("Ошибка: " + e.message);
        }
        return;
      }
      if (data === "schedule:view:current" || data === "schedule:view:next") {
        await ensureRoleState(ctx);
        if (getUserRole(ctx.state.currentUser) === ROLES.LOGIST) {
          await ctx.answerCbQuery("Доступен только график филиала");
          return;
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
        return;
      }
      if (data === "schedule:view") {
        await ensureRoleState(ctx);
        if (getUserRole(ctx.state.currentUser) === ROLES.LOGIST) {
          await ctx.answerCbQuery("Доступен только график филиала");
          return;
        }
        await ctx.editMessageText(
          "Выберите неделю:",
          Markup.inlineKeyboard([
            [Markup.button.callback("Текущая неделя", "schedule:view:current")],
            [Markup.button.callback("Следующая неделя", "schedule:view:next")],
            [Markup.button.callback("◀️ Назад", "menu:schedule")],
          ])
        );
        return;
      }
      if (data === "schedule:send") {
        await ensureRoleState(ctx);
        if (getUserRole(ctx.state.currentUser) === ROLES.LOGIST) {
          await ctx.answerCbQuery("⛔ Недостаточно прав");
          return;
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
          return;
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
        return;
      }
    }

    const isAdminCtx = ctx.state?.isAdmin ?? false;
    const isBranchManagerCtx = hasBranchManagerRights(ctx.state?.currentUser);

    if (data === "admin:addLink" || data === "links:add") {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("addLink");
    }
    if (data === "admin:deleteLink" || data === "links:delete") {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("deleteLink");
    }
    if (data === "admin:addTraining" || data === "training:add") {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("addTraining");
    }
    if (data === "admin:deleteTraining" || data === "training:delete") {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("deleteTraining");
    }

    if (data.startsWith("support_reply:")) {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      const targetId = data.split(":")[1];
      ctx.session = ctx.session || {};
      ctx.session.supportReplyTarget = targetId;
      await ctx.answerCbQuery();
      try {
        await ctx.deleteMessage();
      } catch (_) {}
      await ctx.reply(`Введите ответ для курьера (ID: ${targetId})`);
      ctx.session.awaitingSupportAdminReply = true;
      return;
    }
    if (data.startsWith("approve_") || data.startsWith("reject_")) {
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
        return await ctx.answerCbQuery("Пользователь не найден");
      }

      const isAdmin = isAdminCtx;
      const isBranchManager = hasBranchManagerRights(actingUser);

      if (!isAdmin && !isBranchManager) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }

      if (!isAdmin && isBranchManager) {
        const managerBranch = actingUser?.branch;
        if (!managerBranch) {
          await ctx.answerCbQuery("Назначьте филиал, чтобы обрабатывать заявки");
          return;
        }
        if (user.branch && user.branch !== managerBranch) {
          await ctx.answerCbQuery("Это заявка другого филиала");
          return;
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

      return;
    }
    await ctx.answerCbQuery("Неизвестная команда");
  });
}

module.exports = { registerCallbackHandlers };
