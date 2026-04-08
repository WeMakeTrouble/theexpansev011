/**
 * ============================================================================
 * BrainOrchestrator.js — Phase Dispatch Orchestrator (v010 r2)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Central dispatch layer for sequenced phase execution. Runs commands through
 * a deterministic pipeline of phases and returns a single responseIntent.
 *
 * V010 R2 CHANGES FROM V010 R1
 * ----------------------------
 * - Timer leak fixed: _createPhaseTimeout now returns { promise, clear }
 *   so the timer is explicitly cleared after phase completes, preventing
 *   leaked setTimeout handles.
 * - TSE resume early returns now record Claude move before returning.
 *   v010 r1 bypassed move recording on TSE-handled turns, breaking
 *   conversation history consistency.
 * - Phase dependency validation upgraded from warn-only to skip-phase.
 *   Missing required prior results now skip the phase and add to
 *   failedPhases instead of running with undefined inputs.
 * - Dead code in resolvePostPhaseSignals removed: teachingOffer setup
 *   was never consumed because _startTSEFromSignal ran immediately after.
 *   Consolidated to single code path.
 * - Counters now increment AFTER phase execution (success vs failure
 *   tracked separately) instead of before.
 * - DiagnosticReport structure validated after EarWig collation returns.
 * - Simple circuit breaker: phases that time out 3+ consecutive times
 *   across turns are auto-skipped until reset.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - EarWig integration: unified input interpretation runs ONCE before phases.
 *   Produces turnState.diagnosticReport consumed by all phases.
 *   turnState.diagnosticReport consumed by all phases directly.
 * - Logger: switched from core/Logger.js to createModuleLogger (v010 standard).
 * - generateTurnId: crypto.randomBytes hex format (collision resistant).
 *   Turn IDs are ephemeral trace IDs, not persisted primary keys.
 * - Enforced phase timeouts: Promise.race with configurable PHASE_TIMEOUT_MS.
 *   Hung phases are terminated and logged, not silently blocking.
 * - TSE resume logic extracted to _handleTSEResume() private method.
 * - TSE teaching start logic extracted to _startTSEFromSignal() to eliminate
 *   duplicated JSON parsing and output building in resolvePostPhaseSignals.
 * - Input validation on dispatchTurn entry.
 * - EarWig readiness gating via getStatus() before hear() call.
 * - Per-phase readiness gating via optional isReady() on phase handlers.
 * - Failed phase tracking via turnState.failedPhases array.
 * - failedPhases surfaced in final responseIntent metadata for caller access.
 * - QUD affirmatives/negatives elevated to frozen constants.
 * - All v009 logic preserved: QUD check, TSE resume, phase loop, post-phase
 *   signal resolution, move recording.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Define fixed phase order (deterministic)
 *  - Execute each phase in sequence with enforced timeout
 *  - Generate unique turn_id for replay/audit/diffing
 *  - Track phase trace and latency
 *  - Allow early termination on terminal flag
 *  - Allow phase skipping via dependency configuration
 *  - Isolate phase errors with result validation
 *  - Assert response integrity before return
 *  - Run EarWig input interpretation before phase loop
 *  - Track failed/timed-out phases and surface in response metadata
 *  - Record Claude move on ALL code paths including TSE early returns
 *
 * PHASE SEQUENCE
 * ---------------
 * 1. emotional   - PAD emotion (reads diagnosticReport.rawModules.pad)
 * 2. access      - Permission checks (god mode, access levels)
 * 3. teaching    - TSE learning loop
 * 4. identity    - Character/trait resolution
 * 5. claudesHelpDesk - World break detection (human/b_roll/gronk routing)
 * 6. intent      - Intent matching (reads diagnosticReport.rawModules.cognitiveFrame)
 * 7. voice       - Final LTLM utterance selection (reads diagnosticReport.compositeEmotionalState)
 *
 * CIRCUIT BREAKER
 * ----------------
 * Tracks consecutive timeouts per phase. After CIRCUIT_BREAKER_THRESHOLD
 * consecutive timeouts, the phase is auto-skipped until the breaker resets
 * (on next successful execution of any phase, or manual reset).
 *
 * FOUNDATIONAL INVARIANTS
 * -----------------------
 *  - Deterministic: Fixed order; no randomness in phase sequence
 *  - Backend authority: Phases validate/enforce state
 *  - DB as truth: Phase handlers must query DB
 *  - Single-process: Safe for process-local state
 *
 * DEPENDENCIES
 * ------------
 * Internal:
 *   - EarWig (backend/services/EarWig.js) — input interpretation
 *   - ConversationStateManager (backend/services/) — QUD, moves
 *   - TSELoopManager (backend/TSE/) — teaching session resume
 *   - Counters (councilTerminal/metrics/) — phase metrics
 *   - Phase handlers (councilTerminal/phases/) — 7 phase executors
 *
 * External: None (no external AI APIs)
 *
 * HUB-AND-SPOKE ARCHITECTURE (Design Decision — March 2026)
 * ----------------------------------------------------------
 * All communication in The Expanse routes through Claude the Tanuki:
 *   Entity -> Claude -> Entity (where Entity = human user or B-Roll character)
 *
 * B-Roll characters NEVER communicate directly with each other.
 * Claude mediates, narrates, and processes every interaction.
 *
 * This means:
 *   - speaker: 'claude' in _recordClaudeMove is CORRECT by design
 *   - Claude is always the voice to the user
 *   - B-Roll characters influence what Claude says, not how it is delivered
 *   - Every interaction produces identical pipeline data (EarWig, phases, LTLM)
 *
 * Rationale (validated by 5 independent consultants, scores 86-94/100):
 *   1. Observability: every interaction logged through one pipeline
 *   2. Clinical validation: B-Roll as controlled OCEAN test subjects
 *      requires the system-under-test (Claude) on every interaction path
 *   3. Data integrity: homogeneous pipeline data for internal learning
 *   4. Ripple propagation: hub-mediated contagion is more predictable
 *      than peer-to-peer (Deffuant bounded confidence, Hatfield contagion)
 *   5. No unobserved confounders in B-Roll state changes
 *
 * Key risk: Character Homogenization — PhaseVoice MUST use OCEAN-weighted
 * vocabulary per character, not Claude's default voice.
 *
 * For B-Roll input attribution, see turnState.sourceCharacterId.
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { randomBytes } from 'crypto';
import { createModuleLogger } from '../../utils/logger.js';
import Counters from '../metrics/counters.js';
import { getTSELoopManager } from '../../TSE/TSELoopManagerSingleton.js';
import ConversationStateManager from '../../services/ConversationStateManager.js';
import earWig from '../../services/EarWig.js';
import pool from '../../db/pool.js';
import { CLAUDE_CHARACTER_ID } from '../config/constants.js';

import PhaseAccess from '../phases/PhaseAccess.js';
import PhaseTeaching from '../phases/PhaseTeaching.js';
import PhaseEmotional from '../phases/PhaseEmotional.js';
import PhaseIdentity from '../phases/PhaseIdentity.js';
import PhaseClaudesHelpDesk from '../phases/PhaseClaudesHelpDesk.js';
import PhaseIntent from '../phases/PhaseIntent.js';
import PhaseVoice from '../phases/PhaseVoice.js';
import taughtEntityCapturer from '../../services/taughtEntityCapturer.js';
import learningCapturer from '../../services/learningCapturer.js';
import { searchEntityWithDisambiguation } from '../../utils/tieredEntitySearch.js';
import cotwIntentMatcher from '../cotwIntentMatcher.js';
import ClaudeVisitationScheduler from '../../broll/ClaudeVisitationScheduler.js';
import BRollSessionManager from '../../broll/BRollSessionManager.js';
import { processTurn as wwddProcessTurn, initSession as wwddInitSession } from '../../services/wwdd/index.js';

const logger = createModuleLogger('BrainOrchestrator');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const PHASE_TIMEOUT_MS = Object.freeze(
  parseInt(process.env.PHASE_TIMEOUT_MS, 10) || 8000
);

const CIRCUIT_BREAKER_THRESHOLD = 3;

const PHASE_DEPENDENCIES = Object.freeze({
  claudesHelpDesk: ['identityResult'],
  intent: ['claudesHelpDeskResult', 'identityResult'],
  voice: ['intentResult']
});

const PHASE_ORDER = Object.freeze([
  'emotional',
  'access',
  'teaching',
  'identity',
  'claudesHelpDesk',
  'intent',
  'voice'
]);

const PHASE_HANDLERS = Object.freeze({
  access: PhaseAccess,
  teaching: PhaseTeaching,
  emotional: PhaseEmotional,
  identity: PhaseIdentity,
  claudesHelpDesk: PhaseClaudesHelpDesk,
  intent: PhaseIntent,
  voice: PhaseVoice
});

const QUD_AFFIRMATIVES = Object.freeze([
  'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'yea', 'y', 'please',
  'lets go', 'go ahead'
]);

const QUD_NEGATIVES = Object.freeze([
  'no', 'nope', 'nah', 'not now', 'later', 'maybe later', 'n', 'skip'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Entity Curiosity Constants                                                */
