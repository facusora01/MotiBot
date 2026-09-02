const db = require("./database");
const { getTunnelUrl } = require("./tunnel-url");
const { handleAdminPanel, AYUDA: AYUDA_PANEL } = require("./panel");
const alertas = require("./alertas");
const matba = require("./matba");
const carry = require("./carry");
const historia = require("./historia");

const { exec } = require("child_process");

const userCooldowns = new Map();
const COOLDOWN_TIME = 5 * 60 * 1000;

// En privado MotiBot es solo un dispensador de frases: ventana propia y mucho
// más larga que la de los grupos, y Map aparte para que pedir en un grupo no
// consuma el turno del privado (ni al revés).
const privateCooldowns = new Map();
const PRIVATE_COOLDOWN_TIME = 12 * 60 * 60 * 1000;

// Cache de admins (válido por 2 minutos para no consultar WhatsApp constantemente)
const adminCache = new Map(); // { groupId_userId: { isAdmin: boolean, timestamp: number } }
const ADMIN_CACHE_TIME = 2 * 60 * 1000;

// ⚡ Cache de participantes por grupo. getChat() en grupos grandes serializa
// TODA la lista de participantes por Puppeteer (lento). Sin esto, cada usuario
// distinto dispara su propio getChat. Con esto: 1 getChat por grupo cada 2min.
const groupChatCache = new Map(); // { groupId: { participants: [], timestamp: number } }

function getAdminCacheKey(groupId, userId) {
  return `${groupId}_${userId}`;
}

function getCachedAdmin(groupId, userId) {
  const key = getAdminCacheKey(groupId, userId);
  const cached = adminCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < ADMIN_CACHE_TIME) {
    return cached.isAdmin;
  }
  return null;
}

function setCachedAdmin(groupId, userId, isAdmin) {
  const key = getAdminCacheKey(groupId, userId);
  adminCache.set(key, { isAdmin, timestamp: Date.now() });
}

function clearAdminCache() {
  adminCache.clear();
  groupChatCache.clear();
}

// 🧹 Purga periódica: elimina entradas vencidas para que los Maps no crezcan infinito.
// Sin esto, cada usuario único deja basura permanente → fuga de memoria en runtime largo.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of adminCache) {
    if (now - val.timestamp >= ADMIN_CACHE_TIME) adminCache.delete(key);
  }
  for (const [userId, ts] of userCooldowns) {
    if (now - ts >= COOLDOWN_TIME) userCooldowns.delete(userId);
  }
  for (const [userId, ts] of privateCooldowns) {
    if (now - ts >= PRIVATE_COOLDOWN_TIME) privateCooldowns.delete(userId);
  }
  for (const [gid, val] of groupChatCache) {
    if (now - val.timestamp >= ADMIN_CACHE_TIME) groupChatCache.delete(gid);
  }
}, 10 * 60 * 1000).unref(); // unref: no bloquea el cierre del proceso

// ─── AYUDA ───────────────────────────────────────────────────────────────────
const HELP_TEXT = `
🤖 *¡Hola! Soy MotiBot, tu dosis diaria de buena energía.* ✨

Acá tenés todo lo que puedo hacer por vos y tu equipo:

*🛠️ Configuración (Solo Admins):*
▸ \`/mbot add\` — Sumarme al equipo para mandar frases diarias
▸ \`/mbot remove\` — Despedirme del equipo 😢
▸ \`/mbot lang es|en\` — Cambiar idioma (Español 🇦🇷 / Inglés 🇬🇧)
▸ \`/mbot clock HH:MM\` — Ajustar mi hora de visita diaria
▸ \`/mbot freq <1-6>\` — Ajustar cuántas veces paso por día
▸ \`/mbot use custom\` — Iniciar transición a frases del equipo
▸ \`/mbot use default\` — Volver a las frases clásicas
▸ \`/mbot frases on|off\` — Prender o apagar las frases, cumples e ideas
▸ \`/mbot mercado on|off\` — Prender o apagar la pizarra de granos diaria

*📚 Gestión de Frases:*
▸ \`/new "Frase" - Autor\` — Sumar a la colección
▸ \`/add\` (en reply) — Guardar el mensaje citado como frase (autor = quien lo escribió)
▸ \`/mbot phrase\` — Recibir una frase ya mismo
▸ \`/mbot list\` — 🌐 Panel Web para gestionar la colección

*🎂 Cumpleaños:*
▸ \`/birthday @persona dd/mm/yyyy\` — Cargar un cumple (día/mes/año)
▸ \`/birthday list\` — Ver todos los cumples cargados

*💡 Ideas para el bot:*
▸ \`/idea <recomendación>\` — Proponer una mejora (en una línea)
▸ \`/ideas\` — Ver el listado y votar reaccionando con emojis
▸ \`/ideas list\` — 🌐 Panel Web con todas las ideas y sus votos (admins)

*🚜 Mercado de granos:*
▸ \`/mbot mercado\` — Cotización del día (trigo, soja, maíz, sorgo y girasol)
▸ \`/mbot alerta soja 600000\` — Avisar cuando la pizarra toque ese precio
▸ \`/mbot alertas\` — Ver las alertas de este chat
▸ \`/mbot precio soja\` — Dónde cae el precio de hoy contra su historia
▸ \`/mbot carry soja\` — Vender hoy o guardar, con los números a la vista
▸ \`/mbot granos\` — *Cómo se usa todo esto, explicado*

*💡 Información y Ansiedad:*
▸ \`/mbot time\` — ⏳ Cuenta regresiva para activación de librería custom
▸ \`/mbot status\` — Ver reporte detallado de configuración
▸ \`/mbot help\` — Ver este menú de nuevo

_💡 Tip: en vez de \`/mbot\` también podés arrobarme: \`@MotiBot phrase\`, \`@MotiBot help\`, etc._
`.trim();

// Comandos reservados: NO salen en el `/mbot help` de nadie, ni siquiera en un
// grupo donde el mercado esté habilitado. El único lugar donde se listan es el
// help que pide el super admin desde su chat privado.
const HELP_SECRETO = `
🔐 *Comandos reservados* _(solo vos)_

*🚨 Emergencia:*
▸ \`/mbot stop\` — Apagar motibot y el túnel (se vuelve a levantar por SSH)
▸ \`/mbot sync\` — Sincronización global de grupos`;

const SEPARADOR = "━━━━━━━━━━━━━━━━━━━━";

// Menú de un grupo en modo solo mercado: mostrarle el HELP_TEXT completo sería
// ofrecerle comandos que ahí no responden.
const HELP_SOLO_MERCADO = `
🚜 *MotiBot — Mercado de granos* 🌾

En este equipo estoy solo para la pizarra de cotizaciones:

▸ \`/mbot mercado\` — Ver la cotización del día
▸ \`/mbot mercado on|off\` — Prender o apagar la pizarra diaria (admins)
▸ \`/mbot alerta soja 600000\` — Avisar cuando la pizarra toque ese precio
▸ \`/mbot precio soja\` — Dónde cae el precio de hoy contra su historia
▸ \`/mbot carry soja\` — Vender hoy o guardar, con los números a la vista
▸ \`/mbot granos\` — *Cómo se usa todo esto, explicado*

_Todos los días la mando sola, apenas se publica el tablero._

_📖 Cómo se usa todo esto, explicado:_ \`/mbot granos\`

_💡 ¿Quieren además las frases diarias, los cumpleaños y las ideas? Un admin las prende con_ \`/mbot frases on\`_._
`.trim();

// Antes estos comandos cortaban en silencio si el chat no estaba registrado, y
// el bot parecía colgado: leía el comando y no contestaba nada. Ahora avisan.
const NO_REGISTRADO = "❌ ¡Todavía no me adoptaron en este chat! Un admin tiene que usar `/mbot add` primero.";

// ─── UTILS ────────────────────────────────────────────────────────────────────
// Números/lids con permisos de emergencia (/mbot stop, sync, activación custom
// instantánea). Vienen del .env coma-separados — son teléfonos reales, no van
// hardcodeados en un repo público.
const SUPER_ADMINS = (process.env.SUPER_ADMINS || "")
  .split(",").map((s) => s.trim().replace(/\D/g, "")).filter(Boolean);

// Un id @lid no es el teléfono: hay que pasar por el contacto para poder
// compararlo contra SUPER_ADMINS (números reales del .env).
async function resolverNumero(message) {
  let rawSenderId = message.author || message.from;

  if (rawSenderId && rawSenderId.includes('@lid')) {
    try {
      const contact = await message.getContact();
      if (contact && contact.number) {
        rawSenderId = contact.number + '@c.us';
      }
    } catch (e) {}
  }

  return String(rawSenderId || "").split('@')[0].split(':')[0];
}

async function esSuperAdmin(message) {
  return SUPER_ADMINS.includes(await resolverNumero(message));
}

async function isAdmin(message, client) {
  try {
    const number = await resolverNumero(message);

    if (SUPER_ADMINS.includes(number)) return true;

    const groupId = message.from;
    const cached = getCachedAdmin(groupId, number);
    if (cached !== null) return cached;

    // ⚡ Reusamos la lista de participantes cacheada del grupo si está fresca,
    // así no hacemos getChat() (caro en grupos grandes) por cada usuario nuevo.
    let participants;
    const chatCached = groupChatCache.get(groupId);
    if (chatCached && (Date.now() - chatCached.timestamp) < ADMIN_CACHE_TIME) {
      participants = chatCached.participants;
    } else {
      const chat = await message.getChat();
      if (!chat.isGroup) return false;
      participants = chat.participants || [];
      groupChatCache.set(groupId, { participants, timestamp: Date.now() });
    }

    const participant = participants.find((p) => {
      const pNumber = p.id.user || p.id._serialized.split('@')[0].split(':')[0];
      return pNumber === number;
    });

    const isAdminResult = participant?.isAdmin || participant?.isSuperAdmin || false;
    setCachedAdmin(groupId, number, isAdminResult);
    
    return isAdminResult;
  } catch (error) {
    console.error("❌ Error en isAdmin:", error.message);
    return false;
  }
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function getTimeRemaining(targetDate) {
  const now = new Date();
  const diff = new Date(targetDate) - now;
  
  if (diff <= 0) return null;

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  return `${hours}h ${minutes}m`;
}

// Nombre legible de un contacto de WhatsApp. pushname = nombre que el usuario se
// puso; name/shortName = como lo tenés agendado. Caemos al número solo si no hay
// nada (y a "Anónimo" si ni eso). Evita mostrar el id/lid crudo.
function nombreContacto(contact) {
  if (!contact) return "Anónimo";
  return contact.pushname || contact.name || contact.shortName ||
         contact.verifiedName || contact.number || "Anónimo";
}

// Nombre del AUTOR de un mensaje sin depender de getContact() — que en whatsapp-
// web.js explota con identidades @lid ("Cannot read ... '_serialized'"). Orden:
//   1. notifyName del raw data: es el pushname del emisor, ya viene en el mensaje.
//   2. getContact() como respaldo (envuelto: si tira, seguimos).
//   3. getContactById sobre el id del autor.
async function nombreDeMensaje(client, msg) {
  const notify = msg?._data?.notifyName;
  if (notify) return notify;

  try {
    const n = nombreContacto(await msg.getContact());
    if (n && n !== "Anónimo") return n;
  } catch (e) { /* @lid rompe getContact → seguimos al próximo intento */ }

  try {
    const id = msg.author || msg.from;
    if (client && id) {
      const n = nombreContacto(await client.getContactById(id));
      if (n && n !== "Anónimo") return n;
    }
  } catch (e) { /* sin suerte → Anónimo */ }

  return "Anónimo";
}

// El body de WhatsApp guarda las menciones como "@<id>" (número/lid), no el
// nombre. Las reemplazamos por "@Nombre" resolviendo cada id mencionado vía
// getContactById (no usamos getMentions: arma Contact y revienta con @lid).
async function resolverMenciones(client, msg, texto) {
  const ids = msg?.mentionedIds || msg?._data?.mentionedJidList || [];
  if (!ids.length || !client) return texto;
  let out = texto;
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw : raw?._serialized;
    if (!id) continue;
    const idUser = id.split("@")[0];
    let nombre = idUser; // si no resolvemos, dejamos el id (mejor que romper)
    try {
      const n = nombreContacto(await client.getContactById(id));
      if (n && n !== "Anónimo") nombre = n;
    } catch (e) {}
    out = out.split(`@${idUser}`).join(`@${nombre}`);
  }
  return out;
}

