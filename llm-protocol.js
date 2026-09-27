// Protocolo entre MotiBot y los LLMs de la comunidad. La única regla que
// importa: por acá viaja TEXTO y nada más. No hay mensajes para archivos,
// comandos, URLs ni herramientas, y cualquier cosa que no encaje exacto en lo
// que está definido abajo se descarta (y el gateway corta la conexión).
//
// Lo usan el gateway (proceso encerrado que habla con los agentes) y el bot
// (que habla con el gateway por IPC). Sin dependencias fuera de crypto.
const crypto = require("crypto");

const LIMITES = {
  payload: 16 * 1024,  // bytes por mensaje WebSocket
  token: 128,
  respuesta: 1500,     // caracteres que llegan al grupo
  pregunta: 1000,      // caracteres que se le mandan al LLM
  mensajesPorJob: 24,       // sistema + memoria (10 idas y vueltas) + pregunta
  contenidoPorMensaje: 2000,
  contenidoPorJob: 12000,   // suma de todos los mensajes de un job
  codigoAgente: 200 * 1024,
};

// Versión del agente a partir de la cual recibe la memoria de la charla. Los
// agentes viejos no mandan versión (= 1) y aceptan como mucho 4 mensajes por
// job: a esos se les sigue mandando solo la pregunta.
const VERSION_MEMORIA = 2;

const PREFIJO_TOKEN = "mbk_";
const RE_TOKEN = /^mbk_[A-Za-z0-9_-]{43}$/;
const RE_MODELO = /^[A-Za-z0-9._:/-]{1,64}$/;
const RE_JOB = /^[a-f0-9]{16}$/;
const RE_HASH = /^[a-f0-9]{64}$/;
const ROLES = ["system", "user", "assistant"];

function generarToken() {
  return PREFIJO_TOKEN + crypto.randomBytes(32).toString("base64url");
}

// En la base solo queda el hash: si alguien se lleva la base, no se lleva
// tokens que sirvan.
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function nuevoIdJob() {
  return crypto.randomBytes(8).toString("hex");
}

function esObjetoPlano(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x) &&
    Object.getPrototypeOf(x) === Object.prototype;
}

function soloClaves(obj, permitidas) {
  return Object.keys(obj).every((k) => permitidas.includes(k));
}

function esConn(x) {
  return Number.isInteger(x) && x > 0 && x < 2 ** 31;
}

// ─── AGENTE → GATEWAY (WebSocket) ────────────────────────────────────────────
// Dos tipos y ninguno más:
//   { type: "auth",  token, model, v? }   (v = versión del agente, 1 si falta)
//   { type: "reply", id, text }   |   { type: "reply", id, error: true }
function esVersion(v) {
  return Number.isInteger(v) && v >= 1 && v <= 100;
}

function parsearMensajeAgente(raw) {
  if (typeof raw !== "string" || raw.length > LIMITES.payload) return null;

  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return null; }
  if (!esObjetoPlano(msg)) return null;

  if (msg.type === "auth") {
    if (!soloClaves(msg, ["type", "token", "model", "v"])) return null;
    if (typeof msg.token !== "string" || msg.token.length > LIMITES.token || !RE_TOKEN.test(msg.token)) return null;
    if (typeof msg.model !== "string" || !RE_MODELO.test(msg.model)) return null;
    if (msg.v !== undefined && !esVersion(msg.v)) return null;
    return { type: "auth", token: msg.token, model: msg.model, v: msg.v ?? 1 };
  }

  if (msg.type === "reply") {
    if (!soloClaves(msg, ["type", "id", "text", "error"])) return null;
    if (typeof msg.id !== "string" || !RE_JOB.test(msg.id)) return null;
    if (msg.error === true && msg.text === undefined) return { type: "reply", id: msg.id, error: true };
    if (msg.error !== undefined || typeof msg.text !== "string") return null;
    return { type: "reply", id: msg.id, text: msg.text };
  }

  return null;
}

// Mensajes de un job: la conversación que se le pasa al LLM. Solo roles de
// chat y texto plano.
function validarMensajesJob(mensajes) {
  if (!Array.isArray(mensajes) || mensajes.length === 0 || mensajes.length > LIMITES.mensajesPorJob) return false;
  const ok = mensajes.every((m) =>
    esObjetoPlano(m) && soloClaves(m, ["role", "content"]) &&
    ROLES.includes(m.role) &&
    typeof m.content === "string" && m.content.length <= LIMITES.contenidoPorMensaje
  );
  return ok && mensajes.reduce((total, m) => total + m.content.length, 0) <= LIMITES.contenidoPorJob;
}

