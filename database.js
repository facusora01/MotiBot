const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

// Configurable para poder correr pruebas contra una base descartable (y, si
// algún día hace falta, para montar la base fuera del contenedor).
const DB_PATH = process.env.MOTIBOT_DB || path.join(__dirname, "motivacional.db");
const db = new Database(DB_PATH);

// ─── TABLAS ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     TEXT UNIQUE NOT NULL,
    group_name   TEXT,
    active       INTEGER DEFAULT 1,
    web_token    TEXT,
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

  -- Un cumpleaños por persona y por grupo (la misma persona puede estar en
  -- varios grupos). last_greeted guarda el YYYY-MM-DD del último saludo: es lo
  -- que evita saludar dos veces si el proceso reinicia dentro del mismo minuto.
  CREATE TABLE IF NOT EXISTS birthdays (
    group_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    name         TEXT,
    month        INTEGER NOT NULL,
    day          INTEGER NOT NULL,
    year         INTEGER,
    added_by     TEXT,
    last_greeted TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    TEXT NOT NULL,
    text        TEXT NOT NULL,
    author      TEXT DEFAULT 'Anónimo',
    author_id   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  );

  -- WhatsApp permite UNA reacción por persona y por mensaje, así que la PK
  -- (idea_id, voter_id) alcanza: votar otra idea reemplaza el voto anterior.
  CREATE TABLE IF NOT EXISTS idea_votes (
    idea_id    INTEGER NOT NULL,
    voter_id   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (idea_id, voter_id),
    FOREIGN KEY (idea_id) REFERENCES ideas(id)
  );

  -- Mapa emoji → idea del último listado enviado a cada grupo. Cuando llega una
  -- reacción solo tenemos el id del mensaje: acá resolvemos a qué idea votó.
  CREATE TABLE IF NOT EXISTS idea_polls (
    msg_id     TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL,
    mapping    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

function addGroup(groupId, groupName) {
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
    const stmt = db.prepare("UPDATE group_settings SET use_custom = 'active' WHERE group_id = ?");
    return stmt.run(groupId);
  } catch (error) {
    console.error("❌ Error en activateCustomNow:", error.message);
    throw error;
  }
}

// ─── CUMPLEAÑOS ───────────────────────────────────────────────────────────────
// Volver a cargar a la misma persona pisa la fecha anterior (así se corrige un
// error sin comando extra) y limpia last_greeted: si la fecha nueva es hoy, el
// saludo sale igual.
function setBirthday(groupId, userId, name, month, day, year, addedBy) {
  db.prepare(`
    INSERT INTO birthdays (group_id, user_id, name, month, day, year, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, user_id) DO UPDATE SET
      name = excluded.name,
      month = excluded.month,
      day = excluded.day,
      year = excluded.year,
      added_by = excluded.added_by,
      last_greeted = NULL
  `).run(groupId, userId, name || null, month, day, year || null, addedBy);
}

function getBirthdaysList(groupId) {
  return db.prepare(`
    SELECT * FROM birthdays WHERE group_id = ? ORDER BY month, day
  `).all(groupId);
}

function countBirthdays(groupId) {
  return db.prepare(`SELECT COUNT(*) as count FROM birthdays WHERE group_id = ?`).get(groupId).count;
}

// fechas: [{ month, day }] — normalmente una sola, pero el 1/3 de un año no
// bisiesto también arrastra a los nacidos el 29/2. hoyISO (YYYY-MM-DD) filtra a
// los ya saludados hoy.
function getBirthdaysDelDia(groupId, fechas, hoyISO) {
  if (!fechas.length) return [];
  const where = fechas.map(() => "(month = ? AND day = ?)").join(" OR ");
  const params = fechas.flatMap((f) => [f.month, f.day]);
  return db.prepare(`
    SELECT * FROM birthdays
    WHERE group_id = ? AND (${where})
      AND (last_greeted IS NULL OR last_greeted != ?)
  `).all(groupId, ...params, hoyISO);
}

function markBirthdayGreeted(groupId, userId, hoyISO) {
  db.prepare(`
    UPDATE birthdays SET last_greeted = ? WHERE group_id = ? AND user_id = ?
  `).run(hoyISO, groupId, userId);
}

function deleteBirthday(groupId, userId) {
  const info = db.prepare(`DELETE FROM birthdays WHERE group_id = ? AND user_id = ?`).run(groupId, userId);
  return info.changes > 0;
}

// ─── IDEAS ────────────────────────────────────────────────────────────────────
function addIdea(groupId, text, author, authorId) {
  const info = db.prepare(`
    INSERT INTO ideas (group_id, text, author, author_id) VALUES (?, ?, ?, ?)
  `).run(groupId, text, author || "Anónimo", authorId);
  return info.lastInsertRowid;
}

// Orden ESTABLE (por antigüedad). Es el que usa el listado del chat: si
// ordenáramos por votos, cada idea cambiaría de número al recibir uno y el
// 1️⃣ significaría algo distinto en cada listado — quien vota cree que su voto
// se fue a otra idea.
function getIdeasList(groupId) {
  return db.prepare(`
    SELECT i.*, (SELECT COUNT(*) FROM idea_votes v WHERE v.idea_id = i.id) AS votes
    FROM ideas i
    WHERE i.group_id = ?
    ORDER BY i.id ASC
  `).all(groupId);
}

