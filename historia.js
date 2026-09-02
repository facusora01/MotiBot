// Persistencia de la serie de precios. Matba Rofex tiene años de historia y es
// la fuente de verdad, pero consultarla en vivo para todo deja al bot sin nada
// el día que esa API cambie o desaparezca — incluso sin lo que ya vimos pasar.
// Así que la guardamos: el backfill se hace una vez y después se agrega una
// fila por rueda.
const db = require("./database");
const matba = require("./matba");

const GRANOS = ["SO", "TR", "MZ", "SG", "GI"];

// Cuánto traer en la carga inicial. Tres años cubren de sobra las ventanas que
// usamos (90 ruedas y 12 meses) y dejan margen para mirar más atrás.
const ANIOS_BACKFILL = 3;

function restarAnios(hastaISO, anios) {
  const d = new Date(`${hastaISO}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - anios);
  return d.toISOString().slice(0, 10);
}

// Trae de MATBA y guarda. Devuelve cuántas ruedas quedaron por grano.
async function backfill(hastaISO, anios = ANIOS_BACKFILL) {
  const desde = restarAnios(hastaISO, anios);
  const resultado = [];

  for (const codigo of GRANOS) {
    try {
      const serie = await matba.getHistoria(codigo, desde, hastaISO);
      if (serie.length) db.guardarMatba(codigo, serie);
      resultado.push({ codigo, ruedas: serie.length });
      console.log(`📚 Historia ${codigo}: ${serie.length} ruedas guardadas (desde ${desde}).`);
    } catch (error) {
      console.error(`❌ No pude traer la historia de ${codigo}:`, error.message);
      resultado.push({ codigo, ruedas: 0, error: error.message });
    }
  }

  return resultado;
}

// Al arranque: si la base está vacía, cargamos. Si ya hay datos no tocamos
// nada — el backfill es caro y la puesta al día diaria alcanza.
async function backfillSiHaceFalta(hastaISO) {
  if (db.contarMatba()) return false;

  console.log("📚 Sin historia de precios guardada: hago la carga inicial desde Matba Rofex.");
  await backfill(hastaISO);
  return true;
}

// Puesta al día diaria: pedimos una ventana corta (no toda la historia) y
// guardamos. La ventana de días cubre fines de semana largos y cualquier día
// en que el bot haya estado caído.
async function actualizar(hastaISO, dias = 10) {
  const d = new Date(`${hastaISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  const desde = d.toISOString().slice(0, 10);

  let guardadas = 0;
  for (const codigo of GRANOS) {
    try {
      const serie = await matba.getHistoria(codigo, desde, hastaISO);
      if (serie.length) {
        db.guardarMatba(codigo, serie);
        guardadas += serie.length;
      }
    } catch (error) {
      console.error(`❌ No pude actualizar la historia de ${codigo}:`, error.message);
    }
  }
  return guardadas;
}

// Lectura para las comparaciones: primero la base, que es instantánea y no
// depende de que MATBA esté en pie. Si está vacía o muy corta (bot nuevo,
// backfill fallado), caemos a la API y de paso guardamos lo que traigamos.
async function serieParaComparar(codigo, hastaISO, minimo = 10) {
  const desde = restarAnios(hastaISO, 2);
  const guardada = db.getMatbaHistoria(codigo, desde);
  if (guardada.length >= minimo) return guardada;

  const serie = await matba.getHistoria(codigo, desde, hastaISO);
  if (serie.length) db.guardarMatba(codigo, serie);
  return serie;
}

module.exports = { backfill, backfillSiHaceFalta, actualizar, serieParaComparar, GRANOS, ANIOS_BACKFILL };
