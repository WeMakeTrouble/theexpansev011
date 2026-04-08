// config/session.js
// Session management configuration with PostgreSQL store

import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pool from '../backend/db/pool.js';

const PgSessionStore = pgSession(session);

// Session middleware configuration
export const sessionMiddleware = session({
  store: new PgSessionStore({
    pool: pool,
    tableName: 'session_store',
    createTableIfMissing: true
  }),
  name: 'expanse.sid',
  secret: process.env.SESSION_SECRET || 'CHANGE_THIS_IN_PRODUCTION',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 // 24 hours
  }
});
