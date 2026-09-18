// Cotización de granos: pizarra de Barrilli (https://www.barrilli.com.ar/mercados,
// solapa "Pizarra"). Antes leíamos el feed de ACAbase, que publica la pizarra de
// la Cámara de Rosario y solo esa plaza: es una referencia, pero no es el precio
// al que operan los semilleros. Barrilli publica la misma fijación de Rosario en
// pesos MÁS las plazas de puerto (Quequén, Bahía Blanca, Buenos Aires) en
// dólares, que es lo que se mira para vender.
//
// La página es HTML renderizado del lado del servidor (no hay JSON detrás) y la
// tabla vive dentro del panel #pizarra.
const PIZARRA_URL = "https://www.barrilli.com.ar/mercados";

// Dólar Banco Nación (la placa lo muestra al pie, compra/venta).
const DOLAR_URL = "https://dolarapi.com/v1/dolares/oficial";

const TIMEOUT = 12000;

// La pizarra se actualiza durante la rueda; un cache corto evita pegarle una vez
// por grupo cuando el envío diario recorre varios.
const CACHE_MS = 10 * 60 * 1000;
let cache = { ts: 0, datos: null };

async function pedir(url, comoJSON) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (MotiBot)",
        Accept: comoJSON ? "application/json" : "text/html",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (comoJSON) return await res.json();
    // La página se sirve en UTF-8, pero el sitio es viejo y alguna sección
    // todavía sale en latin-1. Si la decodificación deja caracteres de reemplazo
    // volvemos a intentar como latin-1: con "Maíz" roto el grano no matchea con
    // ningún código y la pizarra saldría sin maíz.
    const bytes = Buffer.from(await res.arrayBuffer());
    const utf8 = bytes.toString("utf8");
    return utf8.includes("�") ? bytes.toString("latin1") : utf8;
  } finally {
    clearTimeout(t);
  }
}

const pedirJSON = (url) => pedir(url, true);
const pedirHTML = (url) => pedir(url, false);

// Orden de la placa, y emoji por grano. Lo que no esté acá igual se muestra
// (al final): si mañana suman cebada, aparece sola.
const GRANOS = {
  TR: { nombre: "Trigo", emoji: "🌾", orden: 1 },
  SO: { nombre: "Soja", emoji: "🫘", orden: 2 },
  MZ: { nombre: "Maíz", emoji: "🌽", orden: 3 },
  SG: { nombre: "Sorgo", emoji: "🌱", orden: 4 },
  GI: { nombre: "Girasol", emoji: "🌻", orden: 5 },
};

// Los códigos son los mismos que usaba ACAbase: las alertas, el historial y el
// carry ya están guardados con estos, así que el cambio de fuente no los toca.
const CODIGO_POR_NOMBRE = {
  TRIGO: "TR",
  SOJA: "SO",
  MAIZ: "MZ",
  SORGO: "SG",
  GIRASOL: "GI",
  CEBADA: "CB",
};

// Encabezados de columna de la tabla, ya normalizados. La moneda es por plaza:
// Rosario y Córdoba cotizan en pesos, los puertos en dólares.
const PLAZAS = {
  ROS: { nombre: "Rosario", moneda: "ARS", orden: 1 },
  "BS AS": { nombre: "Buenos Aires", moneda: "USD", orden: 2 },
  QQ: { nombre: "Quequén", moneda: "USD", orden: 3 },
  "B B": { nombre: "Bahía Blanca", moneda: "USD", orden: 4 },
  CBA: { nombre: "Córdoba", moneda: "ARS", orden: 5 },
};

