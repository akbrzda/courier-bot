require("dotenv").config();
const { Telegraf, Scenes, Markup, session } = require("telegraf");
const { google } = require("googleapis");
const moment = require("moment-timezone");
const cron = require("node-cron");

const { ensureWeekSheetAndAsk, upsertSchedule, upsertScheduleForFio, getScheduleText, getAdminScheduleText, parseAndAppend, isScheduleSubmissionAllowed, getWeekBounds } = require("./grafik.js");
const { initSchema } = require("./db");
const { getUserById, upsertUserBasic, setUserStatus, deleteUser, listApprovedUsers, listAllUsers } = require("./services.users");

// ==================== Инициализация бота ====================
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const SPREADSHEET_ID = process.env.GRAFIK;

// ==================== Работа с пользователями ====================
// Переведено на MySQL через сервисы в services.users.js

// ==================== Google Sheets ====================
// Инициализация авторизации для Sheets выполняется локально в местах использования

// ==================== Функции работы с датами ====================
function getPreviousWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const currentMonday = new Date(now);
  currentMonday.setDate(now.getDate() - ((day + 6) % 7));
  const lastMonday = new Date(currentMonday);
  lastMonday.setDate(currentMonday.getDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  lastMonday.setHours(0, 0, 0, 0);
  lastSunday.setHours(23, 59, 59, 999);
  return { fromDate: lastMonday, toDate: lastSunday };
}

cron.schedule("0 12 * * 5", async () => {
  const now = moment().tz("Asia/Yekaterinburg");
  console.log(`[Напоминание] Рассылаю напоминание в ${now.format("YYYY-MM-DD HH:mm")}`);
  try {
    const approvedUsers = await listApprovedUsers();
    for (const u of approvedUsers) {
      try {
        await bot.telegram.sendMessage(
          String(u.id),
          "⏰ Напоминаем! Пожалуйста, отправьте свой график на следующую неделю через кнопку «Отправить график» в меню."
        );
      } catch (e) {
        console.error(`[Напоминание] Ошибка для ${u.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error("[Напоминание] Ошибка выборки пользователей:", e.message);
  }
}, { timezone: "Asia/Yekaterinburg" });

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 (воскресенье) … 6 (суббота)

  const diffToMonday = (day + 6) % 7;

  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { fromDate: monday, toDate: sunday };
}

function parseDate(str) {
  if (!str || typeof str !== "string" || !str.includes(".")) {
    return null;
  }
  const [day, month, year] = str.split(".");
  return new Date(`${month}/${day}/${year}`);
}

// Экранирование для HTML-форматирования Telegram
function escapeHtml(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ==================== Главное меню ====================
// ========== INLINE MENU GENERATORS ==========

function getMainMenuInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📅 Табель', 'menu:report')],
    [Markup.button.callback('📊 График', 'menu:schedule')],
    [Markup.button.callback('✉️ Написать администратору', 'support:start')],
  ]);
}

function getReportMenuInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📅 За сегодня', 'report:today')],
    [Markup.button.callback('📆 За вчера', 'report:yesterday')],
    [Markup.button.callback('📊 Текущая неделя', 'report:week_current')],
    [Markup.button.callback('📊 Прошлая неделя', 'report:week_prev')],
    [Markup.button.callback('🗓 Этот месяц', 'report:month_current')],
    [Markup.button.callback('🗓 Прошлый месяц', 'report:month_prev')],
    [Markup.button.callback('📅 Выбрать период…', 'report:custom')],
    [Markup.button.callback('◀️ Назад', 'menu:main')],
  ]);
}

function getScheduleMenuInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👁 Посмотреть график', 'schedule:view')],
    [Markup.button.callback('➕ Отправить график', 'schedule:send')],
    [Markup.button.callback('🛠 Изменить график', 'schedule:edit')],
    [Markup.button.callback('◀️ Назад', 'menu:main')],
  ]);
}
function getBackInlineMenu(callbackBack) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('◀️ Назад', callbackBack)]
  ]);
}


// ==================== Админское меню ====================
function adminMenu() {
  return Markup.keyboard([
    ["👥 Список курьеров", "❌ Удалить курьера"],
    ["📋 График: текущая неделя", "📋 График: следующая неделя"],
    ["✏️ Изменить график по ФИО", "📢 Рассылка"],
  ]).resize();
}

// ==================== Сцена регистрации ====================
const registrationScene = new Scenes.BaseScene("registration");

registrationScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.reply("👋 Привет! Введите своё ФИО для регистрации:", Markup.removeKeyboard());
});

registrationScene.on("text", async (ctx) => {
  const userId = ctx.from.id.toString();
  const name = ctx.message.text.trim();

  if (!name || name.length < 3) {
    return await ctx.reply("❗ Пожалуйста, введите корректное ФИО (минимум 3 символа)");
  }

  await upsertUserBasic(userId, {
    name,
    status: "pending",
    username: ctx.from.username ? `@${ctx.from.username}` : null,
    first_name: ctx.from.first_name || null,
    last_name: ctx.from.last_name || null,
  });

  try {
    const userInfo = ctx.from;
    const username = userInfo.username ? `@${userInfo.username}` : "не указан";
    const fullTelegramName = `${userInfo.first_name || ""} ${userInfo.last_name || ""}`.trim();

    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📥 Новая заявка на регистрацию:\n` +
        `👤 Введённое ФИО: ${name}\n` +
        `🔹 Telegram: ${fullTelegramName} (${username})\n` +
        `🆔 Telegram ID: ${userId}`,
      Markup.inlineKeyboard([
        Markup.button.callback(`✅ Подтвердить`, `approve_${userId}`),
        Markup.button.callback(`❌ Отклонить`, `reject_${userId}`),
      ])
    );

    await ctx.reply("⏳ Заявка отправлена! Ожидайте подтверждения администратора.");
    await ctx.scene.leave();
  } catch (err) {
    return await ctx.reply("⚠️ Произошла ошибка при отправке заявки. Попробуйте позже.");
  }
});

registrationScene.on("message", async (ctx) => {
  await ctx.reply("Пожалуйста, введите только текст");
});

// ==================== Сцена удаления курьера ====================
const deleteCourierScene = new Scenes.BaseScene("deleteCourier");
const editScheduleByFioScene = new Scenes.BaseScene("editScheduleByFio");
const broadcastScene = new Scenes.BaseScene("broadcast");
broadcastScene.enter(async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  ctx.session = ctx.session || {};
  ctx.session.broadcastText = null;
  await ctx.reply(
    "Введите текст рассылки (поддерживается обычный текст; для Markdown/HTML — пока без форматирования):",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "broadcast:cancel")]])
  );
});

