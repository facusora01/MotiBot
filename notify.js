const nodemailer = require("nodemailer");

// Config esperada en .env: SMTP_HOST/PORT/USER/PASS (PASS = app password de
// Gmail, no tu clave normal) y ALERT_TO. Ver env.example.
function getTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  const port = Number(SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // 465 = SSL; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: (SMTP_PASS || "").replace(/\s/g, "") }, // Gmail lo copia con espacios
    // Sin topes, un SMTP que no responde deja el envío colgado para siempre y
    // con él el cierre del proceso, que ahora lo espera.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

// ALERT_TO admite varias casillas separadas por coma, y conviene usarlas: este
// mail es el único aviso de que el bot se cayó, y un solo proveedor que lo
// filtre lo deja sin llegar. Pasó con Hotmail, que descartó en silencio los que
// mandaba Gmail.
function destinatarios() {
  const crudo = process.env.ALERT_TO || process.env.SMTP_USER || "";
  const lista = crudo.split(",").map((x) => x.trim()).filter(Boolean);
  return lista.join(", ");
}

// Traduce los fallos de SMTP a qué hacer. Sin esto el log deja un código de
// Google ("535-5.7.8 BadCredentials") y hay que ir a buscar qué significa —
// justo cuando el bot está caído y el mail era el único aviso.
function explicarFalla(e) {
  const texto = `${e?.code || ""} ${e?.responseCode || ""} ${e?.message || ""}`;
  const usuario = process.env.SMTP_USER || "(sin SMTP_USER)";

  if (/EAUTH|535|BadCredentials|Username and Password not accepted/i.test(texto)) {
    console.error(
      "\n   👉 Google rechazó el usuario o la clave. Casi siempre es una de estas:\n" +
      `      1. SMTP_PASS tiene la clave de la cuenta. Tiene que ser una *app password*\n` +
      "         de 16 letras: https://myaccount.google.com/apppasswords\n" +
      "      2. La cuenta no tiene verificación en 2 pasos activada. Sin eso Google no\n" +
      "         deja crear app passwords.\n" +
      "      3. La app password fue revocada o regenerada: hay que crear una nueva.\n" +
      `      4. SMTP_USER (${usuario}) no es la misma cuenta que generó la app password.\n\n` +
      "   Después de corregir el .env: pm2 restart motibot && node probar-mail.js\n"
    );
    return;
  }

  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET/i.test(texto)) {
    console.error(
      "\n   👉 No se pudo ni conectar al servidor SMTP. Revisá SMTP_HOST y SMTP_PORT\n" +
      "      (465 con SSL, 587 con STARTTLS), y que el server tenga salida a ese puerto.\n"
    );
  }
}

// No tira si falla (solo loguea): un problema de mail no debe tumbar el bot.
async function alertarRevinculacion(pairUrl) {
  const transport = getTransport();
  const to = destinatarios();

  if (!transport || !to) {
    // Decir CUÁL falta: "faltan SMTP_HOST/USER/PASS" obliga a revisarlas todas.
    const faltan = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter((v) => !process.env[v]);
    if (!to) faltan.push("ALERT_TO (o SMTP_USER)");
    console.warn(`⚠️ Alerta NO enviada: falta configurar ${faltan.join(", ")} en el .env.`);
    return false;
  }

  try {
    await transport.sendMail({
      from: `"MotiBot 🤖" <${process.env.SMTP_USER}>`,
      to,
      subject: "🚨 MotiBot perdió la sesión — re-vinculá",
      text:
        `El bot se desvinculó de WhatsApp y está esperando que lo re-vincules.\n\n` +
        `Abrí este link desde el celular y seguí los pasos:\n${pairUrl}\n\n` +
        `Ahí vas a ver un código de 8 dígitos EN VIVO (se renueva solo).\n` +
        `En WhatsApp: Dispositivos vinculados → Vincular con número de teléfono → tipeá el código.\n\n` +
        `No hace falta que toques el servidor.`,
      html:
        `<h2>🚨 MotiBot perdió la sesión</h2>` +
        `<p>El bot se desvinculó de WhatsApp y está esperando re-vinculación.</p>` +
        `<p><a href="${pairUrl}" style="background:#25D366;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Abrir página de vinculación</a></p>` +
        `<p>Ahí vas a ver un <b>código de 8 dígitos en vivo</b> (se renueva solo).</p>` +
        `<p>En WhatsApp: <b>Dispositivos vinculados → Vincular con número de teléfono</b> → tipeá el código.</p>` +
        `<p style="color:#888">No hace falta que toques el servidor.</p>`,
    });
    // Decimos SIEMPRE a quién: "enviada" sin destinatario no distingue entre
    // que llegó y que se fue a una casilla que no mira nadie.
    console.log(`📧 Alerta de re-vinculación enviada a ${to}`);
    return true;
  } catch (e) {
    console.error("❌ No pude enviar el mail de alerta:", e.message);
    explicarFalla(e);
    return false;
  }
}

module.exports = { alertarRevinculacion };
