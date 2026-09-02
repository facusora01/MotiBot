// Cliente del Centro de Estadísticas de Matba Rofex (CEM). Es la fuente de dos
// cosas que la pizarra de ACAbase no da:
//   · historia diaria (la pizarra solo devuelve el día; acá hay años),
//   · precios de futuros, que es lo que permite calcular el carry.
//
// Endpoint público, sin credenciales. Devuelve el "settlement" (ajuste) de cada
// rueda, que es el precio de cierre oficial del contrato.
const BASE = "https://apicem.matbarofex.com.ar/api/v2/closing-prices";
const TIMEOUT = 20000;
const PAGE_SIZE = 500; // el máximo que acepta el endpoint

// Nombres de producto tal como los publica el CEM.
//   usd  → disponible en dólares por tonelada (la serie "limpia" para comparar
//          en el tiempo: el peso argentino arrastra inflación y devaluación).
//   ars  → disponible en pesos por tonelada.
//   fut  → curva de futuros en dólares. Solo soja, trigo y maíz tienen; sorgo y
//          girasol no cotizan a término, así que ahí no hay carry que calcular.
// Trigo publica dos plazas (Rosario y Buenos Aires) bajo el mismo producto: nos
// quedamos con Rosario, que es la plaza de la pizarra que ya mostramos.
const PRODUCTOS = {
  SO: { usd: "SOJ Disponible", ars: "SOJ Pesos MATba", fut: "SOJ Dolar MATba" },
  TR: { usd: "TRI Disponible", ars: "TRI Pesos MATba", fut: "TRI Dolar MATba" },
  MZ: { usd: "MAI Disponible", ars: "MAI Pesos MATba", fut: "MAI Dolar MATba" },
  SG: { usd: "SOR Disponible", ars: "SORGO ARS", fut: null },
  GI: { usd: null, ars: "GIR ARS", fut: null },
};

const PLAZA_ROSARIO = /\.ROS[./]/;

function tieneFuturos(codigo) {
  return !!PRODUCTOS[codigo]?.fut;
}

