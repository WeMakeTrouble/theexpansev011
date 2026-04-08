/**
 * ===========================================================================
 * DevelopmentalStageClassifier.js — B-Roll Developmental Stage Classification
 * ===========================================================================
 * Version: 2
 * Last Modified: 2026-03-07
 *
 * WHAT THIS MODULE IS:
 * --------------------------------------------------------------------------
 * A pure logic classifier that maps a B-Roll character's productive vocabulary
 * counts to a developmental stage for speech construction. No database access,
 * no side effects, no randomness. Takes numbers in, returns classification out.
 *
 * The Vocabulary Constructor (System B) calls this to determine which speech
 * templates are available to a character. A character at stage 1 (holophrastic)
 * can only use single-word templates. A character at stage 3 (telegraphic) can
 * use Subject-Verb-Object patterns. The stage gates what grammar is available.
 *
 * GRAMMAR COMPETENCE MODIFIER:
 * --------------------------------------------------------------------------
 * Vocabulary count alone does not determine stage. A character needs sufficient
 * PIVOTs (combinatorial words like "more", "no", "what") and OPERATORs
 * (function words like "is", "the", "can") at productive retention to unlock
 * higher stages. A 60-word character with zero PIVOTs remains effectively
 * holophrastic — they have words but cannot combine them.
 *
 * This downgrade mechanism prevents characters from producing grammar they
 * have not earned. The spec calls this "grammar competence modifies stage."
 *
 * WHY TOTAL PRODUCTIVE (NOT WORDS-ONLY) DRIVES STAGE:
 * --------------------------------------------------------------------------
 * The Final Spec Section 3.2 defines belt ranges as "Productive Vocab: 1-50"
 * for White belt. The universal starter set (Section 6.1) includes PIVOTs
 * ("no", "more", "what") and OPERATORs ("is") counted toward the 50-word
 * White belt total. Words 2, 3, 4, and 6 of the first 10 are PIVOTs or
 * OPERATORs. The spec does not distinguish WORD-only counts for belt
 * thresholds — "productive vocabulary count" means all knowledge types the
 * character can produce.
 *
 * The grammar competence gate is the separate mechanism that prevents a
 * character with 60 content words but zero PIVOTs from reaching two-word
 * stage. This two-layer design (vocabulary count sets ceiling, grammar
 * competence may lower it) is intentional.
 *
 * CONFIGURABLE THRESHOLDS:
 * --------------------------------------------------------------------------
 * All stage boundaries and grammar minimums are configurable via the
 * thresholds parameter. Defaults are derived from the Final Spec belt/stripe
 * mapping and L1 acquisition research (Brown 1973, Braine 1963). The caller
 * can override any or all thresholds — from a database config table, from an
 * admin panel, from test fixtures.
 *
 * The classifier does not own these numbers. It applies them.
 *
 * SCALE EXPECTATION:
 * --------------------------------------------------------------------------
 * The system will support 100+ B-Roll characters. At 100 characters with
 * 10 classifications per second, this produces ~1,000 small objects/sec.
 * V8's generational garbage collector handles millions of short-lived objects
 * per second — no object pooling or allocation avoidance is warranted here.
 * If scale exceeds 10,000 characters, revisit this assumption.
 *
 * OBSERVABILITY:
 * --------------------------------------------------------------------------
 * The classify function accepts an optional options object with:
 *   - debug (boolean): When true, the return object includes a trace array
 *     showing each reasoning step. Useful for admin tools and diagnostics.
 *   - onDowngrade (function): Optional callback invoked when grammar
 *     competence forces a stage downgrade. Receives the full classification
 *     result. Caller is responsible for logging/metrics emission.
 *
 * The classifier itself does not import a logger or emit metrics — that is
 * the caller's responsibility. This preserves the pure function contract.
 *
 * INPUT VALIDATION:
 * --------------------------------------------------------------------------
 * The classifier uses strict input validation. If counts.words, counts.pivots,
 * or counts.operators is a non-numeric type (string, object, boolean), the
 * function throws a TypeError. This is fail-fast behaviour — if upstream data
 * is corrupted (e.g. character_knowledge_state returns a string for pivots),
 * the error surfaces immediately rather than silently treating the character
 * as pre-verbal.
 *
 * Null and undefined are accepted and treated as 0 (absent data is valid).
 * Negative numbers and NaN throw. Floats are floored to integers (no partial
 * words).
 *
 * WHAT THIS MODULE IS NOT:
 * --------------------------------------------------------------------------
 * - Not a promotion gate. Belt/stripe promotion requires the Triple Gate
 *   (vocabulary threshold + grammar competence + FSRS stability). This
 *   classifier only reports the current developmental stage for speech
 *   template selection.
 * - Not a database accessor. The caller queries character_knowledge_state
 *   and passes in the counts.
 * - Not an FSRS component. It does not read or write retrievability,
 *   stability, or difficulty values.
 * - Not a metrics emitter. The optional onDowngrade callback pushes that
 *   responsibility to the caller, preserving purity.
 *
 * EXAMPLE USAGE:
 * --------------------------------------------------------------------------
 *   import { classify } from './DevelopmentalStageClassifier.js';
 *
 *   // Basic classification
 *   const result = classify({ words: 35, pivots: 3, operators: 1 });
 *   // result.stageNumber === 2 (two_word)
 *   // result.belt === 'white'
 *   // result.stripe === 4
 *   // result.grammarDowngrade === false
 *
 *   // Grammar downgrade example
 *   const result2 = classify({ words: 55, pivots: 0, operators: 0 });
 *   // result2.vocabImpliedStage === 2 (two_word — 55 words qualifies)
 *   // result2.stageNumber === 1 (holophrastic — no PIVOTs to combine)
 *   // result2.grammarDowngrade === true
 *
 *   // With debug trace
 *   const result3 = classify(
 *     { words: 55, pivots: 0, operators: 0 },
 *     null,
 *     { debug: true }
 *   );
 *   // result3.trace === [
 *   //   'Input: words=55, pivots=0, operators=0, total=55',
 *   //   'Vocab-implied stage: 2 (two_word)',
 *   //   'Grammar gate: stage 2 requires minPivots=1, minOperators=0. Have pivots=0, operators=0. Not met.',
 *   //   'Grammar gate: stage 1 requires minPivots=0, minOperators=0. Have pivots=0, operators=0. Met.',
 *   //   'Downgraded: two_word -> holophrastic',
 *   //   'Belt: white, Stripe: 4 (totalProductive=55)'
 *   // ]
 *
 *   // With downgrade callback
 *   classify(
 *     { words: 55, pivots: 0, operators: 0 },
 *     null,
 *     { onDowngrade: (result) => logger.warn('Grammar downgrade', { result }) }
 *   );
 *
 * REFERENCES:
 * --------------------------------------------------------------------------
 * - Brown, R. (1973). A first language: The early stages.
 * - Benedict, H. (1979). Early lexical development.
 * - Braine, M.D.S. (1963). The ontogeny of English phrase structure.
 * - Bates, E. et al. (1988). From first words to grammar.
 * - Fenson, L. et al. (1994). Variability in early communicative development.
 * - V010_FINAL_SPEC_BRoll_Autonomous_Speech.md (Sections 3, 5, 7)
 *
 * REVIEW HISTORY:
 * --------------------------------------------------------------------------
 * v1: Initial implementation. Three independent reviews scored 78, 94, 92.
 * v2: Addressed all consensus findings:
 *     - Added CLASSIFIER_VERSION constant (Review 2)
 *     - Added structured debug trace via options.debug (Reviews 1, 2, 3)
 *     - Added onDowngrade callback hook via options.onDowngrade (Reviews 1, 3)
 *     - Switched to strict input validation with TypeError (Review 1)
 *     - Added invariant assertion: stageThresholds vs STAGE_DEFINITIONS (Review 2)
 *     - Added semantic consistency checks in validateThresholds (Review 1)
 *     - Added belt contiguity and stripe contiguity validation (Review 1)
 *     - Removed duplicate default+named export of classify (Review 1)
 *     - Added example invocations in JSDoc and header (Review 3)
 *     - Documented totalProductive rationale with spec citations (Review 2)
 *     - Documented scale expectation of 100+ characters (corrected from v1)
 *     - Added Math.floor for float-to-int conversion (Review 3)
 *
 * ===========================================================================
 */

