const { Markup } = require("telegraf");
const {
  getAllLinks,
  getLinkById,
  getAllTrainingMaterials,
  getTrainingMaterialById,
} = require("../../../services/content");
const { logAction, logError } = require("../../../services/logger");
const { getUserById } = require("../../../services/users");
const { adminMenu, createPaginatedKeyboard, getBackInlineMenu } = require("../../menus");
const { ensureRoleState, isAdminId } = require("../../context");

async function handleContentCallbacks({ bot, ctx, data, userId }) {
  if (data === "menu:links") {
    try {
      const links = await getAllLinks();
      if (links.length === 0) {
        await ctx.editMessageText("Пока нет доступных ссылок.", getBackInlineMenu("menu:main"));
        return true;
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
    return true;
  }

  if (data.startsWith("links:page_")) {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    const rawPage = data.split("_")[1];
    const page = Number.parseInt(rawPage, 10);
    if (Number.isNaN(page) || page < 0) {
      await ctx.answerCbQuery("Некорректная страница");
      return true;
    }
    try {
      const links = await getAllLinks();
      if (!links.length) {
        await ctx.editMessageText("📋 Список ссылок пуст", Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить", "links:add")]]));
        return true;
      }
      ctx.session = ctx.session || {};
      ctx.session.linksAdminPage = page;
      await ctx.editMessageText("🔗 Полезные ссылки:", createPaginatedKeyboard(links, page, 6, "links", true));
      await ctx.answerCbQuery();
    } catch (err) {
      await ctx.answerCbQuery("Ошибка загрузки");
    }
    return true;
  }

  if (data === "links:noop") {
    await ctx.answerCbQuery();
    return true;
  }

  if (data.startsWith("links:view_")) {
    await ensureRoleState(ctx);
    if (!ctx.state?.isAdmin) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    const linkId = data.split("_")[1];
    try {
      const link = await getLinkById(linkId);
      if (!link) {
        await ctx.answerCbQuery("Ссылка не найдена");
        return true;
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
    return true;
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
        return true;
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
    return true;
  }

  if (data === "training:noop") {
    await ctx.answerCbQuery();
    return true;
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
        return true;
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
    return true;
  }

  if (data.startsWith("training:view_")) {
    const matId = data.split("_")[1];
    try {
      const material = await getTrainingMaterialById(matId);
      if (!material) {
        await ctx.answerCbQuery("Материал не найден");
        return true;
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
    return true;
  }

  return false;
}

module.exports = {
  handleContentCallbacks,
};