// ─── GATEWAY ↔ BOT (IPC) ─────────────────────────────────────────────────────
// El bot tampoco le cree al gateway: si alguna vez lo comprometieran, lo único
// que podría mandar son estos mensajes, y todos terminan en texto.
function parsearIpcDelGateway(msg) {
  if (!esObjetoPlano(msg)) return null;

  switch (msg.kind) {
    case "listening":
      if (!soloClaves(msg, ["kind", "port"]) || !Number.isInteger(msg.port)) return null;
      return { kind: "listening", port: msg.port };
    case "auth":
      if (!soloClaves(msg, ["kind", "conn", "hash", "model", "v"])) return null;
      if (!esConn(msg.conn) || typeof msg.hash !== "string" || !RE_HASH.test(msg.hash)) return null;
      if (typeof msg.model !== "string" || !RE_MODELO.test(msg.model)) return null;
      if (!esVersion(msg.v)) return null;
      return { kind: "auth", conn: msg.conn, hash: msg.hash, model: msg.model, v: msg.v };
    case "closed":
      if (!soloClaves(msg, ["kind", "conn"]) || !esConn(msg.conn)) return null;
      return { kind: "closed", conn: msg.conn };
    case "reply":
      if (!soloClaves(msg, ["kind", "conn", "job", "text", "error"])) return null;
      if (!esConn(msg.conn) || typeof msg.job !== "string" || !RE_JOB.test(msg.job)) return null;
      if (msg.error === true && msg.text === undefined) return { kind: "reply", conn: msg.conn, job: msg.job, error: true };
      if (msg.error !== undefined || typeof msg.text !== "string" || msg.text.length > LIMITES.payload) return null;
      return { kind: "reply", conn: msg.conn, job: msg.job, text: msg.text };
    default:
      return null;
  }
}

function parsearIpcDelBot(msg) {
  if (!esObjetoPlano(msg)) return null;

  switch (msg.kind) {
    case "config":
      if (!soloClaves(msg, ["kind", "agentSource"])) return null;
      if (typeof msg.agentSource !== "string" || msg.agentSource.length > LIMITES.codigoAgente) return null;
      return { kind: "config", agentSource: msg.agentSource };
    case "authResult":
      if (!soloClaves(msg, ["kind", "conn", "ok"]) || !esConn(msg.conn) || typeof msg.ok !== "boolean") return null;
      return { kind: "authResult", conn: msg.conn, ok: msg.ok };
    case "job":
      if (!soloClaves(msg, ["kind", "conn", "job", "messages"])) return null;
      if (!esConn(msg.conn) || typeof msg.job !== "string" || !RE_JOB.test(msg.job)) return null;
      if (!validarMensajesJob(msg.messages)) return null;
      return { kind: "job", conn: msg.conn, job: msg.job, messages: msg.messages };
    case "kick":
      if (!soloClaves(msg, ["kind", "conn"]) || !esConn(msg.conn)) return null;
      return { kind: "kick", conn: msg.conn };
    default:
      return null;
  }
}

// ─── TEXTO QUE LLEGA AL GRUPO ────────────────────────────────────────────────
// Caracteres de control y de dirección (U+202A..U+202E, U+2066..U+2069) se van:
// los segundos sirven para disfrazar texto ("gnp.exe" que se lee "exe.png").
const RE_INVISIBLES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

function limpiarRespuesta(texto) {
  let t = String(texto ?? "").replace(/\r\n?/g, "\n").replace(RE_INVISIBLES, "");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > LIMITES.respuesta) t = t.slice(0, LIMITES.respuesta).trimEnd() + "…";
  return t;
}

// Los modelos chicos imitan el "Nombre: mensaje" de un chat y arrancan con
// "MotiBot:" (o un nombre inventado). Una sola palabra con dos puntos al
// principio de todo se saca.
const RE_NOMBRE_INICIAL = /^[*_]*[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]{0,19}[*_]*\s*:[*_]*\s+/;

// El mensaje final para el grupo. Nunca empieza con "/" ni con "@", diga lo
// que diga el LLM: el bot no lo puede leer como un comando. Siempre termina
// con la firma, que es lo que lo identifica como respuesta del LLM.
function formatearRespuesta(texto, modelo, dueno) {
  const cuerpo = limpiarRespuesta(texto)
    .replace(RE_NOMBRE_INICIAL, "")
    .replace(/^[\s/@]+/, "") || "…";
  const firma = limpiarRespuesta(`${modelo} · LLM de ${dueno || "alguien del grupo"}`).replace(/\n/g, " ");
  return `${cuerpo}\n\n_— ${firma}_`;
}

module.exports = {
  LIMITES,
  VERSION_MEMORIA,
  generarToken,
  hashToken,
  nuevoIdJob,
  parsearMensajeAgente,
  validarMensajesJob,
  parsearIpcDelGateway,
  parsearIpcDelBot,
  limpiarRespuesta,
  formatearRespuesta,
};
