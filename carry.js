// Carry y comparaciones descriptivas. Dos reglas que atraviesan todo el módulo:
//
//   1. MotiBot no dice si conviene vender. Muestra la resta con los supuestos a
//      la vista para que la decisión la tome el productor, que es el único que
//      sabe su costo real.
//   2. Nada de tendencias ni proyecciones. Solo dónde cae el precio de hoy
//      contra su propia historia, y qué diferencia paga hoy el mercado entre el
//      disponible y una posición a término.
const alertas = require("./alertas");

// --- COMPARACIONES DESCRIPTIVAS ---------------------------------------------
// La serie en dólares es la que permite comparar en el tiempo: el precio en
// pesos de hace seis meses arrastra inflación y devaluación, y un "8% arriba
// del promedio" medido en pesos puede ser enteramente eso. Igual mostramos las
// dos, con la de pesos etiquetada como nominal.
function promedio(valores) {
  if (!valores.length) return null;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

// Ventanas en RUEDAS, no en días corridos: la pizarra no existe los fines de
// semana ni los feriados, y decir "30 días" cuando son 30 ruedas (seis semanas
// de calendario) sería impreciso.
function estadisticas(serie, campo) {
  const valores = serie.map((p) => p[campo]).filter((v) => Number.isFinite(v) && v > 0);
  if (!valores.length) return null;

  const hoy = valores.at(-1);
  const ultimas = (n) => valores.slice(-n);

  const anio = ultimas(250); // ~12 meses de ruedas
  const max = Math.max(...anio);
  const min = Math.min(...anio);

  // En qué percentil del último año cae el precio de hoy. Es la forma honesta
  // de decir "está caro" o "está barato" sin decirlo: cuántas de las últimas
  // ruedas estuvieron por debajo.
  const debajo = anio.filter((v) => v < hoy).length;
  const percentil = anio.length > 1 ? Math.round((debajo / (anio.length - 1)) * 100) : null;

  return {
    hoy,
    ruedas: valores.length,
    prom30: valores.length >= 10 ? promedio(ultimas(30)) : null,
    prom90: valores.length >= 30 ? promedio(ultimas(90)) : null,
    max,
    min,
    ruedasAnio: anio.length,
    percentil: anio.length >= 20 ? percentil : null,
  };
}

function variacionPct(valor, base) {
  if (!Number.isFinite(valor) || !Number.isFinite(base) || base === 0) return null;
  return ((valor - base) / base) * 100;
}

function pct(n, decimales = 1) {
  if (n === null) return "—";
  const signo = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${signo}${Math.abs(n).toFixed(decimales).replace(".", ",")}%`;
}

function usd(n, decimales = 1) {
  return Number(n).toLocaleString("es-AR", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

// Cuántas ruedas hacen falta para que un promedio signifique algo. Con cinco
// datos, un "promedio de 30 ruedas" es una etiqueta falsa.
const MINIMO_UTIL = 10;

function bloqueComparacion(titulo, st, formato) {
  if (!st) return null;

  const f = formato;
  const lineas = [`${titulo}: *${f(st.hoy)}*`];

  if (st.prom30) lineas.push(`    ${pct(variacionPct(st.hoy, st.prom30))} vs. promedio 30 ruedas (${f(st.prom30)})`);
  if (st.prom90) lineas.push(`    ${pct(variacionPct(st.hoy, st.prom90))} vs. promedio 90 ruedas (${f(st.prom90)})`);
  if (st.ruedasAnio >= 20) {
    // La ventana son las últimas 250 ruedas (~12 meses), pero si la serie es
    // más corta hay que decir cuántas son: rotular "12 meses" 60 ruedas de
    // historia sería afirmar algo falso sobre el período que se comparó.
    const periodo = st.ruedasAnio >= 240 ? "Últimos 12 meses" : `Últimas ${st.ruedasAnio} ruedas`;
    lineas.push(`    ${periodo}: mín ${f(st.min)} · máx ${f(st.max)}`);
    if (st.percentil !== null) {
      lineas.push(`    Hoy está por encima del ${st.percentil}% de esas ruedas`);
    }
  }

  return lineas.join("\n");
}

// serie: [{ fecha, usd, ars }] ya ordenada y filtrada al período que se quiera.
function mensajeComparacion(codigo, serie) {
  const nombre = alertas.nombreGrano(codigo);
  const emoji = alertas.emojiGrano(codigo);

  const stUsd = estadisticas(serie, "usd");
  const stArs = estadisticas(serie, "ars");
  const mejor = stUsd || stArs;

  if (!mejor || mejor.ruedas < MINIMO_UTIL) {
    return (
      `${emoji} *${nombre}*\n\n` +
      `Todavía no tengo historia suficiente para comparar ` +
      `(${mejor?.ruedas || 0} rueda${mejor?.ruedas === 1 ? "" : "s"}; hacen falta al menos ${MINIMO_UTIL}).`
    );
  }

  const bloques = [
    bloqueComparacion("💵 En dólares por tonelada", stUsd, (v) => `US$ ${usd(v)}`),
    bloqueComparacion("💰 En pesos por tonelada _(nominal)_", stArs, (v) => `$ ${alertas.pesos(v)}`),
  ].filter(Boolean);

  const ultima = serie.at(-1)?.fecha || "";

  return (
    `${emoji} *${nombre} — dónde cae el precio de hoy*\n` +
    `📅 Rueda del ${ultima}\n\n` +
    `${bloques.join("\n\n")}\n\n` +
    `_La comparación en dólares es la que vale para mirar en el tiempo: la de pesos ` +
    `arrastra inflación y devaluación, no solo mercado._\n\n` +
    `_Datos descriptivos sobre ${mejor.ruedas} ruedas (Matba Rofex). No es una proyección ` +
    `ni una recomendación de venta._`
  );
}

// --- CARRY -------------------------------------------------------------------
// Teoría: F = S + financiamiento + almacenaje − convenience yield. La versión
// decisional es la resta: lo que el mercado paga por esperar, menos lo que a vos
// te cuesta esperar.
//
// El convenience yield queda afuera a propósito: para un productor que guarda
// grano propio no es un costo observable, y ponerle un número sería inventar
// precisión que no tenemos.
//
// Todo en DÓLARES. El grano argentino se cotiza en dólares y los futuros de
// MATBA también; meter una tasa en pesos contra un precio en dólares cuenta la
// devaluación dos veces y da un carry sistemáticamente malo.
//
// Interés simple, no compuesto: son horizontes de meses y la diferencia es
// despreciable frente a la incertidumbre del propio costo de almacenaje.
// El almacenaje viene en una de dos unidades, porque los acopios lo cobran
// como PORCENTAJE mensual del valor del grano y no en dólares fijos. Pedirlo
// en dólares por tonelada obligaría al productor a hacer una cuenta con un
// número que no tiene a mano.
function almacenajeMensualUsd({ almacenaje, unidad }, spotUsd) {
  return unidad === "pct" ? spotUsd * (almacenaje / 100) : almacenaje;
}

function calcularCarry({ spotUsd, futuroUsd, meses, almacenajeMes, tasaAnual }) {
  const mercado = futuroUsd - spotUsd;
  const almacenaje = almacenajeMes * meses;
  const financiero = spotUsd * (tasaAnual / 100) * (meses / 12);
  const neto = mercado - almacenaje - financiero;

  return {
    mercado,
    mercadoPct: variacionPct(futuroUsd, spotUsd),
    almacenaje,
    financiero,
    costos: almacenaje + financiero,
    neto,
  };
}

// Punto de equilibrio: cuánto podría costar el almacenaje mensual para que
// guardar quede en cero, dado el resto. Le dice al productor si está lejos o
// cerca, que es más útil que un sí/no.
function almacenajeDeEquilibrio({ spotUsd, futuroUsd, meses, tasaAnual }) {
  if (!meses) return null;
  const financiero = spotUsd * (tasaAnual / 100) * (meses / 12);
  return (futuroUsd - spotUsd - financiero) / meses;
}

// Lo que paga el mercado, mensualizado. Es la vista SIN supuestos: no depende
// de ningún costo, es aritmética sobre dos precios publicados. Y da vuelta la
// pregunta difícil ("¿cuánto te cuesta guardar?") por una fácil ("¿te cuesta
// más o menos que esto por mes?"), que el productor puede contestar incluso a
// ojo, sin buscar la liquidación.
function mensajeCarryMercado(codigo, { spotUsd, spotArs, posiciones, fecha }) {
  const nombre = alertas.nombreGrano(codigo);
  const emoji = alertas.emojiGrano(codigo);

  const bloques = posiciones.map((p) => {
    const bruto = p.precio - spotUsd;
    const porMes = bruto / p.meses;
    const signo = bruto >= 0 ? "+" : "−";

    const lectura = porMes > 0
      ? `→ Te conviene esperar si guardar y financiar te cuesta *menos de US$ ${usd(porMes, 2)}/t por mes*.`
      : `→ Esa posición vale menos que el disponible: esperar no se paga.`;

    const meses = p.meses.toFixed(1).replace(".", ",");

    return [
      `📆 *${p.nombre}* — US$ ${usd(p.precio, 1)}/t  _(${meses} meses)_`,
      `    Paga ${signo}US$ ${usd(Math.abs(bruto))}/t en total = *${signo}US$ ${usd(Math.abs(porMes), 2)}/t por mes*`,
      `    ${lectura}`,
    ].join("\n");
  });

  const enPesos = spotArs ? `  _($ ${alertas.pesos(spotArs)})_` : "";

  return [
    `${emoji} *${nombre} — qué paga el mercado por esperar*`,
    `📅 Rueda del ${fecha}`,
    ``,
    `Disponible Rosario: *US$ ${usd(spotUsd, 1)}/t*${enPesos}`,
    ``,
    bloques.join("\n\n"),
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Esto no supone nada sobre vos: son dos precios publicados y una división.`,
    ``,
    `Si cargás *tus* costos hago la resta completa y te digo cuánto te queda:`,
    `\`/mbot carry costos\`  _(te explico de dónde sacar cada número)_`,
    ``,
    `_Fuente: Matba Rofex. Información de referencia, no es una recomendación de venta._`,
  ].join("\n");
}

