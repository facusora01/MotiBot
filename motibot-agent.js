#!/usr/bin/env node
// Agente de MotiBot: conecta el Ollama de tu PC con MotiBot para que el bot
// pueda contestar en tus grupos con tu LLM.
//
//   node --permission motibot-agent.js --model llama3.1 --token mbk_...
//
// Qué hace y qué no:
//   - Abre UNA conexión saliente y cifrada (wss) a MotiBot. Tu PC no abre
//     ningún puerto.
//   - Lo único que hace con lo que recibe es pasárselo como chat a tu Ollama
//     local (POST /api/chat) y devolver el texto de la respuesta.
//   - No le ofrece herramientas (tools) al modelo y no ejecuta nada de lo que
//     el modelo conteste: lo que vuelve es texto y se manda como texto.
//   - Corre encerrado con --permission: Node le bloquea leer y escribir
//     archivos, lanzar programas, crear workers y cargar addons. Sin ese
//     encierro se niega a arrancar. Así, aunque este archivo estuviera
//     adulterado o MotiBot comprometido, desde acá no se puede tocar tu PC.
//   - Tiene un tope de preguntas por minuto, para que nadie te tenga la PC al
//     100% todo el día.
//
// Opciones:
//   --token         Token que te dio MotiBot (o variable de entorno MOTIBOT_TOKEN)
//   --model         Modelo de Ollama a usar (ej: llama3.1, qwen2.5:7b)
//   --server        URL del gateway (por defecto, la que viene abajo)
//   --ollama        URL de Ollama (por defecto http://127.0.0.1:11434; solo local)
//   --por-minuto    Máximo de preguntas por minuto (1 a 60, por defecto 10)
//
// Necesita Node 22 o más nuevo (trae WebSocket y fetch de fábrica). En Node
// 22 anterior a 22.13 el flag se llama --experimental-permission.

// ─── ENCIERRO ────────────────────────────────────────────────────────────────
// Lo primero de todo: sin sandbox no se hace nada.
function tienePermiso(scope) {
  try { return process.permission.has(scope); } catch (e) { return true; }
}
if (!process.permission || ["child", "worker", "fs.read", "fs.write"].some(tienePermiso)) {
  console.error(
    "❌ Por tu seguridad, el agente solo corre encerrado. Lanzalo así:\n\n" +
    "   node --permission motibot-agent.js --model <modelo> --token <token>\n\n" +
    "   (sin --allow-fs-read, --allow-fs-write, --allow-child-process ni --allow-worker)"
  );
  process.exit(1);
}

const SERVIDOR_POR_DEFECTO = "__MOTIBOT_SERVER__";

// Versión del agente. La 2 recibe la memoria de la charla (varias idas y
// vueltas por pregunta).
const VERSION = 2;

const LIMITES = {
  mensajesPorJob: 24,
  contenidoPorMensaje: 2000,
  contenidoPorJob: 12000,
  respuesta: 2000,
  entrante: 48 * 1024,
};
const TIMEOUT_OLLAMA = 110 * 1000;
// Ventana de contexto que se le pide a Ollama: entra la memoria completa y en
// una placa de 8 GB sigue cabiendo junto con un modelo de 8B.
const CONTEXTO = 8192;
const ROLES = ["system", "user", "assistant"];

function leerArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(token|model|server|ollama|por-minuto)$/);
    if (m && argv[i + 1] !== undefined) args[m[1]] = argv[++i];
  }
  return args;
}

