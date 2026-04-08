/**
 * ===========================================================================
 * chaosConfig.js — Frozen Constants for the Chaos Engine
 * ===========================================================================
 *
 * PURPOSE:
 * Single source of truth for all Chaos Engine configuration values.
 * Every constant is deeply frozen (Object.freeze, recursive). Nothing
 * in this file is mutable at runtime.
 *
 * CALIBRATION STATUS:
 * Values marked "proposed — requires calibration" are working defaults
 * derived from the DD01/DD02 external review process. They must be
 * tuned through testing with representative asset/slot data before
 * production deployment. Changing these values does NOT break
 * determinism — it changes what the deterministic system produces.
 *
 * Changing JENKINS_CONSTANTS or BELT_ENUM WILL break determinism.
 * Those values are load-bearing for the seeding pipeline and frozen
 * into every existing user distribution. Altering them invalidates
 * all golden path test vectors and all stored distributions.
 *
 * CONTENTS:
 *   BELT_ENUM            — Belt level to integer mapping (seed mixing)
 *   BELT_LEVELS          — Ordered belt level array
 *   TIERS                — Asset tier classification (texture/beat/capstone)
 *   GOD_MULTIPLIERS      — Shichifukujin weighting per episode per category
 *   JENKINS_CONSTANTS    — Salt values for seed pipeline isolation
 *   SOLVER_THRESHOLDS    — Density, quality, and retry limits
 *   ASSET_CATEGORIES     — The 10 discoverable asset categories
 *   CONNECTION_TYPES     — Valid synthesis connection types
 *   EPISODE_GODS         — Episode number to god domain mapping
 *   CHAOS_DOMAIN_ID      — Hex ID for the CE domain in knowledge_domains
 *
 * CATEGORY NAMES:
 * The 10 asset categories must exactly match the CHECK constraint on
 * chaos_asset_registry.category in the database:
 *   image, dialogue_fragment, vocabulary, character_observation,
 *   object, location, event_witnessing, music, information, connection
 *
 * GOD MULTIPLIERS:
 * Each episode's Shichifukujin god biases category selection probability.
 * Applied as: effective_weight = base_weight * god_multiplier[category]
 * Default multiplier (unlisted categories) is 1.0 — no bias.
 * Boosted categories: 1.2-1.6x. Reduced categories: 0.6-0.9x.
 * No episode should exceed 60% of assets in one category.
 * All multiplier values are proposed — requires calibration.
 *
 * DEPENDENCIES: None. Pure constants. No imports.
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Configuration
 * ===========================================================================
 */

// ---------------------------------------------------------------------------
// UTILITY: Deep Freeze
// ---------------------------------------------------------------------------

function freeze(obj) {
    Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            freeze(obj[key]);
        }
    });
    return Object.freeze(obj);
}

// ---------------------------------------------------------------------------
// BELT SYSTEM
// ---------------------------------------------------------------------------

/** Belt level to integer mapping. Used in jenkinsMix for belt seed isolation. */
export const BELT_ENUM = freeze({
    'white_belt': 1,
    'blue_belt': 2,
    'purple_belt': 3,
    'brown_belt': 4,
    'black_belt': 5
});

/** Ordered belt levels for iteration and validation. */
export const BELT_LEVELS = freeze([
    'white_belt', 'blue_belt', 'purple_belt', 'brown_belt', 'black_belt'
]);

// ---------------------------------------------------------------------------
// ASSET CLASSIFICATION
// ---------------------------------------------------------------------------

/** Asset tier classification. Texture=high frequency, Beat=mid, Capstone=rare. */
export const TIERS = freeze({
    TEXTURE: 'texture',
    BEAT: 'beat',
    CAPSTONE: 'capstone'
});

/** The 10 discoverable asset categories. Must match DB CHECK constraint. */
export const ASSET_CATEGORIES = freeze([
    'image',
    'dialogue_fragment',
    'vocabulary',
    'character_observation',
    'object',
    'location',
    'event_witnessing',
    'music',
    'information',
    'connection'
]);

/** Valid synthesis connection types. Must match chaos_connections CHECK. */
export const CONNECTION_TYPES = freeze([
    'causal',
    'thematic',
    'spatial',
    'temporal',
    'character'
]);

// ---------------------------------------------------------------------------
// SHICHIFUKUJIN GOD MULTIPLIERS (proposed — requires calibration)
// ---------------------------------------------------------------------------

/** Episode number to god domain mapping. */
export const EPISODE_GODS = freeze({
    1: 'ebisu',
    2: 'daikokuten',
    3: 'bishamonten',
    4: 'benzaiten',
    5: 'fukurokuju',
    6: 'jurojin',
    7: 'hotei'
});

/**
 * Per-god category weight multipliers.
 * Unlisted categories default to 1.0 (no bias).
 * All values proposed — requires calibration.
 */
export const GOD_MULTIPLIERS = freeze({
    ebisu: {
        object: 1.5,
        dialogue_fragment: 1.3,
        vocabulary: 0.8,
        connection: 0.7,
        music: 0.9
    },
    daikokuten: {
        location: 1.4,
        object: 1.4,
        music: 0.7,
        image: 0.9
    },
    bishamonten: {
        event_witnessing: 1.5,
        character_observation: 1.4,
        information: 1.2,
        music: 0.6
    },
    benzaiten: {
        music: 1.6,
        dialogue_fragment: 1.4,
        vocabulary: 1.3,
        object: 0.7
    },
    fukurokuju: {
        information: 1.5,
        character_observation: 1.3,
        event_witnessing: 0.8,
        image: 1.2
    },
    jurojin: {
        information: 1.4,
        dialogue_fragment: 1.3,
        music: 1.2,
        location: 0.8
    },
    hotei: {
        image: 1.3,
        music: 1.4,
        vocabulary: 1.2,
        object: 0.9
    }
});

// ---------------------------------------------------------------------------
// JENKINS HASH CONSTANTS (DO NOT CHANGE — breaks all distributions)
// ---------------------------------------------------------------------------

/**
 * Salt values for Jenkins mixing at each pipeline level.
 * Changing these invalidates ALL golden path test vectors and
 * ALL stored user distributions. Treat as immutable.
 */
export const JENKINS_CONSTANTS = freeze({
    EPISODE_SALT: 0x9e3779b9,
    BELT_SALT: 0xdeadbeef,
    SLOT_SALT: 0x85ebca6b
});

// ---------------------------------------------------------------------------
// SOLVER THRESHOLDS (proposed — requires calibration)
// ---------------------------------------------------------------------------

export const SOLVER_THRESHOLDS = freeze({
    MIN_ASSETS_PER_EPISODE: 3,
    MAX_ASSETS_PER_EPISODE: 12,
    SPINE_PERCENTAGE_TARGET: 0.25,
    QUALITY_MINIMUM: 0.7,
    MAX_RESEED_ATTEMPTS: 5,
    DEFAULT_BASE_WEIGHT: 1.000
});

// ---------------------------------------------------------------------------
// DATABASE REFERENCE
// ---------------------------------------------------------------------------

/** Chaos Engine domain ID in knowledge_domains table. Verified live. */
export const CHAOS_DOMAIN_ID = '#AE0012';
