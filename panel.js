// Panel del super admin: gestión de MotiBot desde su chat privado, sin SSH.
// Todo se referencia por el NÚMERO de la lista de `/admin grupos` (los ids de
// WhatsApp son impronunciables); ese orden es estable porque getAllGroups()
// ordena solo por id de alta, así dar de baja un grupo no renumera al resto.
const db = require("./database");
const { getMercado } = require("./mercado");
const historia = require("./historia");
const alertasMod = require("./alertas");

const AYUDA = `
🛠️ *Panel de MotiBot* — solo super admins

*📋 Grupos*
▸ \`/admin grupos\` — listar todos (con su número)
▸ \`/admin info <n>\` — ficha completa de un grupo
▸ \`/admin baja <n>\` — dejar de mandar ahí (sigo adentro del grupo)
▸ \`/admin alta <n>\` — volver a activarlo
▸ \`/admin salir <n>\` — irme del grupo de WhatsApp (pide confirmación)
▸ \`/admin borrar <n>\` — borrar de la base un grupo dado de baja
▸ \`/admin borrar bajas\` — borrar todos los que estén dados de baja
▸ \`/admin decir <n> <texto>\` — mandar un mensaje al grupo

*🚜 Modo del grupo*
▸ \`/admin phrase off <n>\` — solo mercado: apaga frases, cumples e ideas
▸ \`/admin phrase on <n>\` — volver al MotiBot completo
▸ \`/admin phrase\` — ver qué grupos están en solo mercado

_Los admins de cada grupo también lo manejan con_ \`/mbot phrase on|off\`_._

*🌾 Mercado de granos* _(la pizarra diaria)_
▸ \`/admin mercado on <n>\` — *prenderlo en el grupo n*
▸ \`/admin mercado off <n>\` — apagarlo ahí
▸ \`/admin mercado on todos\` — prenderlo en todos los grupos activos
▸ \`/admin mercado\` — ver en qué grupos está prendido
▸ \`/admin mercado ver\` — previsualizar la cotización acá, sin mandarla
▸ \`/admin mercado ya <n>\` — mandarla al grupo n ahora mismo
▸ \`/admin mercado hora <n> <HH:MM>\` — a partir de qué hora esperar la pizarra
▸ \`/admin historia\` — ver la serie de precios guardada (y recargarla)

_Los admins de cada grupo también la prenden con_ \`/mbot mercado on|off\`_._

_El \`<n>\` es el número que le toca al grupo en \`/admin grupos\`._
_Ejemplo: \`/admin grupos\` y después \`/admin mercado on 2\`._
`.trim();

const HORA_REGEX = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;

function fmtHora(hhmm) {
  const m = String(hhmm || "09:00").match(HORA_REGEX);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "09:00";
}

// Los grupos se listan siempre en el mismo orden; el índice que ve el super
// admin es 1-based sobre esa lista.
function listarGrupos() {
  return db.getAllGroups();
}

// Devuelve { grupo } o { error } ya redactado, para que cada comando solo
// reenvíe el mensaje.
function resolverGrupo(arg) {
  const grupos = listarGrupos();
  if (!grupos.length) return { error: "📭 Todavía no hay ningún grupo registrado." };

  const n = parseInt(String(arg || "").trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > grupos.length) {
    return { error: `❌ Número de grupo inválido. Elegí uno del 1 al ${grupos.length} (mirá \`/admin grupos\`).` };
  }
  return { grupo: grupos[n - 1], n };
}

function lineaGrupo(g, i) {
  const s = db.getGroupSettings(g.group_id);
  const estado = g.active ? "🟢" : "⚪";
  const mercado = s?.market_enabled ? ` · 🌾 ${fmtHora(s.market_time)}` : "";

  // En modo solo mercado la hora y la frecuencia de las frases no significan
  // nada: mostrarlas confundiria.
  const detalle = db.isPhrasesEnabled(g.group_id)
    ? `${s?.send_time || "08:00"} hs · ${s?.frequency || 1}x/día${mercado}`
    : `🚜 solo mercado${mercado}`;

  return `*${i + 1}.* ${estado} ${g.group_name || "(sin nombre)"}\n     _${detalle}_`;
}

