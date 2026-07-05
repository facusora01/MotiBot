const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto"); // 👈 Agregado para generar tokens aleatorios

const db = new Database(path.join(__dirname, "motivacional.db"));

// ─── TABLAS ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     TEXT UNIQUE NOT NULL,
    group_name   TEXT,
    active       INTEGER DEFAULT 1,
    web_token    TEXT, -- 👈 Agregado aquí para nuevas instalaciones
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_settings (
    group_id             TEXT PRIMARY KEY,
    language             TEXT DEFAULT 'es',
    use_custom           TEXT DEFAULT 'default',
    custom_requested_at  DATETIME,
    custom_start_date    DATETIME,
    send_time            TEXT DEFAULT '08:00',
    frequency            INTEGER DEFAULT 1,
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  );

  CREATE TABLE IF NOT EXISTS custom_phrases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    TEXT NOT NULL,
    phrase      TEXT NOT NULL,
    author      TEXT DEFAULT 'Anónimo',
    added_by    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  );
`);

// ─── MIGRACIONES AUTOMÁTICAS ──────────────────────────────────────────────────
try {
  db.exec(`ALTER TABLE group_settings ADD COLUMN frequency INTEGER DEFAULT 1`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE groups ADD COLUMN web_token TEXT`);
  console.log("🔧 Migración: Columna 'web_token' lista.");
} catch (e) {}

// Origen de la frase: 'new' (comando /new) o 'add' (reply con /add). Las viejas
// quedan en 'new' por el default. Sirve para marcarlas distinto en el panel.
try {
  db.exec(`ALTER TABLE custom_phrases ADD COLUMN source TEXT DEFAULT 'new'`);
  console.log("🔧 Migración: Columna 'source' lista.");
} catch (e) {}

// ─── GRUPOS ───────────────────────────────────────────────────────────────────

/**
 * Agrega o activa un grupo generando un token único si no tiene uno.
 */
function addGroup(groupId, groupName) {
  // Generamos un token aleatorio de 16 caracteres hexadecimales
  const token = crypto.randomBytes(8).toString('hex'); 
  
  const stmt = db.prepare(`
    INSERT INTO groups (group_id, group_name, active, web_token)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(group_id) DO UPDATE SET 
      active = 1, 
      group_name = excluded.group_name,
      web_token = COALESCE(groups.web_token, excluded.web_token) -- 🛡️ No pisa el token si ya existe
  `);
  stmt.run(groupId, groupName, token);

  db.prepare(`INSERT OR IGNORE INTO group_settings (group_id) VALUES (?)`).run(groupId);
}

function removeGroup(groupId) {
  db.prepare(`UPDATE groups SET active = 0 WHERE group_id = ?`).run(groupId);
}

function getActiveGroups() {
  return db.prepare(`SELECT * FROM groups WHERE active = 1`).all();
}

function getGroup(groupId) {
  return db.prepare(`SELECT * FROM groups WHERE group_id = ?`).get(groupId);
}

function getGroupToken(groupId) {
  const row = db.prepare("SELECT web_token FROM groups WHERE group_id = ?").get(groupId);
  return row ? row.web_token : null;
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function getGroupSettings(groupId) {
  return db.prepare(`SELECT * FROM group_settings WHERE group_id = ?`).get(groupId);
}

function setLanguage(groupId, language) {
  db.prepare(`UPDATE group_settings SET language = ? WHERE group_id = ?`).run(language, groupId);
}

function requestCustomLibrary(groupId) {
  const now = new Date();
  const startDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); 
  db.prepare(`
    UPDATE group_settings
    SET use_custom = 'pending',
        custom_requested_at = ?,
        custom_start_date = ?
    WHERE group_id = ?
  `).run(now.toISOString(), startDate.toISOString(), groupId);
  return startDate;
}

function getSendTime(groupId) {
  const settings = getGroupSettings(groupId);
  return settings?.send_time || "08:00";
}

function setSendTime(groupId, time) {
  db.prepare(`UPDATE group_settings SET send_time = ? WHERE group_id = ?`).run(time, groupId);
}

function switchToDefault(groupId) {
  db.prepare(`
    UPDATE group_settings
    SET use_custom = 'default',
        custom_requested_at = NULL,
        custom_start_date = NULL
    WHERE group_id = ?
  `).run(groupId);
}

function checkAndActivateCustom(groupId) {
  const settings = getGroupSettings(groupId);
  if (!settings || settings.use_custom !== "pending") return;
  if (new Date() >= new Date(settings.custom_start_date)) {
    db.prepare(`UPDATE group_settings SET use_custom = 'active' WHERE group_id = ?`).run(groupId);
  }
}

// ─── FRASES CUSTOM ────────────────────────────────────────────────────────────
function addCustomPhrase(groupId, phrase, author, addedBy, source = "new") {
  db.prepare(`
    INSERT INTO custom_phrases (group_id, phrase, author, added_by, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(groupId, phrase, author || "Anónimo", addedBy, source);
}

function getCustomPhrases(groupId) {
  return db.prepare(`SELECT * FROM custom_phrases WHERE group_id = ?`).all(groupId);
}

function countCustomPhrases(groupId) {
  return db.prepare(`SELECT COUNT(*) as count FROM custom_phrases WHERE group_id = ?`).get(groupId).count;
}

function getRandomCustomPhrase(groupId) {
  return db.prepare(`
    SELECT * FROM custom_phrases WHERE group_id = ? ORDER BY RANDOM() LIMIT 1
  `).get(groupId);
}

function setFrequency(groupId, frequency) {
  db.prepare(`UPDATE group_settings SET frequency = ? WHERE group_id = ?`).run(frequency, groupId);
}

function deleteCustomPhrase(groupId, phraseId) {
  const info = db.prepare("DELETE FROM custom_phrases WHERE group_id = ? AND id = ?").run(groupId, phraseId);
  return info.changes > 0;
}

function getCustomPhrasesList(groupId) {
  return db.prepare("SELECT id, phrase, author, added_by, source FROM custom_phrases WHERE group_id = ? ORDER BY id DESC").all(groupId);
}

function deleteMultiplePhrases(groupId, phraseIds) {
  const deleteAction = db.transaction((ids) => {
    const stmt = db.prepare("DELETE FROM custom_phrases WHERE group_id = ? AND id = ?");
    for (const id of ids) {
      stmt.run(groupId, parseInt(id));
    }
  });
  return deleteAction(phraseIds);
}

function activateCustomNow(groupId) {
  try {
    // 🛡️ Usamos 'db' que ya está inicializada al principio del archivo
    const stmt = db.prepare("UPDATE group_settings SET use_custom = 'active' WHERE group_id = ?");
    return stmt.run(groupId);
  } catch (error) {
    console.error("❌ Error en activateCustomNow:", error.message);
    throw error;
  }
}

module.exports = {
  addGroup,
  removeGroup,
  getActiveGroups,
  getGroup,
  getGroupSettings,
  setLanguage,
  requestCustomLibrary,
  switchToDefault,
  checkAndActivateCustom,
  addCustomPhrase,
  getCustomPhrases,
  countCustomPhrases,
  getRandomCustomPhrase,
  getSendTime,
  setSendTime,
  setFrequency,
  deleteCustomPhrase,
  getCustomPhrasesList,
  deleteMultiplePhrases,
  getGroupToken,
  activateCustomNow,
};