function mensajeCarry(codigo, { spotUsd, spotArs, posiciones, almacenajeMes, tasaAnual, fecha, dolar, textoAlmacenaje }) {
  const nombre = alertas.nombreGrano(codigo);
  const emoji = alertas.emojiGrano(codigo);

  const enPesos = (u) => (dolar ? `  _($ ${alertas.pesos(Math.round(u * dolar))})_` : "");

  const bloques = posiciones.map((p) => {
    const c = calcularCarry({ spotUsd, futuroUsd: p.precio, meses: p.meses, almacenajeMes, tasaAnual });
    const equilibrio = almacenajeDeEquilibrio({ spotUsd, futuroUsd: p.precio, meses: p.meses, tasaAnual });

    // La posición puede cotizar por DEBAJO del disponible (backwardation): ahí
    // el mercado no paga por esperar, cobra. El signo tiene que decirlo.
    const pagaMercado = c.mercado >= 0
      ? `+US$ ${usd(c.mercado)}`
      : `−US$ ${usd(Math.abs(c.mercado))}`;

    const veredicto =
      c.neto > 0
        ? `✅ Guardar hasta ${p.nombre} deja *+US$ ${usd(c.neto)}/t*${enPesos(c.neto)}`
        : `➖ Guardar hasta ${p.nombre} deja *−US$ ${usd(Math.abs(c.neto))}/t*${enPesos(Math.abs(c.neto))}`;

    // Por qué no cierra, que no siempre es lo mismo:
    //   · si el mercado paga algo pero no alcanza, la culpa es del costo
    //     financiero (y decirlo ayuda: con otra tasa podría cerrar);
    //   · si la posición cotiza por debajo del disponible no hay nada que
    //     capturar, y culpar al financiamiento sería mentir — pasaba con la
    //     tasa en cero, donde el mensaje acusaba a un costo que era 0.
    let referencia;
    if (equilibrio > 0) {
      referencia = `_Se emparda con un almacenaje de US$ ${usd(equilibrio, 2)}/t/mes._`;
    } else if (c.mercado <= 0) {
      referencia = `_Esa posición cotiza por debajo del disponible: no hay carry que capturar._`;
    } else {
      referencia = `_Ni con el almacenaje gratis cerraría: lo que paga el mercado no cubre el costo financiero._`;
    }

    return (
      `📆 *${p.nombre}* — US$ ${usd(p.precio, 1)}/t  (${pct(c.mercadoPct)}, ${p.meses.toFixed(1).replace(".", ",")} meses)\n` +
      `    El mercado paga  ${pagaMercado}\n` +
      `    Almacenaje       −US$ ${usd(c.almacenaje)}\n` +
      `    Costo financiero −US$ ${usd(c.financiero)}\n` +
      `    ${veredicto}\n` +
      `    ${referencia}`
    );
  });

  return (
    `${emoji} *${nombre} — vender hoy o guardar*\n` +
    `📅 Rueda del ${fecha}\n\n` +
    `Disponible Rosario: *US$ ${usd(spotUsd, 1)}/t*` +
    (spotArs ? `  _($ ${alertas.pesos(spotArs)})_` : "") +
    `\n\n${bloques.join("\n\n")}\n\n` +
    `⚙️ *Tus supuestos:* almacenaje ${textoAlmacenaje || `US$ ${usd(almacenajeMes, 2)}/t/mes`} · costo del dinero ${usd(tasaAnual, 1)}% anual en dólares.\n` +
    `_Cambialos con_ \`/mbot carry costos <almacenaje> <tasa>\`\n\n` +
    `_La cuenta va en dólares porque el grano y los futuros cotizan en dólares; ` +
    `los pesos son conversión al cambio de hoy. No incluye flete, comisiones ni mermas._\n\n` +
    `_Fuente: Matba Rofex. Información de referencia, no es una recomendación de venta._`
  );
}

module.exports = {
  mensajeCarryMercado,
  almacenajeMensualUsd,
  estadisticas,
  mensajeComparacion,
  calcularCarry,
  almacenajeDeEquilibrio,
  mensajeCarry,
  variacionPct,
  MINIMO_UTIL,
};