broadcastScene.action("broadcast:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try { await ctx.deleteMessage(); } catch (_) {}
  return ctx.scene.leave();
});

broadcastScene.on("text", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("⛔ Недостаточно прав");
  }
  const text = ctx.message.text?.trim();
  if (!text) {
    return ctx.reply("Текст пуст. Введите текст или нажмите Отмена.");
  }
  ctx.session.broadcastText = text;

  await ctx.reply(
    "Подтвердите отправку рассылки всем зарегистрированным пользователям:",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Отправить", "broadcast:send")],
      [Markup.button.callback("❌ Отмена", "broadcast:cancel")],
    ])
  );
});

broadcastScene.action("broadcast:send", async (ctx) => {
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch (_) {}
  const text = ctx.session?.broadcastText;
  if (!text) {
    await ctx.reply("Текст рассылки не найден. Попробуйте снова.");
    return ctx.scene.leave();
  }

  try {
    const users = await listAllUsers();
    let ok = 0, fail = 0;
    for (const u of users) {
      try {
        await bot.telegram.sendMessage(String(u.id), text);
        ok += 1;
      } catch (e) {
        fail += 1;
        // не прерываем, продолжаем рассылку
      }
      // троттлинг: лёгкая задержка, чтобы не получить 429
      await new Promise((r) => setTimeout(r, 35));
    }
    await ctx.reply(`Рассылка завершена. Успех: ${ok}, ошибки: ${fail}.`, adminMenu());
  } catch (e) {
    await ctx.reply("❗ Ошибка рассылки: " + e.message, adminMenu());
  }
  return ctx.scene.leave();
});

// Сцена редактирования графика по ФИО (для админа)
editScheduleByFioScene.enter(async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  ctx.session = ctx.session || {};
  ctx.session.editFio = null;
  ctx.session.editWeekNext = null;
  ctx.session.awaitingFio = false;
  ctx.session.awaitingSchedule = false;
  await ctx.reply(
    "Выберите неделю для изменения графика:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Текущая неделя", "admin_edit:current")],
      [Markup.button.callback("Следующая неделя", "admin_edit:next")],
      [Markup.button.callback("❌ Отмена", "admin_edit:cancel")],
    ])
  );
});

editScheduleByFioScene.action("admin_edit:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try { await ctx.deleteMessage(); } catch (_) {}
  return ctx.scene.leave();
});

editScheduleByFioScene.action(["admin_edit:current", "admin_edit:next"], async (ctx) => {
  const isNext = ctx.callbackQuery.data.endsWith("next");
  ctx.session.editWeekNext = isNext;
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch (_) {}
  ctx.session.awaitingFio = true;
  await ctx.reply("Введите ФИО курьера (как в таблице):");
});

