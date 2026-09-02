// Cotización de granos. La web de la Cooperativa La Unión de Alfonso no publica
// precios propios en HTML: enlaza la pizarra de ACAbase, que es la referencia
// que usan para armar su placa diaria. Esa pizarra sale de un endpoint JSON
// (el .asp solo la renderiza del lado del cliente), así que consultamos ese.
const PIZARRA_URL =
  "https://s1.dekagb.com/dkmserver.services/html/acabaseservice.aspx?mt=GetPizarras&appname=acabase";

// Dólar Banco Nación (la placa lo muestra al pie, compra/venta).
const DOLAR_URL = "https://dolarapi.com/v1/dolares/oficial";

const TIMEOUT = 12000;

// La pizarra se actualiza durante la rueda; un cache corto evita pegarle una vez
// por grupo cuando el envío diario recorre varios.
const CACHE_MS = 10 * 60 * 1000;
let cache = { ts: 0, datos: null };

async function pedirJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (MotiBot)", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Orden de la placa, y emoji por grano. Lo que no esté acá igual se muestra
// (al final): si mañana suman cebada, aparece sola.
const GRANOS = {
  TR: { nombre: "Trigo", emoji: "🌾", orden: 1 },
  SO: { nombre: "Soja", emoji: "🫘", orden: 2 },
  MZ: { nombre: "Maíz", emoji: "🌽", orden: 3 },
  SG: { nombre: "Sorgo", emoji: "🌱", orden: 4 },
  GI: { nombre: "Girasol", emoji: "🌻", orden: 5 },
};

const PUERTOS = { RS: "Rosario", BB: "Bahía Blanca", QQ: "Quequén", BA: "Buenos Aires" };

async function getPizarra() {
  const json = await pedirJSON(PIZARRA_URL);
  const filas = json?.result?.value;
  if (!Array.isArray(filas) || !filas.length) throw new Error("la pizarra vino vacía");

  const granos = filas
    .map((f) => {
      const cod = String(f.producto || "").trim().toUpperCase();
      const meta = GRANOS[cod];
      return {
        codigo: cod,
        // El nombre del feed viene con padding a ancho fijo ("TRIGO     ").
        nombre: meta?.nombre || String(f.nombre || cod).trim(),
        emoji: meta?.emoji || "•",
        orden: meta?.orden || 99,
        puerto: PUERTOS[String(f.puerto || "").trim().toUpperCase()] || String(f.puerto || "").trim(),
        importe: Number(f.importe),
        dif: Number(f.dif) || 0,
        hora: String(f.hora || "").trim(),
        fecha: String(f.fecha || "").trim(),
      };
    })
    .filter((g) => Number.isFinite(g.importe) && g.importe > 0)
    .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));

  if (!granos.length) throw new Error("ningún grano con precio válido");

  return { fecha: granos[0].fecha, granos };
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

// El feed trae `dif` en PESOS contra la rueda anterior, no en porcentaje. Ese
// número solo (un "-5.714" al lado de un "352.000") no se entiende, así que
// mostramos el porcentaje primero — que es lo que se lee de un vistazo — y los
// pesos entre paréntesis.
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

function formatearMercado({ fecha, granos, dolar }) {
  const lineas = granos.map((g) => {
    const puerto = g.puerto ? ` _(${g.puerto})_` : "";
    return `${g.emoji} *${g.nombre}*${puerto}\n    $ ${pesos(g.importe)}\n    ${variacion(g.importe, g.dif)}`;
  });

  let texto =
    `🚜 *MERCADO DE GRANOS* 🌾\n` +
    `📅 Pizarra del ${fecha}\n\n` +
    `${lineas.join("\n\n")}\n`;

  if (dolar) {
    texto +=
      `\n💵 *Dólar Banco Nación*\n` +
      `    Compra $ ${pesos(dolar.compra, 2)}  ·  Venta $ ${pesos(dolar.venta, 2)}\n`;
  }

  texto +=
    `\n_Valores por tonelada, en pesos. La variación es contra la rueda anterior._\n` +
    `_Fuente: pizarra ACAbase (Rosario)._`;
  return texto;
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

// dd/mm/yyyy → ISO, para comparar la fecha de la pizarra contra hoy. Fin de
// semana y feriados no hay rueda: el feed sigue devolviendo la última, y sin
// esto mandaríamos el viernes otra vez el domingo.
function fechaPizarraISO(fecha) {
  const m = String(fecha || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

module.exports = { getMercado, formatearMercado, fechaPizarraISO };
