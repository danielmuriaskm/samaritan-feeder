import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

const SEARCH_PATH = config.DB_SEARCH_PATH.replace(/[^a-zA-Z0-9_,]/g, ''); // identifier-list only

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Supabase / managed Postgres require TLS. rejectUnauthorized:false accepts the
  // pooler's own CA chain (the connection is still encrypted). Toggle via DATABASE_SSL.
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  // Resolve unqualified relations against the samaritan schema. Set as a startup
  // option (honored by Supavisor) AND re-applied on connect (belt-and-suspenders
  // for poolers that ignore the startup option).
  options: `-c search_path=${SEARCH_PATH}`,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', (client) => {
  client.query(`SET search_path = ${SEARCH_PATH}`).catch((err) => {
    console.error('Failed to set search_path on connect', err instanceof Error ? err.message : err);
  });
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres error', err);
});

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function exec(sql: string, params?: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(sql, params);
  } finally {
    client.release();
  }
}

export async function transact<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
