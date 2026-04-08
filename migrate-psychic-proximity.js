// migrate-psychic-proximity.js
// Run: node migrate-psychic-proximity.js

import pool from './backend/db/pool.js';
import generateHexId from './backend/utils/hexIdGenerator.js';

const CLAUDE_ID = '#700002';

async function migrate() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get all symmetric proximity data (excluding the dodgy #AEFAFA row)
    const result = await client.query(`
      SELECT 
        character_a,
        character_b,
        psychological_distance,
        emotional_resonance,
        relationship_type,
        last_interaction
      FROM psychic_proximity
      WHERE proximity_id != '#AEFAFA'
      ORDER BY psychological_distance ASC
    `);
    
    console.log(`Found ${result.rows.length} symmetric rows to migrate`);
    
    let migratedCount = 0;
    
    for (const row of result.rows) {
      // Generate two directed IDs: A→B and B→A
      const idAB = await generateHexId('psychic_proximity_id');
      const idBA = await generateHexId('psychic_proximity_id');
      
      // Insert A→B
      await client.query(`
        INSERT INTO psychic_proximity_directed (
          proximity_id, from_character, to_character,
          current_distance, baseline_distance,
          emotional_resonance, regression_rate,
          relationship_type, last_interaction,
          last_decay_calculation, is_narrative_override
        ) VALUES ($1, $2, $3, $4, $4, $5, 0.02, $6, $7, NOW(), false)
      `, [
        idAB,
        row.character_a,
        row.character_b,
        row.psychological_distance,
        row.emotional_resonance,
        row.relationship_type,
        row.last_interaction
      ]);
      
      // Insert B→A
      await client.query(`
        INSERT INTO psychic_proximity_directed (
          proximity_id, from_character, to_character,
          current_distance, baseline_distance,
          emotional_resonance, regression_rate,
          relationship_type, last_interaction,
          last_decay_calculation, is_narrative_override
        ) VALUES ($1, $2, $3, $4, $4, $5, 0.02, $6, $7, NOW(), false)
      `, [
        idBA,
        row.character_b,
        row.character_a,
        row.psychological_distance,
        row.emotional_resonance,
        row.relationship_type,
        row.last_interaction
      ]);
      
      migratedCount += 2;
      console.log(`Migrated: ${row.character_a} ↔ ${row.character_b} (${row.relationship_type})`);
    }
    
    await client.query('COMMIT');
    console.log(`\n✅ Migration complete: ${migratedCount} directed rows created`);
    
    // Verify: show rows where to_character = Claude
    const verify = await client.query(`
      SELECT from_character, current_distance, relationship_type
      FROM psychic_proximity_directed
      WHERE to_character = $1
      ORDER BY current_distance ASC
    `, [CLAUDE_ID]);
    
    console.log(`\n📡 Radar data for Claude (${CLAUDE_ID}):`);
    verify.rows.forEach(r => {
      console.log(`  ${r.from_character}: distance=${r.current_distance.toFixed(2)}, type=${r.relationship_type}`);
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
