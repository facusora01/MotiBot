// Prueba el mail de alerta sin esperar a que el bot se desconecte.
//
//   node probar-mail.js
//
// Existe porque el aviso de re-vinculación es lo único que avisa que hay que
// tocar el bot, y solo se descubre que está roto el día que hace falta — con el
// bot caído, que es cuando menos se puede diagnosticar. Esto lo verifica en frío.
require("dotenv").config();

const { alertarRevinculacion } = require("./notify");
const { getTunnelUrl } = require("./tunnel-url");

function estado(nombre, valor, obligatoria = true) {
  if (valor) return `  ✅ ${nombre}`;
  return `  ${obligatoria ? "❌" : "⚠️ "} ${nombre} — ${obligatoria ? "FALTA" : "vacía (opcional)"}`;
}

(async () => {
  console.log("🔎 Configuración de mail\n");

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_TO, PAIR_TOKEN } = process.env;

  console.log(estado("SMTP_HOST", SMTP_HOST));
  console.log(estado("SMTP_PORT", SMTP_PORT, false) + (SMTP_PORT ? ` (${SMTP_PORT})` : " → usa 465"));
  console.log(estado("SMTP_USER", SMTP_USER));
  console.log(estado("SMTP_PASS", SMTP_PASS));
  const casillas = (ALERT_TO || SMTP_USER || "").split(",").map((x) => x.trim()).filter(Boolean);
  console.log(estado("ALERT_TO", casillas.length) + (casillas.length ? `: ${casillas.join(", ")}` : ""));
  if (casillas.length === 1) {
    console.log("     💡 Podés poner varias separadas por coma: si un proveedor filtra el aviso,");
    console.log("        te llega igual por la otra. Es el único mail que avisa que el bot se cayó.");
  }
  console.log(estado("PAIR_TOKEN", PAIR_TOKEN, false));

  const tunel = getTunnelUrl();
  console.log(tunel ? `  ✅ URL del túnel: ${tunel}` : "  ⚠️  Sin URL del túnel: el mail sale sin link");

  const faltan = [
    ["SMTP_HOST", SMTP_HOST],
    ["SMTP_USER", SMTP_USER],
    ["SMTP_PASS", SMTP_PASS],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (faltan.length) {
    console.error(`\n❌ No puedo probar nada: falta ${faltan.join(", ")} en el .env.`);
    console.error("   Con Gmail, SMTP_PASS es una 'app password' (16 letras), no la clave de la cuenta:");
    console.error("   https://myaccount.google.com/apppasswords");
    process.exit(1);
  }

  const destino = casillas.join(", ");
  console.log(`\n📧 Mandando el mail de prueba a ${destino}...`);

  const pairUrl = tunel ? `${tunel}/pair?key=${PAIR_TOKEN || ""}` : "(sin URL de túnel disponible)";
  const ok = await alertarRevinculacion(pairUrl);

  if (ok) {
    console.log("\n✅ Salió. Revisá la casilla (y la carpeta de spam la primera vez).");
    console.log("   Es el mismo mail que vas a recibir cuando el bot pierda la sesión.");
  } else {
    console.error("\n❌ No salió. El motivo está en la línea de arriba.");
    process.exit(1);
  }

  process.exit(0);
})();
