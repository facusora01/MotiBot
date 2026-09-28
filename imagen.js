// Sanea una imagen que mandó un agente antes de que llegue a WhatsApp.
//
// El trabajo lo hace imagen-sanitizer.js en un proceso aparte, uno por
// imagen: si una imagen armada para atacar lograra algo, sería adentro de un
// proceso encerrado, sin archivos ni programas, que muere a los pocos
// segundos. Este módulo solo lo lanza (un fork de un archivo fijo, con
// argumentos fijos) y le pasa los datos por IPC.
const path = require("path");
const { fork } = require("child_process");

const SANITIZER_PATH = path.join(__dirname, "imagen-sanitizer.js");
const JPEG_DIR = path.dirname(require.resolve("jpeg-js/package.json"));
const TIMEOUT = 20 * 1000;

function flagDePermisos() {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has("--permission")) return "--permission";
  if (flags.has("--experimental-permission")) return "--experimental-permission";
  return null;
}

// Recibe el JPEG en base64 tal como vino del agente. Devuelve
// { data, width, height } con un JPEG nuevo, o tira error.
function sanear(base64) {
  return new Promise((resolve, reject) => {
    const flag = flagDePermisos();
    if (!flag) return reject(new Error("sin sandbox"));

    const hijo = fork(SANITIZER_PATH, [], {
      execArgv: [
        flag,
        `--allow-fs-read=${SANITIZER_PATH}`,
        `--allow-fs-read=${JPEG_DIR}`,
        "--max-old-space-size=96",
      ],
      env: {},
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });

    let terminado = false;
    const terminar = (fn, valor) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      try { hijo.kill(); } catch (e) { /* ya terminó */ }
      fn(valor);
    };
    const timer = setTimeout(() => terminar(reject, new Error("timeout")), TIMEOUT);

    hijo.on("message", (msg) => {
      if (msg && msg.ok === true && typeof msg.data === "string" &&
          Number.isInteger(msg.width) && Number.isInteger(msg.height)) {
        return terminar(resolve, { data: msg.data, width: msg.width, height: msg.height });
      }
      terminar(reject, new Error(`imagen rechazada: ${msg?.error || "respuesta inválida"}`));
    });
    hijo.on("exit", (code) => terminar(reject, new Error(`el saneador terminó (código ${code})`)));
    hijo.on("error", (e) => terminar(reject, e));

    hijo.send({ data: base64 });
  });
}

module.exports = { sanear };