async function pedir(params) {
  const url = `${BASE}?${new URLSearchParams({ market: "ROFX", ...params })}`;
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

// Recorre las páginas hasta traer todo el rango. El endpoint tope 500 por
// página y avisa el total, así que no hay que adivinar cuándo parar.
async function pedirTodo(params) {
  const filas = [];
  let page = 1;

  for (;;) {
    const json = await pedir({ ...params, pageSize: PAGE_SIZE, page });
    const datos = json?.data || [];
    filas.push(...datos);

    const total = Number(json?.totalEntries) || filas.length;
    if (filas.length >= total || !datos.length) break;
    page++;
    if (page > 40) break; // 20.000 filas: red de seguridad, no debería llegar
  }

  return filas;
}

function soloRosario(filas) {
  // Los productos con una sola plaza no traen el sufijo: si ninguna fila
  // matchea, devolvemos todo en vez de quedarnos sin datos.
  const ros = filas.filter((f) => PLAZA_ROSARIO.test(f.symbol || ""));
  return ros.length ? ros : filas;
}

function aISO(dateTime) {
  return String(dateTime || "").slice(0, 10);
}

// Serie diaria de un producto: [{ fecha: 'YYYY-MM-DD', valor }]. Ordenada.
async function serie(producto, desde, hasta) {
  if (!producto) return [];
  const filas = soloRosario(await pedirTodo({ product: producto, from: desde, to: hasta }));

  const porFecha = new Map();
  for (const f of filas) {
    const valor = Number(f.settlement);
    if (!Number.isFinite(valor) || valor <= 0) continue;
    porFecha.set(aISO(f.dateTime), valor);
  }

  return [...porFecha.entries()]
    .map(([fecha, valor]) => ({ fecha, valor }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// La historia de un grano no cambia durante el día y son varias páginas de
// red: la cacheamos para que pedir la comparación tres veces seguidas no
// signifique tres barridos de dos años.
const cacheHistoria = new Map(); // clave → { ts, datos }
const CACHE_HISTORIA_MS = 6 * 60 * 60 * 1000;

// Historia del disponible en las dos monedas, unida por fecha. Las series
// pueden no cubrir exactamente las mismas ruedas: cada moneda queda en null
// donde no haya dato, en vez de inventar el hueco.
async function getHistoria(codigo, desde, hasta) {
  const prod = PRODUCTOS[codigo];
  if (!prod) return [];

  const clave = `${codigo}|${desde}|${hasta}`;
  const guardado = cacheHistoria.get(clave);
  if (guardado && Date.now() - guardado.ts < CACHE_HISTORIA_MS) return guardado.datos;

  const [usd, ars] = await Promise.all([serie(prod.usd, desde, hasta), serie(prod.ars, desde, hasta)]);

  const mapa = new Map();
  for (const p of usd) mapa.set(p.fecha, { fecha: p.fecha, usd: p.valor, ars: null });
  for (const p of ars) {
    const fila = mapa.get(p.fecha) || { fecha: p.fecha, usd: null, ars: null };
    fila.ars = p.valor;
    mapa.set(p.fecha, fila);
  }

  const datos = [...mapa.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
  cacheHistoria.set(clave, { ts: Date.now(), datos });
  return datos;
}

const MESES = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DIC: 12 };
const MESES_LARGO = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
                     "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// "SOJ.ROS/ENE27" → { mes: 1, anio: 2027 }. "DIS26" es el disponible, no una
// posición a término: lo descartamos.
function parsearPosicion(symbol) {
  const m = String(symbol || "").match(/\/([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const mes = MESES[m[1]];
  if (!mes) return null;
  return { mes, anio: 2000 + parseInt(m[2], 10) };
}

// Las posiciones de granos vencen a fin del mes de entrega. Tomamos ese día
// como referencia del plazo: es el horizonte máximo que se está comprando.
function vencimiento(pos) {
  return new Date(Date.UTC(pos.anio, pos.mes, 0));
}

function nombrePosicion(pos) {
  return `${MESES_LARGO[pos.mes - 1]} ${pos.anio}`;
}

// Curva de futuros del día, ya ordenada por vencimiento y sin las posiciones
// vencidas. Solo las que tienen interés abierto: una posición sin nadie del
// otro lado tiene precio publicado pero no es un precio al que se pueda operar.
async function getFuturos(codigo, hoyISO) {
  const prod = PRODUCTOS[codigo];
  if (!prod?.fut) return [];

  const filas = soloRosario(await pedirTodo({ product: prod.fut, from: hoyISO, to: hoyISO }));
  const hoy = new Date(`${hoyISO}T00:00:00Z`);

  return filas
    .map((f) => {
      const pos = parsearPosicion(f.symbol);
      if (!pos) return null;
      const precio = Number(f.settlement);
      if (!Number.isFinite(precio) || precio <= 0) return null;

      const vence = vencimiento(pos);
      if (vence <= hoy) return null;

      return {
        symbol: f.symbol,
        nombre: nombrePosicion(pos),
        precio,
        interesAbierto: Number(f.openInterest) || 0,
        volumen: Number(f.volume) || 0,
        vence,
        // Meses hasta el vencimiento, con decimales: el costo financiero y el
        // almacenaje se prorratean por tiempo, redondear a meses enteros
        // distorsionaría el resultado.
        meses: (vence - hoy) / (1000 * 60 * 60 * 24 * 30.4375),
      };
    })
    .filter((p) => p && p.interesAbierto > 0)
    .sort((a, b) => a.vence - b.vence);
}

// Disponible del día en las dos monedas.
async function getDisponible(codigo, hoyISO) {
  const prod = PRODUCTOS[codigo];
  if (!prod) return { usd: null, ars: null };

  const [usd, ars] = await Promise.all([
    serie(prod.usd, hoyISO, hoyISO),
    serie(prod.ars, hoyISO, hoyISO),
  ]);

  return { usd: usd.at(-1)?.valor ?? null, ars: ars.at(-1)?.valor ?? null };
}

module.exports = { getHistoria, getFuturos, getDisponible, tieneFuturos, PRODUCTOS };
