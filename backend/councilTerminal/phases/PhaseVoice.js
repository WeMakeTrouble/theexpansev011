/**
 * ============================================================================
 * PhaseVoice.js — Voice Styling & Response Assembly (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Final phase in the pipeline. Assembles the responseIntent by applying
 * LTLM styling via Storyteller and formatting output.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Mood blending now reads turnState.diagnosticReport.rawModules.pad (real PAD data
 *   from EarWig/padEstimator) instead of dead session.emotion.pad which
 *   was never written. This was Bug 10 from the EarWig brief.
 * - Fallback chain added when finalOutput is empty (Goal 4: Claude never
 *   goes silent). Chain: styled -> raw blocks -> LTLM generic -> hard
 *   fallback. v009 returned "" causing silence.
 * - BLOCK_TYPES expanded to cover all content block types actually used.
 *   v009 had LTLM type referenced but not in the constant.
 * - Dead claudeVoice import removed (was imported but never used).
 * - DB queries wrapped in withTimeout (5s) to prevent stalling.
 * - Counters integration for voice assembly metrics.
 * - Logger switched to createModuleLogger (structured, correlation IDs).
 * - v010 documentation header.
 * - All content block building, Storyteller integration, dossier
 *   formatting, system feature handling, teaching activation, LTLM
 *   utterance selection, and confidence clamping preserved exactly.
 *
 * SESSION MUTATION EXCEPTION
 * --------------------------
 * Line in TEACH_REQUEST handler writes session.context.pendingCurriculumChoice.
 * This is a deliberate session mutation required for curriculum selection
 * flow (PhaseTeaching reads it next turn). Documented exception to the
 * "no session mutation" invariant.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Read upstream phase results (emotional, intent, identity)
 *  - Read EarWig diagnosticReport for PAD mood data and posture recommendation
 *  - Aggregate content blocks from knowledge/entity (multi-item)
 *  - Blend mood with emotional context using real PAD coordinates
 *  - Apply LTLM styling via Storyteller (if available)
 *  - Clamp and finalize confidence
 *  - Assemble final responseIntent
 *  - Ensure Claude NEVER returns empty output (fallback chain)
 *
 * NON-GOALS
 * ---------
 *  - No intent matching (done in PhaseIntent)
 *  - No knowledge retrieval (done in PhaseIntent)
 *  - No emotional detection (done in PhaseEmotional)
 *  - No database mutation (except pendingCurriculumChoice — see above)
 *
 * INVARIANTS
 * ----------
 *  - Always returns a responseIntent with non-empty output
 *  - Never mutates upstream results
 *  - Graceful fallback if Storyteller unavailable
 *  - Confidence always clamped to [0, 1]
 *  - PAD mood comes from diagnosticReport.rawModules (real data), not session
 *
 * DEPENDENCIES
 * ------------
 *  - createModuleLogger (utils/logger.js)
 *  - CLAUDE_CHARACTER_ID (config/constants.js)
 *  - pool (db/pool.js)
 *  - ConversationStateManager (services/)
 *  - withRetry (councilTerminal/utils/)
 *  - Counters (councilTerminal/metrics/)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';
import { CLAUDE_CHARACTER_ID } from '../config/constants.js';
import pool from '../../db/pool.js';
import ConversationStateManager from '../../services/ConversationStateManager.js';
import Counters from '../metrics/counters.js';

const logger = createModuleLogger('PhaseVoice');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const DEFAULT_MOOD = Object.freeze({
  pleasure: 0.5,
  arousal: 0.3,
  dominance: 0.5
});

const DEFAULT_RESPONSE_STYLE = Object.freeze({
  ltlmIntensity: 'moderate',
  verbosity: 'moderate',
  formality: 'casual',
  primary: 'neutral'
});

const MAX_KNOWLEDGE_ITEMS = 3;
const CONFIDENCE_FLOOR = 0.1;
const CONFIDENCE_CEILING = 1.0;
const RETRIEVAL_TIMEOUT_MS = 5000;

const EMOTIONAL_MODE_PAD_MODIFIERS = Object.freeze({
  distressed: { pleasure: -0.3, arousal: 0.2, dominance: -0.1 },
  overwhelmed: { pleasure: -0.2, arousal: 0.4, dominance: -0.2 },
  supportive: { pleasure: 0.2, arousal: 0.1, dominance: 0.1 },
  celebratory: { pleasure: 0.4, arousal: 0.3, dominance: 0.2 },
  neutral: { pleasure: 0, arousal: 0, dominance: 0 }
});

const BLOCK_TYPES = Object.freeze({
  KNOWLEDGE: 'knowledge',
  ENTITY: 'entity',
  FALLBACK: 'fallback',
  LTLM: 'ltlm',
  DOSSIER: 'dossier',
  SYSTEM_FEATURE: 'system_feature',
  TEACHING_ACTIVATION: 'teaching_activation',
  TEACHING: 'teaching',
  TEACHING_OFFER: 'teaching_offer',
  IDENTITY: 'identity'
});

const RANK_HELPDESK_PRIORITY = -2;  // Helpdesk world-break: highest priority, always surfaces first
const RANK_TEACHING_PRIORITY = -1;  // Teaching activation: second priority, surfaces before all other content

const HARD_FALLBACK_RESPONSES = Object.freeze([
  'Hmm, I am not sure what to say about that. Could you try asking in a different way?',
  'I heard you, but I am drawing a blank. Can you rephrase that for me?',
  'That one stumped me. Want to try a different question?',
  'I am not sure how to respond to that just yet. What else is on your mind?'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Timeout Utility                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helper Functions                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function clampConfidence(value) {
  const num = Number(value) || 0;
  return Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEILING, num));
}

/**
 * Blends base PAD mood with emotional mode modifiers.
 * Clamps all values to [-1, 1].
 *
 * @param {object} baseMood - { pleasure, arousal, dominance }
 * @param {string} emotionalMode - Key from EMOTIONAL_MODE_PAD_MODIFIERS
 * @returns {object} Blended PAD coordinates
 */
