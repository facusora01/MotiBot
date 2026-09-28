// Gateway de LLMs: el ÚNICO proceso que habla con las PCs de la comunidad.
//
// Corre aparte del bot, lanzado por llm.js con el modelo de permisos de Node
// (--permission): no puede lanzar procesos, ni crear workers, ni cargar
// addons nativos, ni escribir archivos, y solo lee su propio código. Tampoco
// recibe las variables del .env. Aunque alguien encontrara un bug en el
// parseo, desde acá no hay nada que ejecutar.
//
// Lo que hace: recibe agentes por WebSocket, le pasa el hash del token al bot
// para que decida si entra, y reenvía texto en las dos direcciones. Nada más.

// ─── AUTOCHEQUEO DEL ENCIERRO ────────────────────────────────────────────────
// Si por lo que sea arrancó sin sandbox, no atiende a nadie. 78 = "config
// inválida": llm.js no lo reintenta.
function tienePermiso(scope) {
  try { return process.permission.has(scope); } catch (e) { return true; }
}
if (!process.permission || ["child", "worker", "fs.write"].some(tienePermiso)) {
  console.error("🛑 [llm-gateway] Arranqué sin el sandbox de permisos. No atiendo conexiones.");
  process.exit(78);
}
if (typeof process.send !== "function") {
  console.error("🛑 [llm-gateway] Me tiene que lanzar llm.js (necesito el canal IPC).");
  process.exit(78);
}

const http = require("http");
const { WebSocketServer } = require("ws");
const P = require("./llm-protocol");

const PORT = Number(process.env.LLM_PORT) || 3002;
// Ruta de la URL pública ("/motibot-llm") cuando el 443 se comparte con otros
// servicios. Según cómo esté armado Funnel, la ruta llega con o sin ella:
// se aceptan las dos.
const PREFIJO = /^(\/[A-Za-z0-9._-]+)*$/.test(process.env.LLM_PREFIJO || "") ? (process.env.LLM_PREFIJO || "") : "";

function esRuta(url, destino) {
  const ruta = String(url || "").split("?")[0];
  return ruta === destino || (PREFIJO !== "" && ruta === PREFIJO + destino);
}
const MAX_CONEXIONES = 50;
const AUTH_TIMEOUT = 5000;     // tiempo para mandar el token después de conectar
const PING_INTERVALO = 30000;  // un agente que no contesta el ping se corta
const MAX_JOBS_POR_AGENTE = 2;
// Tope global de intentos de autenticación: un token no se puede adivinar,
// pero así nadie satura al bot (ni sus logs) probando.
const MAX_AUTH_POR_MINUTO = 30;
let ventanaAuth = { inicio: Date.now(), cuenta: 0 };

function authPermitido() {
  const ahora = Date.now();
  if (ahora - ventanaAuth.inicio > 60 * 1000) ventanaAuth = { inicio: ahora, cuenta: 0 };
  return ++ventanaAuth.cuenta <= MAX_AUTH_POR_MINUTO;
}

// Códigos de cierre (4000-4999 son de la aplicación).
const CIERRE = {
  invalido: 4400,
  token: 4401,
  reemplazado: 4403,
  lleno: 4429,
};

let codigoAgente = "";
let siguienteConn = 1;
const conexiones = new Map(); // conn -> { ws, estado, jobs, vivo, timer }

function aviso(msg) {
  try { process.send(msg); } catch (e) { /* el bot se fue: nos vamos con el disconnect */ }
}

function cerrar(conn, codigo, motivo) {
  const c = conexiones.get(conn);
  if (!c) return;
  try { c.ws.close(codigo, motivo); } catch (e) { /* nada */ }
  // Si no cierra prolijo en 2s, se corta igual.
  setTimeout(() => { try { c.ws.terminate(); } catch (e) { /* nada */ } }, 2000).unref();
}

// ─── HTTP: solo el script del agente, para que se lo puedan bajar ────────────
const server = http.createServer((req, res) => {
  if (req.method === "GET" && esRuta(req.url, "/motibot-agent.js") && codigoAgente) {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    return res.end(codigoAgente);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});
server.headersTimeout = 10000;
server.requestTimeout = 10000;

// perMessageDeflate apagado: nada de descomprimir lo que manda un extraño.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: P.LIMITES.payload,
  perMessageDeflate: false,
});

