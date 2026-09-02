// Panel del super admin: gestión de MotiBot desde su chat privado, sin SSH.
// Todo se referencia por el NÚMERO de la lista de `/admin grupos` (los ids de
// WhatsApp son impronunciables); ese orden es estable porque getAllGroups()
// ordena por activo y luego por id de alta.
const db = require("./database");
const { getMercado } = require("./mercado");

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

*🌾 Mercado de granos*
▸ \`/admin mercado\` — ver dónde está activo
▸ \`/admin mercado ver\` — previsualizar la cotización de hoy acá
▸ \`/admin mercado on <n|todos>\` — activarlo en un grupo
▸ \`/admin mercado off <n|todos>\` — desactivarlo
▸ \`/admin mercado hora <n> <HH:MM>\` — horario del envío diario
▸ \`/admin mercado ya <n>\` — mandarlo al grupo ahora mismo

_Ejemplo:_ \`/admin mercado on 2\`
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
  return `*${i + 1}.* ${estado} ${g.group_name || "(sin nombre)"}\n     _${s?.send_time || "08:00"} hs · ${s?.frequency || 1}x/día${mercado}_`;
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
    `_🟢 activo · ⚪ dado de baja · 🌾 mercado de granos_\n` +
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
    `Horario: ${s?.send_time || "08:00"} hs · ${s?.frequency || 1} vez/día\n` +
    `Librería custom: ${custom}\n` +
    `Frases: ${db.countCustomPhrases(grupo.group_id)}\n` +
    `Cumpleaños: ${db.countBirthdays(grupo.group_id)}\n` +
    `Ideas: ${db.countIdeas(grupo.group_id)}\n` +
    `Mercado de granos: ${s?.market_enabled ? `🌾 activo a las ${fmtHora(s.market_time)}` : "apagado"}\n\n` +
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

// ─── MERCADO ──────────────────────────────────────────────────────────────────
async function comandoMercado(message, client, partes) {
  const accion = (partes[0] || "").toLowerCase();

  if (!accion) {
    const grupos = listarGrupos();
    const conMercado = grupos
      .map((g, i) => ({ g, i, s: db.getGroupSettings(g.group_id) }))
      .filter((x) => x.s?.market_enabled);

    const detalle = conMercado.length
      ? conMercado.map((x) => `*${x.i + 1}.* ${x.g.active ? "🟢" : "⚪"} ${x.g.group_name} — ${fmtHora(x.s.market_time)} hs`).join("\n")
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
        ? `🌾 Mercado de granos *activado* en *${grupo.group_name}*.\n\nLo mando todos los días a las *${fmtHora(s?.market_time)} hs* (días hábiles, cuando hay pizarra nueva).\n\n_Cambiar horario:_ \`/admin mercado hora ${n} HH:MM\`\n_Probarlo ahora:_ \`/admin mercado ya ${n}\``
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
    return message.reply(`⏰ El mercado sale a las *${fmtHora(hora)} hs* en *${grupo.group_name}*.`);
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

  if (sub === "mercado") return comandoMercado(message, client, partes.slice(2));

  return message.reply(`❓ No conozco \`/admin ${sub}\`.\n\n${AYUDA}`);
}

module.exports = { handleAdminPanel, AYUDA };
