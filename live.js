// /mbot live y /mbot llm: la parte de WhatsApp de los LLMs de la comunidad.
//
// Cualquiera puede sumar su propio LLM (Ollama en su PC) con /mbot llm add por
// privado. En un grupo, un admin prende /mbot live y MotiBot pasa a contestar
// con el LLM de alguien que esté en ese grupo cuando lo arroban o le responden
// una de sus respuestas.
//
// Lo que devuelve el LLM es texto y termina SOLO en un reply al grupo, siempre
// sin poder empezar con "/" ni "@" y con la firma del modelo al final (ver
// llm-protocol.js).
const db = require("./database");
const llm = require("./llm");
const P = require("./llm-protocol");

// commands.js también requiere este módulo: sus helpers se piden al usarlos.
const cmd = () => require("./commands");

const soloUser = (id) => String(id?._serialized || id || "").split("@")[0].split(":")[0];

// En un mensaje propio (escrito desde el teléfono del bot) "from" es nuestro
// número y el chat viene en "to".
const chatDe = (message) => String((message.fromMe ? message.to : message.from) || "");

// Solo para probar en local vinculando tu propio WhatsApp: deja que tus
// mensajes le pregunten al LLM. En producción (PM2 pone NODE_ENV=production)
// se ignora siempre.
const RESPONDER_PROPIOS =
  process.env.LIVE_RESPONDER_PROPIOS === "1" && process.env.NODE_ENV !== "production";
if (RESPONDER_PROPIOS) console.warn("🧪 [live] LIVE_RESPONDER_PROPIOS activo: mis propios mensajes le preguntan al LLM.");

const COOLDOWN_USUARIO = 15 * 1000;
const ultimoUso = new Map(); // "grupo|autor" -> timestamp
const gruposPensando = new Set();

setInterval(() => {
  const limite = Date.now() - COOLDOWN_USUARIO;
  for (const [clave, ts] of ultimoUso) {
    if (ts < limite) ultimoUso.delete(clave);
  }
}, 10 * 60 * 1000).unref();

// Después de "@MotiBot", estas palabras siguen siendo comandos aunque el modo
// live esté prendido: "@MotiBot phrase" pide una frase, no le pregunta al LLM.
const PALABRAS_COMANDO = new Set([
  "help", "status", "time", "add", "remove", "lang", "use", "clock", "freq",
  "list", "sync", "stop", "phrase", "frases", "mercado", "granos", "grano",
  "precio", "carry", "alerta", "alertas", "live", "llm",
  "new", "birthday", "idea", "ideas", "admin", "image", "imagen",
  // Los mismos en inglés (ver comandos-en.js).
  ...require("./comandos-en").PALABRAS_EN,
]);

// Instrucciones para el modelo. Los modelos chicos las toman al pie de la
// letra: "buena onda" los llenaba de emojis y "explicá que solo podés
// chatear" lo repetían en cada respuesta. Por eso piden tono natural y no
// mencionar limitaciones. Lo que el modelo puede hacer no depende de esto: el
// sistema solo le deja devolver texto, diga lo que diga.
const SISTEMA = [
  "Sos MotiBot y charlás en un grupo de WhatsApp.",
  "Respondé como una persona del grupo: natural, directo y breve (unas pocas oraciones), en el mismo idioma y tono en que te escriben.",
  "Usá emojis solo de vez en cuando, como mucho uno por mensaje.",
  "Si no sabés algo, decilo en vez de inventar.",
  "No hables de tus limitaciones ni de cómo funcionás, salvo que te pidan algo que no podés hacer: ahí decí simplemente que no podés.",
  "Formato de WhatsApp: *negrita* con un asterisco, _cursiva_. Sin títulos con #, sin tablas.",
  "No pongas tu nombre ni \"MotiBot:\" al principio.",
].join(" ");

const RE_FIRMA = /\n\n_— [^\n]+ · LLM de [^\n]+_$/;

// ¿Es una respuesta que mandó MotiBot con un LLM? La delata la firma.
function esRespuestaLLM(body) {
  return RE_FIRMA.test(String(body || ""));
}

// El texto de una respuesta nuestra sin la firma, para dárselo al LLM como
// contexto cuando alguien le contesta.
function textoDeRespuesta(body) {
  return String(body || "").replace(RE_FIRMA, "").trim();
}

