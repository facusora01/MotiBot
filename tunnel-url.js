// ─── LECTOR DE LA URL DEL TÚNEL (EN VIVO) ─────────────────────────────────────
// El quick tunnel de Cloudflare genera una URL random *.trycloudflare.com en cada
// arranque. El wrapper tunnel.sh la captura y la escribe en .tunnel_url cada vez
// que cloudflared (re)arranca. Acá la leemos EN EL MOMENTO de armar un link (mail
// de /pair, /mbot list), no al iniciar el proceso: así el bot siempre usa la URL
// vigente aunque el túnel haya reiniciado solo, sin reiniciar el bot ni depender
// del sed del deploy. Fallback a la env var TUNNEL_URL si el archivo no existe.
const fs = require("fs");
const path = require("path");

const TUNNEL_URL_FILE = path.join(__dirname, ".tunnel_url");

function getTunnelUrl() {
  try {
    const fromFile = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  } catch (e) {}
  return (process.env.TUNNEL_URL || "").trim();
}

module.exports = { getTunnelUrl, TUNNEL_URL_FILE };
