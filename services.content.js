const { pool } = require("./db");

// ============ LINKS ============
async function getAllLinks() {
  const [rows] = await pool.query("SELECT * FROM links ORDER BY created_at DESC");
  return rows;
}

async function getLinkById(id) {
  const [rows] = await pool.query("SELECT * FROM links WHERE id=? LIMIT 1", [id]);
  return rows[0] || null;
}

async function createLink(title, url) {
  const [result] = await pool.query("INSERT INTO links (title, url) VALUES (?, ?)", [title, url]);
  return result.insertId;
}

async function deleteLink(id) {
  await pool.query("DELETE FROM links WHERE id=?", [id]);
}

// ============ TRAINING MATERIALS ============
async function getAllTrainingMaterials() {
  const [rows] = await pool.query("SELECT * FROM training_materials ORDER BY created_at DESC");
  return rows;
}

async function getTrainingMaterialById(id) {
  const [rows] = await pool.query("SELECT * FROM training_materials WHERE id=? LIMIT 1", [id]);
  return rows[0] || null;
}

async function createTrainingMaterial(title, content, mediaUrl = null, mediaType = null) {
  const [result] = await pool.query("INSERT INTO training_materials (title, content, media_url, media_type) VALUES (?, ?, ?, ?)", [
    title,
    content,
    mediaUrl,
    mediaType,
  ]);
  return result.insertId;
}

async function deleteTrainingMaterial(id) {
  await pool.query("DELETE FROM training_materials WHERE id=?", [id]);
}

module.exports = {
  getAllLinks,
  getLinkById,
  createLink,
  deleteLink,
  getAllTrainingMaterials,
  getTrainingMaterialById,
  createTrainingMaterial,
  deleteTrainingMaterial,
};
