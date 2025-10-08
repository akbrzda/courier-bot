/**
 * Миграция для добавления таблиц links и training_materials
 * Запустить один раз для обновления существующей базы данных
 */

require("dotenv").config();
const { pool, initSchema } = require("./services/db");

async function migrate() {
  console.log("🔄 Начало миграции...");

  try {
    // Используем initSchema - она создаст таблицы если их нет
    await initSchema();
    console.log("✅ Миграция успешно завершена!");
    console.log("📋 Созданы/обновлены таблицы:");
    console.log("   - users");
    console.log("   - links");
    console.log("   - training_materials");
  } catch (error) {
    console.error("❌ Ошибка миграции:", error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
