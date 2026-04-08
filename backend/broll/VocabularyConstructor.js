/**
 * ===========================================================================
 * VocabularyConstructor.js — B-Roll Speech Assembly Pipeline (System B)
 * ===========================================================================
 * Version: 3
 * Last Modified: 2026-03-07
 *
 * WHAT THIS MODULE IS:
 * --------------------------------------------------------------------------
 * The core speech assembly engine for B-Roll characters. Given a character
 * and a dialogue function, this module executes a 9-step pipeline to produce
 * a constrained natural language utterance built entirely from words the
 * character has been taught and still remembers.
 *
 * Characters can ONLY say words they know. No word is ever invented.
 * If no template can be satisfied, the character falls back to a single
 * word or a pre-verbal object sound.
 *
 * THE 9-STEP PIPELINE (Final Spec Section 5.1):
 * --------------------------------------------------------------------------
 * Step 1 — Inventory Query:
 *   Pull productive vocabulary with live retrievability from FSRSMultiLearner.
 *   Counts by knowledge type are derived from this same result (no second query).
 *
 * Step 2 — Determine Developmental Stage:
 *   Feed counts to DevelopmentalStageClassifier.
 *
 * Step 3 — Select Template:
 *   Fetch speech_templates by dialogue function family + stage.
 *   Templates are cached in memory with configurable TTL (rarely change).
 *
 * Step 4 — Personality Filter:
 *   Score and select best-matching template via PersonalityTemplateFilter.
 *
 * Step 5 — Slot Filling:
 *   For each slot in the template, find matching words from inventory
 *   via vocabulary_slot_mappings junction table (not semantic tags).
 *
 * Step 6 — Template Backoff:
 *   If a required slot has no candidates, cascade to a simpler template.
 *   If nothing works, fall to holophrastic. If vocab is zero, pre-verbal.
 *
 * Step 7 — Idiolect Application:
 *   Apply character-specific speech quirks from character_idiolect.
 *   Only quirks whose activation_vocabulary_min is met by current vocab size.
 *   Pattern types: preferred_opener (prepend), verbal_tic (append),
 *   sentence_ender (replace final punctuation).
 *
 * Step 8 — PAD Prosody:
 *   Apply emotional colouring based on PAD coordinates.
 *
 * Step 9 — Log and Deliver:
 *   Store utterance in character_utterances with full provenance.
 *
 * SLOT FILLING VIA VOCABULARY_SLOT_MAPPINGS:
 * --------------------------------------------------------------------------
 * Each word in the productive inventory is mapped to template slots via
 * the vocabulary_slot_mappings junction table (vocabulary_id → slot_type).
 * The slot map is built by querying this table for all knowledge IDs in
 * the current inventory. This is the canonical source — not semantic tags.
 *
 * DUPLICATE SLOT HANDLING:
 * --------------------------------------------------------------------------
 * Templates may contain the same slot multiple times (e.g. "[WORD] [WORD]").
 * Slot filling uses positional reconstruction (split/replace by index) to
 * ensure each occurrence is filled independently. A word used in one slot
 * position is excluded from subsequent positions to avoid repetition
 * (unless the inventory has only one candidate for that slot type).
 *
 * TEMPLATE CACHING:
 * --------------------------------------------------------------------------
 * speech_templates are loaded from DB and cached in memory with a
 * configurable TTL (default 5 minutes). Templates are append-only
 * configuration data that rarely changes. Cache invalidation happens
 * on TTL expiry or via invalidateTemplateCache().
 *
 * TRANSACTION DISCIPLINE:
 * --------------------------------------------------------------------------
 * The pipeline performs one write (_logUtterance INSERT). All other steps
 * are reads. The caller should wrap constructUtterance in a transaction
 * if atomicity with other operations (e.g. updating teaching queue) is
 * required. The opts.client parameter is passed through to all DB calls.
 *
 * DETERMINISM:
 * --------------------------------------------------------------------------
 * No Math.random() anywhere. Slot filling uses highest retrievability
 * then djb2 hash tiebreaker. Template selection uses PersonalityFilter's
 * deterministic scoring. Same inputs always produce same utterance.
 *
 * NARRATION MODES (Final Spec Section 15):
 * --------------------------------------------------------------------------
 * Determined by HUMAN USER belt level (not character's):
 *   atmospheric: White user belt. Claude describes the character's state.
 *   paraphrase: Blue-Purple user belt. Claude paraphrases what was said.
 *   quote: Brown-Black user belt. Claude quotes the raw utterance.
 *
 * SCALE EXPECTATION:
 * --------------------------------------------------------------------------
 * 100+ B-Roll characters with occasional speech events. The heaviest
 * operation is the inventory query (SQL-optimised in FSRSMultiLearner).
 * Template cache eliminates one DB round-trip. Counts derived from
 * inventory eliminates another. Total: 5 queries per utterance
 * (inventory, slot mappings, OCEAN profile, idiolect, INSERT).
 *
 * MAX UTTERANCE LENGTH:
 * --------------------------------------------------------------------------
 * Final assembled utterance is capped at MAX_UTTERANCE_LENGTH characters
 * as a safety guardrail against malformed templates producing unbounded
 * output. Default 500 characters — no B-Roll utterance should be longer.
 *
 * DEPENDENCIES:
 * --------------------------------------------------------------------------
 *   - FSRSMultiLearner.js (inventory queries)
 *   - DevelopmentalStageClassifier.js (stage classification)
 *   - PersonalityTemplateFilter.js (template selection, surface mods)
 *   - pool.js (PostgreSQL)
 *   - logger.js (structured logging)
 *   - hexIdGenerator.js (utterance IDs)
 *
 * REFERENCES:
 * --------------------------------------------------------------------------
 *   - V010_FINAL_SPEC_BRoll_Autonomous_Speech.md (Sections 5, 5.1-5.5, 15)
 *   - Reiter, E. and Dale, R. (2000). Building NLG Systems.
 *   - Brown, R. (1973). A first language: The early stages.
 *
 * REVIEW HISTORY:
 * --------------------------------------------------------------------------
 * v1: Initial implementation. Three independent reviews scored 96, 84, 88.
 * v2: Addressed all consensus findings:
 *     - Fixed slot mapping: queries vocabulary_slot_mappings (Reviews 2, 3)
 *     - Fixed duplicate slot replacement with positional reconstruction
 *     - Split constructUtterance into step methods (Reviews 1, 3)
 *     - Added template cache, derived counts, per-step timing
 *     - Added onUtteranceConstructed callback, injectable thresholds
 * v3: Fixed P0 regression caught by reviewer:
 *     - Restored idiolect step (_stepApplyIdiolect) to main pipeline.
 *       v2 had a comment "Step 7 handled inline" but never called it.
 *       Characters would have lost speech quirks. Now async step method
 *       called between slot fill and surface modifications.
 *
 * ===========================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { classify } from './DevelopmentalStageClassifier.js';
import FSRSMultiLearner from './FSRSMultiLearner.js';
import PersonalityTemplateFilter from './PersonalityTemplateFilter.js';

const MODULE_NAME = 'VocabularyConstructor';
const logger = createModuleLogger(MODULE_NAME);

const DEFAULT_QUERY_TIMEOUT_MS = 8000;
const DEFAULT_TEMPLATE_CACHE_TTL_MS = 300000;
const MAX_UTTERANCE_LENGTH = 500;

const SLOT_REGEX = /\[([A-Z_]+)\]/g;

const STAGE_BACKOFF_ORDER = Object.freeze([
    'complex',
    'multiword',
    'telegraphic',
    'two_word',
    'holophrastic'
]);

const DEFAULT_PAD_THRESHOLDS = Object.freeze({
    LOW_PLEASURE: -0.3,
    HIGH_PLEASURE: 0.3,
    HIGH_AROUSAL: 0.3,
    LOW_AROUSAL: -0.3,
    HIGH_DOMINANCE: 0.3,
    LOW_DOMINANCE: -0.3
});

const DEFAULT_NARRATION_MODE_MAP = Object.freeze({
    white: 'atmospheric',
    blue: 'paraphrase',
    purple: 'paraphrase',
    brown: 'quote',
    black: 'quote'
});

function djb2Hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash;
}

export default class VocabularyConstructor {

    constructor(opts = {}) {
        this.pool = opts.dbPool ?? pool;
        this.queryTimeoutMs = opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
        this.fsrs = opts.fsrsLearner ?? new FSRSMultiLearner(this.pool);
        this.personality = opts.personalityFilter ?? new PersonalityTemplateFilter(this.pool);
        this.padThresholds = opts.padThresholds ?? DEFAULT_PAD_THRESHOLDS;
        this.narrationModeMap = opts.narrationModeMap ?? DEFAULT_NARRATION_MODE_MAP;
        this._templateCache = new Map();
        this._templateCacheTtlMs = opts.templateCacheTtlMs ?? DEFAULT_TEMPLATE_CACHE_TTL_MS;
    }

    async _query(sql, params = [], opts = {}, methodLabel = 'unknown') {
        const executor = opts.client ?? this.pool;

        const queryPromise = executor.query(sql, params);
        const timeoutPromise = new Promise((_, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(
                    `${MODULE_NAME}.${methodLabel}: query timeout after ${this.queryTimeoutMs}ms`
                ));
            }, this.queryTimeoutMs);
            queryPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
        });

        return Promise.race([queryPromise, timeoutPromise]);
    }

    _validateHexId(value, name) {
        if (!value || !isValidHexId(value)) {
            throw new Error(
                `${MODULE_NAME}: invalid ${name} — expected #XXXXXX hex format, got: ${value}`
            );
        }
    }

    _nowMs() {
        return Date.now();
    }

    invalidateTemplateCache() {
        this._templateCache.clear();
        logger.debug('Template cache invalidated');
    }

    async constructUtterance(params, opts = {}) {
        const { characterId, dialogueFunctionFamily } = params;
        const pad = params.pad ?? { pleasure: 0, arousal: 0, dominance: 0 };
        const userBelt = params.userBelt ?? 'white';
        const debug = opts.debug === true;
        const onUtteranceConstructed = typeof opts.onUtteranceConstructed === 'function'
            ? opts.onUtteranceConstructed : null;
        const trace = debug ? [] : null;
        const stepTimings = {};

        this._validateHexId(characterId, 'characterId');

        if (!dialogueFunctionFamily || typeof dialogueFunctionFamily !== 'string') {
            throw new Error(
                `${MODULE_NAME}.constructUtterance: dialogueFunctionFamily is required`
            );
        }

        try {
            const pipelineStart = this._nowMs();

            const { inventory, counts, classification } = await this._stepInventoryAndStage(
                characterId, trace, stepTimings, opts
            );

            if (classification.stageNumber === 0) {
                const result = await this._handlePreVerbal(
                    characterId, pad, userBelt, classification, trace, opts
                );
                if (onUtteranceConstructed) onUtteranceConstructed(result);
                return result;
            }

            const candidates = await this._stepFetchTemplates(
                dialogueFunctionFamily, classification.stageName, trace, stepTimings, opts
            );

            const { ocean, templateSelection } = await this._stepPersonalityFilter(
                candidates, characterId, debug, trace, stepTimings, opts
            );

            const slotMap = await this._stepBuildSlotMap(inventory, trace, stepTimings, opts);

            const fillResult = await this._stepSlotFillWithBackoff(
                templateSelection.selected, candidates, slotMap, inventory,
                classification, dialogueFunctionFamily, characterId, ocean,
                trace, stepTimings, opts
            );

            const idiolectResult = await this._stepApplyIdiolect(
                fillResult.rawUtterance, characterId,
                classification.totalProductive, trace, stepTimings, opts
            );

            const prosodyResult = this._stepApplyPadProsody(
                idiolectResult.utterance, pad, trace, stepTimings
            );

            const personalitySurface = ocean
                ? this.personality.applySurfaceModifications(prosodyResult.utterance, ocean, { debug })
                : { modified: prosodyResult.utterance, modifications: [] };

            let finalText = personalitySurface.modified;
            if (finalText.length > MAX_UTTERANCE_LENGTH) {
                finalText = finalText.slice(0, MAX_UTTERANCE_LENGTH);
            }

            const narrationMode = this.narrationModeMap[userBelt] ?? 'atmospheric';

            const utteranceRecord = await this._stepLogUtterance({
                characterId,
                utterance: finalText,
                vocabularySize: classification.totalProductive,
                developmentalStage: classification.stageName,
                templateId: fillResult.templateId,
                personalitySnapshot: templateSelection.personalitySnapshot,
                padSnapshot: pad,
                wordsUsed: fillResult.wordsUsed,
                narrationMode
            }, trace, stepTimings, opts);

            const totalMs = this._nowMs() - pipelineStart;

            if (trace) {
                trace.push(
                    `Pipeline complete: ${totalMs}ms. Steps: ${JSON.stringify(stepTimings)}.`
                );
            }

            const result = {
                utteranceId: utteranceRecord.id,
                utterance: finalText,
                rawUtterance: fillResult.rawUtterance,
                narrationMode,
                classification,
                templateId: fillResult.templateId,
                wordsUsed: fillResult.wordsUsed,
                personalitySnapshot: templateSelection.personalitySnapshot,
                padSnapshot: pad,
                modifications: {
                    idiolect: idiolectResult.applied,
                    padProsody: prosodyResult.modifications,
                    personality: personalitySurface.modifications
                },
                backoffSteps: fillResult.backoffSteps,
                totalMs,
                stepTimings,
                ...(debug ? { trace: Object.freeze([...trace]) } : {})
            };

            if (onUtteranceConstructed) onUtteranceConstructed(result);

            return result;

        } catch (error) {
            logger.error('constructUtterance failed', error, {
                characterId, dialogueFunctionFamily,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async _stepInventoryAndStage(characterId, trace, timings, opts) {
        const start = this._nowMs();

        const inventory = await this.fsrs.getProductiveInventory(characterId, opts);

        let words = 0;
        let pivots = 0;
        let operators = 0;
        for (const item of inventory) {
            if (item.zone !== 'productive' && item.zone !== 'hesitant') continue;
            if (item.knowledgeType === 'WORD') words++;
            else if (item.knowledgeType === 'PIVOT') pivots++;
            else if (item.knowledgeType === 'OPERATOR') operators++;
        }
        const counts = { words, pivots, operators };

        const classification = classify(counts);

        timings.inventoryAndStage = this._nowMs() - start;

        if (trace) {
            trace.push(
                `Step 1-2 (${timings.inventoryAndStage}ms): ` +
                `Inventory=${inventory.length}, counts={w:${words},p:${pivots},o:${operators}}, ` +
                `stage=${classification.stageName} (${classification.stageNumber}), ` +
                `belt=${classification.belt}, stripe=${classification.stripe}.` +
                (classification.grammarDowngrade
                    ? ` DOWNGRADED: ${classification.downgradeReason}`
                    : '')
            );
        }

        return { inventory, counts, classification };
    }

    async _stepFetchTemplates(family, stageName, trace, timings, opts) {
        const start = this._nowMs();
        const cacheKey = `${family}:${stageName}`;
        const cached = this._templateCache.get(cacheKey);

        if (cached && (this._nowMs() - cached.loadedAt) < this._templateCacheTtlMs) {
            timings.fetchTemplates = this._nowMs() - start;
            if (trace) {
                trace.push(
                    `Step 3 (${timings.fetchTemplates}ms): ` +
                    `${cached.rows.length} templates from cache for "${family}/${stageName}".`
                );
            }
            return cached.rows;
        }

        const result = await this._query(
            `SELECT id, dialogue_function_family, speech_act, outcome_intent,
                    stage, base_pattern, required_slots, personality_bias, example_output
             FROM speech_templates
             WHERE dialogue_function_family = $1
               AND stage = $2
             ORDER BY required_slots ASC`,
            [family, stageName],
            opts,
            'fetchTemplates'
        );

        this._templateCache.set(cacheKey, { rows: result.rows, loadedAt: this._nowMs() });

        timings.fetchTemplates = this._nowMs() - start;

        if (trace) {
            trace.push(
                `Step 3 (${timings.fetchTemplates}ms): ` +
                `${result.rows.length} templates from DB for "${family}/${stageName}".`
            );
        }

        return result.rows;
    }

    async _stepPersonalityFilter(candidates, characterId, debug, trace, timings, opts) {
        const start = this._nowMs();

        const ocean = await this.personality.getOceanProfile(characterId, opts);

        const templateSelection = this.personality.selectTemplate(
            candidates, ocean, characterId, { debug }
        );

        timings.personalityFilter = this._nowMs() - start;

        if (trace) {
            trace.push(
                `Step 4 (${timings.personalityFilter}ms): ` +
                `Selected template ${templateSelection.selected?.id ?? 'NONE'} ` +
                `(score=${templateSelection.score}).`
            );
        }

        return { ocean, templateSelection };
    }

    async _stepBuildSlotMap(inventory, trace, timings, opts) {
        const start = this._nowMs();

        const knowledgeIds = inventory.map(item => item.knowledgeId);

        if (knowledgeIds.length === 0) {
            timings.buildSlotMap = this._nowMs() - start;
            if (trace) trace.push(`Step 5a (${timings.buildSlotMap}ms): Empty inventory, empty slot map.`);
            return new Map();
        }

        const result = await this._query(
            `SELECT vocabulary_id, slot_type
             FROM vocabulary_slot_mappings
             WHERE vocabulary_id = ANY($1::text[])`,
            [knowledgeIds],
            opts,
            'buildSlotMap'
        );

        const inventoryLookup = new Map();
        for (const item of inventory) {
            inventoryLookup.set(item.knowledgeId, item);
        }

        const slotMap = new Map();
        for (const row of result.rows) {
            if (!slotMap.has(row.slot_type)) {
                slotMap.set(row.slot_type, []);
            }
            const item = inventoryLookup.get(row.vocabulary_id);
            if (item) {
                slotMap.get(row.slot_type).push(item);
            }
        }

        timings.buildSlotMap = this._nowMs() - start;

        if (trace) {
            const slotSummary = [...slotMap.entries()]
                .map(([slot, items]) => `${slot}:${items.length}`)
                .join(', ');
            trace.push(`Step 5a (${timings.buildSlotMap}ms): Slot map built. ${slotSummary}.`);
        }

        return slotMap;
    }

    async _stepSlotFillWithBackoff(
        selectedTemplate, allCandidates, slotMap, inventory,
        classification, family, characterId, ocean,
        trace, timings, opts
    ) {
        const start = this._nowMs();

        if (selectedTemplate) {
            const fillAttempt = this._attemptFill(selectedTemplate, slotMap, characterId, trace);
            if (fillAttempt.success) {
                timings.slotFill = this._nowMs() - start;
                if (trace) {
                    trace.push(
                        `Steps 5-6 (${timings.slotFill}ms): Filled primary template ` +
                        `${selectedTemplate.id}. Words: ${fillAttempt.wordsUsed.length}.`
                    );
                }
                return {
                    rawUtterance: fillAttempt.utterance,
                    templateId: selectedTemplate.id,
                    wordsUsed: fillAttempt.wordsUsed,
                    backoffSteps: 0
                };
            }
        }

        if (trace) trace.push('Step 6: Primary template failed. Starting backoff.');

        let backoffSteps = 0;
        const currentStageIndex = STAGE_BACKOFF_ORDER.indexOf(classification.stageName);
        const startIndex = currentStageIndex >= 0 ? currentStageIndex : 0;

        for (let i = startIndex; i < STAGE_BACKOFF_ORDER.length; i++) {
            const backoffStage = STAGE_BACKOFF_ORDER[i];
            backoffSteps++;

            let backoffCandidates;
            if (backoffStage === classification.stageName) {
                backoffCandidates = allCandidates.filter(t => t.id !== selectedTemplate?.id);
            } else {
                backoffCandidates = await this._stepFetchTemplates(
                    family, backoffStage, trace, timings, opts
                );
            }

            if (trace) {
                trace.push(`Backoff ${backoffSteps}: stage="${backoffStage}", ${backoffCandidates.length} candidates.`);
            }

            const reselection = ocean && backoffCandidates.length > 1
                ? this.personality.selectTemplate(backoffCandidates, ocean, characterId)
                : { selected: backoffCandidates[0] ?? null };

            if (reselection.selected) {
                const fillAttempt = this._attemptFill(reselection.selected, slotMap, characterId, trace);
                if (fillAttempt.success) {
                    timings.slotFill = this._nowMs() - start;
                    return {
                        rawUtterance: fillAttempt.utterance,
                        templateId: reselection.selected.id,
                        wordsUsed: fillAttempt.wordsUsed,
                        backoffSteps
                    };
                }
            }
        }

        if (trace) trace.push('Backoff exhausted. Holophrastic fallback.');

        timings.slotFill = this._nowMs() - start;
        return this._holophrasticFallback(inventory, characterId, trace);
    }

    _attemptFill(template, slotMap, characterId, trace) {
        const pattern = template.base_pattern;
        if (!pattern) {
            return { success: false, utterance: '', wordsUsed: [] };
        }

        const slots = [];
        let match;
        const regex = new RegExp(SLOT_REGEX.source, SLOT_REGEX.flags);
        while ((match = regex.exec(pattern)) !== null) {
            slots.push({ slot: match[1], start: match.index, end: match.index + match[0].length });
        }

        if (slots.length === 0) {
            return { success: true, utterance: pattern, wordsUsed: [] };
        }

        const wordsUsed = [];
        const usedKnowledgeIds = new Set();
        const parts = [];
        let lastEnd = 0;

        for (const { slot, start, end } of slots) {
            parts.push(pattern.slice(lastEnd, start));
            lastEnd = end;

            const candidates = slotMap.get(slot) ?? [];
            const available = candidates.filter(c => !usedKnowledgeIds.has(c.knowledgeId));

            if (available.length === 0) {
                if (trace) trace.push(`  Slot [${slot}]: no candidates. Fill failed.`);
                return { success: false, utterance: '', wordsUsed: [] };
            }

            const selected = this._selectWordForSlot(available, characterId, slot);
            parts.push(selected.lemma);
            wordsUsed.push(selected.knowledgeId);
            usedKnowledgeIds.add(selected.knowledgeId);

            if (trace) {
                trace.push(
                    `  Slot [${slot}]: "${selected.lemma}" (R=${selected.retrievability}, zone=${selected.zone}).`
                );
            }
        }

        parts.push(pattern.slice(lastEnd));
        let assembled = parts.join('');

        if (assembled.length > MAX_UTTERANCE_LENGTH) {
            assembled = assembled.slice(0, MAX_UTTERANCE_LENGTH);
            if (trace) trace.push(`  Utterance truncated to ${MAX_UTTERANCE_LENGTH} chars.`);
        }

        return { success: true, utterance: assembled, wordsUsed };
    }

    _selectWordForSlot(candidates, characterId, slotType) {
        if (candidates.length === 1) return candidates[0];

        candidates.sort((a, b) => {
            if (b.retrievability !== a.retrievability) {
                return b.retrievability - a.retrievability;
            }
            const hashA = djb2Hash(characterId + a.knowledgeId + slotType);
            const hashB = djb2Hash(characterId + b.knowledgeId + slotType);
            if (hashA !== hashB) return hashB - hashA;
            return a.knowledgeId.localeCompare(b.knowledgeId);
        });

        return candidates[0];
    }

    _holophrasticFallback(inventory, characterId, trace) {
        if (inventory.length === 0) {
            if (trace) trace.push('No inventory. Returning silence.');
            return {
                rawUtterance: '*silence*',
                templateId: null,
                wordsUsed: [],
                backoffSteps: STAGE_BACKOFF_ORDER.length
            };
        }

        const sorted = [...inventory].sort((a, b) => {
            if (b.retrievability !== a.retrievability) {
                return b.retrievability - a.retrievability;
            }
            const hashA = djb2Hash(characterId + a.knowledgeId);
            const hashB = djb2Hash(characterId + b.knowledgeId);
            if (hashA !== hashB) return hashB - hashA;
            return a.knowledgeId.localeCompare(b.knowledgeId);
        });

        const word = sorted[0];
        if (trace) trace.push(`Holophrastic: "${word.lemma}" (R=${word.retrievability}).`);

        return {
            rawUtterance: word.lemma,
            templateId: null,
            wordsUsed: [word.knowledgeId],
            backoffSteps: STAGE_BACKOFF_ORDER.length
        };
    }

    async _stepApplyIdiolect(utterance, characterId, vocabSize, trace, timings, opts) {
        const start = this._nowMs();

        try {
            const result = await this._query(
                `SELECT pattern_type, pattern, strength
                 FROM character_idiolect
                 WHERE character_id = $1
                   AND activation_vocabulary_min <= $2
                   AND pattern_type != 'preverbal_sound'
                   AND pattern_type != 'pivot_preference'
                 ORDER BY strength DESC`,
                [characterId, vocabSize],
                opts,
                'applyIdiolect'
            );

            let modified = utterance;
            const applied = [];

            for (const quirk of result.rows) {
                if (quirk.pattern_type === 'preferred_opener') {
                    modified = quirk.pattern + ' ' + modified;
                    applied.push({ type: quirk.pattern_type, pattern: quirk.pattern });
                } else if (quirk.pattern_type === 'verbal_tic') {
                    modified = modified + ' ' + quirk.pattern;
                    applied.push({ type: quirk.pattern_type, pattern: quirk.pattern });
                } else if (quirk.pattern_type === 'sentence_ender') {
                    modified = modified.replace(/[.!?]+$/, '') + quirk.pattern;
                    applied.push({ type: quirk.pattern_type, pattern: quirk.pattern });
                }
            }

            timings.idiolect = this._nowMs() - start;

            if (trace) {
                trace.push(
                    `Step 7 (${timings.idiolect}ms): ` +
                    `${applied.length > 0 ? `Applied ${applied.length} quirks. Result: "${modified}".` : 'No active quirks.'}`
                );
            }

            return { utterance: modified, applied };

        } catch (error) {
            timings.idiolect = this._nowMs() - start;
            logger.warn('Idiolect application failed, using unmodified utterance', {
                characterId, error: error.message,
                correlationId: opts?.correlationId ?? null
            });
            return { utterance, applied: [] };
        }
    }

    _stepApplyPadProsody(utterance, pad, trace, timings) {
        const start = this._nowMs();
        const result = this._applyPadProsody(utterance, pad, trace);
        timings.padProsody = this._nowMs() - start;
        return result;
    }

    _applyPadProsody(utterance, pad, trace) {
        if (!utterance || !pad) {
            return { utterance: utterance ?? '', modifications: [] };
        }

        let modified = utterance;
        const modifications = [];
        const p = pad.pleasure ?? 0;
        const a = pad.arousal ?? 0;
        const d = pad.dominance ?? 0;
        const t = this.padThresholds;

        if (p < t.LOW_PLEASURE) {
            const lastChar = modified.slice(-1);
            if (lastChar !== '.' && lastChar !== '?' && !modified.endsWith('...')) {
                modified = modified.replace(/[!]+$/, '') + '...';
                modifications.push('low_pleasure_uncertainty');
            }
        } else if (p > t.HIGH_PLEASURE) {
            modified = modified.replace(/\.{3}\??/g, '');
            if (modified.length > 0 && !/[.!?]$/.test(modified)) {
                modified = modified + '.';
            }
            modifications.push('high_pleasure_confidence');
        }

        if (a > t.HIGH_AROUSAL) {
            const lastChar = modified.slice(-1);
            if (lastChar === '.' || (lastChar !== '!' && lastChar !== '?')) {
                modified = modified.replace(/\.+$/, '') + '!';
                modifications.push('high_arousal_emphasis');
            }
        } else if (a < t.LOW_AROUSAL) {
            const clauses = modified.split(/[,;]/);
            if (clauses.length > 1) {
                modified = clauses[0].trimEnd();
                if (!/[.!?]$/.test(modified)) modified += '.';
                modifications.push('low_arousal_truncation');
            }
        }

        if (d > t.HIGH_DOMINANCE) {
            if (modified.slice(-1) === '?') {
                modified = modified.slice(0, -1) + '.';
                modifications.push('high_dominance_declarative');
            }
        } else if (d < t.LOW_DOMINANCE) {
            const lastChar = modified.slice(-1);
            if (lastChar === '.' || lastChar === '!') {
                modified = modified.slice(0, -1) + '?';
                modifications.push('low_dominance_questioning');
            }
        }

        if (trace && modifications.length > 0) {
            trace.push(
                `Step 8: PAD [p=${p}, a=${a}, d=${d}]: ` +
                `${modifications.join(', ')}. Result: "${modified}".`
            );
        }

        return { utterance: modified, modifications };
    }

    async _handlePreVerbal(characterId, pad, userBelt, classification, trace, opts) {
        const idiolectResult = await this._query(
            `SELECT pattern FROM character_idiolect
             WHERE character_id = $1 AND pattern_type = 'preverbal_sound'
             LIMIT 1`,
            [characterId],
            opts,
            'handlePreVerbal'
        );

        const sound = idiolectResult.rows[0]?.pattern ?? '*silence*';
        if (trace) trace.push(`Pre-verbal: "${sound}".`);

        const narrationMode = this.narrationModeMap[userBelt] ?? 'atmospheric';

        const utteranceRecord = await this._stepLogUtterance({
            characterId,
            utterance: sound,
            vocabularySize: 0,
            developmentalStage: 'pre_verbal',
            templateId: null,
            personalitySnapshot: null,
            padSnapshot: pad,
            wordsUsed: [],
            narrationMode
        }, trace, {}, opts);

        return {
            utteranceId: utteranceRecord.id,
            utterance: sound,
            rawUtterance: sound,
            narrationMode,
            classification,
            templateId: null,
            wordsUsed: [],
            personalitySnapshot: null,
            padSnapshot: pad,
            modifications: { idiolect: [], padProsody: [], personality: [] },
            backoffSteps: 0,
            totalMs: 0,
            stepTimings: {},
            ...(trace ? { trace: Object.freeze([...trace]) } : {})
        };
    }

    async _stepLogUtterance(data, trace, timings, opts = {}) {
        const start = this._nowMs();

        try {
            const utteranceId = await generateHexId('character_utterance_id');

            await this._query(
                `INSERT INTO character_utterances (
                    id, character_id, utterance, vocabulary_size,
                    developmental_stage, template_id,
                    personality_snapshot, pad_snapshot,
                    words_used, narration_mode, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
                [
                    utteranceId,
                    data.characterId,
                    data.utterance,
                    data.vocabularySize,
                    data.developmentalStage,
                    data.templateId,
                    data.personalitySnapshot ? JSON.stringify(data.personalitySnapshot) : null,
                    data.padSnapshot ? JSON.stringify(data.padSnapshot) : null,
                    data.wordsUsed,
                    data.narrationMode
                ],
                opts,
                'logUtterance'
            );

            if (timings) timings.logUtterance = this._nowMs() - start;

            if (trace) {
                trace.push(`Step 9 (${timings?.logUtterance ?? 0}ms): Logged as ${utteranceId}.`);
            }

            logger.info('Utterance logged', {
                utteranceId,
                characterId: data.characterId,
                stage: data.developmentalStage,
                narrationMode: data.narrationMode,
                wordCount: data.wordsUsed?.length ?? 0,
                correlationId: opts.correlationId ?? null
            });

            return { id: utteranceId };

        } catch (error) {
            logger.error('logUtterance failed', error, {
                characterId: data.characterId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }
}
