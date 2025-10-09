async function handleAdminActions({ ctx, data }) {
  const isAdminCtx = ctx.state?.isAdmin ?? false;

  if (data === "admin:addLink" || data === "links:add") {
    if (!isAdminCtx) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    await ctx.answerCbQuery();
    await ctx.scene.enter("addLink");
    return true;
  }

  if (data === "admin:deleteLink" || data === "links:delete") {
    if (!isAdminCtx) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    await ctx.answerCbQuery();
    await ctx.scene.enter("deleteLink");
    return true;
  }

  if (data === "admin:addTraining" || data === "training:add") {
    if (!isAdminCtx) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    await ctx.answerCbQuery();
    await ctx.scene.enter("addTraining");
    return true;
  }

  if (data === "admin:deleteTraining" || data === "training:delete") {
    if (!isAdminCtx) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
    }
    await ctx.answerCbQuery();
    await ctx.scene.enter("deleteTraining");
    return true;
  }

  if (data.startsWith("support_reply:")) {
    if (!isAdminCtx) {
      await ctx.answerCbQuery("⛔ Недостаточно прав");
      return true;
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
    return true;
  }

  return false;
}

module.exports = {
  handleAdminActions,
};
