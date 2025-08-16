require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { initSchema, pool } = require("./db");

async function migrate() {
  const jsonPath = path.resolve(__dirname, "users.json");
  if (!fs.existsSync(jsonPath)) {
    console.log("users.json не найден — мигрировать нечего. Пропускаю.");
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.error("Не удалось прочитать users.json:", e.message);
    process.exit(1);
  }

  const entries = Object.entries(data || {});
  if (entries.length === 0) {
    console.log("users.json пуст — мигрировать нечего. Пропускаю.");
    return;
  }

  await initSchema();

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let inserted = 0;
    for (const [idRaw, user] of entries) {
      const id = BigInt(idRaw);
      const name = (user?.name || "").trim();
      const status = user?.status === "approved" ? "approved" : "pending";
      if (!name) continue;

      await connection.query(
        `INSERT INTO users (id, name, status) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status)`,
        [id.toString(), name, status]
      );
      inserted += 1;
    }

    await connection.commit();
    console.log(`Миграция завершена: перенесено записей: ${inserted}`);
  } catch (e) {
    await connection.rollback();
    console.error("Ошибка миграции:", e.message);
    process.exit(1);
  } finally {
    connection.release();
  }
}

migrate().then(() => process.exit(0));

