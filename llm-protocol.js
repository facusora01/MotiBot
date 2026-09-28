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
  // Imágenes: el agente las manda en pedazos chicos para que el tope de cada
  // mensaje WebSocket siga en 16 KB (nadie puede mandar un mensaje gigante).
  promptImagen: 300,          // caracteres del pedido
  imagenParte: 12000,         // caracteres base64 por pedazo (múltiplo de 4)
  imagenPartes: 64,           // pedazos como máximo
  imagenBase64: 800 * 1024,   // caracteres base64 de la imagen entera (~600 KB)
};

// Versión del agente a partir de la cual recibe la memoria de la charla. Los
// agentes viejos no mandan versión (= 1) y aceptan como mucho 4 mensajes por
// job: a esos se les sigue mandando solo la pregunta.
const VERSION_MEMORIA = 2;

// Capacidades que un agente puede anunciar. "image" = genera imágenes.
const CAPACIDADES = ["chat", "image"];
const RE_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

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
// Tres tipos y ninguno más:
//   { type: "auth",  token, model, v?, caps? }  (v = versión, 1 si falta;
//                                                caps = ["chat"] si falta)
//   { type: "reply", id, text }   |   { type: "reply", id, error: true }
//   { type: "image_part", id, n, total, data }  (un pedazo de JPEG en base64)
function esVersion(v) {
  return Number.isInteger(v) && v >= 1 && v <= 100;
}

function esCaps(caps) {
  return Array.isArray(caps) && caps.length >= 1 && caps.length <= CAPACIDADES.length &&
    caps.every((c) => CAPACIDADES.includes(c)) && new Set(caps).size === caps.length;
}

function parsearMensajeAgente(raw) {
  if (typeof raw !== "string" || raw.length > LIMITES.payload) return null;

  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return null; }
  if (!esObjetoPlano(msg)) return null;

  if (msg.type === "auth") {
    if (!soloClaves(msg, ["type", "token", "model", "v", "caps"])) return null;
    if (typeof msg.token !== "string" || msg.token.length > LIMITES.token || !RE_TOKEN.test(msg.token)) return null;
    if (typeof msg.model !== "string" || !RE_MODELO.test(msg.model)) return null;
    if (msg.v !== undefined && !esVersion(msg.v)) return null;
    if (msg.caps !== undefined && !esCaps(msg.caps)) return null;
    return { type: "auth", token: msg.token, model: msg.model, v: msg.v ?? 1, caps: msg.caps ?? ["chat"] };
  }

  if (msg.type === "image_part") {
    if (!soloClaves(msg, ["type", "id", "n", "total", "data"])) return null;
    if (typeof msg.id !== "string" || !RE_JOB.test(msg.id)) return null;
    if (!Number.isInteger(msg.total) || msg.total < 1 || msg.total > LIMITES.imagenPartes) return null;
    if (!Number.isInteger(msg.n) || msg.n < 0 || msg.n >= msg.total) return null;
    if (typeof msg.data !== "string" || msg.data.length === 0 || msg.data.length > LIMITES.imagenParte) return null;
    if (msg.data.length % 4 !== 0 || !RE_BASE64.test(msg.data)) return null;
    return { type: "image_part", id: msg.id, n: msg.n, total: msg.total, data: msg.data };
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
      if (!soloClaves(msg, ["kind", "conn", "hash", "model", "v", "caps"])) return null;
      if (!esConn(msg.conn) || typeof msg.hash !== "string" || !RE_HASH.test(msg.hash)) return null;
      if (typeof msg.model !== "string" || !RE_MODELO.test(msg.model)) return null;
      if (!esVersion(msg.v) || !esCaps(msg.caps)) return null;
      return { kind: "auth", conn: msg.conn, hash: msg.hash, model: msg.model, v: msg.v, caps: msg.caps };
    case "image":
      if (!soloClaves(msg, ["kind", "conn", "job", "data"])) return null;
      if (!esConn(msg.conn) || typeof msg.job !== "string" || !RE_JOB.test(msg.job)) return null;
      if (typeof msg.data !== "string" || !msg.data.length || msg.data.length > LIMITES.imagenBase64) return null;
      if (msg.data.length % 4 !== 0 || !RE_BASE64.test(msg.data)) return null;
      return { kind: "image", conn: msg.conn, job: msg.job, data: msg.data };
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
    case "imageJob":
      if (!soloClaves(msg, ["kind", "conn", "job", "prompt"])) return null;
      if (!esConn(msg.conn) || typeof msg.job !== "string" || !RE_JOB.test(msg.job)) return null;
      if (typeof msg.prompt !== "string" || !msg.prompt || msg.prompt !== limpiarPromptImagen(msg.prompt)) return null;
      return { kind: "imageJob", conn: msg.conn, job: msg.job, prompt: msg.prompt };
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

// El pedido de una imagen. Sin "<" ni ">": el programa de imágenes acepta
// parámetros escondidos dentro del texto (<sd_cpp_extra_args>{...}</...>),
// con los que alguien podría pedir miles de pasos o tamaños gigantes. Sin
// esos signos no hay forma de escribirlos. Una sola línea y con tope.
function limpiarPromptImagen(texto) {
  return String(texto ?? "")
    .replace(RE_INVISIBLES, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITES.promptImagen)
    .trim();
}

// Los modelos chicos imitan el "Nombre: mensaje" de un chat y arrancan con
// "MotiBot:" (o un nombre inventado). Una sola palabra con dos puntos al
// principio de todo se saca.
const RE_NOMBRE_INICIAL = /^[*_]*[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]{0,19}[*_]*\s*:[*_]*\s+/;

// Los modelos escriben en Markdown; WhatsApp tiene su propio formato. Se
// traduce lo más común para que no queden asteriscos ni numerales sueltos:
//   **negrita** / __negrita__ -> *negrita*
//   ~~tachado~~               -> ~tachado~
//   # Título                  -> *Título*
function aWhatsApp(texto) {
  return texto
    .replace(/\*\*([^*\n]+?)\*\*/g, "*$1*")
    .replace(/__([^_\n]+?)__/g, "*$1*")
    .replace(/~~([^~\n]+?)~~/g, "~$1~")
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "*$1*");
}

// El mensaje final para el grupo. Nunca empieza con "/" ni con "@", diga lo
// que diga el LLM: el bot no lo puede leer como un comando. Siempre termina
// con la firma, que es lo que lo identifica como respuesta del LLM.
function formatearRespuesta(texto, modelo, dueno) {
  const cuerpo = aWhatsApp(limpiarRespuesta(texto))
    .replace(RE_NOMBRE_INICIAL, "")
    .replace(/^[\s/@]+/, "") || "…";
  const firma = limpiarRespuesta(`${modelo} · LLM de ${dueno || "alguien del grupo"}`).replace(/\n/g, " ");
  return `${cuerpo}\n\n_— ${firma}_`;
}

module.exports = {
  LIMITES,
  VERSION_MEMORIA,
  CAPACIDADES,
  limpiarPromptImagen,
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