// getQuotedMessage() evalúa en la página y explota (error minificado tipo "r: r")
// cuando el mensaje citado ya no está en el Store: mensajes viejos, borrados, o
// de una sesión anterior a este arranque. Ese raw sí viaja dentro del mensaje que
// cita, así que armamos un mensaje "de mentira" con lo que necesitamos (body,
// menciones, autor) para no perder el /add.
async function obtenerCitado(client, message) {
  try {
    const quoted = await message.getQuotedMessage();
    if (quoted) return quoted;
  } catch (e) {
    console.warn("⚠️ getQuotedMessage falló, uso el raw del mensaje:", e.message);
  }

  const raw = message?._data?.quotedMsg;
  if (!raw) return null;

  const part = message._data.quotedParticipant;
  const autorId = typeof part === "string" ? part : part?._serialized;

  return {
    body: raw.body || raw.caption || "",
    author: autorId,
    from: autorId,
    mentionedIds: raw.mentionedJidList || [],
    _data: {
      notifyName: raw.notifyName,
      mentionedJidList: raw.mentionedJidList || [],
    },
  };
}

// Nombre legible a partir de un id (para los @arrobados, que no traen mensaje
// propio del cual sacar notifyName).
async function nombrePorId(client, id) {
  try {
    const n = nombreContacto(await client.getContactById(id));
    if (n && n !== "Anónimo") return n;
  } catch (e) { /* @lid sin contacto conocido → caemos al número */ }
  return String(id).split("@")[0];
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
               "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function fechaEnPalabras(month, day) {
  return `${day} de ${MESES[month - 1]}`;
}

// Formato dd/mm/yyyy, como se escribe acá. Acepta con o sin ceros a la
// izquierda (4/7/2001 y 04/07/2001 son lo mismo). Devolvemos el error ya
// redactado para que el comando solo tenga que reenviarlo.
function parsearFechaCumple(texto) {
  const m = texto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return { error: "formato" };

  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);

  if (month < 1 || month > 12) {
    // Caso típico de quien viene del formato americano: 12/25 en vez de 25/12.
    const pista = day <= 12 ? `\n\n_¿Escribiste el mes primero? Acá va el día: ${month}/${day}/${year}._` : "";
    return { error: `El mes ${month} no existe. El formato es *dd/mm/yyyy* (primero el día).${pista}` };
  }

  // Construimos la fecha y verificamos que no se haya "corrido": new Date(2000, 1, 30)
  // devuelve el 1 de marzo en silencio, y así el 30/2 pasaría como válido.
  const fecha = new Date(year, month - 1, day);
  if (fecha.getMonth() !== month - 1 || fecha.getDate() !== day) {
    return { error: `El ${day} de ${MESES[month - 1]} no existe. Revisá la fecha.` };
  }

  const hoy = new Date();
  if (year < 1900 || fecha > hoy) return { error: "Esa fecha no puede ser: revisá el año." };

  return { month, day, year };
}

// Edad que cumple hoy (o que cumplió en la última vuelta). Sin año guardado
// devuelve null y el saludo sale sin número.
function edadEnCumple(year, month, day, hoy = new Date()) {
  if (!year) return null;
  let edad = hoy.getFullYear() - year;
  // Antes de la fecha del año en curso todavía no los cumplió.
  const yaPaso = (hoy.getMonth() + 1 > month) || (hoy.getMonth() + 1 === month && hoy.getDate() >= day);
  if (!yaPaso) edad -= 1;
  return edad;
}

// ─── IDEAS ────────────────────────────────────────────────────────────────────
const IDEA_MIN = 10;
const IDEA_MAX = 200;   // "muy resumida": una línea, no un ensayo
const IDEAS_POR_DIA = 3;
const VOTO_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const IDEAS_VOTABLES = VOTO_EMOJIS.length;

// El emoji de reacción puede llegar con o sin selector de variación (U+FE0F)
// según el cliente que reaccionó; normalizamos para que "1️⃣" y "1⃣" sean lo mismo.
function normalizarEmoji(e) {
  return String(e || "").replace(/️/g, "").trim();
}

// Arma el texto del listado y el mapa emoji → idea para registrar los votos.
function construirListadoIdeas(ideas) {
  const votables = ideas.slice(0, IDEAS_VOTABLES);
  const mapping = {};

  const lineas = votables.map((idea, i) => {
    const emoji = VOTO_EMOJIS[i];
    mapping[normalizarEmoji(emoji)] = idea.id;
    const votos = idea.votes === 1 ? "1 voto" : `${idea.votes} votos`;
    return `${emoji} ${idea.text}\n     _${votos} · por ${idea.author}_`;
  });

  let texto =
    `💡 *Ideas para mejorar MotiBot* 💡\n\n` +
    `${lineas.join("\n\n")}\n\n` +
    `🗳️ *Para votar:* reaccioná a ESTE mensaje con el número de la idea que más te guste.\n` +
    `_Una reacción por persona: si cambiás el emoji, cambiás tu voto._`;

  const resto = ideas.length - votables.length;
  if (resto > 0) {
    texto += `\n\n📋 Hay ${resto} idea${resto === 1 ? "" : "s"} más en el panel web (\`/ideas list\`).`;
  }

  return { texto, mapping };
}

