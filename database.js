const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

// Configurable para correr pruebas contra una base descartable.
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
    phrases_enabled      INTEGER DEFAULT 1,
    market_enabled       INTEGER DEFAULT 0,
    market_time          TEXT DEFAULT '09:00',
    market_last_sent     TEXT,
    carry_storage        REAL,
    carry_storage_unit   TEXT DEFAULT 'usd',
    carry_rate           REAL,
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

  -- last_greeted (YYYY-MM-DD) evita saludar dos veces si el proceso reinicia
  -- dentro del mismo minuto.
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

  -- Un voto por persona y por GRUPO, no por listado: así los votos se acumulan
  -- entre listados en vez de reiniciarse. poll_msg_id recuerda en qué listado se
  -- emitió, que es lo que permite distinguir "retiró su reacción de ESE listado"
  -- de "votó en otro".
  CREATE TABLE IF NOT EXISTS idea_votes (
    group_id    TEXT NOT NULL,
    voter_id    TEXT NOT NULL,
    idea_id     INTEGER NOT NULL,
    poll_msg_id TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, voter_id),
    FOREIGN KEY (idea_id) REFERENCES ideas(id)
  );

  -- Alertas de precio, puestas por la gente: "avisame cuando la soja toque X".
  -- El bot no opina, solo avisa que se tocó el número que puso el usuario.
  -- chat_id es DONDE avisa (el grupo o el privado donde se creó), no quién la
  -- puso: una alerta creada en un privado no tiene por qué verla un grupo.
  -- direccion ('sube'|'baja') se deduce del precio del día en que se creó, y es
  -- lo que define qué es "cruzar" el objetivo.
  CREATE TABLE IF NOT EXISTS market_alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    user_id    TEXT,
    user_name  TEXT,
    producto   TEXT NOT NULL,
    direccion  TEXT NOT NULL,
    objetivo   REAL NOT NULL,
    creada_en  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Historia de la pizarra: el feed solo devuelve el día, así que si no la
  -- guardamos no hay con qué comparar nunca. Una fila por grano y por día.
  CREATE TABLE IF NOT EXISTS market_history (
    fecha      TEXT NOT NULL,
    producto   TEXT NOT NULL,
    importe    REAL NOT NULL,
    guardado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (fecha, producto)
  );

  -- Serie histórica de Matba Rofex, en las dos monedas. Va en tabla aparte de
  -- market_history a propósito: son fuentes distintas con números distintos
  -- (el 1/9/26 la pizarra de ACAbase daba soja 550.000 y MATBA 560.000), y
  -- mezclarlas en una sola columna produciría una serie que no es ninguna de
  -- las dos. Se hace backfill una vez y después se agrega una fila por rueda.
  CREATE TABLE IF NOT EXISTS matba_history (
    fecha       TEXT NOT NULL,
    producto    TEXT NOT NULL,
    usd         REAL,
    ars         REAL,
    guardado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (fecha, producto)
  );

  -- Mapa emoji → idea del último listado de cada grupo: resuelve a qué idea
  -- corresponde una reacción.
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

// Modo "solo mercado": apagando phrases_enabled el grupo deja de recibir la
// frase diaria y los saludos de cumple, y MotiBot ignora ahi todo lo que no sea
// la pizarra. Default 1 para que los grupos que ya existen sigan igual.
try {
  db.exec(`ALTER TABLE group_settings ADD COLUMN phrases_enabled INTEGER DEFAULT 1`);
  console.log("🔧 Migración: Columna 'phrases_enabled' lista.");
} catch (e) {}

// Mercado de granos: opt-in por grupo, lo habilita el super admin desde su
// privado. market_last_sent (YYYY-MM-DD) evita repetir el envio en el dia.
try {
  db.exec(`ALTER TABLE group_settings ADD COLUMN market_enabled INTEGER DEFAULT 0`);
  console.log("🔧 Migración: Columna 'market_enabled' lista.");
} catch (e) {}

