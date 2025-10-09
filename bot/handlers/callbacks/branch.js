const { BRANCHES } = require("../../../config");
const {
  getMainMenuInline,
} = require("../../menus");
const {
  computeAdminFlag,
  hasManagerRights,
  hasBranchManagerRights,
} = require("../../context");
const { getUserById, updateUserBranch } = require("../../../services/users");
const { logAction } = require("../../../services/logger");

async function handleBranchSelection({ ctx, data, userId, bot }) {
  if (!data.startsWith("branch:select_")) {
    return false;
  }

  const match = data.match(/^branch:select_(.+)$/);
  const branchId = match ? match[1] : null;
  const branch = BRANCHES.find((b) => b.id === branchId);
  if (!branch) {
    await ctx.answerCbQuery("Неизвестный филиал, попробуйте снова");
    return true;
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
  return true;
}

module.exports = {
  handleBranchSelection,
};