// ─── BOTÓN DE PÁNICO ──────────────────────────────────────────────────────────
// El chequeo de permisos queda afuera (lo hace el llamador con resolverNumero):
// a quien no está autorizado no se le responde nada en ningún lado.
async function detenerEmergencia(message, number) {
  await message.reply("⚠️ *PROTOCOLO DE EMERGENCIA ACTIVADO* ⚠️\n\nApagando procesos `motibot` y `cloudflare-tunnel` inmediatamente. Para volver a subir el sistema, deberás entrar por SSH al servidor.");

  console.error(`🚨 DETENCIÓN DE EMERGENCIA solicitada por ${number} a las ${new Date().toISOString()}`);

  exec("pm2 stop motibot cloudflare-tunnel", (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Error al ejecutar el stop: ${error.message}`);
      return;
    }
    console.log(`✅ Procesos detenidos: ${stdout}`);
  });
}

// ─── CHAT PRIVADO ─────────────────────────────────────────────────────────────
// Un grupo siempre trae message.author (el remitente dentro del grupo); en el
// privado no existe. Miramos las dos cosas para no depender solo del sufijo del
// chat: los ids @lid de WhatsApp son privados, pero el día que un grupo llegue
// con uno, author lo delata igual y sigue tratándose como grupo.
function esChatPrivado(message) {
  const chatId = String(message.fromMe ? message.to : message.from || "");
  return !chatId.endsWith("@g.us") && !message.author;
}

// En privado MotiBot hace UNA sola cosa: dar una frase con /mbot phrase. No
// registra el chat en la base (no hay grupo que adoptar), no contesta ningún
// otro comando y no manda el "todavía no me adoptaron" — cualquier otra cosa
// se ignora en silencio. Los grupos no pasan por acá.
async function handlePrivateCommand(message) {
  const userId = String(message.from || "");
  const now = Date.now();

  // El super admin pide sin límite; al resto le toca la ventana de 12 h.
  const superAdmin = await esSuperAdmin(message);

  if (!superAdmin) {
    const lastUsed = privateCooldowns.get(userId);
    const timeLeft = lastUsed ? lastUsed + PRIVATE_COOLDOWN_TIME - now : 0;

    if (timeLeft > 0) {
      const horas = Math.ceil(timeLeft / (60 * 60 * 1000));
      return message.reply(`⏳ Ya te pasé la tuya. Te espero en ${horas} h para la próxima.`);
    }
  }

  // Sin grupo no hay librería custom ni idioma configurado: siempre el pool
  // clásico en español, pre-cargado (respuesta instantánea).
  const { getPhraseInstant } = require("./phrases");
  const frase = getPhraseInstant("es");

  const emojis = ["🌟", "💪", "🔥", "✨", "🚀", "🌈", "⚡", "🎯", "💡", "🏆"];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];

  if (!superAdmin) privateCooldowns.set(userId, now);

  return message.reply(`${emoji} _"${frase.texto}"_

— *${frase.autor}*`);
}

// Comandos que una persona cualquiera puede usar en el privado del bot. El
// resto se sigue ignorando en silencio: el privado no es una consola.
const PRIVADO_PREFIJOS = ["/mbot help", "/mbot mercado", "/mbot frases", "/mbot alerta", "/mbot alertas", "/mbot precio", "/mbot carry", "/mbot granos"];

function empiezaConAlguno(lowerBody, prefijos) {
  return prefijos.some((c) => lowerBody === c || lowerBody.startsWith(c + " "));
}

// En un privado la persona es dueña de su chat: no hay admins que consultar.
async function puedeConfigurar(message, client) {
  if (esChatPrivado(message)) return true;
  return isAdmin(message, client);
}

// En el privado no existe el /mbot add: el chat se registra solo, la primera
// vez que la persona prende algo, y sin nada más prendido de arrastre.
async function asegurarChatPrivado(message, client, chatId) {
  if (db.getGroup(chatId)?.active) return;
  const nombre = await nombreDeMensaje(client, message);
  db.registrarChatPrivado(chatId, nombre || "Privado");
}

// El server puede correr en UTC: la rueda "de hoy" tiene que ser la argentina.
function hoyArgentinaISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Cuántas ruedas mirar hacia atrás para las comparaciones: dos años, que cubre
// el promedio de 90 ruedas y el mínimo/máximo de los últimos 12 meses con
// margen para feriados.
function desdeDosAnios(hastaISO) {
  const d = new Date(`${hastaISO}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

// La cotización del día. Se pide desde varios lados (grupo, privado registrado
// y privado suelto), así que el manejo del error vive en un solo lugar.
async function responderCotizacion(message) {
  try {
    const { getMercado } = require("./mercado");
    const { texto } = await getMercado();
    return message.reply(texto);
  } catch (error) {
    console.error("❌ Error leyendo la pizarra de granos:", error.message);
    return message.reply("⚠️ No pude leer la pizarra de granos ahora mismo. Probá de nuevo en un rato.");
  }
}

// Guía de las funciones de granos, en castellano y con ejemplos. Existe
// porque las descripciones de una línea del menú no alcanzan: "carry" es
// jerga, y quien no conoce la palabra nunca va a tipear el comando para
// llegar a la explicación que vive adentro. Acá se puede leer antes.
const GUIA_GRANOS = `
🚜 *MotiBot y el mercado de granos* 🌾

Cuatro cosas, de la más simple a la más pesada.

*1️⃣ La pizarra del día*
\`/mbot mercado\`
Los precios de hoy de trigo, soja, maíz, sorgo y girasol, con cuánto
cambiaron respecto de ayer y el dólar. Un admin puede hacer que llegue sola
todos los días con \`/mbot mercado on\`.

*2️⃣ Que te avisen cuando llegue a un precio*
\`/mbot alerta soja 600000\`
Vos ponés el número; el día que la pizarra lo toque, te aviso acá. El
criterio es tuyo: yo no sugiero precios, solo miro el tablero todos los
días, que es lo que vos no podés hacer.
Te aviso *una sola vez* y la borro, para no repetirlo cada día.
Ver las tuyas: \`/mbot alertas\` · Borrar: \`/mbot alerta borrar 1\`

*3️⃣ ¿El precio de hoy es alto o bajo?*
\`/mbot precio soja\`
Te muestro dónde cae el precio de hoy comparado con su propia historia: el
promedio de las últimas 30 y 90 ruedas, el mínimo y el máximo del año, y
cuántas de esas ruedas estuvieron por debajo del de hoy.
Va en dólares y en pesos. *Mirá el de dólares*: el de pesos sube también
por inflación y devaluación, así que un \"+8%\" en pesos puede no ser mercado.
No es un pronóstico. No digo si va a subir ni si conviene vender.

*4️⃣ ¿Vendo ahora o guardo?*
\`/mbot carry soja\`
El mercado a término paga un precio distinto por entregar más adelante. Si
esa diferencia le gana a lo que te cuesta tener el grano guardado, el
mercado te está pagando por esperar. Si no, te está pagando por vender ya.

Es una resta, no una predicción, y necesita *tus dos números*:
▸ *Almacenaje* — lo que te cuesta tener una tonelada guardada un mes, en
dólares. La tarifa del acopio, o la silobolsa prorrateada.
▸ *Tasa* — el costo anual del dinero que no cobrás mientras no vendés.

Se cargan una vez: \`/mbot carry costos 3 8\`
_(US$ 3 por tonelada por mes, 8% anual)_

No pongo valores por defecto a propósito: el que tiene silo propio y el que
alquila tienen respuestas opuestas, y las dos están bien.

━━━━━━━━━━━━━━━━━━━━
_Todo esto es información de referencia y nunca una recomendación de venta._
_Fuentes: pizarra ACAbase y Matba Rofex, con la fecha en cada mensaje._
_Sirve para decidir mejor, no para decidir por vos._
`.trim();

// Menú del privado: corto, solo lo que ahí se puede hacer.
const HELP_PRIVADO = `
🤖 *MotiBot por privado*

Acá podés tener lo tuyo, sin molestar a ningún grupo:

*🚜 Mercado de granos:*
▸ \`/mbot mercado\` — Cotización del día
▸ \`/mbot mercado on\` — Que te la mande todos los días acá
▸ \`/mbot mercado off\` — Dejar de recibirla

*🔔 Alertas de precio:*
▸ \`/mbot alerta soja 600000\` — Avisarte cuando la soja toque ese precio
▸ \`/mbot alertas\` — Ver las tuyas
▸ \`/mbot alerta borrar <n>\` — Borrar una
▸ \`/mbot precio soja\` — Dónde cae el precio de hoy contra su historia
▸ \`/mbot carry soja\` — Vender hoy o guardar, con tus costos
▸ \`/mbot granos\` — *Cómo se usa todo esto, explicado*

*✨ Frases:*
▸ \`/mbot phrase\` — Una frase ahora (una cada 12 h)
▸ \`/mbot frases on\` — Recibir la frase del día todos los días acá
▸ \`/mbot frases off\` — Dejar de recibirla

_El aviso de una alerta llega solo acá: nadie más lo ve._
`.trim();

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
async function handleCommand(message, client) {
  try {
    const body = message.body?.trim() || "";
    const lowerBody = body.toLowerCase();
    const groupId = message.fromMe ? message.to : message.from;

    const parts = body.split(/\s+/);
    const subcommand = (parts[1] || "").toLowerCase();
    const arg = (parts[2] || "").toLowerCase();

    // Privado: para el super admin no hay recorte (su chat se maneja como
    // cualquier otro: puede /mbot add, list, stop, lo que sea). Para el resto,
    // solo /mbot phrase con su espera; todo lo demás en silencio — incluido el
    // /mbot stop de un número no autorizado, que acá ni se reconoce como
    // comando. El corte va ANTES de tocar la base para que el privado de un
    // usuario común nunca quede registrado como equipo.
    if (esChatPrivado(message)) {
      const superAdmin = await esSuperAdmin(message);

      if (!superAdmin) {
        // La frase por privado conserva su ventana propia de 12 h esté o no
        // suscripto el chat: suscribirse no puede ser la vía para pedir más
        // seguido que el resto.
        if (lowerBody === "/mbot phrase") return handlePrivateCommand(message);

        // Lo demás que se puede hacer en un privado (mercado, alertas, la
        // suscripción a las frases). Cualquier otra cosa, silencio.
        if (!empiezaConAlguno(lowerBody, PRIVADO_PREFIJOS)) return;
      }

      // Mientras el super admin no adopte su propio privado con /mbot add, le
      // damos la frase por la vía corta (sin límite) en vez del "no me adoptaron".
      if (lowerBody === "/mbot phrase" && !db.getGroup(groupId)?.active) {
        return handlePrivateCommand(message);
      }
    }

    // Panel del super admin: solo en su chat privado. En un grupo el comando ni
    // existe (tampoco para él): la gestión de otros equipos no se expone ahí.
    if (lowerBody === "/admin" || lowerBody.startsWith("/admin ")) {
      if (!esChatPrivado(message) || !(await esSuperAdmin(message))) return;
      return handleAdminPanel(message, client);
    }

    // Grupos en modo "solo mercado": el super admin apagó las frases ahí, y
    // MotiBot deja de atender toda la parte motivacional (frases, cumples,
    // ideas). No contesta que está apagado ni nada: directamente no escucha,
    // así en un equipo que solo quiere la pizarra el bot no aparece nunca sin
    // que lo llamen. Quedan afuera del silencio los comandos que tienen que
    // funcionar igual: la pizarra, el menú, el alta/baja y el botón de pánico.
    const SOLO_MERCADO_OK = [
      "/mbot mercado", "/mbot frases", "/mbot alerta", "/mbot alertas",
      "/mbot precio", "/mbot carry", "/mbot granos",
      "/mbot help", "/mbot add", "/mbot remove", "/mbot stop", "/mbot sync",
    ];
    if (!esChatPrivado(message) && !db.isPhrasesEnabled(groupId) &&
        !empiezaConAlguno(lowerBody, SOLO_MERCADO_OK)) {
      return;
    }

    let group = db.getGroup(groupId);

    // 🚨 BOTÓN DE PÁNICO (Solo Sora / Super Admins)
    if (subcommand === "stop") {
      // A quien no está autorizado no se le contesta nada, ni en grupo ni en
      // privado: para el resto del mundo este comando no existe.
      const number = await resolverNumero(message);
      if (!SUPER_ADMINS.includes(number)) return;

      return detenerEmergencia(message, number);
    }

    // ── /new "frase" - autor ──────────────────────────────────────────────────
    if (body.toLowerCase().startsWith("/new ")) {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply(NO_REGISTRADO);

      const content = body.slice(5).trim();
      let phrase = content;
      let author = "Anónimo";

      const quoteMatch = content.match(/^[""](.+?)[""](?:\s*[-–]\s*(.+))?$/);
      if (quoteMatch) {
        phrase = quoteMatch[1].trim();
        if (quoteMatch[2]) author = quoteMatch[2].trim();
      } else {
        const dashIdx = content.lastIndexOf(" - ");
        if (dashIdx !== -1) {
          phrase = content.slice(0, dashIdx).trim();
          author = content.slice(dashIdx + 3).trim();
        }
      }
      
      // Menciones (@id → @Nombre) por si la frase nombra a alguien del grupo.
      phrase = await resolverMenciones(client, message, phrase);

      // 🛡️ LIMPIEZA DE UI: Convertimos todos los saltos de línea y espacios
      // múltiples en un solo espacio para que no "estiren" la tabla web.
      phrase = phrase.replace(/\s+/g, ' ').trim();

      if (!phrase || phrase.length < 5) {
        return message.reply('❌ ¡Uy, esa frase es muy cortita!\nEscribila así: `/new "Tu frase inspiradora" - Autor`');
      }

      if (phrase.length > 300) {
        return message.reply(`❌ ¡Epa! Esa frase es un testamento de ${phrase.length} caracteres.\nPor favor, resumila a un máximo de 300 para no saturar la base de datos.`);
      }

      const addedBy = await nombreDeMensaje(client, message);

      db.addCustomPhrase(groupId, phrase, author, addedBy);

      const count = db.countCustomPhrases(groupId);
      const settings = db.getGroupSettings(groupId);

      let avisoCustom = "";
      if (!settings || settings.use_custom === "default") {
        avisoCustom = "\n\n💡 *Nota:* Guardé la frase, pero todavía estoy usando mi libro clásico. Cuando un admin active el modo custom con `/mbot use custom`, empezarán a salir estas frases.";
      }

      if (count >= 60 && settings?.use_custom === "pending") {
        db.activateCustomNow(groupId);
        return message.reply(
          `🎊 ¡MÁXIMA PRODUCTIVIDAD! 🎊\n\nAlcanzamos las ${count} frases. Ya no hace falta esperar los 2 días. *¡El modo Custom ya está activo!* 🚀`
        );
      }

      return message.reply(
        `✅ ¡Qué buena frase! Ya la guardé en nuestra caja fuerte.\n\n_"${phrase}"_ — *${author}*\n\n📚 Con esta ya tenemos ${count} frases listas para brillar.${avisoCustom}`
      );
      
    }

    // ── /add (en reply) → guarda el mensaje citado como frase ─────────────────
    // Misma lógica que /new pero la frase es el mensaje al que se respondió y el
    // autor es quien lo escribió (no quien ejecuta /add, que queda en added_by).
    if (lowerBody === "/add" || lowerBody.startsWith("/add ")) {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply(NO_REGISTRADO);

      if (!message.hasQuotedMsg) {
        return message.reply('💡 Para usar `/add`, respondé (reply) al mensaje que querés guardar como frase.');
      }

      const quoted = await obtenerCitado(client, message);

      if (!quoted) {
        return message.reply("❌ No pude leer ese mensaje citado (puede ser muy viejo o estar borrado). Probá con `/new <frase> — <autor>`.");
      }

      // 🛡️ Solo guardamos TEXTO. Aceptamos mensajes escritos y captions de
      // imagen/video (vienen en body). Si no hay texto (sticker, audio/voz,
      // imagen sin epígrafe, ubicación...), cortamos rápido antes de procesar.
      if (!quoted.body || !quoted.body.trim()) {
        return message.reply("❌ Ese mensaje no tiene texto para guardar. Respondé a un mensaje escrito, o a una imagen/video con epígrafe (no sticker ni audio).");
      }

      // Resolvemos las menciones (@id → @Nombre) ANTES de colapsar espacios.
      let phrase = await resolverMenciones(client, quoted, quoted.body || "");
      phrase = phrase.replace(/\s+/g, ' ').trim();

      if (!phrase || phrase.length < 5) {
        return message.reply('❌ Ese mensaje es muy cortito para guardarlo como frase.');
      }
      if (phrase.length > 300) {
        return message.reply(`❌ ¡Epa! Ese mensaje es un testamento de ${phrase.length} caracteres.\nSolo guardo frases de hasta 300 para no saturar la base.`);
      }

      // 🛡️ AUTOR = quien escribió el mensaje citado. added_by = quien ejecutó /add.
      const author = await nombreDeMensaje(client, quoted);
      const addedBy = await nombreDeMensaje(client, message);

      db.addCustomPhrase(groupId, phrase, author, addedBy, "add");

      const count = db.countCustomPhrases(groupId);
      const settings = db.getGroupSettings(groupId);

      let avisoCustom = "";
      if (!settings || settings.use_custom === "default") {
        avisoCustom = "\n\n💡 *Nota:* Guardé la frase, pero todavía estoy usando mi libro clásico. Cuando un admin active el modo custom con `/mbot use custom`, empezarán a salir estas frases.";
      }

      if (count >= 60 && settings?.use_custom === "pending") {
        db.activateCustomNow(groupId);
        return message.reply(
          `🎊 ¡MÁXIMA PRODUCTIVIDAD! 🎊\n\nAlcanzamos las ${count} frases. *¡El modo Custom ya está activo!* 🚀`
        );
      }

      return message.reply(
        `✅ ¡Buenísima! Sumé el mensaje a nuestra caja fuerte.\n\n_"${phrase}"_ — *${author}*\n\n📚 Con esta ya tenemos ${count} frases listas para brillar.${avisoCustom}`
      );
    }

    // ── /birthday @persona dd/mm/yyyy ─────────────────────────────────────────
    if (lowerBody === "/birthday" || lowerBody.startsWith("/birthday ")) {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply(NO_REGISTRADO);

      const resto = body.slice("/birthday".length).trim();
      const USO = "🎂 *Cómo cargar un cumpleaños:*\n\n`/birthday @persona dd/mm/yyyy`\n\n" +
                  "Ejemplo: `/birthday @juan 8/4/2000` = 8 de abril de 2000.\n" +
                  "_Los ceros son opcionales: `8/4/2000` y `08/04/2000` valen igual._\n\n" +
                  "Para ver los cargados: `/birthday list`";

      if (!resto) return message.reply(USO);

      if (resto.toLowerCase() === "list") {
        const lista = db.getBirthdaysList(groupId);
        if (!lista.length) {
          return message.reply("🎂 Todavía no hay ningún cumpleaños cargado. Sumá uno con `/birthday @persona dd/mm/yyyy`.");
        }
        const lineas = lista.map((b) => {
          const anio = b.year ? ` (${b.year})` : "";
          return `▸ *${b.name || "Alguien"}* — ${fechaEnPalabras(b.month, b.day)}${anio}`;
        });
        return message.reply(`🎂 *Cumpleaños del grupo* (${lista.length})\n\n${lineas.join("\n")}`);
      }

      // mentionedIds puede traer strings o ids serializados según la versión.
      const menciones = (message.mentionedIds || message._data?.mentionedJidList || [])
        .map((raw) => (typeof raw === "string" ? raw : raw?._serialized))
        .filter(Boolean);

      if (menciones.length !== 1) {
        return message.reply(
          menciones.length === 0
            ? `❌ Falta arrobar a la persona.\n\n${USO}`
            : `❌ Un cumpleaños por vez: arrobá a una sola persona.\n\n${USO}`
        );
      }

      const fecha = parsearFechaCumple(resto);
      if (fecha.error) {
        return message.reply(
          fecha.error === "formato"
            ? `❌ No encontré la fecha.\n\n${USO}`
            : `❌ ${fecha.error}`
        );
      }

      const userId = menciones[0];
      const nombre = await nombrePorId(client, userId);
      const addedBy = await nombreDeMensaje(client, message);

      db.setBirthday(groupId, userId, nombre, fecha.month, fecha.day, fecha.year, addedBy);

      const edad = edadEnCumple(fecha.year, fecha.month, fecha.day);
      // Repetimos la fecha en palabras a propósito: si alguien escribió el día
      // primero (dd/mm), acá lo ve al instante y lo corrige repitiendo el comando.
      return message.reply(
        `🎂 ¡Anotado! Voy a saludar a *${nombre}* cada *${fechaEnPalabras(fecha.month, fecha.day)}*.\n\n` +
        `📅 Fecha guardada: ${fecha.day}/${fecha.month}/${fecha.year} _(día/mes/año)_\n` +
        `🎈 Hoy tiene ${edad} años.\n\n` +
        `_Si la fecha no es esa, repetí el comando con la correcta y la piso._`
      );
    }

    // ── /ideas → listado votable (va ANTES de /idea: comparten prefijo) ────────
    if (lowerBody === "/ideas" || lowerBody.startsWith("/ideas ")) {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply(NO_REGISTRADO);

      // /ideas list → panel web, mismo esquema que /mbot list: link público y
      // llave al privado del admin (la llave del grupo abre los dos paneles).
      if (lowerBody.slice("/ideas".length).trim() === "list") {
        const adminStatus = await isAdmin(message, client);
        if (!adminStatus) {
          return message.reply("🔒 ¡Alto ahí! Solo los admins pueden pedir la llave del panel.");
        }

        const baseUrl = getTunnelUrl();
        if (!baseUrl) {
          return message.reply("⚠️ Error de configuración: no hay URL de túnel disponible.");
        }

        const token = db.getGroupToken(groupId);
        if (!token) {
          return message.reply("⚠️ Error: Este grupo no tiene un token de seguridad generado.");
        }

        await message.reply(
          `💡 *Panel de Ideas - ${group.group_name}*\n\n` +
          `Entren acá para ver todas las ideas y sus votos:\n👉 ${baseUrl}/ideas/${groupId}\n\n` +
          `_(Nota: Se requiere la llave de acceso enviada al administrador)_`
        );

        try {
          const adminId = message.author || message.from;
          await client.sendMessage(adminId,
            `🔐 *Llave Maestra Privada*\n\n` +
            `Entrá directo al panel de ideas de *${group.group_name}*:\n` +
            `👉 ${baseUrl}/ideas/${groupId}?key=${token}\n\n` +
            `Tu dispositivo va a recordar el acceso, no hace falta volver a ingresarla.\n\n` +
            `Si te la piden igual, el token es:\n*${token}*\n\n` +
            `⚠️ _No compartas este mensaje con nadie del grupo._`
          );
        } catch (error) {
          console.error("❌ Error enviando la llave por privado:", error);
          return message.reply("⚠️ No pude mandarte la llave por mensaje privado. ¿Me tenés bloqueado?");
        }
        return; // ya mandamos los dos mensajes (público + llave privada)
      }

      const ideas = db.getIdeasList(groupId);
      if (!ideas.length) {
        return message.reply("💡 Todavía no hay ideas. Tirá la primera con `/idea <tu recomendación>`.");
      }

      const { texto, mapping } = construirListadoIdeas(ideas);

      // Sin id no hay votación. Tres vías: el retorno del envío, el evento
      // message_create y la colección del chat. El listener va antes de enviar.
      const espera = esperarIdDelEnviado(client, groupId, texto);

      let enviado;
      try {
        enviado = await message.reply(texto, undefined, { waitUntilMsgSent: true });
      } catch (e) {
        espera.cancelar();
        throw e;
      }

      let msgId = idSerializado(enviado?.id);
      let via = "envío";
      console.log(`🔎 [1/3] envío devolvió: ${msgId || "nada"}`);

      if (msgId) {
        espera.cancelar();
      } else {
        const porEvento = await espera.promesa;
        msgId = idSerializado(porEvento?.id);
        via = "message_create";
        console.log(`🔎 [2/3] message_create: ${msgId || "no llegó ningún mensaje propio con esa cabecera"}`);
      }

      if (!msgId) {
        msgId = await buscarIdDelListadoEnChat(client, groupId, texto);
        via = "colección del chat";
        console.log(`🔎 [3/3] colección del chat: ${msgId || "no encontré el mensaje"}`);
      }

      if (msgId) {
        db.saveIdeaPoll(msgId, groupId, mapping);
        console.log(`💡 Listado guardado (id vía ${via}): ${msgId}`);
      } else {
        console.warn("⚠️ No pude guardar el listado de ideas: el mensaje no devolvió id.");
        // Sin poll guardado los votos no se cuentan, y en silencio parecería que
        // WhatsApp no registra las reacciones. Mejor decirlo.
        await message.reply("⚠️ Ojo: no pude habilitar la votación en ese listado. Volvé a mandar `/ideas` en un ratito.");
      }

      return;
    }

    // ── /idea <texto> → propuesta de mejora ───────────────────────────────────
    if (lowerBody === "/idea" || lowerBody.startsWith("/idea ")) {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply(NO_REGISTRADO);

      let texto = body.slice("/idea".length).trim().replace(/\s+/g, " ");

      if (!texto) {
        return message.reply(
          "💡 *¿Qué mejorarías de MotiBot?*\n\n" +
          "`/idea <tu recomendación en una línea>`\n\n" +
          `Ejemplo: \`/idea que la frase del viernes sea de humor\`\n` +
          `_Máximo ${IDEA_MAX} caracteres. Una idea por mensaje._`
        );
      }

      if (texto.length < IDEA_MIN) {
        return message.reply(`❌ Muy cortito. Contame la idea en al menos ${IDEA_MIN} caracteres.`);
      }
      if (texto.length > IDEA_MAX) {
        return message.reply(
          `❌ ¡Frená! Esa idea tiene ${texto.length} caracteres y el tope son ${IDEA_MAX}.\n` +
          `Resumila en una línea: qué querés que haga distinto.`
        );
      }

      const authorId = message.author || message.from;
      const yaHoy = db.countIdeasHoyDeAutor(groupId, authorId);
      if (yaHoy >= IDEAS_POR_DIA) {
        return message.reply(`⏳ Ya propusiste ${yaHoy} ideas hoy. Guardá el resto para mañana así no se satura el listado.`);
      }

      const author = await nombreDeMensaje(client, message);
      db.addIdea(groupId, texto, author, authorId);
      const total = db.countIdeas(groupId);

      return message.reply(
        `💡 ¡Gracias! Anoté tu idea.\n\n_"${texto}"_\n\n` +
        `📋 Van ${total} idea${total === 1 ? "" : "s"} en total.\n` +
        `Mirá el listado y votá con \`/ideas\`.`
      );
    }

   // ── /mbot ... ─────────────────────────────────────────────────────────────
    if (!body.toLowerCase().startsWith("/mbot")) return;

    if (!subcommand) {
      return message.reply('❓ ¡Me dejaste por la mitad! Usá `/mbot help` para ver cómo pedirme las cosas.');
    }

    // --- guía de granos ---
    // Sin gate de mercado prendido: es justamente lo que alguien lee para
    // saber si le sirve prenderlo.
    if (subcommand === "granos" || subcommand === "grano") {
      return message.reply(GUIA_GRANOS);
    }

    // --- precio: dónde cae el de hoy contra su propia historia ---
    // Descriptivo, nunca predictivo: promedios, mínimo y máximo, y en qué
    // percentil del último año cae hoy. Ni tendencias ni proyecciones: con
    // una serie de precios spot se fabrican señales que suenan seguras y no
    // valen nada.
    if (subcommand === "precio" || subcommand === "carry") {
      // Mismo criterio que la cotización: donde la pizarra está apagada,
      // esto tampoco corresponde.
      if (!esChatPrivado(message) && !db.isMarketEnabled(groupId)) {
        return message.reply("🔕 La pizarra de granos está apagada en este equipo.\n\n_Un admin puede prenderla con_ `/mbot mercado on`.");
      }

      // /mbot carry costos <almacenaje> <tasa>
      if (subcommand === "carry" && (arg === "costos" || arg === "costo")) {
        const almacenaje = Number(String(parts[3] || "").replace(",", "."));
        const tasa = Number(String(parts[4] || "").replace(",", "."));

        if (!Number.isFinite(almacenaje) || almacenaje < 0 || almacenaje > 50 ||
            !Number.isFinite(tasa) || tasa < 0 || tasa > 100) {
          return message.reply(
            "⚙️ *Supuestos del carry*\n\n" +
            "`/mbot carry costos <almacenaje> <tasa>`\n\n" +
            "▸ *Almacenaje*: lo que te cuesta tener una tonelada guardada un mes, en dólares. La tarifa del acopio, o lo que te sale la silobolsa prorrateada." + `\n` +
            "▸ *Tasa*: el costo anual del dinero que no cobrás mientras no vendés, en dólares." + `\n\n` +
            "Ejemplo: `/mbot carry costos 3 8` = US$ 3/t por mes y 8% anual." + `\n\n` +
            "_Son tus números, no hay default: el que tiene silo propio y el que alquila tienen respuestas distintas y las dos están bien._"
          );
        }

        if (!(await puedeConfigurar(message, client))) {
          return message.reply("🔒 ¡Alto ahí! Solo los administradores del equipo pueden cambiar esto.");
        }

        db.setCarryCostos(groupId, almacenaje, tasa);
        return message.reply(
          `⚙️ Anotado: almacenaje *US$ ${almacenaje}/t/mes* y costo del dinero *${tasa}% anual* en dólares.` +
          `\n\nAhora podés pedir \`/mbot carry soja\` (o trigo, o maíz).`
        );
      }

      const grano = alertas.parsearGrano(arg);
      if (!grano) {
        return message.reply(
          subcommand === "precio"
            ? "📊 `/mbot precio <grano>` — dónde cae el precio de hoy contra su historia." + `\n\n` + "Granos: trigo, soja, maíz, sorgo, girasol."
            : "🚜 `/mbot carry <grano>` — vender hoy o guardar, con los números a la vista." + `\n\n` + "Granos con futuros: soja, trigo, maíz." + `\n` + "Configurar tus costos: `/mbot carry costos <almacenaje> <tasa>`"
        );
      }

      const hoyISO = hoyArgentinaISO();

      if (subcommand === "precio") {
        try {
          const serie = await historia.serieParaComparar(grano, hoyISO, carry.MINIMO_UTIL);
          if (!serie.length) {
            return message.reply(`⚠️ No conseguí historia de ${alertas.nombreGrano(grano)} ahora mismo. Probá en un rato.`);
          }
          return message.reply(carry.mensajeComparacion(grano, serie));
        } catch (error) {
          console.error("❌ Error leyendo la historia de Matba Rofex:", error.message);
          return message.reply("⚠️ No pude leer la historia del mercado ahora mismo. Probá de nuevo en un rato.");
        }
      }

      // --- carry ---
      if (!matba.tieneFuturos(grano)) {
        return message.reply(
          `📉 *${alertas.nombreGrano(grano)}* no cotiza a término en Matba Rofex, así que no hay futuro contra el cual comparar y el carry no se puede calcular.` +
          `\n\n_Con futuros: soja, trigo y maíz._`
        );
      }

      const costos = db.getCarryCostos(groupId);
      if (!costos) {
        return message.reply(
          "⚙️ Antes de calcular el carry necesito *tus* dos números:" + `\n\n` +
          "▸ *Almacenaje* — lo que te cuesta tener una tonelada guardada un mes, en dólares." + `\n` +
          "▸ *Tasa* — el costo anual del dinero que no cobrás mientras no vendés, en dólares." + `\n\n` +
          "`/mbot carry costos 3 8`  _(US$ 3/t por mes, 8% anual)_" + `\n\n` +
          "_No pongo valores por defecto a propósito: el que tiene silo propio y el que alquila en el acopio tienen respuestas opuestas, y las dos son correctas._"
        );
      }

      try {
        const [disponible, posiciones] = await Promise.all([
          matba.getDisponible(grano, hoyISO),
          matba.getFuturos(grano, hoyISO),
        ]);

        if (!disponible.usd || !posiciones.length) {
          return message.reply(
            `⚠️ No conseguí la rueda de hoy de ${alertas.nombreGrano(grano)} (puede que todavía no haya cerrado, o que sea un día sin operaciones). Probá más tarde.`
          );
        }

        // Solo las posiciones con interés abierto de verdad: las de dos
        // contratos tienen precio publicado pero no son un mercado.
        const liquidas = posiciones.filter((p) => p.interesAbierto >= 100).slice(0, 4);
        const elegidas = liquidas.length ? liquidas : posiciones.slice(0, 3);

        let dolar = null;
        try {
          const { getMercado } = require("./mercado");
          dolar = (await getMercado())?.dolar?.venta ?? null;
        } catch (e) { /* la conversión a pesos es opcional */ }

        return message.reply(
          carry.mensajeCarry(grano, {
            spotUsd: disponible.usd,
            spotArs: disponible.ars,
            posiciones: elegidas,
            almacenajeMes: costos.almacenajeMes,
            tasaAnual: costos.tasaAnual,
            fecha: hoyISO,
            dolar,
          })
        );
      } catch (error) {
        console.error("❌ Error calculando el carry:", error.message);
        return message.reply("⚠️ No pude leer los futuros ahora mismo. Probá de nuevo en un rato.");
      }
    }

    // --- alertas de precio ---
    // Van antes de la validación de argumentos porque llevan dos (grano y
    // precio) y esas listas asumen uno solo. El umbral lo pone la persona:
    // MotiBot no sugiere números ni dice si conviene vender, solo avisa que
    // se tocó el precio que le pidieron mirar.
    if (subcommand === "alerta" || subcommand === "alertas") {
      const USO_ALERTA =
        "🔔 *Alertas de precio*\n\n`/mbot alerta <grano> <precio>`\n\nEjemplo: `/mbot alerta soja 600000` — te aviso el día que la pizarra la toque.\nGranos: trigo, soja, maíz, sorgo, girasol.\n\nVer las que tenés: `/mbot alertas`\nBorrar una: `/mbot alerta borrar <n>`";

      // Listado: /mbot alertas, o /mbot alerta list.
      const pideListado =
        subcommand === "alertas" || ["list", "lista", "ver"].includes(arg);

      if (pideListado) {
        const mias = db.getAlertasDeChat(groupId);
        if (!mias.length) {
          return message.reply("🔔 No hay ninguna alerta en este chat." + `\n\n` + USO_ALERTA);
        }
        return message.reply(
          `🔔 *Alertas de este chat* (${mias.length})\n\n` +
          mias.map((a, i) => alertas.describir(a, i)).join("\n") +
          `\n\n_Borrar una:_ \`/mbot alerta borrar <n>\``
        );
      }

      // Borrado: /mbot alerta borrar <n>, por el número del listado.
      if (arg === "borrar" || arg === "borra" || arg === "delete") {
        const mias = db.getAlertasDeChat(groupId);
        const n = parseInt(parts[3], 10);

        if (!Number.isInteger(n) || n < 1 || n > mias.length) {
          return message.reply(
            mias.length
              ? `❌ Elegí un número del 1 al ${mias.length} (mirá \`/mbot alertas\`).`
              : "🔔 No hay ninguna alerta para borrar en este chat."
          );
        }

        const victima = mias[n - 1];
        db.deleteAlerta(groupId, victima.id);
        return message.reply(
          `🗑️ Listo, borré la alerta de *${alertas.nombreGrano(victima.producto)}* en $ ${alertas.pesos(victima.objetivo)}.`
        );
      }

      if (!arg) return message.reply(USO_ALERTA);

      // Alta: /mbot alerta <grano> <precio>
      const grano = alertas.parsearGrano(arg);
      if (!grano) {
        return message.reply(`❌ No conozco el grano "${arg}".` + `\n\n` + USO_ALERTA);
      }

      const objetivo = alertas.parsearMonto(parts.slice(3).join(""));
      if (!objetivo) {
        return message.reply("❌ No entendí el precio. Escribilo en pesos por tonelada: `600000`, `600.000` o `600k`." + `\n\n` + USO_ALERTA);
      }

      if (db.countAlertasDeChat(groupId) >= db.MAX_ALERTAS_POR_CHAT) {
        return message.reply(
          `❌ Este chat ya tiene ${db.MAX_ALERTAS_POR_CHAT} alertas, que es el tope. Borrá alguna con \`/mbot alerta borrar <n>\`.`
        );
      }

      // Necesitamos el precio de hoy para saber si la alerta espera una suba
      // o una baja. Sin pizarra no se puede crear bien, y crearla con una
      // dirección inventada haría que dispare cuando no corresponde.
      let precioHoy = null;
      let fechaPizarra = null;
      try {
        const { getMercado } = require("./mercado");
        const mercado = await getMercado();
        fechaPizarra = mercado.fecha;
        precioHoy = mercado.granos.find((g) => g.codigo === grano)?.importe ?? null;
      } catch (error) {
        console.error("❌ No pude leer la pizarra para crear la alerta:", error.message);
      }

      if (precioHoy === null) {
        return message.reply("⚠️ No pude leer la pizarra ahora mismo, así que no sé si esperar una suba o una baja. Probá de nuevo en un rato.");
      }

      const direccion = alertas.direccionPara(precioHoy, objetivo);
      const quien = await nombreDeMensaje(client, message);
      const userId = message.author || message.from;

      db.addAlerta(groupId, userId, quien, grano, direccion, objetivo);

      const nombre = alertas.nombreGrano(grano);
      const emoji = alertas.emojiGrano(grano);
      const distancia = Math.abs(objetivo - precioHoy);
      const pct = precioHoy ? (distancia / precioHoy) * 100 : 0;
      const rumbo = direccion === "sube" ? "suba" : "baje";
      const donde = esChatPrivado(message) ? "acá, por privado" : "en este grupo";

      return message.reply(
        `🔔 *Alerta creada.*\n\n` +
        `${emoji} Te aviso cuando la *${nombre}* ${rumbo} a *$ ${alertas.pesos(objetivo)}*.` +
        `\n\nHoy está en $ ${alertas.pesos(precioHoy)} _(pizarra del ${fechaPizarra})_: falta que ${rumbo} $ ${alertas.pesos(distancia)}, un ${pct.toFixed(1).replace(".", ",")}%.` +
        `\n\nEl aviso llega ${donde}, una sola vez, y después la borro.` +
        `\n\n_Información de referencia, no es una recomendación de venta._`
      );
    }

    const UNKNOWN_MSG = `❓ ¡Epa! Ese comando no lo tengo en mi memoria. Usá \`/mbot help\` para ver mi manual de instrucciones.`;

    // parts = ["/mbot", subcommand, arg?] → length 2 = sin arg extra, 3 = con arg.
    const strictNoArg = ["phrase", "status", "help", "add", "remove", "list", "stop", "time"];
    const needsOneArg = ["lang", "use"];
    // mercado y frases: sin argumento consultan, con on/off cambian el estado.
    const optionalOneArg = ["clock", "freq", "mercado", "frases"];

    if (strictNoArg.includes(subcommand) && parts.length !== 2) return message.reply(UNKNOWN_MSG);
    if (needsOneArg.includes(subcommand) && parts.length !== 3) return message.reply(UNKNOWN_MSG);
    if (optionalOneArg.includes(subcommand) && (parts.length < 2 || parts.length > 3)) return message.reply(UNKNOWN_MSG);

    const allKnown = [...strictNoArg, ...needsOneArg, ...optionalOneArg];
    if (!allKnown.includes(subcommand)) return message.reply(UNKNOWN_MSG);

    // ─── PROCESAMIENTO DE COMANDOS VALIDADOS ──────────────────────────────────
    if (subcommand === "help") {
      // El manual completo (panel + reservados) sale únicamente en el privado
      // del super admin: en un grupo se ve el mismo help que ve cualquiera,
      // aunque quien lo pida sea él.
      //
      // Va PRIMERO lo que solo puede hacer él y último el menú común: son ~2700
      // caracteres y WhatsApp corta con "Leer más", así que lo que quedaba al
      // final (el panel, justamente) no se veía sin desplegar el mensaje.
      if (esChatPrivado(message) && (await esSuperAdmin(message))) {
        return message.reply(
          `${AYUDA_PANEL}\n\n${SEPARADOR}\n${HELP_SECRETO}\n\n${SEPARADOR}\n` +
          `_Y el menú que ve todo el mundo:_\n\n${HELP_TEXT}`
        );
      }
      // En un privado, el menú del privado: el HELP_TEXT habla de "el equipo",
      // los admins y los paneles del grupo, que ahí no aplican.
      if (esChatPrivado(message)) return message.reply(HELP_PRIVADO);

      // En un grupo solo-mercado, el menú corto: el resto de los comandos ahí
      // no responden, ofrecerlos sería mentir.
      if (!esChatPrivado(message) && !db.isPhrasesEnabled(groupId)) {
        return message.reply(HELP_SOLO_MERCADO);
      }

      return message.reply(HELP_TEXT);
    }

    if (subcommand === "status") {
      const group = db.getGroup(groupId);
      const settings = db.getGroupSettings(groupId);
      const customCount = db.countCustomPhrases(groupId);

      if (!group || !group.active) {
        return message.reply("❌ ¡Todavía no me adoptaron en este equipo!\nAlguien con permisos tiene que usar `/mbot add`.");
      }

      let customStatus = "❌ No activada";
      if (settings?.use_custom === "pending") {
        const remaining = getTimeRemaining(settings.custom_start_date);
        customStatus = `⏳ Pendiente (Faltan ${remaining || "pocos minutos"})`;
      } else if (settings?.use_custom === "active") {
        customStatus = `✅ ¡A pleno! (${customCount} frases en la colección)`;
      }

      return message.reply(
        `📊 *¡Acá tenés el reporte de MotiBot!* 🚀\n\n` +
        `📍 Equipo: ${group.group_name}\n` +
        `🌍 Idioma: ${settings?.language === "en" ? "Inglés 🇬🇧" : "Español 🇦🇷"}\n` +
        `📚 Librería Custom: ${customStatus}\n` +
        `🕗 Reloj: Funcionando perfecto`
      );
    }

    if (subcommand === "time") {
      const group = db.getGroup(groupId);
      const settings = db.getGroupSettings(groupId);
      const customCount = db.countCustomPhrases(groupId);

      if (!group || !group.active) return message.reply("❌ ¡Todavía no me adoptaron!");
      
      if (settings?.use_custom === "active") {
        return message.reply("✅ ¡La librería custom ya está activa y funcionando!");
      }

      if (settings?.use_custom === "pending") {
        const remaining = getTimeRemaining(settings.custom_start_date);
        
        if (customCount >= 60) {
          db.activateCustomNow(groupId);
          return message.reply(`🔥 ¡Detección de equipo productivo! 🔥\nCon ${customCount} frases ya no hace falta esperar. *¡Modo Custom activado ahora mismo!*`);
        }

        return message.reply(`⏳ *Cuenta regresiva:* Faltan *${remaining || "pocos minutos"}* para la activación automática.\n\n💡 _Tip de velocidad:_ Si llegan a las 60 frases antes, se activa al toque. (Llevan ${customCount}/60).`);
      }

      return message.reply("ℹ️ Actualmente estamos en modo clásico. Usá `/mbot use custom` para empezar la transición.");
    }

    // --- phrase ---
    if (subcommand === "phrase") {
      try {
        const group = db.getGroup(groupId);
        if (!group || !group.active) {
          return message.reply("❌ ¡Todavía no me adoptaron! Usen `/mbot add` primero.");
        }

        const userId = message.author || message.from;
        const now = Date.now();

        // ⚡ OPTIMIZACIÓN GRUPOS GRANDES: chequeamos el cooldown PRIMERO (en memoria,
        // instantáneo). Solo resolvemos admin (isAdmin → getChat, que en grupos
        // grandes serializa TODA la lista de participantes y tarda segundos) cuando
        // el user realmente está en cooldown y necesita el bypass. Así el caso común
        // (user sin cooldown) responde sin tocar Puppeteer.
        const lastUsed = userCooldowns.get(userId);
        const timeLeft = lastUsed ? lastUsed + COOLDOWN_TIME - now : 0;

        if (timeLeft > 0) {
          const adminStatus = await isAdmin(message, client);
          if (!adminStatus) {
            const minutes = Math.ceil(timeLeft / 1000 / 60);
            return message.reply(`⏳ ¡No tan rápido! Podés pedir otra frase en ${minutes} min.`);
          }
          // Admin dentro del cooldown → bypass, sigue de largo
        }

        db.checkAndActivateCustom(groupId);
        const settings = db.getGroupSettings(groupId);
        let frase = null;
        let isCustom = false;

        // MODO ESTRICTO: si está activo, SOLO busca en la librería del equipo —
        // sin fallback a remotas aunque esté vacía (para eso avisa más abajo).
        if (settings?.use_custom === "active") {
          const customPhrase = db.getRandomCustomPhrase(groupId);

          if (customPhrase) {
            frase = { texto: customPhrase.phrase, autor: customPhrase.author, source: customPhrase.source };
            isCustom = true;
          } else {
            return message.reply("⚠️ El modo custom está activo pero la lista del equipo está vacía. ¡Sumen frases con `/new`!");
          }
        } else {
          // 🌐 MODO CLÁSICO: Solo si el custom no está activo. Pool pre-cargado →
          // respuesta instantánea con diversidad remota (sin esperar la API).
          const { getPhraseInstant } = require("./phrases");
          frase = getPhraseInstant(settings?.language || "es");
        }

        const emojis = ["🌟", "💪", "🔥", "✨", "🚀", "🌈", "⚡", "🎯", "💡", "🏆"];
        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        
        const tag = isCustom
          ? "⭐ *Frase aleatoria (Edición)* ⭐"
          : `${emoji} *Frase del día* ${emoji}`;

        // 🗣️ marca las frases sumadas con /add (reply a un mensaje del grupo).
        const marca = frase.source === "add" ? "🗣️ " : "";
        const mensaje = `${tag}\n\n_"${frase.texto}"_\n\n— ${marca}*${frase.autor}*`;

        // Registramos el uso. Si un admin vuelve dentro de la ventana, el bypass
        // de arriba (isAdmin, cacheado 2min) lo dejará pasar igual.
        userCooldowns.set(userId, now);

        return message.reply(mensaje);

      } catch (error) {
        console.error("❌ Error en phrase:", error);
        return message.reply("⚠️ Hubo un error al buscar la frase.");
      }
    }

    // --- frases on|off ---
    // El admin del grupo decide si quiere el MotiBot completo o solo la
    // pizarra. Sin argumento, dice cómo está.
    if (subcommand === "frases") {
      // En un privado, prenderlas registra el chat; apagarlas o consultarlas no
      // tiene sentido si nunca hubo nada.
      if (esChatPrivado(message) && arg === "on") {
        await asegurarChatPrivado(message, client, groupId);
      }

      const group = db.getGroup(groupId);
      if (!group || !group.active) {
        return message.reply(
          esChatPrivado(message)
            ? "✨ Todavía no te estoy mandando nada por acá.\n\n_Para recibir la frase del día:_ `/mbot frases on`"
            : NO_REGISTRADO
        );
      }

      const prendidas = db.isPhrasesEnabled(groupId);

      if (!arg) {
        return message.reply(
          prendidas
            ? "✨ Las frases están *prendidas*: paso todos los días con una frase, saludo los cumpleaños y atiendo las ideas.\n\n_Para dejar solo el mercado de granos:_ `/mbot frases off`"
            : "🚜 Estoy en *modo solo mercado*: no mando frases ni saludo cumpleaños.\n\n_Para volver al MotiBot completo:_ `/mbot frases on`"
        );
      }

      if (arg !== "on" && arg !== "off") {
        return message.reply("❌ Usá `/mbot frases on` o `/mbot frases off`.");
      }

      if (!(await puedeConfigurar(message, client))) {
        return message.reply("🔒 ¡Alto ahí! Solo los administradores del equipo pueden cambiar esto.");
      }

      const encender = arg === "on";
      if (encender === prendidas) {
        return message.reply(encender ? "ℹ️ Las frases ya estaban prendidas." : "ℹ️ Ya estaba en modo solo mercado.");
      }

      db.setPhrasesEnabled(groupId, encender);

      if (encender) {
        const settings = db.getGroupSettings(groupId);
        return message.reply(
          `✨ *¡Volví completo!*\n\nPaso todos los días a las ${settings?.send_time || "08:00"} hs con una frase, saludo los cumpleaños y escucho sus ideas.\n\nMenú: \`/mbot help\``
        );
      }

      // Si tampoco hay mercado, el grupo se queda sin nada: hay que decirlo.
      const conMercado = db.isMarketEnabled(groupId);
      return message.reply(
        `🚜 *Modo solo mercado activado.*\n\n` +
        `Dejo de mandar la frase diaria, los cumpleaños y las ideas, y no respondo esos comandos.\n\n` +
        (conMercado
          ? `Sigo con la pizarra de granos de todos los días.`
          : `⚠️ Ojo: acá tampoco está prendido el mercado, así que no voy a hacer nada. Prendelo con \`/mbot mercado on\`.`) +
        `\n\n_Para volver atrás:_ \`/mbot frases on\``
      );
    }

    // --- mercado de granos ---
    // Sin argumento devuelve la cotización; con on/off un admin del grupo
    // prende o apaga la pizarra diaria. No hace falta que el super admin
    // autorice nada antes: quien la prende, la habilita.
    if (subcommand === "mercado") {
      // El privado se registra solo al prender la pizarra; para verla una vez
      // (sin argumento) no hace falta registrar nada.
      if (esChatPrivado(message) && arg === "on") {
        await asegurarChatPrivado(message, client, groupId);
      }

      const group = db.getGroup(groupId);
      if (!group || !group.active) {
        // En un privado sin registrar igual mostramos la cotización si la
        // piden: es información pública y no compromete a nada.
        if (!esChatPrivado(message)) return message.reply(NO_REGISTRADO);
        if (arg) {
          return message.reply("🚜 Todavía no te mando la pizarra por acá.\n\n_Para recibirla todos los días:_ `/mbot mercado on`");
        }
        return responderCotizacion(message);
      }

      if (arg === "on" || arg === "off") {
        if (!(await puedeConfigurar(message, client))) {
          return message.reply("🔒 ¡Alto ahí! Solo los administradores del equipo pueden cambiar esto.");
        }

        const encender = arg === "on";
        if (encender === db.isMarketEnabled(groupId)) {
          return message.reply(encender ? "ℹ️ La pizarra ya estaba prendida." : "ℹ️ La pizarra ya estaba apagada.");
        }

        db.setMarketEnabled(groupId, encender);
        const settings = db.getGroupSettings(groupId);

        return message.reply(
          encender
            ? `🚜 *Pizarra de granos activada.*\n\nTodos los días les paso la cotización, apenas se publica el tablero (no antes de las ${settings?.market_time || "09:00"} hs).\n\n_Verla ahora:_ \`/mbot mercado\`
_Además puedo avisarles cuando un grano toque un precio, y ayudarlos con la cuenta de vender o guardar:_ \`/mbot granos\``
            : `🔕 Listo, no mando más la cotización diaria.\n\n_Para volver a prenderla:_ \`/mbot mercado on\``
        );
      }

      if (arg) return message.reply("❌ Usá `/mbot mercado`, `/mbot mercado on` o `/mbot mercado off`.");

      // Sin argumento: la cotización, si la pizarra está prendida en el grupo.
      if (!db.isMarketEnabled(groupId)) {
        return message.reply("🔕 La pizarra de granos está apagada en este equipo.\n\n_Un admin puede prenderla con_ `/mbot mercado on`.");
      }

      return responderCotizacion(message);
    }

    // ── 1. Valid endpoints ──
    const validAdminCommands = ["add", "remove", "lang", "use", "clock", "freq", "list", "sync"];
    
    if (!validAdminCommands.includes(subcommand)) {
      return message.reply(`❓ ¡Epa! Ese comando no lo tengo en mi memoria. Usá \`/mbot help\` para ver mi manual de instrucciones.`);
    }

    // ── 2. Validar admin para los comandos que SÍ existen ──
    const admin = await isAdmin(message, client);
    if (!admin) {
      return message.reply("🔒 ¡Alto ahí! Solo los administradores del equipo tienen la llave para usar este comando.");
    }

    if (subcommand === "add") {
      // getChat() resuelve contra el Store de la página y revienta (error
      // minificado "r: r") si el chat no está cacheado — pasa con los ids @lid.
      // El nombre es solo cosmético: si no se puede leer, registramos igual.
      let nombreChat = null;
      try {
        const chat = await message.getChat();
        nombreChat = chat?.name || null;
      } catch (e) {
        console.warn(`⚠️ No pude leer el nombre del chat ${groupId}:`, e.message);
      }

      db.addGroup(groupId, nombreChat || `Equipo ${String(groupId).split("@")[0].slice(-4)}`);
      return message.reply(
        `✅ *¡Qué lindo estar acá!*\n\n` +
        `Hola a todos, soy **MotiBot** 🤖✨. A partir de mañana voy a pasar por este equipo todos los días para dejarles una frase motivacional y ayudarlos a arrancar con todo.\n\n` +
        `Si quieren ver qué más puedo hacer por ustedes, escriban \`/mbot help\`. ¡Nos leemos!`
      );
    }

    if (subcommand === "remove") {
      const group = db.getGroup(groupId);
      if (!group || !group.active) {
        return message.reply("❌ Mmm, me parece que yo no estaba registrado en este equipo.");
      }
      db.removeGroup(groupId);
      return message.reply("✅ Listo, ya armé mis valijas y no los molesto más. ¡Fue un re gusto! 😞\nSi alguna vez me extrañan, me pueden volver a llamar con `/mbot add`.");
    }

    if (subcommand === "lang") {
      const group = db.getGroup(groupId);
      if (!group || !group.active) {
        return message.reply("❌ ¡Todavía no me adoptaron! Usen `/mbot add` primero.");
      }

      if (arg !== "es" && arg !== "en") {
        return message.reply("❌ Mmm, ese idioma no lo tengo estudiado. Usá `/mbot lang es` o `/mbot lang en`.");
      }

      db.setLanguage(groupId, arg);
      const langName = arg === "en" ? "inglés 🇬🇧" : "español 🇦🇷";
      return message.reply(`✅ ¡Perfecto! Cambié mi chip al *${langName}*.\nA partir de mañana los saludo en ese idioma.`);
    }

    if (subcommand === "use") {
      const group = db.getGroup(groupId);
      if (!group || !group.active) {
        return message.reply("❌ ¡Todavía no me adoptaron! Usen `/mbot add` primero.");
      }

      if (arg === "custom") {
        const settings = db.getGroupSettings(groupId);
        if (settings?.use_custom === "active") {
          const count = db.countCustomPhrases(groupId);
          return message.reply(`ℹ️ ¡Ya estamos usando la librería custom, equipo! Tenemos ${count} frases cargadas y listas.`);
        }
        if (settings?.use_custom === "pending") {
          return message.reply(`⏳ ¡Paciencia! Ya estoy preparando la librería custom. Arrancamos el ${formatDate(settings.custom_start_date)}.`);
        }

        const senderId = message.author || message.from;
        const senderNumber = senderId.split('@')[0].split(':')[0];
        if (SUPER_ADMINS.includes(senderNumber)) {
          db.activateCustomNow(groupId);
          const count = db.countCustomPhrases(groupId);
          return message.reply(
            `🚀 *Activación inmediata de Super Admin*\n\n` +
            `Modo librería custom habilitado al instante, sin espera de 2 días.\n` +
            `Actualmente hay ${count} frases en la colección del equipo.`
          );
        }

        const startDate = db.requestCustomLibrary(groupId);
        return message.reply(
          `🔄 *¡Genial! Pasamos a modo Librería Custom* 🎨\n\n` +
          `📅 Denme *2 días* (hasta el ${formatDate(startDate)}) para organizar todo y empezar a mandarlas.\n` +
          `Mientras tanto, sigo usando mis frases clásicas para que no les falte motivación.\n\n` +
          `¡Vayan llenando la colección del equipo!\n` +
          `Solo tienen que escribir: \`/new "Tu frase acá" - Autor\`\n\n` +
          `💡 Cuantas más frases sumen, ¡más nos vamos a sorprender todos los días!`
        );
      }

      if (arg === "default") {
        db.switchToDefault(groupId);
        return message.reply("✅ Listo, volví a mi librito clásico de frases. Sus frases custom quedaron bien guardaditas por si algún día quieren volver a usarlas.");
      }

      return message.reply("❌ Me mareaste un poco. Usá `/mbot use custom` o `/mbot use default`.");
    }

    if (subcommand === "clock") {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply("❌ ¡Todavía no me adoptaron! Usen `/mbot add` primero.");

      if (!arg) {
        const time = db.getSendTime(groupId);
        return message.reply(`🕗 Actualmente tengo la alarma puesta a las *${time} hs* (Argentina).\n\n¿Quieren cambiarla? Pueden poner:\n▸ \`/mbot clock 15\` (para las 15:00)\n▸ \`/mbot clock 09:30\``);
      }

      let finalTime = "";
      // 1. Regex para formato completo (HH:MM)
      const timeRegexFull = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
      // 2. Regex para formato corto (Solo un número del 0 al 23)
      const timeRegexShort = /^([0-9]|1[0-9]|2[0-3])$/;

      if (timeRegexFull.test(arg)) {
        const match = arg.match(timeRegexFull);
        finalTime = `${match[1].padStart(2, "0")}:${match[2]}`;
      } else if (timeRegexShort.test(arg)) {
        
        
        finalTime = `${arg.padStart(2, "0")}:00`;
      } else {
        return message.reply("❌ ¡Esa hora no me suena! Usá un número del 0 al 23 o el formato HH:MM (ej: 15 o 15:30).");
      }

      db.setSendTime(groupId, finalTime);
      
      // ✅ Mensaje optimizado sin el "mañana"
      return message.reply(
        `✅ ¡Reloj ajustado! ⏰\n\n` +
        `Pasaré a saludarlos todos los días a las *${finalTime} hs*.\n` +
        `_(Si esa hora todavía no pasó hoy, ¡nos vemos en un rato!)_`
      );
    }

    if (subcommand === "freq") {
      const group = db.getGroup(groupId);
      if (!group || !group.active) {
        return message.reply("❌ ¡Todavía no me adoptaron! Usen `/mbot add` primero.");
      }

      if (!arg) {
        const settings = db.getGroupSettings(groupId);
        const freq = settings?.frequency || 1;
        const palabraVez = freq === 1 ? "vez" : "veces";
        return message.reply(`📢 Actualmente paso a dejarles motivación *${freq} ${palabraVez}* por día.\n\nPara cambiar la cantidad usá:\n\`/mbot freq <1-6>\``);
      }

      const freq = parseInt(arg);
      if (isNaN(freq) || freq < 1 || freq > 6) {
        return message.reply("❌ ¡Epa! La frecuencia tiene que ser un número del 1 al 6.");
      }

      db.setFrequency(groupId, freq);

      const time = db.getSendTime(groupId);
      return message.reply(
        `✅ ¡Turbinas activadas! 🚀\n` +
        `A partir de hoy voy a pasar *${freq} veces por día*.\n` +
        `Tomando como base las ${time} hs, calcularé los intervalos automáticamente.`
      );
    }

    if (subcommand === "list") {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply("❌ ¡Todavía no me adoptaron!");

      const adminStatus = await isAdmin(message, client);
      if (!adminStatus) {
        return message.reply("🔒 ¡Alto ahí! Solo los admins pueden pedir la llave del panel.");
      }

      // getTunnelUrl() lee la URL vigente del túnel (archivo .tunnel_url que
      // actualiza tunnel.sh), no una env var congelada.
      const baseUrl = getTunnelUrl();
      if (!baseUrl) {
        return message.reply("⚠️ Error de configuración: no hay URL de túnel disponible.");
      }

      const token = db.getGroupToken(groupId);
      if (!token) {
         return message.reply("⚠️ Error: Este grupo no tiene un token de seguridad generado.");
      }

      await message.reply(
        `📚 *Panel de Gestión - ${group.group_name}*\n\n` +
        `Entren acá para ver las frases:\n👉 ${baseUrl}/frases/${groupId}\n\n` +
        `_(Nota: Se requiere la llave de acceso enviada al administrador)_`
      );

      try {
        const adminId = message.author || message.from;
        await client.sendMessage(adminId,
          `🔐 *Llave Maestra Privada*\n\n` +
          `Entrá directo al panel de *${group.group_name}*:\n` +
          `👉 ${baseUrl}/frases/${groupId}?key=${token}\n\n` +
          `Tu dispositivo va a recordar el acceso, no hace falta volver a ingresarla.\n\n` +
          `Si te la piden igual, el token es:\n*${token}*\n\n` +
          `⚠️ _No compartas este mensaje con nadie del grupo._`
        );
      } catch (error) {
        console.error("❌ Error enviando link privado:", error);
        return message.reply("⚠️ No pude mandarte la llave por mensaje privado. ¿Me tenés bloqueado?");
      }
      return; // ya mandamos los dos mensajes arriba (público + token privado)
    }

    if (subcommand === "sync") {
      const senderId = message.author || message.from;
      const number = senderId.split('@')[0].split(':')[0];

      if (!SUPER_ADMINS.includes(number)) {
        return message.reply("⛔ Solo los super administradores pueden ejecutar la sincronización global.");
      }

      // require tardío (no al tope del archivo): index.js ya requiere este
      // módulo, un require circular al tope devolvería un exports vacío.
      const { syncGroups } = require("./index.js");
      if (typeof syncGroups === 'function') {
        await syncGroups();
        const activeGroups = db.getActiveGroups();
        return message.reply(
          `🔄 *Sincronización completada*\n\n` +
          `Grupos activos después de limpieza: ${activeGroups.length}\n` +
          `Revisá la consola para ver los detalles de grupos removidos.`
        );
      } else {
        return message.reply("⚠️ No se pudo ejecutar la sincronización. Intentá reiniciar el bot.");
      }
    }

    return message.reply(`❓ ¡Epa! Ese comando no lo tengo en mi memoria. Usá \`/mbot help\` para ver mi manual de instrucciones.`);
    
  } catch (error) {
    console.error(`❌ Error fatal en handleCommand (Comando: ${message.body}):`, error);
    return message.reply("⚠️ ¡Uy! Me tropecé con un cable interno procesando eso. Denme unos minutos que me reinicio.");
  }
}

// sendMessage suele devolver undefined (busca el mensaje con una clave que
// reconstruye y no coincide con la real). message_create sí trae el mensaje
// construido; el listener se registra ANTES de enviar.
function esperarIdDelEnviado(client, chatId, texto, ms = 6000) {
  const cabecera = texto.split("\n")[0];
  let terminar;

  const promesa = new Promise((resolve) => {
    // Matcheamos por cabecera y no por chat: el chat del mensaje propio puede
    // venir con otro direccionamiento (@lid vs @g.us) y descartaría el match.
    // La cabecera es única y la ventana dura segundos: no hay confusión posible.
    const handler = (m) => {
      if (!m?.fromMe) return;
      if (!(m.body || "").startsWith(cabecera)) return;
      terminar(m);
    };

    const timer = setTimeout(() => terminar(null), ms);

    terminar = (msg) => {
      clearTimeout(timer);
      try { client.removeListener("message_create", handler); } catch (e) { /* nada */ }
      resolve(msg);
    };

    client.on("message_create", handler);
  });

  return { promesa, cancelar: () => terminar(null) };
}

// Último recurso: buscarlo en la colección de mensajes del chat. Misma consulta
// que Chat.fetchMessages pero sin getChatModel, que falla en algunos grupos.
async function buscarIdDelListadoEnChat(client, chatId, texto) {
  const cabecera = texto.split("\n")[0];
  try {
    // Devuelve también el diagnóstico: si falla, queremos saber si el chat no
    // se encontró, si no hay mensajes, o si están pero ninguno matchea.
    const res = await client.pupPage.evaluate(async (chatId, cabecera) => {
      // El id serializado no siempre está en _serialized: según la versión de
      // WhatsApp Web la clave es un MsgKey (con toString) o un objeto plano.
      // Probamos todas las formas antes de darnos por vencidos.
      const serializar = (k) => {
        if (!k) return null;
        if (typeof k === "string") return k;
        if (typeof k._serialized === "string") return k._serialized;
        try {
          const s = k.toString();
          if (typeof s === "string" && s.includes("_")) return s;
        } catch (e) { /* seguimos */ }
        if (k.id) {
          const remoto = k.remote?._serialized || (k.remote && String(k.remote)) || chatId;
          const partes = [k.fromMe ? "true" : "false", remoto, k.id];
          const part = k.participant?._serialized || (k.participant && String(k.participant));
          if (part) partes.push(part);
          return partes.join("_");
        }
        return null;
      };

      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) return { id: null, motivo: "no encontré el chat" };
      if (!chat.msgs) return { id: null, motivo: "el chat no tiene colección de mensajes" };

      const msgs = chat.msgs.getModelsArray();
      const propios = msgs.filter((m) => m?.id?.fromMe);

      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m?.id?.fromMe) continue;
        if (!(m.body || "").startsWith(cabecera)) continue;

        const id = serializar(m.id);
        return {
          id,
          motivo: id ? null : "encontré el mensaje pero no pude serializar su clave",
          // Con esto sabemos qué forma tiene la clave en esta versión.
          forma: typeof m.id,
          claves: Object.keys(m.id || {}).slice(0, 10),
        };
      }

      return {
        id: null,
        motivo: `${msgs.length} mensajes en el chat, ${propios.length} propios, ninguno arranca con la cabecera`,
        muestra: propios.slice(-3).map((m) => (m.body || "").slice(0, 30)),
      };
    }, chatId, cabecera);

    if (!res?.id) {
      const extra = [
        res?.muestra ? `últimos propios: ${JSON.stringify(res.muestra)}` : null,
        res?.forma ? `forma de la clave: ${res.forma} ${JSON.stringify(res.claves || [])}` : null,
      ].filter(Boolean).join(" | ");
      console.warn(`⚠️ Vía 3: ${res?.motivo || "sin resultado"}${extra ? " | " + extra : ""}`);
    }
    return res?.id || null;
  } catch (e) {
    console.warn("⚠️ Vía 3 falló al consultar la página:", e.message);
    return null;
  }
}