async function comandoGrupos(message) {
  const grupos = listarGrupos();
  if (!grupos.length) {
    return message.reply("📭 Todavía no hay ningún grupo registrado. Usá `/mbot add` dentro de un grupo para sumarlo.");
  }

  const activos = grupos.filter((g) => g.active).length;
  const lineas = grupos.map(lineaGrupo);

  return message.reply(
    `📋 *Grupos de MotiBot* (${activos} activo${activos === 1 ? "" : "s"} de ${grupos.length})\n\n` +
    `${lineas.join("\n\n")}\n\n` +
    `_🟢 activo · ⚪ dado de baja · 🌾 mercado · 🚜 solo mercado_\n` +
    `Detalle: \`/admin info <n>\``
  );
}

async function comandoInfo(message, arg) {
  const { grupo, error } = resolverGrupo(arg);
  if (error) return message.reply(error);

  const s = db.getGroupSettings(grupo.group_id);
  const custom = {
    active: "✅ Activa",
    pending: "⏳ Pendiente",
  }[s?.use_custom] || "❌ Clásicas";

  return message.reply(
    `📍 *${grupo.group_name || "(sin nombre)"}*\n\n` +
    `Estado: ${grupo.active ? "🟢 activo" : "⚪ dado de baja"}\n` +
    `Idioma: ${s?.language === "en" ? "Inglés 🇬🇧" : "Español 🇦🇷"}\n` +
    `Modo: ${db.isPhrasesEnabled(grupo.group_id) ? "MotiBot completo" : "🚜 solo mercado"}\n` +
    `Horario: ${s?.send_time || "08:00"} hs · ${s?.frequency || 1} vez/día\n` +
    `Librería custom: ${custom}\n` +
    `Frases: ${db.countCustomPhrases(grupo.group_id)}\n` +
    `Cumpleaños: ${db.countBirthdays(grupo.group_id)}\n` +
    `Ideas: ${db.countIdeas(grupo.group_id)}\n` +
    `Mercado de granos: ${s?.market_enabled ? `🌾 activo, desde las ${fmtHora(s.market_time)}` : "apagado"}\n\n` +
    `\`\`\`${grupo.group_id}\`\`\``
  );
}

async function comandoBaja(message, arg) {
  const { grupo, error } = resolverGrupo(arg);
  if (error) return message.reply(error);

  if (!grupo.active) return message.reply(`ℹ️ *${grupo.group_name}* ya estaba dado de baja.`);

  db.removeGroup(grupo.group_id);
  return message.reply(
    `✅ *${grupo.group_name}* dado de baja. No le mando más nada.\n\n` +
    `_Sigo dentro del grupo de WhatsApp: para irme del todo usá \`/admin salir\`. Para reactivarlo, \`/admin alta\`. Para borrarlo de la base, \`/admin borrar\`._`
  );
}

async function comandoAlta(message, arg) {
  const { grupo, error } = resolverGrupo(arg);
  if (error) return message.reply(error);

  if (grupo.active) return message.reply(`ℹ️ *${grupo.group_name}* ya estaba activo.`);

  db.reactivateGroup(grupo.group_id);
  const s = db.getGroupSettings(grupo.group_id);
  return message.reply(`✅ *${grupo.group_name}* reactivado. Vuelvo a pasar a las ${s?.send_time || "08:00"} hs.`);
}

// Irse de un grupo no se deshace desde acá (habría que volver a invitar al bot):
// pedimos la palabra "confirmar" antes de ejecutar.
async function comandoSalir(message, client, arg, confirmacion) {
  const { grupo, n, error } = resolverGrupo(arg);
  if (error) return message.reply(error);

  if (String(confirmacion || "").toLowerCase() !== "confirmar") {
    return message.reply(
      `⚠️ Esto me saca del grupo *${grupo.group_name}* en WhatsApp. Para volver a entrar tenés que invitarme de nuevo.\n\n` +
      `Si estás seguro:\n\`/admin salir ${n} confirmar\``
    );
  }

  try {
    const chat = await client.getChatById(grupo.group_id);
    await chat.leave();
  } catch (e) {
    console.error("❌ No pude salir del grupo:", e.message);
    return message.reply(`⚠️ No pude salir de *${grupo.group_name}* (${e.message}). Lo dejo como está.`);
  }

  db.removeGroup(grupo.group_id);
  return message.reply(`👋 Salí de *${grupo.group_name}* y lo di de baja.`);
}

