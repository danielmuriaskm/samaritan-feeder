import { z } from 'zod';

const schema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  SAMARITAN_BASE_URL: z.string().url().default('http://localhost:3001'),
  SAMARITAN_AUTH_TOKEN: z.string().min(1),
  REDIS_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  FEEDER_ENCRYPTION_KEY: z.string().min(32).optional(),
  MAX_EVENTS_PER_SOURCE_PER_HOUR: z.coerce.number().default(100),
  DEFAULT_RETENTION_DAYS: z.coerce.number().default(30),
  RAW_DATA_RETENTION_DAYS: z.coerce.number().default(7),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid feeder configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();
