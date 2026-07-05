// Ejecutá este script UNA SOLA VEZ para ver los IDs de tus grupos.
// Luego copiá el que querés en el .env como GRUPO_ID.

require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "motibot" }),
  puppeteer: {
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("\n📱 Escaneá este QR con tu WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("✅ Conectado! Buscando grupo...\n");

  try {
    await new Promise(resolve => setTimeout(resolve, 5000));

    const chats = await client.getChats();
    const grupo = chats.find(chat => chat.isGroup && chat.name === "TestMotivationalBot");

    if (!grupo) {
      console.log("❌ No se encontró el grupo 'TestMotivationalBot'.");
      console.log("   Verificá que el nombre esté escrito exactamente igual.");
    } else {
      console.log("✅ Grupo encontrado!\n");
      console.log(`   Nombre : ${grupo.name}`);
      console.log(`   ID     : ${grupo.id._serialized}`);
      console.log("\n👆 Copiá ese ID y pegalo en tu .env como GRUPO_ID");
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  }

  await client.destroy();
  process.exit(0);
});

client.on("auth_failure", () => {
  console.error("❌ Error de autenticación.");
  process.exit(1);
});

console.log("🔍 Iniciando búsqueda de grupos...");
client.initialize();
