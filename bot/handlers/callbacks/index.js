const { ensureRoleState } = require("../../context");
const { handleSettingsCallbacks } = require("./settings");
const { handleBranchSelection } = require("./branch");
const { handleMenuCallbacks } = require("./menu");
const { handleContentCallbacks } = require("./content");
const { handleAdminActions } = require("./adminActions");
const { handleApprovalCallbacks } = require("./approvals");

const handlers = [
  handleSettingsCallbacks,
  handleBranchSelection,
  handleMenuCallbacks,
  handleContentCallbacks,
  handleAdminActions,
  handleApprovalCallbacks,
];

function registerCallbackHandlers(bot) {
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    const userId = ctx.from.id.toString();
    ctx.session = ctx.session || {};

    await ensureRoleState(ctx);

    for (const handler of handlers) {
      // eslint-disable-next-line no-await-in-loop
      const handled = await handler({ bot, ctx, data, userId });
      if (handled) return;
    }

    await ctx.answerCbQuery("Неизвестная команда");
  });
}

module.exports = {
  registerCallbackHandlers,
};
