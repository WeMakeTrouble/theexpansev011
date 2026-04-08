import pool from '../backend/db/pool.js';
import generateHexId from '../backend/utils/hexIdGenerator.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WHITEHAT_DIR = join(process.env.HOME, 'Desktop', 'whitehat');
const DOMAIN_ID = '#AE0010';
const CURRICULUM_ID = '#CB0003';
const TEACHER_ID = '#700002';

async function importWhitehatCards() {
  const counterCheck = await pool.query(
    "SELECT current_value FROM hex_id_counters WHERE id_type = 'knowledge_item_id'"
  );

  if (counterCheck.rows.length === 0) {
    await pool.query(
      "INSERT INTO hex_id_counters (id_type, last_used_id, current_value) VALUES ('knowledge_item_id', '#AF1A5F', $1)",
      [parseInt('AF1A5F', 16)]
    );
    console.log('Seeded hex counter for knowledge_item_id at #AF1A5F');
  }

  const phaseFiles = readdirSync(WHITEHAT_DIR)
    .filter(f => f.startsWith('phase_P') && f.endsWith('.json'))
    .sort();

  console.log('Found phase files:', phaseFiles.length);

  let totalInserted = 0;
  let errors = [];

  for (const file of phaseFiles) {
    const filePath = join(WHITEHAT_DIR, file);
    const phase = JSON.parse(readFileSync(filePath, 'utf8'));
    const phaseId = phase.phase_id;

    if (!phase.modules) {
      console.log('Skipping', file, '- no modules');
      continue;
    }

    for (const mod of phase.modules) {
      if (!mod.cards) continue;

      for (const card of mod.cards) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const knowledgeId = await generateHexId('knowledge_item_id');

          const conceptLabel = [phaseId, mod.module_id, card.card_id].filter(Boolean).join(' - ');

          const difficultyToComplexity = {
            1: 0.2,
            2: 0.4,
            3: 0.6,
            4: 0.8,
            5: 1.0
          };
          const complexity = difficultyToComplexity[card.difficulty] || 0.5;

          const beltMap = {
            1: 'white_belt',
            2: 'white_belt',
            3: 'blue_belt',
            4: 'purple_belt',
            5: 'brown_belt'
          };
          const belt = beltMap[card.difficulty] || 'white_belt';

          const tags = card.tags || [];
          const requiredTerms = tags.length > 0 ? JSON.stringify(tags) : '[]';

          await client.query(
            `INSERT INTO knowledge_items
             (knowledge_id, content, domain_id, source_type, initial_character_id,
              initial_strength, complexity_score, concept, belt_level,
              required_terms, answer_statement, entry_type, curriculum_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              knowledgeId,
              card.question,
              DOMAIN_ID,
              'canonical',
              TEACHER_ID,
              1.0,
              complexity,
              conceptLabel.substring(0, 40),
              belt,
              requiredTerms,
              card.answer,
              'fact',
              CURRICULUM_ID
            ]
          );

          await client.query('COMMIT');
          totalInserted++;

          if (totalInserted % 10 === 0) {
            console.log('Inserted', totalInserted, 'cards...');
          }
        } catch (err) {
          await client.query('ROLLBACK');
          errors.push({ card: card.card_id, error: err.message });
          console.error('Error on card', card.card_id, ':', err.message);
        } finally {
          client.release();
        }
      }
    }

    console.log('Phase', phaseId, 'complete');
  }

  console.log('');
  console.log('IMPORT COMPLETE');
  console.log('Total inserted:', totalInserted);
  console.log('Errors:', errors.length);
  if (errors.length > 0) {
    console.log('Failed cards:', errors);
  }

  await pool.end();
}

importWhitehatCards();
