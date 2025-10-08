require("dotenv").config();
const { createBot } = require("./bot");
const { initSchema } = require("./services/db");
const { registerJobs, notifyUsersWithoutBranch } = require("./jobs");

async function bootstrap() {
  if (!process.env.BOT_TOKEN) {
    throw new Error("Отсутствует BOT_TOKEN в переменных окружения");
  }

  await initSchema();

  const bot = createBot(process.env.BOT_TOKEN);

  const jobs = registerJobs(bot);

  await bot.launch();
  console.log("🚀 Бот запущен");

  try {
    await jobs.notifyUsersWithoutBranch();
  } catch (err) {
    console.error("Не удалось запустить напоминание о выборе филиала:", err.message);
  }

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

bootstrap().catch((err) => {
  console.error("❌ Не удалось запустить бота:", err);
  process.exit(1);
});
