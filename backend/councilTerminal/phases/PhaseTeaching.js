/**
 * ============================================================================
 * PhaseTeaching.js — Teaching State Routing (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Phase 3 in the brain pipeline. Detects current teaching state and exposes
 * minimal teachingContext for downstream phases. Also handles entity curiosity
 * when BrainOrchestrator flags an unfamiliar reference — generates an
 * in-character question, pushes a QUD, and terminates the turn.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - REMOVED dead UserTeachingService dependency. The service was archived on
 *   2026-02-02 and never injected by BrainOrchestrator. The "active lesson
 *   detection" via TeachingService was dead code. Active teaching sessions
 *   are handled by BrainOrchestrator's TSE resume logic (lines 256-501)
 *   BEFORE the phase loop starts — PhaseTeaching never sees them.
 * - Removed dependencies destructuring from turnState (not needed).
 * - Logger switched to createModuleLogger (v010 standard).
 * - QUD-triggered teaching activation preserved exactly (works correctly).
 * - Pending curriculum choice preserved exactly (works correctly).
 * - Idle fallback preserved exactly.
 * - Added input validation on featureId format.
 * - Added query timing to DB call logging.
 * - Added entity curiosity handler with rate limiting, template rotation,
 *   QUD idempotency guard, and A/B testing metadata.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Detect entity curiosity flag, enforce rate limits, generate question,
 *    push QUD, terminate turn (Section 0)
 *  - Detect QUD-triggered teaching activation (user accepted teach offer)
 *  - Check pending curriculum choice (context flag)
 *  - Return idle/default if no activity
 *  - Expose teachingContext for downstream phases
 *
 * NON-GOALS
 * ---------
 *  - No intent interpretation
 *  - No response generation (except entity curiosity questions)
 *  - No session mutation (except entity curiosity counters on turnState.session)
 *  - No active lesson detection (handled by BrainOrchestrator TSE resume)
 *
 * INVARIANTS
 * ----------
 *  - Returns safe defaults on missing inputs
 *  - Returns terminal: true ONLY for entity curiosity questions
 *  - All other paths remain enrichment only (no terminal)
 *  - Rate limiting enforced: max 2 curiosity questions per session,
 *    min 8-turn gap between questions
 *
 * DEPENDENCIES
 * ------------
 * Internal:
 *   - pool (PostgreSQL) for feature-to-knowledge resolution
 *   - ConversationStateManager for QUD push and idempotency check
 *   - turnState.qudActivation (set by BrainOrchestrator QUD check)
 *   - turnState.entityCuriosity (set by BrainOrchestrator entity curiosity gate)
 *   - turnState.session (entity curiosity counters)
 *   - session.context.pendingCurriculumChoice
 *
 * External: None
 *
 * NAMING CONVENTIONS
 * ------------------
 * Handler: PhaseTeaching (PascalCase object with execute method)
 * Constants: TEACHING_MODES, ENTITY_CURIOSITY_* (UPPER_SNAKE_CASE, frozen)
 * Logger: createModuleLogger('PhaseTeaching')
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';
import pool from '../../db/pool.js';
import ConversationStateManager from '../../services/ConversationStateManager.js';
import parseExplanation, { requiresConfirmation } from '../../services/entityExplanationParser.js';
import parseVocabExplanation, { requiresConfirmation as vocabRequiresConfirmation } from '../../services/vocabExplanationParser.js';

const logger = createModuleLogger('PhaseTeaching');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const TEACHING_MODES = Object.freeze({
  IDLE: 'idle',
  PENDING_CURRICULUM: 'pending_curriculum_choice',
  PENDING_TEACHING_START: 'pending_teaching_start'
});

/* ── Entity Curiosity Constants ────────────────────────────────────────── */

const ENTITY_CURIOSITY_QUD_PREFIX = 'entity.inquiry.';
const ENTITY_CURIOSITY_SESSION_CAP = 2;
const ENTITY_CURIOSITY_TURN_COOLDOWN = 8;

const LTLM_EXPRESSIVE_CURIOSITY_POSITIVE = '#3400C0';

const ENTITY_CONSENT_QUD_PREFIX = 'entity.consent.';
const LTLM_RESPONSIVE_ACKNOWLEDGE_INFO = '#3400F0';
const LTLM_REPAIR_CONFIRM_UNDERSTANDING = '#3400F4';
const LTLM_SOCIAL_THANK = '#340032';

/* ── Vocabulary Curiosity Constants ─────────────────────────────────── */

const VOCAB_CURIOSITY_QUD_PREFIX = 'vocab.inquiry.';
const VOCAB_CONSENT_QUD_PREFIX = 'vocab.consent.';

const VOCAB_QUESTION_TEMPLATES = Object.freeze([
  (word) => `What\u2019s ${word}? I haven\u2019t come across that before.`,
  (word) => `Hmm, ${word}\u2026 what does that mean?`,
  (word) => `${word}? That\u2019s a new one for me. What does it mean?`
]);

