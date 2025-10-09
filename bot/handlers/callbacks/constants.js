const { ROLES } = require("../../../config");

const SETTINGS_ALLOWED_ROLES = new Set([ROLES.COURIER, ROLES.LOGIST, ROLES.SENIOR]);

module.exports = {
  SETTINGS_ALLOWED_ROLES,
};
