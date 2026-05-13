/**
 * Create a user from the command line. Used to bootstrap the first admin.
 *
 *   docker compose exec backend node dist/scripts/createUser.js <username> <password> [role]
 *
 * Role defaults to 'student'. Use 'admin' for the first account.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool, query } from "../db/client";
import { applySchema } from "../db/client";

async function main() {
  const [username, password, role = "student"] = process.argv.slice(2);
  if (!username || !password) {
    console.error("Usage: createUser.js <username> <password> [student|admin]");
    process.exit(1);
  }
  if (role !== "student" && role !== "admin") {
    console.error(`Invalid role '${role}'. Use 'student' or 'admin'.`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await applySchema();

  const hash = await bcrypt.hash(password, 12);
  try {
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)
       ON CONFLICT (username)
         DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, disabled = false`,
      [username, hash, role]
    );
    console.log(`User '${username}' (${role}) ready.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
