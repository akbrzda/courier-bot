const { Scenes, Markup } = require("telegraf");
const { ROLE_OPTIONS, ROLES } = require("../../config");
const {
  ensureRoleState,
  getRoleLabel,
  getBranchLabel,
  computeAdminFlag,
  isAdminId,
} = require("../context");
const {
  adminMenu,
  createPaginatedKeyboard,
} = require("../menus");
const {
  getUserById,
  deleteUser,
  listApprovedUsers,
  updateUserName,
  updateUserRole,
} = require("../../services/users");
const {
  getAllLinks,
  getLinkById,
  createLink,
  deleteLink,
  getAllTrainingMaterials,
  getTrainingMaterialById,
  createTrainingMaterial,
  deleteTrainingMaterial,
} = require("../../services/content");
const { logAction, logError } = require("../../services/logger");

function createAdminScenes(bot) {
  const assignRoleScene = new Scenes.BaseScene("assignRole");
  const changeCourierNameScene = new Scenes.BaseScene("changeCourierName");
  const deleteCourierScene = new Scenes.BaseScene("deleteCourier");
  const broadcastScene = new Scenes.BaseScene("broadcast");
  const addLinkScene = new Scenes.BaseScene("addLink");
  const deleteLinkScene = new Scenes.BaseScene("deleteLink");
  const addTrainingScene = new Scenes.BaseScene("addTraining");
  const deleteTrainingScene = new Scenes.BaseScene("deleteTraining");

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
      previewText + "\n✅ Подтвердите отправку рассылки всем зарегистрированным пользователям?",
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Отправить", "broadcast:send")],
        [Markup.button.callback("❌ Отмена", "broadcast:cancel")],
      ])
    );
  }

  broadcastScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
      await ctx.reply("⛔ Недостаточно прав");
      return ctx.scene.leave();
    }
    ctx.session = ctx.session || {};
    ctx.session.broadcastText = null;
    ctx.session.broadcastPhoto = null;
    ctx.session.broadcastLinkUrl = null;
    ctx.session.broadcastLinkTitle = null;
    ctx.session.broadcastStep = "text";

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
    await ensureRoleState(ctx);
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
    await ensureRoleState(ctx);
    await ctx.answerCbQuery();
    ctx.session.broadcastLinkUrl = null;
    ctx.session.broadcastLinkTitle = null;
    ctx.session.broadcastStep = "confirm";

    await showBroadcastPreview(ctx);
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

            if (linkUrl && linkTitle) {
              messageOptions.reply_markup = {
                inline_keyboard: [[{ text: linkTitle, url: linkUrl }]],
              };
            }

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

  broadcastScene.on("text", async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
      await ctx.reply("⛔ Недостаточно прав");
      return ctx.scene.leave();
    }

    ctx.session = ctx.session || {};
    const text = ctx.message.text.trim();

    if (ctx.session.broadcastStep === "text") {
      if (!text) {
        return ctx.reply("Введите текст рассылки.");
      }
      ctx.session.broadcastText = text;
      ctx.session.broadcastStep = "photo";
      return ctx.reply(
        "📷 Шаг 2/4: Отправьте фото для рассылки или нажмите 'Пропустить':",
        Markup.inlineKeyboard([
          [Markup.button.callback("⏭ Пропустить", "broadcast:skip_photo")],
          [Markup.button.callback("❌ Отмена", "broadcast:cancel")],
        ])
      );
    }

    if (ctx.session.broadcastStep === "link_url") {
      if (!text.startsWith("http")) {
        return ctx.reply("Введите корректный URL или нажмите 'Пропустить'.");
      }
      ctx.session.broadcastLinkUrl = text;
      ctx.session.broadcastStep = "link_title";
      return ctx.reply(
        "🔗 Шаг 4/4: Введите текст кнопки для ссылки:",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "broadcast:cancel")]])
      );
    }

    if (ctx.session.broadcastStep === "link_title") {
      if (!text) {
        return ctx.reply("Введите корректный текст кнопки.");
      }
      ctx.session.broadcastLinkTitle = text;
      ctx.session.broadcastStep = "confirm";
      return showBroadcastPreview(ctx);
    }

    await ctx.reply("Сейчас ожидается другой тип данных. Используйте кнопки для навигации.");
  });

  broadcastScene.on("photo", async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
      await ctx.reply("⛔ Недостаточно прав");
      return ctx.scene.leave();
    }

    ctx.session = ctx.session || {};
    if (ctx.session.broadcastStep === "photo") {
      const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
      if (!photo) {
        return ctx.reply("Не удалось получить фото. Попробуйте ещё раз.");
      }
      const fileId = photo.file_id;

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

  addLinkScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
      await ctx.reply("⛔ Недостаточно прав");
      return ctx.scene.leave();
    }
    ctx.session = ctx.session || {};
    const text = ctx.message.text.trim();

    if (ctx.session.awaitingLinkTitle) {
      if (!text) return ctx.reply("Название не может быть пустым.");
      ctx.session.linkTitle = text;
      ctx.session.awaitingLinkTitle = false;
      ctx.session.awaitingLinkUrl = true;
      return ctx.reply("Теперь отправьте URL ссылки:", Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "addLink:cancel")]]));
    }

    if (ctx.session.awaitingLinkUrl) {
      if (!text.startsWith("http")) {
        return ctx.reply("Введите корректный URL");
      }
      ctx.session.linkUrl = text;
      try {
        const newId = await createLink(ctx.session.linkTitle, ctx.session.linkUrl);
        const adminInfo = {
          name:
            ctx.from.first_name && ctx.from.last_name
              ? `${ctx.from.first_name} ${ctx.from.last_name}`
              : ctx.from.first_name || ctx.from.username || "Неизвестно",
          username: ctx.from.username,
        };
        await logAction(
          bot,
          `Добавление ссылки: ${ctx.session.linkTitle}`,
          ctx.from.id.toString(),
          adminInfo,
          { linkId: newId },
          "Логи"
        );

        await ctx.reply("✅ Ссылка добавлена!", adminMenu());

        const approvedUsers = await listApprovedUsers();
        for (const u of approvedUsers) {
          try {
            await bot.telegram.sendMessage(
              String(u.id),
              `🔗 Добавлена новая ссылка: ${ctx.session.linkTitle}\n\nОткройте раздел "🔗 Полезные ссылки"`,
              {
                reply_markup: {
                  inline_keyboard: [[{ text: ctx.session.linkTitle, url: ctx.session.linkUrl }]],
                },
              }
            );
          } catch (err) {
            console.warn(`Не удалось отправить ссылку пользователю ${u.id}:`, err.message);
          }
          await new Promise((r) => setTimeout(r, 35));
        }
      } catch (e) {
        await ctx.reply("❌ Ошибка при добавлении ссылки: " + e.message, adminMenu());
      }
      return ctx.scene.leave();
    }
  });

  addLinkScene.on("message", async (ctx) => {
    await ctx.reply("Пожалуйста, введите текст.");
  });

  deleteLinkScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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

  addTrainingScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
      await ctx.reply("Сейчас ожидается текстовое сообщение или ссылка. Используйте кнопки для навигации.");
    }
  });

  addTrainingScene.on("message", async (ctx) => {
    await ctx.reply("Пожалуйста, отправьте текст или фото в соответствии с текущим шагом.");
  });

  deleteTrainingScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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

  changeCourierNameScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
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

  changeCourierNameScene.on("message", async (ctx) => {
    await ctx.reply("Пожалуйста, введите только текст");
  });

  deleteCourierScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
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
      await ensureRoleState(ctx);
      if (!ctx.state?.isAdmin) {
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
      await ensureRoleState(ctx);
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
  assignRoleScene.enter(async (ctx) => {
    await ensureRoleState(ctx);
    const userId = ctx.from.id.toString();
    const actingUser = ctx.state?.currentUser || (await getUserById(userId));
    if (!isAdminId(userId, actingUser)) {
      await ctx.reply("⛔ Недостаточно прав");
      return ctx.scene.leave();
    }

    try {
      const approvedUsers = await listApprovedUsers();
      if (approvedUsers.length === 0) {
        await ctx.reply("Нет пользователей для назначения ролей.", adminMenu());
        return ctx.scene.leave();
      }
      ctx.session = ctx.session || {};
      ctx.session.assignRoleTarget = null;

      const keyboard = approvedUsers.map((u) => {
        const roleLabel = getRoleLabel(u.role);
        const branchLabel = getBranchLabel(u.branch);
        return [Markup.button.callback(`${u.name} • ${roleLabel}`, `assignRole_select_${u.id}`)];
      });
      keyboard.push([Markup.button.callback("❌ Отмена", "assignRole:cancel")]);
      await ctx.reply("Выберите пользователя для изменения роли:", Markup.inlineKeyboard(keyboard));
    } catch (error) {
      await ctx.reply("❗ Ошибка при загрузке пользователей: " + error.message, adminMenu());
      return ctx.scene.leave();
    }
  });

  assignRoleScene.action("assignRole:cancel", async (ctx) => {
    await ctx.answerCbQuery("Отменено");
    try {
      await ctx.deleteMessage();
    } catch (_) {}
    return ctx.scene.leave();
  });

  assignRoleScene.action(/^assignRole_select_(.+)$/, async (ctx) => {
    await ensureRoleState(ctx);
    const targetId = ctx.match[1];
    const targetUser = await getUserById(targetId);
    if (!targetUser) {
      await ctx.answerCbQuery("Пользователь не найден");
      return;
    }
    ctx.session = ctx.session || {};
    ctx.session.assignRoleTarget = targetId;

    const buttons = ROLE_OPTIONS.map((opt) => {
      const isCurrent = opt.id === (targetUser.role || ROLES.COURIER);
      return [Markup.button.callback(`${opt.label}${isCurrent ? " ✅" : ""}`, `assignRole_set_${opt.id}`)];
    });
    buttons.push([Markup.button.callback("◀️ Назад", "assignRole:back")]);

    await ctx.answerCbQuery();
    try {
      await ctx.editMessageText(
        `Выбран: ${targetUser.name}\nТекущая роль: ${getRoleLabel(targetUser.role)}\nФилиал: ${getBranchLabel(targetUser.branch)}`,
        Markup.inlineKeyboard(buttons)
      );
    } catch (err) {
      await ctx.reply(
        `Выбран: ${targetUser.name}\nТекущая роль: ${getRoleLabel(targetUser.role)}\nФилиал: ${getBranchLabel(targetUser.branch)}`,
        Markup.inlineKeyboard(buttons)
      );
    }
  });

  assignRoleScene.action("assignRole:back", async (ctx) => {
    await ctx.answerCbQuery();
    const approvedUsers = await listApprovedUsers();
    if (!approvedUsers.length) {
      await ctx.editMessageText("Нет пользователей для изменения роли.");
      return ctx.scene.leave();
    }
    const keyboard = approvedUsers.map((u) => {
      const roleLabel = getRoleLabel(u.role);
      return [Markup.button.callback(`${u.name} • ${roleLabel}`, `assignRole_select_${u.id}`)];
    });
    keyboard.push([Markup.button.callback("❌ Отмена", "assignRole:cancel")]);
    try {
      await ctx.editMessageText("Выберите пользователя для изменения роли:", Markup.inlineKeyboard(keyboard));
    } catch (err) {
      await ctx.reply("Выберите пользователя для изменения роли:", Markup.inlineKeyboard(keyboard));
    }
  });

  assignRoleScene.action(/^assignRole_set_(.+)$/, async (ctx) => {
    await ensureRoleState(ctx);
    const newRole = ctx.match[1];
    const userId = ctx.from.id.toString();
    const actingUser = ctx.state?.currentUser || (await getUserById(userId));
    if (!isAdminId(userId, actingUser)) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return;
    }

    ctx.session = ctx.session || {};
    const targetId = ctx.session.assignRoleTarget;
    if (!targetId) {
      await ctx.answerCbQuery("Сначала выберите пользователя");
      return;
    }

    try {
      const normalizedRole = Object.values(ROLES).includes(newRole) ? newRole : ROLES.COURIER;
      await updateUserRole(targetId, normalizedRole);
      await ctx.answerCbQuery("Роль обновлена");
      try {
        await ctx.editMessageText("✅ Роль обновлена.", adminMenu());
      } catch (_) {
        await ctx.reply("✅ Роль обновлена.", adminMenu());
      }

      try {
        const targetUser = await getUserById(targetId);
        await logAction(
          bot,
          `Назначение роли: ${getRoleLabel(normalizedRole)}`,
          userId,
          {
            name:
              actingUser?.name ||
              (ctx.from.first_name && ctx.from.last_name
                ? `${ctx.from.first_name} ${ctx.from.last_name}`
                : ctx.from.first_name || ctx.from.username || "Неизвестно"),
            username: ctx.from.username,
          },
          { targetId, role: normalizedRole },
          "Логи"
        );

        await bot.telegram.sendMessage(String(targetId), `Ваша роль обновлена: ${getRoleLabel(normalizedRole)}.`);
      } catch (notifyErr) {
        console.warn("Не удалось уведомить пользователя о смене роли:", notifyErr.message);
      }
    } catch (error) {
      const safeMessage = error?.message || "Неизвестная ошибка";
      try {
        await ctx.editMessageText("⚠️ Не удалось обновить роль. Попробуйте снова.", adminMenu());
      } catch (_) {
        await ctx.reply("⚠️ Не удалось обновить роль. Попробуйте снова.", adminMenu());
      }
      await ctx.answerCbQuery("Ошибка");
      await logError(
        bot,
        error,
        userId,
        {
          name:
            actingUser?.name ||
            (ctx.from.first_name && ctx.from.last_name
              ? `${ctx.from.first_name} ${ctx.from.last_name}`
              : ctx.from.first_name || ctx.from.username || "Неизвестно"),
          username: ctx.from.username,
        },
        "Назначение роли"
      );
    }

    return ctx.scene.leave();
  });

  return {
    assignRoleScene,
    changeCourierNameScene,
    deleteCourierScene,
    broadcastScene,
    addLinkScene,
    deleteLinkScene,
    addTrainingScene,
    deleteTrainingScene,
  };
}

module.exports = { createAdminScenes };