editScheduleByFioScene.on("text", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("⛔ Недостаточно прав");
  }
  ctx.session = ctx.session || {};
  // Шаг 1: получаем ФИО
  if (ctx.session.awaitingFio && !ctx.session.awaitingSchedule) {
    const fio = ctx.message.text.trim();
    if (!fio || fio.length < 3) {
      return ctx.reply("Введите корректное ФИО (минимум 3 символа)");
    }
    ctx.session.editFio = fio;
    ctx.session.awaitingFio = false;
    ctx.session.awaitingSchedule = true;
    const { from, to } = getWeekBounds(ctx.session.editWeekNext === true);
    return ctx.reply(
      `Пришлите график для ${fio} на период ${from.format("DD.MM")}–${to.format("DD.MM")} в формате:\n\nПн: 10-23\nВт: 10-23\n…`
    );
  }
  // Шаг 2: получаем график и применяем
  if (ctx.session.awaitingSchedule) {
    const graphText = ctx.message.text.trim();
    ctx.session.awaitingSchedule = false;
    try {
      const sheetName = await ensureWeekSheetAndAsk(
        SPREADSHEET_ID,
        ctx.chat.id,
        ctx.telegram,
        false,
        ctx.session.editWeekNext === true
      );
      await upsertScheduleForFio(
        SPREADSHEET_ID,
        sheetName,
        graphText,
        ctx.session.editFio,
        ctx.telegram,
        ctx.chat.id
      );
      await ctx.reply("✅ График обновлён!", adminMenu());
    } catch (e) {
      await ctx.reply("❗ " + e.message, adminMenu());
    }
    return ctx.scene.leave();
  }
  // По умолчанию
  return ctx.reply("Пожалуйста, следуйте инструкциям сцены или нажмите Отмена.");
});

deleteCourierScene.enter(async (ctx) => {
  try {
    const approvedUsers = await listApprovedUsers();

    if (approvedUsers.length === 0) {
      await ctx.reply("Нет зарегистрированных курьеров.", adminMenu());
      return await ctx.scene.leave();
    }

    const keyboard = approvedUsers.map((user) => {
      const secondary = user.username ? user.username : `ID:${user.id}`;
      return [Markup.button.callback(`${user.name} (${secondary})`, `delete_${user.id}`)];
    });

    await ctx.reply("Выберите курьера для удаления:", Markup.inlineKeyboard([...keyboard, [Markup.button.callback("❌ Отмена", "cancel_delete")]]));
  } catch (err) {
    console.error("[deleteCourierScene.enter] ERROR:", err);
    await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.");
    await ctx.scene.leave();
  }
});

deleteCourierScene.action(/^delete_(.+)$/, async (ctx) => {
  try {
    console.log("[deleteCourierScene.action] ctx.match:", ctx.match);

    // Проверка на админа
    if (ctx.from.id.toString() !== ADMIN_ID) {
      console.warn(`[deleteCourierScene.action] User ${ctx.from.id} попытался удалить курьера без прав`);
      await ctx.answerCbQuery("Нет прав");
      return;
    }

    const userId = ctx.match[1];
    const user = await getUserById(userId);
    if (!user) {
      await ctx.answerCbQuery("Курьер не найден");
      return await ctx.scene.leave();
    }

    await deleteUser(userId);

    await ctx.editMessageText(`Курьер ${user.name} удалён.`);
    await ctx.answerCbQuery("Курьер удалён");

    try {
      await bot.telegram.sendMessage(userId, "❌ Ваш аккаунт был удалён администратором.");
      console.log("[deleteCourierScene.action] Сообщение отправлено пользователю:", userId);
    } catch (err) {
      console.error("[deleteCourierScene.action] Не удалось отправить сообщение пользователю:", userId, err);
    }

    return await ctx.scene.leave();
  } catch (err) {
    console.error("[deleteCourierScene.action] ERROR:", err);
    await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.");
    await ctx.scene.leave();
  }
});

deleteCourierScene.action("cancel_delete", async (ctx) => {
  try {
    await ctx.answerCbQuery("Отменено");
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.warn("[deleteCourierScene.cancel_delete] Не удалось удалить сообщение:", e);
    }
    return await ctx.scene.leave();
  } catch (err) {
    console.error("[deleteCourierScene.cancel_delete] ERROR:", err);
    await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.");
    await ctx.scene.leave();
  }
});

deleteCourierScene.on("message", async (ctx) => {
  try {
    console.log("[deleteCourierScene.on(message)] Получено сообщение:", ctx.message);
    await ctx.reply("Пожалуйста, используйте кнопки для выбора курьера.");
  } catch (err) {
    console.error("[deleteCourierScene.on(message)] ERROR:", err);
    await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.");
  }
});

// ==================== Инициализация сцен и сессий ====================
const stage = new Scenes.Stage([registrationScene, deleteCourierScene, editScheduleByFioScene, broadcastScene]);
bot.use(session());
bot.use(stage.middleware());

// ==================== Обработчики команд ====================
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();

  if (userId === ADMIN_ID) {
    return await ctx.reply("👋 Добро пожаловать, администратор!", adminMenu());
  }

  const user = await getUserById(userId);
  if (user?.status === "approved") {
    return await ctx.reply(`${user.name}, Вы сейчас находитесь в главном меню бота. Выберите действие:`, getMainMenuInline());
  }

  if (user?.status === "pending") {
    return await ctx.reply("⏳ Ваша заявка на регистрацию рассматривается администратором.");
  }

  return await ctx.scene.enter("registration");
});

