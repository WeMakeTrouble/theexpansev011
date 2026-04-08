#!/usr/bin/env node
/**
 * ===========================================================================
 * seedInspector.js — CLI Tool for Inspecting Chaos Engine Seeds
 * ===========================================================================
 *
 * PURPOSE:
 * Admin/debug tool that displays the complete seed chain and distribution
 * for a given user hex ID, episode, and belt level. Used to verify
 * determinism, debug pathological seeds, and validate Shichifukujin
 * weighting before content authoring at scale.
 *
 * USAGE:
 *   node seedInspector.js <hex_id> <episode_number> <belt_level>
 *   node seedInspector.js #D0000A 1 white_belt
 *
 * OUTPUT:
 *   - Base seed (from djb2 hash of hex ID)
 *   - Episode seed (from Jenkins mix with episode number)
 *   - Belt layer seed (from Jenkins mix with belt enum)
 *   - First 3 PRNG values for slot 1
 *   - Full distribution results (quality score, asset count, frozen state)
 *
 * IMPORTANT:
 *   This tool calls ChaosDistributor.getDistribution() which hits the
 *   live database. If no distribution exists, it GENERATES and PERSISTS
 *   one. Do not run against production user IDs unless intentional.
 *
 * FUTURE (per build spec):
 *   - Integrate into CMS at /cms/chaos-engine/inspect
 *   - Add "rejected candidates with reasons" output
 *   - Add "bad seed" flagging based on quality threshold
 *   - Add PRNG trace (all values consumed during solving)
 *
 * DEPENDENCIES:
 *   - ChaosSeeder (../ChaosSeeder.js)
 *   - ChaosDistributor (../ChaosDistributor.js)
 *   - Requires database connection (pool.js)
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Tooling
 * ===========================================================================
 */

import { ChaosSeeder } from '../ChaosSeeder.js';
import { ChaosDistributor } from '../ChaosDistributor.js';

async function inspectSeed(hexId, episode, belt) {
    console.log(`\n🔍 Inspecting seed for ${hexId}, Episode ${episode}, ${belt}\n`);
   
    const seeder = new ChaosSeeder(hexId);
   
    console.log('Base Seed:', seeder.getBaseSeed());
    console.log('Episode Seed:', seeder.getEpisodeSeed(parseInt(episode)));
    console.log('Belt Layer Seed:', seeder.getBeltLayerSeed(parseInt(episode), belt));
   
    const rng = seeder.getSlotRng(parseInt(episode), belt, 1);
    console.log('\nFirst 3 PRNG values for slot 1:');
    for (let i = 0; i < 3; i++) {
        console.log(`  ${i + 1}: ${rng()}`);
    }
   
    const distributor = new ChaosDistributor();
    const result = await distributor.getDistribution(hexId, parseInt(episode), belt);
   
    console.log('\n📊 Distribution Results:');
    console.log('Quality Score:', result.quality);
    console.log('Generation Seed:', result.generationSeed);
    console.log('Frozen:', result.frozen || false);
    console.log('Asset Count:', result.distributions?.length || result.distributions?.size || 0);
}

const [,, hexId, episode, belt] = process.argv;
if (!hexId || !episode || !belt) {
    console.log('Usage: node seedInspector.js <hex_id> <episode_number> <belt_level>');
    console.log('Example: node seedInspector.js #D0000A 1 white_belt');
    process.exit(1);
}

inspectSeed(hexId, episode, belt);