function estaActivo(groupId) {
  return Boolean(db.getGroupLive(groupId));
}

// ─── MEMORIA DE LA CHARLA ────────────────────────────────────────────────────
// Por grupo, las últimas idas y vueltas del modo live: solo lo que le
// preguntaron al bot y lo que contestó, nunca el resto del chat. Vive en
// memoria (se pierde si el bot reinicia) y es de UN LLM: si cambia, arranca
// de cero, para que la PC nueva no reciba lo que se habló con la anterior.
const MEMORIA = {
  vueltas: 10,
  ventanaMs: 60 * 60 * 1000,
  caracteres: 8000,
};
const memorias = new Map(); // groupId -> { llmId, lista: [{ pregunta, respuesta, ts }] }

function recuerdos(groupId, llmId) {
  const m = memorias.get(groupId);
  if (!m || m.llmId !== llmId) return [];

  const ahora = Date.now();
  m.lista = m.lista.filter((r) => ahora - r.ts < MEMORIA.ventanaMs).slice(-MEMORIA.vueltas);

  // De la más nueva a la más vieja, mientras entren en el tope de caracteres.
  const out = [];
  let total = 0;
  for (let i = m.lista.length - 1; i >= 0; i--) {
    const largo = m.lista[i].pregunta.length + m.lista[i].respuesta.length;
    if (total + largo > MEMORIA.caracteres) break;
    total += largo;
    out.unshift(m.lista[i]);
  }
  return out;
}

function recordar(groupId, llmId, pregunta, respuesta) {
  let m = memorias.get(groupId);
  if (!m || m.llmId !== llmId) {
    m = { llmId, lista: [] };
    memorias.set(groupId, m);
  }
  m.lista.push({ pregunta, respuesta, ts: Date.now() });
  if (m.lista.length > MEMORIA.vueltas) m.lista.shift();
}

function olvidar(groupId) {
  memorias.delete(groupId);
}

setInterval(() => {
  const limite = Date.now() - MEMORIA.ventanaMs;
  for (const [groupId, m] of memorias) {
    m.lista = m.lista.filter((r) => r.ts >= limite);
    if (!m.lista.length) memorias.delete(groupId);
  }
}, 10 * 60 * 1000).unref();

// Si el mensaje es para el LLM, devuelve { pregunta, citado }; si no, null.
// esIdDelBot(user) viene de index.js, que sabe con qué ids nos arroban.
function preguntaDelMensaje(message, esIdDelBot) {
  // Lo que escribe la cuenta del bot nunca va al LLM: así una respuesta del
  // LLM no puede disparar otra. (En modo prueba sí, salvo las respuestas del
  // LLM, que index.js descarta antes de llegar acá.)
  if (message.fromMe && !RESPONDER_PROPIOS) return null;
  if (esRespuestaLLM(message.body)) return null;
  const groupId = chatDe(message);
  if (!groupId.endsWith("@g.us")) return null;

  const body = String(message.body || "").trim();
  if (!body) return null;

  // Lo que sigue a "@MotiBot" o a "/mbot" es una pregunta, salvo que sea un
  // comando: esos tienen prioridad aunque el modo live esté prendido.
  const pedido = (resto) => {
    resto = (resto || "").trim();
    if (!resto || resto.startsWith("/")) return null;
    if (PALABRAS_COMANDO.has(resto.split(/\s+/)[0].toLowerCase())) return null;
    return estaActivo(groupId) ? { pregunta: resto, citado: null } : null;
  };

  // "/mbot <pregunta>"
  const barra = body.match(/^\/mbot\s+([\s\S]+)$/i);
  if (barra) return pedido(barra[1]);
  if (body.startsWith("/")) return null;

  // "@MotiBot <pregunta>"
  const m = body.match(/^@(\S+)\s*([\s\S]*)$/);
  if (m && esIdDelBot(m[1])) return pedido(m[2]);

  // Reply a una respuesta del LLM (de texto: responderle a una imagen no es
  // seguir la charla).
  const citado = message.hasQuotedMsg ? message._data?.quotedMsg : null;
  if (!citado || (citado.type && citado.type !== "chat") || !esRespuestaLLM(citado.body)) return null;
  const part = message._data?.quotedParticipant;
  if (!esIdDelBot(soloUser(part))) return null;
  return estaActivo(groupId) ? { pregunta: body, citado: textoDeRespuesta(citado.body) } : null;
}