// Админские команды
bot.hears("👥 Список курьеров", async (ctx) => {
  const userId = ctx.from.id.toString();

  if (userId !== ADMIN_ID) {
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }

  const approvedUsers = await listApprovedUsers();

  if (approvedUsers.length === 0) {
    return await ctx.reply("Нет зарегистрированных курьеров.", adminMenu());
  }

  let message = "📋 Список зарегистрированных курьеров:\n\n";
  approvedUsers.forEach((u, index) => {
    const secondary = u.username ? u.username : `ID:${u.id}`;
    message += `${index + 1}. ${u.name} (${secondary})\n`;
  });

  await ctx.reply(message, adminMenu());
});

bot.hears("❌ Удалить курьера", async (ctx) => {
  const userId = ctx.from.id.toString();

  if (userId !== ADMIN_ID) {
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }

  await ctx.scene.enter("deleteCourier");
});

bot.hears("✏️ Изменить график по ФИО", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== ADMIN_ID) {
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }
  await ctx.scene.enter("editScheduleByFio");
});

bot.hears("📢 Рассылка", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== ADMIN_ID) {
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }
  await ctx.scene.enter("broadcast");
});

bot.hears("🔙 Главное меню", async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.reply("Главное меню", userId === ADMIN_ID ? adminMenu() : getMainMenuInline());
});

// Просмотр графика админом (все курьеры)
bot.hears(["📋 График: текущая неделя", "📋 График: следующая неделя"], async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== ADMIN_ID) return ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  const nextWeek = ctx.message.text.includes("следующая");
  try {
    const text = await getAdminScheduleText(SPREADSHEET_ID, nextWeek);
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch (e) {
    await ctx.reply("❗ " + e.message, adminMenu());
  }
});

