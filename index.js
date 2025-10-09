require("dotenv").config();
const { validateConfig } = require("./config");
const { createBot } = require("./bot");
const { initSchema } = require("./services/db");
const { registerJobs, notifyUsersWithoutBranch } = require("./jobs");
const { logError, logSystemError } = require("./services/logger");

async function bootstrap() {
  validateConfig();
  const botToken = process.env.BOT_TOKEN;

  await initSchema();

  const bot = createBot(botToken);

  const jobs = registerJobs(bot);

  await bot.launch();
  console.log("🚀 Бот запущен");

  try {
    await jobs.notifyUsersWithoutBranch();
  } catch (err) {
    await logError(bot, err, "system", { name: "Система" }, "Не удалось запустить напоминание о выборе филиала");
  }

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

bootstrap().catch((err) => {
  logSystemError(err, "Не удалось запустить бота");
  process.exit(1);
});
