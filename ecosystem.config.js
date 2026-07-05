// Configuración de PM2 para MotivacionalBot.
// Arrancar con:  pm2 start ecosystem.config.js
// Recargar:      pm2 reload ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "motibot",
      script: "index.js",
      cwd: __dirname,

      // Heap de Node a 512MB (conserva lo que hacía el deploy con --node-args).
      // OJO: esto es el proceso Node, NO el renderer de Chromium.
      node_args: "--max-old-space-size=512",

      // 🔑 CLAVE ANTI-"MUERE": backoff exponencial entre reinicios.
      // Si la sesión queda inestable y se cae en ráfaga, PM2 NO hot-loopea ni
      // marca el proceso 'errored' (que lo dejaría muerto). Espera 5s, 10s, 20s...
      exp_backoff_restart_delay: 5000,

      autorestart: true,
      // Debe quedarse arriba 60s para contar como "estable"; evita falsos crashes.
      min_uptime: "60s",
      // Con exp_backoff activo, PM2 sigue reintentando con demora creciente
      // en vez de rendirse. Tope alto por las dudas.
      max_restarts: 50,

      // 🛡️ Red de seguridad contra fuga de memoria del renderer Chromium:
      // si el proceso pasa los 600MB, PM2 lo recicla solo.
      max_memory_restart: "600M",

      // Da tiempo a cerrar Puppeteer/Chromium limpio antes del SIGKILL.
      kill_timeout: 8000,

      env: {
        NODE_ENV: "production",
        // Puerto propio para no chocar con otros servicios del server (Amankay=3000).
        // Debe coincidir con el --url del túnel en deploy.yml.
        PORT: 3001,
      },
    },
  ],
};
