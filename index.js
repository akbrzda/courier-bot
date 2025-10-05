require("dotenv").config();
const { Telegraf, Scenes, Markup, session } = require("telegraf");
const { google } = require("googleapis");
const moment = require("moment-timezone");
const cron = require("node-cron");
const {
  ensureWeekSheetAndAsk,
  upsertSchedule,
  upsertScheduleForFio,
  getScheduleText,
  getAdminScheduleText,
  parseAndAppend,
  isScheduleSubmissionAllowed,
  getWeekBounds,
} = require("./grafik.js");
const { initSchema } = require("./db");
const { getUserById, upsertUserBasic, setUserStatus, deleteUser, listApprovedUsers, listAllUsers, updateUserName } = require("./services.users");
const { logAction, logTabReport, logScheduleAction, logAuthAction, logError, logBotStart, logMenuNavigation, logMessageSent } = require("./logger");
const {
  getAllLinks,
  getLinkById,
  createLink,
  deleteLink,
  getAllTrainingMaterials,
  getTrainingMaterialById,
  createTrainingMaterial,
  deleteTrainingMaterial,
} = require("./services.content");
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SPREADSHEET_ID = process.env.GRAFIK;

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

/*cron.schedule(
  "0 12 * * 5",
  async () => {
    const now = moment().tz("Asia/Yekaterinburg");
    console.log(`[Напоминание] Рассылаю напоминание в ${now.format("YYYY-MM-DD HH:mm")}`);

    try {
      await logAction(
        bot,
        "Запуск автоматической рассылки напоминаний",
        "system",
        {},
        {
          scheduledTime: now.format("YYYY-MM-DD HH:mm"),
          dayOfWeek: "пятница",
        }
      );

      const approvedUsers = await listApprovedUsers();
      let successCount = 0;
      let errorCount = 0;

      for (const u of approvedUsers) {
        let attempt = 0;
        let sent = false;
        while (attempt < 4 && !sent) {
          try {
            await bot.telegram.sendMessage(
              String(u.id),
              "⏰ Напоминаем! Пожалуйста, отправьте свой график на следующую неделю через кнопку «Отправить график» в меню."
            );
            successCount++;
            sent = true;
          } catch (e) {
            attempt++;
            const baseWait = 150;
            const waitMs = baseWait * Math.pow(2, attempt);
            console.error(`[Напоминание] Ошибка для ${u.id}, попытка ${attempt}:`, e.message);
            if (e && e.response && e.response.error_code === 429) {
              await new Promise((r) => setTimeout(r, waitMs + 500));
            } else {
              await new Promise((r) => setTimeout(r, waitMs));
            }
            if (attempt >= 4) {
              errorCount++;
              await logError(bot, e, u.id, { name: u.name, username: u.username }, "Отправка напоминания");
            }
          }
        }

        await new Promise((r) => setTimeout(r, 35));
      }

      await logAction(
        bot,
        "Завершение автоматической рассылки напоминаний",
        "system",
        {},
        {
          totalUsers: approvedUsers.length,
          successCount,
          errorCount,
        }
      );
    } catch (e) {
      console.error("[Напоминание] Ошибка выборки пользователей:", e.message);
      await logError(bot, e, "system", {}, "Автоматическая рассылка напоминаний");
    }
  },
  { timezone: "Asia/Yekaterinburg" }
);*/

function parseDate(str) {
  if (!str || typeof str !== "string" || !str.includes(".")) return null;
  const [day, month, year] = str.split(".");
  return new Date(`${month}/${day}/${year}`);
}

function escapeHtml(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getMainMenuInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📅 Табель", "menu:report")],
    [Markup.button.callback("📊 График", "menu:schedule")],
    [Markup.button.callback("🔗 Полезные ссылки", "menu:links")],
    [Markup.button.callback("📚 Обучение", "menu:training")],
    [Markup.button.callback("✉️ Написать администратору", "support:start")],
  ]);
}

function isAdminId(id) {
  if (!id) return false;
  return ADMIN_IDS.includes(String(id));
}

function getReportMenuInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📅 За сегодня", "report:today")],
    [Markup.button.callback("📆 За вчера", "report:yesterday")],
    [Markup.button.callback("📊 Текущая неделя", "report:week_current")],
    [Markup.button.callback("📊 Прошлая неделя", "report:week_prev")],
    [Markup.button.callback("🗓 Этот месяц", "report:month_current")],
    [Markup.button.callback("🗓 Прошлый месяц", "report:month_prev")],
    [Markup.button.callback("📅 Выбрать период…", "report:custom")],
    [Markup.button.callback("◀️ Назад", "menu:main")],
  ]);
}

function getScheduleMenuInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👁 Посмотреть график", "schedule:view")],
    //[Markup.button.callback("➕ Отправить график", "schedule:send")],
    [Markup.button.callback("◀️ Назад", "menu:main")],
  ]);
}
function getBackInlineMenu(callbackBack) {
  return Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", callbackBack)]]);
}

function adminMenu() {
  return Markup.keyboard([
    ["👥 Список курьеров", "❌ Удалить курьера"],
    ["📋 График: текущая неделя", "📋 График: следующая неделя"],
    ["✏️ Изменить ФИО курьера", "📢 Рассылка"],
    ["🔗 Управление ссылками", "📚 Управление обучением"],
  ]).resize();
}

