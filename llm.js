// Lado del bot de los LLMs de la comunidad: lanza el gateway encerrado, decide
// qué agentes entran (contra la base) y le pasa preguntas y respuestas.
//
// El gateway es el único que toca la red de afuera. Este módulo solo lo lanza
// (un fork de un archivo fijo, con argumentos fijos: nada de lo que llega de
// un agente se usa para armar un comando) y habla con él por IPC.
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const db = require("./database");
const P = require("./llm-protocol");

const GATEWAY_PATH = path.join(__dirname, "llm-gateway.js");
const PROTOCOLO_PATH = path.join(__dirname, "llm-protocol.js");
const AGENTE_PATH = path.join(__dirname, "motibot-agent.js");
const WS_DIR = path.dirname(require.resolve("ws/package.json"));

const LLM_PORT = Number(process.env.LLM_PORT) || 3002;
const TIMEOUT_JOB = 120 * 1000;

// URL pública del gateway (la de Tailscale Funnel). Puede llevar una ruta
// (https://maquina.tailnet.ts.net/motibot-llm) cuando el 443 lo comparte con
// otros servicios. Sin ella la función queda apagada: el bot anda igual, y
// /mbot live contesta que no hay LLMs.
function urlPublica() {
  const url = String(process.env.LLM_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+(\/[A-Za-z0-9._-]+)*$/.test(url) ? url : null;
}

// La ruta de la URL pública ("/motibot-llm" o ""), para que el gateway la
// reconozca si Funnel se la pasa sin recortar.
function prefijoRuta() {
  const url = urlPublica();
  return url ? new URL(url).pathname.replace(/\/+$/, "") : "";
}

function urlWebSocket() {
  const url = urlPublica();
  return url ? url.replace(/^https:/, "wss:") + "/agent" : null;
}

let gateway = null;
let reintentos = 0;
let apagado = false;

const conexiones = new Map(); // conn -> { llmId, model, version, jobActual }
const porLlm = new Map();     // llmId -> conn
const jobs = new Map();       // jobId -> { conn, resolve, reject, timer }

// El flag cambió de nombre: experimental en Node 20-22, estable después.
function flagDePermisos() {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has("--permission")) return "--permission";
  if (flags.has("--experimental-permission")) return "--experimental-permission";
  return null;
}

function olvidarConexion(conn) {
  const c = conexiones.get(conn);
  if (!c) return;
  conexiones.delete(conn);
  if (porLlm.get(c.llmId) === conn) porLlm.delete(c.llmId);

  for (const [jobId, j] of jobs) {
    if (j.conn === conn) {
      clearTimeout(j.timer);
      jobs.delete(jobId);
      j.reject(new Error("desconectado"));
    }
  }
}

function enviarAlGateway(msg) {
  if (!gateway || !gateway.connected) return false;
  try { gateway.send(msg); return true; } catch (e) { return false; }
}

// Los tokens rechazados se loguean como mucho una vez por minuto, con la
// cuenta: un ataque no llena los logs de PM2.
let rechazosSinLoguear = 0;
let ultimoLogRechazo = 0;

function manejarAuth({ conn, hash, model, v }) {
  const agente = db.getLlmAgentPorHash(hash);
  if (!agente) {
    rechazosSinLoguear++;
    if (Date.now() - ultimoLogRechazo > 60 * 1000) {
      console.warn(`🔐 [llm] ${rechazosSinLoguear} intento(s) de conexión con token desconocido.`);
      rechazosSinLoguear = 0;
      ultimoLogRechazo = Date.now();
    }
    return enviarAlGateway({ kind: "authResult", conn, ok: false });
  }

  // Un token = una PC. Si el mismo LLM se vuelve a conectar, cae la sesión vieja.
  const anterior = porLlm.get(agente.id);
  if (anterior && anterior !== conn) {
    enviarAlGateway({ kind: "kick", conn: anterior });
    olvidarConexion(anterior);
  }

  conexiones.set(conn, { llmId: agente.id, model, version: v, jobActual: null });
  porLlm.set(agente.id, conn);
  enviarAlGateway({ kind: "authResult", conn, ok: true });
  console.log(`🧠 [llm] Conectado el LLM de ${agente.owner_name || agente.owner_phone} (${model}, agente v${v}).`);
}

function manejarReply({ conn, job, text, error }) {
  const j = jobs.get(job);
  // Una respuesta a un job que no es de esa conexión no se acepta.
  if (!j || j.conn !== conn) return;

  clearTimeout(j.timer);
  jobs.delete(job);
  const c = conexiones.get(conn);
  if (c && c.jobActual === job) c.jobActual = null;

  if (error) return j.reject(new Error("el agente no pudo responder"));
  j.resolve(P.limpiarRespuesta(text));
}