// Borrado definitivo, y solo sobre grupos ya dados de baja: pedir la baja
// primero obliga a pasar por un paso reversible antes del que no lo es. Se
// lleva puestas las frases, los cumples y las ideas del grupo, así que además
// pide confirmación con el conteo de lo que se pierde a la vista.
async function comandoBorrar(message, arg, confirmacion) {
  // `/admin borrar bajas` limpia de una todos los inactivos.
  if (String(arg || "").toLowerCase() === "bajas") {
    const bajas = listarGrupos().filter((g) => !g.active);
    if (!bajas.length) return message.reply("✅ No hay ningún grupo dado de baja para borrar.");

    if (String(confirmacion || "").toLowerCase() !== "confirmar") {
      const lista = bajas.map((g) => `▸ ${g.group_name || "(sin nombre)"} — ${resumenDatos(g.group_id)}`).join("\n");
      return message.reply(
        `⚠️ Voy a borrar *${bajas.length}* grupo${bajas.length === 1 ? "" : "s"} dado${bajas.length === 1 ? "" : "s"} de baja, con todos sus datos:\n\n${lista}\n\n` +
        `Esto no se puede deshacer. Si estás seguro:\n\`/admin borrar bajas confirmar\``
      );
    }

    for (const g of bajas) db.deleteGroupCompleto(g.group_id);
    console.warn(`🗑️ Borrados ${bajas.length} grupos dados de baja desde el panel.`);
    return message.reply(
      `🗑️ Borré ${bajas.length} grupo${bajas.length === 1 ? "" : "s"} y sus datos.\n\n_Los números de \`/admin grupos\` se recorrieron._`
    );
  }

  const { grupo, n, error } = resolverGrupo(arg);
  if (error) return message.reply(error);

  if (grupo.active) {
    return message.reply(
      `❌ *${grupo.group_name}* está activo. Solo borro grupos dados de baja.\n\n` +
      `Si querés eliminarlo, primero:\n\`/admin baja ${n}\``
    );
  }

  if (String(confirmacion || "").toLowerCase() !== "confirmar") {
    return message.reply(
      `⚠️ Esto borra *${grupo.group_name}* de la base junto con ${resumenDatos(grupo.group_id)}. No se puede deshacer.\n\n` +
      `Si algún día vuelvo a ese grupo, arranca de cero con \`/mbot add\`.\n\n` +
      `Si estás seguro:\n\`/admin borrar ${n} confirmar\``
    );
  }

  db.deleteGroupCompleto(grupo.group_id);
  console.warn(`🗑️ Grupo borrado desde el panel: ${grupo.group_name} (${grupo.group_id})`);

  return message.reply(
    `🗑️ Borré *${grupo.group_name}* y todos sus datos.\n\n_Ojo: los números de \`/admin grupos\` se corrieron._`
  );
}

// "12 frases, 3 cumples y 5 ideas" — lo que se pierde con el borrado, para que
// la confirmación no sea a ciegas.
function resumenDatos(groupId) {
  const partes = [
    [db.countCustomPhrases(groupId), "frase", "frases"],
    [db.countBirthdays(groupId), "cumple", "cumples"],
    [db.countIdeas(groupId), "idea", "ideas"],
  ]
    .filter(([n]) => n > 0)
    .map(([n, sing, plur]) => `${n} ${n === 1 ? sing : plur}`);

  if (!partes.length) return "sus datos (no tenía nada cargado)";
  if (partes.length === 1) return partes[0];
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}

async function comandoDecir(message, client, arg, texto) {
  const { grupo, error } = resolverGrupo(arg);
  if (error) return message.reply(error);

  if (!texto || !texto.trim()) {
    return message.reply("❌ Falta el mensaje.\n\n`/admin decir <n> <texto>`");
  }

  try {
    await client.sendMessage(grupo.group_id, texto.trim());
  } catch (e) {
    console.error("❌ No pude mandar el mensaje:", e.message);
    return message.reply(`⚠️ No pude mandarlo a *${grupo.group_name}*: ${e.message}`);
  }

  return message.reply(`✅ Enviado a *${grupo.group_name}*.`);
}