const CLASSIFIER_VERSION = 2;

const STAGE_DEFINITIONS = Object.freeze([
    {
        number: 0,
        name: 'pre_verbal',
        description: 'No productive words. Character uses object sounds only.'
    },
    {
        number: 1,
        name: 'holophrastic',
        description: 'Single words function as full utterances.'
    },
    {
        number: 2,
        name: 'two_word',
        description: 'Reliable two-word combinations using pivot grammar.'
    },
    {
        number: 3,
        name: 'telegraphic',
        description: 'Content-word multi-word utterances. SVO structure emerging.'
    },
    {
        number: 4,
        name: 'multiword',
        description: 'Function words present. Auxiliaries, determiners, negation.'
    },
    {
        number: 5,
        name: 'complex',
        description: 'Subordination, modals, hedging. Full personality-driven style.'
    }
]);

const DEFAULT_THRESHOLDS = Object.freeze({
    stages: Object.freeze([
        { minVocab: 0, minPivots: 0, minOperators: 0 },
        { minVocab: 1, minPivots: 0, minOperators: 0 },
        { minVocab: 10, minPivots: 1, minOperators: 0 },
        { minVocab: 50, minPivots: 2, minOperators: 1 },
        { minVocab: 200, minPivots: 3, minOperators: 3 },
        { minVocab: 500, minPivots: 4, minOperators: 5 }
    ]),

    belts: Object.freeze([
        { name: 'white', minVocab: 1, maxVocab: 50 },
        { name: 'blue', minVocab: 51, maxVocab: 200 },
        { name: 'purple', minVocab: 201, maxVocab: 500 },
        { name: 'brown', minVocab: 501, maxVocab: 1000 },
        { name: 'black', minVocab: 1001, maxVocab: Infinity }
    ]),

    stripes: Object.freeze({
        white: Object.freeze([
            { stripe: 1, minVocab: 1, maxVocab: 5 },
            { stripe: 2, minVocab: 6, maxVocab: 15 },
            { stripe: 3, minVocab: 16, maxVocab: 30 },
            { stripe: 4, minVocab: 31, maxVocab: 50 }
        ]),
        blue: Object.freeze([
            { stripe: 1, minVocab: 51, maxVocab: 80 },
            { stripe: 2, minVocab: 81, maxVocab: 120 },
            { stripe: 3, minVocab: 121, maxVocab: 160 },
            { stripe: 4, minVocab: 161, maxVocab: 200 }
        ]),
        purple: Object.freeze([
            { stripe: 1, minVocab: 201, maxVocab: 275 },
            { stripe: 2, minVocab: 276, maxVocab: 350 },
            { stripe: 3, minVocab: 351, maxVocab: 425 },
            { stripe: 4, minVocab: 426, maxVocab: 500 }
        ]),
        brown: Object.freeze([
            { stripe: 1, minVocab: 501, maxVocab: 625 },
            { stripe: 2, minVocab: 626, maxVocab: 750 },
            { stripe: 3, minVocab: 751, maxVocab: 875 },
            { stripe: 4, minVocab: 876, maxVocab: 1000 }
        ]),
        black: Object.freeze([
            { stripe: 1, minVocab: 1001, maxVocab: 1250 },
            { stripe: 2, minVocab: 1251, maxVocab: 1500 },
            { stripe: 3, minVocab: 1501, maxVocab: 1750 },
            { stripe: 4, minVocab: 1751, maxVocab: Infinity }
        ])
    })
});

