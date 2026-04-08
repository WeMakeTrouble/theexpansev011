/**
 * ============================================================================
 * server.js — Application Composition Root (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Bootstrap and wiring layer for The Expanse v010.
 * Every import and initialisation step is logged to the boot report.
 *
 * DESIGN
 * ------
 * - Env + security middleware
 * - Static mounts (added as verified)
 * - Route composition (added as verified)
 * - WebSocket init (added as verified)
 * - Model warm-up (added as verified)
 * - Full boot report showing every loaded component
 *
 * NON-GOALS
 * ---------
 * - No business logic in boot
 * - No domain decisions
 * - No unverified code
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import dotenv from "dotenv";
dotenv.config();

const bootStart = Date.now();
const bootLog = [];

function logBoot(component, status, detail) {
  const ms = Date.now() - bootStart;
  const entry = { ms, component, status, detail };
  bootLog.push(entry);
  const icon = status === "ok" ? "✓" : status === "skip" ? "○" : "✗";
  console.log(`  [${String(ms).padStart(5)}ms] ${icon} ${component}${detail ? " — " + detail : ""}`);
}

console.log("");
console.log("════════════════════════════════════════════════════════════════");
console.log("  THE EXPANSE v010 — BOOT SEQUENCE");
console.log("════════════════════════════════════════════════════════════════");
console.log("");

/* ────────────────────────────────────────────────────────────────────────── */
/*  Core Imports                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

import { createServer } from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { loadIdTypeCache } from './backend/utils/hexIdGenerator.js';

logBoot("express", "ok", "core framework loaded");
logBoot("helmet", "ok", "security headers");
logBoot("cors", "ok", "cross-origin policy");
logBoot("cookie-parser", "ok", "cookie handling");

/* ────────────────────────────────────────────────────────────────────────── */
/*  Session (PostgreSQL-backed)                                               */
/* ────────────────────────────────────────────────────────────────────────── */

import { sessionMiddleware } from "./config/session.js";
logBoot("session", "ok", "PostgreSQL session store");

import initializeWebSocket from "./backend/councilTerminal/socketHandler.js";
logBoot("websocket", "ok", "socket handler imported");

import authRoutes from "./backend/routes/auth.js";
import adminRoutes from "./backend/routes/admin.js";
import verifyAdminAuth from "./backend/middleware/auth.js";
import { verifyUserAuth } from "./backend/middleware/auth.js";
import userCharacterRoutes from "./backend/routes/userCharacters.js";
import userRazorRoutes from "./backend/routes/userRazor.js";
import userAccessRoutes from "./backend/routes/userAccess.js";
import pool from "./backend/db/pool.js";
import commonWordFilter from "./backend/utils/commonWordFilter.js";
import padEstimator from "./backend/services/padEstimator.js";
import ngramSurprisal from "./backend/services/ngramSurprisal.js";
import merchRoutes from "./backend/merch/index.js";
import asciiRoutes from "./backend/routes/ascii.js";
import newsletterRoutes from "./backend/routes/newsletter.js";
logBoot("routes:newsletter", "ok", "newsletter system imported");
logBoot("routes:merch", "ok", "merch system imported");
import merchAdminRoutes from "./backend/merch/adminRoutes.js";
import metaphorDetector from "./backend/services/metaphorDetector.js";
import semanticEmbedder from "./backend/services/SemanticEmbedder.js";
logBoot("auth", "ok", "login/logout/check endpoints");

/* ────────────────────────────────────────────────────────────────────────── */
/*  App Setup                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
/* ────────────────────────────────────────────────────────────────────────── */
/*  Merch Webhooks (raw body required before JSON parsing)                    */
/* ────────────────────────────────────────────────────────────────────────── */
app.use("/api/merch/webhooks", express.raw({type: "application/json"}));
logBoot("routes:merch", "ok", "webhooks mounted (raw body)");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionMiddleware);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.socket.io"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'", "ws:", "wss:", "https://cdn.socket.io"],
        "font-src": ["'self'", "https:", "data:"],
        "media-src": ["'self'", "blob:", "data:"],
        "object-src": ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(cors());
logBoot("middleware", "ok", "json, cookies, session, helmet, cors");