// ==================== Обработчики callback-запросов ====================
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id.toString();
  const { from, to } = getWeekBounds(true);
  ctx.session = ctx.session || {};

  // ========== Юзерское инлайн-меню ==========
  if (
    data.startsWith('menu:') ||
    data.startsWith('report:') ||
    data.startsWith('schedule:') ||
    data.startsWith('support:')
  ) {
    // Поддержка: пользователь -> админ (вход в диалоговый режим)
    if (data === 'support:start') {
      ctx.session = ctx.session || {};
      ctx.session.supportChatActive = true;
      await ctx.editMessageText(
        'Вы вошли в режим общения с администратором. Напишите сообщение.\n\nНажмите «Завершить диалог» чтобы выйти.',
        Markup.inlineKeyboard([
          [Markup.button.callback('✖️ Завершить диалог', 'support:stop')],
          [Markup.button.callback('◀️ Назад', 'menu:main')],
        ])
      );
      return;
    }
    if (data === 'support:stop') {
      ctx.session = ctx.session || {};
      ctx.session.supportChatActive = false;
      await ctx.answerCbQuery('Диалог завершён');
      try { await ctx.editMessageText('Диалог с администратором завершён.', getMainMenuInline()); } catch (_) {}
      return;
    }
    // Главное меню
    if (data === 'menu:main') {
		const userId = ctx.from.id.toString();
      const user = await getUserById(userId);
      await ctx.editMessageText(`${user?.name || ""}, Вы сейчас находитесь в главном меню бота.\n\nВыберите действие:`, getMainMenuInline());
      return;
    }

    // Подменю Табель
    if (data === 'menu:report') {
      await ctx.editMessageText(`Отчет по вашей заработной плате.\n\nВыберите действие:`, getReportMenuInline());
      return;
    }

    // Показываем только "Назад" при просмотре отчёта!
    if (data.startsWith('report:')) {
      await ctx.editMessageText('⏳ Загружаю табель...', getBackInlineMenu('menu:report'));
      let period = null;
      if (data === 'report:today') period = 'today';
      if (data === 'report:yesterday') period = 'yesterday';
      if (data === 'report:week_current') period = 'current_week';
      if (data === 'report:week_prev') period = 'last_week';
      if (data === 'report:month_current') period = 'current_month';
      if (data === 'report:month_prev') period = 'last_month';
      try {
        if (data === 'report:custom') {
          // Переходим к запросу периода дат
          ctx.session = ctx.session || {};
          ctx.session.awaitingCustomReport = true;
          ctx.session.lastReportMsgId = ctx.callbackQuery.message.message_id;
          await ctx.editMessageText('Введите период в формате ДД.ММ.ГГГГ-ДД.ММ.ГГГГ (например, 01.07.2025-15.07.2025)', getBackInlineMenu('menu:report'));
        } else {
        const text = await sendReportText(userId, period);
          await ctx.editMessageText(text, { parse_mode: 'HTML', ...getBackInlineMenu('menu:report') });
        }
      } catch (e) {
        await ctx.editMessageText('❗ ' + e.message, getBackInlineMenu('menu:report'));
      }
      return;
    }

    // Подменю График
    if (data === 'menu:schedule') {
      await ctx.editMessageText(`Просмотр и отправка графика.\n\nВыберите действие:`, getScheduleMenuInline());
      return;
    }

    // Просмотр графика — только "Назад"
    if (data === 'schedule:view:current' || data === 'schedule:view:next') {
      await ctx.editMessageText('⏳ Получаю график...', getBackInlineMenu('menu:schedule'));
      try {
        const nextWeek = data.endsWith('next');
        const grafText = await getScheduleText(SPREADSHEET_ID, userId, nextWeek);
        await ctx.editMessageText(grafText, { parse_mode: "Markdown", ...getBackInlineMenu('menu:schedule') });
      } catch (e) {
        await ctx.editMessageText('❗ ' + e.message, getBackInlineMenu('menu:schedule'));
      }
      return;
    }

    // Посмотреть график (выбор недели)
    if (data === 'schedule:view') {
      await ctx.editMessageText('Выберите неделю:', Markup.inlineKeyboard([
        [Markup.button.callback("Текущая неделя", "schedule:view:current")],
        [Markup.button.callback("Следующая неделя", "schedule:view:next")],
        [Markup.button.callback("◀️ Назад", "menu:schedule")]
      ]));
      return;
    }

    // Отправить график/Изменить график — тут тоже только Назад
    if (data === 'schedule:send') {
		  if (!isScheduleSubmissionAllowed()) {
    await ctx.editMessageText(
      "График можно отправлять только с 22:00 четверга и до 12:00 воскресенья.",
      getBackInlineMenu('menu:schedule')
    );
    return;
  }
      const warn = `📅 Пришлите ваш график на период ${from.format("DD.MM")}–${to.format("DD.MM")} в формате:\n\nПн: 10-23\nВт: 10-23\n…`;
      await ctx.editMessageText(warn, getBackInlineMenu('menu:schedule'));
      ctx.session.awaitingSchedule = true;
      ctx.session.scheduleMode = 'send';
      ctx.session.lastInlineMsgId = ctx.callbackQuery.message.message_id;
      return;
    }
    if (data === 'schedule:edit') {
      const warn = `📅 Пришлите ваш измененный график на период ${from.format("DD.MM")}–${to.format("DD.MM")} в формате:\n\nПн: 10-23\nВт: 10-23\n…`;
      await ctx.editMessageText(warn, getBackInlineMenu('menu:schedule'));
      ctx.session.awaitingSchedule = true;
      ctx.session.scheduleMode = 'edit';
      ctx.session.lastInlineMsgId = ctx.callbackQuery.message.message_id;
      return;
    }
  }

  // ==== АДМИНСКИЕ/РЕГИСТРАЦИОННЫЕ ВЕТКИ (оставь как было!) ====

  // Старые payload'ы SHOW_SCHEDULE_* удалены

  // Обработка cancel_delete выполняется в сцене deleteCourier

  // Проверка прав администратора для других действий
  if (userId !== ADMIN_ID) {
    return await ctx.answerCbQuery("⛔ Недостаточно прав");
  }

  // Админ отвечает курьеру
  if (data.startsWith('support_reply:')) {
    const targetId = data.split(':')[1];
    ctx.session = ctx.session || {};
    ctx.session.supportReplyTarget = targetId;
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch (_) {}
    await ctx.reply(`Введите ответ для курьера (ID: ${targetId})`);
    ctx.session.awaitingSupportAdminReply = true;
    return;
  }

  // Обработка подтверждения/отклонения регистрации
  if (data.startsWith("approve_") || data.startsWith("reject_")) {
    const idToChange = data.split("_")[1];
    const user = await getUserById(idToChange);

    if (!user) {
      return await ctx.answerCbQuery("Пользователь не найден");
    }

try {
  if (data.startsWith("approve_")) {
    await setUserStatus(idToChange, "approved");

    await ctx.editMessageText(`✅ Курьер ${user.name} подтверждён.`);
    await ctx.answerCbQuery("Пользователь подтверждён");

    // Отправка уведомления пользователю — оборачиваем отдельно
    try {
      await bot.telegram.sendMessage(
        idToChange,
        `Ваша заявка одобрена!\nТеперь вам доступны все возможности нашего бота. Добро пожаловать :)\n\nВыберите действие:`,
        getMainMenuInline()
      );
    } catch (err) {
      console.error(`Не удалось отправить уведомление об одобрении курьеру ${idToChange}:`, err.message);
    }
  }

  if (data.startsWith("reject_")) {
    await deleteUser(idToChange);

    await ctx.editMessageText(`❌ Заявка от ${user.name} отклонена.`);
    await ctx.answerCbQuery("Заявка отклонена");

    // Отправка уведомления об отклонении
    try {
      await bot.telegram.sendMessage(
        idToChange,
        `❌ Ваша заявка отклонена.`
      );
    } catch (err) {
      console.error(`Не удалось отправить уведомление об отказе курьеру ${idToChange}:`, err.message);
    }
  }
} catch (err) {
  await ctx.answerCbQuery("⚠️ Произошла ошибка");
  console.error("Ошибка при обработке подтверждения/отклонения:", err.message);
}

    return;
  }

  // Удаление курьера обрабатывается сценой deleteCourier

  // Если callback не распознан
  await ctx.answerCbQuery("Неизвестная команда");
});

