#!/usr/bin/env node
/**
 * ===========================================================================
 * verifyBuild.js — Chaos Engine System Health Check
 * ===========================================================================
 *
 * PURPOSE:
 * End-to-end verification that all Chaos Engine components are installed,
 * importable, functional, and connected to the database. Run this after
 * any build step to confirm nothing is broken.
 *
 * USAGE:
 *   node verifyBuild.js
 *
 * EXIT CODES:
 *   0 — All checks pass.
 *   1 — Critical failure (imports, seeding, or DB connectivity broken).
 *
 * CHECKS PERFORMED:
 *   1. chaosConfig.js — imports, BELT_ENUM, GOD_MULTIPLIERS, domain ID
 *   2. djb2.js + jenkinsMix.js — import and basic function call
 *   3. ChaosSeeder — full seed chain for #D0000A
 *   4. Database connectivity — counts chaos_* tables
 *   5. Test data presence — slot and asset counts (warns if empty)
 *
 * NOTE:
 *   This script requires a live database connection. It does NOT modify
 *   any data — read-only queries against information_schema and counts.
 *
 * DEPENDENCIES:
 *   - All Chaos Engine modules (via dynamic import)
 *   - pool (backend/db/pool.js) for database checks
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Tooling
 * ===========================================================================
 */

console.log('🔧 Chaos Engine Build Verification\n');

// Test 1: Config imports
try {
    const { BELT_ENUM, GOD_MULTIPLIERS, JENKINS_CONSTANTS, CHAOS_DOMAIN_ID } = await import('../chaosConfig.js');
    console.log('✅ chaosConfig.js imports');
    console.log('   Domain ID:', CHAOS_DOMAIN_ID);
    console.log('   Belt levels:', Object.keys(BELT_ENUM).join(', '));
} catch (e) {
    console.error('❌ chaosConfig.js failed:', e.message);
    process.exit(1);
}

// Test 2: Helper imports
try {
    const { djb2 } = await import('../helpers/djb2.js');
    const { jenkinsMix } = await import('../helpers/jenkinsMix.js');
   
    const testHash = djb2('D0000A');
    console.log('✅ Hash helpers work (djb2("D0000A") =', testHash + ')');
   
    const testMix = jenkinsMix(12345, 1, 0x9e3779b9);
    console.log('✅ Jenkins mix works');
} catch (e) {
    console.error('❌ Helper imports failed:', e.message);
    process.exit(1);
}

// Test 3: ChaosSeeder
try {
    const { ChaosSeeder } = await import('../ChaosSeeder.js');
    const seeder = new ChaosSeeder('#D0000A');
    const base = seeder.getBaseSeed();
    const ep1 = seeder.getEpisodeSeed(1);
    const rng = seeder.getSlotRng(1, 'white_belt', 1);
    const val = rng();
   
    console.log('✅ ChaosSeeder works');
    console.log('   Base seed:', base);
    console.log('   Episode 1 seed:', ep1);
    console.log('   Sample PRNG output:', val);
} catch (e) {
    console.error('❌ ChaosSeeder failed:', e.message);
    console.error(e.stack);
    process.exit(1);
}

// Test 4: Database connectivity (check tables exist)
try {
    const { default: pool } = await import('../../db/pool.js');
    const result = await pool.query(`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name LIKE 'chaos_%'
    `);
    console.log('✅ Database connected,', result.rows[0].count, 'Chaos tables found');
} catch (e) {
    console.error('❌ Database check failed:', e.message);
    process.exit(1);
}

// Test 5: Check for test data
try {
    const { default: pool } = await import('../../db/pool.js');
    const slotCheck = await pool.query('SELECT COUNT(*) as count FROM chaos_slot_definitions');
    const assetCheck = await pool.query('SELECT COUNT(*) as count FROM chaos_asset_registry');
   
    console.log('✅ Test data check:', slotCheck.rows[0].count, 'slots,', assetCheck.rows[0].count, 'assets');
   
    if (slotCheck.rows[0].count === 0 || assetCheck.rows[0].count === 0) {
        console.log('\n⚠️  WARNING: No test data in database');
        console.log('   Run the test data insertion script before full testing');
    }
} catch (e) {
    console.error('❌ Test data check failed:', e.message);
}

console.log('\n🎉 Build verification complete!');
