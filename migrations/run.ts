import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function run(): Promise<void> {
  // Apply every migrations/0*.sql in lexical order (idempotent CREATE/ALTER ...
  // IF [NOT] EXISTS), not just 001. Previously this hardcoded 001 so any new
  // migration silently never ran.
  const files = readdirSync(__dirname)
    .filter((f) => /^0\d+_.*\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(resolve(__dirname, file), 'utf-8');
      await client.query(sql);
      console.log(`[migrate] Applied ${file}`);
    }
  } finally {
    client.release();
  }

  await pool.end();
}

run().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