// No usamos Message.getReactions(): corta si hasReaction es false (lo es al
// releer recién reaccionado) y llama a Store.Reactions.find(id._serialized),
// campo que esta versión no expone → "called find without an id". Consultamos
// directo con el id que sí tenemos guardado.
async function leerReacciones(client, msgId) {
  try {
    const datos = await client.pupPage.evaluate(async (id) => {
      const res = await window.Store.Reactions.find(id);
      if (!res?.reactions?.length) return [];
      return res.reactions.serialize();
    }, msgId);

    return { ok: true, reacciones: datos || [] };
  } catch (e) {
    console.warn(`⚠️ No pude leer las reacciones de ${msgId}:`, e.message);
    return { ok: false, reacciones: [] };
  }
}

async function sincronizarVotos(client, poll) {
  const lectura = await leerReacciones(client, poll.msg_id);
  // Si la lectura falló no tocamos nada: cero reacciones leídas por error
  // borraría los votos que ya estaban.
  if (!lectura.ok) return false;

  const reacciones = lectura.reacciones;
  const votos = [];
  const sinMapear = [];

  for (const r of reacciones || []) {
    const emoji = normalizarEmoji(r?.id ?? r?.aggregateEmoji);
    const ideaId = poll.mapping[emoji];

    if (!ideaId) {
      if (emoji) sinMapear.push(emoji);
      continue; // reaccionaron con un emoji que no es de la votación
    }

    for (const sender of r?.senders || []) {
      const voterId = sender?.senderId || sender?.senderUserJid;
      if (voterId) votos.push({ ideaId, voterId });
    }
  }

  db.aplicarVotosDePoll(poll.group_id, poll.msg_id, votos);

  console.log(
    `🗳️  Votos sincronizados (${poll.msg_id}): ${votos.length} en este listado` +
    (sinMapear.length ? ` · emojis ignorados: ${sinMapear.join(" ")}` : "")
  );
  return { ok: true, votos: votos.length };
}