/**
 * Classifies a B-Roll character's developmental stage based on their
 * productive vocabulary counts and grammar competence.
 *
 * @param {Object} counts - Productive vocabulary counts for the character.
 * @param {number} counts.words - Total productive WORDs (content vocabulary).
 * @param {number} counts.pivots - Total productive PIVOTs (combinatorial words).
 * @param {number} counts.operators - Total productive OPERATORs (function words).
 * @param {Object} [thresholds] - Optional threshold overrides. Any missing
 *   properties fall back to DEFAULT_THRESHOLDS.
 * @param {Array} [thresholds.stages] - Stage boundary overrides.
 * @param {Array} [thresholds.belts] - Belt boundary overrides.
 * @param {Object} [thresholds.stripes] - Stripe boundary overrides.
 * @param {Object} [options] - Optional behaviour modifiers.
 * @param {boolean} [options.debug=false] - When true, includes a trace array
 *   in the result showing each reasoning step.
 * @param {Function} [options.onDowngrade] - Optional callback invoked when
 *   grammar competence forces a stage downgrade. Receives the full result.
 *
 * @returns {Object} Classification result (frozen):
 *   - classifierVersion {number} Version of the classification logic.
 *   - stageNumber {number} 0-5. The effective (grammar-gated) stage.
 *   - stageName {string} Human-readable stage name.
 *   - stageDescription {string} What this stage means for speech.
 *   - vocabImpliedStage {number} 0-5. What vocabulary alone would suggest.
 *   - grammarDowngrade {boolean} True if grammar competence lowered the stage.
 *   - downgradeReason {string|null} Explanation if downgraded, null otherwise.
 *   - belt {string} Current belt name ('none','white','blue','purple','brown','black').
 *   - stripe {number} Current stripe within belt (0 if no belt, 1-4 otherwise).
 *   - totalProductive {number} Sum of words + pivots + operators.
 *   - counts {Object} Echo of validated input counts.
 *   - trace {Array|undefined} Reasoning steps (only present when debug=true).
 *
 * @throws {TypeError} If any count value is a non-numeric type other than
 *   null/undefined (e.g. string, boolean, object).
 * @throws {RangeError} If any count value is negative, NaN, or Infinity.
 * @throws {RangeError} If stage thresholds length does not match stage definitions.
 *
 * @example
 * classify({ words: 35, pivots: 3, operators: 1 });
 * // { stageNumber: 2, stageName: 'two_word', belt: 'white', stripe: 4, ... }
 *
 * @example
 * classify({ words: 55, pivots: 0, operators: 0 });
 * // { stageNumber: 1, vocabImpliedStage: 2, grammarDowngrade: true, ... }
 *
 * @example
 * classify({ words: 55, pivots: 0, operators: 0 }, null, { debug: true });
 * // result.trace contains step-by-step reasoning array
 */