// Devuelve el texto a contestar en el grupo (o null si no hay que contestar).
async function responder(message, client, { pregunta, citado }) {
  const groupId = chatDe(message);
  const live = db.getGroupLive(groupId);
  if (!live) return null;

  const info = llm.infoConectado(live.llm_id);
  if (!info) {
    db.borrarGroupLive(groupId);
    olvidar(groupId);
    return "🔌 El LLM que estaba usando se desconectó, así que apagué el modo live.\n\n" +
      "_Un admin lo puede volver a prender con_ `/mbot live`.";
  }

  if (pregunta.length > P.LIMITES.pregunta) {
    return `✂️ Es muy largo para mí: resumilo en menos de ${P.LIMITES.pregunta} caracteres.`;
  }

  // El super admin no tiene espera entre preguntas.
  const clave = `${groupId}|${message.author || message.from}`;
  if (Date.now() - (ultimoUso.get(clave) || 0) < COOLDOWN_USUARIO && !(await cmd().esSuperAdmin(message))) {
    return "⏳ Dame unos segundos entre pregunta y pregunta.";
  }
  if (gruposPensando.has(groupId) || llm.ocupado(live.llm_id)) {
    return "⏳ Estoy terminando otra respuesta, probá en un ratito.";
  }

  ultimoUso.set(clave, Date.now());
  gruposPensando.add(groupId);
  try {
    const nombre = P.limpiarRespuesta(await cmd().nombreDeMensaje(client, message)).replace(/\s+/g, " ").slice(0, 60);
    const turno = `(Te escribe ${nombre || "alguien del grupo"})\n${pregunta}`;
    const mensajes = [{ role: "system", content: SISTEMA }];

    // La memoria solo va a agentes que la soportan: los viejos rechazan jobs
    // de más de 4 mensajes.
    const conMemoria = (info.version || 1) >= P.VERSION_MEMORIA;
    if (conMemoria) {
      for (const r of recuerdos(groupId, live.llm_id)) {
        mensajes.push({ role: "user", content: r.pregunta }, { role: "assistant", content: r.respuesta });
      }
    }
    // La respuesta citada, si no está ya en la memoria.
    const recortado = citado ? citado.slice(0, P.LIMITES.contenidoPorMensaje) : null;
    if (recortado && !mensajes.some((m) => m.role === "assistant" && m.content === recortado)) {
      mensajes.push({ role: "assistant", content: recortado });
    }
    mensajes.push({ role: "user", content: turno });

    const texto = await llm.preguntar(live.llm_id, mensajes);
    const final = P.formatearRespuesta(texto, info.model, info.owner_name);
    if (conMemoria) recordar(groupId, live.llm_id, turno, textoDeRespuesta(final));
    return final;
  } catch (e) {
    console.warn(`⚠️ [live] El LLM #${live.llm_id} no respondió en ${groupId}:`, e.message);
    if (e.message === "desconectado") {
      db.borrarGroupLive(groupId);
      olvidar(groupId);
      return "🔌 El LLM se desconectó mientras pensaba, así que apagué el modo live.";
    }
    if (e.message === "timeout") return "⌛ El LLM tardó demasiado en contestar. Probá de nuevo en un rato.";
    if (e.message === "ocupado") return "⏳ Estoy terminando otra respuesta, probá en un ratito.";
    return "⚠️ El LLM no pudo responder esta vez. Probá de nuevo en un rato.";
  } finally {
    gruposPensando.delete(groupId);
  }
}

// Teléfono y lid de quien manda el mensaje. En grupos nuevos WhatsApp manda
// @lid y el teléfono hay que pedirlo aparte.
async function identidadesDe(client, message) {
  const raw = message.author || message.from;
  const ids = { phone: null, lid: null };
  try {
    const [r] = await client.getContactLidAndPhone([raw]);
    if (r?.pn) ids.phone = soloUser(r.pn);
    if (r?.lid) ids.lid = soloUser(r.lid);
  } catch (e) { /* seguimos con lo que venga en el id */ }

  if (String(raw).endsWith("@lid")) ids.lid = ids.lid || soloUser(raw);
  else ids.phone = ids.phone || soloUser(raw);

  if (!ids.phone) {
    const n = await cmd().resolverNumero(message);
    if (n && n !== ids.lid) ids.phone = n;
  }
  return ids;
}

