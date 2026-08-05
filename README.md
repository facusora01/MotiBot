# 🤖 MotiBot

Bot de WhatsApp que manda frases motivacionales a tus grupos. Cada grupo elige
idioma, hora y frecuencia de envío, y puede armar su propia colección de
frases (`/new`, `/add`) en vez de usar la librería por defecto.

---

## Estructura

```
MotivationBot/
├── index.js            ← Bot principal: cliente WhatsApp, cron, servidor web, watchdog
├── commands.js         ← Lógica de los comandos y de la votación de ideas
├── database.js         ← SQLite (grupos, settings, frases custom, cumpleaños, ideas)
├── phrases.js          ← Frases locales + pool de frases remotas (APIs externas)
├── notify.js           ← Alerta por mail cuando el bot pierde la sesión
├── session-backup.js   ← Backup/restore de la sesión de WhatsApp
├── tunnel-url.js        ← Lee la URL vigente del túnel de Cloudflare
├── tunnel.sh            ← Wrapper de cloudflared (persiste la URL en .tunnel_url)
├── encontrar-grupo.js  ← Script opcional para listar IDs de grupo (no hace
│                          falta para el uso normal: el bot se suma a un grupo
│                          con /mbot add, sin necesidad del ID a mano)
├── ecosystem.config.js ← Config de PM2 (producción)
├── start.ps1            ← Levanta el bot en Docker para pruebas locales
├── docker-compose.yml   ← Definición del contenedor de pruebas
├── Dockerfile           ← Imagen de pruebas (misma base que el server real)
└── env.example         ← Plantilla de configuración
```

---

## Setup

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar el `.env`
```bash
cp env.example .env
```
Completá al menos `HORA_ENVIO` y `CHROMIUM_PATH`. El resto (`BOT_PHONE`,
`PAIR_TOKEN`, `SMTP_*`, `SUPER_ADMINS`, `MYMEMORY_EMAIL`) es opcional — habilita
la re-vinculación automática por mail, los comandos de super admin y el
traductor. Ver los comentarios en `env.example` para el detalle de cada uno.

### 3. Vincular WhatsApp
```bash
node index.js
```
Al arrancar sin sesión, el bot muestra un QR en la consola: escaneálo desde
WhatsApp (Dispositivos vinculados → Vincular un dispositivo).

Si no tenés cámara a mano (por ejemplo, corriendo en un servidor remoto), una
vez vinculado una primera vez podés re-vincular por código en vez de QR: abrí
`/pair?key=<PAIR_TOKEN>` en el navegador (necesita `TUNNEL_URL` o
`.tunnel_url` accesible) y tipeá el código de 8 dígitos en WhatsApp.

Una vez conectado, el bot queda escuchando comandos y el scheduler corre solo.

---

## Comandos de WhatsApp

**Configuración (solo admins del grupo):**
- `/mbot add` — suma el bot al grupo
- `/mbot remove` — lo saca del grupo
- `/mbot lang es|en` — idioma de las frases
- `/mbot clock HH:MM` — hora de envío diario
- `/mbot freq <1-6>` — cuántas veces por día
- `/mbot use custom|default` — cambiar entre librería del equipo y la clásica

**Frases:**
- `/new "Frase" - Autor` — sumar una frase a la colección del grupo
- `/add` (en reply a un mensaje) — guardar ese mensaje como frase
- `/mbot phrase` — pedir una frase ya mismo
- `/mbot list` — link al panel web para gestionar la colección

**Cumpleaños:**
- `/birthday @persona mm/dd/yyyy` — carga el cumple de alguien (formato **mes/día/año**;
  el bot repite la fecha en palabras para que se note si se cargó al revés).
  Volver a cargar a la misma persona pisa la fecha anterior.
- `/birthday list` — todos los cumples del grupo

El saludo sale solo, en el horario base del grupo, con la edad cumplida y una
frase de regalo (del equipo si el modo custom está activo).

**Ideas:**
- `/idea <recomendación>` — propuesta de mejora, máx. 200 caracteres, 3 por
  persona por día
- `/ideas` — listado votable: cada idea lleva un emoji numerado y se vota
  reaccionando a ese mensaje (una reacción por persona; cambiarla cambia el voto)
- `/ideas list` — igual que `/mbot list` pero para las ideas: link al panel web
  y llave al privado del admin

Al panel de ideas también se llega desde el botón *💡 Ideas* del listado de
frases; la llave es la misma para los dos.

**Info:**
- `/mbot status`, `/mbot time`, `/mbot help`

---

## Probar en local con Docker (antes de deployar)

`start.ps1` levanta el bot dockerizado para probar cambios sin tocar el
servidor de producción:

```powershell
./start.ps1
```

Hace todo el setup: crea el `.env` desde `env.example` si no existe, buildea
la imagen (`Dockerfile`, Debian + Chromium, igual que el server real) y
levanta el contenedor con `docker-compose.yml`. La sesión de WhatsApp queda
en `bot_session/` en el host, así sobrevive a reinicios del contenedor. Al
final sigue los logs en vivo — ahí aparece el QR o el código de pairing para
vincular. Health check en `http://localhost:3001/health` y re-vinculación en
`http://localhost:3001/pair?key=TU_PAIR_TOKEN`.

Para parar: `docker compose down`.

---

## Correrlo con PM2 (producción)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # para que arranque solo tras un reboot
```

```bash
pm2 logs motibot
pm2 restart motibot
pm2 stop motibot
```

`ecosystem.config.js` ya trae backoff exponencial entre reinicios y un tope de
memoria (600MB) para reciclar el proceso si Chromium pierde memoria.

### Túnel público (opcional, para `/pair` y `/mbot list`)

Si corrés el bot en un servidor sin dominio propio, `tunnel.sh` levanta un
quick tunnel de Cloudflare y mantiene `.tunnel_url` actualizado aunque el
túnel reinicie solo:

```bash
pm2 start ./tunnel.sh --name cloudflare-tunnel --interpreter bash -- 3001
```

### Deploy automático

`.github/workflows/deploy.yml` hace push→SSH→`git reset --hard`→reinstala→
reinicia PM2 (bot + túnel) en cada push a `main`. Requiere los secrets
`SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` y `TAILSCALE_AUTHKEY` configurados
en el repo.

---

## Tests

```bash
npm test
```

Corre `tests.js`: simula comandos contra un grupo mock y valida permisos,
límites de frases y el cálculo de horarios/frecuencia.

---

## Notas

- La sesión de WhatsApp vive en `bot_session/` (no se versiona). Si el bot
  pierde la sesión (logout) y no logra recuperarse tras varios reinicios, se
  auto-limpia y vuelve a pedir QR/pairing — no hace falta borrar nada a mano.
- `motivacional.db` (SQLite) tampoco se versiona; se crea sola al arrancar.
