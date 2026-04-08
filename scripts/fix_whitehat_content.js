import pool from '../backend/db/pool.js';

async function fixWhitehatContent() {
  const result = await pool.query(
    "SELECT knowledge_id, content, answer_statement FROM knowledge_items WHERE curriculum_id = '#CB0003'"
  );

  console.log('Cards to fix:', result.rows.length);

  let fixed = 0;
  let errors = [];

  for (const row of result.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const contentJson = JSON.stringify({
        teaching_statement: row.answer_statement || '',
        testing_statement: row.content || '',
        answer_statement: row.answer_statement || ''
      });

      await client.query(
        'UPDATE knowledge_items SET content = $1 WHERE knowledge_id = $2',
        [contentJson, row.knowledge_id]
      );

      await client.query('COMMIT');
      fixed++;
    } catch (err) {
      await client.query('ROLLBACK');
      errors.push({ id: row.knowledge_id, error: err.message });
      console.error('Error on', row.knowledge_id, ':', err.message);
    } finally {
      client.release();
    }
  }

  console.log('Fixed:', fixed);
  console.log('Errors:', errors.length);
  if (errors.length > 0) console.log(errors);

  await pool.end();
}

fixWhitehatContent();