function blendMood(baseMood, emotionalMode) {
  const modifier = EMOTIONAL_MODE_PAD_MODIFIERS[emotionalMode] || EMOTIONAL_MODE_PAD_MODIFIERS.neutral;
  return {
    pleasure: Math.max(-1, Math.min(1, (baseMood.pleasure || 0) + modifier.pleasure)),
    arousal: Math.max(-1, Math.min(1, (baseMood.arousal || 0) + modifier.arousal)),
    dominance: Math.max(-1, Math.min(1, (baseMood.dominance || 0) + modifier.dominance))
  };
}

/**
 * Builds content blocks from knowledge results and entity data.
 * Limits knowledge items to MAX_KNOWLEDGE_ITEMS.
 *
 * @param {object|null} knowledgeResult - Knowledge retrieval result
 * @param {object|null} entity - Entity from search result
 * @returns {object[]} Content blocks
 */
function buildContentBlocks(knowledgeResult, entity) {
  const blocks = [];

  if (knowledgeResult?.found && Array.isArray(knowledgeResult.items) && knowledgeResult.items.length > 0) {
    const items = knowledgeResult.items.slice(0, MAX_KNOWLEDGE_ITEMS);

    items.forEach((item, index) => {
      const content = item.content || item.description || '';
      if (content.trim().length > 0) {
        blocks.push({
          type: BLOCK_TYPES.KNOWLEDGE,
          content,
          rank: index,
          source: item.source || null,
          relevance: item.relevance || item.score || null
        });
      }
    });
  }

  if (entity && blocks.length === 0 && entity.source_table !== 'system_features') {
    const entityDesc = entity.description || entity.content || entity.search_context || '';
    const entityName = entity.entity_name || entity.name || 'Unknown';

    if (entityDesc.trim().length > 0 || entityName !== 'Unknown') {
      blocks.push({
        type: BLOCK_TYPES.ENTITY,
        content: '**' + entityName + '**\n' + entityDesc,
        entityName,
        rank: 0
      });
    }
  }

  return blocks;
}

/**
 * Converts content blocks to text output, sorted by rank.
 *
 * @param {object[]} blocks - Content blocks
 * @returns {string} Concatenated text
 */
function blocksToText(blocks) {
  if (blocks.length === 0) {
    return '';
  }

  return blocks
    .sort((a, b) => (a.rank || 0) - (b.rank || 0))
    .map(b => b.content)
    .filter(c => c && c.trim().length > 0)
    .join('\n\n');
}

/**
 * Selects a hard fallback response (deterministic rotation based on turn index).
 * Avoids Math.random() for reproducibility.
 *
 * @param {number} turnIndex - Current turn index
 * @returns {string} Fallback text
 */
function selectHardFallback(turnIndex) {
  const index = (turnIndex || 0) % HARD_FALLBACK_RESPONSES.length;
  return HARD_FALLBACK_RESPONSES[index];
}

/**
 * Formats character dossier into content blocks.
 *
 * @param {object|null} characterDossier - Dossier from PhaseIntent
 * @param {string} correlationId - For logging
 * @returns {object|null} Content block or null
 */
