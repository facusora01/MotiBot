# 🤖 MotivacionalBot

Bot de WhatsApp que envía una frase motivacional aleatoria a un grupo, una vez por día.

---

## Estructura

```
motivacional-bot/
├── index.js            ← Bot principal
├── encontrar-grupo.js  ← Script para obtener el ID de tu grupo
├── .env                ← Tu configuración (crearlo desde .env.example)
└── .env.example        ← Plantilla de configuración
```

---

## Setup paso a paso

### 1. Instalá las dependencias (ya lo hiciste)
```bash
npm init -y
npm install whatsapp-web.js qrcode-terminal node-cron
```

### 2. Instalá dotenv para leer el .env
```bash
npm install dotenv
```
Y agregá esta línea al **principio** de `index.js` y `encontrar-grupo.js`:
```js
require("dotenv").config();
```

### 3. Creá tu archivo de configuración
```bash
cp .env.example .env
```

### 4. Encontrá el ID de tu grupo
```bash
node encontrar-grupo.js
```
Escaneá el QR con WhatsApp → el script imprime todos tus grupos con sus IDs.
Copiá el ID que corresponda (tiene el formato `120363XXXX@g.us`) y pegalo en `.env`.

### 5. Configurá la hora de envío
En el `.env`, cambiá `HORA_ENVIO` a la hora que querés (formato 24hs, horario Argentina):
```
HORA_ENVIO=08:00
```

### 6. Correlo
```bash
node index.js
```
Escaneá el QR → el bot queda corriendo y enviará la frase todos los días a la hora configurada.

---

## Mantenerlo corriendo en la laptop (con PM2)

Para que el bot sobreviva cierres de terminal y se reinicie solo:

```bash
# Instalá PM2 globalmente
npm install -g pm2

# Iniciá el bot con PM2
pm2 start index.js --name motivacional-bot

# Que arranque solo cuando prenda la laptop
pm2 startup
pm2 save
```

Comandos útiles de PM2:
```bash
pm2 status              # Ver si está corriendo
pm2 logs motivacional-bot  # Ver los logs en tiempo real
pm2 restart motivacional-bot
pm2 stop motivacional-bot
```

---

## Probar sin esperar al cron

En `index.js`, dentro del evento `ready`, descomentá el bloque de "TEST INMEDIATO":
```js
setTimeout(async () => {
  const frase = getFraseAleatoria();
  const mensaje = formatearMensaje(frase);
  await client.sendMessage(GRUPO_ID, mensaje);
  console.log("📤 Mensaje de prueba enviado!");
}, 5000);
```

---

## Agregar más frases

En `index.js`, el array `frases` tiene el formato:
```js
{ texto: "Tu frase acá", autor: "El autor" }
```
Agregás las que quieras al array y listo.