function esDe(agente, ids) {
  return [agente.owner_phone, agente.owner_lid].some((x) => x && (x === ids.phone || x === ids.lid));
}

// Elige un LLM conectado que cumpla `sirve`: el de quien lo pide o, si no
// tiene, el de otro miembro del grupo. Si no se pueden leer los
// participantes, solo el propio: nunca se le manda nada del grupo a la PC de
// alguien que no está en él.
async function elegirLlm(client, message, groupId, ids, sirve, preferido = null) {
  const candidatos = llm.habilitado() ? llm.conectados().filter(sirve) : [];
  if (!candidatos.length) return null;

  if (preferido) {
    const p = candidatos.find((a) => a.id === preferido);
    if (p) return p;
  }

  const propio = candidatos.find((a) => esDe(a, ids));
  if (propio) return propio;

  const participantes = await cmd().participantesDelGrupo(client, groupId);
  if (!participantes) return null;
  const miembros = new Set();
  for (const p of participantes) {
    for (const id of [p.id?._serialized, p.lid, p.pn, p.phoneNumber]) {
      const u = soloUser(id);
      if (u) miembros.add(u);
    }
  }
  return candidatos.find((a) => [a.owner_phone, a.owner_lid].some((x) => x && miembros.has(x))) || null;
}

// ─── /mbot llm (por privado) ─────────────────────────────────────────────────
const USO_LLM =
  "🧠 *Tu LLM en MotiBot*\n\n" +
  "▸ `/mbot llm` — Ver si está conectado\n" +
  "▸ `/mbot llm add` — Sumarlo (o generar un token nuevo)\n" +
  "▸ `/mbot llm remove` — Darlo de baja";

async function comandoLlm(message, client, arg) {
  const esPrivado = !chatDe(message).endsWith("@g.us");
  if (!esPrivado) {
    return message.reply("🔒 Tu LLM se maneja por privado: escribime `/mbot llm add` al privado.");
  }
  if (!llm.habilitado()) {
    return message.reply("🧠 Los LLMs de la comunidad no están habilitados en este servidor.");
  }

  const ids = await identidadesDe(client, message);
  const clave = ids.phone || (ids.lid ? `lid:${ids.lid}` : null);
  if (!clave) return message.reply("⚠️ No pude identificar tu número. Probá de nuevo en un rato.");

  if (!arg) {
    const agente = db.getLlmAgentPorDueno(clave);
    if (!agente) return message.reply(`${USO_LLM}\n\n_Todavía no sumaste ninguno._`);
    const info = llm.infoConectado(agente.id);
    return message.reply(
      info
        ? `🟢 Tu LLM está conectado con *${info.model}*.\n\n${USO_LLM}`
        : `⚪ Tu LLM está registrado pero desconectado. Prendé el agente en tu PC.\n\n${USO_LLM}`
    );
  }

  if (arg === "remove") {
    const agente = db.borrarLlmAgent(clave);
    if (!agente) return message.reply("🤷 No tenías ningún LLM registrado.");
    llm.expulsar(agente.id);
    return message.reply("🗑️ Listo, di de baja tu LLM y lo saqué de todos los grupos. El token viejo ya no sirve.");
  }

  if (arg !== "add") return message.reply(USO_LLM);

  const nombre = await cmd().nombreDeMensaje(client, message);
  const token = P.generarToken();
  const anterior = db.getLlmAgentPorDueno(clave);
  const agente = db.guardarLlmAgent(clave, ids.lid, nombre || null, P.hashToken(token));
  // Si ya tenía uno, la sesión con el token viejo se corta ahora.
  if (anterior) llm.expulsar(anterior.id);

  // Links a GitHub (código a la vista) y huella del agente que corre el bot.
  const gh = llm.descargaAgente();
  const chat = chatDe(message);

  await message.reply(
    `🧠 *Sumá tu LLM a MotiBot*\n\n` +
    `Necesitás *Ollama* (ollama.com) y *Node 22+* (nodejs.org).\n\n` +
    `*Windows:* bajá el instalador (botón ⬇️ de GitHub), clic derecho → *Ejecutar con PowerShell*. ` +
    `Te pide el token de abajo, te ofrece sumar generación de imágenes y te deja el acceso directo *MotiBot LLM* en el escritorio:\n${gh.instalador}\n\n` +
    `*Mac/Linux:* bajá el agente (${gh.codigo}) y correlo:\n` +
    `\`node --permission motibot-agent.js --server ${llm.urlWebSocket()} --model qwen3.5:9b --token <token>\`\n\n` +
    `Qué hace, explicado: ${gh.explicacion}\n\n` +
    `⚠️ El token es una contraseña: no lo compartas.` +
    (anterior ? `\n_Generé uno nuevo: el anterior dejó de servir._` : "")
  );

  await client.sendMessage(chat,
    `🛡️ *¿Es seguro? No hace falta que me creas*\n\n` +
    `*Te protege Node, no MotiBot.* Con \`--permission\`, Node (el programa oficial que ya tenés instalado) ` +
    `encierra al agente: no lo deja leer ni escribir tus archivos ni abrir programas. ` +
    `Aunque el archivo fuera malo, no podría tocar tu PC. Probalo vos:\n` +
    `\`node --permission -e "require('fs').readdirSync('.')"\`\n` +
    `Node tiene que contestar *ERR_ACCESS_DENIED*: ni siquiera deja ver qué archivos hay.\n\n` +
    (gh.huella
      ? `🔍 *Comprobá que es el original.* Esta es su huella; si le cambiaran una sola letra, sería otra:\n` +
        `\`${gh.huella}\`\n` +
        `Windows: \`certutil -hashfile motibot-agent.js SHA256\`\n` +
        `Mac/Linux: \`shasum -a 256 motibot-agent.js\`\n\n`
      : "") +
    `_Lo único que Node no encierra es la red: el agente solo se conecta a MotiBot y a tu Ollama, y no le da herramientas al modelo. Tu PC no abre ningún puerto._`
  );

  // Solo y sin formato, para copiarlo con un toque.
  await client.sendMessage(chat, token);
  console.log(`🧠 [llm] Token ${anterior ? "rotado" : "nuevo"} para el LLM #${agente.id} (${nombre || clave}).`);
}

