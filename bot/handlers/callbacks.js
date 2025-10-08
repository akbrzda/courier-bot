const { Markup } = require("telegraf");
const {
  BRANCHES,
  ROLES,
  SPREADSHEET_ID,
} = require("../../config");
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
const {
  getMainMenuInline,
  getReportMenuInline,
  getScheduleMenuInline,
  getBackInlineMenu,
  createPaginatedKeyboard,
} = require("../menus");
const {
  logAction,
  logError,
  logScheduleAction,
  logTabReport,
  logAuthAction,
} = require("../../services/logger");
const {
  getUserById,
  setUserStatus,
  deleteUser,
  updateUserBranch,
} = require("../../services/users");
const {
  getScheduleText,
  getBranchScheduleText,
  getWeekBounds,
  isScheduleSubmissionAllowed,
} = require("../../services/schedule");
const {
  getAllLinks,
  getAllTrainingMaterials,
  getTrainingMaterialById,
} = require("../../services/content");
const { sendReportText } = require("../reporting");
const { pendingApprovalNotifications } = require("../state");

function registerCallbackHandlers(bot) {
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id.toString();
    ctx.session = ctx.session || {};
    await ensureRoleState(ctx);

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
        await ctx.reply(
          `${displayName}, Вы сейчас находитесь в главном меню бота. Выберите действие:`,
          getMainMenuInline(ctx.state.currentUser)
        );
      } else {
        await ctx.reply("Филиал сохранён. Ожидайте подтверждения администратора.");
      }
      return;
    }

    if (
      data.startsWith("menu:") ||
      data.startsWith("report:") ||
      data.startsWith("schedule:") ||
      data.startsWith("support:") ||
      data.startsWith("links:") ||
      data.startsWith("training:")
    ) {
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
        await ctx.editMessageText(
          `${user?.name || ""}, Вы сейчас находитесь в главном меню бота.\n\nВыберите действие:`,
          getMainMenuInline(user)
        );
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
        await ctx.editMessageText(
          `Просмотр и отправка графика.\n\nВыберите действие:`,
          getScheduleMenuInline(ctx.state.currentUser)
        );
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
          const scheduleText = await getBranchScheduleText(
            SPREADSHEET_ID,
            branchId || "",
            branchLabel,
            nextWeek
          );
          await ctx.editMessageText(scheduleText, {
            parse_mode: "Markdown",
            ...getBackInlineMenu("menu:schedule"),
          });
        } catch (e) {
          await ctx.editMessageText("❗ " + e.message, getBackInlineMenu("menu:schedule"));
        }
        return;
      }
      if (data === "menu:links" || data.startsWith("links:page_")) {
        try {
          const links = await getAllLinks();
          if (links.length === 0) {
            await ctx.editMessageText("Пока нет доступных ссылок.", getBackInlineMenu("menu:main"));
            return;
          }
          const page = data.startsWith("links:page_") ? parseInt(data.split("_")[1]) : 0;
          const itemsPerPage = 6;
          const isAdmin = ctx.state?.isAdmin ?? isAdminId(userId, ctx.state?.currentUser);

          const user = await getUserById(userId);
          const userInfo = {
            name: user?.name || "Неизвестно",
            username: user?.username,
            first_name: ctx.from.first_name,
            last_name: ctx.from.last_name,
          };

          await logAction(bot, `Просмотр ссылок (страница ${page + 1})`, userId, userInfo, { page, isAdmin }, "Логи");

          await ctx.editMessageText(
            "🔗 Здесь вы найдете актуальные ссылки.",
            createPaginatedKeyboard(links, page, itemsPerPage, "links", isAdmin)
          );
        } catch (e) {
          await ctx.answerCbQuery("Ошибка загрузки");
        }
        return;
      }
      if (data === "links:noop") {
        await ctx.answerCbQuery();
        return;
      }
      if (data.startsWith("links:view_")) {
        const linkId = data.split("_")[1];
        try {
          const links = await getAllLinks();
          const link = links.find((item) => String(item.id) === linkId);
          if (!link) {
            await ctx.answerCbQuery("Ссылка не найдена");
            return;
          }
          const isAdminView = ctx.state?.isAdmin ?? false;
          const keyboardRows = [[Markup.button.url("🔗 Открыть", link.url)]];
          if (!isAdminView) {
            keyboardRows.push([Markup.button.callback("◀️ Назад", "menu:links")]);
          }
          await ctx.editMessageText(`🔗 *${link.title}*\n${link.url}`, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard(keyboardRows),
          });
        } catch (err) {
          await ctx.answerCbQuery("Ошибка просмотра");
        }
        return;
      }
      if (data === "menu:training" || data.startsWith("training:page_")) {
        try {
          const materials = await getAllTrainingMaterials();
          if (materials.length === 0) {
            await ctx.editMessageText("Пока нет обучающих материалов.", getBackInlineMenu("menu:main"));
            return;
          }
          const page = data.startsWith("training:page_") ? parseInt(data.split("_")[1]) : 0;
          const itemsPerPage = 5;
          const isAdmin = ctx.state?.isAdmin ?? isAdminId(userId, ctx.state?.currentUser);

          await ctx.editMessageText(
            "📚 Обучающие материалы:",
            createPaginatedKeyboard(materials, page, itemsPerPage, "training", isAdmin)
          );
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
            await ctx.editMessageText("📋 Список материалов пуст", Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить", "admin:addTraining")]]));
            return;
          }
          const keyboard = createPaginatedKeyboard(materials, 0, 6, "training", true);
          await ctx.editMessageText("📚 Обучение:", keyboard);
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

          await logAction(
            bot,
            `Просмотр материала обучения: ${material.title}`,
            userId,
            userInfo,
            { materialId: matId },
            "Логи"
          );

          const text = `📚 *${material.title}*\n\n${material.content || ""}`;
          const isAdminView = ctx.state?.isAdmin ?? false;
          const callbackBack = isAdminView ? "admin:training_back" : "menu:training";
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
            await ctx.editMessageText(text, {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard(keyboard),
            });
          } else {
            const options = { parse_mode: "Markdown" };
            Object.assign(options, getBackInlineMenu(callbackBack));
            await ctx.editMessageText(text, options);
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
          await ctx.editMessageText(
            "График можно отправлять только с 22:00 четверга и до 12:00 воскресенья.",
            getBackInlineMenu("menu:schedule")
          );
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

    if (data === "admin:addLink") {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("addLink");
    }
    if (data === "admin:deleteLink") {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("deleteLink");
    }
    if (data === "admin:addTraining") {
      if (!isAdminCtx) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("addTraining");
    }
    if (data === "admin:deleteTraining") {
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
          await logAuthAction(
            bot,
            idToChange,
            { name: user.name, username: user.username },
            "подтверждение администратором",
            {
              adminId: userId,
              adminName: adminInfo.name,
            }
          );

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
          await logAuthAction(
            bot,
            idToChange,
            { name: user.name, username: user.username },
            "отклонение администратором",
            {
              adminId: userId,
              adminName: adminInfo.name,
            }
          );

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
