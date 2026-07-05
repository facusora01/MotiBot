// El perfil Chromium donde whatsapp-web.js guarda la sesión se corrompe fácil
// (cierre sucio, reinicio a destiempo, logout) y el bot terminaría pidiendo QR
// de nuevo. Guardamos una copia cuando está estable y la restauramos antes de
// initialize() si el perfil vivo la perdió.
const fs = require("fs");
const path = require("path");

const BASE = path.join(__dirname, "bot_session");
const SESSION_DIR = path.join(BASE, "session-motibot");
const BACKUP_DIR = path.join(BASE, "session-backup");

// Copiar estos locks reintroduciría el lock de un proceso Chromium ya muerto.
const LOCKS = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie"]);

// Voluminosas y sin sesión (esa vive en Default/IndexedDB y Local Storage).
const CACHE_DIRS = new Set([
  "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache",
  "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "component_crx_cache",
]);

// Existe IndexedDB del perfil ⇒ hay sesión (potencialmente) usable.
function rutaTieneSesion(dir) {
  return fs.existsSync(path.join(dir, "Default", "IndexedDB"));
}

// No usamos fs.cpSync: Chromium compacta el leveldb en caliente (borra .ldb
// mientras copiamos) y cpSync aborta todo ante el primer ENOENT. Copiamos
// archivo por archivo salteando los que desaparecen en la carrera — los .ldb
// son inmutables, así que perder uno recién compactado no corrompe el snapshot.
function copiarPerfil(src, dest) {
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return;
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
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EBUSY") continue;
      throw e;
    }
  }
}

// Swap atómico vía .tmp: un corte a mitad de copia no deja el backup corrupto.
function respaldarSesion() {
  try {
    if (!rutaTieneSesion(SESSION_DIR)) return;
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

// Pensado para correr antes de client.initialize().
function restaurarSesionSiHaceFalta() {
  try {
    if (rutaTieneSesion(SESSION_DIR)) return false;
    if (!rutaTieneSesion(BACKUP_DIR)) return false;
    console.log("♻️ Sesión viva ausente/incompleta. Restaurando desde backup...");
    copiarPerfil(BACKUP_DIR, SESSION_DIR);
    return true;
  } catch (e) {
    console.warn("⚠️ No pude restaurar la sesión desde backup:", e.message);
    return false;
  }
}

// Para sesión muerta (logout/inestabilidad repetida): restaurarla solo mete al
// bot en loop de re-inject. Sin sesión, el próximo initialize arranca limpio.
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
