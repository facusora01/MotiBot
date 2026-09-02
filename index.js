require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const db = require("./database");
const { getPhraseInstant, iniciarPool } = require("./phrases");
const { handleCommand, handleReaction, esSuperAdmin } = require("./commands");
const { alertarRevinculacion } = require("./notify");
const { respaldarSesion, restaurarSesionSiHaceFalta, borrarSesionYBackup } = require("./session-backup");
const { getTunnelUrl } = require("./tunnel-url");
const { getMercado, fechaPizarraISO } = require("./mercado");

const HORA_ENVIO = process.env.HORA_ENVIO || "08:00";

// Perfil de Chromium que usa LocalAuth: <dataPath>/session-<clientId>
const SESSION_DIR = path.join(__dirname, "bot_session", "session-motibot");

// Limpia locks de un Chromium que no cerró bien (si no: "already running" bloquea
// el arranque). Seguro: en el arranque el proceso es nuevo (PM2 reinició), así
// que cualquier lock encontrado es de un huérfano.
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

// No cancela la promesa original (JS no lo permite), pero libera al que espera:
// evita quedar pending eterno si Puppeteer cuelga con la página en mal estado.
const REPLY_TIMEOUT = 30000; // 30s: un reply normal tarda <1s; 30s = trabado
function conTimeout(promise, ms, label = "operación") {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} excedió ${ms}ms`)), ms);
  });
  return Promise.race([promise, limite]).finally(() => clearTimeout(t));
}

function formatMessage(frase, isCustom = false) {
  const emojis = ["🌟", "💪", "🔥", "✨", "🚀", "🌈", "⚡", "🎯", "💡", "🏆"];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const tag = isCustom ? "⭐ *Frase del día* ⭐" : `${emoji} *Frase del día* ${emoji}`;

  const marca = frase.source === "add" ? "🗣️ " : "";
  return `${tag}\n\n_"${frase.texto}"_\n\n— ${marca}*${frase.autor}*`;
}

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
      // timeout: un send trabado no debe frenar el resto de los grupos de este tick.
      await conTimeout(client.sendMessage(group.group_id, mensaje), REPLY_TIMEOUT, `envío a ${group.group_name}`);

      const ahora = new Date().toLocaleString("es-AR");
      console.log(`✉️  [${ahora}] → ${group.group_name}: "${frase.texto.slice(0, 50)}..."`);
    } catch (error) {
      console.error(`❌ Error enviando a ${group.group_name}:`, error.message);
    }
  }
}

// El server puede correr en UTC: la fecha "de hoy" tiene que ser la argentina,
// si no un cumple del día 5 se saluda el 4 a las 21hs.
function fechaArgentina() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [year, month, day] = partes.split("-").map(Number);
  return { year, month, day, iso: partes };
}

function esBisiesto(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Saluda a los cumpleañeros del grupo. El regalo es una frase: del equipo si el
// modo custom está activo, del libro clásico si no.
async function enviarCumpleanios(client, group) {
  const hoy = fechaArgentina();

  const fechas = [{ month: hoy.month, day: hoy.day }];
  // Los nacidos un 29/2 se quedarían sin saludo 3 de cada 4 años: los sumamos al 1/3.
  if (hoy.month === 3 && hoy.day === 1 && !esBisiesto(hoy.year)) {
    fechas.push({ month: 2, day: 29 });
  }

  const cumples = db.getBirthdaysDelDia(group.group_id, fechas, hoy.iso);
  if (!cumples.length) return;

  db.checkAndActivateCustom(group.group_id);
  const settings = db.getGroupSettings(group.group_id);

  for (const cumple of cumples) {
    try {
      let frase = null;
      if (settings?.use_custom === "active") {
        const custom = db.getRandomCustomPhrase(group.group_id);
        if (custom) frase = { texto: custom.phrase, autor: custom.author, source: custom.source };
      }
      if (!frase) frase = getPhraseInstant(settings?.language || "es");

      const nombre = cumple.name || "crack";
      const edad = cumple.year ? hoy.year - cumple.year : null;
      const marca = frase.source === "add" ? "🗣️ " : "";

      // Para que WhatsApp muestre la mención (y le llegue la notificación) el
      // texto tiene que traer el "@<número>"; la lista de mentions sola no
      // alcanza. Va fuera de los asteriscos para que no se coma el formato.
      const arroba = cumple.user_id ? `@${String(cumple.user_id).split("@")[0]}` : nombre;

      const mensaje =
        `🎉🎂 *¡FELIZ CUMPLEAÑOS!* 🎂🎉\n\n` +
        (edad !== null
          ? `${arroba}, hoy soplás *${edad}* velitas. ¡Que sea un año enorme! 🥳\n\n`
          : `${arroba}, ¡que sea un año enorme! 🥳\n\n`) +
        `🎁 Y de regalo, una frase para vos:\n\n` +
        `_"${frase.texto}"_\n\n— ${marca}*${frase.autor}*`;

      await conTimeout(
        client.sendMessage(group.group_id, mensaje, { mentions: cumple.user_id ? [cumple.user_id] : [] }),
        REPLY_TIMEOUT,
        `cumple de ${nombre}`
      );

      // Recién acá: si el envío falló, mañana no lo damos por saludado.
      db.markBirthdayGreeted(group.group_id, cumple.user_id, hoy.iso);
      console.log(`🎂 [${hoy.iso}] Saludo enviado a ${nombre} en ${group.group_name}`);
    } catch (error) {
      console.error(`❌ Error saludando a ${cumple.name} en ${group.group_name}:`, error.message);
    }
  }
}

function aMinutos(hhmm) {
  const [h, m] = String(hhmm || "09:00").split(":").map(Number);
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 0);
}

// Cuánto seguimos esperando la pizarra después de la hora del grupo. Sin este
// tope, un día sin rueda dejaría el sondeo dando vueltas hasta la medianoche.
const VENTANA_MERCADO = 6 * 60; // minutos

// Día del último "todavía no es la de hoy": el aviso se emite una sola vez.
let avisoPizarraVieja = null;

// Mercado de granos: opt-in por grupo (lo habilita el super admin desde su
// privado). market_time NO es la hora exacta del envío sino un "no antes de":
// la pizarra se publica cerca de las 10:30 y algunos días más tarde, así que
// sondeamos desde esa hora y mandamos en el primer tick que la encuentre.
//
// Dos condiciones para que salga, y las dos importan:
//   · la fecha de la pizarra tiene que ser la de HOY — fin de semana y feriados
//     no hay rueda y el feed sigue devolviendo la última, así que sin esto el
//     domingo repetiríamos la del viernes;
//   · market_last_sent tiene que no ser hoy — apenas sale, el grupo queda
//     saldado hasta mañana aunque el cron siga corriendo cada minuto.
//
// El sondeo es barato: getMercado() cachea 10 minutos, así que entre la hora
// del grupo y el envío se pega a la red 6 veces por hora como mucho, y una vez
// enviado no se consulta más en todo el día.
async function enviarMercado(client, ahoraHHMM) {
  const grupos = db.getMarketGroups();
  if (!grupos.length) return;

  const hoy = fechaArgentina();
  const ahora = aMinutos(ahoraHHMM);

  const pendientes = grupos.filter((g) => {
    if (g.market_last_sent === hoy.iso) return false; // ya lo recibió hoy
    const desde = aMinutos(g.market_time);
    return ahora >= desde && ahora < desde + VENTANA_MERCADO;
  });
  if (!pendientes.length) return;

  let mercado;
  try {
    mercado = await getMercado();
  } catch (error) {
    console.error("❌ No pude leer la pizarra de granos:", error.message);
    return;
  }

  if (fechaPizarraISO(mercado.fecha) !== hoy.iso) {
    // Una línea por día: durante la espera esto se evalúa cada minuto y el log
    // quedaría ilegible.
    if (avisoPizarraVieja !== hoy.iso) {
      avisoPizarraVieja = hoy.iso;
      console.log(`🌾 Pizarra del ${mercado.fecha}: todavía no es la de hoy (${hoy.iso}). Sigo esperando.`);
    }
    return;
  }

  for (const grupo of pendientes) {
    try {
      await conTimeout(
        client.sendMessage(grupo.group_id, mercado.texto),
        REPLY_TIMEOUT,
        `mercado a ${grupo.group_name}`
      );
      // Recién acá: si el envío falló, en el próximo tick se reintenta.
      db.markMarketSent(grupo.group_id, hoy.iso);
      console.log(`🌾 [${hoy.iso}] Mercado enviado a ${grupo.group_name}`);
    } catch (error) {
      console.error(`❌ Error enviando el mercado a ${grupo.group_name}:`, error.message);
    }
  }
}

// Sincronización de grupos desactivada temporalmente.
async function syncGroups() {
  console.log("🔄 Sincronización de grupos desactivada.");
}

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

// El código de pairing se genera EN VIVO en /pair (expira cada ~3min); por mail
// solo va el aviso + link.
const PAIR_TOKEN = process.env.PAIR_TOKEN || "";
// Vive fuera de session-motibot/ (sobrevive al logout) para distinguir primer
// setup (no alarmar) de re-vinculación tras perder sesión (sí alarmar).
const LINKED_MARKER = path.join(__dirname, "bot_session", ".was_linked");

// Tras LOGOUT o inestabilidad repetida la sesión queda inválida y reiniciar sin
// más solo repite el loop de re-inject. Contamos reinicios inestables seguidos
// (marcador en disco); al límite, borramos sesión+backup antes del próximo boot.
const CLEAN_FLAG = path.join(__dirname, "bot_session", ".clean_on_boot");
const UNSTABLE_COUNTER = path.join(__dirname, "bot_session", ".unstable_count");
const LIMITE_INESTABLE = 2;

function leerContadorInestable() {
  try { return parseInt(fs.readFileSync(UNSTABLE_COUNTER, "utf8"), 10) || 0; }
  catch (e) { return 0; }
}
function resetContadorInestable() {
  try { fs.rmSync(UNSTABLE_COUNTER, { force: true }); } catch (e) { /* nada */ }
}

// Persistido en 'ready' desde client.info.wid, fuera de session-motibot/ para
// sobrevivir al logout. Prioridad: BOT_PHONE del .env, si no, este marcador —
// así tras el primer QR las siguientes re-vinculaciones no necesitan el .env.
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

// En modo QR la función page-side que devuelve el código no está expuesta.
async function pedirPairingCode() {
  try {
    try {
      await client.pupPage.exposeFunction("onCodeReceivedEvent", (code) => {
        client.emit("code", code);
        return code;
      });
    } catch (e) {} // ya estaba expuesta en esta página
    await client.requestPairingCode(getBotPhone());
  } catch (e) {
    console.error(`⚠️ No pude pedir pairing code: ${e?.name || ""} ${e?.message || e}`);
    pairingSolicitado = false; // permitir reintento en el próximo qr
  }
}

// Una alerta por episodio (alertaEnviada resetea en 'ready'). Se llama desde
// 'qr' Y desde el LOGOUT: si el inject post-logout crashea, 'qr' nunca se
// emite y sin esto no llegaría ningún mail.
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

  // Pairing es opt-in (solo al abrir /pair): pedirlo acá navegaría la página y
  // podría gatillar el loop post-logout.

  dispararAlertaRevinculacion();
});

client.on("code", (code) => {
  ultimoPairingCode = code;
  console.log(`🔑 Código de vinculación vigente: ${code}`);
});

client.on("authenticated", () => console.log("✅ Autenticado correctamente."));
client.on("auth_failure", (msg) => console.error("❌ Error de autenticación:", msg));

let cronRegistrado = false;
let ultimoReadyTs = 0;
let backupProgramado = false;

// Backup diferido 30s + periódico cada 6h; idempotente pese a redisparos de 'ready'.
function programarBackupSesion() {
  if (backupProgramado) return;
  backupProgramado = true;
  setTimeout(respaldarSesion, 30000).unref();
  setInterval(respaldarSesion, 6 * 60 * 60 * 1000).unref();
}

client.on("ready", async () => {
  // 'ready' puede emitirse en ráfaga tras re-inyecciones; colapsamos para no
  // repetir trabajo.
  const ahoraTs = Date.now();
  if (ahoraTs - ultimoReadyTs < 10000) return;
  ultimoReadyTs = ahoraTs;

  console.log("🤖 Bot listo y conectado a WhatsApp!\n");

  necesitaAuth = false;
  estuvoReady = true;
  alertaEnviada = false;
  pairingSolicitado = false;
  ultimoPairingCode = null;

  // Reset diferido 5 min: en el loop de sesión muerta 'ready' dispara brevemente
  // antes de romperse — resetear al instante nunca dejaría escalar al borrado.
  setTimeout(() => { if (!cerrando) resetContadorInestable(); }, 5 * 60 * 1000).unref();

  // A partir de acá, cualquier QR futuro es re-vinculación (dispara el mail).
  try {
    fs.writeFileSync(LINKED_MARKER, new Date().toISOString());
  } catch (e) {
    console.warn("⚠️ No pude escribir el marcador de vinculación:", e.message);
  }

  // Persistimos el número de esta sesión para futuras re-vinculaciones por código.
  try {
    const num = String(client.info?.wid?.user || "").replace(/\D/g, "");
    if (num) fs.writeFileSync(BOT_PHONE_MARKER, num);
  } catch (e) {
    console.warn("⚠️ No pude guardar el número del bot:", e.message);
  }

  // Backup para poder restaurar la sesión si el perfil se corrompe/pierde en un reinicio.
  programarBackupSesion();

  armarWatchdog();

  // Con la sesión viva ya sabemos con qué ids nos arrobaría la gente.
  await registrarIdsDelBot();

  // Pre-cargamos el pool para que /mbot phrase responda al instante; idempotente.
  iniciarPool();

  await syncGroups();

  const groups = db.getActiveGroups();
  console.log(`📋 Grupos activos: ${groups.length}`);
  groups.forEach((g) => console.log(`   • ${g.group_name} (${g.group_id})`));

  // Evita apilar otro cron si 'ready' redispara tras reconexión.
  if (cronRegistrado) {
    console.log("⏭️  Cron ya registrado, omito re-registro.");
    return;
  }
  cronRegistrado = true;

  console.log(`\n📅 Scheduler iniciado\n`);

  cron.schedule("* * * * *", async () => {
  // un grupo con datos corruptos no debe tirar unhandledRejection ni romper el tick.
  try {
    const now = new Date().toLocaleTimeString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });

    const activeGroups = db.getActiveGroups();
    for (const group of activeGroups) {
      // Modo solo mercado: ni frase diaria ni saludos de cumple. La pizarra va
      // por su propio camino (enviarMercado), más abajo.
      if (!db.isPhrasesEnabled(group.group_id)) continue;

      // settings puede ser undefined si el grupo no tiene fila en group_settings.
      const settings = db.getGroupSettings(group.group_id);
      const baseTime = settings?.send_time || "08:00";
      const freq = settings?.frequency || 1;

      const [h, m] = baseTime.split(':').map(Number);
      const baseTotal = h * 60 + m;
      const interval = Math.floor(1440 / freq);

      const [nowH, nowM] = now.split(':').map(Number);
      const nowTotal = nowH * 60 + nowM;

      // Los cumpleaños salen una sola vez por día, en el horario base del grupo
      // (no en cada pasada de la frecuencia). Va antes de la frase del día para
      // que el saludo encabece.
      if (nowTotal === baseTotal) {
        await enviarCumpleanios(client, group);
      }

      for (let i = 0; i < freq; i++) {
        const slot = (baseTotal + (i * interval)) % 1440;
        if (nowTotal === slot) {
          await sendDailyPhrases(client, group.group_id);
          break;
        }
      }
    }

    await enviarMercado(client, now);
  } catch (err) {
    console.error("⚠️ Error en tick del scheduler (se omite, no se cae el bot):", err.message);
  }
}, { timezone: "America/Argentina/Buenos_Aires" });
});

// Tras reconexiones, whatsapp-web.js reinyecta la página y duplica hooks: el
// mismo mensaje se entrega varias veces. Procesamos cada id una sola vez.
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

// Marca de arranque (con margen por desfasaje de reloj): ignora comandos viejos
// que whatsapp-web.js re-dispara al sincronizar el historial.
const ARRANQUE_TS = Math.floor(Date.now() / 1000) - 60;

// Mismo síntoma que cubre el watchdog (página colgada), detectado del lado del
// envío: si CADA reply vence por timeout, no hace falta esperar el sondeo de 60s.
let timeoutsReplySeguidos = 0;
const MAX_TIMEOUTS_REPLY = 3;

// --- ARROBAR AL BOT ---------------------------------------------------------
// Además de /mbot, el bot atiende cuando lo arroban: "@MotiBot phrase" equivale
// a "/mbot phrase". WhatsApp escribe la mención en el body como "@<número>"
// (o "@<lid>" en cuentas nuevas), así que necesitamos saber con qué ids se
// identifica esta sesión; se completan en 'ready'.
const idsDelBot = new Set();

function sumarId(raw) {
  const user = raw?.user || (typeof raw === "string" ? String(raw).split("@")[0] : null);
  if (user) idsDelBot.add(String(user));
}

async function registrarIdsDelBot() {
  for (const raw of [client.info?.wid, client.info?.me, client.info?.lid]) sumarId(raw);

  const env = getBotPhone();
  if (env) idsDelBot.add(env);

  // En cuentas nuevas WhatsApp arroba por @lid, que no siempre viaja en
  // client.info. Se lo preguntamos a la página; si esta versión no expone el
  // helper, seguimos con el número (la mayoría de los grupos arroban así).
  try {
    const lid = await client.pupPage.evaluate(() => {
      const u = window.Store?.User;
      const wid = u?.getMaybeMeLidUser?.() || u?.getMeLidUser?.();
      return wid?.user || wid?._serialized || null;
    });
    if (lid) sumarId(lid);
  } catch (e) {
    console.warn("⚠️ No pude leer mi @lid desde la página:", e.message);
  }

  console.log(`🏷️  Me reconozco arrobado como: ${[...idsDelBot].join(", ") || "(ninguno todavía)"}`);
}

// Comandos que viven en la raíz (no cuelgan de /mbot): "@MotiBot idea X" tiene
// que volverse "/idea X" y no "/mbot idea X".
const COMANDOS_RAIZ = ["new", "add", "birthday", "idea", "ideas", "admin"];

// Devuelve el comando equivalente, o null si el mensaje no nos arroba. Exigimos
// que la mención ABRA el mensaje: así un "gracias @MotiBot" en medio de una
// charla no dispara nada, y la intención de darle una orden es inequívoca.
function comandoDeArroba(message) {
  const body = (message.body || "").trim();
  const m = body.match(/^@(\S+)\s*([\s\S]*)$/);
  if (!m) return null;

  const token = m[1];
  const soloDigitos = token.replace(/\D/g, "");
  const esElBot = /^motibot$/i.test(token) || (soloDigitos && idsDelBot.has(soloDigitos));
  if (!esElBot) return null;

  const resto = (m[2] || "").trim();
  if (!resto) return "/mbot help";
  if (resto.startsWith("/")) return resto; // "@MotiBot /mbot phrase"

  const primera = resto.split(/\s+/)[0].toLowerCase();
  return COMANDOS_RAIZ.includes(primera) ? `/${resto}` : `/mbot ${resto}`;
}

async function processMessage(message) {
  if (message.timestamp && message.timestamp < ARRANQUE_TS) return;

  // Si nos arrobaron, reescribimos el body al comando equivalente y de ahí en
  // más el mensaje viaja como cualquier otro: todo lo de abajo (y commands.js)
  // lo ve como si hubieran tipeado /mbot.
  const porArroba = comandoDeArroba(message);
  if (porArroba) message.body = porArroba;

  const body = message.body?.trim() || "";

  // 450 = comando(10) + frase(300) + autor(50) + margen de comillas/guiones.
  if (!body.startsWith("/") || body.length > 450) return;

  const from = message.from;

  try {
    const lowerBody = body.toLowerCase();

    const empiezaCon = (cmd) => lowerBody === cmd || lowerBody.startsWith(cmd + " ");
    const esComando =
      lowerBody.startsWith("/mbot") ||
      lowerBody.startsWith("/new ") ||
      empiezaCon("/add") ||
      empiezaCon("/birthday") ||
      empiezaCon("/idea") ||
      empiezaCon("/ideas") ||
      empiezaCon("/admin");
    if (!esComando) return;

    // Un grupo siempre trae message.author; el privado no. En privado MotiBot
    // solo atiende /mbot phrase (y /mbot stop, que handleCommand filtra por
    // permisos): el resto se descarta acá, sin loguear ni responder. La
    // excepción es el super admin, cuyo privado funciona como un chat más.
    // esSuperAdmin puede pegarle al contacto para resolver un @lid, por eso va
    // último: solo corre para comandos reales fuera de la lista corta.
    const esGrupo = from.endsWith("@g.us") || !!message.author;
    const PRIVADOS_OK = ["/mbot phrase", "/mbot stop"];
    if (!esGrupo && !PRIVADOS_OK.includes(lowerBody) && !(await esSuperAdmin(message))) return;

    const msgId = message.id?._serialized || message.id?.id;
    if (yaProcesado(msgId)) return;

    const logBody = body.length > 100 ? body.slice(0, 100) + "... (recortado)" : body;

    console.log(`\n🚀 [${new Date().toLocaleTimeString("es-AR")}] Comando detectado de ${from}: "${logBody}"`);

    await conTimeout(handleCommand(message, client), REPLY_TIMEOUT, `comando "${logBody}"`);
    timeoutsReplySeguidos = 0; // respondió ok → la página está sana
  } catch (error) {
    console.error("❌ Error en processMessage:", error.message);

    // timeout/target-closed repetido (sin estar re-vinculando) = página colgada.
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

// Votación de ideas: solo nos interesan las reacciones sobre un listado de
// /ideas; el resto ni toca la base (handleReaction corta si no hay poll).
// Llega una por CADA reacción de la cuenta, en cualquier chat. handleReaction
// descarta las ajenas con una consulta a SQLite, sin tocar la página.
client.on("message_reaction", async (reaction) => {
  try {
    await handleReaction(reaction, client);
  } catch (error) {
    console.error("❌ Error en message_reaction:", error.message);
  }
});

// Destruimos el cliente (cierra Chromium, libera el lock) ANTES de salir — si
// no, queda huérfano con SingletonLock y el próximo arranque falla.
let cerrando = false;
async function cerrarLimpio(code, motivo) {
  if (cerrando) return; // evita cierres múltiples en ráfaga
  cerrando = true;
  console.error(`🛑 Cerrando proceso (${motivo}). Liberando Chromium...`);

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
    limpiarLocksHuerfanos();
    process.exit(code);
  }
}

// Al límite marca la sesión para borrar en el próximo boot (reiniciar sin
// limpiar solo repite el loop); si no, reinicio normal y que PM2 levante.
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

  // Antes esperábamos que la lib se recuperara sola mostrando QR de nuevo, pero
  // esa "auto-recuperación" entra en loop de re-inject porque restauramos la
  // misma sesión muerta. Ahora escalamos: el contador termina borrándola.
  if (String(reason).toUpperCase().includes("LOGOUT")) {
    console.error("🚨 Sesión invalidada (LOGOUT). Reinicio limpio; si insiste, borro la sesión muerta para re-vincular.");
    necesitaAuth = true;
    estuvoReady = false;
    pairingSolicitado = false;
    ultimoPairingCode = null;
    dispararAlertaRevinculacion();
    escalarReinicioInestable("disconnected: LOGOUT");
    return;
  }

  // otros motivos: la lib no se recupera sola → salimos y PM2 reinicia con backoff.
  cerrarLimpio(1, `disconnected: ${reason}`);
});

// El bot puede detectar mensajes con la página en estado != CONNECTED (TIMEOUT,
// OPENING) sin que se dispare 'disconnected' — los replies quedan pending eterno.
// Sondeamos getState(); si no vuelve CONNECTED en 2 chequeos, escalamos reinicio.
const WATCHDOG_INTERVAL = 60 * 1000; // sondeo cada 60s
const WATCHDOG_TOLERANCIA = 2;       // fallos seguidos (~2min) antes de reiniciar
let fallosWatchdog = 0;
let watchdogArmado = false;

function getStateConTimeout(ms = 15000) {
  return conTimeout(client.getState(), ms, "getState");
}

function armarWatchdog() {
  if (watchdogArmado) return; // idempotente: 'ready' puede redisparar
  watchdogArmado = true;
  setInterval(async () => {
    // esperando re-vinculación (UNPAIRED) o cerrando: no cuenta como fallo.
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
  }, WATCHDOG_INTERVAL).unref();
}

process.on("SIGINT", () => cerrarLimpio(0, "SIGINT"));
process.on("SIGTERM", () => cerrarLimpio(0, "SIGTERM"));

// Ocurre al inicializar cuando WhatsApp navega y destruye el contexto de
// Puppeteer; inofensivo si ya está 'ready'. Si pasa durante initialize(), lo
// maneja el catch de startBot().
process.on('unhandledRejection', (reason, promise) => {
    const msg = reason?.message || "";

    if (msg.includes('Execution context was destroyed')) {
        console.warn('⚠️ Contexto de Puppeteer destruido (ignorado si el bot ya está listo).');
        return;
    }

    console.error('🚨 Error no manejado detectado:', reason);
});


const express = require("express");
const app = express();
app.use(express.json());
// Puerto propio (no choca con otros servicios del server, p.ej. WebAmankay=3000).
// Si cambia, ajustar también el túnel de Cloudflare en deploy.yml.
const PORT = process.env.PORT || 3001;

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

// Guarda la llave en el dispositivo apenas se entra a un panel válido. Antes
// solo se guardaba al tipearla en el formulario, así que quien entraba por un
// link con la llave tenía que ingresarla igual en la visita siguiente.
function scriptRecordarLlave(groupId, key) {
  return `<script>
    try { localStorage.setItem('mbot_key_${groupId}', ${JSON.stringify(key)}); } catch (e) {}
  </script>`;
}

// Misma pantalla de llave para el panel de frases y el de ideas.
function paginaLogin(group, groupId, key) {
  return `
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
          const CLAVE = 'mbot_key_${groupId}';
          // Si llegamos acá CON una llave, es porque no sirve: la borramos para
          // no reintentar con la misma en cada visita.
          if (window.location.search.includes('key')) localStorage.removeItem(CLAVE);

          window.onload = () => {
            const saved = localStorage.getItem(CLAVE);
            if (saved && !window.location.search.includes('key')) window.location.href = "?key=" + encodeURIComponent(saved);
          };
          function login() {
            const t = document.getElementById('tInput').value.trim();
            if(t) { localStorage.setItem(CLAVE, t); window.location.href = "?key=" + encodeURIComponent(t); }
          }
        </script>
      </body>
      </html>
    `;
}

app.get("/frases/:groupId", (req, res) => {
  const { groupId } = req.params;
  const { key } = req.query;
  const group = db.getGroup(groupId);
  const groupToken = db.getGroupToken(groupId);

  if (!group) return res.status(404).send("<h1 style='text-align:center;'>Grupo no encontrado</h1>");

  if (!key || key !== groupToken) {
    return res.send(paginaLogin(group, groupId, key));
  }

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
        .btn-idea { background: #ffc107; color: #212529; text-decoration: none; display: inline-block; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h3 style="margin:0">📚 ${safeHTML(group.group_name)} (${frases.length})</h3>
          <div style="display:flex; gap:8px;">
            <a class="btn btn-idea" href="/ideas/${encodeURIComponent(groupId)}?key=${encodeURIComponent(key)}">💡 Ideas (${db.countIdeas(groupId)})</a>
            <button class="btn btn-out" onclick="logout()">Cerrar Sesión 🔒</button>
          </div>
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
      ${scriptRecordarLlave(groupId, key)}
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

// Panel de ideas: mismo grupo, misma llave que /frases. Se entra por el botón
// del panel de frases.
app.get("/ideas/:groupId", (req, res) => {
  const { groupId } = req.params;
  const { key } = req.query;
  const group = db.getGroup(groupId);
  const groupToken = db.getGroupToken(groupId);

  if (!group) return res.status(404).send("<h1 style='text-align:center;'>Grupo no encontrado</h1>");
  if (!key || key !== groupToken) return res.send(paginaLogin(group, groupId, key));

  const ideas = db.getIdeasRanking(groupId);
  const maxVotos = ideas.reduce((max, i) => Math.max(max, i.votes), 0);

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8"><title>Ideas - ${group.group_name}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        :root { --bg: #f8f9fa; --border: #dee2e6; --danger: #dc3545; --gold: #ffc107; }
        body { font-family: sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #212529; }
        .container { max-width: 900px; margin: auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); overflow: hidden; }
        .header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        .idea-row { display: flex; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--border); gap: 15px; }
        .idea-row:hover { background: #f1f3f5; }
        .content-col { flex-grow: 1; }
        .idea-text { font-weight: 500; }
        .votes { min-width: 90px; text-align: right; font-weight: bold; color: #856404; }
        .bar { height: 6px; background: var(--gold); border-radius: 3px; margin-top: 6px; }
        .btn { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; font-weight: bold; }
        .btn-del { background: var(--danger); color: white; }
        .btn-back { background: #6c757d; color: white; text-decoration: none; display: inline-block; }
        .actions-bar { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #343a40; color: white; padding: 12px 25px; border-radius: 50px; display: none; align-items: center; gap: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
        .empty { padding: 40px; text-align: center; color: #6c757d; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h3 style="margin:0">💡 Ideas — ${safeHTML(group.group_name)} (${ideas.length})</h3>
          <a class="btn btn-back" href="/frases/${encodeURIComponent(groupId)}?key=${encodeURIComponent(key)}">← Volver a frases</a>
        </div>
        ${ideas.length === 0
          ? `<div class="empty">Todavía no hay ideas. Se cargan desde el grupo con <code>/idea &lt;recomendación&gt;</code>.</div>`
          : ideas.map(i => `
            <div class="idea-row">
              <input type="checkbox" class="i-cb" value="${i.id}" onchange="updateBar()">
              <div class="content-col">
                <span class="idea-text">${safeHTML(i.text)}</span>
                <div><small>— ${safeHTML(i.author)} · ID #${i.id}</small></div>
                ${i.votes > 0 ? `<div class="bar" style="width:${maxVotos ? Math.round((i.votes / maxVotos) * 100) : 0}%"></div>` : ''}
              </div>
              <div class="votes">🗳️ ${i.votes}</div>
            </div>
          `).join('')}
      </div>
      <div id="aBar" class="actions-bar">
        <span id="cText">0 seleccionadas</span>
        <button class="btn btn-del" onclick="deleteSelected()">🗑️ Borrar Seleccionadas</button>
      </div>
      ${scriptRecordarLlave(groupId, key)}
      <script>
        function updateBar() {
          const n = document.querySelectorAll('.i-cb:checked').length;
          document.getElementById('aBar').style.display = n > 0 ? 'flex' : 'none';
          document.getElementById('cText').innerText = n + " seleccionadas";
        }
        async function deleteSelected() {
          if(!confirm('¿Borrar ideas seleccionadas? También se borran sus votos.')) return;
          const ids = Array.from(document.querySelectorAll('.i-cb:checked')).map(c => c.value);
          const key = new URLSearchParams(window.location.search).get('key') || localStorage.getItem('mbot_key_${groupId}');

          try {
            const res = await fetch(window.location.pathname, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ideaIds: ids, key: key })
            });
            if(res.ok) window.location.reload();
            else {
              const err = await res.json();
              alert('❌ Error: ' + (err.error || 'No se pudo borrar'));
            }
          } catch(e) { alert('❌ Error de conexión al servidor.'); }
        }
      </script>
    </body>
    </html>
  `);
});

