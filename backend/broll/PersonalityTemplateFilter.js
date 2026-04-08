/**
 * ===========================================================================
 * PersonalityTemplateFilter.js — OCEAN-Weighted Template Selection
 * ===========================================================================
 * Version: 2
 * Last Modified: 2026-03-07
 *
 * WHAT THIS MODULE IS:
 * --------------------------------------------------------------------------
 * Selects and modifies speech templates based on a B-Roll character's OCEAN
 * personality profile. Given a list of candidate templates (already filtered
 * by dialogue function family + developmental stage), this module:
 *
 *   1. Scores each template against the character's OCEAN traits
 *   2. Selects the best-matching template deterministically
 *   3. Applies surface-level prosody modifications based on personality
 *
 * This is Step 4 (Personality Filter) in the 9-step Vocabulary Constructor
 * pipeline defined in Final Spec Section 5.1.
 *
 * TWO LAYERS OF PERSONALITY INFLUENCE:
 * --------------------------------------------------------------------------
 * Layer 1 — Template Selection Bias:
 *   Each speech_template has a personality_bias JSONB column that declares
 *   which OCEAN trait-directions favour it. A template with
 *   {"high_neuroticism": 0.8, "low_conscientiousness": 0.5} scores higher
 *   for anxious, chaotic characters. Templates with null/empty bias are
 *   neutral — available to all characters equally (score 0).
 *
 * Layer 2 — Surface Realisation Modification:
 *   After a template is selected, personality modifies the final output
 *   string with prosody markers. This is applied to the assembled utterance,
 *   not the template itself. From Final Spec Section 5.1, Step 4:
 *
 *     High Neuroticism (N > highThreshold):  Add ... and ? (hesitation)
 *     High Extraversion (E > highThreshold): Add ! and word repetition
 *     Low Agreeableness (A < lowThreshold):  Template bias only (no surface)
 *     Low Conscientiousness (C < lowThreshold): Template bias only (no surface)
 *     High Openness (O > highThreshold): Template bias only (no surface)
 *
 * MODIFIER INTERACTION PRECEDENCE:
 * --------------------------------------------------------------------------
 * When a character has both High-N and High-E (e.g. anxious but loud),
 * neuroticism runs first, then extraversion. Neuroticism's trailing ...
 * or ...? takes precedence over extraversion's ! because hesitation is
 * the stronger signal — an anxious extrovert still hesitates, just louder.
 * Extraversion's word-doubling still applies (they repeat, but uncertainly).
 *
 * SURFACE THRESHOLDS:
 * --------------------------------------------------------------------------
 * Surface modifiers use two tiers derived from the configurable thresholds:
 *   - Standard tier: score > highThreshold (default 60)
 *   - Intense tier:  score > highThreshold + VERY_HIGH_OFFSET (default 60+20=80)
 * The intense tier produces stronger markers (N adds ...? instead of ...,
 * E adds word doubling instead of just !). Both tiers are configurable.
 *
 * DETERMINISM:
 * --------------------------------------------------------------------------
 * No Math.random(). When multiple templates tie in score, the tiebreaker
 * uses a djb2 hash of characterId + templateId, with a final localeCompare
 * fallback if hashes collide. Same character always picks the same template
 * from identical candidates.
 *
 * WHAT THIS MODULE IS NOT:
 * --------------------------------------------------------------------------
 * - Not a template database. Templates come from VocabularyConstructor
 *   which queries speech_templates by family + stage.
 * - Not a slot filler. VocabularyConstructor fills template slots.
 * - Not a PAD modifier. PAD prosody is Step 8, separate from OCEAN.
 * - Not an idiolect applicator. character_idiolect quirks are Step 7.
 *
 * PERSONALITY_BIAS JSONB FORMAT:
 * --------------------------------------------------------------------------
 * Expected keys are trait-direction pairs:
 *   high_openness, low_openness
 *   high_conscientiousness, low_conscientiousness
 *   high_extraversion, low_extraversion
 *   high_agreeableness, low_agreeableness
 *   high_neuroticism, low_neuroticism
 *
 * Values are affinity weights (0.0 to 1.0). Higher = stronger preference.
 * Invalid keys are silently skipped. Invalid weights are skipped with a
 * debug trace entry when debug mode is active.
 *
 * SCORING ALGORITHM:
 * --------------------------------------------------------------------------
 * For each template, for each trait-direction in its personality_bias:
 *   1. Check if the character matches that direction
 *      (high = score > highThreshold, low = score < lowThreshold)
 *   2. If matched, compute intensity = distance from threshold / range
 *   3. Template score += weight * intensity
 *
 * Intensity rewards extreme personalities more than borderline ones.
 * A character with N=95 scores higher on high_neuroticism templates than
 * one with N=65, even though both are "high."
 *
 * SCALE EXPECTATION:
 * --------------------------------------------------------------------------
 * Called once per utterance construction. Candidate lists are 3-15 entries.
 * O(n*m) where n=templates, m=trait-directions. Trivial at any scale.
 *
 * DEPENDENCIES:
 * --------------------------------------------------------------------------
 *   - pool.js (PostgreSQL connection — for fetching OCEAN scores)
 *   - logger.js (structured logging)
 *   - hexIdGenerator.js (isValidHexId for input validation)
 *
 * REFERENCES:
 * --------------------------------------------------------------------------
 *   - V010_FINAL_SPEC_BRoll_Autonomous_Speech.md (Section 5.1, Steps 3-4)
 *   - Mairesse, F. and Walker, M.A. (2011). Controlling user perceptions
 *     of linguistic style. Computational Linguistics.
 *   - Tausczik, Y.R. and Pennebaker, J.W. (2010). The psychological
 *     meaning of words. Journal of Language and Social Psychology.
 *
 * REVIEW HISTORY:
 * --------------------------------------------------------------------------
 * v1: Initial implementation. Three independent reviews scored 95, 89, 94.
 * v2: Addressed all consensus findings:
 *     - Added OCEAN range validation (Reviews 2, 3)
 *     - Fixed hardcoded 80 threshold — now derived from configurable
 *       highThreshold + VERY_HIGH_OFFSET (Review 2)
 *     - Added onTemplateSelected callback (Reviews 1, 2, 3)
 *     - Added candidate validation (Review 3)
 *     - Added DEFAULT_NEUTRAL_OCEAN for null ocean handling (Review 3)
 *     - Added localeCompare fallback in sort comparator (Review 3)
 *     - Defined modifier interaction precedence (Review 3)
 *     - Extracted magic numbers to named constants (Review 2)
 *     - Log selected template personality_bias in trace (Review 1)
 *     - Added review history in header (Review 1)
 *
 * ===========================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';

const MODULE_NAME = 'PersonalityTemplateFilter';
const logger = createModuleLogger(MODULE_NAME);

const DEFAULT_QUERY_TIMEOUT_MS = 5000;

const DEFAULT_HIGH_THRESHOLD = 60;
const DEFAULT_LOW_THRESHOLD = 40;
const VERY_HIGH_OFFSET = 20;
const OCEAN_MIN = 0;
const OCEAN_MAX = 100;

const DEFAULT_NEUTRAL_OCEAN = Object.freeze({
    openness: 50,
    conscientiousness: 50,
    extraversion: 50,
    agreeableness: 50,
    neuroticism: 50
});

const OCEAN_TRAITS = Object.freeze([
    'openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'
]);

const TRAIT_DIRECTION_MAP = Object.freeze({
    high_openness: { trait: 'openness', direction: 'high' },
    low_openness: { trait: 'openness', direction: 'low' },
    high_conscientiousness: { trait: 'conscientiousness', direction: 'high' },
    low_conscientiousness: { trait: 'conscientiousness', direction: 'low' },
    high_extraversion: { trait: 'extraversion', direction: 'high' },
    low_extraversion: { trait: 'extraversion', direction: 'low' },
    high_agreeableness: { trait: 'agreeableness', direction: 'high' },
    low_agreeableness: { trait: 'agreeableness', direction: 'low' },
    high_neuroticism: { trait: 'neuroticism', direction: 'high' },
    low_neuroticism: { trait: 'neuroticism', direction: 'low' }
});

function djb2Hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash;
}

export default class PersonalityTemplateFilter {

    constructor(dbPool, opts = {}) {
        this.pool = dbPool ?? pool;
        this.queryTimeoutMs = opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
        this.highThreshold = opts.highThreshold ?? DEFAULT_HIGH_THRESHOLD;
        this.lowThreshold = opts.lowThreshold ?? DEFAULT_LOW_THRESHOLD;
        this.veryHighThreshold = this.highThreshold + VERY_HIGH_OFFSET;
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

    _validateOcean(ocean) {
        if (!ocean || typeof ocean !== 'object') {
            throw new TypeError(
                `${MODULE_NAME}: ocean must be a non-null object`
            );
        }
        for (const trait of OCEAN_TRAITS) {
            const val = ocean[trait];
            if (val === null || val === undefined) continue;
            if (typeof val !== 'number' || !Number.isFinite(val)) {
                throw new TypeError(
                    `${MODULE_NAME}: ocean.${trait} must be a number, got ${typeof val}`
                );
            }
            if (val < OCEAN_MIN || val > OCEAN_MAX) {
                throw new RangeError(
                    `${MODULE_NAME}: ocean.${trait} must be ${OCEAN_MIN}-${OCEAN_MAX}, got ${val}`
                );
            }
        }
    }

    _validateCandidate(template, index) {
        if (!template || typeof template !== 'object') {
            throw new TypeError(
                `${MODULE_NAME}: candidates[${index}] must be a non-null object`
            );
        }
        if (!template.id || typeof template.id !== 'string') {
            throw new TypeError(
                `${MODULE_NAME}: candidates[${index}].id must be a non-empty string`
            );
        }
    }

    async getOceanProfile(characterId, opts = {}) {
        this._validateHexId(characterId, 'characterId');

        try {
            const result = await this._query(
                `SELECT openness, conscientiousness, extraversion,
                        agreeableness, neuroticism
                 FROM character_personality
                 WHERE character_id = $1`,
                [characterId],
                opts,
                'getOceanProfile'
            );

            if (result.rows.length === 0) return null;

            return result.rows[0];

        } catch (error) {
            logger.error('getOceanProfile failed', error, {
                characterId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    selectTemplate(candidates, ocean, characterId, opts = {}) {
        const debug = opts.debug === true;
        const onTemplateSelected = typeof opts.onTemplateSelected === 'function'
            ? opts.onTemplateSelected : null;
        const trace = debug ? [] : null;

        const safeOcean = ocean ?? DEFAULT_NEUTRAL_OCEAN;
        this._validateOcean(safeOcean);

        if (!candidates || candidates.length === 0) {
            if (trace) trace.push('No candidates provided. Returning null.');
            return {
                selected: null,
                score: 0,
                allScores: [],
                personalitySnapshot: safeOcean,
                ...(debug ? { trace: Object.freeze([...trace]) } : {})
            };
        }

        for (let i = 0; i < candidates.length; i++) {
            this._validateCandidate(candidates[i], i);
        }

        if (candidates.length === 1) {
            const only = candidates[0];
            if (trace) trace.push(`Single candidate ${only.id}. Selected by default.`);
            const result = {
                selected: only,
                score: 0,
                allScores: [{ templateId: only.id, score: 0 }],
                personalitySnapshot: safeOcean,
                ...(debug ? { trace: Object.freeze([...trace]) } : {})
            };
            if (onTemplateSelected) onTemplateSelected(result);
            return result;
        }

        if (trace) {
            trace.push(
                `Scoring ${candidates.length} candidates. ` +
                `OCEAN: O=${safeOcean.openness}, C=${safeOcean.conscientiousness}, ` +
                `E=${safeOcean.extraversion}, A=${safeOcean.agreeableness}, N=${safeOcean.neuroticism}.`
            );
        }

        const scored = candidates.map(template => {
            const score = this._scoreTemplate(template, safeOcean, trace);
            return { template, score, templateId: template.id };
        });

        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const hashA = djb2Hash(characterId + a.templateId);
            const hashB = djb2Hash(characterId + b.templateId);
            if (hashA !== hashB) return hashB - hashA;
            return a.templateId.localeCompare(b.templateId);
        });

        const selected = scored[0];
        const hadTiebreak = scored.length > 1 && scored[0].score === scored[1].score;

        if (trace) {
            trace.push(
                `Selected: ${selected.templateId} (score=${selected.score.toFixed(4)}` +
                `${hadTiebreak ? ', via tiebreaker' : ''}). ` +
                `Bias: ${JSON.stringify(selected.template.personality_bias ?? null)}.` +
                (scored.length > 1
                    ? ` Runner-up: ${scored[1].templateId} (score=${scored[1].score.toFixed(4)}).`
                    : '')
            );
        }

        const result = {
            selected: selected.template,
            score: +selected.score.toFixed(4),
            allScores: scored.map(s => ({ templateId: s.templateId, score: +s.score.toFixed(4) })),
            personalitySnapshot: safeOcean,
            hadTiebreak,
            ...(debug ? { trace: Object.freeze([...trace]) } : {})
        };

        if (onTemplateSelected) onTemplateSelected(result);

        return result;
    }

    applySurfaceModifications(utterance, ocean, opts = {}) {
        const debug = opts.debug === true;
        const trace = debug ? [] : null;

        if (!utterance || typeof utterance !== 'string') {
            return {
                modified: utterance ?? '',
                modifications: [],
                ...(debug ? { trace: Object.freeze(['No utterance to modify.']) } : {})
            };
        }

        const safeOcean = ocean ?? DEFAULT_NEUTRAL_OCEAN;

        let modified = utterance;
        const modifications = [];

        if (trace) {
            trace.push(
                `Input: "${utterance}". ` +
                `O=${safeOcean.openness}, C=${safeOcean.conscientiousness}, ` +
                `E=${safeOcean.extraversion}, A=${safeOcean.agreeableness}, N=${safeOcean.neuroticism}. ` +
                `Thresholds: high=${this.highThreshold}, veryHigh=${this.veryHighThreshold}.`
            );
        }

        // Neuroticism runs FIRST. Hesitation is the dominant signal —
        // an anxious extrovert still hesitates, just louder.
        if (safeOcean.neuroticism > this.highThreshold) {
            modified = this._applyNeuroticismSurface(modified, safeOcean.neuroticism);
            modifications.push('high_neuroticism_hesitation');
            if (trace) trace.push(`Applied high_neuroticism_hesitation: "${modified}".`);
        }

        // Extraversion runs SECOND. Adds emphasis and word doubling.
        // If neuroticism already added ... or ...?, extraversion will not
        // override that punctuation (questions and trailing ... are preserved).
        if (safeOcean.extraversion > this.highThreshold) {
            modified = this._applyExtraversionSurface(modified, safeOcean.extraversion);
            modifications.push('high_extraversion_emphasis');
            if (trace) trace.push(`Applied high_extraversion_emphasis: "${modified}".`);
        }

        return {
            modified,
            modifications,
            ...(debug ? { trace: Object.freeze([...trace]) } : {})
        };
    }

    _scoreTemplate(template, ocean, trace) {
        const bias = template.personality_bias;
        if (!bias || typeof bias !== 'object' || Object.keys(bias).length === 0) {
            return 0;
        }

        let score = 0;

        for (const [traitDirection, weight] of Object.entries(bias)) {
            const mapping = TRAIT_DIRECTION_MAP[traitDirection];
            if (!mapping) {
                if (trace) {
                    trace.push(`  ${template.id}: unknown trait direction "${traitDirection}", skipped.`);
                }
                continue;
            }

            const traitScore = ocean[mapping.trait];
            if (traitScore === null || traitScore === undefined) continue;

            const numWeight = Number(weight);
            if (!Number.isFinite(numWeight) || numWeight <= 0) {
                if (trace) {
                    trace.push(`  ${template.id}: invalid weight for ${traitDirection}: ${weight}, skipped.`);
                }
                continue;
            }

            let intensity = 0;

            if (mapping.direction === 'high' && traitScore > this.highThreshold) {
                intensity = (traitScore - this.highThreshold) / (OCEAN_MAX - this.highThreshold);
            } else if (mapping.direction === 'low' && traitScore < this.lowThreshold) {
                intensity = (this.lowThreshold - traitScore) / this.lowThreshold;
            }

            if (intensity > 0) {
                const contribution = numWeight * intensity;
                score += contribution;

                if (trace) {
                    trace.push(
                        `  ${template.id}: ${traitDirection} weight=${numWeight}, ` +
                        `trait=${mapping.trait}=${traitScore}, intensity=${intensity.toFixed(3)}, ` +
                        `contribution=${contribution.toFixed(4)}.`
                    );
                }
            }
        }

        return score;
    }

    _applyNeuroticismSurface(utterance, neuroticismScore) {
        let text = utterance.trimEnd();
        const lastChar = text.slice(-1);
        const isIntense = neuroticismScore > this.veryHighThreshold;

        if (lastChar === '?') {
            return text;
        }

        if (lastChar === '!') {
            return text.slice(0, -1) + '...';
        }

        if (lastChar === '.') {
            text = text.slice(0, -1);
        }

        return isIntense ? text + '...?' : text + '...';
    }

    _applyExtraversionSurface(utterance, extraversionScore) {
        let text = utterance.trimEnd();
        const lastChar = text.slice(-1);
        const isIntense = extraversionScore > this.veryHighThreshold;

        // Neuroticism markers (... and ...?) take precedence.
        // Do not replace trailing hesitation with exclamation.
        if (lastChar === '?') {
            return isIntense ? this._addWordDoubling(text) : text;
        }

        if (text.endsWith('...')) {
            return isIntense ? this._addWordDoubling(text) : text;
        }

        if (lastChar === '.') {
            text = text.slice(0, -1) + '!';
        } else if (lastChar !== '!') {
            text = text + '!';
        }

        if (isIntense) {
            text = this._addWordDoubling(text);
        }

        return text;
    }

    _addWordDoubling(text) {
        const words = text.split(/\s+/);
        if (words.length > 0) {
            const firstWord = words[0].replace(/[.!?,;:]+$/, '');
            if (firstWord.length > 0) {
                text = text + ' ' + firstWord + '!';
            }
        }
        return text;
    }
}