const CONSENT_TEMPLATES = Object.freeze({
  high: [
    (phrase, typeLabel) => `So ${phrase} is your ${typeLabel}! Want me to remember that?`,
    (phrase, typeLabel) => `${phrase}, your ${typeLabel}\u2026 got it! Should I keep that in mind for later?`,
    (phrase, typeLabel) => `Your ${typeLabel} ${phrase}! Want me to remember?`
  ],
  medium: [
    (phrase, typeLabel) => `So ${phrase} is your ${typeLabel}? Did I get that right?`,
    (phrase, typeLabel) => `Let me check \u2014 ${phrase} is your ${typeLabel}?`,
    (phrase, typeLabel) => `${phrase}\u2026 your ${typeLabel}, yeah?`
  ]
});

const QUESTION_TYPE_MAP = Object.freeze({
  possessive: 'who',
  relationshipIntro: 'who',
  qualifiedPossessive: 'who',
  capitalised: 'who',
  preposition: 'where'
});

/* ── FUTURE: These hardcoded templates are placeholder for v010.          ── */
/* ── In a later version, LTLM should generate these phrases dynamically   ── */
/* ── using dialogue function expressive.curiosity.positive and the         ── */
/* ── character voice model. Remove templates and wire to LTLM when ready. ── */

const QUESTION_TEMPLATES = Object.freeze({
  who: [
    (phrase) => `Who\u2019s ${phrase}? Someone important to you?`,
    (phrase) => `Hmm, ${phrase}\u2026 I don\u2019t know that name. Who are they?`,
    (phrase) => `${phrase}? Tell me about them!`
  ],
  where: [
    (phrase) => `Where\u2019s ${phrase}? Sounds like a place you know.`,
    (phrase) => `${phrase}\u2026 I don\u2019t know that spot. Where is it?`,
    (phrase) => `Ooh, ${phrase}? What\u2019s it like there?`
  ],
  what: [
    (phrase) => `What\u2019s ${phrase}? I haven\u2019t heard that before.`,
    (phrase) => `Hmm, ${phrase}\u2026 what does that mean?`,
    (phrase) => `${phrase}? That\u2019s new to me. What is it?`
  ]
});

/* ── FUTURE: These hardcoded templates are placeholder for v010.          ── */
/* ── In a later version, LTLM should generate did-you-mean phrases        ── */
/* ── dynamically using the character voice model. Remove templates and     ── */
/* ── wire to LTLM when ready.                                             ── */

const DID_YOU_MEAN_TEMPLATES = Object.freeze([
  (phrase, match) => `Hmm, I don\u2019t know anyone called ${phrase}\u2026 did you mean ${match}?`,
  (phrase, match) => `${phrase}? I\u2019m not sure about that name, but could you mean ${match}?`,
  (phrase, match) => `I don\u2019t recognise ${phrase}, but that sounds a bit like ${match}. Is that who you mean?`
]);

const RETRIEVAL_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Timeout after ' + ms + 'ms: ' + label));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  PhaseTeaching Handler                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