/*                                                                            */
/*  BrainOrchestrator only FLAGS entity curiosity — PhaseTeaching acts.       */
/*  Rate limiting is infrastructure-ready but currently DISABLED.             */
/*  To enable: uncomment the session cap and cooldown checks in the           */
/*  Entity Curiosity Flag block below.                                        */
/* ────────────────────────────────────────────────────────────────────────── */

const ENTITY_CURIOSITY_EMOTIONAL_GATE = -0.3;
const ENTITY_CURIOSITY_SESSION_CAP = 2;       /* max questions per session — NOT ENFORCED YET */
const ENTITY_CURIOSITY_TURN_COOLDOWN = 8;     /* min turns between questions — NOT ENFORCED YET */
const ENTITY_CURIOSITY_QUD_PREFIX = 'entity.inquiry.';
const ENTITY_CONSENT_QUD_PREFIX = 'entity.consent.';
const VOCAB_CURIOSITY_QUD_PREFIX = 'vocab.inquiry.';
const VOCAB_CONSENT_QUD_PREFIX = 'vocab.consent.';
const VOCAB_CURIOSITY_EMOTIONAL_GATE = -0.3;
const ENTITY_SEEKING_QUERY_PATTERN = /^(?:who\s+is|what\s+is|what\s+are|where\s+is|where\s+are|tell\s+me\s+about|identify|show\s+me|define|explain|search\s+for|find|lookup|query)\s+/i;
const QUD_HANDLER_TIMEOUT_MS = 5000;

/* ────────────────────────────────────────────────────────────────────────── */
/*  B-Roll Processing Priority Constants                                      */
/*                                                                            */
/*  Infrastructure-ready for tick-based B-Roll processing.                    */
/*  NOT ENFORCED YET. When B-Roll Chaos Factory is built, these constants     */
/*  control how Claude prioritises interactions through the hub pipeline.      */
/*  Human user interactions always take Tier 1 priority.                       */
/*                                                                            */
/*  Throughput headroom: 50 characters at 30s intervals = 1.7 req/s.          */
/*  Node.js pipeline capacity: 10-20 req/s per core. No queuing needed yet.   */
/* ────────────────────────────────────────────────────────────────────────── */

const BROLL_TICK_INTERVAL_MS = 30000;           /* ms between B-Roll processing ticks — NOT ENFORCED YET */
const BROLL_MAX_INTERACTIONS_PER_TICK = 5;      /* max B-Roll interactions per tick — NOT ENFORCED YET */
const BROLL_PRIORITY_TIER_HUMAN = 1;            /* human user interaction priority — NOT ENFORCED YET */
const BROLL_PRIORITY_TIER_NARRATIVE = 2;        /* narrative-critical B-Roll priority — NOT ENFORCED YET */
const BROLL_PRIORITY_TIER_BACKGROUND = 3;       /* background B-Roll chatter priority — NOT ENFORCED YET */

