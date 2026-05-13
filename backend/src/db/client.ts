/**
 * PostgreSQL pool + helpers. Auto-applies schema.sql on first connect.
 */
import fs from "fs";
import path from "path";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { env } from "../config";
import { logger } from "../services/logger";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected postgres pool error");
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params);
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const r = await query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const r = await query<T>(sql, params);
  return r.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply schema.sql. Idempotent (uses CREATE TABLE IF NOT EXISTS).
 * Called once at backend startup.
 */
export async function applySchema(): Promise<void> {
  // schema.sql sits next to this file at runtime (dist/db/schema.sql) and
  // at dev time (src/db/schema.sql). __dirname adapts to whichever.
  const schemaPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
  logger.info("Database schema applied");
}