try {
  db.exec(`ALTER TABLE group_settings ADD COLUMN market_time TEXT DEFAULT '09:00'`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE group_settings ADD COLUMN market_last_sent TEXT`);
} catch (e) {}

// Supuestos del carry: almacenaje en USD/t/mes y costo del dinero anual en
// dolares. NULL = sin configurar, y en ese caso el carry no se muestra: una
// cuenta con supuestos que el productor no eligio es peor que ninguna cuenta.
try {
  db.exec(`ALTER TABLE group_settings ADD COLUMN carry_storage REAL`);
  db.exec(`ALTER TABLE group_settings ADD COLUMN carry_rate REAL`);
  db.exec(`ALTER TABLE group_settings ADD COLUMN carry_storage_unit TEXT DEFAULT 'usd'`);
  console.log("🔧 Migración: Columnas de supuestos del carry listas.");
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

// idea_votes nació con PK (idea_id, voter_id), que reiniciaba la votación en
// cada listado nuevo. La PK no se puede cambiar con ALTER: rehacemos la tabla
// conservando los votos, deduciendo el grupo desde ideas y asignándoles el
// listado vigente de ese grupo.
try {
  const columnas = db.prepare(`PRAGMA table_info(idea_votes)`).all().map((c) => c.name);
  if (columnas.length && !columnas.includes("poll_msg_id")) {
    db.exec(`
      CREATE TABLE idea_votes_nueva (
        group_id    TEXT NOT NULL,
        voter_id    TEXT NOT NULL,
        idea_id     INTEGER NOT NULL,
        poll_msg_id TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, voter_id),
        FOREIGN KEY (idea_id) REFERENCES ideas(id)
      );

      INSERT OR IGNORE INTO idea_votes_nueva (group_id, voter_id, idea_id, poll_msg_id, created_at)
      SELECT i.group_id, v.voter_id, v.idea_id,
             (SELECT p.msg_id FROM idea_polls p WHERE p.group_id = i.group_id ORDER BY p.created_at DESC LIMIT 1),
             v.created_at
      FROM idea_votes v
      JOIN ideas i ON i.id = v.idea_id;

      DROP TABLE idea_votes;
      ALTER TABLE idea_votes_nueva RENAME TO idea_votes;
    `);
    console.log("🔧 Migración: votos de ideas ahora son uno por persona y grupo.");
  }
} catch (e) {
  console.error("❌ Error migrando idea_votes:", e.message);
}

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

// Activos + dados de baja: el panel del super admin los lista todos para poder
// reactivar uno sin tener que volver a pasar por /mbot add en el grupo. Orden
// por id de alta y nada más: el panel numera las filas, y ordenar por estado
// haría que dar de baja un grupo renumere a todos los demás.
function getAllGroups() {
  return db.prepare(`SELECT * FROM groups ORDER BY id ASC`).all();
}

// Borrado definitivo: el grupo y TODO lo que colgaba de él (frases, cumples,
// ideas con sus votos, listados y settings). No hay foreign keys en cascada
// acá, así que cada tabla se limpia a mano; en una transacción para no dejar
// huérfanos si algo falla a mitad de camino. El llamador decide a quién se le
// permite (el panel solo lo ofrece sobre grupos ya dados de baja).
function deleteGroupCompleto(groupId) {
  const borrar = db.transaction(() => {
    db.prepare(`DELETE FROM idea_votes WHERE group_id = ?`).run(groupId);
    db.prepare(`DELETE FROM idea_polls WHERE group_id = ?`).run(groupId);
    db.prepare(`DELETE FROM ideas WHERE group_id = ?`).run(groupId);
    db.prepare(`DELETE FROM birthdays WHERE group_id = ?`).run(groupId);
    db.prepare(`DELETE FROM custom_phrases WHERE group_id = ?`).run(groupId);
    db.prepare(`DELETE FROM group_settings WHERE group_id = ?`).run(groupId);
    return db.prepare(`DELETE FROM groups WHERE group_id = ?`).run(groupId).changes > 0;
  });
  return borrar();
}

// Un chat privado se registra como cualquier otro chat, pero al reves que un
// grupo: NADA prendido de entrada. En un grupo alguien hace /mbot add porque
// quiere las frases; en un privado la persona pidio una cosa puntual y no
// corresponde empezar a mandarle lo demas. Solo aplica los defaults la primera
// vez: si el chat ya existia, respeta lo que la persona haya elegido.
function registrarChatPrivado(chatId, nombre) {
  const nuevo = !db.prepare(`SELECT 1 FROM groups WHERE group_id = ?`).get(chatId);
  addGroup(chatId, nombre);
  if (nuevo) {
    db.prepare(`
      UPDATE group_settings SET phrases_enabled = 0, market_enabled = 0 WHERE group_id = ?
    `).run(chatId);
  }
  return nuevo;
}

// Reactiva un grupo ya conocido sin tocar su nombre ni su token.
function reactivateGroup(groupId) {
  const info = db.prepare(`UPDATE groups SET active = 1 WHERE group_id = ?`).run(groupId);
  db.prepare(`INSERT OR IGNORE INTO group_settings (group_id) VALUES (?)`).run(groupId);
  return info.changes > 0;
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
// Recargar pisa la fecha anterior y limpia last_greeted: si la nueva es hoy, el
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

// fechas: [{month, day}] — más de una el 1/3 de año no bisiesto, que arrastra a
// los nacidos el 29/2.
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

// Orden estable para el listado del chat: ordenado por votos, cada idea
// cambiaría de número al recibir uno y el voto parecería mal asignado.
function getIdeasList(groupId) {
  return db.prepare(`
    SELECT i.*, (SELECT COUNT(*) FROM idea_votes v WHERE v.idea_id = i.id) AS votes
    FROM ideas i
    WHERE i.group_id = ?
    ORDER BY i.id ASC
  `).all(groupId);
}

// Para el panel web, donde no hay numeración que respetar.
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
// Un solo listado activo por grupo: cada sincronización recalcula los votos
// desde las reacciones de SU mensaje, así que dos listados se pisan entre sí.
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

// Filtro barato para descartar reacciones ajenas sin tocar la página.
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

// Aplica las reacciones de UN listado sin pisar los votos de los demás: quien
// reaccionó acá pasa a votar esta idea (su voto anterior en el grupo se muda) y
// solo se borra a quien había votado en ESTE listado y ya no figura, es decir
// quien retiró su reacción. El que votó en otro listado queda intacto.
function aplicarVotosDePoll(groupId, pollMsgId, votos) {
  const aplicar = db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO idea_votes (group_id, voter_id, idea_id, poll_msg_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, voter_id) DO UPDATE SET
        idea_id = excluded.idea_id,
        poll_msg_id = excluded.poll_msg_id,
        created_at = CURRENT_TIMESTAMP
    `);
    for (const v of votos) upsert.run(groupId, v.voterId, v.ideaId, pollMsgId);

    const votantes = votos.map((v) => v.voterId);
    const huecos = votantes.length ? `AND voter_id NOT IN (${votantes.map(() => "?").join(",")})` : "";
    db.prepare(`
      DELETE FROM idea_votes WHERE group_id = ? AND poll_msg_id = ? ${huecos}
    `).run(groupId, pollMsgId, ...votantes);
  });
  return aplicar();
}

