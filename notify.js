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
  });
}

// No tira si falla (solo loguea): un problema de mail no debe tumbar el bot.
async function alertarRevinculacion(pairUrl) {
  const transport = getTransport();
  const to = process.env.ALERT_TO || process.env.SMTP_USER;

  if (!transport || !to) {
    console.warn("⚠️ Alerta NO enviada: faltan SMTP_HOST/USER/PASS o ALERT_TO en el .env.");
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
    console.log(`📧 Alerta de re-vinculación enviada a ${to}`);
    return true;
  } catch (e) {
    console.error("❌ No pude enviar el mail de alerta:", e.message);
    return false;
  }
}

module.exports = { alertarRevinculacion };