// Функция для создания пагинированной клавиатуры
function createPaginatedKeyboard(items, page, itemsPerPage, callbackPrefix, isAdmin = false) {
  const start = page * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = items.slice(start, end);
  const totalPages = Math.ceil(items.length / itemsPerPage);

  const keyboard = [];

  // Кнопки действий для админа (только если это админ-режим)
  if (isAdmin) {
    keyboard.push([Markup.button.callback("➕ Добавить", `${callbackPrefix}:add`), Markup.button.callback("❌ Удалить", `${callbackPrefix}:delete`)]);
  }

  // Элементы списка
  pageItems.forEach((item) => {
    if (callbackPrefix === "links") {
      keyboard.push([Markup.button.url(item.title, item.url)]);
    } else {
      keyboard.push([Markup.button.callback(item.title, `training:view_${item.id}`)]);
    }
  });

  // Кнопки пагинации (если страниц больше 1)
  if (totalPages > 1) {
    const paginationButtons = [];
    if (page > 0) {
      paginationButtons.push(Markup.button.callback("⬅️", `${callbackPrefix}:page_${page - 1}`));
    }
    paginationButtons.push(Markup.button.callback(`${page + 1}/${totalPages}`, `${callbackPrefix}:noop`));
    if (page < totalPages - 1) {
      paginationButtons.push(Markup.button.callback("➡️", `${callbackPrefix}:page_${page + 1}`));
    }
    keyboard.push(paginationButtons);
  }

  // Кнопка "Назад" (только для обычных пользователей)
  if (!isAdmin) {
    keyboard.push([Markup.button.callback("◀️ Назад", "menu:main")]);
  }

  return Markup.inlineKeyboard(keyboard);
}

const registrationScene = new Scenes.BaseScene("registration");
const changeCourierNameScene = new Scenes.BaseScene("changeCourierName");

// Сцены для управления ссылками
const addLinkScene = new Scenes.BaseScene("addLink");
const deleteLinkScene = new Scenes.BaseScene("deleteLink");

// Сцены для управления обучением
const addTrainingScene = new Scenes.BaseScene("addTraining");
const deleteTrainingScene = new Scenes.BaseScene("deleteTraining");

registrationScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.reply(
    "👋 Привет! Введите своё Имя и Фамилия для регистрации. Например, Иванов Иван. Обязательно, без отчества!",
    Markup.removeKeyboard()
  );
});

registrationScene.on("text", async (ctx) => {
  const userId = ctx.from.id.toString();
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

  if (!name || name.length < 3) {
    await logAction(bot, "Попытка регистрации с некорректным ФИО", userId, userInfo, { enteredName: name });
    return await ctx.reply("❗ Пожалуйста, введите корректное ФИО (минимум 3 символа)");
  }

  try {
    await upsertUserBasic(userId, {
      name,
      status: "pending",
      username: ctx.from.username ? `@${ctx.from.username}` : null,
      first_name: ctx.from.first_name || null,
      last_name: ctx.from.last_name || null,
    });

    await logAuthAction(bot, userId, userInfo, "Подача заявки на регистрацию", { enteredName: name });

    const telegramUserInfo = ctx.from;
    const username = telegramUserInfo.username ? `@${telegramUserInfo.username}` : "не указан";
    const fullTelegramName = `${telegramUserInfo.first_name || ""} ${telegramUserInfo.last_name || ""}`.trim();

    for (const admin of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(
          admin,
          `📥 Новая заявка на регистрацию:\n` +
            `👤 Введённое ФИО: ${name}\n` +
            `🔹 Telegram: ${fullTelegramName} (${username})\n` +
            `🆔 Telegram ID: ${userId}`,
          Markup.inlineKeyboard([
            Markup.button.callback(`✅ Подтвердить`, `approve_${userId}`),
            Markup.button.callback(`❌ Отклонить`, `reject_${userId}`),
          ])
        );
      } catch (e) {
        console.warn("Не удалось отправить уведомление администратору", admin, e.message);
        await logError(bot, e, userId, userInfo, "Отправка уведомления администратору");
      }
    }

    await ctx.reply("⏳ Заявка отправлена! Ожидайте подтверждения администратора.");
    await ctx.scene.leave();
  } catch (err) {
    await logError(bot, err, userId, userInfo, "Обработка заявки на регистрацию");
    return await ctx.reply("⚠️ Произошла ошибка при отправке заявки. Попробуйте позже.");
  }
});

registrationScene.on("message", async (ctx) => {
  await ctx.reply("Пожалуйста, введите только текст");
});

const deleteCourierScene = new Scenes.BaseScene("deleteCourier");
const broadcastScene = new Scenes.BaseScene("broadcast");
broadcastScene.enter(async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  ctx.session = ctx.session || {};
  ctx.session.broadcastText = null;
  ctx.session.broadcastPhoto = null;
  ctx.session.broadcastLinkUrl = null;
  ctx.session.broadcastLinkTitle = null;
  ctx.session.broadcastStep = "text"; // text, photo, link_url, link_title, confirm

  await ctx.reply("📝 Шаг 1/4: Введите текст рассылки:", Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "broadcast:cancel")]]));
});

broadcastScene.action("broadcast:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  return ctx.scene.leave();
});

broadcastScene.action("broadcast:skip_photo", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.broadcastPhoto = null;
  ctx.session.broadcastStep = "link_url";

  await ctx.reply(
    "🔗 Шаг 3/4: Отправьте URL ссылки или нажмите 'Пропустить':",
    Markup.inlineKeyboard([
      [Markup.button.callback("⏭ Пропустить", "broadcast:skip_link")],
      [Markup.button.callback("❌ Отмена", "broadcast:cancel")],
    ])
  );
});

broadcastScene.action("broadcast:skip_link", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.broadcastLinkUrl = null;
  ctx.session.broadcastLinkTitle = null;
  ctx.session.broadcastStep = "confirm";

  await showBroadcastPreview(ctx);
});

