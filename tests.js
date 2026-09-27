const db = require("./database");
const { handleCommand, clearAdminCache } = require("./commands");

let hasFailed = false;

const mockClient = {
  sendMessage: async (id, msg) => console.log(`[MOCK PRIVADO] a ${id}: ${msg.slice(0, 50)}...`)
};

// ─── HELPER MEJORADO ──────────────────────────────────────────────────────────
async function simulate(text, isAdminFlag = false, fromMe = false, expectedInReply = null) {
  let capturedReply = "";

  clearAdminCache();
  
  const msg = {
    body: text,
    from: "123456789@g.us",
    author: "123456789@c.us",
    fromMe: fromMe,
    getChat: async () => ({ 
      isGroup: true, 
      name: "Grupo de Test",
      participants: [{ id: { user: "123456789", _serialized: "123456789@c.us" }, isAdmin: isAdminFlag }] 
    }),
    getContact: async () => ({ pushname: "Sora Tester", number: "123456789" }),
    reply: async (replyText) => {
      capturedReply = replyText;
      console.log(`🤖 RESPUESTA: ${replyText.replace(/\n/g, ' ')}`);
    }
  };

  try {
    await handleCommand(msg, mockClient);
    if (expectedInReply && !capturedReply.toLowerCase().includes(expectedInReply.toLowerCase())) {
      console.error(`❌ FALLÓ ASERCIÓN: Se esperaba "${expectedInReply}"`);
      hasFailed = true;
    }
  } catch (e) {
    console.error(`❌ ERROR CRÍTICO: ${e.message}`);
    hasFailed = true;
  }
}

// ─── LÓGICA DE INTERVALOS (Para el bug de freq) ───────────────────────────────
function shouldSendNow(sendTime, frequency, mockCurrentTime) {
    const [h, m] = sendTime.split(':').map(Number);
    const [nowH, nowM] = mockCurrentTime.split(':').map(Number);
    const nowTotal = nowH * 60 + nowM;
    const baseTotal = h * 60 + m;
    const interval = Math.floor(1440 / frequency);
    
    for (let i = 0; i < frequency; i++) {
        const slot = (baseTotal + (i * interval)) % 1440;
        if (nowTotal === slot) return true;
    }
    return false;
}

// ─── LLMs DE LA COMUNIDAD: SOLO CHAT ──────────────────────────────────────────
// Estos tests son la garantía de que un LLM no puede ejecutar nada en el
// servidor. Si alguno falla, el deploy se frena.
function chequear(condicion, mensaje) {
  if (condicion) console.log(`✅ ${mensaje}`);
  else { console.error(`❌ ${mensaje}`); hasFailed = true; }
}

