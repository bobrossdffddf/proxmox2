const crypto = require("crypto");
const Crypt = require("guacamole-lite/lib/Crypt");

const CIPHER = "AES-256-CBC";
const KEY = crypto.randomBytes(32);
const crypt = new Crypt(CIPHER, KEY);

const payload = {"connection":{"type":"rdp","settings":{"hostname":"192.168.68.21","port":3389,"username":"","password":"","ignore-cert":true,"width":1280,"height":800,"dpi":96,"security":"any","enable-wallpaper":false,"enable-theming":false,"enable-font-smoothing":true,"resize-method":"display-update"}}};

const encryptedToken = crypt.encrypt(payload);

const tokenData = JSON.parse(Buffer.from(encryptedToken, 'base64').toString());
const decipher = crypto.createDecipheriv(
    CIPHER,
    KEY,
    Buffer.from(tokenData.iv, 'base64')
);

let decrypted = decipher.update(Buffer.from(tokenData.value, 'base64'), null, 'utf8');
decrypted += decipher.final('utf8');

console.log("Decrypted string:", decrypted);
console.log("Length:", decrypted.length);
try {
    JSON.parse(decrypted);
    console.log("JSON Parse OK");
} catch (e) {
    console.error("Parse Error:", e.message);
}
