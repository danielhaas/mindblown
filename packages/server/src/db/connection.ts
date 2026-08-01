import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://mindblown:mindblown@localhost:5433/mindblown';

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
});

export const db = drizzle(pool, { schema });
export { pool };