// --- SUPUESTOS DEL CARRY -----------------------------------------------------
function getCarryCostos(groupId) {
  const row = db.prepare(`
    SELECT carry_storage, carry_storage_unit, carry_rate FROM group_settings WHERE group_id = ?
  `).get(groupId);
  if (!row || row.carry_storage === null || row.carry_rate === null) return null;
  return {
    almacenaje: row.carry_storage,
    // 'pct' = porcentaje mensual del valor del grano, que es como lo cobran los
    // acopios; 'usd' = dolares por tonelada por mes, fijo.
    unidad: row.carry_storage_unit || "usd",
    tasaAnual: row.carry_rate,
  };
}

function setCarryCostos(groupId, almacenaje, unidad, tasaAnual) {
  db.prepare(`INSERT OR IGNORE INTO group_settings (group_id) VALUES (?)`).run(groupId);
  db.prepare(`
    UPDATE group_settings
    SET carry_storage = ?, carry_storage_unit = ?, carry_rate = ?
    WHERE group_id = ?
  `).run(almacenaje, unidad, tasaAnual, groupId);
}

// --- ALERTAS DE PRECIO -------------------------------------------------------
const MAX_ALERTAS_POR_CHAT = 20;

function addAlerta(chatId, userId, userName, producto, direccion, objetivo) {
  const info = db.prepare(`
    INSERT INTO market_alerts (chat_id, user_id, user_name, producto, direccion, objetivo)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chatId, userId, userName, producto, direccion, objetivo);
  return info.lastInsertRowid;
}

function getAlertasDeChat(chatId) {
  return db.prepare(`SELECT * FROM market_alerts WHERE chat_id = ? ORDER BY id ASC`).all(chatId);
}

function getTodasLasAlertas() {
  return db.prepare(`SELECT * FROM market_alerts ORDER BY chat_id, id`).all();
}

function countAlertasDeChat(chatId) {
  return db.prepare(`SELECT COUNT(*) as count FROM market_alerts WHERE chat_id = ?`).get(chatId).count;
}

// Acotado al chat: una alerta solo la borra quien la ve.
function deleteAlerta(chatId, id) {
  const info = db.prepare(`DELETE FROM market_alerts WHERE chat_id = ? AND id = ?`).run(chatId, id);
  return info.changes > 0;
}

// Cuando una alerta se cumple se borra: avisar todos los dias que la soja sigue
// arriba del objetivo seria ruido, no informacion.
function deleteAlertas(ids) {
  const borrar = db.transaction((lista) => {
    const stmt = db.prepare(`DELETE FROM market_alerts WHERE id = ?`);
    for (const id of lista) stmt.run(id);
  });
  return borrar(ids);
}

// --- HISTORIA DE LA PIZARRA --------------------------------------------------
// Idempotente: el tick puede pasar varias veces por la misma pizarra del dia.
function guardarPizarra(fechaISO, granos) {
  const guardar = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO market_history (fecha, producto, importe) VALUES (?, ?, ?)
      ON CONFLICT(fecha, producto) DO UPDATE SET importe = excluded.importe
    `);
    for (const g of granos) stmt.run(fechaISO, g.codigo, g.importe);
  });
  return guardar();
}