function iniciarGateway() {
  if (apagado || gateway) return;

  if (!urlPublica()) {
    console.log("🧠 [llm] LLM_PUBLIC_URL vacío o inválido: los LLMs de la comunidad quedan apagados.");
    return;
  }

  const flag = flagDePermisos();
  if (!flag) {
    console.error("🛑 [llm] Este Node no tiene modelo de permisos (hace falta Node 20 o más nuevo). " +
      "No levanto el gateway sin sandbox.");
    return;
  }

  let codigoAgente = "";
  try {
    // El que se lo baja ya trae la URL del servidor puesta: un flag menos.
    codigoAgente = fs.readFileSync(AGENTE_PATH, "utf8")
      .replace('"__MOTIBOT_SERVER__"', JSON.stringify(urlWebSocket()));
  } catch (e) {
    console.warn("⚠️ [llm] No encontré motibot-agent.js para servirlo:", e.message);
  }

  gateway = fork(GATEWAY_PATH, [], {
    execArgv: [
      flag,
      `--allow-fs-read=${GATEWAY_PATH}`,
      `--allow-fs-read=${PROTOCOLO_PATH}`,
      `--allow-fs-read=${WS_DIR}`,
      "--max-old-space-size=64",
    ],
    // Env mínimo a propósito: el gateway no ve SMTP_PASS, PAIR_TOKEN ni nada
    // del .env.
    env: {
      LLM_PORT: String(LLM_PORT),
      LLM_PREFIJO: prefijoRuta(),
      WS_NO_BUFFER_UTIL: "1",
      WS_NO_UTF_8_VALIDATE: "1",
    },
  });

  gateway.on("message", (raw) => {
    const msg = P.parsearIpcDelGateway(raw);
    if (!msg) return console.warn("⚠️ [llm] Mensaje inválido del gateway, lo ignoro.");

    if (msg.kind === "listening") {
      reintentos = 0;
      console.log(`🧠 [llm] Gateway encerrado escuchando en 127.0.0.1:${msg.port} → ${urlWebSocket()}`);
      if (codigoAgente) enviarAlGateway({ kind: "config", agentSource: codigoAgente });
    } else if (msg.kind === "auth") {
      manejarAuth(msg);
    } else if (msg.kind === "closed") {
      const c = conexiones.get(msg.conn);
      if (c) console.log(`🧠 [llm] Se desconectó el LLM #${c.llmId}.`);
      olvidarConexion(msg.conn);
    } else if (msg.kind === "reply") {
      manejarReply(msg);
    }
  });

  gateway.on("exit", (code) => {
    gateway = null;
    for (const conn of [...conexiones.keys()]) olvidarConexion(conn);

    if (apagado) return;
    if (code === 78) {
      console.error("🛑 [llm] El gateway se negó a arrancar sin sandbox. Queda apagado.");
      return;
    }
    const espera = Math.min(5000 * 2 ** reintentos, 5 * 60 * 1000);
    reintentos++;
    console.error(`⚠️ [llm] El gateway terminó (código ${code}). Lo relanzo en ${espera / 1000}s.`);
    setTimeout(iniciarGateway, espera).unref();
  });
}

function detenerGateway() {
  apagado = true;
  if (gateway) try { gateway.kill(); } catch (e) { /* nada */ }
}

// ─── CONSULTAS ───────────────────────────────────────────────────────────────
function habilitado() {
  return Boolean(urlPublica());
}

// LLMs conectados ahora mismo, con los datos de su dueño.
function conectados() {
  const lista = [];
  for (const [llmId, conn] of porLlm) {
    const agente = db.getLlmAgent(llmId);
    const c = conexiones.get(conn);
    if (agente && c) lista.push({ ...agente, model: c.model, version: c.version });
  }
  return lista;
}

function infoConectado(llmId) {
  const conn = porLlm.get(llmId);
  const c = conn && conexiones.get(conn);
  if (!c) return null;
  const agente = db.getLlmAgent(llmId);
  return agente ? { ...agente, model: c.model, version: c.version } : null;
}

function ocupado(llmId) {
  const c = conexiones.get(porLlm.get(llmId));
  return Boolean(c?.jobActual);
}

// Manda una conversación al LLM y devuelve su respuesta ya limpia. Un job por
// LLM a la vez: una PC de escritorio no da para más, y así nadie la satura.
function preguntar(llmId, mensajes) {
  return new Promise((resolve, reject) => {
    const conn = porLlm.get(llmId);
    const c = conn && conexiones.get(conn);
    if (!c) return reject(new Error("desconectado"));
    if (c.jobActual) return reject(new Error("ocupado"));
    if (!P.validarMensajesJob(mensajes)) return reject(new Error("mensajes inválidos"));

    const job = P.nuevoIdJob();
    const timer = setTimeout(() => {
      jobs.delete(job);
      if (c.jobActual === job) c.jobActual = null;
      reject(new Error("timeout"));
    }, TIMEOUT_JOB);

    jobs.set(job, { conn, resolve, reject, timer });
    c.jobActual = job;

    if (!enviarAlGateway({ kind: "job", conn, job, messages: mensajes })) {
      clearTimeout(timer);
      jobs.delete(job);
      c.jobActual = null;
      reject(new Error("desconectado"));
    }
  });
}

// Corta la sesión de un LLM (cuando su dueño lo da de baja o rota el token).
function expulsar(llmId) {
  const conn = porLlm.get(llmId);
  if (!conn) return;
  enviarAlGateway({ kind: "kick", conn });
  olvidarConexion(conn);
}

module.exports = {
  iniciarGateway,
  detenerGateway,
  habilitado,
  urlPublica,
  urlWebSocket,
  conectados,
  infoConectado,
  ocupado,
  preguntar,
  expulsar,
};
