/**
 * ============================================================================
 * socketHandler.js — Canonical Terminal Socket Orchestrator (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Authoritative transport-layer orchestrator for the /terminal Socket.IO
 * namespace, /public namespace for registration, and /ws/psychic-radar
 * namespace for character proximity visualization.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Authenticate socket connections via session middleware
 *  - Initialize onboarding flow (FSM-driven via OnboardingOrchestrator)
 *  - Route terminal commands to ClaudeBrain
 *  - Handle omiyage accept/decline/deferral events
 *  - Manage TSE learning session events (start/respond/pause/resume/summary)
 *  - Enforce safety guards (MechanicalBrain blocking)
 *  - Track user-visible entity encounters via UIMS hex scanning
 *  - Update dossier snapshots on session disconnect
 *  - Serve psychic radar contact data
 *
 * NON-GOALS
 * ---------
 *  - No wizard logic (gift wizard, menu wizard removed in v008)
 *  - No admin tooling via sockets
 *  - No business logic outside orchestration
 *  - No direct SQL mutations (delegated to services)
 *
 * SOCKET-LOCAL STATE
 * ------------------
 *  - socket._onboardingHandled : boolean (guard against duplicate init)
 *  - socket._omiyageTimer      : timeout handle (cleared on user input)
 *  - socket._tseSessionId      : active TSE session hex ID
 *  - socket.userId             : from session
 *  - socket.username           : from session
 *  - socket.accessLevel        : from session
 *  - socket.ownedCharacterId   : from session or DB lookup
 *  - socket.context            : conversation context (ephemeral)
 *  - socket.conversationId     : hex conversation ID (generated on connect)
 *  - socket.turnIndex          : incremented each terminal-command
 *  - socket.beltLevels         : map of domain_id → current_belt
 *  - socket.authorityKey       : frozen user key for duplicate prevention
 *  - socket.tseResumeOffered   : boolean TSE resume state
 *  - socket.tseDeclinedThisSession : boolean TSE decline state
 *  - socket.awaitingSessions   : pending TSE sessions
 *
 * NAMESPACES
 * ----------
 *  /public          — Registration (unauthenticated)
 *  /terminal        — Authenticated terminal commands
 *  /ws/psychic-radar — Character proximity radar (unauthenticated)
 *
 * FOUNDATIONAL INVARIANTS
 * -----------------------
 *  - Single-process: Socket state is process-local; unsafe to scale
 *  - Backend authority: Events are requests; state validated server-side
 *  - DB as truth: Always query DB for state; in-memory is ephemeral
 *  - Deterministic: No randomness in logic; reproducible outputs
 *  - No external LLMs: All processing via internal services
 *
 * MIGRATION FROM v009
 * -------------------
 *  - Replaced v009 Logger with v010 createModuleLogger (structured logging)
 *  - Replaced generateCorrelationId with crypto.randomUUID()
 *  - Removed hardcoded CLAUDE_ID — uses CLAUDE_CHARACTER_ID from constants
 *  - Removed console.log violation (line 759 in v009)
 *  - Removed diagnostic/debug debris (lines 576-579, 611, 674 in v009)
 *  - Replaced emoji string-concat logs with structured logger calls
 *  - Froze all UIMS constants
 *  - Added counters for observability
 *
 * CONSUMERS
 * ---------
 *  - server.js (calls initializeWebSocket on startup)
 *
 * DEPENDENCIES
 * ------------
 *  Internal: pool.js, logger.js, ClaudeBrain.js, OnboardingOrchestrator.js,
 *            omiyageService.js, constants.js, narrativeWelcomeService.js,
 *            ConciergeStatusReportService.js, TSELoopManagerSingleton.js,
 *            hexIdGenerator.js, ConversationStateManager.js,
 *            userInteractionMemoryService.js, counters.js
 *  External: socket.io, crypto
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import claudeBrain from './ClaudeBrain.js';
import onboardingOrchestrator, {
  InvalidTransitionError,
  OptimisticLockError
} from '../services/OnboardingOrchestrator.js';
import * as omiyageService from '../services/omiyageService.js';
import { CLAUDE_CHARACTER_ID } from './config/constants.js';
import { getFirstLoginWelcomeBeat } from '../services/narrativeWelcomeService.js';
import ConciergeStatusReportService from '../services/ConciergeStatusReportService.js';
import { getTSELoopManager } from '../TSE/TSELoopManagerSingleton.js';
import generateHexId, { getIdTypeSync } from '../utils/hexIdGenerator.js';
import ConversationStateManager from '../services/ConversationStateManager.js';
import { recordInteractionsBatch, getInteractionSummary } from '../services/userInteractionMemoryService.js';
import Counters from './metrics/counters.js';
import { getState as wwddGetState } from '../services/wwdd/index.js';

const logger = createModuleLogger('SocketHandler');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Module-Level Handler Tracking (prevents duplicate registration)           */
/* ────────────────────────────────────────────────────────────────────────── */

const boundUserSessions = new Map();

/* ────────────────────────────────────────────────────────────────────────── */
/*  UIMS: User Interaction Memory System — Global Hex Scanner                */
/* ────────────────────────────────────────────────────────────────────────── */

const UIMS_CONSTANTS = Object.freeze({
  MAX_ENTITIES_PER_RESPONSE: 20,
  MAX_OUTPUT_LENGTH: 32768,
  QUEUE_FLUSH_THRESHOLD: 10,
  QUEUE_DEBOUNCE_MS: 500,
  MAX_QUEUE_SIZE: 50,
  DOSSIER_MAX_DISCOVERIES: 5,
  DOSSIER_TYPE: 'user'
});

const UIMS_HEX_PATTERN = /#[0-9A-Fa-f]{6}/g;
const uimsQueue = new Map();

function extractTrackableEntities(output) {
  if (!output || typeof output !== 'string') return [];
  if (output.length > UIMS_CONSTANTS.MAX_OUTPUT_LENGTH) return [];

  const matches = output.match(UIMS_HEX_PATTERN) || [];
  const seen = new Set();
  const entities = [];

  for (const raw of matches) {
    const hexId = '#' + raw.slice(1).toUpperCase();
    if (seen.has(hexId)) continue;
    seen.add(hexId);

    const entityType = getIdTypeSync(hexId);
    if (!entityType || entityType === 'unknown') continue;

    entities.push({ entityId: hexId, entityType });

    if (entities.length >= UIMS_CONSTANTS.MAX_ENTITIES_PER_RESPONSE) break;
  }

  return entities;
}

