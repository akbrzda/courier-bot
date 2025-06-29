require("dotenv").config();
const { Telegraf, Scenes, Markup, session } = require("telegraf");
const fs = require("fs");
const { google } = require("googleapis");
const moment = require("moment-timezone");
const cron = require("node-cron");

const { ensureWeekSheetAndAsk, upsertSchedule, showSchedule, parseAndAppend } = require("./grafik.js");

// ==================== Инициализация бота ====================
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const SPREADSHEET_ID = process.env.GRAFIK;

// ==================== Работа с пользователями ====================
let users = fs.existsSync("users.json") ? JSON.parse(fs.readFileSync("users.json")) : {};

function saveUsers() {
  fs.writeFileSync("users.json", JSON.stringify(users, null, 2));
}

// ==================== Google Sheets ====================
const auth = new google.auth.GoogleAuth({
  keyFile: "creds.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

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
  for (const [userId, user] of Object.entries(users)) {
    if (user.status === "approved") {
      try {
        await bot.telegram.sendMessage(
          userId,
          "⏰ Напоминаем! Пожалуйста, отправьте свой график на следующую неделю через кнопку «Отправить график» в меню."
        );
      } catch (e) {
        console.error(`[Напоминание] Ошибка для ${userId}:`, e.message);
      }
    }
  }
});

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

// ==================== Главное меню ====================
function mainMenu() {
  return Markup.keyboard([
    ["📅 Табель за сегодня", "📆 Табель за вчера"],
    ["📊 Табель за прошлую неделю", "📊 Табель за текущую неделю"],
    ["Отправить график", "Посмотреть график"],
    ["Изменить график"],
  ]).resize();
}