// ==================== Интеграция grafik.js ====================

// handleShowScheduleInline удалён как неиспользуемый

// Обработка текста с расписанием
bot.on("text", async (ctx) => {
  ctx.session = ctx.session || {};
  const userId = ctx.from.id.toString();

  // Произвольный период табеля
  if (ctx.session.awaitingCustomReport) {
    ctx.session.awaitingCustomReport = false;
    const input = ctx.message.text.trim();
    try {
      const text = await sendReportText(userId, 'custom', input);
      const msgId = ctx.session.lastReportMsgId;
      if (msgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, { parse_mode: 'HTML', ...getBackInlineMenu('menu:report') });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', ...getReportMenuInline() });
      }
  } catch (e) {
      const msgId = ctx.session.lastReportMsgId;
      if (msgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, '❗ ' + e.message, getBackInlineMenu('menu:report'));
      } else {
        await ctx.reply('❗ ' + e.message, getReportMenuInline());
      }
    }
    return;
  }

  // Сообщение в поддержку (пользователь -> админ)
  if (ctx.session.awaitingSupportMessage || ctx.session.supportChatActive) {
    const text = ctx.message.text?.trim();
    if (!text) {
      return ctx.reply('Пустое сообщение. Отмена.', getMainMenuInline());
    }
    try {
      const user = await getUserById(userId);
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `📥 Новое обращение от курьера:\n` +
        `👤 ${user ? user.name : userId} (ID: ${userId})\n\n` +
        `${text}`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`✍️ Ответить ${user ? user.name : userId}`, `support_reply:${userId}`)]
        ])
      );
      if (!ctx.session.supportChatActive) {
        await ctx.reply('✅ Сообщение отправлено администратору. Ожидайте ответ.');
      }
    } catch (e) {
      await ctx.reply('❗ Не удалось отправить сообщение. Попробуйте позже.');
    }
    return;
  }

  // Новое расписание (добавить)
  if (ctx.session.awaitingSchedule && ctx.session.scheduleMode === 'send') {
    ctx.session.awaitingSchedule = false;
    try {
      ctx.session.currentSheet = await ensureWeekSheetAndAsk(SPREADSHEET_ID, ctx.chat.id, ctx.telegram);
      await parseAndAppend(SPREADSHEET_ID, ctx.session.currentSheet, ctx.message.text.trim(), userId);
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, "✅ График сохранён!", getScheduleMenuInline());
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, '❗ ' + e.message, getScheduleMenuInline());
    }
    return;
  }
  // Редактирование расписания
  if (ctx.session.awaitingSchedule && ctx.session.scheduleMode === 'edit') {
    ctx.session.awaitingSchedule = false;
    try {
      ctx.session.currentSheet = await ensureWeekSheetAndAsk(SPREADSHEET_ID, ctx.chat.id, ctx.telegram, false);
      await upsertSchedule(SPREADSHEET_ID, ctx.session.currentSheet, ctx.message.text.trim(), userId, ctx.telegram);
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, "✅ График обновлён!", getScheduleMenuInline());
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, '❗ ' + e.message, getScheduleMenuInline());
    }
    return;
  }

  // Ответ админа курьеру
  if (ctx.session.awaitingSupportAdminReply) {
    const targetId = ctx.session.supportReplyTarget;
    ctx.session.awaitingSupportAdminReply = false;
    ctx.session.supportReplyTarget = null;
    const replyText = ctx.message.text?.trim();
    if (!replyText) {
      return ctx.reply('Пустой ответ. Отменено.', adminMenu());
    }
    try {
      await bot.telegram.sendMessage(String(targetId), `✉️ Сообщение от администратора:\n\n${replyText}`);
      await ctx.reply('✅ Ответ отправлен.', adminMenu());
    } catch (e) {
      await ctx.reply('❗ Не удалось отправить ответ пользователю.', adminMenu());
    }
    return;
  }
});

