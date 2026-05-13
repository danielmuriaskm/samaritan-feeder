import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function run(): Promise<void> {
  const file = resolve(__dirname, '001_intelligence.sql');
  const sql = readFileSync(file, 'utf-8');

  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('[migrate] Applied 001_intelligence.sql');
  } finally {
    client.release();
  }

  await pool.end();
}

run().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