// ==================== Админское меню ====================
function adminMenu() {
  return Markup.keyboard([
    ["👥 Список курьеров", "❌ Удалить курьера"],
    ["Посмотреть график", "🔙 Главное меню"],
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

  users[userId] = { name, status: "pending" };
  saveUsers();

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

deleteCourierScene.enter(async (ctx) => {
  try {
    console.log("[deleteCourierScene.enter] users:", users);
    const approvedUsers = Object.entries(users)
      .filter(([id, user]) => user.status === "approved")
      .map(([id, user]) => ({ id, name: user.name }));

    console.log("[deleteCourierScene.enter] approvedUsers:", approvedUsers);

    if (approvedUsers.length === 0) {
      await ctx.reply("Нет зарегистрированных курьеров.", adminMenu());
      return await ctx.scene.leave();
    }

    const keyboard = approvedUsers.map((user) => [Markup.button.callback(user.name, `delete_${user.id}`)]);

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
    console.log("[deleteCourierScene.action] userId:", userId);
    const user = users[userId];
    console.log("[deleteCourierScene.action] user:", user);

    if (!user) {
      await ctx.answerCbQuery("Курьер не найден");
      console.warn("[deleteCourierScene.action] Не найден пользователь:", userId);
      return await ctx.scene.leave();
    }

    delete users[userId];
    try {
      saveUsers();
      console.log("[deleteCourierScene.action] Пользователь удалён и users сохранён:", userId);
    } catch (e) {
      console.error("[deleteCourierScene.action] Ошибка при сохранении users:", e);
    }

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
const stage = new Scenes.Stage([registrationScene, deleteCourierScene]);
bot.use(session());
bot.use(stage.middleware());

// ==================== Обработчики команд ====================
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const fullNameTG = `${ctx.from.first_name} ${ctx.from.last_name || ""}`.trim();

  if (userId === ADMIN_ID) {
    return await ctx.reply("👋 Добро пожаловать, администратор!", adminMenu());
  }

  if (users[userId]?.status === "approved") {
    return await ctx.reply(`✅ Вы уже зарегистрированы как ${users[userId].name}`, mainMenu());
  }

  if (users[userId]?.status === "pending") {
    return await ctx.reply("⏳ Ваша заявка на регистрацию рассматривается администратором.", mainMenu());
  }

  return await ctx.scene.enter("registration");
});

bot.command("menu", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId === ADMIN_ID) {
    await ctx.reply("Админское меню:", adminMenu());
  } else if (users[userId]?.status === "approved") {
    await ctx.reply("Главное меню:", mainMenu());
  } else {
    await ctx.reply("Пройдите регистрацию /start");
  }
});

bot.help(async (ctx) => {
  const userId = ctx.from.id.toString();

  let helpText = "Помощь по боту:\n";
  helpText += "/start - начать регистрацию\n";
  helpText += "/menu - показать меню\n";

  if (users[userId]?.status === "approved") {
    helpText += "\nДоступные команды:\n";
    helpText += "📅 Табель за сегодня\n";
    helpText += "📆 Табель за вчера\n";
    helpText += "📊 Табель за прошлую неделю\n";
    helpText += "📊 Табель за текущую неделю\n";
  }

  if (userId === ADMIN_ID) {
    helpText += "\n\nАдмин-команды:\n";
    helpText += "👥 Список курьеров\n";
    helpText += "❌ Удалить курьера";
  }

  await ctx.reply(helpText, userId === ADMIN_ID ? adminMenu() : mainMenu());
});

// ==================== Обработчики сообщений ====================
bot.hears("📅 Табель за сегодня", async (ctx) => {
  await sendReport(ctx, "today");
});

bot.hears("📆 Табель за вчера", async (ctx) => {
  await sendReport(ctx, "yesterday");
});

bot.hears("📊 Табель за прошлую неделю", async (ctx) => {
  await sendReport(ctx, "last_week");
});

bot.hears("📊 Табель за текущую неделю", async (ctx) => {
  await sendReport(ctx, "current_week");
});

// Админские команды
bot.hears("👥 Список курьеров", async (ctx) => {
  const userId = ctx.from.id.toString();

  if (userId !== ADMIN_ID) {
    return await ctx.reply("⛔ Недостаточно прав", mainMenu());
  }

  const approvedUsers = Object.entries(users)
    .filter(([id, user]) => user.status === "approved")
    .map(([id, user]) => ({ id, name: user.name }));

  if (approvedUsers.length === 0) {
    return await ctx.reply("Нет зарегистрированных курьеров.", adminMenu());
  }

  let message = "📋 Список зарегистрированных курьеров:\n\n";
  approvedUsers.forEach((user, index) => {
    message += `${index + 1}. ${user.name} (ID: ${user.id})\n`;
  });

  await ctx.reply(message, adminMenu());
});

bot.hears("❌ Удалить курьера", async (ctx) => {
  const userId = ctx.from.id.toString();

  if (userId !== ADMIN_ID) {
    return await ctx.reply("⛔ Недостаточно прав", mainMenu());
  }

  await ctx.scene.enter("deleteCourier");
});

bot.hears("🔙 Главное меню", async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.reply("Главное меню", userId === ADMIN_ID ? adminMenu() : mainMenu());
});

// ==================== Обработчики callback-запросов ====================
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const adminId = ctx.from.id.toString();
  if (data === "SHOW_SCHEDULE_THIS" || data === "SHOW_SCHEDULE_NEXT") {
    await ctx.answerCbQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log("Ошибка удаления сообщения с кнопками:", e);
    }
    await handleShowScheduleInline(ctx, data === "SHOW_SCHEDULE_NEXT");
    return;
  }
  // Обработка отмены удаления
  if (data === "cancel_delete") {
    await ctx.answerCbQuery("Отменено");
    await ctx.deleteMessage();
    return;
  }

  // Проверка прав администратора для других действий
  if (adminId !== ADMIN_ID) {
    return await ctx.answerCbQuery("⛔ Недостаточно прав");
  }

  // Обработка подтверждения/отклонения регистрации
  if (data.startsWith("approve_") || data.startsWith("reject_")) {
    const userId = data.split("_")[1];
    const user = users[userId];

    if (!user) {
      return await ctx.answerCbQuery("Пользователь не найден");
    }

    try {
      if (data.startsWith("approve_")) {
        users[userId].status = "approved";
        saveUsers();

        await ctx.editMessageText(`✅ Курьер ${user.name} подтверждён.`);
        await ctx.answerCbQuery("Пользователь подтверждён");

        await bot.telegram.sendMessage(userId, `✅ Ваша заявка одобрена!\nТеперь вам доступно меню.`, mainMenu());
      }

      if (data.startsWith("reject_")) {
        delete users[userId];
        saveUsers();

        await ctx.editMessageText(`❌ Заявка от ${user.name} отклонена.`);
        await ctx.answerCbQuery("Заявка отклонена");
        await bot.telegram.sendMessage(userId, `❌ Ваша заявка отклонена.`);
      }
    } catch (err) {
      await ctx.answerCbQuery("⚠️ Произошла ошибка");
    }
    return;
  }

  // Обработка удаления курьера
  if (data.startsWith("delete_")) {
    const userId = data.split("_")[1];
    const user = users[userId];

    if (!user) {
      await ctx.answerCbQuery("Курьер не найден");
      return;
    }

    delete users[userId];
    saveUsers();

    await ctx.editMessageText(`Курьер ${user.name} удалён.`);
    await ctx.answerCbQuery("Курьер удалён");

    try {
      await bot.telegram.sendMessage(userId, "❌ Ваш аккаунт был удалён администратором.");
    } catch (err) {}
    return;
  }

  // Если callback не распознан
  await ctx.answerCbQuery("Неизвестная команда");
});
// ==================== Интеграция grafik.js ====================

