const { ROLES } = require("../../../config");
const { listUsersByRoleAndBranch, listUsersByRole } = require("../../../services/users");

function displayUsername(raw) {
  if (!raw) return "username не указан";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function dedupeUsers(users = []) {
  const map = new Map();
  for (const user of users) {
    if (!user || !user.id) continue;
    const idStr = String(user.id);
    if (!map.has(idStr)) {
      map.set(idStr, user);
    }
  }
  return Array.from(map.values());
}

async function getManagersByBranch(branchId) {
  if (branchId) {
    const senior = await listUsersByRoleAndBranch(ROLES.SENIOR, branchId);
    const logist = await listUsersByRoleAndBranch(ROLES.LOGIST, branchId);
    return dedupeUsers([...senior, ...logist]);
  }
  const seniorAll = await listUsersByRole(ROLES.SENIOR);
  const logistAll = await listUsersByRole(ROLES.LOGIST);
  return dedupeUsers([...seniorAll, ...logistAll]);
}

module.exports = {
  displayUsername,
  dedupeUsers,
  getManagersByBranch,
};
