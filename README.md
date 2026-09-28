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
├── live.js              ← /mbot live y /mbot llm (LLMs de la comunidad)
├── llm.js               ← Lanza el gateway encerrado y le habla por IPC
├── llm-gateway.js       ← Proceso aislado que recibe a los agentes por WebSocket
├── llm-protocol.js      ← Protocolo (texto e imágenes) y limpieza de respuestas
├── imagen.js            ← Lanza el saneador de imágenes, uno por imagen
├── imagen-sanitizer.js  ← Proceso aislado que rehace cada imagen desde los píxeles
├── motibot-agent.js     ← Agente que corre cada usuario al lado de su Ollama
├── instalador/          ← Instalador para Windows (acceso directo "MotiBot LLM")
├── docs/AGENTE.md       ← Qué hace el agente, explicado para quien lo instala
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
- `/birthday @persona dd/mm/yyyy` — carga el cumple de alguien (formato **día/mes/año**,
  con los ceros opcionales: `8/4/2000` y `08/04/2000` son lo mismo). El bot repite
  la fecha en palabras para que se note si se cargó al revés, y volver a cargar a
  la misma persona pisa la fecha anterior.
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

**LLM en vivo:**
- `/mbot llm add` (por privado): registra tu LLM y te da un token para el agente.
  Repetirlo genera un token nuevo y anula el anterior.
- `/mbot llm` / `/mbot llm remove` (por privado): ver el estado o darlo de baja.
- `/mbot live` (admins, en un grupo): prende el modo live con el LLM de quien
  lo pide o, si no tiene, con el de otro miembro del grupo que esté conectado.
  Si no hay ninguno, avisa que no hay LLM disponible.
- `/mbot live off` (admins): lo apaga.

Con el modo prendido, el bot contesta con el LLM cuando lo arroban
(`@MotiBot tu pregunta`), cuando le escriben `/mbot <pregunta>` o cuando le
responden una de sus respuestas. Los comandos (`@MotiBot phrase`,
`/mbot help`...) siguen funcionando igual.

**Memoria:** en cada grupo recuerda las últimas 10 preguntas y respuestas de
la última hora (solo lo que se le preguntó al bot, nunca el resto del chat).
Vive en la memoria del proceso: se borra con `/mbot live off`, con
`/mbot live reset` (admins), al cambiar de LLM o si el bot reinicia. Solo la
reciben los agentes v2 en adelante; los viejos siguen andando sin memoria.

**Imágenes:**
- `/mbot image on|off` (admins): prende o apaga las imágenes en el grupo.
- `/mbot image <descripción>`: cualquiera pide una imagen (una cada 2 minutos
  por persona, 10 por día por persona y 30 por grupo). La dibuja el LLM de
  alguien del grupo que tenga la generación de imágenes prendida (agente v3
  con `--imagenes`): primero traduce el pedido al inglés con su modelo de
  texto y después dibuja en 768×768.
- `/mbot image delete` (admins, respondiendo a la imagen): la borra para todos.

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

### LLMs de la comunidad (Tailscale Funnel)

Cada usuario corre `motibot-agent.js` en su PC, al lado de su Ollama. El
agente abre una conexión saliente y cifrada (`wss://`) al gateway del bot, así
que nadie abre puertos en su casa. El gateway escucha solo en `127.0.0.1` y lo
publica Tailscale Funnel, con URL fija y TLS, sin necesidad de dominio.

Una sola vez, en el servidor:

```bash
tailscale funnel --bg 3002     # la primera vez te da un link para habilitar Funnel
tailscale funnel status        # muestra la URL: https://<maquina>.<tailnet>.ts.net
```

Poné esa URL en `LLM_PUBLIC_URL` del `.env` y reiniciá el bot.

Si los puertos de Funnel (443, 8443, 10000) ya los usan otros servicios,
montalo en una ruta propia sin tocar lo que ya está:

```bash
tailscale funnel --bg --https=443 --set-path=/motibot-llm http://127.0.0.1:3002
# LLM_PUBLIC_URL=https://<maquina>.<tailnet>.ts.net/motibot-llm
```

El gateway acepta la ruta con o sin el prefijo, así que funciona recorte
Funnel la ruta o no.

**Aislamiento: el LLM solo puede chatear.**
- El gateway corre como un proceso aparte con el modelo de permisos de Node
  (`--permission`): no puede lanzar procesos, crear workers, cargar addons ni
  escribir archivos, y no recibe las variables del `.env`. Si arranca sin
  sandbox, se niega a atender. Necesita Node 20 o más nuevo; si el Node no
  tiene permisos, el gateway no se levanta.
- El protocolo acepta exactamente tres mensajes del agente: `auth`, `reply`
  (texto) e `image_part` (pedazos de un JPEG en base64, de hasta 12 KB, solo
  para un pedido de imagen que hizo el bot, en orden). Cualquier otra cosa
  corta la conexión, y ningún mensaje pasa de 16 KB.
- Una imagen nunca se publica tal cual llega: `imagen-sanitizer.js`, en un
  proceso aparte encerrado igual que el gateway, la decodifica con un
  decodificador en JavaScript puro (sin código en C), con tope de resolución
  y memoria, y arma un JPEG nuevo desde los píxeles: sin metadatos ni nada
  pegado al archivo original.
- El pedido de imagen pierde `<` y `>` (en el bot y en el agente, antes y
  después de traducir): así nadie puede esconder parámetros para el
  generador (`<sd_cpp_extra_args>`). Tamaño y pasos los fija el agente.
- La respuesta del LLM solo termina en un reply al grupo, limpia de caracteres
  invisibles, recortada, sin poder empezar con `/` ni `@` y con la firma del
  modelo al final: nunca se lee como comando. Los mensajes propios del bot nunca van al LLM.
- Al LLM solo le llega un prompt fijo, el nombre de quien pregunta, la
  pregunta y, si es un reply, la respuesta anterior. Nada del servidor.
- `npm test` falla si el código del LLM importa `child_process`, `fs`, `vm` y
  similares, o si el gateway se lanza con más permisos.

**Del lado del usuario: su PC tampoco se toca.** Explicado para quien lo
instala en [docs/AGENTE.md](docs/AGENTE.md). `/mbot llm add` manda el link al
agente en GitHub (rama `main`, la que se deploya), con su huella SHA-256 para
verificarlo (el repo sale de `LLM_REPO`, por defecto `facusora01/MotiBot`).
- El agente se corre con `node --permission motibot-agent.js ...` y se niega a
  arrancar sin ese encierro: no puede leer ni escribir archivos, lanzar
  programas, crear workers ni cargar addons. Así, ni un servidor comprometido
  ni un agente adulterado pueden hacer nada en esa PC.
- No le ofrece herramientas (tools) al modelo y no ejecuta nada de lo que
  conteste. Solo habla con `POST /api/chat` de un Ollama en `127.0.0.1`.
- Valida lo que llega del servidor (solo `ready` y `job` con chat) y tiene un
  tope de preguntas por minuto (`--por-minuto`, 10 por defecto).

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
límites de frases, el cálculo de horarios/frecuencia y el aislamiento de los
LLMs (protocolo, respuestas y código prohibido).

---

## Notas

- La sesión de WhatsApp vive en `bot_session/` (no se versiona). Si el bot
  pierde la sesión (logout) y no logra recuperarse tras varios reinicios, se
  auto-limpia y vuelve a pedir QR/pairing — no hace falta borrar nada a mano.
- `motivacional.db` (SQLite) tampoco se versiona; se crea sola al arrancar.