bot.hears("Отправить график", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!users[userId] || users[userId].status !== "approved") {
    return ctx.reply("❌ Доступ запрещён. Пройдите регистрацию /start", mainMenu());
  }
  ctx.session.waitingSchedule = true;
  try {
    ctx.session.currentSheet = await ensureWeekSheetAndAsk(SPREADSHEET_ID, ctx.chat.id, ctx.telegram);
  } catch (e) {
    console.error(e);
    await ctx.reply("❗ Ошибка: " + e.message, mainMenu());
    ctx.session.waitingSchedule = false;
  }
});

bot.hears("Посмотреть график", (ctx) => {
  return ctx.reply(
    "Выберите неделю:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Текущая неделя", "SHOW_SCHEDULE_THIS"), Markup.button.callback("Следующая неделя", "SHOW_SCHEDULE_NEXT")],
    ])
  );
});

async function handleShowScheduleInline(ctx, nextWeek) {
  const userId = ctx.from.id.toString();
  const isAdmin = userId === process.env.ADMIN_ID;
  if (!isAdmin && (!users[userId] || users[userId].status !== "approved")) {
    return ctx.reply("❌ Доступ запрещён");
  }
  const fio = isAdmin ? null : users[userId]?.name;

  try {
    await showSchedule(
      SPREADSHEET_ID,
      ctx.chat.id,
      ctx.telegram,
      nextWeek, // true/false: следующая/текущая неделя
      isAdmin,
      fio
    );
  } catch (e) {
    console.error(e);
    await ctx.reply("❗ " + e.message);
  }
}

bot.hears("Изменить график", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!users[userId] || users[userId].status !== "approved") {
    return ctx.reply("❌ Доступ запрещён. Пройдите регистрацию /start", mainMenu());
  }
  ctx.session.waitingScheduleEdit = true; // для дальнейшего различения в on('text')
  try {
    ctx.session.currentSheet = await ensureWeekSheetAndAsk(SPREADSHEET_ID, ctx.chat.id, ctx.telegram, false);
    await ctx.reply("✏️ Пришлите новый график — он полностью заменит предыдущий!", mainMenu());
  } catch (e) {
    console.error(e);
    await ctx.reply("❗ Ошибка: " + e.message, mainMenu());
    ctx.session.waitingScheduleEdit = false;
  }
});

// Обработка текста с расписанием
bot.on("text", async (ctx) => {
  // Изменить график
  if (ctx.session.waitingScheduleEdit) {
    ctx.session.waitingScheduleEdit = false;
    try {
      await upsertSchedule(SPREADSHEET_ID, ctx.session.currentSheet, ctx.message.text.trim(), ctx.chat.id, ctx.telegram);
      await ctx.reply("✅ Ваш график обновлён!", mainMenu());
    } catch (e) {
      console.error(e);
      await ctx.reply("❗ Ошибка: " + e.message, mainMenu());
    }
    return;
  }

  // Отправить график (новый)
  if (ctx.session.waitingSchedule) {
    ctx.session.waitingSchedule = false;
    const text = ctx.message.text.trim();
    const sheetName = ctx.session.currentSheet;
    try {
      await parseAndAppend(SPREADSHEET_ID, sheetName, text, ctx.from.id.toString());
      await ctx.reply("✅ График сохранён!", mainMenu());
    } catch (e) {
      console.error(e);
      await ctx.reply(e.message, mainMenu());
    }
    return;
  }
});