function salir(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const args = leerArgs(process.argv.slice(2));
const token = args.token || process.env.MOTIBOT_TOKEN || "";
const modelo = args.model || "";
const servidor = args.server || (SERVIDOR_POR_DEFECTO.startsWith("wss://") ? SERVIDOR_POR_DEFECTO : "");
const ollama = (args.ollama || "http://127.0.0.1:11434").replace(/\/+$/, "");
const porMinuto = args["por-minuto"] === undefined ? 10 : Number(args["por-minuto"]);
if (!Number.isInteger(porMinuto) || porMinuto < 1 || porMinuto > 60) salir("--por-minuto tiene que ser un número del 1 al 60.");

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  salir(`Tu Node (${process.version}) es viejo: necesitás Node 22 o más nuevo.`);
}
if (!/^mbk_[A-Za-z0-9_-]{43}$/.test(token)) salir("Falta el token (--token mbk_...). Lo pedís con /mbot llm add por privado.");
if (!/^[A-Za-z0-9._:/-]{1,64}$/.test(modelo)) salir("Falta el modelo (--model llama3.1).");
// Sin cifrar solo contra la misma PC (pruebas locales).
const RE_SERVIDOR = /^(wss:\/\/[^\s/]+(\/[A-Za-z0-9._-]+)*|ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?)\/agent$/;
if (!RE_SERVIDOR.test(servidor)) salir("La URL del servidor tiene que ser wss://.../agent (conexión cifrada).");

// Ollama tiene que ser local: el agente no le manda tus chats a otra máquina.
let hostOllama;
try { hostOllama = new URL(ollama).hostname; } catch (e) { salir("La URL de Ollama no es válida."); }
if (!["127.0.0.1", "localhost", "[::1]"].includes(hostOllama)) salir("Ollama tiene que correr en esta PC (127.0.0.1).");

// ─── OLLAMA ──────────────────────────────────────────────────────────────────
// Los modelos que "piensan" antes de contestar (qwen3, deepseek-r1...) se
// gastarían el límite de tokens razonando y la respuesta llegaría vacía o
// tarde: se les apaga. Los que no piensan rechazan la opción; entonces se
// pide sin ella y se recuerda para las próximas.
let modeloSinThink = false;

