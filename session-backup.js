// ─── BACKUP / RESTORE DE LA SESIÓN DE WHATSAPP ────────────────────────────────
// whatsapp-web.js (LocalAuth) guarda la sesión dentro del perfil de Chromium
// (session-motibot/). Ese perfil se corrompe o se pierde fácil: Chromium que no
// cerró limpio, un reinicio en mal momento, o el propio logout de la librería.
// Cuando eso pasa, el bot arranca SIN sesión y pide QR de nuevo (login perdido).
//
// Mitigación: cuando la sesión está estable (bot ready), guardamos una copia en
// session-backup/. Si en un arranque el perfil vivo no tiene sesión usable pero
// el backup sí, lo restauramos ANTES de inicializar → evitamos el QR.
const fs = require("fs");
const path = require("path");

const BASE = path.join(__dirname, "bot_session");
const SESSION_DIR = path.join(BASE, "session-motibot");
const BACKUP_DIR = path.join(BASE, "session-backup");

// Locks de singleton de Chromium: si se copian, reintroducen un lock de un
// proceso muerto en el destino. Nunca van al backup ni se restauran.
const LOCKS = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie"]);

// Carpetas de caché: voluminosas y efímeras. No contienen la sesión (auth vive
// en Default/IndexedDB y Local Storage). Las saltamos para un backup liviano.
const CACHE_DIRS = new Set([
  "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache",
  "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "component_crx_cache",
]);

// La sesión real de WhatsApp vive en el IndexedDB del perfil. Si esa carpeta
// existe, consideramos que el perfil tiene una sesión (potencialmente) usable.
function rutaTieneSesion(dir) {
  return fs.existsSync(path.join(dir, "Default", "IndexedDB"));
}

// Copia un perfil de Chromium saltando locks y cachés.
//
// NO usamos fs.cpSync: Chromium compacta el leveldb del IndexedDB EN CALIENTE
// (borra archivos .ldb mientras copiamos), y cpSync aborta TODA la copia ante el
// primer ENOENT. Acá caminamos el árbol a mano y salteamos archivo por archivo:
// si un .ldb desapareció en la carrera, lo ignoramos y seguimos con el resto.
// Los .ldb de leveldb son inmutables (solo se crean/borran), así que perder uno
// recién compactado deja un snapshot consistente igual.
function copiarPerfil(src, dest) {
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return; // la carpeta misma desapareció: la salteamos
    throw e;
  }

  fs.mkdirSync(dest, { recursive: true });

  for (const ent of entries) {
    const base = ent.name;
    if (LOCKS.has(base) || CACHE_DIRS.has(base)) continue;

    const s = path.join(src, base);
    const d = path.join(dest, base);
    try {
      if (ent.isDirectory()) {
        copiarPerfil(s, d);
      } else if (ent.isFile()) {
        fs.copyFileSync(s, d);
      }
      // symlinks u otros tipos raros del perfil: los ignoramos.
    } catch (e) {
      // Archivo que se borró/locked mientras copiábamos → lo salteamos.
      if (e.code === "ENOENT" || e.code === "EBUSY") continue;
      throw e;
    }
  }
}

// Respalda la sesión viva al backup. Swap atómico vía carpeta .tmp: solo pisamos
// el backup bueno cuando la copia nueva terminó completa, así un corte a mitad
// de copia no nos deja un backup corrupto.
function respaldarSesion() {
  try {
    if (!rutaTieneSesion(SESSION_DIR)) return; // nada útil que respaldar
    const tmp = BACKUP_DIR + ".tmp";
    fs.rmSync(tmp, { recursive: true, force: true });
    copiarPerfil(SESSION_DIR, tmp);
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    fs.renameSync(tmp, BACKUP_DIR);
    console.log("💾 Backup de sesión actualizado.");
  } catch (e) {
    console.warn("⚠️ No pude respaldar la sesión:", e.message);
  }
}

// Restaura el backup sobre el perfil vivo SOLO si el vivo no tiene sesión y el
// backup sí. Devuelve true si restauró. Pensado para correr antes de initialize.
function restaurarSesionSiHaceFalta() {
  try {
    if (rutaTieneSesion(SESSION_DIR)) return false; // sesión viva ok, no tocamos
    if (!rutaTieneSesion(BACKUP_DIR)) return false;  // no hay de dónde restaurar
    console.log("♻️ Sesión viva ausente/incompleta. Restaurando desde backup...");
    copiarPerfil(BACKUP_DIR, SESSION_DIR);
    return true;
  } catch (e) {
    console.warn("⚠️ No pude restaurar la sesión desde backup:", e.message);
    return false;
  }
}

// Borra el perfil vivo Y el backup. Se usa cuando la sesión está muerta (logout
// o inestabilidad repetida): restaurarla solo mete al bot en un loop de re-inject.
// Sin sesión, el próximo initialize arranca limpio (UNPAIRED → QR nuevo).
function borrarSesionYBackup() {
  for (const dir of [SESSION_DIR, BACKUP_DIR, BACKUP_DIR + ".tmp"]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`⚠️ No pude borrar ${path.basename(dir)}:`, e.message);
    }
  }
}

module.exports = { respaldarSesion, restaurarSesionSiHaceFalta, borrarSesionYBackup };