async function showBroadcastPreview(ctx) {
  const text = ctx.session?.broadcastText || "";
  const photo = ctx.session?.broadcastPhoto;
  const linkUrl = ctx.session?.broadcastLinkUrl;
  const linkTitle = ctx.session?.broadcastLinkTitle;

  let previewText = "📋 Предварительный просмотр рассылки:\n\n";
  previewText += `Текст: ${text}\n`;
  if (photo) previewText += `📷 Фото: прикреплено\n`;
  if (linkUrl) previewText += `🔗 Ссылка: ${linkTitle} (${linkUrl})\n`;

  await ctx.reply(
    previewText + "\n✅ Подтвердите отправку рассылки всем зарегистрированным пользователям:",
    Markup.inlineKeyboard([[Markup.button.callback("✅ Отправить", "broadcast:send")], [Markup.button.callback("❌ Отмена", "broadcast:cancel")]])
  );
}

broadcastScene.on("text", async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    return ctx.reply("⛔ Недостаточно прав");
  }

  const text = ctx.message.text?.trim();
  const step = ctx.session.broadcastStep;

  if (step === "text") {
    if (!text) {
      return ctx.reply("Текст пуст. Введите текст или нажмите Отмена.");
    }
    ctx.session.broadcastText = text;
    ctx.session.broadcastStep = "photo";

    await ctx.reply(
      "📷 Шаг 2/4: Отправьте фото или нажмите 'Пропустить':",
      Markup.inlineKeyboard([
        [Markup.button.callback("⏭ Пропустить", "broadcast:skip_photo")],
        [Markup.button.callback("❌ Отмена", "broadcast:cancel")],
      ])
    );
  } else if (step === "link_url") {
    if (!text) {
      return ctx.reply("URL не может быть пустым. Введите URL или нажмите 'Пропустить'.");
    }
    // Простая валидация URL
    if (!text.startsWith("http://") && !text.startsWith("https://")) {
      return ctx.reply("❌ URL должен начинаться с http:// или https://");
    }
    ctx.session.broadcastLinkUrl = text;
    ctx.session.broadcastStep = "link_title";

    await ctx.reply(
      "✏️ Шаг 4/4: Введите название для кнопки ссылки:",
      Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "broadcast:cancel")]])
    );
  } else if (step === "link_title") {
    if (!text) {
      return ctx.reply("Название не может быть пустым. Введите название кнопки.");
    }
    ctx.session.broadcastLinkTitle = text;
    ctx.session.broadcastStep = "confirm";

    await showBroadcastPreview(ctx);
  }
});

broadcastScene.on("photo", async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    return ctx.reply("⛔ Недостаточно прав");
  }

  const step = ctx.session.broadcastStep;

  if (step === "photo") {
    const photo = ctx.message.photo;
    if (!photo || photo.length === 0) {
      return ctx.reply("Фото не найдено. Попробуйте снова.");
    }

    // Берём фото наибольшего размера
    const fileId = photo[photo.length - 1].file_id;
    ctx.session.broadcastPhoto = fileId;
    ctx.session.broadcastStep = "link_url";

    await ctx.reply(
      "🔗 Шаг 3/4: Отправьте URL ссылки или нажмите 'Пропустить':",
      Markup.inlineKeyboard([
        [Markup.button.callback("⏭ Пропустить", "broadcast:skip_link")],
        [Markup.button.callback("❌ Отмена", "broadcast:cancel")],
      ])
    );
  } else {
    await ctx.reply("Сейчас ожидается другой тип данных. Используйте кнопки для навигации.");
  }
});

broadcastScene.action("broadcast:send", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (_) {}

  const text = ctx.session?.broadcastText;
  const photo = ctx.session?.broadcastPhoto;
  const linkUrl = ctx.session?.broadcastLinkUrl;
  const linkTitle = ctx.session?.broadcastLinkTitle;

  if (!text) {
    await ctx.reply("Текст рассылки не найден. Попробуйте снова.");
    return ctx.scene.leave();
  }

  try {
    const users = await listAllUsers();
    let ok = 0,
      fail = 0;

    for (const u of users) {
      let attempt = 0;
      let sent = false;

      while (attempt < 4 && !sent) {
        try {
          const messageOptions = {};

          // Добавляем inline-кнопку, если есть ссылка
          if (linkUrl && linkTitle) {
            messageOptions.reply_markup = {
              inline_keyboard: [[{ text: linkTitle, url: linkUrl }]],
            };
          }

          // Отправляем фото с текстом или просто текст
          if (photo) {
            await bot.telegram.sendPhoto(String(u.id), photo, {
              caption: text,
              ...messageOptions,
            });
          } else {
            await bot.telegram.sendMessage(String(u.id), text, messageOptions);
          }

          ok += 1;
          sent = true;
        } catch (e) {
          attempt++;
          const waitMs = 100 * Math.pow(2, attempt);
          if (e && e.response && e.response.error_code === 429) {
            await new Promise((r) => setTimeout(r, waitMs + 300));
          } else {
            await new Promise((r) => setTimeout(r, waitMs));
          }
          if (attempt >= 4) {
            fail += 1;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 35));
    }

    await ctx.reply(`✅ Рассылка завершена. Успех: ${ok}, ошибки: ${fail}.`, adminMenu());
  } catch (e) {
    await ctx.reply("❗ Ошибка рассылки: " + e.message, adminMenu());
  }

  return ctx.scene.leave();
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

changeCourierNameScene.enter(async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  ctx.session = ctx.session || {};
  ctx.session.changeTarget = null;
  ctx.session.awaitingTarget = false;
  ctx.session.awaitingNewName = false;

  try {
    const approvedUsers = await listApprovedUsers();
    if (approvedUsers.length === 0) {
      await ctx.reply("Нет зарегистрированных курьеров.");
      return ctx.scene.leave();
    }
    const keyboard = approvedUsers.map((u) => [Markup.button.callback(`${u.name} (${u.username || "ID:" + u.id})`, `changeName_${u.id}`)]);
    keyboard.push([Markup.button.callback("❌ Отмена", "changeName:cancel")]);
    await ctx.reply("Выберите курьера для изменения ФИО:", Markup.inlineKeyboard(keyboard));
  } catch (e) {
    console.error("[changeCourierNameScene.enter]", e);
    await ctx.reply("Произошла ошибка. Попробуйте позже.");
    return ctx.scene.leave();
  }
});

changeCourierNameScene.action("changeName:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  return ctx.scene.leave();
});