function llamarChat(mensajes, apagarThink) {
  const cuerpo = {
    model: modelo,
    messages: mensajes,
    stream: false,
    options: { num_predict: 512, num_ctx: CONTEXTO },
  };
  if (apagarThink) cuerpo.think = false;
  // Sin "tools": el modelo solo puede contestar texto.
  return fetch(`${ollama}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TIMEOUT_OLLAMA),
  });
}

async function preguntarAOllama(mensajes) {
  let res = await llamarChat(mensajes, !modeloSinThink);
  if (!res.ok && !modeloSinThink && res.status === 400) {
    const detalle = await res.text().catch(() => "");
    if (!/think/i.test(detalle)) throw new Error("Ollama respondió 400");
    modeloSinThink = true;
    res = await llamarChat(mensajes, false);
  }
  if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
  const data = await res.json();
  const texto = data?.message?.content;
  if (typeof texto !== "string") throw new Error("Ollama no devolvió texto");
  // Por si el razonamiento igual viene pegado en el texto.
  return texto.replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, LIMITES.respuesta);
}

async function chequearOllama() {
  try {
    const res = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const nombres = (data?.models || []).map((m) => m.name);
    const existe = nombres.some((n) => n === modelo || n === `${modelo}:latest`);
    if (!existe) console.warn(`⚠️ No encontré el modelo "${modelo}" en Ollama. Bajalo con: ollama pull ${modelo}`);
    else console.log(`✅ Ollama listo con ${modelo}.`);
  } catch (e) {
    console.warn(`⚠️ No pude hablar con Ollama en ${ollama}. ¿Está corriendo? (${e.message})`);
  }
}

// ─── VALIDACIÓN DE LO QUE LLEGA ──────────────────────────────────────────────
// Tampoco le creemos al servidor: solo aceptamos "ready" y "job" con chat.
function esObjetoPlano(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function parsearDelServidor(raw) {
  if (typeof raw !== "string" || raw.length > LIMITES.entrante) return null;
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return null; }
  if (!esObjetoPlano(msg)) return null;

  if (msg.type === "ready" && Object.keys(msg).length === 1) return msg;

  if (msg.type === "job") {
    if (Object.keys(msg).some((k) => !["type", "id", "messages"].includes(k))) return null;
    if (typeof msg.id !== "string" || !/^[a-f0-9]{16}$/.test(msg.id)) return null;
    const ok = Array.isArray(msg.messages) && msg.messages.length > 0 && msg.messages.length <= LIMITES.mensajesPorJob &&
      msg.messages.every((m) => esObjetoPlano(m) && Object.keys(m).length === 2 &&
        ROLES.includes(m.role) && typeof m.content === "string" && m.content.length <= LIMITES.contenidoPorMensaje) &&
      msg.messages.reduce((total, m) => total + m.content.length, 0) <= LIMITES.contenidoPorJob;
    if (!ok) return null;
    return { type: "job", id: msg.id, messages: msg.messages.map((m) => ({ role: m.role, content: m.content })) };
  }
  return null;
}

// ─── CONEXIÓN ────────────────────────────────────────────────────────────────
const CIERRE_TOKEN = 4401;
const CIERRE_REEMPLAZADO = 4403;
let espera = 2000;
let ocupado = false;
let recientes = []; // timestamps de las preguntas del último minuto

function dentroDelTope() {
  const ahora = Date.now();
  recientes = recientes.filter((t) => ahora - t < 60 * 1000);
  if (recientes.length >= porMinuto) return false;
  recientes.push(ahora);
  return true;
}

function conectar() {
  const ws = new WebSocket(servidor);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", token, model: modelo, v: VERSION }));
  });

  ws.addEventListener("message", async (evento) => {
    if (typeof evento.data !== "string") return;
    const msg = parsearDelServidor(evento.data);
    if (!msg) return console.warn("⚠️ Llegó un mensaje que no entiendo, lo ignoro.");

    if (msg.type === "ready") {
      espera = 2000;
      console.log(`🟢 Conectado a MotiBot. Tu LLM (${modelo}) ya está disponible para /mbot live.`);
      return;
    }

    // Un job a la vez: el servidor ya lo respeta, esto es por las dudas.
    if (ocupado) return ws.send(JSON.stringify({ type: "reply", id: msg.id, error: true }));
    if (!dentroDelTope()) {
      console.warn(`⏳ Llegué al tope de ${porMinuto} preguntas por minuto: rechazo esta.`);
      return ws.send(JSON.stringify({ type: "reply", id: msg.id, error: true }));
    }
    ocupado = true;
    const inicio = Date.now();
    try {
      const texto = await preguntarAOllama(msg.messages);
      ws.send(JSON.stringify({ type: "reply", id: msg.id, text: texto }));
      console.log(`💬 Respondí una pregunta en ${((Date.now() - inicio) / 1000).toFixed(1)}s.`);
    } catch (e) {
      console.warn(`⚠️ No pude responder: ${e.message}`);
      try { ws.send(JSON.stringify({ type: "reply", id: msg.id, error: true })); } catch (e2) { /* se cortó */ }
    } finally {
      ocupado = false;
    }
  });

  ws.addEventListener("close", (evento) => {
    // Sin process.exit acá adentro: sin reintentos pendientes, el proceso
    // termina solo cuando se cierra la conexión.
    const fin = {
      [CIERRE_TOKEN]: "MotiBot rechazó el token. Pedí uno nuevo con /mbot llm add.",
      [CIERRE_REEMPLAZADO]: "Esta sesión se cerró: el LLM se dio de baja o se conectó desde otra PC.",
    }[evento.code];
    if (fin) {
      console.error(`❌ ${fin}`);
      process.exitCode = 1;
      return;
    }

    console.warn(`🔌 Desconectado (${evento.code}). Reintento en ${espera / 1000}s...`);
    setTimeout(conectar, espera);
    espera = Math.min(espera * 2, 60 * 1000);
  });

  ws.addEventListener("error", () => { /* el close llega igual */ });
}

console.log(`🧠 MotiBot agent → ${servidor}`);
chequearOllama().then(conectar);
