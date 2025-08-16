const { pool } = require("./db");

async function getUserById(userId) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id=? LIMIT 1", [userId]);
  return rows[0] || null;
}

async function upsertUserBasic(userId, payload) {
  const { name, status = "pending", username = null, first_name = null, last_name = null } = payload;
  await pool.query(
    `INSERT INTO users (id, name, status, username, first_name, last_name)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status), username=VALUES(username), first_name=VALUES(first_name), last_name=VALUES(last_name)`,
    [userId, name, status, username, first_name, last_name]
  );
}

async function setUserStatus(userId, status) {
  await pool.query("UPDATE users SET status=? WHERE id=?", [status, userId]);
}

async function deleteUser(userId) {
  await pool.query("DELETE FROM users WHERE id=?", [userId]);
}

async function listApprovedUsers() {
  const [rows] = await pool.query("SELECT id, name, username FROM users WHERE status='approved' ORDER BY name");
  return rows;
}

async function listAllUsers() {
  const [rows] = await pool.query("SELECT id, name, username, status FROM users ORDER BY name");
  return rows;
}

module.exports = {
  getUserById,
  upsertUserBasic,
  setUserStatus,
  deleteUser,
  listApprovedUsers,
  listAllUsers,
};

