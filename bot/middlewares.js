const { ensureRoleState } = require("./context");
const { buildBranchKeyboard } = require("./menus");

function registerMiddlewares(bot) {
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId) {
      return next();
    }

    const userId = String(fromId);
    const callbackData = ctx.callbackQuery?.data || "";
    if (callbackData.startsWith("branch:select_") || callbackData.startsWith("reg:branch_")) {
      return next();
    }

    if (ctx.scene && ctx.scene.current && ctx.scene.current.id === "registration") {
      return next();
    }

    await ensureRoleState(ctx);
    const user = ctx.state.currentUser;

    if (user && user.status === "approved" && !user.branch) {
      const isStartCommand = ctx.updateType === "message" && ctx.message?.text?.startsWith("/start");
      ctx.session = ctx.session || {};

      if (ctx.updateType === "callback_query") {
        await ctx.answerCbQuery("Выберите филиал, чтобы продолжить");
      }

      if (!ctx.session.branchPromptShown && !isStartCommand) {
        ctx.session.branchPromptShown = true;
        await ctx.reply("Чтобы продолжить работу, выберите филиал:", buildBranchKeyboard("branch:select"));
      }

      if (isStartCommand) {
        return next();
      }
      return;
    }

    return next();
  });
}

module.exports = { registerMiddlewares };
