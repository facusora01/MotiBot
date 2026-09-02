// Alertas de precio. El umbral lo pone la persona, no el bot: MotiBot no dice
// nunca si conviene vender ni sugiere un número. Lo único que aporta es estar
// mirando la pizarra todos los días, que es lo que la persona no puede hacer.
const db = require("./database");

// Alias hacia el código que usa la pizarra de ACAbase.
const GRANOS = {
  trigo: "TR",
  soja: "SO", soya: "SO",
  maiz: "MZ", maíz: "MZ",
  sorgo: "SG",
  girasol: "GI",
};

const NOMBRES = { TR: "Trigo", SO: "Soja", MZ: "Maíz", SG: "Sorgo", GI: "Girasol" };
const EMOJIS = { TR: "🌾", SO: "🫘", MZ: "🌽", SG: "🌱", GI: "🌻" };

function nombreGrano(codigo) {
  return NOMBRES[codigo] || codigo;
}

function emojiGrano(codigo) {
  return EMOJIS[codigo] || "•";
}

// Normaliza acentos para que "maíz" y "maiz" sean lo mismo.
function parsearGrano(texto) {
  const limpio = String(texto || "").toLowerCase().trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [alias, codigo] of Object.entries(GRANOS)) {
    const aliasLimpio = alias.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (aliasLimpio === limpio) return codigo;
  }
  return null;
}

// Acepta cómo se escribe un precio de verdad: 600000, 600.000, 600,000, $600.000
// y también "600k" / "600 mil". Devuelve null si no es un número usable.
function parsearMonto(texto) {
  let t = String(texto || "").toLowerCase().trim().replace(/^\$\s*/, "").replace(/\s/g, "");
  if (!t) return null;

  let multiplicador = 1;
  if (t.endsWith("k") || t.endsWith("mil")) {
    multiplicador = 1000;
    t = t.replace(/(k|mil)$/, "");
  }

  // Separadores de miles: los puntos y las comas acá nunca son decimales (la
  // pizarra va en pesos enteros por tonelada).
  t = t.replace(/[.,]/g, "");
  if (!/^\d+$/.test(t)) return null;

  const n = parseInt(t, 10) * multiplicador;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function pesos(n) {
  return Number(n).toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

// Qué significa "se cumplió": si el objetivo está por encima del precio de hoy,
// la alerta espera una suba; si está por debajo, una baja. Se decide al crearla
// y queda guardado, así el disparo no cambia de sentido si el precio se mueve.
function direccionPara(precioActual, objetivo) {
  return objetivo >= precioActual ? "sube" : "baja";
}

function seCumplio(alerta, precio) {
  return alerta.direccion === "sube" ? precio >= alerta.objetivo : precio <= alerta.objetivo;
}

// Texto de una alerta en el listado.
function describir(alerta, i) {
  const flecha = alerta.direccion === "sube" ? "🔼 llegue a" : "🔻 baje a";
  const quien = alerta.user_name ? ` · ${alerta.user_name}` : "";
  return `*${i + 1}.* ${emojiGrano(alerta.producto)} ${nombreGrano(alerta.producto)} — ${flecha} $ ${pesos(alerta.objetivo)}${quien}`;
}

// Evalúa todas las alertas contra la pizarra del día y devuelve, agrupado por
// chat, las que se cumplieron. No toca la base: borrar es responsabilidad del
// llamador, y recién después de que el aviso salió.
function evaluar(granos) {
  const precios = {};
  for (const g of granos) precios[g.codigo] = g.importe;

  const porChat = new Map();

  for (const alerta of db.getTodasLasAlertas()) {
    const precio = precios[alerta.producto];
    if (precio === undefined) continue; // ese grano no vino en la pizarra de hoy
    if (!seCumplio(alerta, precio)) continue;

    if (!porChat.has(alerta.chat_id)) porChat.set(alerta.chat_id, []);
    porChat.get(alerta.chat_id).push({ alerta, precio });
  }

  return porChat;
}

// El aviso: qué pediste, cuánto vale hoy, y nada más. Sin flechas de tendencia,
// sin "momento de vender": el criterio ya lo puso la persona cuando la creó.
function mensajeDisparo(cumplidas, fechaPizarra) {
  const lineas = cumplidas.map(({ alerta, precio }) => {
    const pedido = alerta.direccion === "sube" ? "llegara a" : "bajara a";
    const quien = alerta.user_name ? `${alerta.user_name} pidió` : "Pediste";
    return (
      `${emojiGrano(alerta.producto)} *${nombreGrano(alerta.producto)}: $ ${pesos(precio)}*\n` +
      `    _${quien} aviso cuando ${pedido} $ ${pesos(alerta.objetivo)}._`
    );
  });

  const plural = cumplidas.length === 1 ? "tu alerta" : "tus alertas";

  return (
    `🔔 *Se cumplió ${plural}* 🔔\n` +
    `📅 Pizarra del ${fechaPizarra}\n\n` +
    `${lineas.join("\n\n")}\n\n` +
    `_${cumplidas.length === 1 ? "La borro" : "Las borro"} para no repetir el aviso todos los días. ` +
    `Podés crear otra con_ \`/mbot alerta <grano> <precio>\`\n\n` +
    `_Información de referencia (pizarra ACAbase), no es una recomendación de venta._`
  );
}

module.exports = {
  parsearGrano,
  parsearMonto,
  direccionPara,
  seCumplio,
  describir,
  evaluar,
  mensajeDisparo,
  nombreGrano,
  emojiGrano,
  pesos,
  GRANOS_VALIDOS: Object.keys(NOMBRES),
};
