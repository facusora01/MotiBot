// Los comandos oficiales están en inglés (/mbot market, /admin groups...).
// Por dentro, la lógica sigue usando los nombres históricos en español, que
// además siguen funcionando para quien ya los usaba. Este módulo traduce el
// mensaje apenas llega: lo de inglés pasa a su equivalente interno y todo lo
// demás queda igual (incluido el texto libre de /admin say o /admin rename).

// /mbot <sub>
const MBOT = {
  market: "mercado",
  grains: "granos",
  grain: "granos",
  price: "precio",
  alert: "alerta",
  alerts: "alertas",
  phrases: "frases",
};

// /admin <sub>
const ADMIN = {
  enable: "alta",
  disable: "baja",
  history: "historia",
  market: "mercado",
};

// /admin market <acción>
const ADMIN_MARKET = {
  preview: "ver",
  now: "ya",
  time: "hora",
  load: "cargar",
};

// Traduce la palabra que está en la posición i de las palabras (sin contar
// los espacios, que se conservan tal cual).
function traducir(partes, i, tabla) {
  const k = i * 2;
  if (k >= partes.length) return;
  const nueva = tabla[partes[k].toLowerCase()];
  if (nueva) partes[k] = nueva;
}

function palabra(partes, i) {
  return (partes[i * 2] || "").toLowerCase();
}

function traducirComando(body) {
  const texto = String(body || "");
  const lider = texto.match(/^\s*/)[0];
  // Palabras en las posiciones pares, espacios en las impares.
  const partes = texto.slice(lider.length).split(/(\s+)/);
  const cmd = palabra(partes, 0);

  if (cmd === "/mbot") {
    traducir(partes, 1, MBOT);
    // /mbot carry costs
    if (palabra(partes, 1) === "carry") traducir(partes, 2, { costs: "costos", cost: "costos" });
  } else if (cmd === "/admin") {
    traducir(partes, 1, ADMIN);
    const sub = palabra(partes, 1);
    if (sub === "mercado") traducir(partes, 2, ADMIN_MARKET);
    if (sub === "historia") traducir(partes, 2, { load: "cargar" });
    if (sub === "delete" || sub === "borrar") traducir(partes, 2, { disabled: "bajas" });
    // "confirm" al final de los comandos que piden confirmación.
    if (["delete", "borrar", "leave", "salir"].includes(sub)) {
      for (let i = 2; i <= 3; i++) traducir(partes, i, { confirm: "confirmar" });
    }
  } else {
    return texto;
  }

  return lider + partes.join("");
}

// Palabras de comando en inglés, para que el modo live no las confunda con
// una pregunta ("/mbot market" es un comando, no algo para el LLM).
const PALABRAS_EN = Object.keys(MBOT);

module.exports = { traducirComando, PALABRAS_EN };