changeCourierNameScene.action(/^changeName_(.+)$/, async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.answerCbQuery("Нет прав");
    return;
  }
  const targetId = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.changeTarget = targetId;
  ctx.session.awaitingNewName = true;
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  await ctx.reply(`Введите новое ФИО для курьера (ID: ${targetId}):`);
});

changeCourierNameScene.on("text", async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  ctx.session = ctx.session || {};
  if (!ctx.session.awaitingNewName || !ctx.session.changeTarget) {
    return ctx.reply("Пожалуйста, выберите курьера через кнопки.");
  }
  const newName = ctx.message.text.trim();
  if (!newName || newName.length < 3) {
    return ctx.reply("Введите корректное ФИО (минимум 3 символа)");
  }
  try {
    await updateUserName(ctx.session.changeTarget, newName);
    await ctx.reply("✅ ФИО обновлено.");
    try {
      await bot.telegram.sendMessage(String(ctx.session.changeTarget), `✏️ Администратор обновил ваше ФИО на: ${newName}`);
    } catch (e) {
      console.warn("Не удалось уведомить пользователя:", e.message);
    }
  } catch (e) {
    console.error("[changeCourierNameScene.on(text)]", e);
    await ctx.reply("Ошибка при обновлении ФИО: " + e.message);
  }
  return ctx.scene.leave();
});

deleteCourierScene.action(/^delete_(.+)$/, async (ctx) => {
  try {
    if (!isAdminId(ctx.from.id)) {
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
    await ctx.reply("Пожалуйста, используйте кнопки для выбора курьера.");
  } catch (err) {
    await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.");
  }
});

// ============ СЦЕНЫ ДЛЯ УПРАВЛЕНИЯ ССЫЛКАМИ ============
addLinkScene.enter(async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  ctx.session = ctx.session || {};
  ctx.session.linkTitle = null;
  ctx.session.linkUrl = null;
  ctx.session.awaitingLinkTitle = true;
  await ctx.reply("Введите название ссылки:", Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "addLink:cancel")]]));
});

addLinkScene.action("addLink:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  return ctx.scene.leave();
});

addLinkScene.on("text", async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    return ctx.reply("⛔ Недостаточно прав");
  }
  ctx.session = ctx.session || {};
  const text = ctx.message.text.trim();

  if (ctx.session.awaitingLinkTitle) {
    if (!text) return ctx.reply("Название не может быть пустым.");
    ctx.session.linkTitle = text;
    ctx.session.awaitingLinkTitle = false;
    ctx.session.awaitingLinkUrl = true;
    return ctx.reply("Теперь введите URL:", Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "addLink:cancel")]]));
  }

  if (ctx.session.awaitingLinkUrl) {
    if (!text || !text.startsWith("http")) {
      return ctx.reply("Введите корректный URL (должен начинаться с http:// или https://)");
    }
    try {
      await createLink(ctx.session.linkTitle, text);

      const adminInfo = {
        name:
          ctx.from.first_name && ctx.from.last_name
            ? `${ctx.from.first_name} ${ctx.from.last_name}`
            : ctx.from.first_name || ctx.from.username || "Неизвестно",
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };

      await logAction(bot, `Добавление ссылки: ${ctx.session.linkTitle}`, ctx.from.id.toString(), adminInfo, { url: text }, "Логи");

      await ctx.reply("✅ Ссылка добавлена!", adminMenu());

      // Отправка уведомлений пользователям
      const users = await listApprovedUsers();
      for (const u of users) {
        try {
          await bot.telegram.sendMessage(
            String(u.id),
            `🔗 Добавлена новая полезная ссылка: *${ctx.session.linkTitle}*\n\nПосмотрите в разделе "🔗 Полезные ссылки"`,
            { parse_mode: "Markdown" }
          );
        } catch (e) {
          console.warn(`Не удалось отправить уведомление пользователю ${u.id}:`, e.message);
        }
        await new Promise((r) => setTimeout(r, 35));
      }
    } catch (e) {
      await ctx.reply("❌ Ошибка при добавлении ссылки: " + e.message, adminMenu());
    }
    return ctx.scene.leave();
  }
});

deleteLinkScene.enter(async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  try {
    const links = await getAllLinks();
    if (links.length === 0) {
      await ctx.reply("Нет ссылок для удаления.", adminMenu());
      return ctx.scene.leave();
    }
    const keyboard = links.map((link) => [Markup.button.callback(`${link.title}`, `deleteLink_${link.id}`)]);
    keyboard.push([Markup.button.callback("❌ Отмена", "deleteLink:cancel")]);
    await ctx.reply("Выберите ссылку для удаления:", Markup.inlineKeyboard(keyboard));
  } catch (e) {
    await ctx.reply("❌ Ошибка: " + e.message, adminMenu());
    return ctx.scene.leave();
  }
});

deleteLinkScene.action("deleteLink:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  return ctx.scene.leave();
});