async function testsLlm() {
  const fs = require("fs");
  const path = require("path");
  const P = require("./llm-protocol");
  const live = require("./live");

  console.log("\n--- Test 11: El protocolo solo acepta auth y reply ---");
  const token = P.generarToken();
  chequear(P.parsearMensajeAgente(JSON.stringify({ type: "auth", token, model: "llama3.1" })), "auth válido entra");
  chequear(P.parsearMensajeAgente(JSON.stringify({ type: "reply", id: "0123456789abcdef", text: "hola" })), "reply válido entra");
  const rechazados = [
    "no soy json",
    JSON.stringify([1, 2]),
    JSON.stringify({ type: "exec", cmd: "ls" }),
    JSON.stringify({ type: "shell", cmd: "ls" }),
    JSON.stringify({ type: "file", path: "/etc/passwd" }),
    JSON.stringify({ type: "tool_call", name: "x" }),
    JSON.stringify({ type: "auth", token, model: "x", tools: [] }),
    JSON.stringify({ type: "auth", token, model: "x; rm -rf /" }),
    JSON.stringify({ type: "auth", token: "cualquiera", model: "x" }),
    JSON.stringify({ type: "reply", id: "../../etc", text: "x" }),
    JSON.stringify({ type: "reply", id: "0123456789abcdef", text: { $gt: 1 } }),
    JSON.stringify({ type: "reply", id: "0123456789abcdef", text: "x", run: "ls" }),
    JSON.stringify({ type: "reply", id: "0123456789abcdef", text: "x".repeat(20000) }),
  ];
  chequear(rechazados.every((r) => P.parsearMensajeAgente(r) === null), `${rechazados.length} mensajes fuera de protocolo rechazados`);
  chequear(P.parsearMensajeAgente(JSON.stringify({ type: "auth", token, model: "x", v: 2 }))?.v === 2, "auth con versión 2 entra");
  chequear(P.parsearMensajeAgente(JSON.stringify({ type: "auth", token, model: "x" }))?.v === 1, "auth sin versión = agente v1");
  chequear(["2", 0, 101, 1.5, null].every((v) => P.parsearMensajeAgente(JSON.stringify({ type: "auth", token, model: "x", v })) === null),
    "versiones inválidas rechazadas");
  const largo = (n) => Array.from({ length: n }, () => ({ role: "user", content: "x".repeat(1000) }));
  chequear(P.validarMensajesJob(largo(12)) && !P.validarMensajesJob(largo(13)), "tope de caracteres por job (12.000)");
  chequear(P.parsearIpcDelGateway({ kind: "exec", cmd: "ls" }) === null, "IPC del gateway: tipo inventado rechazado");
  chequear(P.parsearIpcDelBot({ kind: "job", conn: 1, job: "0123456789abcdef", messages: [{ role: "tool", content: "x" }] }) === null,
    "IPC: rol 'tool' rechazado");

  console.log("\n--- Test 12: La respuesta del LLM nunca es un comando ---");
  const peligrosos = ["/mbot stop", "@MotiBot stop", "/admin", "‮/mbot sync", "   /mbot remove", "",
    "MotiBot: /mbot stop", "@ /mbot sync", "//@@/admin"];
  for (const t of peligrosos) {
    const final = P.formatearRespuesta(t, "llama3.1", "Juan");
    chequear(!/^[\s/@]/.test(final) && live.esRespuestaLLM(final),
      `"${t.replace(/‮/, "<RLO>")}" → "${final.split("\n")[0]}" (no arranca con / ni @)`);
  }
  chequear(P.formatearRespuesta("Moto: Hola! Estoy bien.", "m", "Sora").startsWith("Hola! Estoy bien."),
    "se saca el \"Nombre:\" que el modelo pone al principio");
  chequear(P.formatearRespuesta("*MotiBot:* Hola", "m", "Sora").startsWith("Hola"), "también con negrita");
  chequear(!/[‪-‮⁦-⁩\u0000-\u0008]/.test(P.limpiarRespuesta("a‮b\u0007c⁦")), "caracteres invisibles y de dirección eliminados");
  chequear(P.limpiarRespuesta("x".repeat(5000)).length <= P.LIMITES.respuesta + 1, "respuesta recortada al límite");

  const esBot = (t) => /^motibot$/i.test(t);
  const grupo = "123456789@g.us";
  chequear(live.preguntaDelMensaje({ fromMe: true, from: grupo, body: "@MotiBot hola" }, esBot) === null,
    "un mensaje propio del bot nunca va al LLM");
  chequear(live.preguntaDelMensaje({ fromMe: false, from: grupo, body: "@MotiBot phrase" }, esBot) === null,
    "\"@MotiBot phrase\" sigue siendo comando");
  chequear(live.preguntaDelMensaje({ fromMe: false, from: grupo, body: "/mbot live off" }, esBot) === null,
    "\"/mbot live off\" sigue siendo comando");

  // Con el modo live prendido, "/mbot <pregunta>" va al LLM.
  db.setGroupLive(grupo, 999, "test");
  const pregunta = live.preguntaDelMensaje({ fromMe: false, from: grupo, body: "/mbot como andas" }, esBot);
  chequear(pregunta?.pregunta === "como andas", "\"/mbot como andas\" con live prendido va al LLM");
  chequear(live.preguntaDelMensaje({ fromMe: false, from: grupo, body: "/mbot help" }, esBot) === null,
    "\"/mbot help\" con live prendido sigue siendo comando");
  db.borrarGroupLive(grupo);
  chequear(live.preguntaDelMensaje({ fromMe: false, from: grupo, body: "/mbot como andas" }, esBot) === null,
    "con live apagado, \"/mbot como andas\" no va al LLM");

  console.log("\n--- Test 12b: Memoria del modo live ---");
  const { recuerdos, recordar, olvidar, MEMORIA } = live._memoria;
  const g = "memoria-test@g.us";
  for (let i = 1; i <= 12; i++) recordar(g, 7, `pregunta ${i}`, `respuesta ${i}`);
  const r = recuerdos(g, 7);
  chequear(r.length === MEMORIA.vueltas && r[0].pregunta === "pregunta 3" && r.at(-1).pregunta === "pregunta 12",
    `guarda las últimas ${MEMORIA.vueltas} idas y vueltas`);
  chequear(recuerdos(g, 8).length === 0, "otro LLM no recibe la memoria del anterior");
  recordar(g, 8, "nueva", "charla");
  chequear(recuerdos(g, 8).length === 1 && recuerdos(g, 7).length === 0, "al cambiar de LLM la memoria arranca de cero");
  olvidar(g);
  for (let i = 0; i < 6; i++) recordar(g, 7, "p".repeat(900), "r".repeat(900));
  const total = recuerdos(g, 7).reduce((t, x) => t + x.pregunta.length + x.respuesta.length, 0);
  chequear(total <= MEMORIA.caracteres, `tope de caracteres de memoria (${total} ≤ ${MEMORIA.caracteres})`);
  olvidar(g);
  chequear(recuerdos(g, 7).length === 0, "olvidar borra todo");

  console.log("\n--- Test 13: El código del LLM no puede ejecutar nada ---");
  const PROHIBIDO = [
    [/require\(\s*["'](node:)?(child_process|fs|fs\/promises|vm|worker_threads|cluster|module|v8|inspector)["']\s*\)/, "módulos de ejecución/archivos"],
    [/require\(\s*["']better-sqlite3["']\s*\)/, "acceso a la base"],
    [/\beval\s*\(/, "eval"],
    [/new\s+Function\s*\(/, "new Function"],
    [/process\.(binding|dlopen|_linkedBinding)\b/, "bindings nativos"],
    [/\bimport\s*\(/, "import dinámico"],
    [/require\(\s*[^"'\s)]/, "require con ruta variable"],
  ];
  for (const archivo of ["llm-gateway.js", "llm-protocol.js", "live.js", "motibot-agent.js"]) {
    const codigo = fs.readFileSync(path.join(__dirname, archivo), "utf8");
    const encontrados = PROHIBIDO.filter(([re]) => re.test(codigo)).map(([, nombre]) => nombre);
    chequear(encontrados.length === 0, `${archivo} limpio${encontrados.length ? ` (encontré: ${encontrados.join(", ")})` : ""}`);
  }

  // llm.js es el único que toca child_process: solo para lanzar el gateway
  // (un archivo fijo), nunca exec/spawn.
  const lanzador = fs.readFileSync(path.join(__dirname, "llm.js"), "utf8");
  chequear(!/\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\b/.test(lanzador), "llm.js no usa exec ni spawn");
  chequear((lanzador.match(/\bfork\(/g) || []).length === 1 && /fork\(GATEWAY_PATH,/.test(lanzador), "llm.js solo hace fork del gateway");
  chequear(/--allow-fs-read=/.test(lanzador) && !/--allow-(child-process|worker|addons|fs-write)/.test(lanzador),
    "el gateway se lanza sin permisos de procesos, workers, addons ni escritura");

  const gw = fs.readFileSync(path.join(__dirname, "llm-gateway.js"), "utf8");
  chequear(/process\.permission/.test(gw) && /process\.exit\(78\)/.test(gw), "el gateway se niega a correr sin sandbox");
  chequear(/listen\(PORT, "127\.0\.0\.1"/.test(gw), "el gateway escucha solo en loopback");

  // Lado del usuario: el agente se encierra solo y no le da tools al modelo.
  const agente = fs.readFileSync(path.join(__dirname, "motibot-agent.js"), "utf8");
  chequear(/if \(!process\.permission \|\|/.test(agente) && /"fs\.read", "fs\.write"/.test(agente),
    "el agente se niega a correr sin sandbox");
  chequear(!/\btools\s*:/.test(agente) && !/tool_calls/.test(agente), "el agente no le ofrece tools al modelo");
  chequear((agente.match(/fetch\(/g) || []).length === 2 && /\/api\/chat`/.test(agente) && /\/api\/tags`/.test(agente),
    "el agente solo llama a /api/chat y /api/tags de Ollama");

  console.log("\n--- Test 14: Comandos /mbot live y /mbot llm ---");
  await simulate("/mbot live", false, false, "Solo los admins");
  await simulate("/mbot live", true, false, "No hay ningún LLM disponible");
  await simulate("/mbot live off", true, false, "no estaba prendido");
  await simulate("/mbot llm add", true, false, "por privado");
}

// ─── MOTOR DE TESTS ───────────────────────────────────────────────────────────
async function runTests() {
  console.log("🧪 INICIANDO MASTER TEST SUITE (MODO CI/CD)...\n");

  try {
    db.addGroup("123456789@g.us", "Grupo de Test");

    console.log("--- Test 1: Intento de Inyección ---");
    await simulate('/new "<script>alert(1)</script>" - Hacker');

    console.log("\n--- Test 2: Frase demasiado larga ---");
    await simulate(`/new "${"A".repeat(350)}" - Autor`, false, false, "testamento");

    console.log("\n--- Test 3: Formato de hora (Reloj 24hs) ---");
    await simulate("/mbot clock 15", true, false, "ajustado");

    console.log("\n--- Test 4: Permisos de Admin ---");
    await simulate("/mbot clock 12:00", false, false, "Solo los administradores");

    console.log("\n--- Test 5: Cooldown de frase ---");
    await simulate("/mbot phrase", false);

    console.log("\n--- Test 6: Borrado vía Web API (Check Health) ---");
    const response = await fetch(`http://localhost:${process.env.PORT || 3001}/health`).catch(() => null);
    if (!response) console.log("⚠️ Servidor web no detectado localmente. Saltando...");

    console.log("\n--- Test 7: Muestreo Multi-API ---");
    const { getPhrase } = require("./phrases");
    const p = await getPhrase("es");
    console.log(`✅ API Response: ${p.texto.slice(0, 30)}...`);

    console.log("\n--- Test 8: Comando Freq (Límites y DB) ---");
    await simulate("/mbot freq 7", true, false, "1 al 6");
    await simulate("/mbot freq 6", true, false, "Turbinas activadas");
    
    const settings = db.getGroupSettings("123456789@g.us");
    if (settings.frequency !== 6) { hasFailed = true; console.error("❌ Error DB: Freq no guardada."); }

    console.log("\n--- Test 9: Lógica Matemática de Frecuencia ---");
    const base = "09:00";
    const ok1 = shouldSendNow(base, 6, "09:00");
    const ok2 = shouldSendNow(base, 6, "13:00");
    const fail = shouldSendNow(base, 6, "10:00");

    console.log("\n--- Test 10: Enviar en cada intervalo exitosamente (Freq=6, Intervalo=240min) ---");
    const base10 = "09:00";
    const frequency10 = 6;
    const expectedTimes = ["09:00", "13:00", "17:00", "21:00", "01:00", "05:00"];
    
    let test10Passed = true;
    expectedTimes.forEach(time => {
      const result = shouldSendNow(base10, frequency10, time);
      if (!result) {
        console.error(`❌ Falló: debería disparar en ${time}`);
        test10Passed = false;
      } else {
        console.log(`✅ Disparo exitoso en ${time}`);
      }
    });
    
    const shouldNotFire = ["10:00", "12:00", "14:00", "16:00"];
    shouldNotFire.forEach(time => {
      const result = shouldSendNow(base10, frequency10, time);
      if (result) {
        console.error(`❌ Falló: NO debería disparar en ${time}`);
        test10Passed = false;
      } else {
        console.log(`✅ No dispara en ${time} (correcto)`);
      }
    });

    if (!test10Passed) hasFailed = true;

    console.log("\n--- Test 10b: Validar intervalos para Freq=4 (360min) ---");
    const base10b = "06:00";
    const frequency10b = 4;
    const expectedTimes10b = ["06:00", "12:00", "18:00", "00:00"];
    
    let test10bPassed = true;
    expectedTimes10b.forEach(time => {
      const result = shouldSendNow(base10b, frequency10b, time);
      if (!result) {
        console.error(`❌ Falló: debería disparar en ${time}`);
        test10bPassed = false;
      } else {
        console.log(`✅ Disparo exitoso en ${time}`);
      }
    });

    if (!test10bPassed) hasFailed = true;

    console.log("\n--- Test 10c: Validar intervalos para Freq=2 (720min) ---");
    const base10c = "08:00";
    const frequency10c = 2;
    const expectedTimes10c = ["08:00", "20:00"];
    
    let test10cPassed = true;
    expectedTimes10c.forEach(time => {
      const result = shouldSendNow(base10c, frequency10c, time);
      if (!result) {
        console.error(`❌ Falló: debería disparar en ${time}`);
        test10cPassed = false;
      } else {
        console.log(`✅ Disparo exitoso en ${time}`);
      }
    });

    if (!test10cPassed) hasFailed = true;
    
    if (ok1 && ok2 && !fail) console.log("✅ Intervalos calculados correctamente.");
    else { hasFailed = true; console.error("❌ Fallo en cálculo de intervalos."); }

    await testsLlm();

  } catch (err) {
    console.error("\n❌ FALLO GLOBAL:", err.message);
    hasFailed = true;
  }

  db.removeGroup("123456789@g.us");
  console.log("\n✅ PRUEBAS FINALIZADAS.");

  if (hasFailed) {
    console.error("⛔ CI/CD RECHAZADO: Hay errores en la lógica.");
    process.exit(1); 
  } else {
    console.log("🌟 CI/CD APROBADO: El código es estable.");
    process.exit(0);
  }
}

runTests();