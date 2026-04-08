import pool from '../backend/db/pool.js';
import generateHexId from '../backend/utils/hexIdGenerator.js';

async function createWhitehatDomain() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const counterCheck = await client.query(
      "SELECT current_value FROM hex_id_counters WHERE id_type = 'domain_id'"
    );

    if (counterCheck.rows.length === 0) {
      await client.query(
        "INSERT INTO hex_id_counters (id_type, last_used_id, current_value) VALUES ('domain_id', '#AE0101', $1)",
        [parseInt('AE0101', 16)]
      );
      console.log('Seeded hex counter for domain_id at current highest: #AE0101');
    }

    await client.query('COMMIT');

    const domainId = await generateHexId('domain_id');
    console.log('Generated domain_id:', domainId);

    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      await client2.query(
        "INSERT INTO knowledge_domains (domain_id, domain_name, description) VALUES ($1, $2, $3)",
        [domainId, 'Ethical White Hat Security', 'FAANG-grade ethical hacking curriculum v3.0 covering web, API, cloud, mobile, DevSecOps, detection engineering, AI/LLM security, and secure system design.']
      );
      await client2.query('COMMIT');
      console.log('Domain created:', domainId, '- Ethical White Hat Security');
    } finally {
      client2.release();
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

createWhitehatDomain();