deleteLinkScene.action(/^deleteLink_(.+)$/, async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.answerCbQuery("Нет прав");
    return;
  }
  const linkId = ctx.match[1];
  try {
    const link = await getLinkById(linkId);
    await deleteLink(linkId);

    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    await logAction(bot, `Удаление ссылки: ${link?.title || "ID:" + linkId}`, ctx.from.id.toString(), adminInfo, { linkId }, "Логи");

    await ctx.answerCbQuery("Ссылка удалена");
    await ctx.editMessageText("✅ Ссылка удалена!");
  } catch (e) {
    await ctx.answerCbQuery("Ошибка");
    await ctx.reply("❌ Ошибка при удалении: " + e.message);
  }
  return ctx.scene.leave();
});

// ============ СЦЕНЫ ДЛЯ УПРАВЛЕНИЯ ОБУЧЕНИЕМ ============
addTrainingScene.enter(async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  ctx.session = ctx.session || {};
  ctx.session.trainingTitle = null;
  ctx.session.trainingContent = null;
  ctx.session.trainingMediaUrl = null;
  ctx.session.trainingMediaType = null;
  ctx.session.awaitingTrainingTitle = true;
  await ctx.reply("Введите название материала:", Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "addTraining:cancel")]]));
});

addTrainingScene.action("addTraining:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  return ctx.scene.leave();
});