// ─── /mbot live (en un grupo) ────────────────────────────────────────────────
async function comandoLive(message, client, arg) {
  const groupId = chatDe(message);
  if (!groupId.endsWith("@g.us")) {
    return message.reply("🧠 El modo live es para grupos. Tu propio LLM lo manejás con `/mbot llm`.");
  }

  const group = db.getGroup(groupId);
  if (!group || !group.active) {
    return message.reply("❌ ¡Todavía no me adoptaron en este equipo!\nAlguien con permisos tiene que usar `/mbot add`.");
  }
  if (arg && arg !== "off" && arg !== "reset") {
    return message.reply("❓ Usá `/mbot live` para prenderlo, `/mbot live off` para apagarlo o `/mbot live reset` para que me olvide de la charla.");
  }

  if (!(await cmd().isAdmin(message, client))) {
    return message.reply("🔒 Solo los admins pueden manejar el modo live.");
  }

  if (arg === "off") {
    olvidar(groupId);
    return message.reply(
      db.borrarGroupLive(groupId) ? "⚪ Modo live apagado. Vuelvo a ser el MotiBot de siempre." : "⚪ El modo live no estaba prendido."
    );
  }

  if (arg === "reset") {
    olvidar(groupId);
    return message.reply("🧹 Listo, me olvidé de todo lo que charlamos. Arrancamos de cero.");
  }

  const actual = db.getGroupLive(groupId);
  const infoActual = actual && llm.infoConectado(actual.llm_id);
  if (infoActual) {
    return message.reply(
      `🟢 El modo live ya está prendido con *${infoActual.model}* (LLM de ${infoActual.owner_name || "alguien del grupo"}).\n\n` +
      "_Para apagarlo:_ `/mbot live off`"
    );
  }

  const sinLlm =
    "🔌 No hay ningún LLM disponible ahora.\n\n" +
    "_Solo uso LLMs de gente que está en el grupo. Cualquiera puede sumar el suyo con_ `/mbot llm add` _por privado._";

  const ids = await identidadesDe(client, message);
  const elegido = await elegirLlm(client, message, groupId, ids, () => true);
  if (!elegido) return message.reply(sinLlm);

  db.setGroupLive(groupId, elegido.id, ids.phone || ids.lid);
  olvidar(groupId);
  const dueno = elegido.owner_name || "alguien del grupo";
  const memoria = (elegido.version || 1) >= P.VERSION_MEMORIA
    ? `🧩 Me acuerdo de las últimas ${MEMORIA.vueltas} preguntas y respuestas de la última hora. ` +
      `\`/mbot live reset\` para que me olvide.\n`
    : `🧩 Sin memoria: cada pregunta va sola (el agente de ${dueno} es una versión vieja).\n`;
  return message.reply(
    `🟢 *Modo live activado*\n\n` +
    `🧠 Modelo: *${elegido.model}* (LLM de ${dueno})\n\n` +
    `Escribime \`@MotiBot tu pregunta\` o \`/mbot tu pregunta\`, o respondé a una de mis respuestas, y te contesto.\n\n` +
    memoria +
    `👀 Lo que me escriban así (y lo que recuerdo) se procesa en la PC de ${dueno}.\n` +
    `_Para apagarlo:_ \`/mbot live off\``
  );
}