// ==================== Функция отправки отчетов ====================
async function sendReport(ctx, period) {
  const userId = ctx.from.id.toString();

  if (!users[userId] || users[userId].status !== "approved") {
    return await ctx.reply("❌ Доступ запрещен. Пройдите регистрацию /start", mainMenu());
  }

  const fullName = users[userId].name.trim().toLowerCase();

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    const sheetNames = ["Сургут 1 (30 лет победы)", "Сургут 2 (Усольцева)", "Сургут 3 (Магистральная)"];

    let allRows = [];

    for (const sheetName of sheetNames) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: `${sheetName}!A2:Z`,
      });

      if (res.data.values) {
        allRows.push(...res.data.values);
      }
    }

    const rows = allRows;
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
        return await ctx.reply(`Данных за ${period === "today" ? "сегодня" : "вчера"} нет.`, mainMenu());
      }

      const [, date, , , , , , hours, km, orders, , , , times, nps, , , , , , , zaezd1, zaezd2, salary] = match;
      const totalZaezd = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
      return await ctx.reply(
        `📅 ${date}\n👤 ${users[userId].name}\n\n` +
          `Отработано: ${hours}\n` +
          `Пробег: ${km} км\n` +
          `Заказы: ${orders}\n` +
          `Заезды: ${totalZaezd}\n` +
          `Сумма: ${salary} ₽`,
        mainMenu()
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
        return await ctx.reply(
          `Нет данных за прошлую неделю ` + `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`,
          mainMenu()
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
        `📅 Табель за прошлую неделю ` +
        `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})\n` +
        `👤 ${users[userId].name}`;

      for (const r of filtered) {
        const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
        const totalZaezd = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
        message +=
          `\n\n📆 ${date}:\n` +
          `Отработано: ${hours} ч\n` +
          `Пробег: ${km} км\n` +
          `Заказы: ${orders}\n` +
          `Заезды: ${totalZaezd}\n` +
          `Сумма: ${salary} ₽`;

        totalHours += parseFloat(hours || 0);
        totalKm += parseFloat(km || 0);
        totalOrders += parseInt(orders || 0);
        totalSalary += parseFloat(salary || 0);
        totalZaezdy += totalZaezd;
        times = time;
        rating = nps;
      }

      message +=
        `\n\nИТОГО:\n` +
        `Отработано: ${totalHours} ч\n` +
        `Пробег: ${totalKm} км\n` +
        `Заказов: ${totalOrders}\n` +
        `Заезды: ${totalZaezdy}\n` +
        `Заработано: ${totalSalary.toFixed(2)} ₽\n` +
        `Рейтинг: ${rating}\n` +
        `Среднее время: ${times} мин`;

      return await ctx.reply(message, mainMenu());
    }

    if (period === "current_week") {
      const { fromDate, toDate } = getCurrentWeekRange();

      const filtered = rows.filter((r) => {
        const rowName = r[2]?.trim().toLowerCase();
        const rowDate = parseDate(r[1]);
        return rowName === fullName && rowDate && rowDate >= fromDate && rowDate <= toDate;
      });

      if (filtered.length === 0) {
        return await ctx.reply(
          `Нет данных за текущую неделю ` + `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`,
          mainMenu()
        );
      }

      // аккумулируем итоги
      let totalHours = 0,
        totalKm = 0,
        totalOrders = 0,
        totalSalary = 0,
        totalZaezdy = 0;
      let lastTime = "",
        lastRating = "";
      let message =
        `📅 Табель за текущую неделю ` +
        `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})\n` +
        `👤 ${users[userId].name}`;

      for (const r of filtered) {
        const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
        const zaezdy = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);

        message +=
          `\n\n📆 ${date}:\n` +
          `Отработано: ${hours} ч\n` +
          `Пробег: ${km} км\n` +
          `Заказы: ${orders}\n` +
          `Заезды: ${zaezdy}\n` +
          `Сумма: ${salary} ₽`;

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

      return await ctx.reply(message, mainMenu());
    }
  } catch (err) {
    return await ctx.reply("⚠️ Произошла ошибка при получении данных. Попробуйте позже.", mainMenu());
  }
}

// ==================== Обработка ошибок ====================
bot.catch(async (err, ctx) => {
  const userId = ctx.from?.id || "unknown";
  await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.", mainMenu());
});

// ==================== Запуск бота ====================
bot
  .launch()
  .then(() => {
    console.log("Бот запущен!");
  })
  .catch((err) => {
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