addTrainingScene.action("addTraining:skip", async (ctx) => {
  await ctx.answerCbQuery("Пропущено");
  try {
    await createTrainingMaterial(ctx.session.trainingTitle, ctx.session.trainingContent, null, null);

    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    await logAction(
      bot,
      `Добавление материала обучения: ${ctx.session.trainingTitle} (текст)`,
      ctx.from.id.toString(),
      adminInfo,
      { mediaType: "text" },
      "Логи"
    );

    await ctx.reply("✅ Материал добавлен без медиа!", adminMenu());

    // Отправка уведомлений пользователям
    const users = await listApprovedUsers();
    for (const u of users) {
      try {
        await bot.telegram.sendMessage(
          String(u.id),
          `📚 Добавлен новый обучающий материал: *${ctx.session.trainingTitle}*\n\nПосмотрите в разделе "📚 Обучение"`,
          { parse_mode: "Markdown" }
        );
      } catch (e) {
        console.warn(`Не удалось отправить уведомление пользователю ${u.id}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 35));
    }
  } catch (e) {
    await ctx.reply("❌ Ошибка: " + e.message, adminMenu());
  }
  return ctx.scene.leave();
});

addTrainingScene.on("text", async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    return ctx.reply("⛔ Недостаточно прав");
  }
  ctx.session = ctx.session || {};
  const text = ctx.message.text.trim();

  if (ctx.session.awaitingTrainingTitle) {
    if (!text) return ctx.reply("Название не может быть пустым.");
    ctx.session.trainingTitle = text;
    ctx.session.awaitingTrainingTitle = false;
    ctx.session.awaitingTrainingContent = true;
    return ctx.reply("Теперь введите текст материала:", Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "addTraining:cancel")]]));
  }

  if (ctx.session.awaitingTrainingContent) {
    if (!text) return ctx.reply("Текст не может быть пустым.");
    ctx.session.trainingContent = text;
    ctx.session.awaitingTrainingContent = false;
    ctx.session.awaitingTrainingMedia = true;
    return ctx.reply(
      "Отправьте ссылку или фото (или нажмите Пропустить):",
      Markup.inlineKeyboard([
        [Markup.button.callback("⏭ Пропустить", "addTraining:skip")],
        [Markup.button.callback("❌ Отмена", "addTraining:cancel")],
      ])
    );
  }

  if (ctx.session.awaitingTrainingMedia) {
    if (text.startsWith("http")) {
      ctx.session.trainingMediaUrl = text;
      ctx.session.trainingMediaType = "link";
      try {
        await createTrainingMaterial(
          ctx.session.trainingTitle,
          ctx.session.trainingContent,
          ctx.session.trainingMediaUrl,
          ctx.session.trainingMediaType
        );

        const adminInfo = {
          name:
            ctx.from.first_name && ctx.from.last_name
              ? `${ctx.from.first_name} ${ctx.from.last_name}`
              : ctx.from.first_name || ctx.from.username || "Неизвестно",
          username: ctx.from.username,
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
        };

        await logAction(
          bot,
          `Добавление материала обучения: ${ctx.session.trainingTitle} (ссылка)`,
          ctx.from.id.toString(),
          adminInfo,
          { mediaType: "link", url: ctx.session.trainingMediaUrl },
          "Логи"
        );

        await ctx.reply("✅ Материал добавлен со ссылкой!", adminMenu());

        // Отправка уведомлений пользователям
        const users = await listApprovedUsers();
        for (const u of users) {
          try {
            await bot.telegram.sendMessage(
              String(u.id),
              `📚 Добавлен новый обучающий материал: *${ctx.session.trainingTitle}*\n\nПосмотрите в разделе "📚 Обучение"`,
              { parse_mode: "Markdown" }
            );
          } catch (e) {
            console.warn(`Не удалось отправить уведомление пользователю ${u.id}:`, e.message);
          }
          await new Promise((r) => setTimeout(r, 35));
        }
      } catch (e) {
        await ctx.reply("❌ Ошибка: " + e.message, adminMenu());
      }
      return ctx.scene.leave();
    } else {
      return ctx.reply("Введите корректный URL или отправьте фото.");
    }
  }
});

addTrainingScene.on("photo", async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    return ctx.reply("⛔ Недостаточно прав");
  }
  ctx.session = ctx.session || {};

  if (ctx.session.awaitingTrainingMedia) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    ctx.session.trainingMediaUrl = photo.file_id;
    ctx.session.trainingMediaType = "photo";
    try {
      await createTrainingMaterial(
        ctx.session.trainingTitle,
        ctx.session.trainingContent,
        ctx.session.trainingMediaUrl,
        ctx.session.trainingMediaType
      );

      const adminInfo = {
        name:
          ctx.from.first_name && ctx.from.last_name
            ? `${ctx.from.first_name} ${ctx.from.last_name}`
            : ctx.from.first_name || ctx.from.username || "Неизвестно",
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };

      await logAction(
        bot,
        `Добавление материала обучения: ${ctx.session.trainingTitle} (фото)`,
        ctx.from.id.toString(),
        adminInfo,
        { mediaType: "photo" },
        "Логи"
      );

      await ctx.reply("✅ Материал добавлен с фото!", adminMenu());

      // Отправка уведомлений пользователям
      const users = await listApprovedUsers();
      for (const u of users) {
        try {
          await bot.telegram.sendMessage(
            String(u.id),
            `📚 Добавлен новый обучающий материал: *${ctx.session.trainingTitle}*\n\nПосмотрите в разделе "📚 Обучение"`,
            { parse_mode: "Markdown" }
          );
        } catch (e) {
          console.warn(`Не удалось отправить уведомление пользователю ${u.id}:`, e.message);
        }
        await new Promise((r) => setTimeout(r, 35));
      }
    } catch (e) {
      await ctx.reply("❌ Ошибка: " + e.message, adminMenu());
    }
    return ctx.scene.leave();
  }
});

deleteTrainingScene.enter(async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.reply("⛔ Недостаточно прав");
    return ctx.scene.leave();
  }
  try {
    const materials = await getAllTrainingMaterials();
    if (materials.length === 0) {
      await ctx.reply("Нет материалов для удаления.", adminMenu());
      return ctx.scene.leave();
    }
    const keyboard = materials.map((mat) => [Markup.button.callback(`${mat.title}`, `deleteTraining_${mat.id}`)]);
    keyboard.push([Markup.button.callback("❌ Отмена", "deleteTraining:cancel")]);
    await ctx.reply("Выберите материал для удаления:", Markup.inlineKeyboard(keyboard));
  } catch (e) {
    await ctx.reply("❌ Ошибка: " + e.message, adminMenu());
    return ctx.scene.leave();
  }
});

deleteTrainingScene.action("deleteTraining:cancel", async (ctx) => {
  await ctx.answerCbQuery("Отменено");
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  return ctx.scene.leave();
});

deleteTrainingScene.action(/^deleteTraining_(.+)$/, async (ctx) => {
  if (!isAdminId(ctx.from.id)) {
    await ctx.answerCbQuery("Нет прав");
    return;
  }
  const matId = ctx.match[1];
  try {
    const material = await getTrainingMaterialById(matId);
    await deleteTrainingMaterial(matId);

    const adminInfo = {
      name:
        ctx.from.first_name && ctx.from.last_name
          ? `${ctx.from.first_name} ${ctx.from.last_name}`
          : ctx.from.first_name || ctx.from.username || "Неизвестно",
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    };

    await logAction(
      bot,
      `Удаление материала обучения: ${material?.title || "ID:" + matId}`,
      ctx.from.id.toString(),
      adminInfo,
      { materialId: matId },
      "Логи"
    );

    await ctx.answerCbQuery("Материал удален");
    await ctx.editMessageText("✅ Материал удален!");
  } catch (e) {
    await ctx.answerCbQuery("Ошибка");
    await ctx.reply("❌ Ошибка при удалении: " + e.message);
  }
  return ctx.scene.leave();
});

const stage = new Scenes.Stage([
  registrationScene,
  deleteCourierScene,
  broadcastScene,
  changeCourierNameScene,
  addLinkScene,
  deleteLinkScene,
  addTrainingScene,
  deleteTrainingScene,
]);
bot.use(session());
bot.use(stage.middleware());

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
    if (isAdminId(userId)) {
      await logBotStart(bot, userId, userInfo, true);
      return await ctx.reply("👋 Добро пожаловать, администратор!", adminMenu());
    }

    const user = await getUserById(userId);
    if (user?.status === "approved") {
      await logBotStart(bot, userId, { ...userInfo, name: user.name });
      return await ctx.reply(`${user.name}, Вы сейчас находитесь в главном меню бота. Выберите действие:`, getMainMenuInline());
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

  if (!isAdminId(userId)) {
    await logAction(bot, "попытка доступа к списку курьеров без прав", userId, adminInfo);
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }

  try {
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
  } catch (error) {
    await logError(bot, error, userId, adminInfo, "Получение списка курьеров");
    throw error;
  }
});

bot.hears("❌ Удалить курьера", async (ctx) => {
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

  if (!isAdminId(userId)) {
    await logAction(bot, "попытка удаления курьера без прав", userId, adminInfo);
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }
  await ctx.scene.enter("deleteCourier");
});

bot.hears("✏️ Изменить ФИО курьера", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdminId(userId)) {
    await logAction(bot, "попытка входа в изменение ФИО без прав", userId, { username: ctx.from.username });
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }
  return await ctx.scene.enter("changeCourierName");
});

bot.hears("📢 Рассылка", async (ctx) => {
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

  if (!isAdminId(userId)) {
    await logAction(bot, "попытка рассылки без прав", userId, adminInfo);
    return await ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }

  await ctx.scene.enter("broadcast");
});

bot.hears("🔗 Управление ссылками", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdminId(userId)) {
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
  if (links.length === 0) {
    return await ctx.reply("📋 Список ссылок пуст", Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить", "admin:addLink")]]));
  }

  const keyboard = createPaginatedKeyboard(links, 0, 6, "links", true);
  await ctx.reply("🔗 Полезные ссылки:", keyboard);
});

bot.hears("📚 Управление обучением", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdminId(userId)) {
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
  if (materials.length === 0) {
    return await ctx.reply("📋 Список материалов пуст", Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить", "admin:addTraining")]]));
  }

  const keyboard = createPaginatedKeyboard(materials, 0, 6, "training", true);
  await ctx.reply("📚 Обучение:", keyboard);
});
bot.hears(["📋 График: текущая неделя", "📋 График: следующая неделя"], async (ctx) => {
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

  if (!isAdminId(userId)) {
    await logAction(bot, "попытка просмотра графика без прав", userId, adminInfo);
    return ctx.reply("⛔ Недостаточно прав", getMainMenuInline());
  }

  const nextWeek = ctx.message.text.includes("следующая");

  try {
    const text = await getAdminScheduleText(SPREADSHEET_ID, nextWeek);
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch (e) {
    await logError(bot, e, userId, adminInfo, `Просмотр графика ${nextWeek ? "следующей" : "текущей"} недели`);
    await ctx.reply("❗ " + e.message, adminMenu());
  }
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id.toString();
  ctx.session = ctx.session || {};

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
        Markup.inlineKeyboard([[Markup.button.callback("✖️ Завершить диалог", "support:stop")], [Markup.button.callback("◀️ Назад", "menu:main")]])
      );
      return;
    }
    if (data === "support:stop") {
      ctx.session = ctx.session || {};
      ctx.session.supportChatActive = false;
      await ctx.answerCbQuery("Диалог завершён");
      try {
        await ctx.editMessageText("Диалог с администратором завершён.", getMainMenuInline());
      } catch (_) {}
      return;
    }
    if (data === "menu:main") {
      const userId = ctx.from.id.toString();
      const user = await getUserById(userId);
      await ctx.editMessageText(`${user?.name || ""}, Вы сейчас находитесь в главном меню бота.\n\nВыберите действие:`, getMainMenuInline());
      return;
    }
    if (data === "menu:report") {
      await ctx.editMessageText(`Отчет по вашей заработной плате.\n\nВыберите действие:`, getReportMenuInline());
      return;
    }
    if (data.startsWith("report:")) {
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
      await ctx.editMessageText(`Просмотр и отправка графика.\n\nВыберите действие:`, getScheduleMenuInline());
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
        const isAdmin = isAdminId(userId);

        const user = await getUserById(userId);
        const userInfo = {
          name: user?.name || "Неизвестно",
          username: user?.username,
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
        };

        await logAction(bot, `Просмотр ссылок (страница ${page + 1})`, userId, userInfo, { page, isAdmin }, "Логи");

        await ctx.editMessageText(
          "🔗 Здесь вы найдете полезные ссылки, которые могут Вам помочь.\n\nВыберите действие:",
          createPaginatedKeyboard(links, page, itemsPerPage, "links", isAdmin)
        );
      } catch (e) {
        await ctx.editMessageText("❌ Ошибка загрузки ссылок: " + e.message, getBackInlineMenu("menu:main"));
      }
      return;
    }
    if (data === "links:add") {
      if (!isAdminId(userId)) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("addLink");
    }
    if (data === "links:delete") {
      if (!isAdminId(userId)) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("deleteLink");
    }
    if (data === "links:noop") {
      await ctx.answerCbQuery();
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
        const itemsPerPage = 6;
        const isAdmin = isAdminId(userId);

        const user = await getUserById(userId);
        const userInfo = {
          name: user?.name || "Неизвестно",
          username: user?.username,
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
        };

        await logAction(bot, `Просмотр материалов обучения (страница ${page + 1})`, userId, userInfo, { page, isAdmin }, "Логи");

        await ctx.editMessageText(
          "📚 Здесь вы найдете обучающие материалы, которые будут Вам полезны для работы.\n\nВыберите действие:",
          createPaginatedKeyboard(materials, page, itemsPerPage, "training", isAdmin)
        );
      } catch (e) {
        await ctx.editMessageText("❌ Ошибка загрузки материалов: " + e.message, getBackInlineMenu("menu:main"));
      }
      return;
    }
    if (data === "training:add") {
      if (!isAdminId(userId)) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("addTraining");
    }
    if (data === "training:delete") {
      if (!isAdminId(userId)) {
        await ctx.answerCbQuery("⛔ Недостаточно прав");
        return;
      }
      await ctx.answerCbQuery();
      return ctx.scene.enter("deleteTraining");
    }
    if (data === "training:noop") {
      await ctx.answerCbQuery();
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

        const text = `📚 *${material.title}*\n\n${material.content}`;

        if (material.media_type === "photo" && material.media_url) {
          // Для фото: удаляем старое сообщение и отправляем новое
          try {
            await ctx.deleteMessage();
          } catch (err) {
            console.warn("Не удалось удалить сообщение:", err.message);
          }
          await ctx.replyWithPhoto(material.media_url, {
            caption: text,
            parse_mode: "Markdown",
          });
        } else if (material.media_type === "link" && material.media_url) {
          // Для ссылки: редактируем текстовое сообщение
          const keyboard = [[Markup.button.url("🔗 Открыть ссылку", material.media_url)], [Markup.button.callback("◀️ Назад", "menu:training")]];
          await ctx.editMessageText(text, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard(keyboard),
          });
        } else {
          // Для текста: редактируем текстовое сообщение
          await ctx.editMessageText(text, {
            parse_mode: "Markdown",
            ...getBackInlineMenu("menu:training"),
          });
        }
      } catch (e) {
        console.error("Ошибка при просмотре материала:", e);
        await ctx.answerCbQuery("Ошибка: " + e.message);
      }
      return;
    }
    if (data === "schedule:view:current" || data === "schedule:view:next") {
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
      await logScheduleAction(bot, userId, userInfo, "запрос на отправку графика", { period: `${from.format("DD.MM")}–${to.format("DD.MM")}` });
      const warn = `📅 Пришлите ваш график на период ${from.format("DD.MM")}–${to.format("DD.MM")} в формате:\n\nПн: 10-23\nВт: 10-23\n…`;
      await ctx.editMessageText(warn, getBackInlineMenu("menu:schedule"));
      ctx.session.awaitingSchedule = true;
      ctx.session.scheduleMode = "send";
      ctx.session.scheduleNextWeek = true;
      ctx.session.lastInlineMsgId = ctx.callbackQuery.message.message_id;
      return;
    }
  }
  if (!isAdminId(userId)) {
    return await ctx.answerCbQuery("⛔ Недостаточно прав");
  }

  // Обработчики для управления ссылками и обучением (админ)
  if (data === "admin:addLink") {
    await ctx.answerCbQuery();
    return ctx.scene.enter("addLink");
  }
  if (data === "admin:deleteLink") {
    await ctx.answerCbQuery();
    return ctx.scene.enter("deleteLink");
  }
  if (data === "admin:addTraining") {
    await ctx.answerCbQuery();
    return ctx.scene.enter("addTraining");
  }
  if (data === "admin:deleteTraining") {
    await ctx.answerCbQuery();
    return ctx.scene.enter("deleteTraining");
  }

  if (data.startsWith("support_reply:")) {
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
            getMainMenuInline()
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
    } catch (err) {
      await logError(bot, err, userId, adminInfo, "Обработка подтверждения/отклонения пользователя");
      await ctx.answerCbQuery("⚠️ Произошла ошибка");
      console.error("Ошибка при обработке подтверждения/отклонения:", err.message);
    }

    return;
  }
  await ctx.answerCbQuery("Неизвестная команда");
});

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
        await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, { parse_mode: "HTML", ...getBackInlineMenu("menu:report") });
      } else {
        await ctx.reply(text, { parse_mode: "HTML", ...getReportMenuInline() });
      }
    } catch (e) {
      await logError(bot, e, userId, userInfo, `Запрос кастомного табеля за период: ${input}`);
      const msgId = ctx.session.lastReportMsgId;
      if (msgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, "❗ " + e.message, getBackInlineMenu("menu:report"));
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
      return ctx.reply("Пустое сообщение. Отмена.", getMainMenuInline());
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
            `📥 Новое обращение от курьера:\n` + `👤 ${user ? user.name : userId} (ID: ${userId})\n\n` + `${text}`,
            Markup.inlineKeyboard([[Markup.button.callback(`✍️ Ответить ${user ? user.name : userId}`, `support_reply:${userId}`)]])
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
        scheduleText: ctx.message.text.trim().substring(0, 100) + (ctx.message.text.trim().length > 100 ? "..." : ""),
      });

      ctx.session.currentSheet = await ensureWeekSheetAndAsk(SPREADSHEET_ID, ctx.chat.id, ctx.telegram, false, !!ctx.session.scheduleNextWeek);
      await parseAndAppend(SPREADSHEET_ID, ctx.session.currentSheet, ctx.message.text.trim(), userId);
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, "✅ График сохранён!", getScheduleMenuInline());
    } catch (e) {
      await logError(bot, e, userId, userInfo, "Сохранение графика");
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, "❗ " + e.message, getScheduleMenuInline());
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
        scheduleText: ctx.message.text.trim().substring(0, 100) + (ctx.message.text.trim().length > 100 ? "..." : ""),
      });

      ctx.session.currentSheet = await ensureWeekSheetAndAsk(SPREADSHEET_ID, ctx.chat.id, ctx.telegram, false, !!ctx.session.scheduleNextWeek);
      await upsertSchedule(SPREADSHEET_ID, ctx.session.currentSheet, ctx.message.text.trim(), userId, ctx.telegram);
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, "✅ График обновлён!", getScheduleMenuInline());
    } catch (e) {
      await logError(bot, e, userId, userInfo, "Обновление графика");
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastInlineMsgId, null, "❗ " + e.message, getScheduleMenuInline());
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

  const sheetNames = ["Сургут 1 (30 лет победы)", "Сургут 2 (Усольцева)", "Сургут 3 (Магистральная)"];

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
      return `Нет данных за прошлую неделю ` + `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
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
      return `Нет данных за текущую неделю ` + `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
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
      return `Нет данных за период ` + `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
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
      return `Нет данных за период ` + `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})`;
    }
    let totalHours = 0,
      totalKm = 0,
      totalOrders = 0,
      totalSalary = 0,
      totalZaezdy = 0;
    let lastTime = "",
      lastRating = "";
    let message = `📅 Табель за период ` + `(${fromDate.toLocaleDateString("ru-RU")} - ${toDate.toLocaleDateString("ru-RU")})\n` + `👤 ${user.name}`;
    for (const r of filtered) {
      const [, date, , , , , , hours, km, orders, , , , time, nps, , , , , , , zaezd1, zaezd2, salary] = r;
      const zaezdy = parseFloat(zaezd1 || 0) + parseFloat(zaezd2 || 0);
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

bot.catch(async (err, ctx) => {
  const userId = ctx.from?.id || "unknown";
  const userInfo = {
    name:
      ctx.from?.first_name && ctx.from?.last_name
        ? `${ctx.from.first_name} ${ctx.from.last_name}`
        : ctx.from?.first_name || ctx.from?.username || "Неизвестно",
    username: ctx.from?.username,
    first_name: ctx.from?.first_name,
    last_name: ctx.from?.last_name,
  };

  await logError(bot, err, userId, userInfo, "Глобальная ошибка бота");
  await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.", getMainMenuInline());
});

initSchema()
  .then(() => bot.launch())
  .catch((err) => {
    process.exit(1);
  });

process.once("SIGINT", () => {
  bot.stop("SIGINT");
  process.exit();
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  process.exit();
});
