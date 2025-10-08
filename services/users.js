const { pool } = require("./db");

async function getUserById(userId) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id=? LIMIT 1", [userId]);
  return rows[0] || null;
}

async function upsertUserBasic(userId, payload) {
  const {
    name,
    status = "pending",
    username = null,
    first_name = null,
    last_name = null,
    branch = null,
    role = "courier",
  } = payload;
  await pool.query(
    `INSERT INTO users (id, name, status, username, first_name, last_name, branch, role)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status), username=VALUES(username), first_name=VALUES(first_name), last_name=VALUES(last_name), branch=VALUES(branch), role=VALUES(role)`,
    [userId, name, status, username, first_name, last_name, branch, role]
  );
}

async function setUserStatus(userId, status) {
  await pool.query("UPDATE users SET status=? WHERE id=?", [status, userId]);
}

async function deleteUser(userId) {
  await pool.query("DELETE FROM users WHERE id=?", [userId]);
}

async function listApprovedUsers() {
  const [rows] = await pool.query(
    "SELECT id, name, username, branch, role FROM users WHERE status='approved' ORDER BY name"
  );
  return rows;
}

async function listAllUsers() {
  const [rows] = await pool.query("SELECT id, name, username, status, branch, role FROM users ORDER BY name");
  return rows;
}

async function listApprovedUsersWithoutBranch() {
  const [rows] = await pool.query(
    "SELECT id, name, username FROM users WHERE status='approved' AND branch IS NULL ORDER BY name"
  );
  return rows;
}

async function updateUserBranch(userId, branch) {
  await pool.query("UPDATE users SET branch=? WHERE id=?", [branch, userId]);
}

async function updateUserRole(userId, role) {
  await pool.query("UPDATE users SET role=? WHERE id=?", [role, userId]);
}

async function listUsersByRole(role) {
  const [rows] = await pool.query("SELECT id, name, username, branch, status, role FROM users WHERE role=? ORDER BY name", [role]);
  return rows;
}

async function listUsersByRoleAndBranch(role, branch) {
  const [rows] = await pool.query(
    "SELECT id, name, username, branch, status, role FROM users WHERE role=? AND branch=? ORDER BY name",
    [role, branch]
  );
  return rows;
}

async function updateUserName(userId, newName) {
  const name = typeof newName === "string" ? newName.trim() : null;
  if (!name) throw new Error("Пустое ФИО");
  const parts = name.split(/\s+/).filter(Boolean);
  const first_name = parts[0] || null;
  const last_name = parts.length > 1 ? parts.slice(1).join(" ") : null;

  await pool.query("UPDATE users SET name=?, first_name=?, last_name=? WHERE id=?", [name, first_name, last_name, userId]);
}

module.exports = {
  getUserById,
  upsertUserBasic,
  updateUserName,
  setUserStatus,
  deleteUser,
  listApprovedUsers,
  listAllUsers,
  listApprovedUsersWithoutBranch,
  updateUserBranch,
  updateUserRole,
  listUsersByRole,
  listUsersByRoleAndBranch,
};
