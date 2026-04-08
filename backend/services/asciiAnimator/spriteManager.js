import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('spriteManager');

/**
 * In-memory cache for loaded sprites
 * Map<characterId, Map<spriteName, SpriteData>>
 */
const spriteCache = new Map();

/**
 * In-memory cache for animation sequences
 * Map<characterId, Map<sequenceName, SequenceData>>
 */
const sequenceCache = new Map();

/**
 * @typedef {Object} SpriteData
 * @property {string} spriteId - Hex ID
 * @property {string} characterId - Hex ID
 * @property {string} spriteName - Display name
 * @property {string} baseFrame - Full ASCII text
 * @property {number} widthChars - Grid width
 * @property {number} heightChars - Grid height
 * @property {number} createdAt - Timestamp
 */

/**
 * @typedef {Object} SequenceData
 * @property {string} sequenceId - Hex ID
 * @property {string} characterId - Hex ID
 * @property {string} sequenceName - Name
 * @property {string} category - Animation category
 * @property {number} frameRate - FPS
 * @property {boolean} loop - Is looping sequence
 * @property {number} totalFrames - Frame count
 * @property {Array<Object>} frames - Reconstructed frame data
 * @property {Object} metadata - Additional config
 */

/**
 * Reconstructs full frame from base + delta
 * 
 * @param {string} baseFrame - Base ASCII text (multiline)
 * @param {Array<Object>} deltaData - Array of {row, col, char} changes
 * @returns {string[][]} 2D character array
 */
export const reconstructFrame = (baseFrame, deltaData) => {
  if (!deltaData || deltaData.length === 0) {
    // No deltas, parse base frame into 2D array
    return baseFrame.split('\n').map(line => line.split(''));
  }
  
  // Start with base frame as 2D array
  const baseLines = baseFrame.split('\n');
  const result = baseLines.map(line => line.split(''));
  
  // Apply deltas
  for (const delta of deltaData) {
    const row = delta?.row ?? -1;
    const col = delta?.col ?? -1;
    const char = delta?.char ?? ' ';
    
    if (row >= 0 && row < result.length && col >= 0 && col < result[row].length) {
      result[row][col] = char;
    }
  }
  
  return result;
};

/**
 * Loads all sprites for a character from database
 * 
 * @param {string} characterId - Hex character ID
 * @param {Object} pool - PostgreSQL pool
 * @returns {Promise<Map<string, SpriteData>>} Map of spriteName -> data
 */
export const loadCharacterSprites = async (characterId, pool) => {
  // Check cache first
  if (spriteCache.has(characterId)) {
    logger.debug('Sprites cache hit for %s', characterId);
    return spriteCache.get(characterId);
  }
  
  const query = `
    SELECT sprite_id, character_id, sprite_name, sprite_data, 
           width_chars, height_chars, created_at
    FROM character_sprites
    WHERE character_id = $1
  `;
  
  const result = await pool.query(query, [characterId]);
  
  const sprites = new Map();
  for (const row of result.rows) {
    const spriteData = {
      spriteId: row.sprite_id,
      characterId: row.character_id,
      spriteName: row.sprite_name,
      baseFrame: row.sprite_data,
      widthChars: row.width_chars,
      heightChars: row.height_chars,
      createdAt: row.created_at
    };
    sprites.set(row.sprite_name, Object.freeze(spriteData));
  }
  
  // Cache and return
  spriteCache.set(characterId, sprites);
  logger.info('Loaded %d sprites for character %s', sprites.size, characterId);
  return sprites;
};

/**
 * Loads all animation sequences for a character from database
 * Reconstructs all frames into memory for performance
 * 
 * @param {string} characterId - Hex character ID
 * @param {Object} pool - PostgreSQL pool
 * @returns {Promise<Map<string, SequenceData>>} Map of sequenceName -> data
 */
export const loadAnimationSequences = async (characterId, pool) => {
  // Check cache
  if (sequenceCache.has(characterId)) {
    logger.debug('Sequences cache hit for %s', characterId);
    return sequenceCache.get(characterId);
  }
  
  // Load sequences
  const seqQuery = `
    SELECT sequence_id, character_id, sequence_name, sequence_category,
           frame_rate, loop, total_frames, metadata
    FROM animation_sequences
    WHERE character_id = $1
  `;
  
  const seqResult = await pool.query(seqQuery, [characterId]);
  
  const sequences = new Map();
  
  for (const seqRow of seqResult.rows) {
    // Load frames for this sequence
    const frameQuery = `
      SELECT frame_id, frame_index, is_base, frame_data, delta_data, duration_ms
      FROM animation_frames
      WHERE sequence_id = $1
      ORDER BY frame_index ASC
    `;
    
    const frameResult = await pool.query(frameQuery, [seqRow.sequence_id]);
    
    // Reconstruct all frames into memory
    const frames = [];
    let baseFrame = null;
    
    for (const frameRow of frameResult.rows) {
      if (frameRow.is_base) {
        baseFrame = frameRow.frame_data;
        frames.push({
          frameId: frameRow.frame_id,
          index: frameRow.frame_index,
          data: reconstructFrame(baseFrame, []),
          durationMs: frameRow.duration_ms
        });
      } else {
        // Delta frame
        const deltaData = frameRow.delta_data ?? [];
        frames.push({
          frameId: frameRow.frame_id,
          index: frameRow.frame_index,
          data: reconstructFrame(baseFrame, deltaData),
          durationMs: frameRow.duration_ms
        });
      }
    }
    
    const sequenceData = {
      sequenceId: seqRow.sequence_id,
      characterId: seqRow.character_id,
      sequenceName: seqRow.sequence_name,
      category: seqRow.sequence_category,
      frameRate: seqRow.frame_rate,
      loop: seqRow.loop,
      totalFrames: seqRow.total_frames,
      frames: Object.freeze(frames),
      metadata: seqRow.metadata ?? {}
    };
    
    sequences.set(seqRow.sequence_name, Object.freeze(sequenceData));
  }
  
  // Cache and return
  sequenceCache.set(characterId, sequences);
  logger.info('Loaded %d sequences for character %s', sequences.size, characterId);
  return sequences;
};

/**
 * Clears cache for a character (call on character update)
 * 
 * @param {string} characterId - Hex ID to clear
 */
export const clearCharacterCache = (characterId) => {
  spriteCache.delete(characterId);
  sequenceCache.delete(characterId);
  logger.info('Cache cleared for character %s', characterId);
};

/**
 * Clears entire cache (use sparingly)
 */
export const clearAllCache = () => {
  spriteCache.clear();
  sequenceCache.clear();
  logger.info('All sprite/sequence cache cleared');
};

logger.info('Sprite manager initialized');