// ─── /mbot image (en un grupo) ───────────────────────────────────────────────
// Imágenes con el LLM de alguien del grupo que tenga la generación prendida.
// La imagen que devuelve el agente nunca llega tal cual a WhatsApp: imagen.js
// la re-codifica desde los píxeles en un proceso encerrado.
const imagen = require("./imagen");

const LIMITE_IMAGEN = {
  esperaUsuario: 2 * 60 * 1000, // una imagen cada 2 minutos por persona
  porDiaUsuario: 10,
  porDiaGrupo: 30,
};
const ultimaImagen = new Map();   // "grupo|autor" -> timestamp
const imagenesDelDia = new Map(); // "fecha|grupo" y "fecha|grupo|autor" -> cantidad
const gruposDibujando = new Set();

const hoyArgentina = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());

setInterval(() => {
  const hoy = hoyArgentina();
  for (const clave of imagenesDelDia.keys()) if (!clave.startsWith(hoy)) imagenesDelDia.delete(clave);
  const limite = Date.now() - LIMITE_IMAGEN.esperaUsuario;
  for (const [clave, ts] of ultimaImagen) if (ts < limite) ultimaImagen.delete(clave);
}, 10 * 60 * 1000).unref();

const USO_IMAGEN =
  "🎨 *Imágenes*\n\n" +
  "▸ `/mbot image <descripción>` — Pedir una imagen\n" +
  "▸ `/mbot image on|off` — Prenderlas o apagarlas en el grupo (admins)\n" +
  "▸ `/mbot image delete` — Borrar una imagen, respondiéndola (admins)\n\n" +
  "_Se dibujan con el LLM de alguien del grupo que tenga la generación de imágenes prendida._";

// ¿Es un /mbot image de un grupo? index.js lo atiende aparte de los demás
// comandos: una imagen tarda más que el tiempo que se le da a un comando.
function esPedidoDeImagen(message) {
  const body = String(message.body || "").trim();
  return /^\/mbot\s+image(\s|$)/i.test(body) && chatDe(message).endsWith("@g.us");
}

