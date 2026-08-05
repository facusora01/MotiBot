const db = require("./database");
const { getTunnelUrl } = require("./tunnel-url");

const { exec } = require("child_process");

const userCooldowns = new Map();
const COOLDOWN_TIME = 5 * 60 * 1000;

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

*📚 Gestión de Frases:*
▸ \`/new "Frase" - Autor\` — Sumar a la colección
▸ \`/add\` (en reply) — Guardar el mensaje citado como frase (autor = quien lo escribió)
▸ \`/mbot phrase\` — Recibir una frase ya mismo
▸ \`/mbot list\` — 🌐 Panel Web para gestionar la colección

*🎂 Cumpleaños:*
▸ \`/birthday @persona mm/dd/yyyy\` — Cargar un cumple (¡primero el mes!)
▸ \`/birthday list\` — Ver todos los cumples cargados

*💡 Ideas para el bot:*
▸ \`/idea <recomendación>\` — Proponer una mejora (en una línea)
▸ \`/ideas\` — Ver el listado y votar reaccionando con emojis
▸ \`/ideas list\` — 🌐 Panel Web con todas las ideas y sus votos (admins)

*💡 Información y Ansiedad:*
▸ \`/mbot time\` — ⏳ Cuenta regresiva para activación de librería custom
▸ \`/mbot status\` — Ver reporte detallado de configuración
▸ \`/mbot help\` — Ver este menú de nuevo
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

async function isAdmin(message, client) {
  try {
    let rawSenderId = message.author || message.from;

    if (rawSenderId && rawSenderId.includes('@lid')) {
      try {
        const contact = await message.getContact();
        if (contact && contact.number) {
          rawSenderId = contact.number + '@c.us';
        }
      } catch (e) {}
    }

    const number = rawSenderId.split('@')[0].split(':')[0];

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

// Formato mm/dd/yyyy (pedido explícito). Devolvemos el error ya redactado para
// que el comando solo tenga que reenviarlo.
function parsearFechaCumple(texto) {
  const m = texto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return { error: "formato" };

  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);

  if (month < 1 || month > 12) return { error: `El mes ${month} no existe. El formato es *mm/dd/yyyy* (primero el mes).` };

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

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
async function handleCommand(message, client) {
  try {
    const body = message.body?.trim() || "";
    const lowerBody = body.toLowerCase();
    const groupId = message.fromMe ? message.to : message.from;

    let group = db.getGroup(groupId);
    const parts = body.split(/\s+/);
    const subcommand = (parts[1] || "").toLowerCase();
    const arg = (parts[2] || "").toLowerCase();

    // 🚨 BOTÓN DE PÁNICO (Solo Sora / Super Admins)
    if (subcommand === "stop") {
      const senderId = message.author || message.from;
      const number = senderId.split('@')[0].split(':')[0];

      if (!SUPER_ADMINS.includes(number)) {
        return message.reply("⛔ Error de acceso: No tenés autorización para ejecutar protocolos de emergencia.");
      }

      await message.reply("⚠️ *PROTOCOLO DE EMERGENCIA ACTIVADO* ⚠️\n\nApagando procesos `motibot` y `cloudflare-tunnel` inmediatamente. Para volver a subir el sistema, deberás entrar por SSH al servidor.");

      console.error(`🚨 DETENCIÓN DE EMERGENCIA solicitada por ${number} a las ${new Date().toISOString()}`);

      exec("pm2 stop motibot cloudflare-tunnel", (error, stdout, stderr) => {
        if (error) {
          console.error(`❌ Error al ejecutar el stop: ${error.message}`);
          return;
        }
        console.log(`✅ Procesos detenidos: ${stdout}`);
      });
      return;
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

    // ── /birthday @persona mm/dd/yyyy ─────────────────────────────────────────
    if (lowerBody === "/birthday" || lowerBody.startsWith("/birthday ")) {
      const group = db.getGroup(groupId);
      if (!group || !group.active) return message.reply(NO_REGISTRADO);

      const resto = body.slice("/birthday".length).trim();
      const USO = "🎂 *Cómo cargar un cumpleaños:*\n\n`/birthday @persona mm/dd/yyyy`\n\n" +
                  "Ejemplo: `/birthday @juan 04/08/2000` = 8 de abril de 2000.\n" +
                  "_Ojo: primero el MES, después el día._\n\n" +
                  "Para ver los cargados: `/birthday list`";

      if (!resto) return message.reply(USO);

      if (resto.toLowerCase() === "list") {
        const lista = db.getBirthdaysList(groupId);
        if (!lista.length) {
          return message.reply("🎂 Todavía no hay ningún cumpleaños cargado. Sumá uno con `/birthday @persona mm/dd/yyyy`.");
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
        `📅 Fecha guardada: ${fecha.month}/${fecha.day}/${fecha.year} _(mes/día/año)_\n` +
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
            `Para gestionar las ideas de *${group.group_name}*, usá este token de acceso:\n\n` +
            `*${token}*\n\n` +
            `⚠️ _No compartas esta llave con nadie del grupo._`
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

      // Sin id no hay votación posible, así que lo buscamos por dos vías: el
      // retorno del envío (rápido, pero suele venir vacío) y el evento
      // message_create (más lento, pero confiable). El listener va primero.
      const espera = esperarIdDelEnviado(client, groupId, texto);

      let enviado;
      try {
        enviado = await message.reply(texto, undefined, { waitUntilMsgSent: true });
      } catch (e) {
        espera.cancelar();
        throw e;
      }

      let msgId = enviado?.id?._serialized || null;
      if (msgId) {
        espera.cancelar();
      } else {
        const porEvento = await espera.promesa;
        msgId = porEvento?.id?._serialized || null;
        if (msgId) console.log(`💡 Id del listado obtenido por message_create: ${msgId}`);
      }

      if (msgId) {
        db.saveIdeaPoll(msgId, groupId, mapping);
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

    const UNKNOWN_MSG = `❓ ¡Epa! Ese comando no lo tengo en mi memoria. Usá \`/mbot help\` para ver mi manual de instrucciones.`;

    // parts = ["/mbot", subcommand, arg?] → length 2 = sin arg extra, 3 = con arg.
    const strictNoArg = ["phrase", "status", "help", "add", "remove", "list", "stop", "time"];
    const needsOneArg = ["lang", "use"];
    const optionalOneArg = ["clock", "freq"];

    if (strictNoArg.includes(subcommand) && parts.length !== 2) return message.reply(UNKNOWN_MSG);
    if (needsOneArg.includes(subcommand) && parts.length !== 3) return message.reply(UNKNOWN_MSG);
    if (optionalOneArg.includes(subcommand) && (parts.length < 2 || parts.length > 3)) return message.reply(UNKNOWN_MSG);

    const allKnown = [...strictNoArg, ...needsOneArg, ...optionalOneArg];
    if (!allKnown.includes(subcommand)) return message.reply(UNKNOWN_MSG);

    // ─── PROCESAMIENTO DE COMANDOS VALIDADOS ──────────────────────────────────
    if (subcommand === "help") {
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
          `Para gestionar las frases de *${group.group_name}*, usá este token de acceso:\n\n` +
          `*${token}*\n\n` +
          `⚠️ _No compartas esta llave con nadie del grupo._`
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

// sendMessage lee el mensaje recién enviado del Store sin esperar a que esté
// indexado, así que muchas veces devuelve undefined y nos quedamos sin id. El
// evento message_create, en cambio, entrega el mensaje ya construido. Lo
// escuchamos como plan B: el listener se registra ANTES de enviar para no
// perder el evento si llega rápido.
function esperarIdDelEnviado(client, chatId, texto, ms = 10000) {
  const cabecera = texto.split("\n")[0];
  let terminar;

  const promesa = new Promise((resolve) => {
    const handler = (m) => {
      if (!m?.fromMe) return;
      if ((m.to || m.from) !== chatId) return;
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

// El payload del evento de reacción no es confiable: el emoji sale de
// data.reactionText, un nombre de campo que la tabla moderna de WhatsApp puede
// no usar (llega undefined), y el id del mensaje padre a veces trae el sufijo
// del participante. Por eso el evento se usa solo como aviso de "algo cambió" y
// la verdad se lee del mensaje: getReactions() devuelve quién reaccionó y con
// qué. Como recalcula todo el listado, además se autocorrige si se perdió algún
// evento o el bot estuvo caído.
async function sincronizarVotos(client, poll) {
  const ideaIds = Object.values(poll.mapping);

  // Siempre releemos el mensaje: hay que pedirlo de nuevo para ver reacciones
  // nuevas. Un objeto guardado del momento del envío trae hasReaction en false
  // y getReactions() cortaría ahí sin mirar nada.
  let mensaje;
  try {
    mensaje = await client.getMessageById(poll.msg_id);
  } catch (e) {
    console.warn(`⚠️ No pude leer el listado ${poll.msg_id}:`, e.message);
    return false;
  }
  if (!mensaje) return false;

  let reacciones;
  try {
    reacciones = await mensaje.getReactions();
  } catch (e) {
    console.warn(`⚠️ No pude leer las reacciones de ${poll.msg_id}:`, e.message);
    return false;
  }

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

  db.reemplazarVotosPoll(ideaIds, votos);

  console.log(
    `🗳️  Votos sincronizados (${poll.msg_id}): ${votos.length} voto(s)` +
    (sinMapear.length ? ` · emojis ignorados: ${sinMapear.join(" ")}` : "")
  );
  return true;
}

function idSerializado(raw) {
  if (!raw) return null;
  return typeof raw === "string" ? raw : (raw._serialized || null);
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
      await sincronizarVotos(client, poll);
      return;
    }

    // Sin chat identificable: último recurso, y solo si existe algún listado.
    const serializado = idSerializado(reaction?.msgId);
    const poll = serializado ? db.getIdeaPoll(serializado) : null;
    if (!poll || !puedeSincronizar(poll.msg_id)) return;

    await sincronizarVotos(client, poll);
  } catch (error) {
    console.error("❌ Error registrando voto de idea:", error.message);
  }
}

module.exports = { handleCommand, clearAdminCache, handleReaction, sincronizarVotos };