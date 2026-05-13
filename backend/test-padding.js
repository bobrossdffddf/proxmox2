const crypto = require("crypto");

const CIPHER = "AES-256-CBC";
const KEY = crypto.randomBytes(32);
const IV = crypto.randomBytes(16);

const cipher = crypto.createCipheriv(CIPHER, KEY, IV);
let encrypted = cipher.update('{"test":123}', 'utf8', 'binary');
encrypted += cipher.final('binary');

const decipher = crypto.createDecipheriv(CIPHER, KEY, IV);
let decrypted = decipher.update(encrypted, 'binary', 'ascii');
decrypted += decipher.final('ascii');

console.log("Decrypted length:", decrypted.length);
console.log("Original length:", '{"test":123}'.length);
console.log("Decrypted string:", JSON.stringify(decrypted));