const demorar = (ms) => new Promise((r) => setTimeout(r, ms));

// El hook de la librería avisa ANTES de persistir la reacción (llama a
// onReaction y recién después al bulkUpsert original), así que leer en ese
// instante da cero. Esperamos, y reintentamos una vez si sigue en cero.
const RETRASO_LECTURA = 1500;
const RETRASO_REINTENTO = 2500;

async function sincronizarVotosConEspera(client, poll) {
  await demorar(RETRASO_LECTURA);

  const res = await sincronizarVotos(client, poll);
  if (!res?.ok || res.votos > 0) return res;

  await demorar(RETRASO_REINTENTO);
  return sincronizarVotos(client, poll);
}

// Una clave de mensaje puede llegar como string, como MsgKey (con _serialized o
// toString) o como objeto plano {fromMe, remote, id, participant}, según la
// versión de WhatsApp Web. Probamos todas para no quedarnos sin id.
function idSerializado(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw._serialized === "string") return raw._serialized;

  try {
    const s = raw.toString();
    if (typeof s === "string" && s.includes("_")) return s;
  } catch (e) { /* seguimos con la reconstrucción manual */ }

  if (raw.id) {
    const remoto = raw.remote?._serialized || (raw.remote && String(raw.remote));
    if (!remoto) return null;
    const partes = [raw.fromMe ? "true" : "false", remoto, raw.id];
    const part = raw.participant?._serialized || (raw.participant && String(raw.participant));
    if (part) partes.push(part);
    return partes.join("_");
  }

  return null;
}