function classify(counts, thresholds, options) {
    const debug = options?.debug === true;
    const onDowngrade = typeof options?.onDowngrade === 'function'
        ? options.onDowngrade
        : null;
    const trace = debug ? [] : null;

    const words = _strictNonNegativeInt(counts?.words, 'counts.words');
    const pivots = _strictNonNegativeInt(counts?.pivots, 'counts.pivots');
    const operators = _strictNonNegativeInt(counts?.operators, 'counts.operators');
    const totalProductive = words + pivots + operators;

    if (debug) {
        trace.push(
            `Input: words=${words}, pivots=${pivots}, operators=${operators}, total=${totalProductive}`
        );
    }

    const stageThresholds = thresholds?.stages ?? DEFAULT_THRESHOLDS.stages;
    const beltThresholds = thresholds?.belts ?? DEFAULT_THRESHOLDS.belts;
    const stripeThresholds = thresholds?.stripes ?? DEFAULT_THRESHOLDS.stripes;

    if (stageThresholds.length !== STAGE_DEFINITIONS.length) {
        throw new RangeError(
            `Stage thresholds length (${stageThresholds.length}) must match ` +
            `stage definitions length (${STAGE_DEFINITIONS.length}).`
        );
    }

    const vocabImpliedStage = _getVocabImpliedStage(totalProductive, stageThresholds);

    if (debug) {
        trace.push(
            `Vocab-implied stage: ${vocabImpliedStage} (${STAGE_DEFINITIONS[vocabImpliedStage].name})`
        );
    }

    const { effectiveStage, downgradeReason } = _applyGrammarGate(
        vocabImpliedStage,
        pivots,
        operators,
        stageThresholds,
        trace
    );

    if (debug && effectiveStage < vocabImpliedStage) {
        trace.push(
            `Downgraded: ${STAGE_DEFINITIONS[vocabImpliedStage].name} -> ` +
            `${STAGE_DEFINITIONS[effectiveStage].name}`
        );
    }

    const { belt, stripe } = _getBeltAndStripe(
        totalProductive,
        beltThresholds,
        stripeThresholds
    );

    if (debug) {
        trace.push(`Belt: ${belt}, Stripe: ${stripe} (totalProductive=${totalProductive})`);
    }

    const stageDef = STAGE_DEFINITIONS[effectiveStage];
    const isDowngraded = effectiveStage < vocabImpliedStage;

    const result = Object.freeze({
        classifierVersion: CLASSIFIER_VERSION,
        stageNumber: stageDef.number,
        stageName: stageDef.name,
        stageDescription: stageDef.description,
        vocabImpliedStage,
        grammarDowngrade: isDowngraded,
        downgradeReason: downgradeReason ?? null,
        belt,
        stripe,
        totalProductive,
        counts: Object.freeze({ words, pivots, operators }),
        ...(debug ? { trace: Object.freeze([...trace]) } : {})
    });

    if (isDowngraded && onDowngrade) {
        onDowngrade(result);
    }

    return result;
}

