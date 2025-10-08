const { Telegraf } = require("telegraf");
const { applyScenes } = require("./scenes");
const { registerMiddlewares } = require("./middlewares");
const { registerCommandHandlers } = require("./handlers/commands");
const { registerCallbackHandlers } = require("./handlers/callbacks");
const { registerTextHandlers } = require("./handlers/text");
const { logError } = require("../services/logger");
const { getMainMenuInline } = require("./menus");

function createBot(token) {
  const bot = new Telegraf(token);

  applyScenes(bot);
  registerMiddlewares(bot);
  registerCommandHandlers(bot);
  registerCallbackHandlers(bot);
  registerTextHandlers(bot);

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

    try {
      await ctx.reply("⚠️ Произошла ошибка. Попробуйте позже.", getMainMenuInline(ctx.state?.currentUser));
    } catch (_) {}
  });

  return bot;
}

module.exports = { createBot };