// Devuelve lo que hay que contestar: { texto } o { imagen: { data, caption } }
// (data = JPEG ya saneado, en base64). null si no hay que contestar nada.
async function comandoImagen(message, client) {
  const groupId = chatDe(message);
  const resto = String(message.body || "").trim().replace(/^\/mbot\s+image/i, "").trim();
  const arg = (resto.split(/\s+/)[0] || "").toLowerCase();

  const group = db.getGroup(groupId);
  if (!group || !group.active) {
    return { texto: "❌ ¡Todavía no me adoptaron en este equipo!\nAlguien con permisos tiene que usar `/mbot add`." };
  }
  if (!resto) {
    return { texto: `${USO_IMAGEN}\n\n${db.isImagesEnabled(groupId) ? "🟢 Prendidas en este grupo." : "⚪ Apagadas en este grupo."}` };
  }

  // Lo que solo pueden hacer los admins.
  if (["on", "off", "delete", "borrar"].includes(arg) && resto.split(/\s+/).length === 1) {
    if (!(await cmd().isAdmin(message, client))) {
      return { texto: "🔒 Solo los admins pueden prender, apagar o borrar imágenes." };
    }
    if (arg === "on" || arg === "off") {
      db.setImagesEnabled(groupId, arg === "on");
      return {
        texto: arg === "on"
          ? "🎨 Imágenes prendidas. Pidan una con `/mbot image <descripción>`.\n\n" +
            "_Se dibujan con el LLM de alguien del grupo. Un admin puede borrar cualquiera respondiéndola con_ `/mbot image delete`."
          : "⚪ Imágenes apagadas en este grupo.",
      };
    }
    return borrarImagen(message, client);
  }

  if (!db.isImagesEnabled(groupId)) {
    return { texto: "⚪ Las imágenes están apagadas en este grupo.\n\n_Un admin las prende con_ `/mbot image on`." };
  }

  const prompt = P.limpiarPromptImagen(resto);
  if (!prompt) return { texto: USO_IMAGEN };
  if (resto.length > P.LIMITES.promptImagen) {
    return { texto: `✂️ Describila en menos de ${P.LIMITES.promptImagen} caracteres.` };
  }

  // Límites de uso. El super admin no tiene ninguno (ni suma al cupo del grupo).
  const autor = message.author || message.from;
  const hoy = hoyArgentina();
  const claveUsuario = `${groupId}|${autor}`;
  const sinLimites = await cmd().esSuperAdmin(message);
  if (!sinLimites) {
    const espera = LIMITE_IMAGEN.esperaUsuario - (Date.now() - (ultimaImagen.get(claveUsuario) || 0));
    if (espera > 0) return { texto: `⏳ Podés pedir otra imagen en ${Math.ceil(espera / 1000)} s.` };
    if ((imagenesDelDia.get(`${hoy}|${claveUsuario}`) || 0) >= LIMITE_IMAGEN.porDiaUsuario) {
      return { texto: `🛑 Ya pediste ${LIMITE_IMAGEN.porDiaUsuario} imágenes hoy. Mañana podés pedir más.` };
    }
    if ((imagenesDelDia.get(`${hoy}|${groupId}`) || 0) >= LIMITE_IMAGEN.porDiaGrupo) {
      return { texto: `🛑 Este grupo ya pidió ${LIMITE_IMAGEN.porDiaGrupo} imágenes hoy. Mañana hay más.` };
    }
  }

  const ids = await identidadesDe(client, message);
  const live = db.getGroupLive(groupId);
  const elegido = await elegirLlm(client, message, groupId, ids,
    (a) => a.caps?.includes("image"), live?.llm_id);
  if (!elegido) {
    return {
      texto: "🔌 No hay nadie del grupo con la generación de imágenes conectada ahora.\n\n" +
        "_Se prende desde el acceso directo MotiBot LLM, eligiendo el modelo de imágenes._",
    };
  }
  if (gruposDibujando.has(groupId) || llm.ocupado(elegido.id)) {
    return { texto: "⏳ Estoy terminando otra cosa, probá en un ratito." };
  }

  if (!sinLimites) {
    ultimaImagen.set(claveUsuario, Date.now());
    imagenesDelDia.set(`${hoy}|${claveUsuario}`, (imagenesDelDia.get(`${hoy}|${claveUsuario}`) || 0) + 1);
    imagenesDelDia.set(`${hoy}|${groupId}`, (imagenesDelDia.get(`${hoy}|${groupId}`) || 0) + 1);
  }
  gruposDibujando.add(groupId);
  try { await message.react("🎨"); } catch (e) { /* no es importante */ }

  try {
    const crudo = await llm.pedirImagen(elegido.id, prompt);
    const limpia = await imagen.sanear(crudo);
    const pedidoPor = P.limpiarRespuesta(await cmd().nombreDeMensaje(client, message)).replace(/\s+/g, " ").slice(0, 60) || "alguien";
    const dueno = P.limpiarRespuesta(elegido.owner_name || "alguien del grupo").replace(/\s+/g, " ").slice(0, 60);
    // Termina con la firma de siempre: así el bot la reconoce como suya.
    const caption = `🎨 _${prompt.slice(0, 150)}_\n\n_— imagen · LLM de ${dueno} · pedida por ${pedidoPor}_`;
    console.log(`🎨 [live] Imagen ${limpia.width}x${limpia.height} en ${groupId} con el LLM #${elegido.id}.`);
    return { imagen: { data: limpia.data, caption } };
  } catch (e) {
    console.warn(`⚠️ [live] No salió la imagen en ${groupId} (LLM #${elegido.id}):`, e.message);
    if (e.message === "timeout") return { texto: "⌛ La imagen tardó demasiado. Probá de nuevo en un rato." };
    if (e.message === "desconectado") return { texto: "🔌 El LLM se desconectó mientras dibujaba." };
    if (e.message.startsWith("imagen rechazada")) return { texto: "🛡️ La imagen que llegó no pasó los controles de seguridad, así que no la publico." };
    return { texto: "⚠️ No pude dibujar esta vez. Probá de nuevo en un rato." };
  } finally {
    gruposDibujando.delete(groupId);
  }
}