// Modo solo mercado: apagar las frases deja al grupo con la pizarra y nada más
// (ni frase diaria, ni cumples, ni ideas, y MotiBot ignora esos comandos ahí).
async function comandoFrases(message, partes) {
  const accion = (partes[0] || "").toLowerCase();

  if (accion !== "on" && accion !== "off") {
    const grupos = listarGrupos()
      .map((g, i) => ({ g, i }))
      .filter((x) => !db.isPhrasesEnabled(x.g.group_id));

    const detalle = grupos.length
      ? grupos.map((x) => `*${x.i + 1}.* ${x.g.active ? "🟢" : "⚪"} ${x.g.group_name}`).join("\n")
      : "_Todos los grupos tienen las frases prendidas._";

    return message.reply(
      `🚜 *Grupos en modo solo mercado*\n\n${detalle}\n\n` +
      `Apagar las frases en un grupo: \`/admin phrase off <n>\`\n` +
      `Volver a prenderlas: \`/admin phrase on <n>\``
    );
  }

  const encender = accion === "on";
  const { grupo, n, error } = resolverGrupo(partes[1]);
  if (error) return message.reply(error);

  db.setPhrasesEnabled(grupo.group_id, encender);

  if (encender) {
    const s = db.getGroupSettings(grupo.group_id);
    return message.reply(
      `✅ Frases *prendidas* en *${grupo.group_name}*.\n\n` +
      `Vuelve todo: frase diaria a las ${s?.send_time || "08:00"} hs, cumpleaños, ideas y los comandos de siempre.`
    );
  }

  // Sin mercado ni frases el bot queda mudo en ese grupo: mejor decirlo ahora
  // que dejarlo descubrir que MotiBot dejó de existir ahí.
  const aviso = db.isMarketEnabled(grupo.group_id)
    ? `Sigue mandando la pizarra de granos a las ${fmtHora(db.getGroupSettings(grupo.group_id)?.market_time)} hs.`
    : `⚠️ *Ojo:* ese grupo tampoco tiene el mercado activado, así que ahí no voy a hacer nada.\nPrendelo con \`/admin mercado on ${n}\`.`;

  return message.reply(
    `🚜 *${grupo.group_name}* pasa a *modo solo mercado*.\n\n` +
    `Se apagan la frase diaria, los cumpleaños, las ideas y todos esos comandos: si alguien los usa ahí, ni contesto.\n\n` +
    `${aviso}\n\n_Para revertirlo:_ \`/admin phrase on ${n}\``
  );
}

// Estado de la serie de precios guardada. Sirve para saber si el backfill
// corrió y si la puesta al día diaria está entrando.
async function comandoHistoria(message, partes) {
  const accion = (partes[0] || "").toLowerCase();

  if (accion === "cargar" || accion === "backfill") {
    await message.reply(`\u{1F4DA} Traigo la historia de Matba Rofex (${historia.ANIOS_BACKFILL} años). Puede tardar un minuto...`);
    const hoy = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    const res = await historia.backfill(hoy);
    const lineas = res.map(
      (r) => `${alertasMod.emojiGrano(r.codigo)} ${alertasMod.nombreGrano(r.codigo)}: ${r.ruedas} ruedas${r.error ? " \u26a0\ufe0f" : ""}`
    );
    return message.reply(`\u{1F4DA} *Carga terminada*\n\n${lineas.join("\n")}`);
  }

  const resumen = db.resumenMatba();
  if (!resumen.length) {
    return message.reply(
      "\u{1F4DA} Todavía no hay historia de precios guardada.\n\n_Traerla ahora:_ `/admin historia cargar`"
    );
  }

  const lineas = resumen.map(
    (r) => `${alertasMod.emojiGrano(r.producto)} *${alertasMod.nombreGrano(r.producto)}* — ${r.ruedas} ruedas\n     _${r.desde} a ${r.hasta}_`
  );

  return message.reply(
    `\u{1F4DA} *Historia de precios guardada*\n\n${lineas.join("\n\n")}\n\n` +
    `_Fuente: Matba Rofex. Se pone al día sola cuando cierra la rueda._\n` +
    `_Recargar todo:_ \`/admin historia cargar\``
  );
}

