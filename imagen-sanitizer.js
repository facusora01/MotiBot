// Re-codificador de imágenes: el ÚNICO lugar donde se abre una imagen que
// mandó un agente. Corre como proceso aparte, uno por imagen, lanzado por
// imagen.js con el modelo de permisos de Node (sin procesos, workers, addons
// ni escritura de archivos, sin el .env) y con memoria y tiempo limitados.
//
// Qué hace: decodifica el JPEG con jpeg-js (JavaScript puro: los bugs clásicos
// de imágenes son de memoria en decodificadores escritos en C) y arma un JPEG
// nuevo desde los píxeles. Lo que sale son solo colores: sin metadatos, sin
// datos ocultos y sin nada pegado al final del archivo original.

function tienePermiso(scope) {
  try { return process.permission.has(scope); } catch (e) { return true; }
}
if (!process.permission || ["child", "worker", "fs.write"].some(tienePermiso)) {
  console.error("🛑 [imagen] Arranqué sin el sandbox de permisos. No abro imágenes.");
  process.exit(78);
}
if (typeof process.send !== "function") process.exit(78);

const jpeg = require("jpeg-js");

const LADO_MIN = 64;
const LADO_MAX = 1024;
const CALIDAD = 85;

function responder(msg) {
  try { process.send(msg); } catch (e) { /* el bot se fue */ }
  process.exit(0);
}

process.once("message", (msg) => {
  try {
    if (!msg || typeof msg.data !== "string" || msg.data.length > 820 * 1024) throw new Error("entrada inválida");
    const bytes = Buffer.from(msg.data, "base64");
    // Firma JPEG (FF D8 FF): cualquier otra cosa ni se intenta abrir.
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("no es un JPEG");

    // Los límites de jpeg-js cortan antes de reservar memoria: una imagen
    // que dice medir 50000x50000 no llega a ocupar nada.
    const img = jpeg.decode(bytes, {
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: 1.1,
      maxMemoryUsageInMB: 48,
    });
    const { width, height } = img;
    if (width < LADO_MIN || height < LADO_MIN || width > LADO_MAX || height > LADO_MAX) throw new Error("medidas fuera de rango");

    const nueva = jpeg.encode({ data: img.data, width, height }, CALIDAD);
    responder({ ok: true, data: Buffer.from(nueva.data).toString("base64"), width, height });
  } catch (e) {
    responder({ ok: false, error: String(e.message || e).slice(0, 120) });
  }
});