// Guarda o actualiza filas de la serie de MATBA. COALESCE: si una rueda ya
// estaba con las dos monedas y viene una actualización con solo una, no le
// borramos la otra.
function guardarMatba(producto, filas) {
  const guardar = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO matba_history (fecha, producto, usd, ars) VALUES (?, ?, ?, ?)
      ON CONFLICT(fecha, producto) DO UPDATE SET
        usd = COALESCE(excluded.usd, matba_history.usd),
        ars = COALESCE(excluded.ars, matba_history.ars)
    `);
    for (const f of filas) {
      if (!f?.fecha) continue;
      stmt.run(f.fecha, producto, f.usd ?? null, f.ars ?? null);
    }
  });
  return guardar();
}

// La serie guardada, en el mismo formato que devuelve matba.getHistoria().
function getMatbaHistoria(producto, desdeISO) {
  return db.prepare(`
    SELECT fecha, usd, ars FROM matba_history
    WHERE producto = ? AND fecha >= ?
    ORDER BY fecha ASC
  `).all(producto, desdeISO);
}

function contarMatba(producto) {
  if (producto) {
    return db.prepare(`SELECT COUNT(*) as count FROM matba_history WHERE producto = ?`).get(producto).count;
  }
  return db.prepare(`SELECT COUNT(*) as count FROM matba_history`).get().count;
}

function resumenMatba() {
  return db.prepare(`
    SELECT producto, COUNT(*) as ruedas, MIN(fecha) as desde, MAX(fecha) as hasta
    FROM matba_history GROUP BY producto ORDER BY producto
  `).all();
}

function contarDiasDeHistoria() {
  return db.prepare(`SELECT COUNT(DISTINCT fecha) as count FROM market_history`).get().count;
}

// --- MODO SOLO MERCADO -------------------------------------------------------
// Sin fila en group_settings el default es "prendido": un grupo que todavia no
// se configuro tiene que comportarse como siempre.
function isPhrasesEnabled(groupId) {
  const row = db.prepare(`SELECT phrases_enabled FROM group_settings WHERE group_id = ?`).get(groupId);
  if (!row) return true;
  return row.phrases_enabled !== 0;
}

function setPhrasesEnabled(groupId, enabled) {
  db.prepare(`INSERT OR IGNORE INTO group_settings (group_id) VALUES (?)`).run(groupId);
  const info = db.prepare(`UPDATE group_settings SET phrases_enabled = ? WHERE group_id = ?`)
    .run(enabled ? 1 : 0, groupId);
  return info.changes > 0;
}

// --- MERCADO DE GRANOS -------------------------------------------------------
// La prende quien quiera: un admin del grupo con /mbot mercado on, o el super
// admin desde su panel. No hay un permiso aparte que haya que dar antes.
function setMarketEnabled(groupId, enabled) {
  db.prepare(`INSERT OR IGNORE INTO group_settings (group_id) VALUES (?)`).run(groupId);
  const info = db.prepare(`UPDATE group_settings SET market_enabled = ? WHERE group_id = ?`)
    .run(enabled ? 1 : 0, groupId);
  return info.changes > 0;
}

function setMarketTime(groupId, time) {
  db.prepare(`INSERT OR IGNORE INTO group_settings (group_id) VALUES (?)`).run(groupId);
  db.prepare(`UPDATE group_settings SET market_time = ? WHERE group_id = ?`).run(time, groupId);
}

function isMarketEnabled(groupId) {
  const row = db.prepare(`SELECT market_enabled FROM group_settings WHERE group_id = ?`).get(groupId);
  return !!row?.market_enabled;
}

// Solo grupos vivos: uno dado de baja con el mercado prendido no debe recibir nada.
function getMarketGroups() {
  return db.prepare(`
    SELECT g.group_id, g.group_name, s.market_time, s.market_last_sent
    FROM groups g
    JOIN group_settings s ON s.group_id = g.group_id
    WHERE g.active = 1 AND s.market_enabled = 1
  `).all();
}

function markMarketSent(groupId, hoyISO) {
  db.prepare(`UPDATE group_settings SET market_last_sent = ? WHERE group_id = ?`).run(hoyISO, groupId);
}

module.exports = {
  addGroup,
  registrarChatPrivado,
  getCarryCostos,
  setCarryCostos,
  addAlerta,
  getAlertasDeChat,
  getTodasLasAlertas,
  countAlertasDeChat,
  deleteAlerta,
  deleteAlertas,
  MAX_ALERTAS_POR_CHAT,
  guardarPizarra,
  guardarMatba,
  getMatbaHistoria,
  contarMatba,
  resumenMatba,
  contarDiasDeHistoria,
  isPhrasesEnabled,
  setPhrasesEnabled,
  getAllGroups,
  reactivateGroup,
  deleteGroupCompleto,
  setMarketEnabled,
  setMarketTime,
  isMarketEnabled,
  getMarketGroups,
  markMarketSent,
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
  aplicarVotosDePoll,
};