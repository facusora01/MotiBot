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

*💡 Información y Ansiedad:*
▸ \`/mbot time\` — ⏳ Cuenta regresiva para activación de librería custom
▸ \`/mbot status\` — Ver reporte detallado de configuración
▸ \`/mbot help\` — Ver este menú de nuevo
`.trim();

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
      } catch (e) {
        // Ignorar
      }
    }

    const number = rawSenderId.split('@')[0].split(':')[0];

    if (SUPER_ADMINS.includes(number)) return true;

    // Verificar cache primero
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
    
    // Guardar en cache
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
    } catch (e) { /* dejamos el id crudo */ }
    out = out.split(`@${idUser}`).join(`@${nombre}`);
  }
  return out;
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
async function handleCommand(message, client) {
  try {
    const body = message.body?.trim() || "";
    const lowerBody = body.toLowerCase();
    const groupId = message.fromMe ? message.to : message.from;

    // ─── INICIALIZACIÓN DE TABLAS ───────────────────────────────────────────────
    // Nos aseguramos de que el grupo tenga un token generado (solo para nuevas instalaciones)
    let group = db.getGroup(groupId);
    const parts = body.split(/\s+/);
    const subcommand = (parts[1] || "").toLowerCase();
    const arg = (parts[2] || "").toLowerCase();

    // 🚨 BOTÓN DE PÁNICO (Solo Sora / Super Admins)
    if (subcommand === "stop") {
      const senderId = message.author || message.from;
      const number = senderId.split('@')[0].split(':')[0];

      // Verificamos que seas vos y nadie más
      if (!SUPER_ADMINS.includes(number)) {
        return message.reply("⛔ Error de acceso: No tenés autorización para ejecutar protocolos de emergencia.");
      }

      await message.reply("⚠️ *PROTOCOLO DE EMERGENCIA ACTIVADO* ⚠️\n\nApagando procesos `motibot` y `cloudflare-tunnel` inmediatamente. Para volver a subir el sistema, deberás entrar por SSH al servidor.");

      console.error(`🚨 DETENCIÓN DE EMERGENCIA solicitada por ${number} a las ${new Date().toISOString()}`);

      // Ejecutamos el comando de PM2 para detener los dos procesos
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
      if (!group || !group.active) return;

      const content = body.slice(5).trim();
      let phrase = content;
      let author = "Anónimo";

      // Extraer frase y autor con Regex
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

      // 1. Filtro de frase muy corta
      if (!phrase || phrase.length < 5) {
        return message.reply('❌ ¡Uy, esa frase es muy cortita!\nEscribila así: `/new "Tu frase inspiradora" - Autor`');
      }

      // 2. Filtro de frase gigante (Testamento)
      if (phrase.length > 300) {
        return message.reply(`❌ ¡Epa! Esa frase es un testamento de ${phrase.length} caracteres.\nPor favor, resumila a un máximo de 300 para no saturar la base de datos.`);
      }

      // 🛡️ OBTENER QUIÉN AGREGÓ LA FRASE: nombre legible; si falla, "Anónimo".
      const addedBy = await nombreDeMensaje(client, message);

      db.addCustomPhrase(groupId, phrase, author, addedBy);

      const count = db.countCustomPhrases(groupId);
      const settings = db.getGroupSettings(groupId);

      let avisoCustom = "";
      if (!settings || settings.use_custom === "default") {
        avisoCustom = "\n\n💡 *Nota:* Guardé la frase, pero todavía estoy usando mi libro clásico. Cuando un admin active el modo custom con `/mbot use custom`, empezarán a salir estas frases.";
      }

      if (count >= 60 && settings?.use_custom === "pending") {
        db.activateCustomNow(groupId); // Debés crear este método en database.js que ponga use_custom = 'active'
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
      if (!group || !group.active) return;

      if (!message.hasQuotedMsg) {
        return message.reply('💡 Para usar `/add`, respondé (reply) al mensaje que querés guardar como frase.');
      }

      const quoted = await message.getQuotedMessage();

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

   // ── /mbot ... ─────────────────────────────────────────────────────────────
    if (!body.toLowerCase().startsWith("/mbot")) return;

    if (!subcommand) {
      return message.reply('❓ ¡Me dejaste por la mitad! Usá `/mbot help` para ver cómo pedirme las cosas.');
    }

    // 🛡️ FILTRO DE ARIDAD ESTRICTA (Solución al Bug)
    const UNKNOWN_MSG = `❓ ¡Epa! Ese comando no lo tengo en mi memoria. Usá \`/mbot help\` para ver mi manual de instrucciones.`;

    // 1. Comandos que NO llevan argumentos extras (Largo exacto: 2)
    const strictNoArg = ["phrase", "status", "help", "add", "remove", "list", "stop", "time"];
    // 2. Comandos que REQUIEREN un argumento (Largo exacto: 3)
    const needsOneArg = ["lang", "use"];
    // 3. Comandos DUALES (Largo: 2 o 3)
    const optionalOneArg = ["clock", "freq"];

    // Validamos si el usuario escribió de más o de menos según el comando
    if (strictNoArg.includes(subcommand) && parts.length !== 2) return message.reply(UNKNOWN_MSG);
    if (needsOneArg.includes(subcommand) && parts.length !== 3) return message.reply(UNKNOWN_MSG);
    if (optionalOneArg.includes(subcommand) && (parts.length < 2 || parts.length > 3)) return message.reply(UNKNOWN_MSG);
    
    // Si el comando ni siquiera está en nuestras listas, también rebota
    const allKnown = [...strictNoArg, ...needsOneArg, ...optionalOneArg];
    if (!allKnown.includes(subcommand)) return message.reply(UNKNOWN_MSG);

    // ─── PROCESAMIENTO DE COMANDOS VALIDADOS ──────────────────────────────────
    if (subcommand === "help") {
      return message.reply(HELP_TEXT);
    }

    if (subcommand === "status") {
      // 1. 🚨 DEFINICIÓN DE VARIABLES (Lo que faltaba)
      const group = db.getGroup(groupId);
      const settings = db.getGroupSettings(groupId);
      const customCount = db.countCustomPhrases(groupId);

      if (!group || !group.active) {
        return message.reply("❌ ¡Todavía no me adoptaron en este equipo!\nAlguien con permisos tiene que usar `/mbot add`.");
      }

      // 2. Lógica de estado de la librería
      let customStatus = "❌ No activada";
      if (settings?.use_custom === "pending") {
        // Usamos la función de tiempo que definimos para los ansiosos
        const remaining = getTimeRemaining(settings.custom_start_date);
        customStatus = `⏳ Pendiente (Faltan ${remaining || "pocos minutos"})`;
      } else if (settings?.use_custom === "active") {
        customStatus = `✅ ¡A pleno! (${customCount} frases en la colección)`;
      }

      // 3. Respuesta final al usuario
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
        
        // ⚡ Si ya tienen 60 frases, el comando /mbot time activa el modo
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

        // 🛡️ Lógica de Cooldown: Los admins saltan la espera
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

        // ⚙️ Verificamos la configuración del grupo
        db.checkAndActivateCustom(groupId); // Lógica de tiempo por defecto
        const settings = db.getGroupSettings(groupId);
        let frase = null;
        let isCustom = false;

        // 🚀 MODO ESTRICTO: Si está activo, SOLO busca en la librería del equipo
        if (settings?.use_custom === "active") {
          const customPhrase = db.getRandomCustomPhrase(groupId);
          
          if (customPhrase) {
            frase = { texto: customPhrase.phrase, autor: customPhrase.author, source: customPhrase.source };
            isCustom = true;
          } else {
            // Si está activo pero no hay frases, avisamos en lugar de usar externas
            return message.reply("⚠️ El modo custom está activo pero la lista del equipo está vacía. ¡Sumen frases con `/new`!");
          }
        } else {
          // 🌐 MODO CLÁSICO: Solo si el custom no está activo. Pool pre-cargado →
          // respuesta instantánea con diversidad remota (sin esperar la API).
          const { getPhraseInstant } = require("./phrases");
          frase = getPhraseInstant(settings?.language || "es");
        }

        // 🎨 Formateo del mensaje final
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
      const chat = await message.getChat();
      db.addGroup(groupId, chat.name);
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

      // 1. Validación de Admin (Ya lo tenés bien)
      const adminStatus = await isAdmin(message, client);
      if (!adminStatus) {
        return message.reply("🔒 ¡Alto ahí! Solo los admins pueden pedir la llave del panel.");
      }

      // 2. Link Base y Token Único. getTunnelUrl() lee la URL vigente del túnel
      // (archivo .tunnel_url que actualiza tunnel.sh), no una env var congelada.
      const baseUrl = getTunnelUrl();
      if (!baseUrl) {
        return message.reply("⚠️ Error de configuración: no hay URL de túnel disponible.");
      }

      const token = db.getGroupToken(groupId); // 🔑 USAMOS EL TOKEN DE LA BASE DE DATOS
      if (!token) {
         return message.reply("⚠️ Error: Este grupo no tiene un token de seguridad generado.");
      }

      // 3. Mensaje público al grupo (Link LIMPIO, sin el token)
      await message.reply(
        `📚 *Panel de Gestión - ${group.group_name}*\n\n` +
        `Entren acá para ver las frases:\n👉 ${baseUrl}/frases/${groupId}\n\n` +
        `_(Nota: Se requiere la llave de acceso enviada al administrador)_`
      );

      // 4. Mensaje Privado al Admin (Solo el Token)
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
      return; // Fin del comando list
    }

    if (subcommand === "sync") {
      // Solo Sora/Super Admins pueden forzar sync global
      const senderId = message.author || message.from;
      const number = senderId.split('@')[0].split(':')[0];
      
      if (!SUPER_ADMINS.includes(number)) {
        return message.reply("⛔ Solo los super administradores pueden ejecutar la sincronización global.");
      }

      // Importar y ejecutar syncGroups desde index.js
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

module.exports = { handleCommand, clearAdminCache };