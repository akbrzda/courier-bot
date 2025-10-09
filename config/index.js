const TIMEZONE = "Asia/Yekaterinburg";

const REQUIRED_ENV_VARS = Object.freeze(["BOT_TOKEN", "DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME", "GRAFIK", "SHEET_ID"]);

const BRANCHES = [
  { id: "surgut_1", label: "Сургут 1 (30 Лет Победы)" },
  { id: "surgut_2", label: "Сургут 2 (Усольцева)" },
  { id: "surgut_3", label: "Сургут 3 (Магистральная)" },
];

const ROLES = Object.freeze({
  COURIER: "courier",
  SENIOR: "senior",
  LOGIST: "logist",
  ADMIN: "admin",
});

const MANAGER_ROLES = new Set([ROLES.SENIOR, ROLES.LOGIST, ROLES.ADMIN]);
const BRANCH_MANAGER_ROLES = new Set([ROLES.SENIOR, ROLES.LOGIST, ROLES.ADMIN]);

const ROLE_OPTIONS = [
  { id: ROLES.COURIER, label: "Курьер" },
  { id: ROLES.SENIOR, label: "Старший курьер" },
  { id: ROLES.LOGIST, label: "Логист" },
];

function parseEnvList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ADMIN_IDS = Object.freeze(parseEnvList(process.env.ADMIN_IDS || process.env.ADMIN_ID));
const SPREADSHEET_ID = process.env.GRAFIK;
const TEMPLATE_SHEET_NAME = process.env.TEMPLATE_SHEET_NAME || "Template";
const REPORT_SHEET_ID = process.env.SHEET_ID;

function validateConfig() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key] || String(process.env[key]).trim() === "");
  if (missing.length) {
    throw new Error(`Отсутствуют обязательные переменные окружения: ${missing.join(", ")}`);
  }
}

module.exports = {
  TIMEZONE,
  BRANCHES,
  ROLES,
  ROLE_OPTIONS,
  MANAGER_ROLES,
  BRANCH_MANAGER_ROLES,
  ADMIN_IDS,
  SPREADSHEET_ID,
  TEMPLATE_SHEET_NAME,
  REPORT_SHEET_ID,
  validateConfig,
};
