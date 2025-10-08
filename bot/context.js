const { BRANCHES, ROLES, MANAGER_ROLES, BRANCH_MANAGER_ROLES, ADMIN_IDS } = require("../config");
const { getUserById } = require("../services/users");

function getUserRole(user) {
  return user?.role || ROLES.COURIER;
}

function computeAdminFlag(userId, user) {
  if (!userId) return false;
  if (ADMIN_IDS.includes(String(userId))) return true;
  return getUserRole(user) === ROLES.ADMIN;
}

function hasManagerRights(user) {
  return MANAGER_ROLES.has(getUserRole(user));
}

function hasBranchManagerRights(user) {
  return BRANCH_MANAGER_ROLES.has(getUserRole(user));
}

function canAccessReports(user) {
  const role = getUserRole(user);
  return role === ROLES.COURIER || role === ROLES.ADMIN || role === ROLES.SENIOR;
}

function getRoleLabel(role) {
  switch (role) {
    case ROLES.SENIOR:
      return "Старший курьер";
    case ROLES.LOGIST:
      return "Логист";
    case ROLES.ADMIN:
      return "Админ";
    default:
      return "Курьер";
  }
}

function getBranchLabel(branchId) {
  const branch = BRANCHES.find((b) => b.id === branchId);
  return branch ? branch.label : "Филиал не выбран";
}

async function ensureRoleState(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  ctx.state = ctx.state || {};
  if (!ctx.state.currentUser) {
    ctx.state.currentUser = await getUserById(String(userId));
  }
  let user = ctx.state.currentUser;
  ctx.state.isAdmin = computeAdminFlag(userId, user);
  if (ctx.state.isAdmin && getUserRole(user) !== ROLES.ADMIN) {
    user = { ...(user || {}), role: ROLES.ADMIN };
    ctx.state.currentUser = user;
  }
  ctx.state.isManager = ctx.state.isAdmin || hasManagerRights(user);
  ctx.state.isBranchManager = ctx.state.isAdmin || hasBranchManagerRights(user);
}

function isAdminId(id, user = null) {
  if (!id) return false;
  if (ADMIN_IDS.includes(String(id))) return true;
  return getUserRole(user) === ROLES.ADMIN;
}

module.exports = {
  getUserRole,
  computeAdminFlag,
  hasManagerRights,
  hasBranchManagerRights,
  canAccessReports,
  getRoleLabel,
  getBranchLabel,
  ensureRoleState,
  isAdminId,
};
