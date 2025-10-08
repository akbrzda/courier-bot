const { Markup } = require("telegraf");
const { BRANCHES, ROLES } = require("../config");
const { canAccessReports, hasBranchManagerRights, getUserRole } = require("./context");

function buildBranchKeyboard(prefix) {
  return Markup.inlineKeyboard(BRANCHES.map((branch) => [Markup.button.callback(branch.label, `${prefix}_${branch.id}`)]));
}

function getMainMenuInline(user = null) {
  const buttons = [];
  if (canAccessReports(user)) {
    buttons.push([Markup.button.callback("📅 Табель", "menu:report")]);
  }
  buttons.push([Markup.button.callback("📊 График", "menu:schedule")]);
  buttons.push([Markup.button.callback("🔗 Полезные ссылки", "menu:links")]);
  buttons.push([Markup.button.callback("📚 Обучение", "menu:training")]);
  buttons.push([Markup.button.callback("✉️ Написать администратору", "support:start")]);
  return Markup.inlineKeyboard(buttons);
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

function getScheduleMenuInline(user = null) {
  const role = getUserRole(user);
  const buttons = [];

  if (role !== ROLES.LOGIST) {
    buttons.push([Markup.button.callback("👁 Посмотреть график", "schedule:view")]);
    buttons.push([Markup.button.callback("➕ Отправить график", "schedule:send")]);
  }
  if (hasBranchManagerRights(user) && (getUserRole(user) !== ROLES.ADMIN || user?.branch)) {
    buttons.push([Markup.button.callback("📊 График филиала", "schedule:branch")]);
  }
  if (!buttons.length) {
    buttons.push([Markup.button.callback("📊 График", "schedule:view")]);
  }
  buttons.push([Markup.button.callback("◀️ Назад", "menu:main")]);
  return Markup.inlineKeyboard(buttons);
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
    ["🎯 Назначить роль"],
  ]).resize();
}

function createPaginatedKeyboard(items, page, itemsPerPage, callbackPrefix, isAdmin = false) {
  const start = page * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = items.slice(start, end);
  const totalPages = Math.ceil(items.length / itemsPerPage);

  const keyboard = [];

  if (isAdmin) {
    keyboard.push([Markup.button.callback("➕ Добавить", `${callbackPrefix}:add`), Markup.button.callback("❌ Удалить", `${callbackPrefix}:delete`)]);
  }

  pageItems.forEach((item) => {
    if (callbackPrefix === "links") {
      keyboard.push([Markup.button.callback(item.title, `links:view_${item.id}`)]);
    } else {
      keyboard.push([Markup.button.callback(item.title, `training:view_${item.id}`)]);
    }
  });

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

  if (!isAdmin) {
    keyboard.push([Markup.button.callback("◀️ Назад", "menu:main")]);
  }

  return Markup.inlineKeyboard(keyboard);
}

module.exports = {
  buildBranchKeyboard,
  getMainMenuInline,
  getReportMenuInline,
  getScheduleMenuInline,
  getBackInlineMenu,
  adminMenu,
  createPaginatedKeyboard,
};