function queueUimsEntities(userId, entities, accessLevel, beltLevels, interactionSource, correlationId) {
  if (!userId || entities.length === 0) return;

  let bucket = uimsQueue.get(userId);
  if (!bucket) {
    bucket = { entities: [], seen: new Set(), timer: null };
    uimsQueue.set(userId, bucket);
  }

  for (const entity of entities) {
    const key = entity.entityType + ':' + entity.entityId;
    if (bucket.seen.has(key)) continue;
    bucket.seen.add(key);

    bucket.entities.push({
      userId,
      entityType: entity.entityType ? String(entity.entityType) : 'unknown',
      entityId: entity.entityId,
      entityName: null,
      interactionSource: interactionSource || 'terminal_response',
      userAccessLevel: accessLevel,
      userBeltLevel: beltLevels || null,
      correlationId
    });
  }

  if (bucket.entities.length >= UIMS_CONSTANTS.MAX_QUEUE_SIZE) {
    logger.warn('UIMS queue size exceeded, forcing flush', {
      userId,
      size: bucket.entities.length,
      correlationId
    });
    flushUimsQueue(userId);
    return;
  }

  if (bucket.entities.length >= UIMS_CONSTANTS.QUEUE_FLUSH_THRESHOLD) {
    flushUimsQueue(userId);
    return;
  }

  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = setTimeout(() => flushUimsQueue(userId), UIMS_CONSTANTS.QUEUE_DEBOUNCE_MS);
}

function flushUimsQueue(userId) {
  const bucket = uimsQueue.get(userId);
  if (!bucket || bucket.entities.length === 0) {
    uimsQueue.delete(userId);
    return;
  }

  if (bucket.timer) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }

  const interactions = [...bucket.entities];
  const batchCorrelationId = interactions[0]?.correlationId;

  bucket.entities = [];
  bucket.seen.clear();
  uimsQueue.delete(userId);

  recordInteractionsBatch(interactions, batchCorrelationId)
    .then(result => {
      if (!result.success) {
        logger.warn('UIMS batch write returned failure', {
          userId,
          entityCount: interactions.length,
          error: result.error
        });
      }
    })
    .catch(err => {
      logger.warn('UIMS batch flush failed', {
        userId,
        entityCount: interactions.length,
        error: err.message
      });
    });
}