/* ────────────────────────────────────────────────────────────────────────── */
/*  Static File Serving                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));
logBoot("static", "ok", "public/ directory");
app.use("/assets", express.static(path.join(__dirname, "uploads/assets")));
logBoot("static", "ok", "uploads/assets/ directory");
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
logBoot("static", "ok", "uploads/ directory");

/* ────────────────────────────────────────────────────────────────────────── */
/*  Route Mounting                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

app.use("/auth", authRoutes);
logBoot("routes:auth", "ok", "/auth/login, /auth/logout, /auth/check");

app.use("/api/admin", verifyAdminAuth, adminRoutes);
logBoot("routes:admin", "ok", "/api/admin/health, /api/admin/status");

app.use("/api/user/characters", verifyUserAuth, userCharacterRoutes);
logBoot("routes:user", "ok", "/api/user/characters");

app.use("/api/user/razor", verifyUserAuth, userRazorRoutes);
logBoot("routes:user", "ok", "/api/user/razor");
app.use("/api/user/access-status", verifyUserAuth, userAccessRoutes);
logBoot("routes:user", "ok", "/api/user/access-status");
app.use("/api/merch", merchRoutes);
logBoot("routes:merch", "ok", "/api/merch/* mounted");
app.use("/api/admin/merch", verifyAdminAuth, merchAdminRoutes);
app.use("/api/ascii", asciiRoutes);logBoot("routes:admin", "ok", "/api/admin/merch/* mounted");
app.use("/api/newsletter", newsletterRoutes);
logBoot("routes:newsletter", "ok", "/api/newsletter/* mounted");


/* ────────────────────────────────────────────────────────────────────────── */
/*  Health Endpoint                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

app.get("/health", (req, res) => {
  res.json({
    version: "v010",
    status: "ok",
    uptime: process.uptime(),
    bootMs: Date.now() - bootStart,
    componentsLoaded: bootLog.filter(e => e.status === "ok").length,
    componentsSkipped: bootLog.filter(e => e.status === "skip").length,
    componentsFailed: bootLog.filter(e => e.status === "fail").length
  });
});

app.get("/", (req, res) => {
  res.send(`
    <h1 style="font-family: Courier New; color: #00ff00; background: black; text-align:center; padding: 50px;">
      THE EXPANSE v010 SERVER RUNNING
    </h1>
  `);
});

logBoot("routes", "ok", "/ and /health");

/* ────────────────────────────────────────────────────────────────────────── */
/*  Server Start                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

const httpServer = createServer(app);

/* Initialize WebSocket server */
initializeWebSocket(httpServer, sessionMiddleware);
logBoot("websocket", "ok", "Socket.io initialized on /ws/psychic-radar");

/* ────────────────────────────────────────────────────────────────────────── */
/*  Model Warm-Up                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

Promise.all([
  padEstimator.warmUp()
    .then(() => logBoot("padEstimator", "ok", "PAD lexicon trained"))
    .catch(err => logBoot("padEstimator", "warn", "warm-up failed: " + err.message)),
  ngramSurprisal.warmUp()
    .then(() => logBoot("ngramSurprisal", "ok", "N-gram surprisal trained"))
    .catch(err => logBoot("ngramSurprisal", "warn", "warm-up failed: " + err.message)),
  metaphorDetector.train()
    .then(() => logBoot("metaphorDetector", "ok", "Metaphor detector trained"))
    .catch(err => logBoot("metaphorDetector", "warn", "warm-up failed: " + err.message)),
  semanticEmbedder.warmUp()
    .then(() => logBoot("semanticEmbedder", "ok", "Semantic embedder trained"))
    .catch(err => logBoot("semanticEmbedder", "warn", "warm-up failed: " + err.message)),
  commonWordFilter.warmUp(pool)
    .then(() => logBoot("commonWordFilter", "ok", "Vocabulary filter warmed up"))
    .catch(err => logBoot("commonWordFilter", "warn", "warm-up failed: " + err.message)),
  loadIdTypeCache()
    .then(() => logBoot("idTypeCache", "ok", "Hex ID type cache loaded"))
    .catch(err => logBoot("idTypeCache", "warn", "cache load failed: " + err.message))
]);


httpServer.listen(PORT, () => {
  const duration = Date.now() - bootStart;

  console.log("");
  console.log("────────────────────────────────────────────────────────────────");
  console.log("  BOOT COMPLETE");
  console.log("────────────────────────────────────────────────────────────────");
  console.log(`  Port        : ${PORT}`);
  console.log(`  Environment : ${process.env.NODE_ENV || "development"}`);
  console.log(`  Boot time   : ${duration}ms`);
  console.log(`  Components  : ${bootLog.filter(e => e.status === "ok").length} loaded`);
  console.log(`  Health      : http://localhost:${PORT}/health`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("");
});