// ─── MERCADO ──────────────────────────────────────────────────────────────────
async function comandoMercado(message, client, partes) {
  const accion = (partes[0] || "").toLowerCase();

  if (!accion) {
    const grupos = listarGrupos();
    const conMercado = grupos
      .map((g, i) => ({ g, i, s: db.getGroupSettings(g.group_id) }))
      .filter((x) => x.s?.market_enabled);

    const detalle = conMercado.length
      ? conMercado.map((x) => `*${x.i + 1}.* ${x.g.active ? "🟢" : "⚪"} ${x.g.group_name} — desde las ${fmtHora(x.s.market_time)} hs`).join("\n")
      : "_Ningún grupo lo tiene activo._";

    return message.reply(
      `🌾 *Mercado de granos*\n\n${detalle}\n\n` +
      `Activar: \`/admin mercado on <n>\`\n` +
      `Previsualizar: \`/admin mercado ver\``
    );
  }

  if (accion === "ver") {
    try {
      const { texto } = await getMercado({ forzar: true });
      return message.reply(texto);
    } catch (e) {
      return message.reply(`⚠️ No pude leer la pizarra: ${e.message}`);
    }
  }

  if (accion === "on" || accion === "off") {
    const encender = accion === "on";
    const destino = (partes[1] || "").toLowerCase();

    if (destino === "todos" || destino === "all") {
      const activos = db.getActiveGroups();
      for (const g of activos) db.setMarketEnabled(g.group_id, encender);
      return message.reply(
        `${encender ? "🌾 Activado" : "🔕 Desactivado"} el mercado en los ${activos.length} grupos activos.`
      );
    }

    const { grupo, n, error } = resolverGrupo(partes[1]);
    if (error) return message.reply(error);

    db.setMarketEnabled(grupo.group_id, encender);
    const s = db.getGroupSettings(grupo.group_id);

    return message.reply(
      encender
        ? `🌾 Mercado de granos *activado* en *${grupo.group_name}*.\n\nLo mando *apenas se publica la pizarra del día*, sin buscarla antes de las *${fmtHora(s?.market_time)} hs*. Una vez por día, y solo los días con rueda.\n\n_Cambiar horario:_ \`/admin mercado hora ${n} HH:MM\`\n_Probarlo ahora:_ \`/admin mercado ya ${n}\``
        : `🔕 Mercado de granos *desactivado* en *${grupo.group_name}*.`
    );
  }

  if (accion === "hora") {
    const { grupo, error } = resolverGrupo(partes[1]);
    if (error) return message.reply(error);

    const hora = String(partes[2] || "").trim();
    if (!HORA_REGEX.test(hora)) {
      return message.reply("❌ Hora inválida. Usá el formato HH:MM (ej: `09:30`).\n\n`/admin mercado hora <n> HH:MM`");
    }

    db.setMarketTime(grupo.group_id, fmtHora(hora));
    return message.reply(`⏰ En *${grupo.group_name}* empiezo a buscar la pizarra a las *${fmtHora(hora)} hs* y la mando apenas se publique.

_La rueda suele cargarse cerca de las 10:30._`);
  }

  if (accion === "ya") {
    const { grupo, error } = resolverGrupo(partes[1]);
    if (error) return message.reply(error);

    let texto;
    try {
      ({ texto } = await getMercado({ forzar: true }));
    } catch (e) {
      return message.reply(`⚠️ No pude leer la pizarra: ${e.message}`);
    }

    try {
      await client.sendMessage(grupo.group_id, texto);
    } catch (e) {
      return message.reply(`⚠️ No pude enviarlo a *${grupo.group_name}*: ${e.message}`);
    }

    return message.reply(`✅ Cotización enviada a *${grupo.group_name}*.`);
  }

  return message.reply(`❓ No conozco \`/admin mercado ${accion}\`. Opciones: \`ver\`, \`on\`, \`off\`, \`hora\`, \`ya\`.`);
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
// El llamador ya verificó que es el super admin en su privado.
async function handleAdminPanel(message, client) {
  const body = (message.body || "").trim();
  const partes = body.split(/\s+/);
  const sub = (partes[1] || "").toLowerCase();

  if (!sub || sub === "help" || sub === "ayuda") return message.reply(AYUDA);

  if (sub === "grupos" || sub === "groups") return comandoGrupos(message);
  if (sub === "info") return comandoInfo(message, partes[2]);
  if (sub === "baja" || sub === "off") return comandoBaja(message, partes[2]);
  if (sub === "alta" || sub === "on") return comandoAlta(message, partes[2]);
  if (sub === "salir" || sub === "leave") return comandoSalir(message, client, partes[2], partes[3]);
  if (sub === "borrar" || sub === "delete") return comandoBorrar(message, partes[2], partes[3]);

  if (sub === "decir" || sub === "say") {
    // El texto es todo lo que sigue al número, con sus espacios originales
    // (partir por /\s+/ y volver a unir aplastaría saltos de línea y sangrías).
    const m = body.match(/^\/admin\s+\S+\s+(\S+)\s*([\s\S]*)$/);
    return comandoDecir(message, client, partes[2], m ? m[2] : "");
  }

  if (sub === "phrase" || sub === "frases" || sub === "frase") return comandoFrases(message, partes.slice(2));
  if (sub === "historia") return comandoHistoria(message, partes.slice(2));
  if (sub === "mercado") return comandoMercado(message, client, partes.slice(2));

  return message.reply(`❓ No conozco \`/admin ${sub}\`.\n\n${AYUDA}`);
}

module.exports = { handleAdminPanel, AYUDA };