app.delete("/ideas/:groupId", (req, res) => {
  const { groupId } = req.params;
  const { ideaIds, key } = req.body;

  const groupToken = db.getGroupToken(groupId);
  if (!key || key !== groupToken) {
    console.warn("⚠️ Intento de borrado de ideas RECHAZADO: llave incorrecta.");
    return res.status(401).json({ error: "Llave maestra incorrecta o caducada." });
  }

  try {
    db.deleteIdeas(groupId, ideaIds || []);
    console.log(`✅ Se borraron ${(ideaIds || []).length} ideas del grupo ${groupId}.`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error borrando ideas:", error);
    res.status(500).json({ error: "Error interno del servidor al borrar." });
  }
});

// Muestra el código de pairing EN VIVO. El mail manda acá. Token-protegida.
app.get("/pair", (req, res) => {
  if (!PAIR_TOKEN || req.query.key !== PAIR_TOKEN) {
    return res.status(401).send("<h1 style='font-family:sans-serif;text-align:center'>🔒 Acceso denegado</h1>");
  }

  if (!necesitaAuth) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="15"></head>
      <body style="font-family:sans-serif;background:#0b141a;color:#fff;text-align:center;padding-top:60px">
      <h1>✅ Bot conectado</h1><p>No hace falta vincular nada. Esta página se refresca sola.</p>
      </body></html>`);
  }

  // Opt-in: solo pedimos código al abrir esta página (con el token), no en el
  // flujo automático de QR, para no desestabilizar el bot solo.
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

// Monitor externo (UptimeRobot/healthchecks) hace ping acá.
app.get("/health", (req, res) => {
  res.status(necesitaAuth ? 503 : 200).json({
    connected: !necesitaAuth,
    everConnected: estuvoReady,
    ts: new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`🌐 Servidor Web activo en puerto ${PORT}`));

console.log("🚀 Iniciando MotiBot...");

async function startBot(intentos = 3, demora = 8000) {
  // Si un ciclo previo marcó la sesión como muerta, la borramos ANTES de
  // restaurar — si no, restauraríamos el cadáver y volveríamos al loop.
  if (fs.existsSync(CLEAN_FLAG)) {
    console.warn("🧹 Marca de limpieza presente: borro sesión muerta + backup para arranque limpio.");
    borrarSesionYBackup();
    try { fs.rmSync(CLEAN_FLAG, { force: true }); } catch (e) { /* nada */ }
    resetContadorInestable();
  }

  // Si el perfil vivo perdió la sesión pero hay backup, restauramos antes de
  // inicializar y evitamos el QR.
  restaurarSesionSiHaceFalta();

  for (let i = 1; i <= intentos; i++) {
    limpiarLocksHuerfanos();

    try {
      await client.initialize();
      return;
    } catch (err) {
      const msg = err.message || "";
      const recuperable =
        msg.includes("Execution context was destroyed") ||
        msg.includes("browser is already running") ||
        msg.includes("WS endpoint URL");

      if (recuperable && i < intentos) {
        console.warn(`⚠️ Error recuperable en intento ${i}/${intentos} (${msg.slice(0, 60)}). Reintentando en ${demora / 1000}s...`);
        await new Promise(r => setTimeout(r, demora));
      } else {
        // sin más intentos → dejamos que PM2 reinicie con backoff.
        console.error(`❌ Error fatal en initialize() (intento ${i}/${intentos}):`, msg);
        process.exit(1);
      }
    }
  }
}

startBot();

module.exports = { client, syncGroups };