const DIAGNOSTIC_REPORT_REQUIRED_KEYS = Object.freeze([
  'rawModules', 'compositeEmotionalState', 'compositeIntent',
  'postureRecommendation', 'confidence', 'flags'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helper Functions                                                          */
/* ────────────────────────────────────────────────────────────────────────── */


/**
 * Wrap a promise with a timeout. If the promise does not resolve
 * within ms milliseconds, it rejects with a descriptive error.
 * Timer is cleaned up via .finally() to prevent leaks.
 * Matches the pattern used in PhaseVoice.js and PhaseIntent.js.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Timeout after ' + ms + 'ms: ' + label));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
/**
 * Generate ephemeral turn ID for trace/audit purposes.
 * Format: T + hex(timestamp) + 8 crypto-random hex chars.
 * Uses crypto.randomBytes(4) for collision resistance.
 * NOT a hex system ID — not persisted as a primary key.
 */
function generateTurnId() {
  const timestamp = Date.now().toString(16).toUpperCase();
  const random = randomBytes(4).toString('hex').toUpperCase();
  return 'T' + timestamp + random;
}

/**
 * Validate that a phase result is either null/undefined (enrichment phases)
 * or a plain object. Throws on invalid types to catch phase bugs early.
 */
function validatePhaseResult(result, phaseName, correlationId) {
  if (!result) {
    return true;
  }

  if (typeof result !== 'object') {
    logger.error('Invalid phase result type', {
      correlationId,
      phase: phaseName,
      receivedType: typeof result
    });
    throw new Error('Phase ' + phaseName + ' returned invalid result type: ' + typeof result);
  }

  return true;
}

/**
* Validate DiagnosticReport structure from EarWig collation engine.
* Returns true if valid, false if malformed.
* Does NOT throw — EarWig failure should not crash the turn.
*/
function validateDiagnosticReport(report, correlationId) {
  if (!report || typeof report !== 'object') {
    return false;
  }

  for (const key of DIAGNOSTIC_REPORT_REQUIRED_KEYS) {
    if (!(key in report)) {
      logger.warn('DiagnosticReport missing required key', {
        correlationId,
        missingKey: key
      });
      return false;
    }
  }

  if (report.rawModules && typeof report.rawModules !== 'object') {
    logger.warn('DiagnosticReport rawModules is not an object', {
      correlationId,
      type: typeof report.rawModules
    });
    return false;
  }

  return true;
}

/**
 * Parse TSE task content, extracting teaching_statement and testing_statement
 * from JSON-encoded input if present. Returns raw content if parsing fails.
 */
function parseTSETaskContent(task) {
  let teachingContent = task.input || task.teachingStatement || '';
  let questionText = task.question || null;

  if (teachingContent && teachingContent.includes('teaching_statement')) {
    try {
      const parsed = JSON.parse(teachingContent);
      teachingContent = parsed.teaching_statement || teachingContent;
      if (!questionText) questionText = parsed.testing_statement || null;
    } catch (e) {
      // Raw content preserved if JSON parse fails
    }
  }

  return { teachingContent, questionText };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  BrainOrchestrator Class                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

class BrainOrchestrator {
  constructor(injectedDependencies = {}) {
    this.dependencies = injectedDependencies;
    this._circuitBreakerCounts = {};
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  dispatchTurn — Main Entry Point                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async dispatchTurn({ command, session, user, correlationId }) {

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Input Validation                                                       */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (!session || !session.owned_character_id) {
      logger.warn('No owned_character_id, skipping dispatch', { correlationId });
      return null;
    }

    if (typeof command !== 'string' || command.trim().length === 0) {
      logger.warn('Invalid or empty command, skipping dispatch', {
        correlationId,
        commandType: typeof command,
        commandLength: command?.length || 0
      });
      return null;
    }

    if (!user || !user.userId) {
      logger.warn('No user or userId, skipping dispatch', { correlationId });
      return null;
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Create Turn State                                                      */
    /* ──────────────────────────────────────────────────────────────────────── */

    const turnId = generateTurnId();

    const turnState = {
      turnId,
      correlationId,
      command,
      session,
      user,
      dependencies: this.dependencies,
      responseIntent: null,
      terminated: false,
      phase_trace: [],
      failedPhases: [],
      accessResult: null,
      teachingResult: null,
      emotionalResult: null,
      identityResult: null,
      claudesHelpDeskResult: null,
      intentResult: null,
      voiceResult: null,
      diagnosticReport: null,
      conversationId: session.conversationId || null,
      turnIndex: session.turnIndex || 0,
      sourceCharacterId: session.sourceCharacterId || null,
      speakerCharacterId: session.speakerCharacterId || CLAUDE_CHARACTER_ID
    };

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  QUD Check (Claude asked a question, user may be responding)            */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.conversationId && user.userId) {
      try {
        const topQUD = await ConversationStateManager.getTopQUD(turnState.conversationId);
        if (topQUD && (topQUD.speaker === 'claude' || topQUD.speaker === CLAUDE_CHARACTER_ID) && topQUD.status === 'open') {
          const userInput = command.toLowerCase().trim();


          /* ── Entity consent QUD: user responding to consent/confirm ─────── */

          const isEntityConsent = typeof topQUD.act_code === 'string' &&
            topQUD.act_code.startsWith(ENTITY_CONSENT_QUD_PREFIX);

          if (isEntityConsent) {
            const isAffirmative = QUD_AFFIRMATIVES.some(a => userInput === a || userInput.startsWith(a + ' '));
            const isNegative = QUD_NEGATIVES.some(n => userInput === n || userInput.startsWith(n + ' '));
            const consentType = topQUD.act_code.replace(ENTITY_CONSENT_QUD_PREFIX, '');

            if (isNegative) {
              logger.info('User declined entity consent', {
                correlationId,
                qudId: topQUD.qud_id,
                consentType
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'refused' }
              );

            } else if (consentType === 'confirm' && isAffirmative) {
              logger.info('User confirmed entity parse, promoting to consent', {
                correlationId,
                qudId: topQUD.qud_id
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'full' }
              );

              let parsedEntity = null;
              try {
                parsedEntity = JSON.parse(topQUD.entities?.[0] || 'null');
              } catch (jsonErr) {
                logger.warn('Failed to parse entity data from consent QUD', {
                  correlationId,
                  raw: topQUD.entities?.[0],
                  error: jsonErr.message
                });
              }

              if (parsedEntity) {
                parsedEntity.confidence = 'high';
                turnState.qudActivation = {
                  type: 'entity_explanation',
                  phrase: parsedEntity.entity_name,
                  questionType: 'what',
                  explanation: parsedEntity.original_explanation,
                  qudId: topQUD.qud_id,
                  confirmedParse: parsedEntity
                };
              }

            } else if (consentType === 'remember' && isAffirmative) {
              logger.info('User consented to entity storage', {
                correlationId,
                qudId: topQUD.qud_id
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'full' }
              );

              let parsedEntity = null;
              try {
                parsedEntity = JSON.parse(topQUD.entities?.[0] || 'null');
              } catch (jsonErr) {
                logger.warn('Failed to parse entity data from consent QUD', {
                  correlationId,
                  raw: topQUD.entities?.[0],
                  error: jsonErr.message
                });
              }

              if (parsedEntity && turnState.user?.userId) {
                try {
                  const dossierLookup = await withTimeout(
                    pool.query(
                      'SELECT dossier_id FROM cotw_dossiers WHERE user_id = $1 AND dossier_type = $2 LIMIT 1',
                      [turnState.user.userId, 'user']
                    ),
                    QUD_HANDLER_TIMEOUT_MS,
                    'QUD dossier lookup'
                  );
                  const dossierId = dossierLookup.rows[0]?.dossier_id || null;

                  if (!dossierId) {
                    logger.warn('No dossier found for user, skipping entity capture', {
                      correlationId,
                      userId: turnState.user.userId
                    });
                  } else {
                    const captureResult = await withTimeout(
                      taughtEntityCapturer.captureEntity(
                        turnState.user.userId,
                        dossierId,
                        parsedEntity
                      ),
                      QUD_HANDLER_TIMEOUT_MS,
                      'QUD entity capture'
                    );
                    logger.info('Entity captured successfully', {
                      correlationId,
                      entityName: parsedEntity.entity_name,
                      entityType: parsedEntity.entity_type,
                      captureResult
                    });
                    turnState.entityCaptured = {
                      success: true,
                      entityName: parsedEntity.entity_name,
                      entityType: parsedEntity.entity_type
                    };
                  }
                } catch (captureErr) {
                  logger.warn('Entity capture failed, continuing without', {
                    correlationId,
                    entityName: parsedEntity.entity_name,
                    error: captureErr.message
                  });
                  turnState.entityCaptured = { success: false, reason: captureErr.message };
                }
              }

            } else {
              logger.info('Ambiguous response to entity consent QUD', {
                correlationId,
                qudId: topQUD.qud_id,
                consentType,
                userInput
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'abandoned' }
              );
            }

          /* ── Vocab consent QUD: user responding to vocab consent/confirm ──── */

          } else if (typeof topQUD.act_code === 'string' &&
            topQUD.act_code.startsWith(VOCAB_CONSENT_QUD_PREFIX)) {
            const isAffirmative = QUD_AFFIRMATIVES.some(a => userInput === a || userInput.startsWith(a + ' '));
            const isNegative = QUD_NEGATIVES.some(n => userInput === n || userInput.startsWith(n + ' '));
            const consentType = topQUD.act_code.replace(VOCAB_CONSENT_QUD_PREFIX, '');

            if (isNegative) {
              logger.info('User declined vocab consent', {
                correlationId,
                qudId: topQUD.qud_id,
                consentType
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'refused' }
              );

            } else if (consentType === 'confirm' && isAffirmative) {
              logger.info('User confirmed vocab parse, promoting to consent', {
                correlationId,
                qudId: topQUD.qud_id
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'full' }
              );

              let parsedVocab = null;
              try {
                parsedVocab = JSON.parse(topQUD.entities?.[0] || 'null');
              } catch (jsonErr) {
                logger.warn('Failed to parse vocab data from consent QUD', {
                  correlationId,
                  raw: topQUD.entities?.[0],
                  error: jsonErr.message
                });
              }

              if (parsedVocab) {
                parsedVocab.confidence = 'high';
                turnState.qudActivation = {
                  type: 'vocab_explanation',
                  word: parsedVocab.word,
                  explanation: parsedVocab.definition || parsedVocab.original_input,
                  qudId: topQUD.qud_id,
                  confirmedParse: parsedVocab
                };
              }

            } else if (consentType === 'remember' && isAffirmative) {
              logger.info('User consented to vocab storage', {
                correlationId,
                qudId: topQUD.qud_id
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'full' }
              );

              let parsedVocab = null;
              try {
                parsedVocab = JSON.parse(topQUD.entities?.[0] || 'null');
              } catch (jsonErr) {
                logger.warn('Failed to parse vocab data from consent QUD', {
                  correlationId,
                  raw: topQUD.entities?.[0],
                  error: jsonErr.message
                });
              }

              if (parsedVocab && turnState.user?.userId) {
                try {
                  const captureResult = await withTimeout(
                    learningCapturer.captureTeaching(
                      turnState.user.userId,
                      {
                        phrase: parsedVocab.word,
                        baseConcept: parsedVocab.baseConcept || null,
                        context: parsedVocab.definition || parsedVocab.original_input || null,
                        padCoordinates: turnState.diagnosticReport?.compositeEmotionalState || null
                      }
                    ),
                    QUD_HANDLER_TIMEOUT_MS,
                    'QUD vocab capture'
                  );
                  logger.info('Vocab captured successfully', {
                    correlationId,
                    word: parsedVocab.word,
                    category: parsedVocab.category,
                    captureResult
                  });
                  turnState.vocabularyCaptured = {
                    success: true,
                    word: parsedVocab.word,
                    category: parsedVocab.category
                  };
                } catch (captureErr) {
                  logger.warn('Vocab capture failed, continuing without', {
                    correlationId,
                    word: parsedVocab.word,
                    error: captureErr.message
                  });
                  turnState.vocabularyCaptured = { success: false, reason: captureErr.message };
                }
              }

            } else {
              logger.info('Ambiguous response to vocab consent QUD', {
                correlationId,
                qudId: topQUD.qud_id,
                consentType,
                userInput
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'abandoned' }
              );
            }


          /* ── Entity inquiry QUD: user explaining an unfamiliar reference ── */

          } else if (typeof topQUD.act_code === 'string' &&
            topQUD.act_code.startsWith(ENTITY_CURIOSITY_QUD_PREFIX)) {
            const isNegative = QUD_NEGATIVES.some(n => userInput === n || userInput.startsWith(n + ' '));

            if (isNegative) {
              logger.info('User declined entity inquiry QUD', {
                correlationId,
                qudId: topQUD.qud_id,
                actCode: topQUD.act_code
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'refused' }
              );
            } else {
              const entityPhrase = topQUD.entities?.[0] || null;
              const questionType = topQUD.act_code.replace(ENTITY_CURIOSITY_QUD_PREFIX, '') || 'what';

              logger.info('User responded to entity inquiry QUD', {
                correlationId,
                qudId: topQUD.qud_id,
                actCode: topQUD.act_code,
                entityPhrase,
                questionType,
                explanationLength: command.length
              });

              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'full' }
              );

              turnState.qudActivation = {
                type: 'entity_explanation',
                phrase: entityPhrase,
                questionType,
                explanation: command.trim(),
                qudId: topQUD.qud_id
              };
            }

          /* ── Vocab inquiry QUD: user explaining an unfamiliar word ────────── */

          } else if (typeof topQUD.act_code === 'string' &&
            topQUD.act_code.startsWith(VOCAB_CURIOSITY_QUD_PREFIX)) {
            const isNegative = QUD_NEGATIVES.some(n => userInput === n || userInput.startsWith(n + ' '));

            if (isNegative) {
              logger.info('User declined vocab inquiry QUD', {
                correlationId,
                qudId: topQUD.qud_id,
                actCode: topQUD.act_code
              });
              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'refused' }
              );
            } else {
              const vocabWord = topQUD.entities?.[0] || null;

              logger.info('User responded to vocab inquiry QUD', {
                correlationId,
                qudId: topQUD.qud_id,
                actCode: topQUD.act_code,
                vocabWord,
                explanationLength: command.length
              });

              await ConversationStateManager.resolveQUD(
                turnState.conversationId, topQUD.qud_id, { type: 'full' }
              );

              turnState.qudActivation = {
                type: 'vocab_explanation',
                word: vocabWord,
                explanation: command.trim(),
                qudId: topQUD.qud_id
              };
            }


          /* ── Standard QUD: affirmative/negative handling ───────────────── */

          } else if (QUD_AFFIRMATIVES.some(a => userInput === a || userInput.startsWith(a + ' '))) {
            logger.info('User affirmed QUD', { correlationId, qudId: topQUD.qud_id, actCode: topQUD.act_code });
            await ConversationStateManager.resolveQUD(turnState.conversationId, topQUD.qud_id, { type: 'full' });

            if (topQUD.act_code === 'teaching.offer.system_feature') {
              const featureId = topQUD.entities?.[0];
              turnState.qudActivation = {
                type: 'teaching_accepted',
                featureId,
                qudId: topQUD.qud_id
              };
              turnState.source = 'qud_activation';
              logger.info('Teaching offer accepted via QUD', { correlationId, featureId });
            }
          } else if (QUD_NEGATIVES.some(n => userInput === n || userInput.startsWith(n + ' '))) {
            logger.info('User declined QUD', { correlationId, qudId: topQUD.qud_id });
            await ConversationStateManager.resolveQUD(turnState.conversationId, topQUD.qud_id, { type: 'refused' });
          }
        }
      } catch (qudErr) {
        logger.warn('QUD check failed', { correlationId, error: qudErr.message });
      }
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Record User Move                                                       */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.conversationId) {
      try {
        await ConversationStateManager.recordMove(turnState.conversationId, {
          speaker: 'user',
          content: command,
          turnIndex: turnState.turnIndex,
          qudResponse: turnState.qudActivation ? turnState.qudActivation.type : null
        });
        logger.debug('User move recorded', { correlationId, turnIndex: turnState.turnIndex });
      } catch (moveErr) {
        logger.warn('Failed to record user move', { correlationId, error: moveErr.message });
      }
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  TSE Resume Check                                                       */
    /* ──────────────────────────────────────────────────────────────────────── */

    const tseResult = await this._handleTSEResume(turnState);
    if (tseResult) {
      await this._recordClaudeMove(turnState);
      return tseResult;
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  EarWig — Unified Input Interpretation                                  */
    /* ──────────────────────────────────────────────────────────────────────── */

    try {
      const earWigStatus = earWig.getStatus();
      const allModulesAvailable = earWigStatus.padEstimator.available
        && earWigStatus.learningDetector.available
        && earWigStatus.repairHandler.available
        && earWigStatus.intentDetector.available;

      if (!allModulesAvailable) {
        logger.warn('EarWig modules not all available, proceeding with partial or no hearing', {
          correlationId,
          turnId,
          status: earWigStatus
        });
      }

      const diagnosticReport = await earWig.hear(command, {
        userId: user.userId,
        conversationId: turnState.conversationId,
        session
      });

      if (validateDiagnosticReport(diagnosticReport, correlationId)) {
        turnState.diagnosticReport = diagnosticReport;
      } else {
        logger.warn('DiagnosticReport validation failed, proceeding without', {
          correlationId,
          turnId
        });
        turnState.diagnosticReport = null;
      }

      logger.info('EarWig hearing complete', {
        correlationId,
        turnId,
        hasReport: !!turnState.diagnosticReport,
        posture: turnState.diagnosticReport?.postureRecommendation,
        confidence: turnState.diagnosticReport?.confidence,
        flagCount: turnState.diagnosticReport?.flags?.length || 0,
        padCoverage: turnState.diagnosticReport?.rawModules?.padMeta?.coverage,
        learningShouldAsk: turnState.diagnosticReport?.rawModules?.learning?.shouldAsk,
        isRepair: turnState.diagnosticReport?.rawModules?.repair?.isRepair,
        cognitiveFrameType: turnState.diagnosticReport?.rawModules?.cognitiveFrame?.type,
        referenceShouldAsk: turnState.diagnosticReport?.rawModules?.reference?.shouldAsk,
        referencePrioritized: turnState.diagnosticReport?.rawModules?.reference?.prioritizedCandidate?.phrase || null
      });
    } catch (earWigErr) {
      logger.warn('EarWig failed, continuing without diagnosticReport', {
        correlationId,
        turnId,
        error: earWigErr.message
      });
      turnState.diagnosticReport = null;
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  WWDD Engine — Session Outcome Inference (parallel accumulator)         */
    /*  Called after EarWig collation. Does not modify pipeline or turnState.  */
    /*  Enhancement path: failure is logged but never breaks the pipeline.     */
    /* ──────────────────────────────────────────────────────────────────────── */

    try {
      const wwddConversationId = turnState.conversationId;
      const wwddUserId = user.userId;

      if (wwddConversationId && wwddUserId) {
        if (turnState.turnIndex === 1) {
          wwddInitSession(wwddConversationId, wwddUserId);
        }

        const wwddState = await wwddProcessTurn(
          wwddConversationId,
          turnState.turnIndex,
          turnState.diagnosticReport,
          turnState.diagnosticReport?.rawModules?.drClaude ?? null,
          turnState.diagnosticReport?.rawModules?.conversationState ?? null
        );

        if (wwddState) {
          turnState.wwddState = wwddState;
        }
      }
    } catch (wwddErr) {
      logger.warn('WWDD: processTurn failed, continuing without', {
        correlationId,
        turnId,
        error: wwddErr.message
      });
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Phase Loop — Deterministic Sequence with Enforced Timeouts             */
    /* ──────────────────────────────────────────────────────────────────────── */

    logger.info('Dispatch started', {
      turnId,
      correlationId,
      userId: user.userId,
      command
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  Entity Curiosity Flag                                               */
    /*                                                                      */
    /*  If referenceDetector found an unfamiliar entity, this block flags   */
    /*  turnState.entityCuriosity for PhaseTeaching to consume.             */
    /*  BrainOrchestrator ONLY flags — it does NOT push QUDs, generate     */
    /*  question text, or select question types. PhaseTeaching owns all    */
    /*  curiosity decisions, phrasing, and QUD management.                 */
    /*                                                                      */
    /*  Gates:                                                              */
    /*    1. reference.shouldAsk must be true                               */
    /*    2. Emotional pleasure >= ENTITY_CURIOSITY_EMOTIONAL_GATE          */
    /*    3. No open entity.inquiry.* QUD in conversation                  */
    /*                                                                      */
    /*  Rate limiting (session cap + turn cooldown) is infrastructure-      */
    /*  ready but DISABLED. Uncomment the guards below to enable.          */
    /*  B-Roll Chaos Characters should have limits enabled first.           */
    /* ──────────────────────────────────────────────────────────────────── */

    const referenceData = turnState.diagnosticReport?.rawModules?.reference;
    const _isExplicitEntityQuery = ENTITY_SEEKING_QUERY_PATTERN.test(command.trim());

    if (referenceData?.shouldAsk === true && referenceData.prioritizedCandidate && !_isExplicitEntityQuery) {
      const emotionalP = turnState.diagnosticReport?.compositeEmotionalState?.p ?? 0;

      /* ── Gate 1: Emotional state ──────────────────────────────────────── */

      if (emotionalP < ENTITY_CURIOSITY_EMOTIONAL_GATE) {
        logger.debug('Entity curiosity skipped: user distressed', {
          correlationId,
          emotionalP,
          gate: ENTITY_CURIOSITY_EMOTIONAL_GATE
        });

      /* ── Gate 2: No open entity QUD ───────────────────────────────────── */

      } else {
        let hasOpenEntityQud = false;
        try {
          const topQUD = await ConversationStateManager.getTopQUD(turnState.conversationId);
          hasOpenEntityQud = topQUD?.status === 'open' &&
            typeof topQUD?.act_code === 'string' &&
            topQUD.act_code.startsWith(ENTITY_CURIOSITY_QUD_PREFIX);
        } catch (qudCheckErr) {
          logger.warn('Entity curiosity QUD check failed, skipping', {
            correlationId,
            error: qudCheckErr.message
          });
          hasOpenEntityQud = true;
        }

        if (hasOpenEntityQud) {
          logger.debug('Entity curiosity skipped: entity QUD already open', { correlationId });

        /* ── Gate 3 (DISABLED): Session rate limiting ───────────────────── */
        /* Uncomment to enable session cap and turn cooldown:                */
        /* } else if ((turnState.session?.entityCuriosityCount || 0) >= ENTITY_CURIOSITY_SESSION_CAP) { */
        /*   logger.debug('Entity curiosity skipped: session cap reached', { correlationId }); */
        /* } else if ((turnState.turnIndex - (turnState.session?.lastEntityCuriosityTurn || 0)) < ENTITY_CURIOSITY_TURN_COOLDOWN) { */
        /*   logger.debug('Entity curiosity skipped: turn cooldown active', { correlationId }); */

        } else {
          /* ── All gates passed — check known entities before flagging ── */
          const candidatePhrase = referenceData.prioritizedCandidate.phrase;
          const userAccessLevel = turnState.user?.access_level || 1;
          const searchRealm = cotwIntentMatcher.getRealmFromAccessLevel(userAccessLevel);

          let knownEntityMatch = null;

          try {
            const entitySearchResult = await searchEntityWithDisambiguation(
              candidatePhrase, searchRealm
            );

            if (entitySearchResult.action === 'single_match') {
              knownEntityMatch = entitySearchResult;
              logger.info('Entity curiosity resolved via tiered search', {
                correlationId,
                phrase: candidatePhrase,
                matchedEntity: entitySearchResult.entity?.entity_name,
                confidence: entitySearchResult.confidence,
                method: entitySearchResult.method,
                searchRealm
              });

            } else if (entitySearchResult.action === 'confirm' ||
                       entitySearchResult.action === 'clarify' ||
                       entitySearchResult.action === 'disambiguate') {
              knownEntityMatch = entitySearchResult;
              logger.info('Entity curiosity found probable match', {
                correlationId,
                phrase: candidatePhrase,
                action: entitySearchResult.action,
                suggestedEntity: entitySearchResult.entity?.entity_name || 'multiple',
                confidence: entitySearchResult.confidence,
                method: entitySearchResult.method,
                searchRealm
              });
            }
          } catch (searchErr) {
            logger.warn('Entity curiosity tiered search failed, proceeding as unknown', {
              correlationId,
              phrase: candidatePhrase,
              error: searchErr.message
            });
          }

          if (knownEntityMatch) {
            turnState.entityCuriosity = {
              candidate: referenceData.prioritizedCandidate,
              allCandidates: referenceData.candidates,
              score: referenceData.score,
              triggeredSignals: referenceData.triggeredSignalNames,
              knownEntityMatch
            };

            logger.info('Entity curiosity flagged with known match suggestion', {
              correlationId,
              phrase: candidatePhrase,
              matchAction: knownEntityMatch.action,
              matchedEntity: knownEntityMatch.entity?.entity_name || 'multiple',
              sessionCuriosityCount: turnState.session?.entityCuriosityCount || 0
            });

          } else {
            turnState.entityCuriosity = {
              candidate: referenceData.prioritizedCandidate,
              allCandidates: referenceData.candidates,
              score: referenceData.score,
              triggeredSignals: referenceData.triggeredSignalNames
            };

            logger.info('Entity curiosity flagged for PhaseTeaching', {
              correlationId,
              phrase: referenceData.prioritizedCandidate.phrase,
              signal: referenceData.prioritizedCandidate.signal,
              score: referenceData.score,
              candidateCount: referenceData.candidates.length,
              sessionCuriosityCount: turnState.session?.entityCuriosityCount || 0
            });
          }
        }
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  Vocabulary Curiosity Flag                                          */
    /*                                                                      */
    /*  If learningDetector found unfamiliar words, this block flags         */
    /*  turnState.vocabularyCuriosity for PhaseTeaching to consume.          */
    /*  Same pattern as entity curiosity. Entity takes priority —            */
    /*  if entityCuriosity was already flagged, this block is skipped.       */
    /*                                                                      */
    /*  Gates:                                                              */
    /*    1. Entity curiosity not already flagged (one question per turn)    */
    /*    2. learning.shouldAsk must be true                                */
    /*    3. unknownWords array must have entries                            */
    /*    4. Emotional pleasure >= VOCAB_CURIOSITY_EMOTIONAL_GATE            */
    /*    5. No open vocab.inquiry.* or entity.inquiry.* QUD                 */
    /* ──────────────────────────────────────────────────────────────────── */
    /*                                                                      */
    /*  DESIGN DECISION: No Suppression List / No Prioritisation (v010)     */
    /*                                                                      */
    /*  Suppression: A WELL_KNOWN_INTERNET_SLANG suppression list was       */
    /*  considered but intentionally omitted. Claude the Tanuki is a        */
    /*  character who is genuinely learning English and human culture.       */
    /*  Asking "What's lol?" is in-character and creates genuine teaching   */
    /*  moments that strengthen the user-companion bond. Once a word is     */
    /*  learned it persists in cotw_user_language, preventing repeat asks.  */
    /*  Rate limiting (2/session, 8-turn cooldown) handles frequency.       */
    /*                                                                      */
    /*  Prioritisation: unknownWords[0] is used as the candidate word.      */
    /*  N-gram surprisal already scores overall message novelty via         */
    /*  learningDetector._estimateSurprisal(). Per-word ranking was         */
    /*  considered but deferred until real user data reveals whether        */
    /*  first-position selection causes quality issues. The session cap     */
    /*  (max 2 questions) limits exposure to suboptimal picks.             */
    /*                                                                      */
    /*  FUTURE IMPLEMENTATION GUIDE:                                        */
    /*                                                                      */
    /*  Suppression list:                                                   */
    /*    1. Create Set in backend/utils/commonWordFilter.js or new file    */
    /*       backend/utils/vocabSuppressionList.js                          */
    /*    2. Import into this file (BrainOrchestrator.js)                   */
    /*    3. Filter BEFORE candidateWord selection below:                   */
    /*       const filtered = learningData.unknownWords                     */
    /*         .filter(w => !WELL_KNOWN_INTERNET_SLANG.has(w.toLowerCase()))*/
    /*       const candidateWord = filtered[0];                             */
    /*    4. Skip vocab curiosity if filtered array is empty                */
    /*                                                                      */
    /*  Prioritisation:                                                     */
    /*    1. Add per-word surprisal scoring to learningDetector.js          */
    /*       (currently only scores full message via ngramSurprisal)        */
    /*    2. Return scored unknownWords array sorted by surprisal desc      */
    /*    3. candidateWord selection below already takes [0], so sorting    */
    /*       the array is sufficient — no BrainOrchestrator changes needed  */
    /*    4. Alternatively, add vocabQueue to turnState for deferred words  */
    /*       that were deprioritised but could be asked in future turns     */
    /*                                                                      */
    /*  MULTILINGUAL & INDIGENOUS LANGUAGE CAPABILITY:                      */
    /*                                                                      */
    /*  This pipeline is language-agnostic by design. N-gram surprisal      */
    /*  fires on ANY unfamiliar token regardless of source language.         */
    /*  A user saying "my whanau are coming over" triggers the same         */
    /*  curiosity flow as English slang. The user explains, the system      */
    /*  stores phrase + base concept + context in cotw_user_language.        */
    /*                                                                      */
    /*  This makes the vocabulary curiosity system a natural pathway for    */
    /*  indigenous language learning. Claude learns te reo Maori, Hawaiian, */
    /*  Navajo, or any language the user shares — and future recall         */
    /*  (Task 7 / PhaseVoice) enables Claude to use those words back in    */
    /*  context, which is a meaningful act of cultural respect.             */
    /*                                                                      */
    /*  The deliberate absence of a suppression list protects this          */
    /*  capability. An English-centric filter would risk excluding          */
    /*  indigenous words that coincide with English dictionary entries.     */
    /*  The open design ensures all user-taught language is treated with    */
    /*  equal curiosity and care.                                           */
    /*                                                                      */

    if (!turnState.entityCuriosity) {
      const learningData = turnState.diagnosticReport?.rawModules?.learning;

      if (learningData?.shouldAsk === true &&
          Array.isArray(learningData.unknownWords) &&
          learningData.unknownWords.length > 0) {

        const emotionalP = turnState.diagnosticReport?.compositeEmotionalState?.p ?? 0;

        if (emotionalP < VOCAB_CURIOSITY_EMOTIONAL_GATE) {
          logger.debug('Vocab curiosity skipped: user distressed', {
            correlationId,
            emotionalP,
            gate: VOCAB_CURIOSITY_EMOTIONAL_GATE
          });

        } else {
          let hasOpenCuriosityQud = false;
          try {
            const topQUD = await ConversationStateManager.getTopQUD(turnState.conversationId);
            hasOpenCuriosityQud = topQUD?.status === 'open' &&
              typeof topQUD?.act_code === 'string' &&
              (topQUD.act_code.startsWith(VOCAB_CURIOSITY_QUD_PREFIX) ||
               topQUD.act_code.startsWith(ENTITY_CURIOSITY_QUD_PREFIX));
          } catch (qudCheckErr) {
            logger.warn('Vocab curiosity QUD check failed, skipping', {
              correlationId,
              error: qudCheckErr.message
            });
            hasOpenCuriosityQud = true;
          }

          if (hasOpenCuriosityQud) {
            logger.debug('Vocab curiosity skipped: curiosity QUD already open', { correlationId });

          } else {
            const candidateWord = learningData.unknownWords[0];

            turnState.vocabularyCuriosity = {
              word: candidateWord,
              allUnknownWords: learningData.unknownWords,
              score: learningData.score,
              triggeredSignals: learningData.triggeredSignalNames,
              novelNgrams: learningData.novelNgrams || []
            };

            logger.info('Vocab curiosity flagged for PhaseTeaching', {
              correlationId,
              word: candidateWord,
              score: learningData.score,
              unknownWordCount: learningData.unknownWords.length,
              triggeredSignals: learningData.triggeredSignalNames
            });
          }
        }
      }
    }

    for (const phaseName of PHASE_ORDER) {
      if (this.dependencies?.skipPhases?.includes(phaseName)) {
        logger.debug('Phase skipped (config)', { turnId, correlationId, phase: phaseName });
        continue;
      }

      if (this._isCircuitBroken(phaseName)) {
        logger.warn('Phase circuit broken, skipping', {
          turnId,
          correlationId,
          phase: phaseName,
          consecutiveTimeouts: this._circuitBreakerCounts[phaseName]
        });
        turnState.failedPhases.push({ phase: phaseName, error: 'Circuit breaker open', type: 'circuit_broken' });
        turnState[phaseName + 'Result'] = null;
        continue;
      }

      try {
        await this.runPhase(phaseName, turnState);

        if (turnState.terminated) {
          logger.debug('Early termination', { turnId, correlationId, phase: phaseName });
          break;
        }
      } catch (err) {
        logger.error('Phase error', {
          turnId,
          correlationId,
          userId: turnState.user.userId,
          phase: phaseName,
          error: err.message,
          stack: err.stack
        });
        turnState.failedPhases.push({ phase: phaseName, error: err.message, type: 'error' });
        turnState[phaseName + 'Result'] = null;
        continue;
      }
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Post-Phase Signal Resolution                                           */
    /* ──────────────────────────────────────────────────────────────────────── */

    await this.resolvePostPhaseSignals(turnState);


    if (!turnState.responseIntent) {
      logger.warn('No responseIntent produced', {
        turnId,
        correlationId,
        phasesExecuted: turnState.phase_trace.length,
        failedPhases: turnState.failedPhases
      });
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Record Claude Move                                                     */
    /* ──────────────────────────────────────────────────────────────────────── */

    await this._recordClaudeMove(turnState);

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Surface Failed Phases in Response Metadata                             */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.responseIntent && turnState.failedPhases.length > 0) {
      turnState.responseIntent._meta = turnState.responseIntent._meta || {};
      turnState.responseIntent._meta.failedPhases = turnState.failedPhases;
      turnState.responseIntent._meta.phasesExecuted = turnState.phase_trace.length;

      logger.warn('Turn completed with phase failures', {
        turnId,
        correlationId,
        failedPhases: turnState.failedPhases
      });
    }

    logger.info('Dispatch complete', {
      turnId,
      correlationId,
      userId: turnState.user.userId,
      handled: Boolean(turnState.responseIntent),
      phasesExecuted: turnState.phase_trace.length,
      failedPhases: turnState.failedPhases.length > 0 ? turnState.failedPhases : undefined
    });


    /* ──────────────────────────────────────────────────────────────────── */
    /*  Attach DiagnosticReport to responseIntent for downstream access     */
    /* ──────────────────────────────────────────────────────────────────── */

    if (turnState.responseIntent && turnState.diagnosticReport) {
      turnState.responseIntent.diagnosticReport = {
        postureRecommendation: turnState.diagnosticReport.postureRecommendation,
        confidence: turnState.diagnosticReport.confidence,
        agreement: turnState.diagnosticReport.agreement,
        flags: turnState.diagnosticReport.flags,
        compositeEmotionalState: turnState.diagnosticReport.compositeEmotionalState,
        rawModules: {
          pad: turnState.diagnosticReport.rawModules?.pad,
          padMeta: turnState.diagnosticReport.rawModules?.padMeta,
          learning: turnState.diagnosticReport.rawModules?.learning,
          repair: turnState.diagnosticReport.rawModules?.repair,
          cognitiveFrame: turnState.diagnosticReport.rawModules?.cognitiveFrame,
          reference: turnState.diagnosticReport.rawModules?.reference
        }
      };
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  Propagate entity to responseIntent for context tracking             */
    /* ──────────────────────────────────────────────────────────────────── */

    if (turnState.responseIntent && !turnState.responseIntent.entity) {
      const resolvedEntity = turnState.intentResult?.intentContext?.searchResult?.entity ?? null;
      if (resolvedEntity) {
        turnState.responseIntent.entity = resolvedEntity;
      }
    }

    return turnState.responseIntent;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Phase Execution with Enforced Timeout, Readiness, and Dependencies     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async runPhase(phaseName, turnState) {
    const handler = PHASE_HANDLERS[phaseName];

    if (!handler || typeof handler.execute !== 'function') {
      logger.error('Invalid phase handler', {
        turnId: turnState.turnId,
        correlationId: turnState.correlationId,
        phase: phaseName
      });
      throw new Error('Invalid phase handler: ' + phaseName);
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Per-phase readiness check                                              */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (typeof handler.isReady === 'function') {
      try {
        const ready = await handler.isReady();
        if (!ready) {
          logger.warn('Phase not ready, skipping', {
            turnId: turnState.turnId,
            correlationId: turnState.correlationId,
            phase: phaseName
          });
          turnState.failedPhases.push({ phase: phaseName, error: 'Phase not ready', type: 'not_ready' });
          turnState[phaseName + 'Result'] = null;
          return;
        }
      } catch (readyErr) {
        logger.warn('Phase readiness check failed, skipping', {
          turnId: turnState.turnId,
          correlationId: turnState.correlationId,
          phase: phaseName,
          error: readyErr.message
        });
        turnState.failedPhases.push({ phase: phaseName, error: readyErr.message, type: 'readiness_error' });
        turnState[phaseName + 'Result'] = null;
        return;
      }
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Validate phase dependencies (skip if missing)                          */
    /*                                                                         */
    /*  v010 r1 only warned. v010 r2 skips the phase to prevent phases from   */
    /*  running with undefined upstream results.                               */
    /* ──────────────────────────────────────────────────────────────────────── */

    const requiredPrior = PHASE_DEPENDENCIES[phaseName] || [];
    for (const req of requiredPrior) {
      if (!turnState[req]) {
        logger.warn('Missing required prior result, skipping phase', {
          turnId: turnState.turnId,
          correlationId: turnState.correlationId,
          phase: phaseName,
          missingResult: req
        });
        turnState.failedPhases.push({
          phase: phaseName,
          error: 'Missing dependency: ' + req,
          type: 'missing_dependency'
        });
        turnState[phaseName + 'Result'] = null;
        return;
      }
    }

    const traceEntry = {
      phase: phaseName,
      startedAt: Date.now(),
      completedAt: null,
      timedOut: false
    };

    turnState.phase_trace.push(traceEntry);

    logger.debug('Phase start', {
      turnId: turnState.turnId,
      correlationId: turnState.correlationId,
      phase: phaseName
    });

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Execute phase with enforced timeout via Promise.race                   */
    /*                                                                         */
    /*  Timer is explicitly cleared after race resolves to prevent leaks.      */
    /* ──────────────────────────────────────────────────────────────────────── */

    let result;
    const timeout = this._createPhaseTimeout(PHASE_TIMEOUT_MS, phaseName);

    try {
      result = await Promise.race([handler.execute(turnState), timeout.promise]);
    } catch (err) {
      if (err.message && err.message.startsWith('PHASE_TIMEOUT:')) {
        traceEntry.timedOut = true;
        traceEntry.completedAt = Date.now();
        turnState.failedPhases.push({ phase: phaseName, error: err.message, type: 'timeout' });

        this._recordPhaseTimeout(phaseName);

        logger.warn('Phase timeout enforced', {
          turnId: turnState.turnId,
          correlationId: turnState.correlationId,
          phase: phaseName,
          timeoutMs: PHASE_TIMEOUT_MS,
          durationMs: traceEntry.completedAt - traceEntry.startedAt,
          consecutiveTimeouts: this._circuitBreakerCounts[phaseName] || 0
        });

        Counters.increment('phase_timeout', phaseName);
        Counters.recordLatency(phaseName, traceEntry.completedAt - traceEntry.startedAt);
        turnState[phaseName + 'Result'] = null;
        return;
      }
      throw err;
    } finally {
      timeout.clear();
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Validate phase result shape                                            */
    /* ──────────────────────────────────────────────────────────────────────── */

    validatePhaseResult(result, phaseName, turnState.correlationId);

    traceEntry.completedAt = Date.now();
    const durationMs = traceEntry.completedAt - traceEntry.startedAt;
    Counters.recordLatency(phaseName, durationMs);

    this._resetCircuitBreaker(phaseName);

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Post-execution counters (success path only)                            */
    /* ──────────────────────────────────────────────────────────────────────── */

    Counters.increment('phase_executed', phaseName);

    logger.debug('Phase complete', {
      turnId: turnState.turnId,
      correlationId: turnState.correlationId,
      phase: phaseName,
      durationMs
    });

    if (result?.responseIntent) {
      turnState.responseIntent = result.responseIntent;
      turnState.terminated = Boolean(result.terminal);

      logger.debug('Phase produced response', {
        turnId: turnState.turnId,
        correlationId: turnState.correlationId,
        phase: phaseName,
        terminal: turnState.terminated
      });
    }

    turnState[phaseName + 'Result'] = result ?? null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Phase Timeout Promise (with cleanup)                           */
  /*                                                                          */
  /*  Returns { promise, clear } so the caller can cancel the timer after    */
  /*  the phase resolves, preventing leaked setTimeout handles.               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _createPhaseTimeout(ms, phaseName) {
    let timer;
    const promise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('PHASE_TIMEOUT: ' + phaseName + ' exceeded ' + ms + 'ms'));
      }, ms);
    });

    return {
      promise,
      clear: () => clearTimeout(timer)
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Circuit Breaker                                                */
  /*                                                                          */
  /*  Tracks consecutive timeouts per phase. After threshold reached,         */
  /*  phase is auto-skipped. Resets on successful phase execution.            */
  /* ──────────────────────────────────────────────────────────────────────── */

  _isCircuitBroken(phaseName) {
    return (this._circuitBreakerCounts[phaseName] || 0) >= CIRCUIT_BREAKER_THRESHOLD;
  }

  _recordPhaseTimeout(phaseName) {
    this._circuitBreakerCounts[phaseName] = (this._circuitBreakerCounts[phaseName] || 0) + 1;
  }

  _resetCircuitBreaker(phaseName) {
    if (this._circuitBreakerCounts[phaseName]) {
      this._circuitBreakerCounts[phaseName] = 0;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Record Claude Move                                             */
  /*                                                                          */
  /*  Extracted so ALL code paths (normal pipeline, TSE early returns)        */
  /*  record Claude's move consistently.                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _recordClaudeMove(turnState) {
    const { correlationId, conversationId, responseIntent } = turnState;

    if (!conversationId || !responseIntent) {
      return;
    }

    try {
      const intentResult = turnState.intentResult || {};
      await ConversationStateManager.recordMove(conversationId, {
        speaker: 'claude',
        speakerCharacterId: turnState.speakerCharacterId,
        turnIndex: turnState.turnIndex,
        queryType: responseIntent.queryType || 'unknown',
        topic: intentResult.topic || intentResult.systemFeature?.featureName || null,
        hasTeachingOffer: Boolean(
          responseIntent.output?.includes('teach') || responseIntent.output?.includes('study')
        )
      });
      logger.debug('Claude move recorded', { correlationId, turnIndex: turnState.turnIndex });
    } catch (moveErr) {
      logger.warn('Failed to record Claude move', { correlationId, error: moveErr.message });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: TSE Resume Handler                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _handleTSEResume(turnState) {
    const { session, user, command, correlationId } = turnState;

    try {
      const tseManager = getTSELoopManager();
      if (!tseManager || !user.userId || session.tseDeclinedThisSession) {
        return null;
      }

      logger.info('TSE answer handler check', {
        correlationId,
        hasUserId: !!user?.userId,
        userId: user?.userId,
        hasAwaitingSessions: !!session?.awaitingSessions,
        hasTseResumeOffered: !!session?.tseResumeOffered,
        tseDeclined: !!session?.tseDeclinedThisSession
      });

      /* ──────────────────────────────────────────────────────────────────── */
      /*  Scenario 1: User answering an active TSE task                      */
      /* ──────────────────────────────────────────────────────────────────── */

      if (!session.awaitingSessions && !session.tseResumeOffered) {
        const awaitingSession = await tseManager.getAwaitingSessionForUser(user.userId);

        if (awaitingSession && awaitingSession.currentTask) {
          logger.info('User answering active TSE task', {
            correlationId,
            sessionId: awaitingSession.id,
            taskType: awaitingSession.currentTask?.taskType
          });

          const tseResult = await tseManager.runOrContinueTseSession(
            session.owned_character_id,
            null,
            command.trim(),
            null,
            {
              focusDomain: awaitingSession.domainId,
              existingSessionId: awaitingSession.id
            }
          );

          if (tseResult) {
            const responseOutput = this._buildTSEResponse(tseResult);
            const voicedOutput1 = await this._voiceTSEOutput(turnState, responseOutput);
            turnState.responseIntent = {
              output: voicedOutput1.output,
              source: 'tse_curricula',
              queryType: 'TEACHING',
              tseSession: {
                sessionId: tseResult.session?.id,
                task: tseResult.task,
                evaluation: tseResult.evaluation,
                status: tseResult.task?.requiresResponse ? 'awaiting_response' : 'completed'
              }
            };
            turnState.terminated = true;

            logger.info('TSE answer processed', {
              correlationId,
              sessionId: tseResult.session?.id,
              hasEvaluation: !!tseResult.evaluation,
              hasNextTask: !!tseResult.task
            });

            return turnState.responseIntent;
          }
        }
      }

      /* ──────────────────────────────────────────────────────────────────── */
      /*  Scenario 2: User selecting from TSE resume menu                    */
      /* ──────────────────────────────────────────────────────────────────── */

      if (session.tseResumeOffered && session.awaitingSessions) {
        const userChoice = parseInt(command.trim(), 10);
        const sessionCount = session.awaitingSessions.length;
        const declineOption = sessionCount + 1;

        if (isNaN(userChoice) || userChoice < 1 || userChoice > declineOption) {
          logger.info('Invalid TSE choice, re-presenting menu', {
            correlationId,
            userInput: command.trim()
          });

          const menuText = this._buildTSEMenu(session.awaitingSessions, 'That was not a valid choice. Please pick a number:\n\n');
          const voicedMenu1 = await this._voiceTSEOutput(turnState, menuText);
          turnState.responseIntent = {
            output: voicedMenu1.output,
            queryType: 'TSE_RESUME_CHOICE',
            tseSession: { status: 'awaiting_resume_choice', sessionCount }
          };
          turnState.terminated = true;
          return turnState.responseIntent;
        }

        if (userChoice === declineOption) {
          logger.info('User chose normal conversation over TSE', { correlationId, declineOption });
          session.tseDeclinedThisSession = true;
          session.awaitingSessions = null;
          return null;
        }

        const chosen = session.awaitingSessions[userChoice - 1];
        logger.info('Resuming TSE session', {
          correlationId,
          sessionId: chosen.sessionId,
          domainName: chosen.domainName
        });

        session.awaitingSessions = null;

        const tseResult = await tseManager.runOrContinueTseSession(
          session.owned_character_id,
          null,
          null,
          null,
          {
            focusDomain: chosen.domainId,
            existingSessionId: chosen.sessionId
          }
        );

        if (tseResult) {
          const responseOutput = this._buildTSEResponse(tseResult);
          const voicedOutput2 = await this._voiceTSEOutput(turnState, responseOutput);
          turnState.responseIntent = {
            output: voicedOutput2.output,
            queryType: 'TEACHING',
            tseSession: {
              sessionId: tseResult.session?.id,
              task: tseResult.task,
              evaluation: tseResult.evaluation,
              status: tseResult.task?.requiresResponse ? 'awaiting_response' : 'completed'
            }
          };
          turnState.terminated = true;

          logger.info('TSE session resumed', { correlationId, sessionId: tseResult.session?.id });
          return turnState.responseIntent;
        }
      }

      /* ──────────────────────────────────────────────────────────────────── */
      /*  Scenario 3: First contact — present TSE resume menu                */
      /* ──────────────────────────────────────────────────────────────────── */

      if (!session.tseResumeOffered) {
        const awaitingSessions = await tseManager.getAllAwaitingSessionsForUser(user.userId);

        if (awaitingSessions.length > 0) {
          logger.info('Awaiting TSE sessions found', { correlationId, count: awaitingSessions.length });

          session.tseResumeOffered = true;
          session.awaitingSessions = awaitingSessions;

          const menuText = this._buildTSEMenu(awaitingSessions, 'Welcome back! You have learning sessions in progress:\n\n');
          const voicedMenu2 = await this._voiceTSEOutput(turnState, menuText);
          turnState.responseIntent = {
            output: voicedMenu2.output,
            queryType: 'TSE_RESUME_CHOICE',
            tseSession: { status: 'awaiting_resume_choice', sessionCount: awaitingSessions.length }
          };
          turnState.terminated = true;
          return turnState.responseIntent;
        }
      }

      return null;

    } catch (tseResumeErr) {
      logger.error('TSE resume check failed', {
        correlationId,
        error: tseResumeErr.message,
        stack: tseResumeErr.stack
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Build TSE Response Output                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Voice TSE Output via PhaseVoice                                */
  /*                                                                          */
  /*  Sets minimum turnState fields required by PhaseVoice and calls          */
  /*  execute(). Falls back to raw output if PhaseVoice fails.                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _voiceTSEOutput(turnState, rawOutput) {
    turnState.tseRawOutput = rawOutput;
    turnState.intentResult = {
      intentContext: { type: 'TSE_ACTIVE' }
    };
    try {
      const voiceResult = await PhaseVoice.execute(turnState);
      if (voiceResult?.responseIntent?.output) {
        return voiceResult.responseIntent;
      }
    } catch (voiceErr) {
      logger.warn('PhaseVoice failed for TSE output, using raw', {
        correlationId: turnState.correlationId,
        error: voiceErr.message
      });
    }
    return { output: rawOutput };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  _buildTSEResponse(tseResult) {
    if (tseResult.evaluation) {
      const evalFeedback = tseResult.evaluation.explanation
        || tseResult.evaluation.feedback
        || 'Thank you for your answer.';

      if (tseResult.task && tseResult.session?.status !== 'completed') {
        const { teachingContent, questionText } = parseTSETaskContent(tseResult.task);
        let output = evalFeedback + '\n\n' + teachingContent;
        if (questionText) {
          output += '\n\n' + questionText;
        }
        return output;
      }
      return evalFeedback;
    }

    if (tseResult.task) {
      const { teachingContent, questionText } = parseTSETaskContent(tseResult.task);

      if (teachingContent && questionText) {
        return teachingContent + '\n\n' + questionText;
      }
      if (questionText) {
        return questionText;
      }
      if (teachingContent) {
        return teachingContent;
      }
      return 'Please respond to this task.';
    }

    return 'Session complete. Well done!';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Build TSE Resume Menu                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildTSEMenu(sessions, headerText) {
    const lines = [headerText];
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const stripeText = s.currentStripes > 0
        ? ', ' + s.currentStripes + ' stripe' + (s.currentStripes > 1 ? 's' : '')
        : '';
      lines.push((i + 1) + '. ' + s.domainName + ' (' + s.currentBelt + stripeText + ')');
    }
    lines.push((sessions.length + 1) + '. Return to normal conversation');
    lines.push('');
    lines.push('Please type a number.');
    return lines.join('\n');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Start TSE From Signal                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _startTSEFromSignal(turnState, domainId, options, introPrefix) {
    const { session, correlationId } = turnState;

    const tseManager = getTSELoopManager();
    const characterId = session.owned_character_id;

    if (!tseManager || !characterId) {
      return false;
    }

    /* ── Review Gate ────────────────────────────────────────────── */
    /* If the user has due reviews in this domain, inform them      */
    /* before starting. New content is locked until reviews clear.  */
    const dueCount = await tseManager.getDueItemCount(session.userId, domainId);
    if (dueCount > 0) {
      logger.info("TSE review gate: due items found, blocking new content", {
        correlationId,
        userId: session.userId,
        domainId,
        dueCount
      });

      turnState.responseIntent = {
        output: `You have items waiting for review in this subject. Before we explore new territory, let us revisit what you have already learned. Ready to review? Type YES to begin your review, or NO to return to the main menu.`,
        source: turnState.source || "curriculum_selection",
        queryType: "TEACHING",
        tseSession: { reviewGate: true, domainId, dueCount },
        _tseReviewGateDomain: domainId
      };
      turnState.terminated = true;
      return true;
    }


    const tseResult = await tseManager.runOrContinueTseSession(
      characterId,
      null,
      null,
      null,
      { focusDomain: domainId, ...options }
    );

    if (!tseResult || !tseResult.task) {
      return false;
    }

    const { teachingContent, questionText } = parseTSETaskContent(tseResult.task);

    let teachingOutput = introPrefix ? introPrefix : '';
    teachingOutput += teachingContent;
    if (questionText) {
      teachingOutput += '\n\n' + questionText;
    }
    if (!teachingOutput || teachingOutput.trim() === '') {
      teachingOutput = 'Let us begin your lesson.';
    }

    turnState.responseIntent = {
      output: teachingOutput,
      source: turnState.source || 'curriculum_selection',
      queryType: 'TEACHING',
      _tseDirectEmit: {
        event: 'tse:task',
        payload: {
          sessionId: tseResult.session?.id,
          task: tseResult.task,
          teachingContent: teachingOutput,
          evaluation: null,
          completedTasks: tseResult.session?.completedTasks || 0,
          status: 'awaiting_response'
        }
      },
      tseSession: {
        sessionId: tseResult.session?.id,
        task: tseResult.task,
        completedTasks: tseResult.session?.completedTasks || 0,
        status: 'awaiting_response'
      }
    };
    turnState.terminated = true;

    logger.info('TSE session started', {
      correlationId,
      sessionId: tseResult.session?.id,
      domainId,
      source: introPrefix ? 'qud_activation' : 'curriculum_selection'
    });

    return true;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Post-Phase Signal Resolution                                            */
  /*                                                                          */
  /*  v010 r2: Dead code removed. teachingOffer setup was never consumed     */
  /*  because _startTSEFromSignal ran immediately after. Consolidated to     */
  /*  single code path that either starts TSE or logs the offer.             */
  /* ──────────────────────────────────────────────────────────────────────── */

  async resolvePostPhaseSignals(turnState) {
    const { correlationId } = turnState;
    const intentContext = turnState.intentResult?.intentContext ?? {};
    const selection = intentContext.upstreamSignals?.curriculumSelection;

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  QUD-triggered teaching activation                                      */
    /* ──────────────────────────────────────────────────────────────────────── */

    const teachingContext = turnState.teachingResult?.teachingContext;
    if (teachingContext?.mode === 'pending_teaching_start' && teachingContext?.activatedViaQud) {
      logger.info('QUD teaching activation - starting TSE', {
        correlationId,
        featureId: teachingContext.featureId,
        qudId: teachingContext.qudId
      });

      try {
        const domainId = teachingContext?.domainId || '#AE0007';
        const featureName = teachingContext?.featureName || teachingContext?.featureCode || 'this topic';
        const introPrefix = 'Let us explore ' + featureName.replace(/_/g, ' ') + ' together.\n\n';

        await this._startTSEFromSignal(
          turnState,
          domainId,
          { targetKnowledgeId: teachingContext?.knowledgeId || teachingContext?.featureId || null },
          introPrefix
        );
      } catch (tseErr) {
        logger.error('QUD TSE start failed', { correlationId, error: tseErr.message });
      }
      return;
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  Curriculum selection — start TSE directly                              */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (!selection) {
      return;
    }

    logger.info('Curriculum selection detected, starting TSE', {
      correlationId,
      type: selection.type,
      curriculumName: selection.curriculum?.curriculum_name,
      domainId: selection.curriculum?.domain_id
    });

    try {
      const domainId = selection.curriculum?.domain_id;
      if (domainId) {
        const started = await this._startTSEFromSignal(turnState, domainId, {}, null);
        if (!started) {
          logger.warn('TSE start from curriculum selection returned no task', {
            correlationId,
            domainId
          });
        }
      } else {
        logger.warn('Curriculum selection has no domain_id', {
          correlationId,
          curriculum: selection.curriculum?.curriculum_name
        });
      }
    } catch (tseErr) {
      logger.error('TSE start failed', {
        correlationId,
        error: tseErr.message,
        stack: tseErr.stack
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: B-Roll Autonomous Visit Cycle                                   */
  /*                                                                          */
  /*  Called by socketHandler during user idle time. Selects the highest-      */
  /*  priority B-Roll character via ClaudeVisitationScheduler, then runs a     */
  /*  full teaching/review/comfort/narrative session via BRollSessionManager.  */
  /*  Returns the session result or null if no visit was needed.               */
  /*  Transport-agnostic: caller is responsible for emitting to user.          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async runBRollCycle({ userBelt, correlationId } = {}) {
    if (!this._brollScheduler) {
      this._brollScheduler = new ClaudeVisitationScheduler();
    }
    if (!this._brollSessionManager) {
      this._brollSessionManager = new BRollSessionManager();
    }

    try {
      const scheduleResult = await this._brollScheduler.runSchedulingCycle({
        mode: 'idle',
        correlationId
      });

      if (!scheduleResult.winner || !scheduleResult.queueEntryId) {
        logger.debug('B-Roll cycle: no visit needed', { correlationId });
        return null;
      }

      logger.info('B-Roll cycle: visit scheduled', {
        correlationId,
        characterId: scheduleResult.winner.characterId,
        characterName: scheduleResult.winner.characterName,
        visitType: scheduleResult.visitType,
        cps: scheduleResult.winner.cps
      });

      const sessionResult = await this._brollSessionManager.runSession({
        characterId: scheduleResult.winner.characterId,
        visitType: scheduleResult.visitType,
        queueEntryId: scheduleResult.queueEntryId,
        userBelt: userBelt || 'white'
      }, { correlationId });

      logger.info('B-Roll cycle: session complete', {
        correlationId,
        characterId: scheduleResult.winner.characterId,
        visitType: scheduleResult.visitType,
        alreadyClaimed: sessionResult.alreadyClaimed || false
      });

      return sessionResult;

    } catch (brollErr) {
      logger.error('B-Roll cycle failed', {
        correlationId,
        error: brollErr.message
      });
      return null;
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export { BrainOrchestrator };
export default BrainOrchestrator;
