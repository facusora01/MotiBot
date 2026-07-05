require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const db = require("./database");
const { getPhraseInstant, iniciarPool } = require("./phrases");
const { handleCommand } = require("./commands");
const { alertarRevinculacion } = require("./notify");
const { respaldarSesion, restaurarSesionSiHaceFalta, borrarSesionYBackup } = require("./session-backup");
const { getTunnelUrl } = require("./tunnel-url");

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const HORA_ENVIO = process.env.HORA_ENVIO || "08:00";

// Perfil de Chromium que usa LocalAuth: <dataPath>/session-<clientId>
const SESSION_DIR = path.join(__dirname, "bot_session", "session-motibot");

// 🧹 Borra los locks de singleton que deja un Chromium que no cerró limpio.
// Sin esto, al reiniciar aparece "The browser is already running ..." y el bot
// no levanta nunca. Solo deben quedar si hay un Chromium VIVO; como en el
// arranque el proceso es nuevo (PM2 reinició), cualquier lock es de un huérfano.
function limpiarLocksHuerfanos() {
  const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  for (const f of locks) {
    try {
      fs.rmSync(path.join(SESSION_DIR, f), { force: true });
    } catch (e) {
      console.warn(`⚠️ No pude limpiar lock ${f}:`, e.message);
    }
  }
}

function buildCronExpression(horaStr) {
  const [h, m] = horaStr.split(":").map(Number);
  return `${m} ${h} * * *`;
}

