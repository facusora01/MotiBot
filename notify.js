// ─── ALERTAS POR EMAIL ────────────────────────────────────────────────────────
// Manda un mail cuando el bot pierde la sesión y necesita re-vincularse.
// El mail es solo el AVISO + link; el código de vinculación se genera en vivo
// en /pair (porque expira en ~3min y un código mandado de madrugada llega vencido).
const nodemailer = require("nodemailer");

// Config por .env. Ejemplo para Gmail:
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465
//   SMTP_USER=tucuenta@gmail.com
//   SMTP_PASS=<app password de 16 letras>   (NO tu clave normal)
//   ALERT_TO=tucuenta@gmail.com
function getTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  const port = Number(SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // 465 = SSL; 587 = STARTTLS
    // Gmail muestra el app password con espacios ("xxxx xxxx xxxx xxxx");
    // los sacamos para que funcione tal cual lo copiás.
    auth: { user: SMTP_USER, pass: (SMTP_PASS || "").replace(/\s/g, "") },
  });
}

/**
 * Envía la alerta de re-vinculación. No tira si falla (solo loguea): nunca debe
 * tumbar el bot por un problema de mail.
 * @param {string} pairUrl - Link a la página /pair con el código en vivo.
 */
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
