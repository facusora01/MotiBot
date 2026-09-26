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
  "new", "birthday", "idea", "ideas", "admin",
]);

const SISTEMA = [
  "Sos MotiBot, un bot de WhatsApp buena onda que participa de un chat grupal.",
  "Respondé en el idioma del mensaje, de forma breve (menos de 800 caracteres) y sin inventar datos.",
  "Solo podés conversar: no tenés herramientas, no podés ejecutar nada ni acceder a archivos, links ni sistemas.",
  "Si te piden algo de eso, explicá que solo podés chatear.",
  "Formato de WhatsApp: *negrita* y _cursiva_. Nada de títulos con # ni tablas.",
  "Respondé directo: no pongas tu nombre ni \"MotiBot:\" al principio.",
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

  // Reply a una respuesta del LLM.
  const citado = message.hasQuotedMsg ? message._data?.quotedMsg : null;
  if (!citado || !esRespuestaLLM(citado.body)) return null;
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
    return "🔌 El LLM que estaba usando se desconectó, así que apagué el modo live.\n\n" +
      "_Un admin lo puede volver a prender con_ `/mbot live`.";
  }

  if (pregunta.length > P.LIMITES.pregunta) {
    return `✂️ Es muy largo para mí: resumilo en menos de ${P.LIMITES.pregunta} caracteres.`;
  }

  const clave = `${groupId}|${message.author || message.from}`;
  if (Date.now() - (ultimoUso.get(clave) || 0) < COOLDOWN_USUARIO) {
    return "⏳ Dame unos segundos entre pregunta y pregunta.";
  }
  if (gruposPensando.has(groupId) || llm.ocupado(live.llm_id)) {
    return "⏳ Estoy terminando otra respuesta, probá en un ratito.";
  }

  ultimoUso.set(clave, Date.now());
  gruposPensando.add(groupId);
  try {
    const nombre = P.limpiarRespuesta(await cmd().nombreDeMensaje(client, message)).replace(/\s+/g, " ").slice(0, 60);
    const mensajes = [{ role: "system", content: SISTEMA }];
    if (citado) mensajes.push({ role: "assistant", content: citado.slice(0, P.LIMITES.contenidoPorMensaje) });
    mensajes.push({ role: "user", content: `(Te escribe ${nombre || "alguien del grupo"})\n${pregunta}` });

    const texto = await llm.preguntar(live.llm_id, mensajes);
    return P.formatearRespuesta(texto, info.model, info.owner_name);
  } catch (e) {
    console.warn(`⚠️ [live] El LLM #${live.llm_id} no respondió en ${groupId}:`, e.message);
    if (e.message === "desconectado") {
      db.borrarGroupLive(groupId);
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

  const base = llm.urlPublica();
  await message.reply(
    `🧠 *Sumá tu LLM a MotiBot*\n\n` +
    `1. Instalá Ollama (ollama.com) y bajá un modelo:\n` +
    `   \`ollama pull llama3.1\`\n\n` +
    `2. Bajá el agente (necesita Node 22 o más nuevo):\n` +
    `   ${base}/motibot-agent.js\n\n` +
    `3. Correlo con el token que te mando abajo:\n` +
    `   \`node --permission motibot-agent.js --model llama3.1 --token <token>\`\n\n` +
    `🔒 Tu PC no abre ningún puerto: el agente se conecta solo a MotiBot y únicamente le pasa texto a tu Ollama.\n` +
    `🛡️ El agente corre encerrado (\`--permission\`): no puede leer ni escribir tus archivos ni ejecutar nada, y no le da herramientas al modelo. ` +
    `Dejá Ollama escuchando solo en tu PC (es lo que viene por defecto).\n` +
    `👀 Ojo: en los grupos donde se use tu LLM, lo que le escriban al bot se procesa en tu PC.\n` +
    `⚠️ El token es una contraseña. Si se filtra, \`/mbot llm add\` genera otro y anula este.` +
    (anterior ? `\n\n_Generé un token nuevo: el anterior dejó de servir._` : "")
  );
  // Solo y sin formato, para copiarlo con un toque.
  await client.sendMessage(chatDe(message), token);
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
  if (arg && arg !== "off") return message.reply("❓ Usá `/mbot live` para prenderlo o `/mbot live off` para apagarlo.");

  if (!(await cmd().isAdmin(message, client))) {
    return message.reply("🔒 Solo los admins pueden prender o apagar el modo live.");
  }

  if (arg === "off") {
    return message.reply(
      db.borrarGroupLive(groupId) ? "⚪ Modo live apagado. Vuelvo a ser el MotiBot de siempre." : "⚪ El modo live no estaba prendido."
    );
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

  const conectados = llm.habilitado() ? llm.conectados() : [];
  if (!conectados.length) return message.reply(sinLlm);

  // Primero el LLM de quien lo prende; si no tiene, el de otro miembro. Si no
  // se pueden leer los participantes, solo el propio: no le mandamos los
  // mensajes del grupo a la PC de alguien que no está en él.
  const ids = await identidadesDe(client, message);
  let elegido = conectados.find((a) => esDe(a, ids));

  if (!elegido) {
    const participantes = await cmd().participantesDelGrupo(client, groupId);
    if (participantes) {
      const miembros = new Set();
      for (const p of participantes) {
        for (const id of [p.id?._serialized, p.lid, p.pn, p.phoneNumber]) {
          const u = soloUser(id);
          if (u) miembros.add(u);
        }
      }
      elegido = conectados.find((a) => [a.owner_phone, a.owner_lid].some((x) => x && miembros.has(x)));
    }
  }

  if (!elegido) return message.reply(sinLlm);

  db.setGroupLive(groupId, elegido.id, ids.phone || ids.lid);
  const dueno = elegido.owner_name || "alguien del grupo";
  return message.reply(
    `🟢 *Modo live activado*\n\n` +
    `🧠 Modelo: *${elegido.model}* (LLM de ${dueno})\n\n` +
    `Escribime \`@MotiBot tu pregunta\` o \`/mbot tu pregunta\`, o respondé a una de mis respuestas, y te contesto.\n\n` +
    `👀 Lo que me escriban así se procesa en la PC de ${dueno}.\n` +
    `_Para apagarlo:_ \`/mbot live off\``
  );
}

module.exports = {
  esRespuestaLLM,
  preguntaDelMensaje,
  responder,
  comandoLlm,
  comandoLive,
};