// Chat al que pertenece la reacción. El id del mensaje padre a veces no viene,
// pero el de la reacción sí, y ambos son del mismo chat: MsgKey.remote, o el
// segundo campo de "fromMe_<chat>_<id>".
function chatDeReaccion(reaction) {
  const desdeRemote = idSerializado(reaction?.id?.remote) || idSerializado(reaction?.msgId?.remote);
  if (desdeRemote) return desdeRemote;

  for (const key of [reaction?.id, reaction?.msgId]) {
    const s = idSerializado(key);
    const partes = s ? s.split("_") : [];
    if (partes.length >= 3 && partes[1].includes("@")) return partes[1];
  }
  return null;
}

// Evita que una ráfaga de reacciones en un grupo activo dispare una llamada a
// la página por cada una.
const ultimaSync = new Map(); // msg_id → timestamp
const SYNC_MIN = 3000;

function puedeSincronizar(msgId) {
  const ahora = Date.now();
  if (ahora - (ultimaSync.get(msgId) || 0) < SYNC_MIN) return false;
  ultimaSync.set(msgId, ahora);
  return true;
}

// El evento llega por CADA reacción de CADA chat de la cuenta. El descarte tiene
// que ser barato: primero resolvemos el chat y consultamos SQLite; solo si ese
// chat tiene un listado vivo tocamos la página (que es lo que cuesta).
async function handleReaction(reaction, client) {
  try {
    const chatId = chatDeReaccion(reaction);

    // Chat conocido y sin listados → no es asunto nuestro. Cero costo.
    if (chatId) {
      const polls = db.getPollsDeGrupo(chatId);
      if (!polls.length) return;

      // Con el id del padre elegimos el listado exacto; si no vino, el más
      // reciente del chat, que es el que la gente tiene a mano para votar.
      const serializado = idSerializado(reaction?.msgId);
      let poll = null;

      if (serializado) {
        const candidatos = [serializado];
        const partes = serializado.split("_");
        // El serializado puede traer el participante al final.
        if (partes.length > 3) candidatos.push(partes.slice(0, 3).join("_"));
        poll = polls.find((p) => candidatos.includes(p.msg_id)) || null;
      }

      if (!poll) poll = polls[0];
      if (!puedeSincronizar(poll.msg_id)) return;

      console.log(`👍 Reacción en ${chatId} → sincronizo listado ${poll.msg_id}`);
      await sincronizarVotosConEspera(client, poll);
      return;
    }

    // Sin chat identificable: último recurso, y solo si existe algún listado.
    const serializado = idSerializado(reaction?.msgId);
    const poll = serializado ? db.getIdeaPoll(serializado) : null;
    if (!poll || !puedeSincronizar(poll.msg_id)) return;

    await sincronizarVotosConEspera(client, poll);
  } catch (error) {
    console.error("❌ Error registrando voto de idea:", error.message);
  }
}

module.exports = { handleCommand, clearAdminCache, handleReaction, sincronizarVotos, esSuperAdmin };