// Solo se acepta el upgrade en la ruta del agente; cualquier otro se corta.
server.on("upgrade", (req, socket, head) => {
  if (!esRuta(req.url, "/agent")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  if (conexiones.size >= MAX_CONEXIONES) {
    ws.close(CIERRE.lleno, "servidor lleno");
    return;
  }

  const conn = siguienteConn++;
  // jobs: id -> "chat" | "image". partes: id -> pedazos de la imagen en curso.
  const c = { ws, estado: "nuevo", jobs: new Map(), partes: new Map(), vivo: true, timer: null };
  conexiones.set(conn, c);

  c.timer = setTimeout(() => {
    if (c.estado !== "ok") cerrar(conn, CIERRE.token, "sin autenticar");
  }, AUTH_TIMEOUT);

  ws.on("pong", () => { c.vivo = true; });

  ws.on("message", (data, esBinario) => {
    if (esBinario) return cerrar(conn, CIERRE.invalido, "mensaje inválido");

    const msg = P.parsearMensajeAgente(data.toString("utf8"));
    if (!msg) return cerrar(conn, CIERRE.invalido, "mensaje inválido");

    if (c.estado === "nuevo" && msg.type === "auth") {
      if (!authPermitido()) return cerrar(conn, CIERRE.lleno, "demasiados intentos");
      c.estado = "validando";
      // El token no sale de acá: al bot le llega solo su hash.
      return aviso({ kind: "auth", conn, hash: P.hashToken(msg.token), model: msg.model, v: msg.v, caps: msg.caps });
    }

    const tipo = c.estado === "ok" ? c.jobs.get(msg.id) : undefined;

    // Un error vale para cualquier job; un texto, solo para un job de chat.
    if (tipo && msg.type === "reply" && (msg.error || tipo === "chat")) {
      c.jobs.delete(msg.id);
      c.partes.delete(msg.id);
      return aviso(msg.error
        ? { kind: "reply", conn, job: msg.id, error: true }
        : { kind: "reply", conn, job: msg.id, text: msg.text });
    }

    // Los pedazos de una imagen: solo para un job de imagen que pedimos, en
    // orden (0, 1, 2...) y con el mismo total en todos.
    if (tipo === "image" && msg.type === "image_part") {
      const armado = c.partes.get(msg.id) || { total: msg.total, piezas: [], largo: 0 };
      if (msg.total !== armado.total || msg.n !== armado.piezas.length) {
        return cerrar(conn, CIERRE.invalido, "imagen fuera de orden");
      }
      armado.piezas.push(msg.data);
      armado.largo += msg.data.length;
      if (armado.largo > P.LIMITES.imagenBase64) return cerrar(conn, CIERRE.invalido, "imagen demasiado grande");
      c.partes.set(msg.id, armado);

      if (armado.piezas.length === armado.total) {
        c.jobs.delete(msg.id);
        c.partes.delete(msg.id);
        aviso({ kind: "image", conn, job: msg.id, data: armado.piezas.join("") });
      }
      return;
    }

    // Cualquier otra combinación (auth repetido, reply a un job que no
    // pedimos, mensajes antes de autenticar) es un agente que no sigue el
    // protocolo.
    cerrar(conn, CIERRE.invalido, "mensaje fuera de protocolo");
  });

  ws.on("close", () => {
    clearTimeout(c.timer);
    conexiones.delete(conn);
    if (c.estado !== "nuevo") aviso({ kind: "closed", conn });
  });

  ws.on("error", () => { /* el close llega igual */ });
});

setInterval(() => {
  for (const [conn, c] of conexiones) {
    if (!c.vivo) { try { c.ws.terminate(); } catch (e) { /* nada */ } continue; }
    c.vivo = false;
    try { c.ws.ping(); } catch (e) { cerrar(conn, CIERRE.invalido, "ping falló"); }
  }
}, PING_INTERVALO).unref();

// ─── ÓRDENES DEL BOT ─────────────────────────────────────────────────────────
process.on("message", (raw) => {
  const msg = P.parsearIpcDelBot(raw);
  if (!msg) return;

  if (msg.kind === "config") {
    codigoAgente = msg.agentSource;
    return;
  }

  const c = conexiones.get(msg.conn);
  if (!c) return;

  if (msg.kind === "authResult") {
    if (c.estado !== "validando") return;
    if (!msg.ok) return cerrar(msg.conn, CIERRE.token, "token inválido");
    c.estado = "ok";
    clearTimeout(c.timer);
    try { c.ws.send(JSON.stringify({ type: "ready" })); } catch (e) { /* nada */ }
    return;
  }

  if (msg.kind === "job" || msg.kind === "imageJob") {
    if (c.estado !== "ok" || c.jobs.size >= MAX_JOBS_POR_AGENTE) {
      return aviso({ kind: "reply", conn: msg.conn, job: msg.job, error: true });
    }
    const esImagen = msg.kind === "imageJob";
    c.jobs.set(msg.job, esImagen ? "image" : "chat");
    // El bot abandona el job (120s el chat, 240s la imagen); acá se libera un
    // poco después para que un agente que nunca contesta no quede bloqueado.
    setTimeout(() => { c.jobs.delete(msg.job); c.partes.delete(msg.job); }, (esImagen ? 250 : 130) * 1000).unref();
    try {
      c.ws.send(JSON.stringify(esImagen
        ? { type: "image", id: msg.job, prompt: msg.prompt }
        : { type: "job", id: msg.job, messages: msg.messages }));
    } catch (e) {
      c.jobs.delete(msg.job);
      aviso({ kind: "reply", conn: msg.conn, job: msg.job, error: true });
    }
    return;
  }

  if (msg.kind === "kick") cerrar(msg.conn, CIERRE.reemplazado, "desvinculado");
});

// Si el bot se cae, el gateway no tiene razón de existir.
process.on("disconnect", () => process.exit(0));

server.on("error", (e) => {
  console.error(`🛑 [llm-gateway] No pude escuchar en el puerto ${PORT}:`, e.message);
  process.exit(1);
});

// Solo loopback: desde afuera se llega únicamente a través de Tailscale Funnel.
server.listen(PORT, "127.0.0.1", () => {
  aviso({ kind: "listening", port: PORT });
});