// Sin acentos, sin puntos y en mayúsculas: así "B. B." y "Maíz" entran en las
// tablas de arriba aunque la página cambie el formateo.
function normalizar(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function textoDeCelda(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// "343000" / "1.234,50" / "235" → número. La página mezcla formatos según la
// tabla, así que decidimos por los separadores que traiga.
function aNumero(txt) {
  const limpio = String(txt || "").replace(/[^\d.,-]/g, "");
  if (!limpio) return null;
  let n;
  if (limpio.includes(",")) n = Number(limpio.replace(/\./g, "").replace(",", "."));
  else if ((limpio.match(/\./g) || []).length > 1) n = Number(limpio.replace(/\./g, ""));
  else n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// Red de seguridad sobre la moneda declarada: una tonelada en pesos está en
// cientos de miles y en dólares, en cientos. Si el número contradice a la
// columna, le creemos al número antes que al encabezado: publicar "U$S 343.000"
// sería peor que no publicar nada.
function monedaDe(declarada, valor) {
  if (declarada === "ARS" && valor < 10000) return "USD";
  if (declarada === "USD" && valor >= 10000) return "ARS";
  return declarada;
}

function filasDeTabla(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => textoDeCelda(c[1]))
  );
}

// El panel #pizarra, hasta el cierre de su tabla.
function panelPizarra(html) {
  const i = html.search(/id="pizarra"/i);
  if (i === -1) throw new Error("no encontré el panel de la pizarra");
  const fin = html.indexOf("</table>", i);
  return html.slice(i, fin === -1 ? html.length : fin);
}

function parsearPizarra(html) {
  const filas = filasDeTabla(panelPizarra(html));
  if (!filas.length) throw new Error("la pizarra vino vacía");

  let columnas = null;
  let fecha = null;
  let fechaPrecios = null;
  const granos = [];
  // Barrilli carga la tabla a mano y a veces la publica incompleta: la fila del
  // grano está, pero vacía. No es lo mismo que un grano que no cotiza en la
  // pizarra, así que los juntamos aparte para poder avisarlo.
  const faltantes = [];

  for (const celdas of filas) {
    // Pie de la tabla: "Fijación del 17/09/2026 | Precios del 16/09/2026". Va
    // en una sola celda con colspan, así que se reconoce por el texto.
    const pie = celdas.join(" ");
    const fij = pie.match(/Fijaci.n del\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const pre = pie.match(/Precios del\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (fij || pre) {
      if (fij) fecha = fij[1];
      if (pre) fechaPrecios = pre[1];
      continue;
    }

    if (celdas.length < 2) continue;

    // Encabezado: la fila que reconoce al menos una plaza.
    if (!columnas) {
      const posibles = celdas.map((c) => PLAZAS[normalizar(c)] || null);
      if (posibles.some(Boolean)) {
        columnas = posibles;
        continue;
      }
    }

    const codigo = CODIGO_POR_NOMBRE[normalizar(celdas[0])];
    if (!codigo || !columnas) continue;

    const plazas = [];
    for (let i = 1; i < celdas.length && i < columnas.length; i++) {
      const plaza = columnas[i];
      if (!plaza) continue;
      const valor = aNumero(celdas[i]);
      if (!Number.isFinite(valor) || valor <= 0) continue;
      plazas.push({
        plaza: plaza.nombre,
        moneda: monedaDe(plaza.moneda, valor),
        orden: plaza.orden,
        importe: valor,
      });
    }
    const meta = GRANOS[codigo];

    if (!plazas.length) {
      faltantes.push({
        codigo,
        nombre: meta?.nombre || celdas[0],
        emoji: meta?.emoji || "•",
        orden: meta?.orden || 99,
      });
      continue;
    }
    plazas.sort((a, b) => a.orden - b.orden);

    // `importe` es el precio en pesos de Rosario: es el que usan las alertas, el
    // historial y el carry, todos cargados en pesos. Si esa plaza no cotizó, el
    // grano igual se muestra con sus plazas en dólares, pero sin número testigo.
    const rosario = plazas.find((p) => p.plaza === "Rosario" && p.moneda === "ARS");

    granos.push({
      codigo,
      nombre: meta?.nombre || celdas[0],
      emoji: meta?.emoji || "•",
      orden: meta?.orden || 99,
      puerto: rosario ? "Rosario" : plazas[0].plaza,
      importe: rosario ? rosario.importe : null,
      dif: 0, // lo completa difsDesdeHistorial(): la fuente no lo publica
      hora: "",
      fecha: "",
      plazas,
    });
  }

  if (!granos.length) throw new Error("ningún grano con precio válido");
  if (!fecha) throw new Error("la pizarra vino sin fecha de fijación");

  granos.sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));
  faltantes.sort((a, b) => a.orden - b.orden);
  for (const g of granos) g.fecha = fecha;

  return { fecha, fechaPrecios, granos, faltantes };
}

// dd/mm/yyyy → ISO, para comparar la fecha de la pizarra contra hoy. Fin de
// semana y feriados no hay rueda: la página sigue mostrando la última, y sin
// esto mandaríamos el viernes otra vez el domingo.
function fechaPizarraISO(fecha) {
  const m = String(fecha || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// ACAbase traía la variación contra la rueda anterior; Barrilli no la publica.
// Como ya guardamos la pizarra de cada día en market_history, la calculamos
// contra la última que registramos. El primer día después del cambio de fuente
// no hay con qué comparar y sale "sin cambios", que es lo honesto.
function difsDesdeHistorial(granos, fechaISO) {
  if (!fechaISO) return;
  let anterior = null;
  try {
    const db = require("./database");
    anterior = db.getPizarraAnterior(fechaISO);
  } catch (e) {
    console.warn("⚠️ No pude leer la pizarra anterior para la variación:", e.message);
    return;
  }
  if (!anterior?.precios) return;

  for (const g of granos) {
    const previo = anterior.precios[g.codigo];
    if (!Number.isFinite(g.importe) || !Number.isFinite(previo) || previo <= 0) continue;
    g.dif = g.importe - previo;
    g.difFecha = anterior.fecha;
  }
}

async function getPizarra() {
  const pizarra = parsearPizarra(await pedirHTML(PIZARRA_URL));
  difsDesdeHistorial(pizarra.granos, fechaPizarraISO(pizarra.fecha));
  return pizarra;
}

// El dólar es decorativo: si la API falla, la cotización sale igual sin esa línea.
async function getDolar() {
  try {
    const d = await pedirJSON(DOLAR_URL);
    if (!Number.isFinite(Number(d?.compra)) || !Number.isFinite(Number(d?.venta))) return null;
    return { compra: Number(d.compra), venta: Number(d.venta) };
  } catch (e) {
    console.warn("⚠️ No pude leer el dólar BNA:", e.message);
    return null;
  }
}

function pesos(n, decimales = 0) {
  return n.toLocaleString("es-AR", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
}

function precioPlaza(p) {
  return p.moneda === "USD" ? `U$S ${pesos(p.importe)}` : `$ ${pesos(p.importe)}`;
}

// La variación va en PESOS contra la pizarra anterior. Ese número solo (un
// "+7.600" al lado de un "343.000") no se entiende, así que mostramos el
// porcentaje primero — que es lo que se lee de un vistazo — y los pesos entre
// paréntesis.
function variacion(importe, dif) {
  if (!dif) return "➖ sin cambios";

  const flecha = dif > 0 ? "🔼" : "🔻";
  const signo = dif > 0 ? "+" : "-";
  const enPesos = `${signo}$ ${pesos(Math.abs(dif))}`;

  // El porcentaje va sobre el valor ANTERIOR (importe - dif), que es contra lo
  // que se midió el cambio; dividir por el de hoy daría un número distinto.
  const previo = importe - dif;
  if (!previo || previo <= 0) return `${flecha} ${enPesos}`;

  const pct = (dif / previo) * 100;
  return `${flecha} ${signo}${pesos(Math.abs(pct), 2)}%  (${enPesos})`;
}

function bloqueGrano(g) {
  const enPesos = g.plazas.filter((p) => p.moneda !== "USD");
  const enDolares = g.plazas.filter((p) => p.moneda === "USD");

  const lineas = enPesos.map((p) => `    ${precioPlaza(p)} _(${p.plaza})_`);

  // La variación cuelga del precio testigo en pesos: es el único del que
  // tenemos días anteriores guardados.
  if (Number.isFinite(g.importe)) lineas.push(`    ${variacion(g.importe, g.dif)}`);

  if (enDolares.length) {
    lineas.push("    " + enDolares.map((p) => `${precioPlaza(p)} _(${p.plaza})_`).join(" · "));
  }

  return `${g.emoji} *${g.nombre}*\n${lineas.join("\n")}`;
}

// "Soja", "Soja y Girasol", "Soja, Girasol y Maíz".
function enumerar(nombres) {
  if (nombres.length <= 1) return nombres[0] || "";
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}

// La pizarra contra la que se comparó. Suele ser la rueda anterior, pero si el
// bot estuvo caído unos días es una más vieja, y decir "contra la anterior" sin
// aclarar cuál haría pasar por variación del día algo que no lo es.
function notaVariacion(granos) {
  const fechas = [...new Set(granos.map((g) => g.difFecha).filter(Boolean))];
  if (fechas.length !== 1) return "La variación es del precio en pesos contra la pizarra anterior.";
  const [y, m, d] = fechas[0].split("-");
  return `La variación es del precio en pesos contra la pizarra del ${d}/${m}/${y}.`;
}

function formatearMercado({ fecha, granos, faltantes, dolar }) {
  const bloques = granos.map(bloqueGrano);

  let texto =
    `🚜 *MERCADO DE GRANOS* 🌾\n` +
    `📅 Pizarra del ${fecha}\n\n` +
    `${bloques.join("\n\n")}\n`;

  if (dolar) {
    texto +=
      `\n💵 *Dólar Banco Nación*\n` +
      `    Compra $ ${pesos(dolar.compra, 2)}  ·  Venta $ ${pesos(dolar.venta, 2)}\n`;
  }

  if (faltantes?.length) {
    texto +=
      `\n⏳ _Barrilli todavía no cargó ${enumerar(faltantes.map((g) => g.nombre))} en esta pizarra. ` +
      `Si sale más tarde, te lo mando aparte._\n`;
  }

  texto +=
    `\n_Valores por tonelada. Rosario y Córdoba en pesos; las plazas de puerto, en dólares._\n` +
    `_${notaVariacion(granos)}_\n` +
    `_Fuente: pizarra Barrilli._`;
  return texto;
}

// Mensaje corto para un grano que Barrilli cargó después de que ya mandamos la
// placa del día: repetir la pizarra entera por una sola línea nueva sería ruido.
function formatearActualizacion({ fecha, granos }) {
  const uno = granos.length === 1;
  return (
    `🚜 *${uno ? "Se cargó el grano que faltaba" : "Se cargaron los granos que faltaban"}* 🌾\n` +
    `📅 Pizarra del ${fecha}\n\n` +
    `${granos.map(bloqueGrano).join("\n\n")}\n\n` +
    `_Valores por tonelada. ${notaVariacion(granos)}_\n` +
    `_Fuente: pizarra Barrilli._`
  );
}

// Devuelve { fecha, granos, dolar, texto }. Tira si la pizarra no se pudo leer:
// mandar un mercado a medias sería peor que no mandar nada.
async function getMercado({ forzar = false } = {}) {
  if (!forzar && cache.datos && Date.now() - cache.ts < CACHE_MS) return cache.datos;

  const pizarra = await getPizarra();
  const dolar = await getDolar();

  const datos = { ...pizarra, dolar };
  datos.texto = formatearMercado(datos);

  cache = { ts: Date.now(), datos };
  return datos;
}

module.exports = {
  getMercado,
  formatearMercado,
  formatearActualizacion,
  fechaPizarraISO,
  parsearPizarra,
};