function formatDossierBlock(characterDossier, correlationId) {
  if (!characterDossier?.success || !characterDossier?.dossier) {
    return null;
  }

  const dossier = characterDossier.dossier;
  const parts = [];

  if (dossier.core) {
    const name = dossier.core.characterName || 'Unknown';
    const category = dossier.core.category || '';
    const description = dossier.core.description || '';
    parts.push('**' + name + '**' + (category ? ' (' + category + ')' : ''));
    if (description) parts.push(description);
  }

  if (dossier.images && dossier.images.length > 0) {
    parts.push('');
    parts.push('Images: ' + dossier.images.length + ' image(s) available');
  }

  if (dossier.personality?.ocean) {
    const o = dossier.personality.ocean;
    parts.push('');
    parts.push('Personality (OCEAN): Openness ' + (o.openness || 0) + ', Conscientiousness ' + (o.conscientiousness || 0) + ', Extraversion ' + (o.extraversion || 0) + ', Agreeableness ' + (o.agreeableness || 0) + ', Neuroticism ' + (o.neuroticism || 0));
  }

  if (dossier.traits && dossier.traits.length > 0) {
    parts.push('');
    parts.push('Traits: ' + dossier.traits.length + ' trait(s) recorded');
    const topTraits = dossier.traits.slice(0, 5).map(t => t.traitName + ' (' + Math.round(t.percentileScore) + '%)').join(', ');
    parts.push('Top 5: ' + topTraits);
  }

  if (dossier.identity && dossier.identity.length > 0) {
    parts.push('');
    parts.push('Identity Anchors: ' + dossier.identity.length + ' anchor(s)');
    dossier.identity.forEach(anchor => {
      if (anchor.anchor_text) parts.push('  - ' + anchor.anchor_type + ': ' + anchor.anchor_text);
    });
  }

  if (dossier.inventory && dossier.inventory.length > 0) {
    parts.push('');
    parts.push('Inventory: ' + dossier.inventory.length + ' item(s)');
    dossier.inventory.forEach(item => {
      const itemName = item.object_name || item.objectName || 'Unknown item';
      parts.push('  - ' + itemName);
    });
  }

  if (dossier.knowledge && dossier.knowledge.length > 0) {
    parts.push('');
    parts.push('Knowledge: ' + dossier.knowledge.length + ' knowledge item(s)');
  }

  if (dossier.relationships && dossier.relationships.length > 0) {
    parts.push('');
    parts.push('Relationships: ' + dossier.relationships.length + ' connection(s)');
    dossier.relationships.forEach(rel => {
      const relName = rel.relatedCharacterName || rel.related_character_name || 'Unknown';
      const relType = rel.relationshipType || rel.relationship_type || 'connected';
      parts.push('  - ' + relName + ' (' + relType + ')');
    });
  }

  if (dossier.psychic) {
    if (dossier.psychic.currentMood) {
      const mood = dossier.psychic.currentMood;
      parts.push('');
      parts.push('Current Mood (PAD): Pleasure ' + (mood.p || 0).toFixed(2) + ', Arousal ' + (mood.a || 0).toFixed(2) + ', Dominance ' + (mood.d || 0).toFixed(2));
    }
    if (dossier.psychic.proximity && dossier.psychic.proximity.length > 0) {
      parts.push('');
      parts.push('Psychic Proximity: ' + dossier.psychic.proximity.length + ' connection(s)');
    }
  }

  if (dossier.music && dossier.music.length > 0) {
    parts.push('');
    parts.push('Music: ' + dossier.music.length + ' track(s) featuring this character');
    dossier.music.forEach(track => {
      parts.push('  - ' + (track.track_name || track.trackName) + ' by ' + (track.artist_name || track.artistName));
    });
  }

  if (dossier.narrative && dossier.narrative.length > 0) {
    parts.push('');
    parts.push('Narrative: Active in ' + dossier.narrative.length + ' storyline(s)');
  }

  if (parts.length === 0) {
    return null;
  }

  logger.debug('Character dossier content formatted', {
    correlationId,
    tier: characterDossier.tier
  });

  return {
    type: BLOCK_TYPES.DOSSIER,
    content: parts.join('\n'),
    rank: 0,
    source: 'character_dossier'
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  PhaseVoice Handler                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

const PhaseVoice = {
  async execute(turnState) {
    const { session, dependencies, correlationId } = turnState;

    logger.debug('Executing', { correlationId });

    const speakerCharacterId = turnState.speakerId || turnState.activeCharacterId || CLAUDE_CHARACTER_ID;

    /* ──────────────────────────────────────────────────────────────────── */
    /*  1. Dependency validation                                            */
    /* ──────────────────────────────────────────────────────────────────── */

    const Storyteller = dependencies?.Storyteller;

    if (!Storyteller?.buildStorytellerResponse) {
      logger.warn('Storyteller missing or incomplete', { correlationId });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  2. Read upstream phase results                                      */
    /* ──────────────────────────────────────────────────────────────────── */

    const emotionalContext = turnState.emotionalResult?.emotionalContext ?? {};
    const intentContext = turnState.intentResult?.intentContext ?? {};
    const identityContext = turnState.identityResult?.identityContext ?? {};

    /* ──────────────────────────────────────────────────────────────────── */
    /*  3. Read and merge voice parameters                                  */
    /*                                                                      */
    /*  Bug 10 fix: v009 read session.emotion.pad which was never written. */
    /*  v010 reads turnState.diagnosticReport.rawModules.pad for real PAD coordinates */
    /*  from EarWig/padEstimator. Falls back to DEFAULT_MOOD if EarWig     */
    /*  failed or diagnosticReport is null.                                    */
    /*  FIX #13 (v011): Read compositeEmotionalState (60/40 EMA-blended)   */
    /*  instead of rawModules.pad (single-turn raw). compositeEmotionalState */
    /*  incorporates DrClaude historical trajectory and sarcasm adjustments. */
    /*  compositeEmotionalState uses shorthand { p, a, d } — map to full    */
    /*  names for blendMood compatibility.                                   */
    /* ──────────────────────────────────────────────────────────────────── */

    const compositeEmotionalState = turnState.diagnosticReport?.compositeEmotionalState ?? null;
    const baseMood = compositeEmotionalState
      ? { pleasure: compositeEmotionalState.p, arousal: compositeEmotionalState.a, dominance: compositeEmotionalState.d }
      : DEFAULT_MOOD;

    const emotionalMode = emotionalContext.paramKey || emotionalContext.mode || 'neutral';
    const blendedMood = blendMood(baseMood, emotionalMode);

    const responseStyle = {
      ...DEFAULT_RESPONSE_STYLE,
      ...(dependencies?.responseStyle || {})
    };

    const skipLtlm = responseStyle.ltlmIntensity === 'minimal';

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4. Build content blocks (multi-item aggregation)                    */
    /* ──────────────────────────────────────────────────────────────────── */

    const knowledgeResult = intentContext.knowledgeResult;
    const entity = intentContext.searchResult?.entity;
    const contentBlocks = buildContentBlocks(knowledgeResult, entity);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4.1. Handle teaching activation confirmation                        */
    /* ──────────────────────────────────────────────────────────────────── */

    if (turnState.teachingActivation?.activated) {
      const curriculumName = turnState.teachingActivation.curriculumName || 'the curriculum';
      contentBlocks.unshift({
        type: BLOCK_TYPES.TEACHING_ACTIVATION,
        content: 'Great! Let us begin learning ' + curriculumName + '. I will guide you through the material step by step.',
        rank: RANK_TEACHING_PRIORITY,
        source: 'teaching_activation'
      });
      logger.debug('Teaching activation confirmation added', { correlationId, curriculumName });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4.2. Handle character dossier data                                  */
    /* ──────────────────────────────────────────────────────────────────── */

    const characterDossier = intentContext.characterDossier;
    const imageUrl = intentContext.imageUrl || null;
    const dossierBlock = formatDossierBlock(characterDossier, correlationId);
    if (dossierBlock) {
      contentBlocks.push(dossierBlock);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4.3. Handle system feature documentation                            */
    /* ──────────────────────────────────────────────────────────────────── */

    const systemFeature = intentContext.systemFeature;
    if (systemFeature?.success && systemFeature?.facts?.length > 0) {
      const featureName = systemFeature.featureName || 'this feature';
      const facts = systemFeature.facts;
      const parts = [];

      parts.push('**' + featureName + '**');
      parts.push('');

      for (const fact of facts) {
        if (fact.fact_content) {
          parts.push(fact.fact_content);
        }
      }

      if (parts.length > 1) {
        contentBlocks.push({
          type: BLOCK_TYPES.SYSTEM_FEATURE,
          content: parts.join('\n'),
          rank: 0,
          source: 'feature_facts'
        });
        logger.debug('System feature content added', { correlationId, featureName, factCount: facts.length });
      }

      const teachingContext = turnState.teachingResult?.teachingContext ?? {};
      if (teachingContext.mode !== 'active_lesson' && teachingContext.mode !== 'pending_curriculum_choice') {
        try {
          let offerText = '\n\nWould you like to study this feature? Say yes to begin.';
          if (dependencies?.LtlmUtteranceSelector) {
            const teachOfferResult = await withTimeout(
              dependencies.LtlmUtteranceSelector.selectLtlmUtteranceForBeat({
                speakerCharacterId,
                speechActCode: 'commissive',
                dialogueFunctionCode: 'teaching.offer.system_feature',
                outcomeIntentCode: 'clarity',
                targetPad: blendedMood
              }),
              RETRIEVAL_TIMEOUT_MS,
              'LtlmUtteranceSelector.teachingOffer'
            );
            if (teachOfferResult?.utteranceText) {
              offerText = '\n\n' + teachOfferResult.utteranceText.replace(/<FEATURE_NAME>/g, featureName);
            }
          }

          contentBlocks.push({
            type: BLOCK_TYPES.TEACHING_OFFER,
            content: offerText,
            rank: 10,
            source: 'system_feature_offer',
            meta: {
              featureId: systemFeature.featureId,
              featureCode: systemFeature.featureCode,
              dialogueFunction: 'commissive.offer_help'
            }
          });
          logger.debug('Teaching offer added for system feature', { correlationId, featureName });

          if (turnState.conversationId && turnState.session?.userId) {
            try {
              const qudId = await ConversationStateManager.pushQUD(
                turnState.conversationId,
                turnState.session.userId,
                {
                  actCode: 'teaching.offer.system_feature',
                  questionText: offerText.trim(),
                  speaker: 'claude',
                  topic: 'teaching_offer',
                  entities: [systemFeature.featureId],
                  turnIndex: turnState.turnIndex || 0
                }
              );
              logger.debug('QUD pushed for teaching offer', { correlationId, qudId, featureName });
            } catch (qudErr) {
              logger.warn('Failed to push QUD for teaching offer', { correlationId, error: qudErr.message });
            }
          }
        } catch (offerErr) {
          logger.warn('Teaching offer query failed', { correlationId, error: offerErr.message });
        }
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4.4. Handle self-inquiry with identity data                         */
    /* ──────────────────────────────────────────────────────────────────── */

    if (identityContext.mode === 'self_inquiry' && identityContext.signals?.selfInquiryDetected) {
      try {
        if (dependencies?.IdentityService?.getIdentitySummary) {
          const identitySummary = await withTimeout(
            dependencies.IdentityService.getIdentitySummary(CLAUDE_CHARACTER_ID),
            RETRIEVAL_TIMEOUT_MS,
            'IdentityService.getIdentitySummary'
          );

          if (identitySummary?.summary) {
            contentBlocks.push({
              type: BLOCK_TYPES.IDENTITY,
              content: identitySummary.summary,
              rank: 0,
              source: 'identity_anchors'
            });
            if (identitySummary.whoIAm?.length > 0) {
              contentBlocks.push({
                type: BLOCK_TYPES.IDENTITY,
                content: identitySummary.whoIAm.join(' '),
                rank: 1,
                source: 'identity_anchors'
              });
            }
            logger.debug('Identity summary fetched for self-inquiry', { correlationId });
          }
        }
      } catch (identityErr) {
        logger.warn('Identity fetch failed', { correlationId, error: identityErr.message });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4.5. Handle TEACH_REQUEST — list available curricula                 */
    /*                                                                      */
    /*  SESSION MUTATION: Writes session.context.pendingCurriculumChoice.   */
    /*  This is a documented exception required for curriculum selection.   */
    /* ──────────────────────────────────────────────────────────────────── */

    if (intentContext.type === 'TEACH_REQUEST') {
      try {
        const userAccessLevel = session?.access_level || 1;
        const curricula = await withTimeout(
          pool.query(
            'SELECT curriculum_id, curriculum_name, description, belt_levels, domain_id, minimum_access_level, (minimum_access_level <= $1) AS is_accessible FROM curricula WHERE is_active = true ORDER BY display_order',
            [userAccessLevel]
          ),
          RETRIEVAL_TIMEOUT_MS,
          'curricula_query'
        );

        if (curricula.rows.length === 0) {
          contentBlocks.push({
            type: BLOCK_TYPES.TEACHING,
            content: 'I do not have any courses ready to teach yet. Check back soon!',
            rank: 0,
            source: 'tse_curricula'
          });
        } else {
          const courseList = curricula.rows.map((c, i) => (i + 1) + '. ' + c.curriculum_name + ' - ' + c.description).join('\n\n');
          session.context = session.context || {};
          session.context.pendingCurriculumChoice = curricula.rows;
          contentBlocks.push({
            type: BLOCK_TYPES.TEACHING,
            content: 'I can teach you these subjects:\n\n' + courseList + '\n\nChoose what you would like to learn by entering the number or simply say no.',
            rank: 0,
            source: 'tse_curricula'
          });
        }
        logger.debug('TEACH_REQUEST handled', { correlationId, curriculaCount: curricula.rows.length });
      } catch (tseError) {
        logger.error('Curricula fetch failed', { correlationId, error: tseError.message });
        contentBlocks.push({
          type: BLOCK_TYPES.TEACHING,
          content: 'I am having trouble accessing my teaching materials right now.',
          rank: 0,
          source: 'tse_error'
        });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4.5b. Handle TSE_ACTIVE — active session task/eval/menu content     */
    /*                                                                      */
    /*  BrainOrchestrator sets turnState.tseRawOutput with the assembled    */
    /*  TSE response before calling PhaseVoice. Storyteller voices it.      */
    /* ──────────────────────────────────────────────────────────────────── */

    if (intentContext.type === 'TSE_ACTIVE' && turnState.tseRawOutput) {
      contentBlocks.push({
        type: BLOCK_TYPES.TEACHING,
        content: turnState.tseRawOutput,
        rank: 0,
        source: 'tse_curricula'
      });
      logger.debug('TSE_ACTIVE content block added', { correlationId });
    }

    /*  4.6. Fetch LTLM utterance for conversational intents                */
    /* ──────────────────────────────────────────────────────────────────── */

    const _TERMINAL_TYPES = new Set(['system_feature', 'teaching_offer', 'teaching_activation', 'entity', 'dossier']);
    const _hasSubstantiveContent = contentBlocks.some(b => b?.type && _TERMINAL_TYPES.has(b.type));

    if (!_hasSubstantiveContent && intentContext.dialogueFunction && dependencies?.LtlmUtteranceSelector) {
      try {
        const ltlmResult = await withTimeout(
          dependencies.LtlmUtteranceSelector.selectLtlmUtteranceForBeat({
            speakerCharacterId,
            speechActCode: intentContext.speechAct || 'expressive',
            dialogueFunctionCode: intentContext.dialogueFunction,
            outcomeIntentCode: intentContext.outcomeIntent || 'clarity',
            targetPad: blendedMood
          }),
          RETRIEVAL_TIMEOUT_MS,
          'LtlmUtteranceSelector.selectLtlmUtteranceForBeat'
        );

        if (ltlmResult?.utteranceText) {
          contentBlocks.push({
            type: BLOCK_TYPES.LTLM,
            content: ltlmResult.utteranceText,
            rank: 0,
            source: 'ltlm',
            utteranceId: ltlmResult.trainingExampleId
          });
          logger.debug('LTLM utterance fetched', { correlationId, utteranceId: ltlmResult.trainingExampleId });
        }
      } catch (ltlmErr) {
        logger.warn('LTLM selection failed', { correlationId, error: ltlmErr.message });
      }
    }

    /*  4.8. Handle helpdesk world break (PhaseClaudesHelpDesk detected)   */
    /*                                                                      */
    /*  PLACEHOLDER RESPONSES — February 2026                              */
    /*  These hardcoded responses are temporary. When LTLM training        */
    /*  examples are authored for helpdesk dialogue functions               */
    /*  (e.g. commissive.offer_help, responsive.acknowledge_request),      */
    /*  replace this block with LtlmUtteranceSelector calls matching       */
    /*  the pattern used in section 4.6 above.                             */
    /*  Categories to populate: #3400FB (commissive.offer_help),           */
    /*  #3400F1 (responsive.acknowledge_request),                          */
    /*  #3400F0 (responsive.acknowledge_information)                       */
    /* ──────────────────────────────────────────────────────────────────── */

    const helpdeskResult = turnState.claudesHelpDeskResult?.helpdeskContext;
    if (helpdeskResult?.worldBreakDetected && helpdeskResult.primaryIntent) {
      const helpdeskMode = helpdeskResult.mode || 'shopkeeper';
      const helpdeskIntent = helpdeskResult.primaryIntent;
      const helpdeskUserType = helpdeskResult.userType || 'human';

      const HELPDESK_RESPONSES = {
        COMMERCE: 'It sounds like you are interested in buying something! I am not quite set up as a shopkeeper yet, but I have noted your interest. The store is coming soon.',
        ORDER_SUPPORT: 'It sounds like you need help with an order. I have flagged this for our support team. Hang tight.',
        BUSINESS: 'A business inquiry! I have noted this and will make sure the right people see it.',
        TECH_SUPPORT: 'It sounds like you are having a technical issue. Let me flag this so we can get it sorted.',
        SIGNUP: 'You want to sign up! I have noted your interest. The signup system is coming soon.',
        INQUIRY: 'Curious about who is behind all this? I have noted your question for the team.',
        FEEDBACK: 'Thank you for the feedback! I have logged it so the team can review it.',
        LEGAL_RISK: 'I have flagged this as a priority concern and it will be reviewed immediately.',
        NARRATIVE_PARADOX: 'It seems like something in the narrative does not add up. Let me look into that.',
        EXISTENTIAL_CRISIS: 'That is a deep question about your existence. Let me think about how to help.',
        RELATIONSHIP_CONFLICT: 'It sounds like there is some tension. Let me see what I can do.',
        PRODUCT_CURIOSITY: 'Welcome! You seem curious about what this place is. I would love to show you around.',
        HOW_TO_START: 'Want to know how to get started? Let me walk you through it.',
        WHAT_IS_THIS: 'Welcome to The Expanse! This is an interactive learning universe. I am Claude the Tanuki, your guide.'
      };

      const responseText = HELPDESK_RESPONSES[helpdeskIntent]
        || 'I noticed you need some help outside the usual conversation. I have flagged it.';

      contentBlocks.unshift({
        type: 'helpdesk',
        content: responseText,
        rank: RANK_HELPDESK_PRIORITY,
        source: 'helpdesk_world_break',
        meta: {
          mode: helpdeskMode,
          intent: helpdeskIntent,
          userType: helpdeskUserType,
          strength: helpdeskResult.strength
        }
      });

      logger.info('Helpdesk world break response added', {
        correlationId,
        mode: helpdeskMode,
        intent: helpdeskIntent,
        userType: helpdeskUserType,
        strength: helpdeskResult.strength
      });
    }

    logger.debug('Content blocks built', {
      correlationId,
      blockCount: contentBlocks.length,
      types: contentBlocks.map(b => b.type)
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  5. Apply LTLM styling via Storyteller                               */
    /* ──────────────────────────────────────────────────────────────────── */

    let styledOutput = null;
    let storytellerMeta = null;

    if (!skipLtlm && contentBlocks.length > 0 && Storyteller?.buildStorytellerResponse) {
      try {
        const storytellerResult = await withTimeout(
          Storyteller.buildStorytellerResponse({
            intentResult: intentContext,
            emotionalSignal: emotionalMode,
            identitySignal: identityContext.mode,
            contentBlocks,
            mood: blendedMood,
            formality: responseStyle.formality,
            verbosity: responseStyle.verbosity,
            styleHint: responseStyle.primary
          }),
          RETRIEVAL_TIMEOUT_MS,
          'Storyteller.buildStorytellerResponse'
        );

        if (storytellerResult?.output && storytellerResult.storytellerMeta?.usedStoryteller) {
          styledOutput = storytellerResult.output;
          storytellerMeta = storytellerResult.storytellerMeta;
          logger.debug('Storyteller styling applied', { correlationId });
        }
      } catch (err) {
        logger.error('Storyteller error', { correlationId, error: err.message });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  5b. Handle positive emotion (fires when Storyteller did not style) */
    /* ──────────────────────────────────────────────────────────────────── */

    const isPositiveEmotion = turnState.flags?.positiveEmotionDetected === true;
    const postureIsEmpathetic = turnState.diagnosticReport?.postureRecommendation === "empathetic";

    if (isPositiveEmotion && dependencies?.LtlmUtteranceSelector) {
      try {
        const positiveLtlm = await withTimeout(
          dependencies.LtlmUtteranceSelector.selectLtlmUtteranceForBeat({
            speakerCharacterId,
            speechActCode: "expressive",
            dialogueFunctionCode: "expressive.celebrate",
            outcomeIntentCode: "emotional_outcomes.amplify_joy",
            targetPad: blendedMood
          }),
          RETRIEVAL_TIMEOUT_MS,
          "LtlmUtteranceSelector.positiveEmotion"
        );

        if (positiveLtlm?.utteranceText) {
          styledOutput = positiveLtlm.utteranceText;
          logger.info("Positive emotion styled", {
            correlationId,
            postureIsEmpathetic,
            dialogueFunction: "expressive.celebrate",
            utteranceId: positiveLtlm.trainingExampleId
          });
        }
      } catch (positiveErr) {
        logger.warn("Positive emotion LTLM selection failed", { correlationId, error: positiveErr.message });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  6. Fallback chain (Goal 4: Claude NEVER goes silent)                */
    /*                                                                      */
    /*  Tier 1: Styled output from Storyteller                             */
    /*  Tier 2: Raw content blocks concatenated                            */
    /*  Tier 3: Hard fallback (deterministic rotation)                     */
    /*                                                                      */
    /*  v009 returned "" causing silence. v010 guarantees non-empty output. */
    /* ──────────────────────────────────────────────────────────────────── */

    const rawBlocksText = blocksToText(contentBlocks);
    let finalOutput = styledOutput || rawBlocksText || '';
    let fallbackUsed = false;

    if (finalOutput.trim().length === 0 && dependencies?.LtlmUtteranceSelector) {
      try {
        const genericResult = await withTimeout(
          dependencies.LtlmUtteranceSelector.selectLtlmUtteranceForBeat({
            speakerCharacterId,
            speechActCode: 'assertive.inform',
            dialogueFunctionCode: 'responsive.acknowledge_information',
            outcomeIntentCode: 'clarity',
            targetPad: blendedMood
          }),
          RETRIEVAL_TIMEOUT_MS,
          'LtlmUtteranceSelector.genericFallback'
        );
        if (genericResult?.utteranceText) {
          finalOutput = genericResult.utteranceText;
          Counters.increment('voice_ltlm_generic_fallback', 'success');
          logger.debug('LTLM generic fallback used', { correlationId });
        }
      } catch (genericErr) {
        logger.warn('LTLM generic fallback failed', { correlationId, error: genericErr.message });
      }
    }

    if (finalOutput.trim().length === 0) {
      finalOutput = selectHardFallback(turnState.turnIndex);
      fallbackUsed = true;
      Counters.increment('voice_hard_fallback', 'silence_prevented');
      logger.info('Hard fallback activated — silence prevented', {
        correlationId,
        turnIndex: turnState.turnIndex,
        blockCount: contentBlocks.length
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  7. Clamp and finalize confidence                                    */
    /* ──────────────────────────────────────────────────────────────────── */

    const rawConfidence = intentContext.confidence ?? 0;
    const finalConfidence = fallbackUsed
      ? CONFIDENCE_FLOOR
      : clampConfidence(rawConfidence);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  7b. Sanitise unsubstituted LTLM placeholders                      */
    /*                                                                      */
    /*  LTLM utterances may contain <PLACEHOLDER> tags intended for         */
    /*  substitution by the selecting phase. Any that survive to this       */
    /*  point were not filled — strip the sentence containing them rather   */
    /*  than expose raw tags to the user.                                   */
    /* ──────────────────────────────────────────────────────────────────── */

    const _PLACEHOLDER_RE = /<[A-Z][A-Z_]{0,30}>/;
    if (_PLACEHOLDER_RE.test(finalOutput)) {
      const cleanedSentences = finalOutput
        .split(/(?<=[.!?…])\s+/)
        .filter(s => !_PLACEHOLDER_RE.test(s));
      finalOutput = cleanedSentences.join(' ').trim();
      logger.debug('Placeholder sanitiser fired', { correlationId, before: finalOutput.length });
    }


    /* ──────────────────────────────────────────────────────────────────── */
    /*  8. Build responseIntent                                             */
    /* ──────────────────────────────────────────────────────────────────── */

    const responseIntent = {
      success: true,
      output: finalOutput,
      source: styledOutput ? 'LTLM' : fallbackUsed ? 'hard_fallback' : 'raw',
      confidence: finalConfidence,
      intentType: intentContext.type || null,
      intentMode: intentContext.mode || null,
      entity: entity || null,
      image: imageUrl,
      knowledgeResult: knowledgeResult || null,
      storytellerMeta,
      contentBlockCount: contentBlocks.length,
      fallbackUsed,
      voiceParams: {
        emotionalMode,
        identityMode: identityContext.mode || null,
        blendedMood,
        baseMoodSource: compositeEmotionalState ? 'diagnosticReport' : 'default',
        ltlmApplied: Boolean(styledOutput),
        skippedLtlm: skipLtlm,
        formality: responseStyle.formality,
        verbosity: responseStyle.verbosity
      }
    };

    Counters.increment('voice_response_source', responseIntent.source);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  9. Return responseIntent (final phase)                              */
    /* ──────────────────────────────────────────────────────────────────── */

    logger.debug('Complete', {
      correlationId,
      source: responseIntent.source,
      confidence: finalConfidence,
      hasOutput: true,
      blockCount: contentBlocks.length,
      fallbackUsed
    });

    return {
      responseIntent
    };
  }
};

export default PhaseVoice;