function _getVocabImpliedStage(totalProductive, stageThresholds) {
    for (let i = stageThresholds.length - 1; i >= 1; i--) {
        if (totalProductive >= stageThresholds[i].minVocab) {
            return i;
        }
    }
    return totalProductive >= 1 ? 1 : 0;
}

function _applyGrammarGate(vocabStage, pivots, operators, stageThresholds, trace) {
    if (vocabStage <= 1) {
        return { effectiveStage: vocabStage, downgradeReason: null };
    }

    for (let stage = vocabStage; stage >= 1; stage--) {
        const req = stageThresholds[stage];
        const requiredPivots = req.minPivots ?? 0;
        const requiredOperators = req.minOperators ?? 0;
        const pivotsMet = pivots >= requiredPivots;
        const operatorsMet = operators >= requiredOperators;

        if (trace) {
            trace.push(
                `Grammar gate: stage ${stage} requires minPivots=${requiredPivots}, ` +
                `minOperators=${requiredOperators}. ` +
                `Have pivots=${pivots}, operators=${operators}. ` +
                `${pivotsMet && operatorsMet ? 'Met.' : 'Not met.'}`
            );
        }

        if (pivotsMet && operatorsMet) {
            if (stage < vocabStage) {
                const vocabReq = stageThresholds[vocabStage];
                const reasons = [];
                if (pivots < (vocabReq.minPivots ?? 0)) {
                    reasons.push(
                        `PIVOTs: ${pivots} productive, need ${vocabReq.minPivots} for stage ${vocabStage}`
                    );
                }
                if (operators < (vocabReq.minOperators ?? 0)) {
                    reasons.push(
                        `OPERATORs: ${operators} productive, need ${vocabReq.minOperators} for stage ${vocabStage}`
                    );
                }
                return {
                    effectiveStage: stage,
                    downgradeReason: `Grammar competence insufficient. ${reasons.join('. ')}. ` +
                        `Downgraded from ${STAGE_DEFINITIONS[vocabStage].name} to ${STAGE_DEFINITIONS[stage].name}.`
                };
            }
            return { effectiveStage: stage, downgradeReason: null };
        }
    }

    return {
        effectiveStage: 0,
        downgradeReason: 'Grammar competence insufficient for any stage above pre-verbal.'
    };
}

function _getBeltAndStripe(totalProductive, beltThresholds, stripeThresholds) {
    if (totalProductive < 1) {
        return { belt: 'none', stripe: 0 };
    }

    let currentBelt = 'white';
    for (let i = beltThresholds.length - 1; i >= 0; i--) {
        if (totalProductive >= beltThresholds[i].minVocab) {
            currentBelt = beltThresholds[i].name;
            break;
        }
    }

    const beltStripes = stripeThresholds[currentBelt];
    let currentStripe = 1;
    if (beltStripes) {
        for (let i = beltStripes.length - 1; i >= 0; i--) {
            if (totalProductive >= beltStripes[i].minVocab) {
                currentStripe = beltStripes[i].stripe;
                break;
            }
        }
    }

    return { belt: currentBelt, stripe: currentStripe };
}

function _strictNonNegativeInt(value, fieldName) {
    if (value === null || value === undefined) {
        return 0;
    }

    if (typeof value !== 'number') {
        throw new TypeError(
            `${fieldName}: expected number or null/undefined, got ${typeof value} (${String(value)})`
        );
    }

    if (!Number.isFinite(value)) {
        throw new RangeError(
            `${fieldName}: expected finite number, got ${value}`
        );
    }

    if (value < 0) {
        throw new RangeError(
            `${fieldName}: expected non-negative number, got ${value}`
        );
    }

    return Math.floor(value);
}

function getStageName(stageNumber) {
    const stage = STAGE_DEFINITIONS[stageNumber];
    return stage?.name ?? null;
}

function getStageDefinitions() {
    return STAGE_DEFINITIONS;
}

function getDefaultThresholds() {
    return DEFAULT_THRESHOLDS;
}

function getClassifierVersion() {
    return CLASSIFIER_VERSION;
}