const PhaseTeaching = {
  async execute(turnState) {
    const { session, correlationId, diagnosticReport } = turnState;

    logger.debug('Executing', { correlationId });

    const learningSignals = diagnosticReport?.rawModules?.learning ?? null;
    const cognitiveFrame = diagnosticReport?.rawModules?.cognitiveFrame ?? null;
    const postureRecommendation = diagnosticReport?.postureRecommendation ?? 'unknown';
    const diagnosticConfidence = diagnosticReport?.confidence ?? 0;

    logger.debug('DiagnosticReport received', {
      correlationId,
      hasReport: !!diagnosticReport,
      posture: postureRecommendation,
      confidence: diagnosticConfidence,
      learningDetected: learningSignals?.shouldAsk ?? false,
      cognitiveFrameType: cognitiveFrame?.type ?? 'none'
    });

    const diagnosticSummary = {
      posture: postureRecommendation,
      confidence: diagnosticConfidence,
      learningDetected: learningSignals?.shouldAsk ?? false,
      unknownWords: learningSignals?.unknownWords ?? [],
      cognitiveFrameType: cognitiveFrame?.type ?? 'none',
      cognitiveFrameConfidence: cognitiveFrame?.confidence ?? 0
    };

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  0. Entity Curiosity (unfamiliar reference detected)                    */
    /*                                                                         */
    /*  When BrainOrchestrator flags turnState.entityCuriosity, this block:    */
    /*    a) Enforces rate limits (session cap + turn cooldown)                 */
    /*    b) Guards against duplicate QUD push (idempotency)                    */
    /*    c) Maps detection signal to question type (who/what/where)            */
    /*    d) Selects question template via deterministic rotation               */
    /*    e) Pushes QUD via ConversationStateManager                           */
    /*    f) Returns terminal response with question text                       */
    /*                                                                         */
    /*  On any failure or gate rejection, falls through to Section 1.          */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.entityCuriosity) {
      const { candidate } = turnState.entityCuriosity;
      const phrase = candidate?.phrase;

      if (!phrase || !turnState.conversationId || !turnState.user?.userId) {
        logger.debug('Entity curiosity skipped: missing phrase or IDs', {
          correlationId,
          hasPhrase: !!phrase,
          hasConversationId: !!turnState.conversationId,
          hasUserId: !!turnState.user?.userId
        });

      /* ── Rate Limit: Session cap ─────────────────────────────────────── */

      } else if ((session?.entityCuriosityCount || 0) >= ENTITY_CURIOSITY_SESSION_CAP) {
        logger.debug('Entity curiosity skipped: session cap reached', {
          correlationId,
          phrase,
          sessionCount: session.entityCuriosityCount,
          cap: ENTITY_CURIOSITY_SESSION_CAP
        });

      /* ── Rate Limit: Turn cooldown ───────────────────────────────────── */

      } else if (
        typeof turnState.turnIndex === 'number' &&
        typeof session?.lastEntityCuriosityTurn === 'number' &&
        (turnState.turnIndex - session.lastEntityCuriosityTurn) < ENTITY_CURIOSITY_TURN_COOLDOWN
      ) {
        logger.debug('Entity curiosity skipped: turn cooldown active', {
          correlationId,
          phrase,
          currentTurn: turnState.turnIndex,
          lastCuriosityTurn: session.lastEntityCuriosityTurn,
          cooldown: ENTITY_CURIOSITY_TURN_COOLDOWN
        });

      } else {

        /* ── Idempotency: Check for open entity QUD ──────────────────── */

        let hasOpenEntityQud = false;
        try {
          const topQUD = await ConversationStateManager.getTopQUD(turnState.conversationId);
          hasOpenEntityQud = topQUD?.status === 'open' &&
            typeof topQUD?.act_code === 'string' &&
            topQUD.act_code.startsWith(ENTITY_CURIOSITY_QUD_PREFIX);
        } catch (qudCheckErr) {
          logger.warn('Entity curiosity QUD idempotency check failed, skipping', {
            correlationId,
            error: qudCheckErr.message
          });
          hasOpenEntityQud = true;
        }

        if (hasOpenEntityQud) {
          logger.debug('Entity curiosity skipped: entity QUD already open', {
            correlationId,
            phrase
          });

        } else {

          /* ── Generate question ──────────────────────────────────────── */

          const knownMatch = turnState.entityCuriosity.knownEntityMatch;

          if (knownMatch) {
            /* ── Did you mean? — known entity fuzzy match ────────────── */

            const matchedName = knownMatch.entity?.entity_name || 'unknown';
            const didYouMeanIndex = turnState.turnIndex % DID_YOU_MEAN_TEMPLATES.length;
            const questionText = DID_YOU_MEAN_TEMPLATES[didYouMeanIndex](phrase, matchedName);
            const actCode = ENTITY_CURIOSITY_QUD_PREFIX + 'who';
            const questionTemplateId = `did_you_mean_${didYouMeanIndex}`;

            try {
              await ConversationStateManager.pushQUD(
                turnState.conversationId,
                turnState.user.userId,
                {
                  actCode,
                  questionText,
                  speaker: turnState.speakerCharacterId || 'claude',
                  topic: 'entity_curiosity_did_you_mean',
                  entities: [phrase, matchedName],
                  turnIndex: turnState.turnIndex
                }
              );

              if (session) {
                session.entityCuriosityCount = (session.entityCuriosityCount || 0) + 1;
                session.lastEntityCuriosityTurn = turnState.turnIndex;
              }

              logger.info('Entity curiosity did-you-mean question generated', {
                correlationId,
                phrase,
                matchedEntity: matchedName,
                matchAction: knownMatch.action,
                matchConfidence: knownMatch.confidence,
                matchMethod: knownMatch.method,
                questionTemplateId,
                sessionCuriosityCount: session?.entityCuriosityCount || 0,
                turnIndex: turnState.turnIndex
              });

              return {
                responseIntent: {
                  output: questionText,
                  source: 'PhaseTeaching.entityCuriosity.didYouMean',
                  dialogueFunction: LTLM_EXPRESSIVE_CURIOSITY_POSITIVE,
                  metadata: {
                    entityCuriosity: true,
                    didYouMean: true,
                    phrase,
                    matchedEntity: matchedName,
                    matchAction: knownMatch.action,
                    matchConfidence: knownMatch.confidence,
                    matchMethod: knownMatch.method,
                    questionTemplateId,
                    probableType: candidate.probable_type || null,
                    contextScore: candidate.context_score || 0
                  }
                },
                teachingContext: {
                  mode: 'entity_curiosity_did_you_mean',
                  hasActiveLesson: false,
                  diagnosticSummary
                },
                terminal: true
              };

            } catch (qudErr) {
              logger.warn('Did-you-mean QUD push failed, falling through to standard curiosity', {
                correlationId,
                phrase,
                matchedEntity: matchedName,
                error: qudErr.message
              });
            }
          }

          /* ── Standard unknown entity question ─────────────────────── */

          const signal = candidate.signal || 'capitalised';
          const questionType = QUESTION_TYPE_MAP[signal] || 'what';
          const templates = QUESTION_TEMPLATES[questionType];
          const templateIndex = turnState.turnIndex % templates.length;
          const questionText = templates[templateIndex](phrase);
          const actCode = ENTITY_CURIOSITY_QUD_PREFIX + questionType;
          const questionTemplateId = `entity_curiosity_${questionType}_${templateIndex}`;

          try {
            await ConversationStateManager.pushQUD(
              turnState.conversationId,
              turnState.user.userId,
              {
                actCode,
                questionText,
                speaker: turnState.speakerCharacterId || 'claude',
                topic: 'entity_curiosity',
                entities: [phrase],
                turnIndex: turnState.turnIndex
              }
            );

            /* ── Update session counters ─────────────────────────────── */

            if (session) {
              session.entityCuriosityCount = (session.entityCuriosityCount || 0) + 1;
              session.lastEntityCuriosityTurn = turnState.turnIndex;
            }

            logger.info('Entity curiosity question generated', {
              correlationId,
              phrase,
              signal,
              questionType,
              actCode,
              questionTemplateId,
              sessionCuriosityCount: session?.entityCuriosityCount || 0,
              turnIndex: turnState.turnIndex
            });

            return {
              responseIntent: {
                output: questionText,
                source: 'PhaseTeaching.entityCuriosity',
                dialogueFunction: LTLM_EXPRESSIVE_CURIOSITY_POSITIVE,
                metadata: {
                  entityCuriosity: true,
                  phrase,
                  questionType,
                  signal,
                  score: turnState.entityCuriosity.score,
                  questionTemplateId,
                  probableType: candidate.probable_type || null,
                  contextScore: candidate.context_score || 0
                }
              },
              teachingContext: {
                mode: 'entity_curiosity',
                hasActiveLesson: false,
                diagnosticSummary
              },
              terminal: true
            };

          } catch (qudErr) {
            logger.warn('Entity curiosity QUD push failed, continuing without', {
              correlationId,
              phrase,
              error: qudErr.message
            });
          }
        }
      }
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  0b. Vocabulary Curiosity (unfamiliar word detected)                    */
    /*                                                                         */
    /*  When BrainOrchestrator flags turnState.vocabularyCuriosity, this block */
    /*  enforces shared rate limits, guards against duplicate QUD push,        */
    /*  selects a question template, pushes QUD, and returns terminal.         */
    /*                                                                         */
    /*  On any failure or gate rejection, falls through to Section 1.          */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.vocabularyCuriosity) {
      const { word } = turnState.vocabularyCuriosity;

      if (!word || !turnState.conversationId || !turnState.user?.userId) {
        logger.debug('Vocab curiosity skipped: missing word or IDs', {
          correlationId,
          hasWord: !!word,
          hasConversationId: !!turnState.conversationId,
          hasUserId: !!turnState.user?.userId
        });

      /* ── Rate Limit: Shared session cap (entity + vocab combined) ────── */

      } else if (
        ((session?.entityCuriosityCount || 0) + (session?.vocabCuriosityCount || 0))
          >= ENTITY_CURIOSITY_SESSION_CAP
      ) {
        logger.debug('Vocab curiosity skipped: shared session cap reached', {
          correlationId,
          word,
          entityCount: session?.entityCuriosityCount || 0,
          vocabCount: session?.vocabCuriosityCount || 0,
          cap: ENTITY_CURIOSITY_SESSION_CAP
        });

      /* ── Rate Limit: Turn cooldown ───────────────────────────────────── */

      } else if (
        typeof turnState.turnIndex === 'number' &&
        typeof session?.lastVocabCuriosityTurn === 'number' &&
        (turnState.turnIndex - session.lastVocabCuriosityTurn) < ENTITY_CURIOSITY_TURN_COOLDOWN
      ) {
        logger.debug('Vocab curiosity skipped: turn cooldown active', {
          correlationId,
          word,
          currentTurn: turnState.turnIndex,
          lastVocabCuriosityTurn: session.lastVocabCuriosityTurn,
          cooldown: ENTITY_CURIOSITY_TURN_COOLDOWN
        });

      } else {

        /* ── Idempotency: Check for open vocab QUD ──────────────────────── */

        let hasOpenVocabQud = false;
        try {
          const topQUD = await ConversationStateManager.getTopQUD(turnState.conversationId);
          hasOpenVocabQud = topQUD?.status === 'open' &&
            typeof topQUD?.act_code === 'string' &&
            topQUD.act_code.startsWith(VOCAB_CURIOSITY_QUD_PREFIX);
        } catch (qudCheckErr) {
          logger.warn('Vocab curiosity QUD idempotency check failed, skipping', {
            correlationId,
            error: qudCheckErr.message
          });
          hasOpenVocabQud = true;
        }

        if (hasOpenVocabQud) {
          logger.debug('Vocab curiosity skipped: vocab QUD already open', {
            correlationId,
            word
          });

        } else {

          /* ── Generate question ──────────────────────────────────────────── */

          const templateIndex = turnState.turnIndex % VOCAB_QUESTION_TEMPLATES.length;
          const questionText = VOCAB_QUESTION_TEMPLATES[templateIndex](word);
          const actCode = VOCAB_CURIOSITY_QUD_PREFIX + 'what';
          const questionTemplateId = 'vocab_curiosity_what_' + templateIndex;

          try {
            await ConversationStateManager.pushQUD(
              turnState.conversationId,
              turnState.user.userId,
              {
                actCode,
                questionText,
                speaker: turnState.speakerCharacterId || 'claude',
                topic: 'vocab_curiosity',
                entities: [word],
                turnIndex: turnState.turnIndex
              }
            );

            /* ── Update session counters ─────────────────────────────────── */

            if (session) {
              session.vocabCuriosityCount = (session.vocabCuriosityCount || 0) + 1;
              session.lastVocabCuriosityTurn = turnState.turnIndex;
            }

            logger.info('Vocab curiosity question generated', {
              correlationId,
              word,
              actCode,
              questionTemplateId,
              sessionVocabCount: session?.vocabCuriosityCount || 0,
              sessionEntityCount: session?.entityCuriosityCount || 0,
              turnIndex: turnState.turnIndex
            });

            return {
              responseIntent: {
                output: questionText,
                source: 'PhaseTeaching.vocabCuriosity',
                dialogueFunction: LTLM_EXPRESSIVE_CURIOSITY_POSITIVE,
                metadata: {
                  vocabCuriosity: true,
                  word,
                  allUnknownWords: turnState.vocabularyCuriosity.allUnknownWords,
                  score: turnState.vocabularyCuriosity.score,
                  triggeredSignals: turnState.vocabularyCuriosity.triggeredSignals,
                  questionTemplateId
                }
              },
              teachingContext: {
                mode: 'vocab_curiosity',
                hasActiveLesson: false,
                diagnosticSummary
              },
              terminal: true
            };

          } catch (qudErr) {
            logger.warn('Vocab curiosity QUD push failed, continuing without', {
              correlationId,
              word,
              error: qudErr.message
            });
          }
        }
      }
    }


    /* ──────────────────────────────────────────────────────────────────────── */
    /*  1. QUD-triggered teaching activation                                   */
    /*                                                                         */
    /*  When a user accepts a teaching offer via QUD affirmative response,     */
    /*  BrainOrchestrator sets turnState.qudActivation. This block resolves    */
    /*  the feature ID to a knowledge item and domain for TSE to use.          */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.qudActivation?.type === 'teaching_accepted') {
      const { featureId, qudId } = turnState.qudActivation;
      logger.info('QUD teaching activation detected', { correlationId, featureId, qudId });

      let knowledgeId = null;
      let domainId = null;

      if (!featureId || typeof featureId !== 'string' || !featureId.startsWith('#')) {
        logger.warn('Invalid or missing featureId in QUD activation', {
          correlationId,
          featureId
        });
      } else {
        const resolveStart = Date.now();
        try {
          const resolved = await withTimeout(pool.query(
            `SELECT ki.knowledge_id, ki.domain_id, sf.feature_code
             FROM system_features sf
             LEFT JOIN knowledge_items ki ON ki.concept ILIKE sf.feature_code || $2
             WHERE sf.feature_id = $1
             ORDER BY ki.belt_level ASC NULLS FIRST, ki.complexity_score ASC
             LIMIT 1`,
            [featureId, '%']
          ), RETRIEVAL_TIMEOUT_MS, 'feature_resolution_query');
          const resolveMs = Date.now() - resolveStart;

          if (resolved.rows.length > 0 && resolved.rows[0].knowledge_id) {
            knowledgeId = resolved.rows[0].knowledge_id;
            domainId = resolved.rows[0].domain_id;
            logger.info('Resolved feature to knowledge item', {
              correlationId,
              featureId,
              featureCode: resolved.rows[0].feature_code,
              knowledgeId,
              domainId,
              resolveMs
            });
          } else if (resolved.rows.length > 0) {
            logger.warn('Feature found but no matching knowledge item', {
              correlationId,
              featureId,
              featureCode: resolved.rows[0].feature_code,
              resolveMs
            });
          } else {
            logger.warn('Feature not found in system_features', {
              correlationId,
              featureId,
              resolveMs
            });
          }
        } catch (resolveErr) {
          logger.warn('Feature resolution failed, continuing without', {
            correlationId,
            featureId,
            error: resolveErr.message
          });
        }
      }

      return {
        teachingContext: {
          mode: TEACHING_MODES.PENDING_TEACHING_START,
          hasActiveLesson: false,
          activatedViaQud: true,
          featureId,
          knowledgeId,
          domainId,
          qudId,
          diagnosticSummary
        }
      };
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  1b. Entity explanation handler (Turn 3 of curiosity flow)               */
    /*                                                                         */
    /*  BrainOrchestrator resolved an entity.inquiry.* QUD and set             */
    /*  turnState.qudActivation = { type: 'entity_explanation', phrase,        */
    /*  questionType, explanation, qudId }. We parse the explanation,           */
    /*  generate a confirmation or consent question, and push a consent QUD.   */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.qudActivation?.type === 'entity_explanation') {
      const { phrase, questionType, explanation, qudId } = turnState.qudActivation;

      logger.info('Entity explanation received', {
        correlationId,
        phrase,
        questionType,
        explanationLength: explanation?.length || 0,
        qudId
      });

      /* ── Parse the explanation ───────────────────────────────────────── */

      const parsed = parseExplanation(explanation, phrase, questionType);

      logger.info('Entity explanation parsed', {
        correlationId,
        phrase,
        entityType: parsed.entity_type,
        relationshipType: parsed.relationship_type,
        confidence: parsed.confidence,
        parsingFlag: parsed.parsing_flag
      });

      /* ── LOW confidence: acknowledge + store raw for admin ───────────── */

      if (parsed.confidence === 'low') {
        logger.info('Entity explanation low confidence, acknowledging without consent gate', {
          correlationId,
          phrase,
          parsingFlag: parsed.parsing_flag
        });

        return {
          responseIntent: {
            output: 'Thanks for telling me about ' + phrase + '!',
            source: 'PhaseTeaching.entityExplanation',
            dialogueFunction: LTLM_SOCIAL_THANK,
            metadata: {
              entityExplanation: true,
              phrase,
              questionType,
              parsed,
              consentSkipped: true,
              reason: 'low_confidence'
            }
          },
          teachingContext: {
            mode: 'entity_explanation_acknowledged',
            hasActiveLesson: false,
            diagnosticSummary
          },
          terminal: true
        };
      }

      /* ── MEDIUM confidence: confirmation sub-question ────────────────── */
      /* ── HIGH confidence: direct consent question ────────────────────── */

      const needsConfirmation = requiresConfirmation(parsed);
      const templateSet = needsConfirmation ? CONSENT_TEMPLATES.medium : CONSENT_TEMPLATES.high;
      const templateIndex = turnState.turnIndex % templateSet.length;
      const typeLabel = _entityTypeLabel(parsed);
      const responseText = templateSet[templateIndex](phrase, typeLabel);
      const consentActCode = needsConfirmation
        ? ENTITY_CONSENT_QUD_PREFIX + 'confirm'
        : ENTITY_CONSENT_QUD_PREFIX + 'remember';
      const dialogueFunction = needsConfirmation
        ? LTLM_REPAIR_CONFIRM_UNDERSTANDING
        : LTLM_RESPONSIVE_ACKNOWLEDGE_INFO;

      try {
        await ConversationStateManager.pushQUD(
          turnState.conversationId,
          turnState.user.userId,
          {
            actCode: consentActCode,
            questionText: responseText,
            speaker: turnState.speakerCharacterId || 'claude',
            topic: 'entity_consent',
            entities: [JSON.stringify(parsed)],
            turnIndex: turnState.turnIndex
          }
        );

        logger.info('Entity consent QUD pushed', {
          correlationId,
          phrase,
          consentActCode,
          confidence: parsed.confidence,
          needsConfirmation,
          entityType: parsed.entity_type,
          templateIndex
        });

        return {
          responseIntent: {
            output: responseText,
            source: 'PhaseTeaching.entityExplanation',
            dialogueFunction,
            metadata: {
              entityExplanation: true,
              phrase,
              questionType,
              parsed,
              needsConfirmation,
              consentActCode,
              templateIndex
            }
          },
          teachingContext: {
            mode: 'entity_consent_pending',
            hasActiveLesson: false,
            diagnosticSummary
          },
          terminal: true
        };

      } catch (consentQudErr) {
        logger.warn('Entity consent QUD push failed, acknowledging without', {
          correlationId,
          phrase,
          error: consentQudErr.message
        });

        return {
          responseIntent: {
            output: 'Thanks for telling me about ' + phrase + '!',
            source: 'PhaseTeaching.entityExplanation',
            dialogueFunction: LTLM_SOCIAL_THANK,
            metadata: {
              entityExplanation: true,
              phrase,
              parsed,
              consentSkipped: true,
              reason: 'qud_push_failed'
            }
          },
          teachingContext: {
            mode: 'entity_explanation_acknowledged',
            hasActiveLesson: false,
            diagnosticSummary
          },
          terminal: true
        };
      }
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  1c. Vocabulary explanation handler (Turn 2 of vocab curiosity flow)    */
    /*                                                                         */
    /*  BrainOrchestrator resolved a vocab.inquiry.* QUD and set              */
    /*  turnState.qudActivation = { type: 'vocab_explanation', word,          */
    /*  explanation, qudId }. We parse the explanation, generate a             */
    /*  confirmation or consent question, and push a consent QUD.             */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (turnState.qudActivation?.type === 'vocab_explanation') {
      const { word, explanation, qudId } = turnState.qudActivation;

      logger.info('Vocab explanation received', {
        correlationId,
        word,
        explanationLength: explanation?.length || 0,
        qudId
      });

      /* ── Parse the explanation ───────────────────────────────────────── */

      const parsed = parseVocabExplanation(explanation, word);

      logger.info('Vocab explanation parsed', {
        correlationId,
        word,
        category: parsed.category,
        baseConcept: parsed.baseConcept,
        confidence: parsed.confidence,
        confidenceScore: parsed.confidenceScore,
        parsingFlag: parsed.parsing_flag
      });

      /* ── LOW confidence: acknowledge + store raw for admin ───────────── */

      if (parsed.confidence === 'low') {
        logger.info('Vocab explanation low confidence, acknowledging without consent gate', {
          correlationId,
          word,
          parsingFlag: parsed.parsing_flag
        });

        return {
          responseIntent: {
            output: 'Thanks for explaining ' + word + '!',
            source: 'PhaseTeaching.vocabExplanation',
            dialogueFunction: LTLM_SOCIAL_THANK,
            metadata: {
              vocabExplanation: true,
              word,
              parsed,
              consentSkipped: true,
              reason: 'low_confidence'
            }
          },
          teachingContext: {
            mode: 'vocab_explanation_acknowledged',
            hasActiveLesson: false,
            diagnosticSummary
          },
          terminal: true
        };
      }

      /* ── MEDIUM confidence: confirmation sub-question ────────────────── */
      /* ── HIGH confidence: direct consent question ────────────────────── */

      const needsConfirmation = vocabRequiresConfirmation(parsed);
      const definition = parsed.definition || parsed.baseConcept || explanation.trim();
      const responseText = needsConfirmation
        ? 'So ' + word + ' means ' + definition + '? Did I get that right?'
        : 'So ' + word + ' means ' + definition + '! Want me to remember that?';
      const consentActCode = needsConfirmation
        ? VOCAB_CONSENT_QUD_PREFIX + 'confirm'
        : VOCAB_CONSENT_QUD_PREFIX + 'remember';
      const dialogueFunction = needsConfirmation
        ? LTLM_REPAIR_CONFIRM_UNDERSTANDING
        : LTLM_RESPONSIVE_ACKNOWLEDGE_INFO;

      try {
        await ConversationStateManager.pushQUD(
          turnState.conversationId,
          turnState.user.userId,
          {
            actCode: consentActCode,
            questionText: responseText,
            speaker: turnState.speakerCharacterId || 'claude',
            topic: 'vocab_consent',
            entities: [JSON.stringify(parsed)],
            turnIndex: turnState.turnIndex
          }
        );

        logger.info('Vocab consent QUD pushed', {
          correlationId,
          word,
          consentActCode,
          confidence: parsed.confidence,
          needsConfirmation,
          category: parsed.category,
          templateUsed: needsConfirmation ? 'confirmation' : 'consent'
        });

        return {
          responseIntent: {
            output: responseText,
            source: 'PhaseTeaching.vocabExplanation',
            dialogueFunction,
            metadata: {
              vocabExplanation: true,
              word,
              parsed,
              needsConfirmation,
              consentActCode
            }
          },
          teachingContext: {
            mode: 'vocab_consent_pending',
            hasActiveLesson: false,
            diagnosticSummary
          },
          terminal: true
        };

      } catch (consentQudErr) {
        logger.warn('Vocab consent QUD push failed, acknowledging without', {
          correlationId,
          word,
          error: consentQudErr.message
        });

        return {
          responseIntent: {
            output: 'Thanks for explaining ' + word + '!',
            source: 'PhaseTeaching.vocabExplanation',
            dialogueFunction: LTLM_SOCIAL_THANK,
            metadata: {
              vocabExplanation: true,
              word,
              parsed,
              consentSkipped: true,
              reason: 'qud_push_failed'
            }
          },
          teachingContext: {
            mode: 'vocab_explanation_acknowledged',
            hasActiveLesson: false,
            diagnosticSummary
          },
          terminal: true
        };
      }
    }


    /* ──────────────────────────────────────────────────────────────────────── */
    /*  2. Pending curriculum selection                                         */
    /* ──────────────────────────────────────────────────────────────────────── */

    const context = session?.context ?? {};

    if (context.pendingCurriculumChoice) {
      logger.debug('Pending curriculum choice detected', { correlationId });
      return {
        teachingContext: {
          mode: TEACHING_MODES.PENDING_CURRICULUM,
          availableCurricula: context.pendingCurriculumChoice ?? [],
          hasActiveLesson: false,
          diagnosticSummary
        }
      };
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  3. Idle teaching state                                                 */
    /* ──────────────────────────────────────────────────────────────────────── */

    logger.debug('No active teaching state', { correlationId });

    return {
      teachingContext: {
        mode: TEACHING_MODES.IDLE,
        hasActiveLesson: false,
        diagnosticSummary
      }
    };
  }
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  FUTURE: Vocabulary Recall & Confirmation System (Task 7)                 */
/*                                                                           */
/*  OVERVIEW                                                                 */
/*  --------                                                                 */
/*  The vocabulary curiosity pipeline (Sections 0b, 1c, and BrainOrch       */
/*  consent handler) captures user-taught words in cotw_user_language.       */
/*  This section documents the planned recall lifecycle that transforms      */
/*  captured words into confirmed, actively-used vocabulary.                 */
/*                                                                           */
/*  RECALL LIFECYCLE                                                         */
/*  ----------------                                                         */
/*                                                                           */
/*  Stage 1: CAPTURE (BUILT)                                                */
/*    User teaches Claude a word via curiosity flow.                         */
/*    Stored in cotw_user_language with date_learned, confidence_level = 1.  */
/*    Word status: UNCONFIRMED.                                             */
/*                                                                           */
/*  Stage 2: CONFIRMATION (NOT YET BUILT)                                   */
/*    On the users NEXT LOGIN (not same session), if there are no active    */
/*    curiosity triggers, Claude brings up an unconfirmed word:              */
/*                                                                           */
/*      "Hey, last time we were chatting you used the word yeet and         */
/*       told me it means to throw something. Did I get that right?"         */
/*                                                                           */
/*    Rules:                                                                 */
/*      - Curiosity always takes priority over confirmation                  */
/*      - Maximum 1 confirmation per session                                 */
/*      - Confirmation does NOT count against curiosity session cap (2)      */
/*      - One successful confirmation locks the word (confidence bumped)     */
/*      - If user says "no thats wrong": mark for re-teaching               */
/*        (reset confidence to 0, curiosity system picks it up again)        */
/*      - Confirmation is opportunistic: only when no curiosity fires       */
/*                                                                           */
/*    Implementation location:                                               */
/*      - BrainOrchestrator: check cotw_user_language for unconfirmed        */
/*        words on first turn of session (after curiosity gates)             */
/*      - PhaseTeaching: new Section 0c for confirmation question gen       */
/*      - New QUD prefix: vocab.confirm.recall                              */
/*                                                                           */
/*  Stage 3: FIVE-WORD MILESTONE (NOT YET BUILT)                            */
/*    When Claude accumulates 5 unconfirmed words, it triggers a special    */
/*    teaching-reversal moment:                                              */
/*                                                                           */
/*      "Hey, its your turn to be the teacher this time!                    */
/*       Can we go over some words I learned from you?"                      */
/*                                                                           */
/*    This flips the dynamic: the user becomes the teacher, Claude the      */
/*    student. The user quizzes Claude on each word. Claude attempts to     */
/*    recall the meaning, and the user confirms or corrects.                 */
/*                                                                           */
/*    Rules:                                                                 */
/*      - Triggers when unconfirmed word count >= 5                          */
/*      - Still subordinate to active curiosity triggers                     */
/*      - One mini-session covers all 5 words sequentially                   */
/*      - Each confirmed word gets locked (confidence bumped)               */
/*      - Corrections reset the word for re-teaching                        */
/*      - This milestone could contribute to belt progression               */
/*                                                                           */
/*    Implementation location:                                               */
/*      - BrainOrchestrator: count unconfirmed words, flag milestone        */
/*      - PhaseTeaching: new Section 0d for milestone session handler       */
/*      - Needs session state to track progress through the 5 words         */
/*                                                                           */
/*  Stage 4: NATURAL USE / ACTIVE RECALL (NOT YET BUILT)                    */
/*    Once Claude has 5+ CONFIRMED (locked) words, PhaseVoice can draw      */
/*    from the vocabulary pool when generating responses.                    */
/*                                                                           */
/*    Rules:                                                                 */
/*      - Backlog gate: minimum 5 confirmed words before any recall         */
/*      - Probability gating: dont use every word every time                */
/*      - Confidence ramp: low usage probability initially, increasing      */
/*        as user continues to use the word organically                      */
/*      - User repetition of a word in organic conversation reinforces      */
/*        it (usage tracking in cotw_user_language)                          */
/*      - One confirmation locks meaning. No re-confirmation needed.        */
/*                                                                           */
/*    Implementation location:                                               */
/*      - PhaseVoice: fetch confirmed vocabulary, inject into response      */
/*      - learningDetector or new module: track user organic word usage     */
/*      - cotw_user_language: add usage_count, last_used_at columns         */
/*                                                                           */
/*  MULTILINGUAL NOTE                                                        */
/*  -----------------                                                        */
/*  This entire lifecycle is language-agnostic. Words taught in te reo       */
/*  Maori, Hawaiian, Navajo, or any language follow the same capture,       */
/*  confirmation, and recall path. Claude using an indigenous word back      */
/*  in context after confirmation is a meaningful act of cultural respect.  */
/*                                                                           */
/*  DATABASE REQUIREMENTS (FUTURE)                                           */
/*  -------------------------------                                          */
/*  cotw_user_language may need additional columns:                          */
/*    - confirmed_at (timestamp, null until confirmed)                       */
/*    - confirmation_session_id (which session confirmed it)                 */
/*    - usage_count (times user used word organically post-teaching)         */
/*    - last_used_at (timestamp of last organic use)                         */
/*    - claude_usage_count (times Claude used word in responses)             */
/*                                                                           */
/* ────────────────────────────────────────────────────────────────────────── */



/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Produces a human-readable label from parsed entity data for use in
 * consent/confirmation templates. Returns lowercase string.
 *
 * Examples:
 *   { entity_type: "PET", attributes: { species: "dog" } } -> "dog"
 *   { entity_type: "PERSON", relationship_type: "FRIEND" } -> "friend"
 *   { entity_type: "LOCATION" } -> "place"
 */
function _entityTypeLabel(parsed) {
  if (!parsed) return "thing";

  if (parsed.entity_type === "PET" && parsed.attributes?.species) {
    return parsed.attributes.species;
  }

  if (parsed.entity_type === "PERSON") {
    if (parsed.attributes?.familyRole) return parsed.attributes.familyRole;
    if (parsed.attributes?.role) return parsed.attributes.role;
    if (parsed.relationship_type === "FRIEND") return "friend";
    if (parsed.relationship_type === "FAMILY") return "family";
    if (parsed.relationship_type === "PARTNER") return "partner";
    return "friend";
  }

  if (parsed.entity_type === "LOCATION") return "place";
  if (parsed.entity_type === "ACTIVITY") return parsed.attributes?.activityType || "activity";
  if (parsed.entity_type === "INSTITUTION") return parsed.attributes?.institutionType || "place";

  return "thing";
}
export default PhaseTeaching;