// ⏱️ Envuelve una promesa con un timeout. Si no resuelve a tiempo, rechaza con un
// Error etiquetado. NO cancela la promesa original (JS no lo permite) pero libera
// al que la await: evita quedar pending eterno si un send/evaluate de Puppeteer
// cuelga con la página en mal estado. El que llama decide qué hacer con el throw.
const REPLY_TIMEOUT = 30000; // 30s: un reply normal tarda <1s; 30s = trabado
function conTimeout(promise, ms, label = "operación") {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} excedió ${ms}ms`)), ms);
  });
  return Promise.race([promise, limite]).finally(() => clearTimeout(t));
}

// ─── FORMATO DEL MENSAJE ──────────────────────────────────────────────────────
function formatMessage(frase, isCustom = false) {
  const emojis = ["🌟", "💪", "🔥", "✨", "🚀", "🌈", "⚡", "🎯", "💡", "🏆"];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const tag = isCustom ? "⭐ *Frase del día* ⭐" : `${emoji} *Frase del día* ${emoji}`;

  // 🗣️ marca las frases sumadas con /add (reply a un mensaje del grupo).
  const marca = frase.source === "add" ? "🗣️ " : "";
  return `${tag}\n\n_"${frase.texto}"_\n\n— ${marca}*${frase.autor}*`;
}

// ─── ENVÍO DIARIO ─────────────────────────────────────────────────────────────
async function sendDailyPhrases(client, specificGroupId = null) {
  const allGroups = db.getActiveGroups();
  const groups = specificGroupId
    ? allGroups.filter(g => g.group_id === specificGroupId)
    : allGroups;

  if (groups.length === 0) {
    console.log("📭 No hay grupos activos.");
    return;
  }

  for (const group of groups) {
    try {
      db.checkAndActivateCustom(group.group_id);

      const settings = db.getGroupSettings(group.group_id);
      let frase;
      let isCustom = false;

      if (settings?.use_custom === "active") {
        const customPhrase = db.getRandomCustomPhrase(group.group_id);
        if (customPhrase) {
          frase = { texto: customPhrase.phrase, autor: customPhrase.author, source: customPhrase.source };
          isCustom = true;
        }
      }

      if (!frase) {
        frase = getPhraseInstant(settings?.language || "es");
      }

      const mensaje = formatMessage(frase, isCustom);
      // Timeout: un send trabado (página colgada) no debe frenar el resto de los
      // grupos de este tick ni quedar pending eterno. El catch del for lo loguea.
      await conTimeout(client.sendMessage(group.group_id, mensaje), REPLY_TIMEOUT, `envío a ${group.group_name}`);

      const ahora = new Date().toLocaleString("es-AR");
      console.log(`✉️  [${ahora}] → ${group.group_name}: "${frase.texto.slice(0, 50)}..."`);
    } catch (error) {
      console.error(`❌ Error enviando a ${group.group_name}:`, error.message);
    }
  }
}

// 🧹 SINCRONIZACIÓN DE GRUPOS: Desactivar grupos donde ya no estamos
// async function syncGroups() {
//   try {
//     console.log("🔄 Sincronizando grupos con WhatsApp...");
//     
//     // Obtener todos los chats activos de WhatsApp
//     const chats = await client.getChats();
//     const activeChatIds = new Set(
//       chats
//         .filter(chat => chat.isGroup)
//         .map(chat => chat.id._serialized)
//     );

//     // 🛡️ SEGURIDAD: Si no se obtuvieron chats válidos, abortar
//     if (activeChatIds.size === 0) {
//       console.warn("⚠️ No se obtuvieron grupos de WhatsApp. Posible timeout o error de conexión.");
//       console.warn("   Se omite la limpieza para evitar desactivar grupos activos por error.");
//       return;
//     }

//     // Obtener grupos activos en la base de datos
//     const dbGroups = db.getActiveGroups();
//     let removedCount = 0;

//     for (const group of dbGroups) {
//       if (!activeChatIds.has(group.group_id)) {
//         // El bot ya no está en este grupo - desactivarlo
//         db.removeGroup(group.group_id);
//         console.log(`   🗑️ Desactivado: ${group.group_name} (ya no estamos en el grupo)`);
//         removedCount++;
//       }
//     }

//     if (removedCount > 0) {
//       console.log(`✅ Se limpiaron ${removedCount} grupo(s) obsoleto(s)\n`);
//     } else {
//       console.log(`✅ Todos los grupos están sincronizados\n`);
//     }
//   } catch (error) {
//     console.error("⚠️ Error en syncGroups (se omite limpieza):", error.message);
//     // NO desactivamos grupos si hay error - es más seguro mantenerlos activos
//   }
// }

// Función vacía temporal mientras la sincronización está desactivada
async function syncGroups() {
  console.log("🔄 Sincronización de grupos desactivada.");
}

// ─── CLIENTE WHATSAPP ─────────────────────────────────────────────────────────
// Buscá la sección del cliente en index.js y agregá estos flags
const client = new Client({
  authStrategy: new LocalAuth({ 
    clientId: "motibot",
    dataPath: "./bot_session"
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    protocolTimeout: 120000, // 2min: la página WA cuelga operaciones bajo carga
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-zygote",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  },
});

// ─── ESTADO DE RE-VINCULACIÓN ─────────────────────────────────────────────────
// Cuando el bot pierde sesión necesita re-vincularse. El código de pairing se
// genera EN VIVO en /pair (expira cada ~3min). Por mail solo va el aviso + link.
const PAIR_TOKEN = process.env.PAIR_TOKEN || "";
// Marcador en disco: indica que el bot YA se vinculó alguna vez. Vive en
// bot_session/ pero FUERA de session-motibot/, así sobrevive al logout (que
// borra session-motibot). Sirve para distinguir "primer setup manual" (no
// alarmar) de "re-vinculación tras perder sesión" (sí alarmar), entre reinicios.
const LINKED_MARKER = path.join(__dirname, "bot_session", ".was_linked");

// ─── AUTO-LIMPIEZA DE SESIÓN MUERTA ───────────────────────────────────────────
// Tras un LOGOUT (o inestabilidad repetida) la sesión guardada queda inválida:
// WhatsApp la rechaza y el bot entra en loop de re-inject ("Target closed" /
// "Execution context destroyed"), reiniciándose sin recuperarse nunca.
// Contamos los reinicios inestables seguidos en disco. Si se acumulan, borramos
// sesión + backup antes del próximo arranque → boot limpio (UNPAIRED → QR nuevo).
// El contador se resetea solo tras 5 min de conexión estable (ver 'ready'), así
// un evento transitorio aislado NO escala al borrado. Ambos marcadores viven
// fuera de session-motibot/ para sobrevivir al wipe.
const CLEAN_FLAG = path.join(__dirname, "bot_session", ".clean_on_boot");
const UNSTABLE_COUNTER = path.join(__dirname, "bot_session", ".unstable_count");
const LIMITE_INESTABLE = 2; // reinicios inestables seguidos antes de borrar sesión

function leerContadorInestable() {
  try { return parseInt(fs.readFileSync(UNSTABLE_COUNTER, "utf8"), 10) || 0; }
  catch (e) { return 0; }
}
function resetContadorInestable() {
  try { fs.rmSync(UNSTABLE_COUNTER, { force: true }); } catch (e) { /* nada */ }
}

// 📞 Número del bot para pedir el pairing code. Lo persistimos en 'ready' desde
// client.info.wid (el número de la sesión conectada), también fuera de
// session-motibot para que sobreviva al logout. Prioridad al leerlo:
//   1. BOT_PHONE del .env (si lo querés hardcodear).
//   2. Número de la última sesión conectada (este marcador).
// Así, tras vincular una vez por QR, las re-vinculaciones por código ya saben el
// número solas — sin necesidad de BOT_PHONE en el .env.
const BOT_PHONE_MARKER = path.join(__dirname, "bot_session", ".bot_phone");
function getBotPhone() {
  const env = (process.env.BOT_PHONE || "").replace(/\D/g, "");
  if (env) return env;
  try {
    return (fs.readFileSync(BOT_PHONE_MARKER, "utf8") || "").replace(/\D/g, "");
  } catch (e) {
    return "";
  }
}
let ultimoPairingCode = null; // último código emitido por WhatsApp
let necesitaAuth = false;     // true mientras espera vinculación
let estuvoReady = false;      // ya estuvo conectado al menos una vez
let alertaEnviada = false;    // evita spamear mails
let pairingSolicitado = false;// evita pedir code en cada qr

// 📱 Pide el código de pairing. En modo QR la función page-side que devuelve el
// código NO está expuesta, así que la exponemos nosotros antes de pedirlo.
async function pedirPairingCode() {
  try {
    try {
      await client.pupPage.exposeFunction("onCodeReceivedEvent", (code) => {
        client.emit("code", code);
        return code;
      });
    } catch (e) {
      // Ya estaba expuesta en esta página → ok, seguimos.
    }
    await client.requestPairingCode(getBotPhone());
  } catch (e) {
    console.error(`⚠️ No pude pedir pairing code: ${e?.name || ""} ${e?.message || e}`);
    pairingSolicitado = false; // permitir reintento en el próximo qr
  }
}

// 🚨 Manda la alerta de re-vinculación por mail, una sola vez por episodio.
// Solo si el bot YA estuvo vinculado antes — sea en este proceso (estuvoReady) o
// en uno previo (marcador en disco, sobrevive al reinicio tras logout). En el
// primer setup manual NO alarmamos (estás presente vos). 'alertaEnviada' se
// resetea en 'ready', así cada nuevo episodio de desvinculación avisa de nuevo.
// IMPORTANTE: se llama desde 'qr' Y desde el LOGOUT de 'disconnected'. Antes
// colgaba solo del 'qr', pero si el inject post-logout crashea ("Execution
// context destroyed"), el 'qr' nunca se emite → no llegaba ningún mail.
function dispararAlertaRevinculacion() {
  const yaVinculado = estuvoReady || fs.existsSync(LINKED_MARKER);
  if (!yaVinculado || alertaEnviada) return;
  alertaEnviada = true;
  const base = getTunnelUrl();
  const pairUrl = base ? `${base}/pair?key=${PAIR_TOKEN}` : "(configurá TUNNEL_URL)";
  alertarRevinculacion(pairUrl);
}

client.on("qr", (qr) => {
  necesitaAuth = true;

  console.log("==========================================");
  console.log(`🕒 [${new Date().toLocaleTimeString()}] ESPERANDO VINCULACIÓN`);
  console.log("==========================================\n");
  qrcode.generate(qr, { small: true });

  // ⚠️ NO pedimos pairing code acá automáticamente: requestPairingCode navega la
  // página (initializeAltDeviceLinking) y puede gatillar el loop de post_logout.
  // El pairing es OPT-IN: solo cuando abrís /pair (estás presente re-vinculando).

  dispararAlertaRevinculacion();
});

// WhatsApp entrega/renueva el código de 8 dígitos por acá.
client.on("code", (code) => {
  ultimoPairingCode = code;
  console.log(`🔑 Código de vinculación vigente: ${code}`);
});

client.on("authenticated", () => console.log("✅ Autenticado correctamente."));
client.on("auth_failure", (msg) => console.error("❌ Error de autenticación:", msg));

let cronRegistrado = false;
let ultimoReadyTs = 0;
let backupProgramado = false;

// Programa el respaldo de la sesión: uno diferido 30s (que se asiente) y luego
// uno periódico cada 6h. Idempotente: aunque 'ready' redispare, agenda una vez.
function programarBackupSesion() {
  if (backupProgramado) return;
  backupProgramado = true;
  setTimeout(respaldarSesion, 30000).unref();
  setInterval(respaldarSesion, 6 * 60 * 60 * 1000).unref();
}

client.on("ready", async () => {
  // La librería emite 'ready' varias veces en ráfaga tras re-inyecciones.
  // Colapsamos la ráfaga para no repetir logs ni trabajo.
  const ahoraTs = Date.now();
  if (ahoraTs - ultimoReadyTs < 10000) return;
  ultimoReadyTs = ahoraTs;

  console.log("🤖 Bot listo y conectado a WhatsApp!\n");

  // ✅ Conectado: reseteamos el estado de re-vinculación.
  necesitaAuth = false;
  estuvoReady = true;
  alertaEnviada = false;
  pairingSolicitado = false;
  ultimoPairingCode = null;

  // 🧹 Conexión estable: si seguimos arriba 5 min, la sesión es sana → reseteamos
  // el contador de inestabilidad. NO lo reseteamos al instante: en el loop de
  // sesión muerta 'ready' dispara brevemente antes de romperse, y un reset
  // inmediato impediría escalar al borrado. Si el proceso reinicia antes de los
  // 5 min, el timer muere y el contador persiste → escala. unref: no bloquea.
  setTimeout(() => { if (!cerrando) resetContadorInestable(); }, 5 * 60 * 1000).unref();

  // Dejamos el marcador: a partir de acá, cualquier QR futuro = re-vinculación
  // (no primer setup) → dispara el mail aunque sea en otro proceso tras reinicio.
  try {
    fs.writeFileSync(LINKED_MARKER, new Date().toISOString());
  } catch (e) {
    console.warn("⚠️ No pude escribir el marcador de vinculación:", e.message);
  }

  // código (pairing) sin necesidad de BOT_PHONE en el .env.
  try {
    const num = String(client.info?.wid?.user || "").replace(/\D/g, "");
    if (num) fs.writeFileSync(BOT_PHONE_MARKER, num);
  } catch (e) {
    console.warn("⚠️ No pude guardar el número del bot:", e.message);
  }

  // 💾 Sesión estable → la respaldamos para poder restaurarla si el perfil se
  // corrompe/pierde en un reinicio (evita re-pedir QR). Una vez por proceso + 6h.
  programarBackupSesion();

  // 🐕 Watchdog anti-cuelgue silencioso: a veces la página WA queda en estado
  // TIMEOUT/reconexión SIN emitir 'disconnected'. El bot sigue detectando
  // mensajes (event loop vivo) pero los reply() quedan pending para siempre.
  // El watchdog sondea getState() y reinicia si deja de estar CONNECTED.
  armarWatchdog();

  // 🎯 Pre-cargamos el pool de frases remotas para que /mbot phrase responda al
  // instante. iniciarPool es idempotente (rellenarPool tiene guard), seguro si
  // 'ready' redispara tras reconexión.
  iniciarPool();

  // 🧹 SINCRONIZACIÓN DE GRUPOS: Limpiar grupos donde ya no estamos
  await syncGroups();

  const groups = db.getActiveGroups();
  console.log(`📋 Grupos activos: ${groups.length}`);
  groups.forEach((g) => console.log(`   • ${g.group_name} (${g.group_id})`));

  // 🛡️ Si ready re-dispara tras reconexión, NO apilamos otro cron
  if (cronRegistrado) {
    console.log("⏭️  Cron ya registrado, omito re-registro.");
    return;
  }
  cronRegistrado = true;

  console.log(`\n📅 Scheduler iniciado\n`);

  // Corre cada minuto y verifica qué grupos hay que enviar
  // Actualización necesaria en index.js
  cron.schedule("* * * * *", async () => {
  // 🛡️ Try/catch global del tick: un grupo con datos corruptos NUNCA
  // debe tirar un unhandledRejection ni romper el resto de los envíos.
  try {
    const now = new Date().toLocaleTimeString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });

    const activeGroups = db.getActiveGroups();
    for (const group of activeGroups) {
      // 🛡️ settings puede ser undefined si el grupo no tiene fila en group_settings.
      // Sin este guard, `settings.send_time` lanzaba TypeError y mataba el tick.
      const settings = db.getGroupSettings(group.group_id);
      const baseTime = settings?.send_time || "08:00";
      const freq = settings?.frequency || 1;

      // 🧮 Cálculo de slots
      const [h, m] = baseTime.split(':').map(Number);
      const baseTotal = h * 60 + m;
      const interval = Math.floor(1440 / freq);

      const [nowH, nowM] = now.split(':').map(Number);
      const nowTotal = nowH * 60 + nowM;

      // Buscamos si el minuto actual coincide con algún slot del ciclo
      for (let i = 0; i < freq; i++) {
        const slot = (baseTotal + (i * interval)) % 1440;
        if (nowTotal === slot) {
          await sendDailyPhrases(client, group.group_id);
          break;
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error en tick del scheduler (se omite, no se cae el bot):", err.message);
  }
}, { timezone: "America/Argentina/Buenos_Aires" });
});

// ─── DEDUP DE MENSAJES ────────────────────────────────────────────────────────
// Tras reconexiones, whatsapp-web.js re-inyecta la página y acumula hooks: el
// MISMO mensaje se entrega varias veces → comandos y respuestas duplicados.
// Procesamos cada id de mensaje una sola vez.
const mensajesVistos = new Map(); // id -> timestamp
function yaProcesado(id) {
  if (!id) return false;
  if (mensajesVistos.has(id)) return true;
  mensajesVistos.set(id, Date.now());
  return false;
}
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 1000;
  for (const [id, ts] of mensajesVistos) {
    if (ts < limite) mensajesVistos.delete(id);
  }
}, 2 * 60 * 1000).unref();

// ⏪ ANTI-BACKLOG: marca temporal del arranque del proceso (en segundos, como los
// timestamps de WhatsApp). Restamos un margen por desfasaje de reloj para no
// perder comandos legítimos enviados justo antes de levantar.
const ARRANQUE_TS = Math.floor(Date.now() / 1000) - 60;

// 🔁 Reinicio por reply trabado: el síntoma clásico (visto en logs) es que la
// página WA queda medio-muerta —detecta comandos pero CADA respuesta vence por
// timeout ("Runtime.callFunctionOn timed out")—. Contamos los timeouts seguidos
// y reiniciamos. Es el mismo mal que cubre el watchdog de getState, pero se
// detecta desde el lado del envío, sin esperar el sondeo de 60s.
let timeoutsReplySeguidos = 0;
const MAX_TIMEOUTS_REPLY = 3;

// ─── HANDLER DE MENSAJES ──────────────────────────────────────────────────────
async function processMessage(message) {
  // Al levantar, whatsapp-web.js re-dispara message_create por TODOS los mensajes
  // viejos (sincronización). Ignoramos lo anterior al arranque: ni re-ejecutamos
  // comandos viejos ni gastamos recursos procesando historial.
  if (message.timestamp && message.timestamp < ARRANQUE_TS) return;

  const body = message.body?.trim() || "";

  // 🛡️ 1. CORTE MAESTRO: Si no empieza con "/" o es un testamento (> 450 caracteres), afuera.
  // Usamos 450 para dar aire a: comando (10) + frase (300) + autor (50) + comillas/guiones.
  if (!body.startsWith("/") || body.length > 450) return;

  const from = message.from;

  try {
    // 2. Filtro de origen: Solo aceptamos de grupos o identificadores @lid
    if (!from.endsWith("@g.us") && !from.endsWith("@lid")) return;

    // 3. Filtro de comandos: Solo pasamos si es /mbot, /new o /add (reply)
    const lowerBody = body.toLowerCase();
    const esAdd = lowerBody === "/add" || lowerBody.startsWith("/add ");
    if (!lowerBody.startsWith("/mbot") && !lowerBody.startsWith("/new ") && !esAdd) return;

    // 3.5 Dedup: si el mismo comando ya se procesó (entrega duplicada tras
    // reconexión), lo ignoramos. Evita respuestas y envíos repetidos.
    const msgId = message.id?._serialized || message.id?.id;
    if (yaProcesado(msgId)) return;

    // 4. Log Seguro: Ya sabemos que "body" es corto, pero igual lo recortamos para la consola
    const logBody = body.length > 100 ? body.slice(0, 100) + "... (recortado)" : body;
    
    console.log(`\n🚀 [${new Date().toLocaleTimeString("es-AR")}] Comando detectado de ${from}: "${logBody}"`);

    // Timeout: si reply() cuelga (página WA trabada) no quedamos pending eterno.
    await conTimeout(handleCommand(message, client), REPLY_TIMEOUT, `comando "${logBody}"`);
    timeoutsReplySeguidos = 0; // respondió ok → la página está sana
  } catch (error) {
    console.error("❌ Error en processMessage:", error.message);

    // Si el error es un timeout/target-closed y NO estamos re-vinculando, lo
    // contamos: varios seguidos = página colgada → reinicio limpio (PM2 levanta).
    const esTimeout = /excedió|timed out|Target closed/i.test(error.message || "");
    if (esTimeout && !necesitaAuth && !cerrando) {
      timeoutsReplySeguidos++;
      if (timeoutsReplySeguidos >= MAX_TIMEOUTS_REPLY) {
        console.error(`🔁 ${timeoutsReplySeguidos} replies seguidos vencidos por timeout: página colgada. Reinicio limpio.`);
        cerrarLimpio(1, "replies en timeout");
      }
    }
  }
}

client.on("message_create", processMessage);

// 1. Cierre limpio: destruimos el cliente (cierra Chromium → libera el lock del
//    perfil) ANTES de salir. Si solo hacemos process.exit, el Chromium queda
//    huérfano sosteniendo SingletonLock y el próximo arranque falla con
//    "The browser is already running ...".
let cerrando = false;
async function cerrarLimpio(code, motivo) {
  if (cerrando) return; // Evita cierres múltiples en ráfaga
  cerrando = true;
  console.error(`🛑 Cerrando proceso (${motivo}). Liberando Chromium...`);

  // Carrera contra reloj: si destroy() cuelga (página rota), forzamos exit a los 8s.
  const forzar = setTimeout(() => {
    console.error("⏱️ destroy() tardó demasiado, forzando salida.");
    process.exit(code);
  }, 8000);

  try {
    await client.destroy();
  } catch (e) {
    console.error("⚠️ Error al destruir el cliente:", e.message);
  } finally {
    clearTimeout(forzar);
    limpiarLocksHuerfanos(); // Por las dudas, dejamos el perfil sin locks
    process.exit(code);
  }
}

// Reinicio por inestabilidad (watchdog colgado o LOGOUT). Incrementa el contador
// en disco; si llega al límite, marca la sesión para borrarse en el próximo boot
// (la sesión está muerta y reiniciar sin limpiar solo repite el loop). Si no,
// reinicia normal y deja que PM2 levante: un evento aislado se recupera solo.
function escalarReinicioInestable(motivo) {
  const n = leerContadorInestable() + 1;
  try { fs.writeFileSync(UNSTABLE_COUNTER, String(n)); } catch (e) { /* nada */ }

  if (n >= LIMITE_INESTABLE) {
    console.error(`🧹 ${n} reinicios inestables seguidos: sesión muerta. La borro en el próximo arranque → QR nuevo.`);
    try { fs.writeFileSync(CLEAN_FLAG, new Date().toISOString()); } catch (e) { /* nada */ }
    cerrarLimpio(1, `${motivo} (x${n}: limpiar sesión)`);
  } else {
    console.error(`🔁 Reinicio inestable ${n}/${LIMITE_INESTABLE} (${motivo}). PM2 levanta.`);
    cerrarLimpio(1, motivo);
  }
}

client.on("disconnected", (reason) => {
  const ts = new Date().toISOString();
  console.error(`❌ [${ts}] Bot desconectado. Razón: ${reason}`);

  // ⚠️ LOGOUT: la sesión se invalidó (cierre desde el cel, ban, o WhatsApp Web
  // abierto en otro lado). Antes NO salíamos acá, esperando que la lib se
  // recuperara sola mostrando un QR nuevo — pero esa "auto-recuperación" entra en
  // un loop de re-inject ("Target closed") que NUNCA se cura porque restauramos
  // la misma sesión muerta. Ahora escalamos a reinicio: el contador de
  // inestabilidad termina borrando la sesión muerta → arranque limpio con QR.
  if (String(reason).toUpperCase().includes("LOGOUT")) {
    console.error("🚨 Sesión invalidada (LOGOUT). Reinicio limpio; si insiste, borro la sesión muerta para re-vincular.");
    necesitaAuth = true;
    estuvoReady = false;
    pairingSolicitado = false;
    ultimoPairingCode = null;
    // 📧 Mandamos el mail ACÁ, no esperamos al 'qr': si el inject post-logout
    // crashea, el 'qr' nunca se emite y nos quedábamos sin aviso. (estuvoReady ya
    // está en false, pero el marcador en disco hace que yaVinculado siga true.)
    dispararAlertaRevinculacion();
    escalarReinicioInestable("disconnected: LOGOUT");
    return;
  }

  // Otros motivos (conflicto de red, etc.): la lib no se recupera sola → salimos
  // limpio y dejamos que PM2 reinicie con backoff.
  cerrarLimpio(1, `disconnected: ${reason}`);
});

// ─── WATCHDOG ANTI-CUELGUE SILENCIOSO ─────────────────────────────────────────
// Síntoma que cubre: el bot detecta comandos pero nunca responde (reply queda
// pending eterno) y NO se dispara 'disconnected'. Causa: la página WA entró en
// estado != CONNECTED (TIMEOUT, OPENING colgado) con el websocket medio-vivo.
// Como no hay evento, la lib no se auto-recupera → quedaría colgado indefinido.
// Solución: sondear getState() y, si no vuelve CONNECTED en chequeos seguidos,
// reiniciar limpio para que PM2 levante con la página sana.
const WATCHDOG_INTERVAL = 60 * 1000; // sondeo cada 60s
const WATCHDOG_TOLERANCIA = 2;       // fallos seguidos (~2min) antes de reiniciar
let fallosWatchdog = 0;
let watchdogArmado = false;

// getState() hace page.evaluate; si la página está colgada, también cuelga. Lo
// corremos con timeout para que el propio watchdog no se cuelgue esperándolo.
function getStateConTimeout(ms = 15000) {
  return conTimeout(client.getState(), ms, "getState");
}

function armarWatchdog() {
  if (watchdogArmado) return; // idempotente: 'ready' puede redisparar
  watchdogArmado = true;
  setInterval(async () => {
    // Mientras esperamos re-vinculación el estado NO es CONNECTED a propósito
    // (UNPAIRED). Tampoco molestamos si ya estamos cerrando. En ambos casos
    // reseteamos el contador para no arrastrar fallos previos.
    if (necesitaAuth || cerrando) { fallosWatchdog = 0; return; }

    let estado;
    try {
      estado = await getStateConTimeout();
    } catch (e) {
      estado = `ERROR(${e.message})`; // timeout o evaluate roto → cuenta como fallo
    }

    if (estado === "CONNECTED") {
      fallosWatchdog = 0;
      return;
    }

    fallosWatchdog++;
    console.warn(`🐕 Watchdog: estado="${estado}" (${fallosWatchdog}/${WATCHDOG_TOLERANCIA}).`);

    if (fallosWatchdog >= WATCHDOG_TOLERANCIA) {
      console.error(`🐕 Watchdog: página colgada (estado="${estado}").`);
      escalarReinicioInestable(`watchdog: estado ${estado}`);
    }
  }, WATCHDOG_INTERVAL).unref(); // unref: no bloquea el cierre del proceso
}

// Señales de PM2 (reload/stop): cerramos Chromium limpio para no dejar huérfanos.
process.on("SIGINT", () => cerrarLimpio(0, "SIGINT"));
process.on("SIGTERM", () => cerrarLimpio(0, "SIGTERM"));

// 2. CAPA DE SEGURIDAD GLOBAL
process.on('unhandledRejection', (reason, promise) => {
    const msg = reason?.message || "";

    // Este error ocurre durante la inicialización cuando WhatsApp
    // navega la página y destruye el contexto de Puppeteer.
    // NO hacemos exit aquí: si ya estamos listos (ready), es inofensivo.
    // Si ocurre durante initialize(), el bloque catch de startBot() lo maneja.
    if (msg.includes('Execution context was destroyed')) {
        console.warn('⚠️ Contexto de Puppeteer destruido (ignorado si el bot ya está listo).');
        return;
    }

    console.error('🚨 Error no manejado detectado:', reason);
});


// ─── SERVIDOR WEB (EXPRESS) ───────────────────────────────────────────────────
const express = require("express");
const app = express();
app.use(express.json());
// Puerto propio (3001) para NO chocar con otros servicios del mismo server (p.ej.
// WebAmankay usa el 3000). Configurable por env. Si cambia, ajustá también el
// túnel de Cloudflare en deploy.yml (--url http://localhost:<PORT>).
const PORT = process.env.PORT || 3001;

// 🛡️ 1. Función para neutralizar scripts maliciosos (XSS)
function safeHTML(str) {
  if (!str) return "";
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

// ─── PANEL WEB (GESTIÓN DE FRASES) ───────────────────────────────────────────
app.get("/frases/:groupId", (req, res) => {
  const { groupId } = req.params;
  const { key } = req.query;
  const group = db.getGroup(groupId);
  const groupToken = db.getGroupToken(groupId);

  if (!group) return res.status(404).send("<h1 style='text-align:center;'>Grupo no encontrado</h1>");

  // 🛡️ 1. PANTALLA DE LOGIN (Si no hay llave o es incorrecta)
  if (!key || key !== groupToken) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8"><title>🔒 Login - ${group.group_name}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: sans-serif; background: #1a1a2e; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .login-box { background: #16213e; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; width: 320px; border: 1px solid #0f3460; }
          input { width: 100%; padding: 12px; margin: 20px 0; border-radius: 6px; border: none; background: #0f3460; color: white; box-sizing: border-box; text-align: center; }
          button { background: #e94560; color: white; border: none; padding: 12px; width: 100%; border-radius: 6px; cursor: pointer; font-weight: bold; }
          .error { color: #ff4d4d; font-size: 0.8em; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="login-box">
          <h2>MotiBot 🤖</h2>
          <p>Llave para <b>${safeHTML(group.group_name)}</b></p>
          <input type="password" id="tInput" placeholder="••••••••••••••••">
          <button onclick="login()">INGRESAR</button>
          ${key ? '<p class="error">❌ Llave inválida</p>' : ''}
        </div>
        <script>
          window.onload = () => {
            const saved = localStorage.getItem('mbot_key_${groupId}');
            if (saved && !window.location.search.includes('key')) window.location.href = "?key=" + saved;
          };
          function login() {
            const t = document.getElementById('tInput').value.trim();
            if(t) { localStorage.setItem('mbot_key_${groupId}', t); window.location.href = "?key=" + t; }
          }
        </script>
      </body>
      </html>
    `);
  }

  // 🔓 2. PANEL PRINCIPAL (Si la llave es correcta)
  const frases = db.getCustomPhrasesList(groupId);
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8"><title>Panel - ${group.group_name}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        :root { --bg: #f8f9fa; --border: #dee2e6; --primary: #007bff; --danger: #dc3545; }
        body { font-family: sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #212529; }
        .container { max-width: 900px; margin: auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); overflow: hidden; }
        .header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        .search-bar { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 5px; margin-top: 10px; }
        .phrase-row { display: flex; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--border); gap: 15px; }
        .phrase-row:hover { background: #f1f3f5; }
        .phrase-row.hidden { display: none; }
        .content-col { flex-grow: 1; overflow: hidden; }
        .phrase-text { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
        .meta-col { text-align: right; font-size: 0.85em; color: #6c757d; min-width: 150px; }
        .actions-bar { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #343a40; color: white; padding: 12px 25px; border-radius: 50px; display: none; align-items: center; gap: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
        .btn { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; font-weight: bold; }
        .btn-del { background: var(--danger); color: white; }
        .btn-out { background: transparent; border: 1px solid var(--danger); color: var(--danger); }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h3 style="margin:0">📚 ${safeHTML(group.group_name)} (${frases.length})</h3>
          <button class="btn btn-out" onclick="logout()">Cerrar Sesión 🔒</button>
          <input type="text" id="sIn" class="search-bar" placeholder="🔍 Buscar frase o autor..." onkeyup="filter()">
        </div>
        <div id="pList">
          ${frases.map(f => `
            <div class="phrase-row" data-s="${safeHTML(f.phrase + ' ' + f.author).toLowerCase()}">
              <input type="checkbox" class="p-cb" value="${f.id}" onchange="updateBar()">
              <div class="content-col">
                <span class="phrase-text" title="${f.source === 'add' ? 'Agregada con /add (reply)' : 'Agregada con /new'}">${f.source === 'add' ? '🗣️ ' : ''}"${safeHTML(f.phrase)}"</span>
                <small>— ${safeHTML(f.author)}</small>
              </div>
              <div class="meta-col">👤 ${safeHTML(f.added_by || 'Anónimo')}<br>ID: #${f.id}</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div id="aBar" class="actions-bar">
        <span id="cText">0 seleccionadas</span>
        <button class="btn btn-del" onclick="deleteSelected()">🗑️ Borrar Seleccionadas</button>
      </div>
      <script>
        function filter() {
          const q = document.getElementById('sIn').value.toLowerCase();
          document.querySelectorAll('.phrase-row').forEach(r => r.classList.toggle('hidden', !r.dataset.s.includes(q)));
        }
        function updateBar() {
          const n = document.querySelectorAll('.p-cb:checked').length;
          document.getElementById('aBar').style.display = n > 0 ? 'flex' : 'none';
          document.getElementById('cText').innerText = n + " seleccionadas";
        }
        async function deleteSelected() {
          if(!confirm('¿Borrar frases seleccionadas?')) return;
          const ids = Array.from(document.querySelectorAll('.p-cb:checked')).map(c => c.value);
          const key = new URLSearchParams(window.location.search).get('key') || localStorage.getItem('mbot_key_${groupId}');
          
          try {
            const res = await fetch(window.location.pathname, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phraseIds: ids, key: key })
            });
            if(res.ok) window.location.reload();
            else {
              const err = await res.json();
              alert('❌ Error: ' + (err.error || 'No se pudo borrar'));
            }
          } catch(e) { alert('❌ Error de conexión al servidor.'); }
        }
        function logout() { localStorage.removeItem('mbot_key_${groupId}'); window.location.href = window.location.pathname; }
      </script>
    </body>
    </html>
  `);
});

// ─── API: BORRADO MÚLTIPLE (Única versión válida) ───────────────────────────
app.delete("/frases/:groupId", (req, res) => {
  const { groupId } = req.params;
  const { phraseIds, key } = req.body;

  console.log(`\n🗑️ Petición de borrado para el grupo: ${groupId}`);

  const groupToken = db.getGroupToken(groupId);
  if (!key || key !== groupToken) {
    console.warn("⚠️ Intento de borrado RECHAZADO: Llave incorrecta.");
    return res.status(401).json({ error: "Llave maestra incorrecta o caducada." });
  }

  try {
    db.deleteMultiplePhrases(groupId, phraseIds);
    console.log(`✅ Se borraron ${phraseIds.length} frases correctamente.`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error en base de datos:", error);
    res.status(500).json({ error: "Error interno del servidor al borrar." });
  }
});

// ─── PÁGINA DE RE-VINCULACIÓN ────────────────────────────────────────────────
// Muestra el código de pairing EN VIVO. El mail manda acá. Token-protegida.
app.get("/pair", (req, res) => {
  if (!PAIR_TOKEN || req.query.key !== PAIR_TOKEN) {
    return res.status(401).send("<h1 style='font-family:sans-serif;text-align:center'>🔒 Acceso denegado</h1>");
  }

  // Ya conectado: nada que hacer.
  if (!necesitaAuth) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="15"></head>
      <body style="font-family:sans-serif;background:#0b141a;color:#fff;text-align:center;padding-top:60px">
      <h1>✅ Bot conectado</h1><p>No hace falta vincular nada. Esta página se refresca sola.</p>
      </body></html>`);
  }

  // 📱 Pairing ON-DEMAND: lo pedimos solo cuando alguien abre esta página (con el
  // token), no en el flujo automático de QR. Así el bot no se desestabiliza solo.
  if (getBotPhone() && !pairingSolicitado) {
    pairingSolicitado = true;
    pedirPairingCode();
  }

  const codigo = ultimoPairingCode
    ? `<div style="font-size:46px;letter-spacing:8px;font-weight:bold;background:#1f2c34;padding:20px;border-radius:12px;margin:20px 0">${safeHTML(ultimoPairingCode)}</div>`
    : `<p style="color:#ffb300">⏳ Generando código... (refrescá en unos segundos)</p>`;

  const aviso = getBotPhone() ? "" : `<p style="color:#ff6b6b">⚠️ Sin número del bot (ni BOT_PHONE en .env ni sesión previa): no puedo generar código. Vinculá por QR una vez.</p>`;

  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="20"><title>Vincular MotiBot</title></head>
    <body style="font-family:sans-serif;background:#0b141a;color:#fff;text-align:center;padding:30px;max-width:480px;margin:auto">
      <h1>🔗 Re-vincular MotiBot</h1>
      ${aviso}
      <p>En tu teléfono, abrí WhatsApp y andá a:</p>
      <p style="background:#1f2c34;padding:12px;border-radius:8px">⚙️ <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b> → <b>Vincular con número de teléfono</b></p>
      <p>Después tipeá este código:</p>
      ${codigo}
      <p style="color:#8696a0;font-size:0.85em">El código se renueva solo cada ~3 min. Si no entra, esperá el refresco y usá el nuevo.</p>
    </body></html>`);
});

// ─── HEALTH CHECK (para monitor externo: UptimeRobot/healthchecks) ────────────
app.get("/health", (req, res) => {
  res.status(necesitaAuth ? 503 : 200).json({
    connected: !necesitaAuth,
    everConnected: estuvoReady,
    ts: new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`🌐 Servidor Web activo en puerto ${PORT}`));

// ─── INICIO CON REINTENTOS ────────────────────────────────────────────────────
console.log("🚀 Iniciando MotivacionalBot v2...");

async function startBot(intentos = 3, demora = 8000) {
  // 🧹 Si un ciclo previo marcó la sesión como muerta (LOGOUT o inestabilidad
  // repetida), la borramos ANTES de restaurar: si no, restauraríamos el cadáver y
  // volveríamos al loop de re-inject. Sin sesión → arranque limpio (UNPAIRED→QR).
  if (fs.existsSync(CLEAN_FLAG)) {
    console.warn("🧹 Marca de limpieza presente: borro sesión muerta + backup para arranque limpio.");
    borrarSesionYBackup();
    try { fs.rmSync(CLEAN_FLAG, { force: true }); } catch (e) { /* nada */ }
    resetContadorInestable();
  }

  // 💾 Si el perfil vivo perdió la sesión pero hay backup, lo restauramos antes
  // de inicializar — así recuperamos el login en vez de caer en el QR.
  restaurarSesionSiHaceFalta();

  for (let i = 1; i <= intentos; i++) {
    // 🧹 Antes de cada intento limpiamos locks de un Chromium que no cerró bien.
    limpiarLocksHuerfanos();

    try {
      await client.initialize();
      return; // Éxito
    } catch (err) {
      const msg = err.message || "";
      // Errores recuperables: contexto destruido, perfil bloqueado por huérfano,
      // o Chromium lento en publicar el WS endpoint. En todos, reintentar ayuda.
      const recuperable =
        msg.includes("Execution context was destroyed") ||
        msg.includes("browser is already running") ||
        msg.includes("WS endpoint URL");

      if (recuperable && i < intentos) {
        console.warn(`⚠️ Error recuperable en intento ${i}/${intentos} (${msg.slice(0, 60)}). Reintentando en ${demora / 1000}s...`);
        await new Promise(r => setTimeout(r, demora));
      } else {
        // Sin más intentos → dejamos que PM2 reinicie (con backoff del ecosystem)
        console.error(`❌ Error fatal en initialize() (intento ${i}/${intentos}):`, msg);
        process.exit(1);
      }
    }
  }
}

startBot();

module.exports = { client, syncGroups };