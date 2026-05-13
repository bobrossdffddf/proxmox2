const Crypt = require("guacamole-lite/lib/Crypt");
const crypto = require("crypto");

const CIPHER = "AES-256-CBC";
const KEY = crypto.randomBytes(32);
const crypt = new Crypt(CIPHER, KEY);

const payload = { connection: { type: "rdp", settings: { hostname: "127.0.0.1", port: 3389 } } };

try {
  const token = crypt.encrypt(payload);
  console.log("Token:", token);
  const decrypted = crypt.decrypt(token);
  console.log("Decrypted:", decrypted);
} catch (e) {
  console.error("Error:", e);
}
