import pool from '../backend/db/pool.js';
import generateHexId from '../backend/utils/hexIdGenerator.js';

async function createWhitehatCurriculum() {
  const curriculumId = await generateHexId('curriculum_id');
  console.log('Generated curriculum_id:', curriculumId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO curricula (curriculum_id, curriculum_name, description, domain_id, belt_levels, is_active, display_order, seed_question, summary_statement) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        curriculumId,
        'Ethical White Hat Security v3',
        'FAANG-grade ethical hacking curriculum: 13 phases (P0-P12), 159 cards.',
        '#AE0010',
        ['white_belt', 'blue_belt', 'purple_belt', 'brown_belt', 'black_belt'],
        true,
        3,
        'What is the difference between ethical hacking and illegal hacking?',
        'Master offensive security from foundations through FAANG-level penetration testing, detection engineering, and secure system design.'
      ]
    );
    await client.query('COMMIT');
    console.log('Curriculum created:', curriculumId, '- Ethical White Hat Security v3');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

createWhitehatCurriculum();