// Las imágenes que mandó el bot, por el id del mensaje: así /mbot image
// delete las encuentra sin leer el mensaje citado de la página (en los
// grupos nuevos getQuotedMessage() revienta con "r"), y solo se puede borrar
// lo que el bot sabe que mandó él. WhatsApp deja borrar para todos por un
// tiempo limitado; se recuerdan 48 h.
const RECUERDO_IMAGENES = 48 * 60 * 60 * 1000;
const imagenesEnviadas = new Map(); // id del mensaje -> { mensaje, groupId, ts }

function registrarImagenEnviada(enviado, groupId) {
  const id = enviado?.id?.id;
  if (!id) return console.warn("⚠️ [live] La imagen se mandó pero no vino su id: no se podrá borrar con el comando.");
  imagenesEnviadas.set(id, { mensaje: enviado, groupId, ts: Date.now() });
  console.log(`🎨 [live] Imagen registrada para borrar: ${id} en ${groupId}.`);
}

// Plan B (por ejemplo, después de un reinicio del bot): la busca en la
// memoria de WhatsApp Web por su id, y sirve solo si la mandó el bot, es una
// imagen de este grupo y tiene la firma del LLM.
async function buscarImagenDelBot(client, stanzaId, groupId) {
  try {
    const serializado = await client.pupPage.evaluate((sid, gid) => {
      const m = window.Store.Msg.getModelsArray().find((x) => x.id?.id === sid);
      const chat = m?.id?.remote?._serialized || m?.id?.remote;
      return m && m.id.fromMe && m.type === "image" && chat === gid ? m.id._serialized : null;
    }, stanzaId, groupId);
    if (!serializado) return null;
    const mensaje = await client.getMessageById(serializado);
    return mensaje && esRespuestaLLM(mensaje.body) ? mensaje : null;
  } catch (e) {
    console.warn("⚠️ [live] No pude buscar la imagen en WhatsApp Web:", e.message);
    return null;
  }
}

setInterval(() => {
  const limite = Date.now() - RECUERDO_IMAGENES;
  for (const [id, r] of imagenesEnviadas) if (r.ts < limite) imagenesEnviadas.delete(id);
}, 60 * 60 * 1000).unref();

// /mbot image delete, respondiendo a una imagen del bot: la borra para todos.
async function borrarImagen(message, client) {
  if (!message.hasQuotedMsg) {
    return { texto: "💡 Respondé (reply) a la imagen que querés borrar con `/mbot image delete`." };
  }
  const groupId = chatDe(message);
  const idCitado = message._data?.quotedStanzaID;
  const registrada = idCitado && imagenesEnviadas.get(idCitado);
  let mensaje = registrada && registrada.groupId === groupId ? registrada.mensaje : null;
  if (!mensaje && idCitado) mensaje = await buscarImagenDelBot(client, idCitado, groupId);
  console.log(`🎨 [live] Borrar imagen: citada=${idCitado || "(sin id)"} · en memoria=${Boolean(registrada)} · encontrada=${Boolean(mensaje)} · registradas=${imagenesEnviadas.size}`);

  if (!mensaje) {
    return { texto: "❌ Solo puedo borrar imágenes que dibujé yo." };
  }
  try {
    await mensaje.delete(true);
    imagenesEnviadas.delete(idCitado);
    return null;
  } catch (e) {
    console.warn("⚠️ [live] No pude borrar la imagen:", e.message);
    return { texto: "⚠️ No pude borrarla (WhatsApp solo deja borrar para todos durante un tiempo)." };
  }
}

module.exports = {
  esPedidoDeImagen,
  comandoImagen,
  registrarImagenEnviada,
  // Para tests
  _memoria: { recuerdos, recordar, olvidar, MEMORIA },
  esRespuestaLLM,
  preguntaDelMensaje,
  responder,
  comandoLlm,
  comandoLive,
};