// ==================== Функция отправки отчетов ====================
async function sendReportText(userId, period, customRangeInput) {
  const user = await getUserById(userId);
  if (!user || user.status !== "approved") {
    return "❌ Доступ запрещен. Пройдите регистрацию /start";
  }
  const fullName = user.name.trim().toLowerCase();
  const auth = new google.auth.GoogleAuth({
    keyFile: "creds.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const sheetNames = [
    "Сургут 1 (30 лет победы)",
    "Сургут 2 (Усольцева)",
    "Сургут 3 (Магистральная)"
  ];

  let allRows = [];
  for (const sheetName of sheetNames) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${sheetName}!A2:Z`,
    });
    if (res.data.values) allRows.push(...res.data.values);
  }
  const rows = allRows;

  function parseDate(str) {
    if (!str || typeof str !== "string" || !str.includes(".")) return null;
    const [day, month, year] = str.split(".");
    return new Date(`${month}/${day}/${year}`);
  }
  function getPreviousWeekRange() {
    const now = new Date();
    const day = now.getDay();
    const currentMonday = new Date(now);
    currentMonday.setDate(now.getDate() - ((day + 6) % 7));
    const lastMonday = new Date(currentMonday);
    lastMonday.setDate(currentMonday.getDate() - 7);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    lastMonday.setHours(0, 0, 0, 0);
    lastSunday.setHours(23, 59, 59, 999);
    return { fromDate: lastMonday, toDate: lastSunday };
  }
  function getCurrentWeekRange() {
    const now = new Date();
    const day = now.getDay();
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return { fromDate: monday, toDate: sunday };
  }

  if (period === "today" || period === "yesterday") {
    const today = new Date();
    const target = new Date(today);
    if (period === "yesterday") target.setDate(today.getDate() - 1);
    const targetStr = target.toLocaleDateString("ru-RU");

    const match = rows.find((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDateStr = r[1];
      const rowDate = parseDate(rowDateStr);
      return rowName === fullName && rowDate?.toLocaleDateString("ru-RU") === targetStr;
    });
    if (!match) {
      return `Данных за ${period === "today" ? "сегодня" : "вчера"} нет.`;
    }
    const [, date, , , , , , hours, km, orders, , , , times, nps, , , , , , , zaezd1, zaezd2, salary] = match;
    const totalZaezd = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
    return (
      `<b>📅 ${escapeHtml(date)}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>\n\n` +
      `• Отработано: <b>${escapeHtml(hours)}</b>\n` +
      `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
      `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezd)}</b>\n` +
      `• Сумма: <b>${escapeHtml(salary)}</b> ₽`
    );
  }
  if (period === "last_week") {
    const { fromDate, toDate } = getPreviousWeekRange();
    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDateStr = r[1];
      const rowDate = parseDate(rowDateStr);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return (
        `Нет данных за прошлую неделю ` +
        `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`
      );
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let times = "",
      rating = "";
    let message =
      `<b>📅 Табель за прошлую неделю</b>\n` +
      `Период: <b>${fromDate.toLocaleDateString("ru-RU")} – ${toDate.toLocaleDateString("ru-RU")}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const totalZaezd = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      message +=
        `\n\n📆 <b>${escapeHtml(date)}</b>\n` +
        `• Отработано: <b>${escapeHtml(hours)}</b> ч\n` +
        `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
        `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
        `• Заезды: <b>${escapeHtml(totalZaezd)}</b>\n` +
        `• Сумма: <b>${escapeHtml(salary)}</b> ₽`;
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += totalZaezd;
      times = time;
      rating = nps;
    }
    message +=
      `\n\n<b>ИТОГО</b>\n` +
      `• Отработано: <b>${escapeHtml(totalHours)}</b> ч\n` +
      `• Пробег: <b>${escapeHtml(totalKm)}</b> км\n` +
      `• Заказов: <b>${escapeHtml(totalOrders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezdy)}</b>\n` +
      `• Заработано: <b>${escapeHtml(totalSalary.toFixed(2))}</b> ₽\n` +
      `• Рейтинг: <b>${escapeHtml(rating)}</b>\n` +
      `• Среднее время: <b>${escapeHtml(times)}</b> мин`;
    return message;
  }
  if (period === "current_week") {
    const { fromDate, toDate } = getCurrentWeekRange();
    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDate = parseDate(r[1]);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return (
        `Нет данных за текущую неделю ` +
        `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`
      );
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let lastTime = "",
      lastRating = "";
    let message =
      `<b>📅 Табель за текущую неделю</b>\n` +
      `Период: <b>${fromDate.toLocaleDateString("ru-RU")} – ${toDate.toLocaleDateString("ru-RU")}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const zaezdy = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      message +=
        `\n\n📆 <b>${escapeHtml(date)}</b>\n` +
        `• Отработано: <b>${escapeHtml(hours)}</b> ч\n` +
        `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
        `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
        `• Заезды: <b>${escapeHtml(zaezdy)}</b>\n` +
        `• Сумма: <b>${escapeHtml(salary)}</b> ₽`;
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0, 10);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += zaezdy;
      lastTime = time;
      lastRating = nps;
    }
    message +=
      `\n\n<b>ИТОГО</b>\n` +
      `• Отработано: <b>${escapeHtml(totalHours)}</b> ч\n` +
      `• Пробег: <b>${escapeHtml(totalKm)}</b> км\n` +
      `• Заказов: <b>${escapeHtml(totalOrders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezdy)}</b>\n` +
      `• Заработано: <b>${escapeHtml(totalSalary.toFixed(2))}</b> ₽\n` +
      `• Рейтинг: <b>${escapeHtml(lastRating)}</b>\n` +
      `• Среднее время: <b>${escapeHtml(lastTime)}</b> мин`;
    return message;
  }
  if (period === "current_month" || period === "last_month") {
    const now = new Date();
    let fromDate, toDate;
    if (period === "current_month") {
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else {
      fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      toDate = new Date(now.getFullYear(), now.getMonth(), 0);
    }
    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);
    const daysInRange = Math.floor((toDate - fromDate) / (24 * 60 * 60 * 1000)) + 1;
    const summarizeOnly = daysInRange > 7;

    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDate = parseDate(r[1]);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return (
        `Нет данных за период ` +
        `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`
      );
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let lastTime = "",
      lastRating = "";
    let message =
      `<b>📅 Табель за период</b>\n` +
      `Период: <b>${fromDate.toLocaleDateString("ru-RU")} – ${toDate.toLocaleDateString("ru-RU")}</b>\n` +
      `👤 <b>${escapeHtml(user.name)}</b>`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const zaezdy = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      if (!summarizeOnly) {
        message +=
        `\n\n📆 <b>${escapeHtml(date)}</b>\n` +
        `• Отработано: <b>${escapeHtml(hours)}</b> ч\n` +
        `• Пробег: <b>${escapeHtml(km)}</b> км\n` +
        `• Заказы: <b>${escapeHtml(orders)}</b>\n` +
        `• Заезды: <b>${escapeHtml(zaezdy)}</b>\n` +
        `• Сумма: <b>${escapeHtml(salary)}</b> ₽`;
      }
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0, 10);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += zaezdy;
      lastTime = time;
      lastRating = nps;
    }
    message +=
      `\n\n<b>ИТОГО</b>\n` +
      `• Отработано: <b>${escapeHtml(totalHours)}</b> ч\n` +
      `• Пробег: <b>${escapeHtml(totalKm)}</b> км\n` +
      `• Заказов: <b>${escapeHtml(totalOrders)}</b>\n` +
      `• Заезды: <b>${escapeHtml(totalZaezdy)}</b>\n` +
      `• Заработано: <b>${escapeHtml(totalSalary.toFixed(2))}</b> ₽\n` +
      `• Рейтинг: <b>${escapeHtml(lastRating)}</b>\n` +
      `• Среднее время: <b>${escapeHtml(lastTime)}</b> мин`;
    return message;
  }
  if (period === "custom") {
    if (!customRangeInput || !/\d{2}\.\d{2}\.\d{4}-\d{2}\.\d{2}\.\d{4}/.test(customRangeInput)) {
      throw new Error("Некорректный формат. Используйте ДД.ММ.ГГГГ-ДД.ММ.ГГГГ");
    }
    const [fromStr, toStr] = customRangeInput.split("-");
    const fromDate = parseDate(fromStr);
    const toDate = parseDate(toStr);
    if (!fromDate || !toDate || fromDate > toDate) {
      throw new Error("Некорректные даты в периоде");
    }
    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);
    const daysInRange = Math.floor((toDate - fromDate) / (24 * 60 * 60 * 1000)) + 1;
    const summarizeOnly = daysInRange > 7;
    const filtered = rows.filter((r) => {
      const rowName = r[2]?.trim().toLowerCase();
      const rowDate = parseDate(r[1]);
      return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
    });
    if (filtered.length === 0) {
      return (
        `Нет данных за период ` +
        `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`
      );
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let lastTime = "",
      lastRating = "";
    let message =
      `📅 Табель за период ` +
      `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})\n` +
      `👤 ${user.name}`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const zaezdy = parseFloat(zaezd1 || 0) + parseFloat(zaezд2 || 0);
      if (!summarizeOnly) {
      message +=
        `\n\n📆 ${date}:\n` +
        `Отработано: ${hours} ч\n` +
        `Пробег: ${km} км\n` +
        `Заказы: ${orders}\n` +
        `Заезды: ${zaezdy}\n` +
        `Сумма: ${salary} ₽`;
      }
      totalHours += parseFloat(hours || 0);
      totalKm += parseFloat(km || 0);
      totalOrders += parseInt(orders || 0, 10);
      totalSalary += parseFloat(salary || 0);
      totalZaezdy += zaezdy;
      lastTime = time;
      lastRating = nps;
    }
    message +=
      `\n\nИТОГО:\n` +
      `Отработано: ${totalHours} ч\n` +
      `Пробег: ${totalKm} км\n` +
      `Заказов: ${totalOrders}\n` +
      `Заезды: ${totalZaezdy}\n` +
      `Заработано: ${totalSalary.toFixed(2)} ₽\n` +
      `Рейтинг: ${lastRating}\n` +
      `Среднее время: ${lastTime} мин`;
    return message;
  }
  return "Нет данных.";
}

// ==================== Обработка ошибок ====================
bot.catch(async (err, ctx) => {
  const userId = ctx.from?.id || "unknown";
  await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.", getMainMenuInline());
});

// ==================== Запуск бота ====================
initSchema()
  .then(() => bot.launch())
  .then(() => {
    console.log("Бот запущен!");
  })
  .catch((err) => {
    console.error("Ошибка запуска:", err.message);
    process.exit(1);
  });

// ==================== Обработка завершения работы ====================
process.once("SIGINT", () => {
  bot.stop("SIGINT");
  process.exit();
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  process.exit();
});