function validateThresholds(thresholds) {
    const errors = [];

    if (!thresholds || typeof thresholds !== 'object') {
        return { isValid: false, errors: ['Thresholds must be a non-null object.'] };
    }

    if (thresholds.stages !== undefined) {
        if (!Array.isArray(thresholds.stages)) {
            errors.push('stages must be an array.');
        } else {
            if (thresholds.stages.length !== STAGE_DEFINITIONS.length) {
                errors.push(
                    `stages must have exactly ${STAGE_DEFINITIONS.length} entries (0-${STAGE_DEFINITIONS.length - 1}), ` +
                    `got ${thresholds.stages.length}.`
                );
            }

            for (let i = 0; i < thresholds.stages.length; i++) {
                const s = thresholds.stages[i];
                if (typeof s?.minVocab !== 'number' || s.minVocab < 0) {
                    errors.push(`stages[${i}].minVocab must be a non-negative number.`);
                }
                if (typeof s?.minPivots !== 'number' || s.minPivots < 0) {
                    errors.push(`stages[${i}].minPivots must be a non-negative number.`);
                }
                if (typeof s?.minOperators !== 'number' || s.minOperators < 0) {
                    errors.push(`stages[${i}].minOperators must be a non-negative number.`);
                }
            }

            for (let i = 1; i < thresholds.stages.length; i++) {
                if (thresholds.stages[i]?.minVocab < thresholds.stages[i - 1]?.minVocab) {
                    errors.push(
                        `stages[${i}].minVocab (${thresholds.stages[i].minVocab}) must be >= ` +
                        `stages[${i - 1}].minVocab (${thresholds.stages[i - 1].minVocab}).`
                    );
                }
            }
        }
    }

    if (thresholds.belts !== undefined) {
        if (!Array.isArray(thresholds.belts)) {
            errors.push('belts must be an array.');
        } else {
            for (let i = 0; i < thresholds.belts.length; i++) {
                const b = thresholds.belts[i];
                if (typeof b?.name !== 'string' || b.name.length === 0) {
                    errors.push(`belts[${i}].name must be a non-empty string.`);
                }
                if (typeof b?.minVocab !== 'number' || b.minVocab < 0) {
                    errors.push(`belts[${i}].minVocab must be a non-negative number.`);
                }
                if (typeof b?.maxVocab !== 'number' || b.maxVocab < b?.minVocab) {
                    errors.push(`belts[${i}].maxVocab must be >= minVocab.`);
                }
            }

            for (let i = 1; i < thresholds.belts.length; i++) {
                const prev = thresholds.belts[i - 1];
                const curr = thresholds.belts[i];
                if (prev?.maxVocab !== Infinity && curr?.minVocab !== prev?.maxVocab + 1) {
                    errors.push(
                        `Belt gap: ${prev.name} ends at ${prev.maxVocab}, ` +
                        `${curr.name} starts at ${curr.minVocab}. Expected ${prev.maxVocab + 1}.`
                    );
                }
            }
        }
    }

    if (thresholds.belts && thresholds.stages) {
        const whiteBelt = thresholds.belts.find(b => b.name === 'white');
        const holophrasticStage = thresholds.stages[1];
        if (whiteBelt && holophrasticStage) {
            if (whiteBelt.minVocab !== holophrasticStage.minVocab) {
                errors.push(
                    `Belt/stage misalignment: white belt minVocab (${whiteBelt.minVocab}) ` +
                    `must equal holophrastic stage minVocab (${holophrasticStage.minVocab}).`
                );
            }
        }
    }

    if (thresholds.stripes !== undefined) {
        if (typeof thresholds.stripes !== 'object' || Array.isArray(thresholds.stripes)) {
            errors.push('stripes must be a non-array object keyed by belt name.');
        } else {
            for (const [beltName, stripes] of Object.entries(thresholds.stripes)) {
                if (!Array.isArray(stripes)) {
                    errors.push(`stripes.${beltName} must be an array.`);
                    continue;
                }
                for (let i = 1; i < stripes.length; i++) {
                    const prev = stripes[i - 1];
                    const curr = stripes[i];
                    if (prev?.maxVocab !== Infinity && curr?.minVocab !== prev?.maxVocab + 1) {
                        errors.push(
                            `Stripe gap in ${beltName}: stripe ${prev.stripe} ends at ${prev.maxVocab}, ` +
                            `stripe ${curr.stripe} starts at ${curr.minVocab}. Expected ${prev.maxVocab + 1}.`
                        );
                    }
                }
            }
        }
    }

    return { isValid: errors.length === 0, errors };
}

export {
    classify,
    getStageName,
    getStageDefinitions,
    getDefaultThresholds,
    getClassifierVersion,
    validateThresholds,
    STAGE_DEFINITIONS,
    DEFAULT_THRESHOLDS,
    CLASSIFIER_VERSION
};

export default classify;