// Para el panel web, donde sí interesa ver el ranking y no hay numeración que
// respetar.
function getIdeasRanking(groupId) {
  return db.prepare(`
    SELECT i.*, (SELECT COUNT(*) FROM idea_votes v WHERE v.idea_id = i.id) AS votes
    FROM ideas i
    WHERE i.group_id = ?
    ORDER BY votes DESC, i.id ASC
  `).all(groupId);
}

function countIdeas(groupId) {
  return db.prepare(`SELECT COUNT(*) as count FROM ideas WHERE group_id = ?`).get(groupId).count;
}

// Tope diario por persona: evita que una sola llene el listado.
function countIdeasHoyDeAutor(groupId, authorId) {
  return db.prepare(`
    SELECT COUNT(*) as count FROM ideas
    WHERE group_id = ? AND author_id = ?
      AND date(created_at, 'localtime') = date('now', 'localtime')
  `).get(groupId, authorId).count;
}

function deleteIdeas(groupId, ideaIds) {
  const borrar = db.transaction((ids) => {
    const delVotes = db.prepare(`DELETE FROM idea_votes WHERE idea_id = ?`);
    const delIdea = db.prepare(`DELETE FROM ideas WHERE group_id = ? AND id = ?`);
    for (const raw of ids) {
      const id = parseInt(raw, 10);
      if (!Number.isInteger(id)) continue;
      delVotes.run(id);
      delIdea.run(groupId, id);
    }
  });
  return borrar(ideaIds);
}

// ─── VOTACIÓN DE IDEAS ────────────────────────────────────────────────────────
// Un solo listado activo por grupo. Con dos, los votos de uno pisan los del
// otro: cada sincronización recalcula desde las reacciones de SU mensaje, así
// que el último en sincronizar borraría los votos del anterior. Además, cuando
// la reacción llega sin el id del mensaje, hay que adivinar a cuál pertenece.
function saveIdeaPoll(msgId, groupId, mapping) {
  const guardar = db.transaction(() => {
    db.prepare(`DELETE FROM idea_polls WHERE group_id = ? AND msg_id != ?`).run(groupId, msgId);
    db.prepare(`
      INSERT INTO idea_polls (msg_id, group_id, mapping) VALUES (?, ?, ?)
      ON CONFLICT(msg_id) DO UPDATE SET mapping = excluded.mapping
    `).run(msgId, groupId, JSON.stringify(mapping));
  });
  guardar();
}

function getIdeaPoll(msgId) {
  const row = db.prepare(`SELECT * FROM idea_polls WHERE msg_id = ?`).get(msgId);
  if (!row) return null;
  try {
    return { ...row, mapping: JSON.parse(row.mapping) };
  } catch (e) {
    return null;
  }
}

// Listados vivos de UN chat. Es el filtro barato que decide, sin tocar la
// página, si una reacción nos interesa: si el chat no tiene listado, se ignora.
function getPollsDeGrupo(groupId, dias = 7) {
  const rows = db.prepare(`
    SELECT * FROM idea_polls
    WHERE group_id = ? AND created_at > datetime('now', ?)
    ORDER BY created_at DESC
  `).all(groupId, `-${dias} days`);

  return rows.map((row) => {
    try {
      return { ...row, mapping: JSON.parse(row.mapping) };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

function getPollsRecientes(dias = 7) {
  const rows = db.prepare(`
    SELECT * FROM idea_polls
    WHERE created_at > datetime('now', ?)
    ORDER BY created_at DESC
  `).all(`-${dias} days`);

  return rows.map((row) => {
    try {
      return { ...row, mapping: JSON.parse(row.mapping) };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

// Reescribe de cero los votos de las ideas de un listado a partir de lo que
// WhatsApp reporta como reacciones reales. Es idempotente: si algo se
// desincronizó (un evento perdido, un reinicio), la próxima pasada lo corrige.
function reemplazarVotosPoll(ideaIds, votos) {
  const aplicar = db.transaction(() => {
    const del = db.prepare(`DELETE FROM idea_votes WHERE idea_id = ?`);
    for (const id of ideaIds) del.run(id);

    const ins = db.prepare(`INSERT OR IGNORE INTO idea_votes (idea_id, voter_id) VALUES (?, ?)`);
    for (const v of votos) ins.run(v.ideaId, v.voterId);
  });
  return aplicar();
}

// Un voto por persona y por listado: antes de sumar el nuevo, borramos el que
// esa persona tuviera en cualquier idea de ESE listado (WhatsApp reemplaza la
// reacción anterior, así que el voto viejo quedaría colgado).
function setVoto(ideaIds, voterId, ideaElegida) {
  const votar = db.transaction(() => {
    const del = db.prepare(`DELETE FROM idea_votes WHERE idea_id = ? AND voter_id = ?`);
    for (const id of ideaIds) del.run(id, voterId);
    if (ideaElegida) {
      db.prepare(`
        INSERT OR IGNORE INTO idea_votes (idea_id, voter_id) VALUES (?, ?)
      `).run(ideaElegida, voterId);
    }
  });
  return votar();
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
  setBirthday,
  getBirthdaysList,
  countBirthdays,
  getBirthdaysDelDia,
  markBirthdayGreeted,
  deleteBirthday,
  addIdea,
  getIdeasList,
  getIdeasRanking,
  countIdeas,
  countIdeasHoyDeAutor,
  deleteIdeas,
  saveIdeaPoll,
  getIdeaPoll,
  getPollsRecientes,
  getPollsDeGrupo,
  reemplazarVotosPoll,
  setVoto,
};