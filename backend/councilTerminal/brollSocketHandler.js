/**
 * B-ROLL SOCKET HANDLER — Fracture Engine Integration
 * 
 * Handles WebSocket events for B-Roll character birth and Omiyage comfort.
 * To be imported by socketHandler.js
 */

import { FractureEngine } from '../../fracture-engine/index.js';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('BrollSocketHandler');
const fractureEngine = new FractureEngine();

/**
 * Attach B-Roll handlers to socket
 * @param {Object} io - Socket.io server
 * @param {Object} socket - Connected socket
 * @param {Object} context - Socket context (userId, characterId, etc)
 */
export function attachBrollHandlers(io, socket, context) {
  
  socket.on('broll:birth', async (data, callback) => {
    try {
      const {
        entityId, objectId, objectType,
        attachmentStrength, entityPAD, oceanScores
      } = data;

      // Compute fracture
      const fracture = fractureEngine.computeFracture({
        sourceP: entityPAD.P,
        sourceA: entityPAD.A,
        sourceD: entityPAD.D,
        attachmentStrength: attachmentStrength || 0.5,
        objectType,
        entityId,
        objectId,
        ocean: oceanScores
      });

      // Generate IDs using existing hex generator from context
      const brollId = await context.generateHexId('character_id');
      const eventId = await context.generateHexId('event_id');
      const trajectoryId = await context.generateHexId('trajectory_id');

      // Persist to database
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(`
          INSERT INTO fracture_events (
            event_id, entity_id, object_id, broll_character_id,
            source_p, source_a, source_d,
            attachment_strength, object_type,
            fractured_p, fractured_a, fractured_d,
            severity_factor, predicted_trajectory, recovery_rate,
            fight_triggered, target_p, target_a, target_d, seed
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `, [
          eventId, entityId, objectId, brollId,
          entityPAD.P, entityPAD.A, entityPAD.D,
          attachmentStrength || 0.5, objectType,
          fracture.P, fracture.A, fracture.D,
          fracture.severityFactor, fracture.trajectory, fracture.recoveryRate,
          fracture.fightTriggered,
          fracture.targetBaseline.P, fracture.targetBaseline.A, fracture.targetBaseline.D,
          fracture.seed
        ]);

        await client.query(`
          INSERT INTO recovery_trajectories (
            trajectory_id, broll_character_id, fracture_event_id,
            trajectory_type, current_p, current_a, current_d
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [trajectoryId, brollId, eventId, fracture.trajectory, fracture.P, fracture.A, fracture.D]);

        await client.query(`
          INSERT INTO psychic_moods (character_id, p, a, d, updated_at)
          VALUES ($1,$2,$3,$4,NOW())
          ON CONFLICT (character_id) DO UPDATE SET p=$2, a=$3, d=$4, updated_at=NOW()
        `, [brollId, fracture.P, fracture.A, fracture.D]);

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      // Broadcast
      socket.join('broll:' + brollId);
      io.to('entity:' + entityId).emit('psychic:fracture', {
        brollId, objectId, fracture, entityId
      });

      callback({ success: true, brollId, fracture });

    } catch (error) {
      logger.error('broll:birth failed', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('broll:omiyage', async (data, callback) => {
    try {
      const { brollId, comfortLevel } = data;

      const result = await pool.query(
        'SELECT current_p, current_a, current_d FROM recovery_trajectories WHERE broll_character_id=$1',
        [brollId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('B-Roll not found');
      }

      const row = result.rows[0];
      const comforted = fractureEngine.applyOmiyage(
        { P: row.current_p, A: row.current_a, D: row.current_d },
        comfortLevel
      );

      await pool.query(`
        UPDATE recovery_trajectories 
        SET omiyage_given=true, omiyage_comfort=$2, omiyage_given_at=NOW(),
            current_p=$3, current_a=$4, current_d=$5
        WHERE broll_character_id=$1
      `, [brollId, comfortLevel, comforted.P, comforted.A, comforted.D]);

      await pool.query(`
        UPDATE psychic_moods SET p=$2, a=$3, d=$4, updated_at=NOW() WHERE character_id=$1
      `, [brollId, comforted.P, comforted.A, comforted.D]);

      io.to('broll:' + brollId).emit('psychic:comfort', { brollId, comforted });

      callback({ success: true, comforted });

    } catch (error) {
      logger.error('broll:omiyage failed', error);
      callback({ success: false, error: error.message });
    }
  });
}