process.on('SIGTERM', () => {
  logger.info('UIMS draining all queues on shutdown');
  for (const [userId] of uimsQueue) {
    flushUimsQueue(userId);
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  B-Roll: Idle Timer Constants                                              */
/* ────────────────────────────────────────────────────────────────────────── */

const BROLL_IDLE_TIMEOUT_MS = 30000;

const BELT_ORDER = Object.freeze(['white', 'blue', 'purple', 'brown', 'black']);

function getHighestBelt(beltLevels) {
  if (!beltLevels || typeof beltLevels !== 'object') return 'white';
  let highest = 0;
  for (const belt of Object.values(beltLevels)) {
    const idx = BELT_ORDER.indexOf(belt);
    if (idx > highest) highest = idx;
  }
  return BELT_ORDER[highest];
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  UIMS: Dossier Snapshot on Session End                                    */
/* ────────────────────────────────────────────────────────────────────────── */

async function updateDossierSnapshot(userId, socketId, beltLevels) {
  const correlationId = 'SESSION_END_' + socketId.substring(0, 8) + '_' + Date.now();

  const summary = await getInteractionSummary(userId, correlationId);
  if (!summary.success || !summary.summary) {
    logger.warn('No summary available for dossier snapshot', { userId, correlationId });
    return;
  }

  const snapshotData = {
    interactionMemory: {
      totalEntitiesEncountered: summary.summary.totalEntitiesEncountered,
      recentDiscoveries: summary.summary.recentDiscoveries
        .slice(0, UIMS_CONSTANTS.DOSSIER_MAX_DISCOVERIES)
        .map(d => d.entity_id),
      pendingFollowUps: summary.summary.pendingFollowUps.length,
      beltCreditsAwarded: summary.summary.beltCredits
        .reduce((sum, r) => sum + Number(r.credits), 0),
      userBeltLevel: beltLevels || null,
      snapshotAt: new Date().toISOString()
    }
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE cotw_dossiers SET helpdesk_context = helpdesk_context || $1::jsonb, updated_at = NOW() WHERE user_id = $2 AND dossier_type = $3',
      [JSON.stringify(snapshotData), userId, UIMS_CONSTANTS.DOSSIER_TYPE]
    );
    await client.query('COMMIT');
    logger.info('Dossier snapshot updated on disconnect', {
      userId,
      totalEntities: summary.summary.totalEntitiesEncountered,
      correlationId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Session Middleware Wrapper                                                */
/* ────────────────────────────────────────────────────────────────────────── */

function wrapSessionMiddleware(middleware) {
  return (socket, next) => middleware(socket.request, {}, next);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Onboarding Flow Handler                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

async function handleOnboardingFlow(socket, correlationId) {
  if (socket._onboardingHandled) {
    logger.debug('Onboarding already handled for this socket', { correlationId });
    return;
  }
  socket._onboardingHandled = true;

  try {
    await onboardingOrchestrator.initializeUser(socket.userId);
    const state = await onboardingOrchestrator.getCurrentState(socket.userId);

    if (!state) {
      logger.error('Onboarding failed to get state', { correlationId, userId: socket.userId });
      return;
    }

    logger.debug('Onboarding user state', {
      correlationId,
      userId: socket.userId,
      state: state.current_state,
      version: state.state_version
    });

    switch (state.current_state) {
      case 'new': {
        const welcomeBeat = await getFirstLoginWelcomeBeat(socket.userId, CLAUDE_CHARACTER_ID);
        if (welcomeBeat) {
          logger.debug('Emitting welcome beat', { correlationId, beatId: welcomeBeat.beatId });
          socket.emit('command-response', {
            mode: 'tanuki',
            from: 'Claude',
            welcome: true,
            welcomeBeat
          });
        }

        await onboardingOrchestrator.advanceToAwaitingReadyAfterWelcome(
          socket.userId,
          welcomeBeat?.beat_id
        );

        socket._omiyageTimer = setTimeout(async () => {
          try {
            const currentState = await onboardingOrchestrator.getCurrentState(socket.userId);
            if (currentState && currentState.current_state === 'awaiting_ready') {
              logger.debug('Onboarding 15s timeout, proactive omiyage', { correlationId });
              await onboardingOrchestrator.transitionTo(
                socket.userId,
                'omiyage_offered',
                {},
                'proactive_timeout'
              );
              const result = await omiyageService.checkAndInitiateOmiyage(socket.userId);
              if (result && result.type !== 'resume_resolved') {
                socket.emit('omiyage:offer', {
                  choiceId: result.choiceId,
                  offerCount: result.offerCount,
                  narrative: result.narrative,
                  giverName: 'Claude The Tanuki'
                });
              }
            }
          } catch (err) {
            logger.error('Proactive omiyage error', { correlationId, error: err.message });
          }
        }, 15000);
        break;
      }

      case 'welcomed': {
        await onboardingOrchestrator.transitionTo(
          socket.userId,
          'awaiting_ready',
          {},
          'reconnect_after_welcome'
        );
        break;
      }

      case 'awaiting_ready': {
        logger.debug('User awaiting affirmative', { correlationId });
        break;
      }

      case 'omiyage_offered': {
        const result = await omiyageService.checkAndInitiateOmiyage(socket.userId);
        if (result) {
          if (result.type === 'resume_resolved') {
            const fulfilResult = await omiyageService.fulfilOmiyage(result.choiceId, socket.ownedCharacterId);
            const narrative = await omiyageService.buildFulfilmentNarrative(fulfilResult.object);
            socket.emit('omiyage:fulfilled', {
              choiceId: result.choiceId,
              object: fulfilResult.object,
              narrative
            });
            await onboardingOrchestrator.transitionTo(
              socket.userId,
              'onboarded',
              { choice_id: result.choiceId },
              'omiyage_auto_fulfilled_on_reconnect'
            );
          } else {
            socket.emit('omiyage:offer', {
              choiceId: result.choiceId,
              offerCount: result.offerCount,
              narrative: result.narrative,
              giverName: 'Claude The Tanuki'
            });
          }
        }
        break;
      }

      case 'onboarded': {
        logger.debug('User already onboarded', { correlationId });
        break;
      }
    }

  } catch (err) {
    if (err.name === 'OptimisticLockError') {
      logger.warn('Onboarding concurrent state change detected', { correlationId });
    } else if (err.name === 'InvalidTransitionError') {
      logger.error('Onboarding invalid transition', { correlationId, error: err.message });
    } else {
      logger.error('Onboarding flow error', { correlationId, error: err.message });
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Psychic Radar: Contact Fetcher                                           */
/* ────────────────────────────────────────────────────────────────────────── */

async function getRadarContacts() {
  try {
    const result = await pool.query(`
      SELECT
        ppd.from_character,
        ppd.to_character,
        ppd.current_distance,
        ppd.emotional_resonance,
        ppd.relationship_type,
        c.character_name,
        c.category,
        m.p AS mood_p,
        m.a AS mood_a,
        m.d AS mood_d
      FROM psychic_proximity_directed ppd
      JOIN character_profiles c ON ppd.from_character = c.character_id
      LEFT JOIN psychic_moods m ON ppd.from_character = m.character_id
      WHERE ppd.to_character = $1
        AND c.category NOT IN ('Knowledge Entity', 'User Avatar')
      ORDER BY ppd.current_distance ASC
    `, [CLAUDE_CHARACTER_ID]);

    const contacts = [];

    let angleOffset = 0;
    const angleSpread = 360 / Math.max(result.rows.length, 1);

    for (const row of result.rows) {
      contacts.push({
        id: row.from_character,
        name: row.character_name,
        distance: row.current_distance,
        angle: angleOffset,
        intensity: row.emotional_resonance,
        category: row.category,
        mood: {
          p: parseFloat(row.mood_p) || 0,
          a: parseFloat(row.mood_a) || 0,
          d: parseFloat(row.mood_d) || 0
        },
        relationship: row.relationship_type
      });
      angleOffset += angleSpread;
    }

    return contacts;
  } catch (err) {
    logger.error('Psychic radar failed to get contacts', { error: err.message });
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Admin Systems Report: Connection Health Check                            */
/* ────────────────────────────────────────────────────────────────────────── */

async function generateAdminSystemsReport(userId, correlationId) {
  try {
    const queries = await Promise.allSettled([
      pool.query('SELECT COUNT(*) AS total FROM users'),
      pool.query('SELECT COUNT(*) AS total FROM character_profiles'),
      pool.query('SELECT COUNT(*) FILTER (WHERE is_active = true) AS active FROM character_profiles'),
      pool.query('SELECT COUNT(DISTINCT category) AS categories FROM character_profiles'),
      pool.query('SELECT MAX(last_login) AS recent FROM users'),
      pool.query("SELECT COUNT(*) AS total FROM tse_cycles WHERE status = 'running'"),
      pool.query('SELECT COUNT(*) AS total FROM conversations'),
      pool.query('SELECT COUNT(*) AS total FROM knowledge_domains'),
      pool.query('SELECT pg_database_size(current_database()) AS db_size'),
    ]);

    const val = (idx, field) => {
      const r = queries[idx];
      if (r.status !== 'fulfilled' || !r.value.rows[0]) return '?';
      return r.value.rows[0][field];
    };

    const dbSizeBytes = val(8, 'db_size');
    const dbSizeMB = dbSizeBytes !== '?' ? (Number(dbSizeBytes) / 1048576).toFixed(1) : '?';

    const lastLogin = val(4, 'recent');
    const lastLoginStr = lastLogin !== '?' && lastLogin
      ? new Date(lastLogin).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
      : 'Never';

    const uptimeSeconds = Math.floor(process.uptime());
    const uptimeHours = Math.floor(uptimeSeconds / 3600);
    const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

    const report = [
      '=== ADMIN SYSTEMS REPORT ===',
      '',
      'Server Status: ONLINE',
      'Uptime: ' + uptimeHours + 'h ' + uptimeMinutes + 'm',
      'Database: ' + dbSizeMB + ' MB',
      '',
      'Users: ' + val(0, 'total'),
      'Characters: ' + val(1, 'total') + ' (' + val(2, 'active') + ' active)',
      'Character Categories: ' + val(3, 'categories'),
      'Knowledge Domains: ' + val(7, 'total'),
      'Conversations: ' + val(6, 'total'),
      'Active TSE Sessions: ' + val(5, 'total'),
      '',
      'Last User Login: ' + lastLoginStr,
      '',
      'All systems operational. Ready for admin commands.',
    ].join('\n');

    logger.info('Admin systems report generated', { correlationId, userId });
    return { success: true, report };

  } catch (err) {
    logger.error('Admin systems report failed', { correlationId, error: err.message });
    return { success: false, error: err.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Main Export: WebSocket Initialization                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export default function initializeWebSocket(httpServer, sessionMiddleware) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
      credentials: true
    }
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  /public Namespace (Registration)                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  const publicIo = io.of('/public');
  publicIo.on('connection', (socket) => {
    logger.debug('Public socket connected', { socketId: socket.id });
    Counters.increment('socket_handler', 'public_connect');
    socket.on('disconnect', () => {
      logger.debug('Public socket disconnected', { socketId: socket.id });
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  /terminal Namespace (Authenticated)                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  const terminalIo = io.of('/terminal');

  terminalIo.disconnectSockets(true);
  boundUserSessions.clear();
  logger.warn('Forced terminal socket reset on boot');

  terminalIo.use(wrapSessionMiddleware(sessionMiddleware));

  terminalIo.use(async (socket, next) => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) {
      return next(new Error('Unauthorized'));
    }

    socket.userId = sess.userId;
    socket.username = sess.username;
    socket.accessLevel = sess.accessLevel || sess.access_level || 1;

    if (sess.ownedCharacterId) {
      socket.ownedCharacterId = sess.ownedCharacterId;
    } else {
      try {
        const result = await pool.query(
          'SELECT owned_character_id FROM users WHERE user_id = $1',
          [sess.userId]
        );
        if (result.rows.length > 0 && result.rows[0].owned_character_id) {
          socket.ownedCharacterId = result.rows[0].owned_character_id;
          sess.ownedCharacterId = socket.ownedCharacterId;
        }
      } catch (err) {
        logger.error('Failed to fetch owned_character_id', { error: err.message, userId: sess.userId });
      }
    }

    try {
      const beltResult = await pool.query(
        'SELECT domain_id, current_belt FROM user_belt_progression WHERE user_id = $1',
        [sess.userId]
      );
      if (beltResult.rows.length > 0) {
        const beltMap = {};
        for (const row of beltResult.rows) {
          beltMap[row.domain_id] = row.current_belt;
        }
        socket.beltLevels = beltMap;
      } else {
        socket.beltLevels = null;
      }
    } catch (err) {
      logger.error('Failed to fetch belt levels', { error: err.message, userId: sess.userId });
      socket.beltLevels = null;
    }

    next();
  });

  terminalIo.on('connection', (socket) => {
    socket.authorityKey = socket.userId ?? ('anon_' + socket.id);
    const userKey = socket.authorityKey;
    if (boundUserSessions.has(userKey)) {
      const oldSocketId = boundUserSessions.get(userKey);
      logger.debug('Replacing old socket binding', { userId: userKey, oldSocketId, newSocketId: socket.id });
    }
    boundUserSessions.set(userKey, socket.id);
    Counters.increment('socket_handler', 'terminal_connect');

    /* ──────────────────────────────────────────────────────────────────── */
    /*  QUD SYSTEM: Initialize Conversation Tracking                      */
    /* ──────────────────────────────────────────────────────────────────── */

    socket.turnIndex = 0;

    (async () => {
      try {
        const conversationId = await generateHexId('conversation_id');
        socket.conversationId = conversationId;

        await ConversationStateManager.getOrCreateState(conversationId, socket.userId);

        logger.debug('Conversation initialized', {
          conversationId,
          userId: socket.userId
        });
      } catch (err) {
        logger.error('Failed to initialize conversation', {
          error: err.message,
          userId: socket.userId
        });
      }
    })();

    logger.info('Terminal connected', {
      username: socket.username,
      accessLevel: socket.accessLevel,
      socketId: socket.id
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  CONNECTION REPORT: Admin Systems Report or User Concierge          */
    /* ──────────────────────────────────────────────────────────────────── */

    (async () => {
      if (!socket.userId) return;

      const correlationId = randomUUID();
      const isAdmin = (socket.accessLevel || 0) >= 11;

      try {
        if (isAdmin) {
          logger.debug('Generating admin systems report', {
            correlationId,
            userId: socket.userId
          });

          const adminResult = await generateAdminSystemsReport(socket.userId, correlationId);

          if (adminResult.success) {
            socket.emit('command-response', {
              output: adminResult.report,
              type: 'admin_systems_report',
              isStatusReport: true,
              timestamp: new Date().toISOString()
            });
            Counters.increment('socket_handler', 'admin_report_sent');
          } else {
            logger.warn('Admin systems report failed', {
              correlationId,
              error: adminResult.error
            });
          }
        } else {
          logger.debug('Generating concierge status report', {
            correlationId,
            userId: socket.userId
          });

          const statusResult = await ConciergeStatusReportService.generateStatusReport(
            socket.userId,
            correlationId
          );

          if (statusResult.success) {
            socket.emit('command-response', {
              output: statusResult.report,
              type: 'concierge_status',
              isStatusReport: true,
              timestamp: new Date().toISOString()
            });
            logger.info('Concierge status report sent', {
              correlationId,
              userId: socket.userId
            });
            Counters.increment('socket_handler', 'concierge_report_sent');
          } else {
            logger.warn('Concierge status report generation failed', {
              correlationId,
              userId: socket.userId,
              error: statusResult.error
            });
          }
        }
      } catch (error) {
        logger.error('Connection report error', {
          error: error.message,
          userId: socket.userId,
          isAdmin
        });
      }
    })();

    /* ──────────────────────────────────────────────────────────────────── */
    /*  terminal-command Event                                             */
    /* ──────────────────────────────────────────────────────────────────── */

    socket.on('terminal-command', async (data) => {
      const correlationId = randomUUID();

      if (socket._brollIdleTimer) {
        clearTimeout(socket._brollIdleTimer);
        socket._brollIdleTimer = null;
      }

      const userKey = socket.authorityKey;
      if (boundUserSessions.get(userKey) !== socket.id) {
        logger.debug('Ignoring command from stale socket', {
          correlationId,
          userId: userKey,
          socketId: socket.id,
          activeSocketId: boundUserSessions.get(userKey)
        });
        return;
      }

      try {
        if (!socket.userId) {
          socket.emit('command-response', { error: 'NOT_AUTHENTICATED' });
          return;
        }

        if (!socket._onboardingHandled) {
          await handleOnboardingFlow(socket, correlationId);
        }

        const { command } = data;
        logger.debug('Command received', { correlationId, command });

        const state = await onboardingOrchestrator.getCurrentState(socket.userId);

        if (state && state.current_state === 'awaiting_ready') {
          if (socket._omiyageTimer) {
            clearTimeout(socket._omiyageTimer);
          }
          logger.debug('User input detected, advancing to omiyage', { correlationId });

          try {
            await onboardingOrchestrator.transitionTo(
              socket.userId,
              'omiyage_offered',
              {},
              'user_affirmative'
            );

            const result = await omiyageService.checkAndInitiateOmiyage(socket.userId);
            if (result && result.type !== 'resume_resolved') {
              socket.emit('omiyage:offer', {
                choiceId: result.choiceId,
                offerCount: result.offerCount,
                narrative: result.narrative,
                giverName: 'Claude The Tanuki'
              });
            }
            return;
          } catch (err) {
            if (err.name === 'OptimisticLockError') {
              logger.warn('Concurrent affirmative, re-checking state', { correlationId });
              const updatedState = await onboardingOrchestrator.getCurrentState(socket.userId);
              if (updatedState.current_state === 'omiyage_offered') {
                logger.debug('Already advanced by another process', { correlationId });
                return;
              }
            } else if (err.name === 'InvalidTransitionError') {
              logger.error('Invalid transition from awaiting_ready', { correlationId, error: err.message });
            }
            throw err;
          }
        }

        socket.turnIndex++;
        const session = {
          userId: socket.userId,
          username: socket.username,
          access_level: socket.accessLevel,
          context: socket.context || {},
          owned_character_id: socket.ownedCharacterId,
          conversationId: socket.conversationId,
          turnIndex: socket.turnIndex,
          tseResumeOffered: socket.tseResumeOffered || false,
          tseDeclinedThisSession: socket.tseDeclinedThisSession || false,
          awaitingSessions: socket.awaitingSessions || null
        };



        /* ── TSE Pre-Processing Handlers ─────────────────────────── */
        /* Priority 1: Stale session check (once per connection)      */
        /* Priority 2: Review gate YES/NO response                    */
        /* Priority 3: Active TSE session redirect                    */
        /* ────────────────────────────────────────────────────────── */

        const tseManager = getTSELoopManager();

        /* ── Handler 1: Stale Session Check (non-blocking, once) ── */
        if (!socket._tseStaleChecked && tseManager && socket.userId && !socket._tseSessionId) {
          socket._tseStaleChecked = true;
          try {
            const staleSession = await tseManager.getAwaitingSessionForUser(socket.userId);
            if (staleSession && staleSession.currentTask) {
              logger.info("TSE stale session found, flagged for future resume", {
                correlationId,
                sessionId: staleSession.id,
                taskType: staleSession.currentTask?.taskType
              });
              // Session stays in DB per no stale-session rejection principle
              // Future: emit tse:resume_offer when frontend handler exists
            }
          } catch (tseErr) {
            logger.warn("TSE stale session check failed, continuing normally", {
              correlationId,
              error: tseErr.message
            });
          }
        }

        /* ── Handler 2: Review Gate YES/NO Response ───────────── */
        if (socket._tseReviewGateDomain) {
          const gateDomain = socket._tseReviewGateDomain;
          const cmd = command.trim().toLowerCase();

          if (cmd === "yes" || cmd === "y") {
            logger.info("TSE review gate accepted", { correlationId, domainId: gateDomain });
            socket._tseReviewGateDomain = null;

            try {
              const result = await tseManager.runOrContinueTseSession(
                socket.ownedCharacterId,
                null,
                null,
                null,
                { focusDomain: gateDomain, singleTurn: true }
              );

              if (result && result.session) {
                await tseManager.saveSessionState(result.session);
                socket._tseSessionId = result.session.id;

                socket.emit("tse:task", {
                  sessionId: result.session.id,
                  task: result.task,
                  teachingContent: result.task?.input || result.task?.teachingStatement || "Let us begin your review.",
                  evaluation: result.evaluation || null,
                  completedTasks: result.session.completedTasks || 0,
                  status: "awaiting_response"
                });
              }
            } catch (tseErr) {
              logger.error("TSE review gate start failed", { correlationId, error: tseErr.message });
              socket.emit("tse:error", { error: tseErr.message });
            }
            return;

          } else if (cmd === "no" || cmd === "n") {
            logger.info("TSE review gate declined", { correlationId, domainId: gateDomain });
            socket._tseReviewGateDomain = null;
            // Fall through to normal processQuery
          } else {
            logger.info("TSE review gate cleared (unrecognised input)", { correlationId, input: cmd });
            socket._tseReviewGateDomain = null;
            // Fall through to normal processQuery
          }
        }

        /* ── Handler 3: Active TSE Session Redirect ───────────── */
        if (socket._tseSessionId && tseManager) {
          const activeSessionId = socket._tseSessionId;
          logger.info("TSE active session redirect", { correlationId, sessionId: activeSessionId });

          try {
            const savedSession = await tseManager.loadSessionState(activeSessionId);
            if (!savedSession) {
              logger.warn("TSE active session not found, clearing", { correlationId, sessionId: activeSessionId });
              socket._tseSessionId = null;
            } else {
              const result = await tseManager.runOrContinueTseSession(
                socket.ownedCharacterId,
                savedSession.query,
                command.trim(),
                null,
                { focusDomain: savedSession.domainId, singleTurn: true, existingSessionId: activeSessionId }
              );


              if (result.session) {
                await tseManager.saveSessionState(result.session);

                const isComplete = (result.session.completedTasks || 0) >= 5 || result.session.status === "completed";

                socket.emit("tse:task", {
                  sessionId: result.session.id,
                  task: result.task,
                  teachingContent: result.task ? (result.task.input || result.task.teachingStatement || "") : null,
                  evaluation: result.evaluation || null,
                  completedTasks: result.session.completedTasks || 0,
                  status: isComplete ? "complete" : "awaiting_response"
                });

                if (isComplete) {
                  logger.info("TSE session complete, clearing", { correlationId, sessionId: activeSessionId });
                  socket._tseSessionId = null;
                }
              } else {
                // Re-teach or non-standard result shape
                socket.emit("tse:task", {
                  sessionId: activeSessionId,
                  task: null,
                  teachingContent: result.teachingStatement || result.message || "Let us try again.",
                  evaluation: null,
                  completedTasks: 0,
                  status: "awaiting_response"
                });
              }

              Counters.increment("socket_handler", "tse_terminal_redirect");
              return;
            }
          } catch (tseErr) {
            logger.error("TSE redirect failed, clearing session", { correlationId, error: tseErr.message });
            socket._tseSessionId = null;
            socket.emit("tse:error", { error: tseErr.message });
            return;
          }
        }


        const user = session;
        const brainResponse = await claudeBrain.processQuery({ command, session, user: session, correlationId });

        /* ── TSE Direct Emit Handler ─────────────────────────────────── */
        /* If BrainOrchestrator signalled a TSE session start via        */
        /* turnState, emit the socket event and skip terminal response.  */
        if (brainResponse?._tseDirectEmit) {
          const tseEmit = brainResponse._tseDirectEmit;
          socket.emit(tseEmit.event, tseEmit.payload);
          socket._tseSessionId = tseEmit.payload.sessionId;
          logger.info('TSE direct emit from curriculum selection', {
            correlationId,
            sessionId: tseEmit.payload.sessionId,
            event: tseEmit.event
          });
          return;
        }

        /* ── Cache Review Gate Domain from BrainOrchestrator ──── */
        if (brainResponse?._tseReviewGateDomain) {
          socket._tseReviewGateDomain = brainResponse._tseReviewGateDomain;
          logger.info("TSE review gate domain cached", {
            correlationId,
            domainId: brainResponse._tseReviewGateDomain
          });
        }


        const response = { ...brainResponse, source: brainResponse.source || 'UNSPECIFIED', userInput: command };

        try {
          socket.context = JSON.parse(JSON.stringify(response.context || session.context));
        } catch (e) {
          logger.error('socket.context assignment failed', {
            correlationId,
            error: e?.message,
            contextType: typeof response.context
          });
        }

        if (session.tseResumeOffered) {
          socket.tseResumeOffered = true;
        }
        if (session.tseDeclinedThisSession) {
          socket.tseDeclinedThisSession = true;
        }
        if (session.awaitingSessions !== undefined) {
          socket.awaitingSessions = session.awaitingSessions;
        }

        if (socket.context?.teachingStateId) {
          logger.debug('teachingStateId persisted', { correlationId, teachingStateId: socket.context.teachingStateId });
        }

        if (response?.source === 'MechanicalBrain') {
          logger.error('MechanicalBrain output blocked', { correlationId });
          socket.emit('command-response', { error: 'INTERNAL_ROUTING_ERROR' });
          return;
        }

        if (socket.userId && response.success !== false) {
          const responsePayload = JSON.stringify(response);
          const trackableEntities = extractTrackableEntities(responsePayload);
          if (trackableEntities.length > 0) {
            const uimsSource = response.image ? 'terminal_image' : 'terminal_response';
            queueUimsEntities(
              socket.userId,
              trackableEntities,
              socket.accessLevel,
              socket.beltLevels || null,
              uimsSource,
              correlationId
            );
          }
        }

        try {
          JSON.stringify(response);
        } catch (e) {
          logger.error('Response not serializable', {
            correlationId,
            error: e.message
          });
          socket.emit('command-response', { error: 'RESPONSE_SERIALIZATION_FAILED' });
          return;
        }

        try {
          if (!socket || socket.disconnected) {
            logger.warn('Socket invalid at emit time', {
              correlationId,
              socketId: socket?.id,
              disconnected: socket?.disconnected
            });
            return;
          }

          socket.emit('command-response', response);

          const wwddState = wwddGetState(socket.conversationId);
          if (wwddState && !socket.disconnected) {
            socket.emit('wwdd_update', wwddState);
          }
          Counters.increment('socket_handler', 'command_success');

          if (socket._brollIdleTimer) {
            clearTimeout(socket._brollIdleTimer);
          }
          socket._brollIdleTimer = setTimeout(async () => {
            socket._brollIdleTimer = null;
            if (!socket.userId || socket.disconnected) return;
            const brollCorrelationId = randomUUID();
            try {
              const userBelt = getHighestBelt(socket.beltLevels);
              const brollResult = await claudeBrain.runBRollCycle({
                userBelt,
                correlationId: brollCorrelationId
              });
              if (brollResult && !brollResult.alreadyClaimed && !socket.disconnected) {
                socket.emit('command-response', {
                  output: brollResult.narration || null,
                  type: 'broll_visit',
                  brollVisit: {
                    characterId: brollResult.characterId,
                    visitType: brollResult.visitType,
                    sessionTurns: brollResult.sessionTurns || 0,
                    newItemsTaught: brollResult.newItemsTaught || 0,
                    itemsReviewed: brollResult.itemsReviewed || 0
                  },
                  timestamp: new Date().toISOString()
                });
                Counters.increment('socket_handler', 'broll_visit_emitted');
              }
            } catch (brollErr) {
              logger.warn('B-Roll idle cycle failed', {
                correlationId: brollCorrelationId,
                userId: socket.userId,
                error: brollErr.message
              });
            }
          }, BROLL_IDLE_TIMEOUT_MS);
        } catch (e) {
          logger.error('socket.emit failed', {
            correlationId,
            error: e.message
          });
        }

      } catch (err) {
        logger.error('Terminal command error', {
          correlationId,
          userId: socket.userId,
          error: err.message,
          stack: err.stack
        });
        Counters.increment('socket_handler', 'command_error');
        socket.emit('command-response', { error: 'COMMAND_FAILED' });
      }
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  omiyage:accept Event                                               */
    /* ──────────────────────────────────────────────────────────────────── */

    socket.on('omiyage:accept', async (payload) => {
      const correlationId = randomUUID();
      logger.debug('Omiyage accept received', { correlationId, userId: socket.userId, payload });

      try {
        const { choiceId, chosenNumber } = payload;

        if (!choiceId || !chosenNumber) {
          socket.emit('omiyage:error', { error: 'Missing choiceId or chosenNumber' });
          return;
        }

        const resolveResult = await omiyageService.resolveChoice(choiceId, chosenNumber);

        if (resolveResult.alreadyResolved) {
          logger.debug('Omiyage choice already resolved', { correlationId, status: resolveResult.status });
          if (resolveResult.status === 'fulfilled') {
            socket.emit('omiyage:fulfilled', { choiceId, alreadyFulfilled: true });
            return;
          }
        }

        const fulfilResult = await omiyageService.fulfilOmiyage(choiceId, socket.ownedCharacterId);
        const narrative = await omiyageService.buildFulfilmentNarrative(fulfilResult.object);

        socket.emit('omiyage:fulfilled', {
          choiceId,
          object: fulfilResult.object,
          narrative,
          newInventoryEntryId: fulfilResult.newInventoryEntryId
        });

        try {
          await onboardingOrchestrator.transitionTo(
            socket.userId,
            'onboarded',
            { choice_id: choiceId },
            'omiyage_accepted'
          );
        } catch (err) {
          if (err.name === 'OptimisticLockError') {
            logger.warn('Concurrent completion on accept', { correlationId });
          } else if (err.name === 'InvalidTransitionError') {
            logger.warn('User already onboarded on accept', { correlationId });
          } else {
            throw err;
          }
        }

        logger.debug('Omiyage fulfilled', {
          correlationId,
          objectName: fulfilResult.object.object_name,
          userId: socket.userId
        });
        Counters.increment('socket_handler', 'omiyage_accept');

      } catch (err) {
        logger.error('Omiyage accept error', { correlationId, error: err.message });
        socket.emit('omiyage:error', { error: err.message });
      }
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  omiyage:decline Event                                              */
    /* ──────────────────────────────────────────────────────────────────── */

    socket.on('omiyage:decline', async (payload) => {
      const correlationId = randomUUID();
      logger.debug('Omiyage decline received', { correlationId, userId: socket.userId, payload });

      try {
        const { choiceId } = payload;

        if (!choiceId) {
          socket.emit('omiyage:error', { error: 'Missing choiceId' });
          return;
        }

        const narrative = await omiyageService.declineOmiyage(choiceId);

        socket.emit('omiyage:declined', { choiceId, narrative });

        try {
          await onboardingOrchestrator.transitionTo(
            socket.userId,
            'onboarded',
            { choice_id: choiceId, declined: true },
            'omiyage_declined'
          );
        } catch (err) {
          if (err.name === 'OptimisticLockError') {
            logger.warn('Concurrent completion on decline', { correlationId });
          } else if (err.name === 'InvalidTransitionError') {
            logger.warn('User already onboarded on decline', { correlationId });
          } else {
            throw err;
          }
        }

        logger.debug('Omiyage declined', { correlationId, choiceId, userId: socket.userId });
        Counters.increment('socket_handler', 'omiyage_decline');

      } catch (err) {
        logger.error('Omiyage decline error', { correlationId, error: err.message });
        socket.emit('omiyage:error', { error: err.message });
      }
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  omiyage:deferral Event                                             */
    /* ──────────────────────────────────────────────────────────────────── */

    socket.on('omiyage:deferral', async (payload) => {
      const correlationId = randomUUID();
      logger.debug('Omiyage deferral received', { correlationId, userId: socket.userId, payload });

      try {
        await onboardingOrchestrator.transitionTo(
          socket.userId,
          'onboarded',
          { deferred: true },
          'omiyage_deferred_skip_to_onboarded'
        );

        socket.emit('omiyage:deferred', { choiceId: payload.choiceId });

        logger.debug('Omiyage deferred', { correlationId, userId: socket.userId });
        Counters.increment('socket_handler', 'omiyage_defer');

      } catch (err) {
        if (err.name === 'OptimisticLockError') {
          logger.warn('Concurrent deferral', { correlationId });
        } else if (err.name === 'InvalidTransitionError') {
          logger.warn('User already onboarded on deferral', { correlationId });
        } else {
          logger.error('Omiyage deferral error', { correlationId, error: err.message });
        }
      }
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  TSE Learning Events                                                */
    /* ──────────────────────────────────────────────────────────────────── */

    const tseManager = getTSELoopManager();

    socket.on('tse:start', async (payload) => {
      const correlationId = randomUUID();
      logger.debug('TSE start received', { correlationId, userId: socket.userId, payload });

      try {
        if (!socket.ownedCharacterId) {
          socket.emit('tse:error', { error: 'No owned character found' });
          return;
        }

        const { domainId, query } = payload;
        if (!domainId) {
          socket.emit('tse:error', { error: 'domainId is required' });
          return;
        }

        socket.tseDeclinedThisSession = false;
        socket.tseResumeOffered = false;
        socket.awaitingSessions = null;

        const existingSession = await pool.query(
          "SELECT cycle_id FROM tse_cycles WHERE character_id = $1 AND status = 'running' LIMIT 1",
          [socket.ownedCharacterId]
        );
        if (existingSession.rows.length > 0) {
          logger.info('TSE returning existing active session', {
            correlationId,
            cycleId: existingSession.rows[0].cycle_id
          });
          socket.emit('tse:active', {
            cycleId: existingSession.rows[0].cycle_id,
            message: 'Session already active'
          });
          return;
        }

        const result = await tseManager.runOrContinueTseSession(
          socket.ownedCharacterId,
          query || null,
          null,
          null,
          { focusDomain: domainId, singleTurn: true }
        );

        socket._tseSessionId = result.session.id;
        await tseManager.saveSessionState(result.session);

        socket.emit('tse:task', {
          sessionId: result.session.id,
          task: result.task,
          evaluation: result.evaluation,
          completedTasks: result.session.completedTasks,
          status: 'awaiting_response'
        });

        logger.debug('TSE session started', { correlationId, sessionId: result.session.id });
        Counters.increment('socket_handler', 'tse_start');

      } catch (err) {
        logger.error('TSE start error', { correlationId, error: err.message });
        socket.emit('tse:error', { error: err.message });
      }
    });

    socket.on('tse:respond', async (payload) => {
      const correlationId = randomUUID();
      logger.debug('TSE respond received', { correlationId, userId: socket.userId, payload });

      try {
        const { sessionId, response } = payload;

        if (!socket.ownedCharacterId) {
          socket.emit('tse:error', { error: 'No owned character found' });
          return;
        }
        const activeSessionId = sessionId || socket._tseSessionId;

        if (!activeSessionId) {
          socket.emit('tse:error', { error: 'No active session' });
          return;
        }

        const savedSession = await tseManager.loadSessionState(activeSessionId);
        if (!savedSession) {
          socket.emit('tse:error', { error: 'Session not found' });
          return;
        }

        const result = await tseManager.runOrContinueTseSession(
          socket.ownedCharacterId,
          savedSession.query,
          response,
          null,
          { focusDomain: savedSession.domainId, singleTurn: true, existingSessionId: activeSessionId }
        );

        await tseManager.saveSessionState(result.session);

        socket.emit('tse:task', {
          sessionId: result.session.id,
          task: result.task,
          evaluation: result.evaluation,
          completedTasks: result.session.completedTasks,
          status: result.session.completedTasks >= 5 ? 'complete' : 'awaiting_response'
        });

        Counters.increment('socket_handler', 'tse_respond');

      } catch (err) {
        logger.error('TSE respond error', { correlationId, error: err.message });
        socket.emit('tse:error', { error: err.message });
      }
    });

    socket.on('tse:pause', async (payload) => {
      const correlationId = randomUUID();
      logger.debug('TSE pause received', { correlationId, userId: socket.userId });

      try {
        const sessionId = payload?.sessionId || socket._tseSessionId;
        if (!sessionId) {
          socket.emit('tse:error', { error: 'No active session to pause' });
          return;
        }

        const savedSession = await tseManager.loadSessionState(sessionId);
        if (savedSession) {
          savedSession.status = 'paused';
          await tseManager.saveSessionState(savedSession);
          socket.emit('tse:paused', { sessionId, status: 'paused' });
          logger.debug('TSE session paused', { correlationId, sessionId });
          Counters.increment('socket_handler', 'tse_pause');
        }

      } catch (err) {
        logger.error('TSE pause error', { correlationId, error: err.message });
        socket.emit('tse:error', { error: err.message });
      }
    });

    socket.on('tse:resume', async (payload) => {
      const correlationId = randomUUID();
      logger.debug('TSE resume received', { correlationId, userId: socket.userId, payload });

      try {
        const { sessionId } = payload;
        if (!sessionId) {
          socket.emit('tse:error', { error: 'sessionId required' });
          return;
        }

        const savedSession = await tseManager.loadSessionState(sessionId);
        if (!savedSession) {
          socket.emit('tse:error', { error: 'Session not found' });
          return;
        }

        socket._tseSessionId = sessionId;
        socket.emit('tse:resumed', {
          sessionId,
          completedTasks: savedSession.completedTasks,
          domainId: savedSession.domainId,
          status: savedSession.status
        });

        logger.debug('TSE session resumed', { correlationId, sessionId });
        Counters.increment('socket_handler', 'tse_resume');

      } catch (err) {
        logger.error('TSE resume error', { correlationId, error: err.message });
        socket.emit('tse:error', { error: err.message });
      }
    });

    socket.on('tse:summary', async () => {
      const correlationId = randomUUID();
      logger.debug('TSE summary requested', { correlationId, userId: socket.userId });

      try {
        if (!socket.ownedCharacterId) {
          socket.emit('tse:error', { error: 'No owned character found' });
          return;
        }

        const result = await tseManager.refreshLearningSummary(socket.userId, socket.ownedCharacterId);
        socket.emit('tse:summary-result', result);
        Counters.increment('socket_handler', 'tse_summary');

      } catch (err) {
        logger.error('TSE summary error', { correlationId, error: err.message });
        socket.emit('tse:error', { error: err.message });
      }
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  disconnect Event                                                   */
    /* ──────────────────────────────────────────────────────────────────── */

    socket.on('disconnect', () => {
      logger.info('Terminal disconnected', {
        username: socket.username,
        socketId: socket.id
      });
      Counters.increment('socket_handler', 'terminal_disconnect');

      const userKey = socket.authorityKey;
      if (boundUserSessions.has(userKey)) {
        boundUserSessions.delete(userKey);
        logger.debug('Removed user from boundUserSessions', { userId: userKey });
      }

      if (socket._omiyageTimer) {
        clearTimeout(socket._omiyageTimer);
      }

      if (socket._brollIdleTimer) {
        clearTimeout(socket._brollIdleTimer);
        socket._brollIdleTimer = null;
      }

      if (socket.userId) {
        flushUimsQueue(socket.userId);
      }

      if (socket.userId) {
        updateDossierSnapshot(socket.userId, socket.id, socket.beltLevels)
          .catch(err => logger.warn('Dossier snapshot on disconnect failed', {
            userId: socket.userId,
            error: err.message
          }));
      }
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  /ws/psychic-radar Namespace                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  const psychicRadarIo = io.of('/ws/psychic-radar');
  psychicRadarIo.on('connection', async (socket) => {
    logger.debug('Psychic radar connected', { socketId: socket.id });
    Counters.increment('socket_handler', 'radar_connect');

    const contacts = await getRadarContacts();
    socket.emit('contacts', { type: 'contacts', contacts });

    socket.on('request-update', async () => {
      const updatedContacts = await getRadarContacts();
      socket.emit('contacts', { type: 'contacts', contacts: updatedContacts });
    });

    socket.on('disconnect', () => {
      logger.debug('Psychic radar disconnected', { socketId: socket.id });
    });
  });

  return io;
}
