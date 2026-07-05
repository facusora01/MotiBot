// pm2 start ecosystem.config.js / pm2 reload ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "motibot",
      script: "index.js",
      cwd: __dirname,

      node_args: "--max-old-space-size=512", // heap del proceso Node, no del renderer Chromium

      exp_backoff_restart_delay: 5000, // backoff 5s,10s,20s... si cae en ráfaga
      autorestart: true,
      min_uptime: "60s", // umbral para contar el reinicio como "estable"
      max_restarts: 50,

      max_memory_restart: "600M", // fuga de memoria del renderer Chromium

      kill_timeout: 8000, // tiempo para cerrar Puppeteer limpio antes del SIGKILL

      env: {
        NODE_ENV: "production",
        PORT: 3001, // propio, no choca con otros servicios (Amankay=3000); debe matchear deploy.yml
      },
    },
  ],
};
