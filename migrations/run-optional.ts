import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Applies the OPTIONAL migrations in migrations/optional/ (e.g. semantic search,
 * which needs the pgvector extension). Kept separate from the default migration
 * glob so a non-pgvector Postgres can't be broken by an unconditional
 * CREATE EXTENSION.
 */
async function run(): Promise<void> {
  const dir = resolve(__dirname, 'optional');
  if (!existsSync(dir)) {
    console.log('[migrate:optional] No optional migrations directory.');
    await pool.end();
    return;
  }
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(resolve(dir, file), 'utf-8');
      await client.query(sql);
      console.log(`[migrate:optional] Applied optional/${file}`);
    }
  } finally {
    client.release();
  }
  await pool.end();
}

run().catch((err) => {
  console.error('[migrate:optional] Failed:', err);
  process.exit(1);
});
