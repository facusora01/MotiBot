#!/bin/bash
# Wrapper de cloudflared (quick tunnel). cloudflared imprime una URL random
# *.trycloudflare.com en CADA arranque. Este wrapper la captura de su salida y la
# escribe en .tunnel_url, que el bot lee en vivo al armar links (mail /pair,
# /mbot list). Así, aunque el túnel reinicie solo (PM2/crash/reboot), el bot
# siempre usa la URL vigente sin depender del sed del deploy ni reiniciar el bot.
#
# Uso (vía PM2):
#   pm2 start ./tunnel.sh --name cloudflare-tunnel --interpreter bash -- 3001
set -uo pipefail

cd "$(dirname "$0")"
URL_FILE="$(pwd)/.tunnel_url"
PORT="${1:-3001}"

# 2>&1: la URL la imprime cloudflared por stderr. read línea a línea, la echo-eamos
# (para que quede en los logs de PM2) y, si matchea, la persistimos al archivo.
cloudflared tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"
  url="$(echo "$line" | grep -om1 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' || true)"
  if [ -n "${url:-}" ]; then
    echo "$url" > "$URL_FILE"
    echo "📝 TUNNEL_URL actualizado: $url"
  fi
done
