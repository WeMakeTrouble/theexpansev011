/**
 * ===========================================================================
 * ChaosSeeder.js — Deterministic Seeding Pipeline for the Chaos Engine
 * ===========================================================================
 *
 * PURPOSE:
 * Transforms a user's hex ID into a hierarchy of deterministic seeds that
 * drive all randomness in the Chaos Engine. Same user always gets the same
 * world. Same episode always gets the same distribution. Same belt layer
 * always gets the same additions, regardless of when they were generated.
 *
 * SEEDING PIPELINE:
 *
 *   user_hex_id (#D0000A)
 *       ↓ strip #, djb2 hash
 *   base_seed (2851966090)
 *       ↓ XOR with djb2(purchase_code) if present
 *   modified_base_seed
 *       ↓ jenkinsMix(base, episode, EPISODE_SALT)
 *   episode_seed (isolated per episode)
 *       ↓ jenkinsMix(ep_seed, belt_enum, BELT_SALT)
 *   belt_layer_seed (isolated per belt level)
 *       ↓ jenkinsMix(layer_seed, slot_sequence, SLOT_SALT)
 *   slot_seed → mulberry32(slot_seed) → deterministic PRNG instance
 *
 * ISOLATION GUARANTEES:
 *   - Episode isolation: Changing Episode 1 does not cascade into Episode 7.
 *     Each episode derives its own seed from the base via Jenkins mixing
 *     with EPISODE_SALT (0x9e3779b9).
 *   - Belt isolation: Blue Belt layer generated on Day 30 is identical to
 *     Blue Belt layer generated on Day 90. The pipeline is a pure function
 *     of (userHexId, episodeNumber, beltLevel) — time is never an input.
 *   - Slot isolation: Each slot gets its own Mulberry32 PRNG instance. No
 *     shared state between slots. Slot order changes don't cascade.
 *
 * PURCHASE CODE MODIFIER:
 *   The users.purchase_code field (merch drop code) modifies the base seed
 *   via XOR. Users without codes use the raw djb2 hash. Users with codes
 *   get a different but equally deterministic universe. No conditional
 *   logic in downstream pipeline — just different inputs.
 *
 * DEPENDENCIES:
 *   - djb2 (backend/chaosEngine/helpers/djb2.js)
 *   - jenkinsMix (backend/chaosEngine/helpers/jenkinsMix.js)
 *   - BELT_ENUM, JENKINS_CONSTANTS (backend/chaosEngine/chaosConfig.js)
 *   - mulberry32 (backend/services/imageProcessor/prng.js) — existing module
 *
 * EXPORTS:
 *   ChaosSeeder class (named export)
 *     constructor(userHexId, purchaseCode?)
 *     getEpisodeSeed(episodeNumber) → 32-bit unsigned integer
 *     getBeltLayerSeed(episodeNumber, beltLevel) → 32-bit unsigned integer
 *     getSlotRng(episodeNumber, beltLevel, slotSequence) → Mulberry32 PRNG
 *     getBaseSeed() → 32-bit unsigned integer
 *
 * GOLDEN PATH TEST VECTORS (any change is a breaking change):
 *   Input: "#D0000A", no purchase code
 *   Base seed:               2851966090
 *   Episode 1 seed:          2175316142
 *   Episode 7 seed:          2327456351
 *   Ep1 white_belt seed:     3842356132
 *   Ep1 white_belt slot0:    3199615010
 *   PRNG[0]:                 0.8110810071229935
 *   PRNG[1]:                 0.6401743933092803
 *   PRNG[2]:                 0.6965343763586134
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Seeding Pipeline
 * ===========================================================================
 */

import { djb2 } from './helpers/djb2.js';
import { jenkinsMix } from './helpers/jenkinsMix.js';
import { BELT_ENUM, JENKINS_CONSTANTS } from './chaosConfig.js';
import { mulberry32 } from '../services/imageProcessor/prng.js';

export class ChaosSeeder {
    constructor(userHexId, purchaseCode = null) {
        const cleanHex = userHexId.replace('#', '');
        let baseSeed = djb2(cleanHex);

        if (purchaseCode && purchaseCode.length > 0) {
            const codeHash = djb2(purchaseCode);
            baseSeed = (baseSeed ^ codeHash) >>> 0;
        }

        this.baseSeed = baseSeed;
    }

    getEpisodeSeed(episodeNumber) {
        return jenkinsMix(
            this.baseSeed,
            episodeNumber,
            JENKINS_CONSTANTS.EPISODE_SALT
        );
    }

    getBeltLayerSeed(episodeNumber, beltLevel) {
        const epSeed = this.getEpisodeSeed(episodeNumber);
        const beltVal = BELT_ENUM[beltLevel] || 1;

        return jenkinsMix(
            epSeed,
            beltVal,
            JENKINS_CONSTANTS.BELT_SALT
        );
    }

    getSlotRng(episodeNumber, beltLevel, slotSequence) {
        const layerSeed = this.getBeltLayerSeed(episodeNumber, beltLevel);
        const slotSeed = jenkinsMix(
            layerSeed,
            slotSequence,
            JENKINS_CONSTANTS.SLOT_SALT
        );

        return mulberry32(slotSeed);
    }

    getBaseSeed() {
        return this.baseSeed;
    }
}
