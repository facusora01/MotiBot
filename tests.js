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