const { Scenes, session } = require("telegraf");
const { createRegistrationScene } = require("./registration");
const { createAdminScenes } = require("./admin");

function applyScenes(bot) {
  const registrationScene = createRegistrationScene(bot);
  const adminScenes = createAdminScenes(bot);

  const stage = new Scenes.Stage([
    registrationScene,
    adminScenes.deleteCourierScene,
    adminScenes.broadcastScene,
    adminScenes.changeCourierNameScene,
    adminScenes.addLinkScene,
    adminScenes.deleteLinkScene,
    adminScenes.addTrainingScene,
    adminScenes.deleteTrainingScene,
    adminScenes.assignRoleScene,
  ]);

  bot.use(session());
  bot.use(stage.middleware());

  return {
    stage,
    registrationScene,
    ...adminScenes,
  };
}

module.exports = { applyScenes };
