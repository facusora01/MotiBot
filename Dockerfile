# MotiBot — imagen de pruebas (pre-producción).
# Debian bookworm trae chromium en /usr/bin/chromium, igual que el server.
FROM node:20-bookworm-slim

# Chromium + libs que Puppeteer/whatsapp-web.js necesitan para renderizar, y el
# toolchain (python3/make/g++) por si better-sqlite3 (módulo nativo) tiene que
# compilarse al no haber binario prebuilt para esta plataforma.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Mismo path de Chromium que el deploy real → index.js lo lee de CHROMIUM_PATH.
ENV CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Capa de deps cacheable: solo se reinstala si cambia package*.json.
COPY package*.json ./
RUN npm ci --omit=dev

# Resto del código (node_modules y bot_session quedan excluidos por .dockerignore).
COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
