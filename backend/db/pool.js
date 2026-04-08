/**
 * ============================================================================
 * pool.js — Database Connection Pool (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Single PostgreSQL connection pool for the entire application.
 * All database access goes through this pool.
 *
 * NOTE
 * ----
 * Calls dotenv.config() directly because ES module import hoisting
 * means this file loads before server.js code executes.
 *
 * REQUIRES
 * --------
 * DATABASE_URL environment variable set in .env
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import dotenv from "dotenv";
dotenv.config();

import pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[pool.js] FATAL: DATABASE_URL not set in environment');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[pool.js] FATAL: Unexpected error on idle client', err);
  process.exit(1);
});

console.log('[pool.js] ✓ Database pool created');

export default pool;
