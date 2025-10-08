const cron = require("node-cron");
const moment = require("moment-timezone");
const { TIMEZONE } = require("../config");
const {
  listApprovedUsers,
  listApprovedUsersWithoutBranch,
} = require("../services/users");
const { logAction, logError } = require("../services/logger");
const { buildBranchKeyboard } = require("../bot/menus");

async function notifyUsersWithoutBranch(bot) {
  try {
    const users = await listApprovedUsersWithoutBranch();
    if (!users.length) {
      console.log("[Branch] Все одобренные курьеры уже выбрали филиал");
      return;
    }

    console.log(`[Branch] Отправляю запрос на выбор филиала ${users.length} пользователям`);
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(
          String(user.id),
          "Чтобы продолжить работу с ботом, выберите филиал:",
          buildBranchKeyboard("branch:select")
        );
        await logAction(bot, "Напоминание о выборе филиала", user.id, {
          name: user.name,
          username: user.username,
        });
      } catch (err) {
        await logError(bot, err, user.id, { name: user.name, username: user.username }, "Рассылка выбора филиала");
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (err) {
    console.error("Не удалось уведомить курьеров без филиала:", err.message);
  }
}

function scheduleWeeklyReminder(bot) {
  return cron.schedule(
    "0 12 * * 5",
    async () => {
      const now = moment().tz(TIMEZONE);
      console.log(`[Напоминание] Рассылаю напоминание в ${now.format("YYYY-MM-DD HH:mm")}`);

      try {
        await logAction(
          bot,
          "Запуск автоматической рассылки напоминаний",
          "system",
          {},
          {
            scheduledTime: now.format("YYYY-MM-DD HH:mm"),
            dayOfWeek: "пятница",
          }
        );

        const approvedUsers = await listApprovedUsers();
        let successCount = 0;
        let errorCount = 0;

        for (const u of approvedUsers) {
          let attempt = 0;
          let sent = false;
          while (attempt < 4 && !sent) {
            try {
              await bot.telegram.sendMessage(
                String(u.id),
                "⏰ Напоминаем! Пожалуйста, отправьте свой график на следующую неделю через кнопку «Отправить график» в меню."
              );
              successCount++;
              sent = true;
            } catch (e) {
              attempt++;
              const baseWait = 150;
              const waitMs = baseWait * Math.pow(2, attempt);
              console.error(`[Напоминание] Ошибка для ${u.id}, попытка ${attempt}:`, e.message);
              if (e && e.response && e.response.error_code === 429) {
                await new Promise((r) => setTimeout(r, waitMs + 500));
              } else {
                await new Promise((r) => setTimeout(r, waitMs));
              }
              if (attempt >= 4) {
                errorCount++;
                await logError(bot, e, u.id, { name: u.name, username: u.username }, "Отправка напоминания");
              }
            }
          }

          await new Promise((r) => setTimeout(r, 35));
        }

        await logAction(
          bot,
          "Завершение автоматической рассылки напоминаний",
          "system",
          {},
          {
            totalUsers: approvedUsers.length,
            successCount,
            errorCount,
          }
        );
      } catch (e) {
        console.error("[Напоминание] Ошибка выборки пользователей:", e.message);
        await logError(bot, e, "system", {}, "Автоматическая рассылка напоминаний");
      }
    },
    { timezone: TIMEZONE }
  );
}

function registerJobs(bot) {
  const reminderTask = scheduleWeeklyReminder(bot);
  return {
    reminderTask,
    notifyUsersWithoutBranch: () => notifyUsersWithoutBranch(bot),
  };
}

module.exports = {
  registerJobs,
  notifyUsersWithoutBranch,
};
