/**
 * ============================================================================
 * CotwQueryEngine — Universal Query Engine for Council Terminal
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Processes intent results from cotwIntentMatcher and generates responses.
 * Takes a matched intent (WHO, WHAT, WHERE, WHEN, etc.) and builds the
 * appropriate response text by fetching full entity details from source
 * tables and formatting them for display.
 *
 * WHAT THIS MODULE DOES:
 * ---------------------------------------------------------------------------
 * 1. Receives intentResult from cotwIntentMatcher (entity match + query type)
 * 2. Handles disambiguation actions (not_found, confirm, clarify, disambiguate, refine)
 * 3. Fetches full source row data from the entity's source table (with retry)
 * 4. Routes to type-specific handler (WHO, WHAT, WHICH, IS, CAN, WHEN, WHERE, WHY, HOW, SEARCH)
 * 5. Returns structured response with message, data, realm, and optional action flags
 *
 * WHAT THIS MODULE DOES NOT DO:
 * ---------------------------------------------------------------------------
 * - Does NOT perform intent matching (that is cotwIntentMatcher)
 * - Does NOT perform entity search (that is entityHelpers.js)
 * - Does NOT mutate session state
 * - Does NOT interact with EarWig or HearingReport
 *
 * ARCHITECTURE POSITION:
 * ---------------------------------------------------------------------------
 * cotwIntentMatcher.matchIntent() → cotwQueryEngine.processQuery() → response
 * Called by PhaseIntent after intent matching resolves to entity data.
 * Also called directly for fetchSourceRow() enrichment.
 *
 * EXPORT:
 * ---------------------------------------------------------------------------
 * Default singleton instance: import cotwQueryEngine from '../cotwQueryEngine.js'
 *
 * PUBLIC METHODS:
 * ---------------------------------------------------------------------------
 * processQuery(intentResult, user) — Main entry point for full query processing
 * executeQuery(intentResult, user) — Alias for processQuery
 * fetchSourceRow(entityData, ctx) — Fetch full row from entity source table
 * listAllEntities(realm_hex_id, entityType) — List all entities in a realm
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * - pool (../../db/pool.js) — Database connection
 * - getAllEntitiesInRealm (../../utils/entityHelpers.js) — Entity listing
 * - createModuleLogger (../../utils/logger.js) — Structured logging
 * - withRetry (./utils/withRetry.js) — Transient failure resilience
 * - Counters (./metrics/counters.js) — Observability metrics
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 * - PhaseIntent.js (fetchSourceRow, processQuery)
 *
 * v010 CHANGES FROM v009:
 * ---------------------------------------------------------------------------
 * - Replaced Logger from core/Logger.js with createModuleLogger
 * - Fixed console.error in handleShowImage → structured logger
 * - Removed unused responseCache (declared but never read in v009)
 * - Added explicit whitelist guard in fetchSourceRow (SQL injection safeguard)
 * - Added withRetry on fetchSourceRow DB calls (transient failure resilience)
 * - Added Counters metrics for per-type processing and success/failure rates
 * - Added structured error codes in _errorResponse
 * - Added audit logging on EDIT_PROFILE action
 * - Accept correlationId from caller instead of generating timestamp-based ID
 * - All internal handlers use _camelCase per NAMING_CONVENTIONS.md
 * - Added full documentation header
 *
 * NAMING: camelCase singleton export per NAMING_CONVENTIONS.md
 * LOGGING: Structured logger only — no console.log/console.error
 * ============================================================================
 */

import { getAllEntitiesInRealm } from '../utils/entityHelpers.js';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { withRetry } from './utils/withRetry.js';
import Counters from './metrics/counters.js';

const logger = createModuleLogger('CotwQueryEngine');

/**
 * ============================================================================
 * CONSTANTS
 * ============================================================================
 */

const SOURCE_TABLE_ID_MAP = Object.freeze({
  character_profiles: 'character_id',
  locations: 'location_id',
  knowledge_items: 'knowledge_id',
  multiverse_events: 'event_id',
  objects: 'object_id'
});

const VALID_SOURCE_TABLES = Object.freeze(Object.keys(SOURCE_TABLE_ID_MAP));

const ERROR_CODES = Object.freeze({
  NO_INTENT: 'NO_INTENT_RESULT',
  NO_USER: 'NO_USER_OR_ACCESS_LEVEL',
  UNKNOWN_TYPE: 'UNKNOWN_INTENT_TYPE',
  QUERY_FAILED: 'QUERY_PROCESSING_FAILED',
  ENTITY_LIST_FAILED: 'ENTITY_LIST_FAILED',
  IMAGE_NOT_FOUND: 'IMAGE_TARGET_NOT_IDENTIFIED'
});

/**
 * ============================================================================
 * CotwQueryEngine Class
 * ============================================================================
 */

class CotwQueryEngine {
  constructor() {
    // No state needed — all methods are stateless query processors
  }

  /**
   * Fetch the actual row from the source table for full entity details.
   * Wrapped in withRetry for transient DB failure resilience.
   *
   * @param {Object} entityData - Entity record with source_table and source_hex_id
   * @param {Object} ctx - Context object with correlationId
   * @returns {Promise<Object|null>} Full source row or null
   */
  async fetchSourceRow(entityData, ctx) {
    if (!entityData || !entityData.source_table || !entityData.source_hex_id) {
      return null;
    }

    const { source_table, source_hex_id } = entityData;

    if (!VALID_SOURCE_TABLES.includes(source_table)) {
      logger.warn('Rejected unknown source table in fetchSourceRow', {
        correlationId: ctx?.correlationId,
        sourceTable: source_table
      });
      return null;
    }

    const idColumn = SOURCE_TABLE_ID_MAP[source_table];

    try {
      const result = await withRetry(
        async () => {
          const sql = `SELECT * FROM ${source_table} WHERE ${idColumn} = $1`;
          return pool.query(sql, [source_hex_id]);
        },
        { maxAttempts: 2, backoffMs: 150 }
      );
      Counters.increment('query_engine_fetch', 'success');
      return result.rows[0] || null;
    } catch (error) {
      Counters.increment('query_engine_fetch', 'failure');
      logger.error('Failed to fetch source row', error, {
        correlationId: ctx?.correlationId,
        sourceTable: source_table,
        sourceHexId: source_hex_id
      });
      return null;
    }
  }

  /**
   * Main query processing function.
   * Routes intentResult to appropriate handler based on search action and intent type.
   *
   * @param {Object} intentResult - Result from cotwIntentMatcher.matchIntent()
   * @param {Object} user - User object with access_level
   * @param {Object} [options] - Optional config
   * @param {string} [options.correlationId] - Correlation ID from caller
   * @returns {Promise<Object>} Structured response with success, message, data, realm
   */
  async processQuery(intentResult, user, options = {}) {
    const correlationId = options.correlationId || `qe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ctx = { correlationId };

    if (!intentResult) {
      return this._errorResponse('No intent result provided', ctx, ERROR_CODES.NO_INTENT);
    }

    if (!user || !user.access_level) {
      return this._errorResponse('User object with access_level required', ctx, ERROR_CODES.NO_USER);
    }

    const { type, searchResult, entity, entityData, realm } = intentResult;

    Counters.increment('query_engine_processed', type || 'unknown');

    if (searchResult) {
      switch (searchResult.action) {
        case 'not_found': return this._notFoundResponse(entity, realm, ctx);
        case 'confirm': return this._confirmResponse(searchResult, ctx);
        case 'clarify': return this._clarifyResponse(searchResult, ctx);
        case 'disambiguate': return this._disambiguateResponse(searchResult, ctx);
        case 'refine': return this._refineResponse(searchResult, ctx);
      }
    }

    if (entityData) {
      const fullDetails = await this.fetchSourceRow(entityData, ctx);
      const enrichedData = { ...entityData, ...fullDetails };
      return await this._handleIntentType(type, enrichedData, realm, ctx);
    }

    if (type === 'SHOW_IMAGE') {
      return await this._handleShowImage({ entity_name: entity, entity_type: 'SEARCH' }, realm, ctx);
    }

    return this._errorResponse('Unable to process query', ctx, ERROR_CODES.QUERY_FAILED);
  }

  /**
   * Route to appropriate handler based on intent type.
   */
  async _handleIntentType(type, entityData, realm, ctx) {
    switch (type) {
      case 'WHO': return this._handleWho(entityData, realm, ctx);
      case 'WHAT': return this._handleWhat(entityData, realm, ctx);
      case 'WHICH': return this._handleWhich(entityData, realm, ctx);
      case 'IS': return this._handleIs(entityData, realm, ctx);
      case 'CAN': return this._handleCan(entityData, realm, ctx);
      case 'WHEN': return this._handleWhen(entityData, realm, ctx);
      case 'WHERE': return this._handleWhere(entityData, realm, ctx);
      case 'WHY': return this._handleWhy(entityData, realm, ctx);
      case 'HOW': return this._handleHow(entityData, realm, ctx);
      case 'SEARCH': return this._handleSearch(entityData, realm, ctx);
      case 'SHOW_IMAGE': return this._handleShowImage(entityData, realm, ctx);
      case 'EDIT_PROFILE': return this._handleEditProfile(entityData, realm, ctx);
      default:
        logger.warn('Unknown intent type', { correlationId: ctx?.correlationId, type });
        Counters.increment('query_engine_unknown_type', type || 'null');
        return this._errorResponse(`Unknown intent type: ${type}`, ctx, ERROR_CODES.UNKNOWN_TYPE);
    }
  }

  /*
   * ============================================================================
   * Intent Type Handlers
   * ============================================================================
   */

  /**
   * WHO — Returns information about a person/character.
   */
  async _handleWho(entityData, realm, ctx) {
    const { entity_name, entity_type, category, search_context, biography, description, traits } = entityData;

    if (entity_type === 'KNOWLEDGE') {
      return this._handleWhat(entityData, realm, ctx);
    }

    let message = `**${entity_name}**`;

    if (category) message += ` (${category})`;
    message += '\n';

    if (description) {
      message += `${description}\n`;
    } else if (biography) {
      message += `${biography.substring(0, 300)}${biography.length > 300 ? '...' : ''}\n`;
    } else if (search_context) {
      message += `${search_context}\n`;
    }

    if (traits) {
      const traitsStr = Array.isArray(traits) ? traits.join(', ') : traits;
      message += `\n**Traits:** ${traitsStr}`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * WHAT — Returns definition/explanation.
   */
  async _handleWhat(entityData, realm, ctx) {
    const { entity_name, entity_type, search_context, content, description, definition } = entityData;

    let message = `**${entity_name}**`;

    if (content) {
      try {
        const parsedContent = JSON.parse(content);
        if (parsedContent.statement) {
          message += `\nFact: ${parsedContent.statement}`;
        } else {
          message += `\n${content}`;
        }
      } catch (e) {
        message += `\n${content}`;
      }
    } else if (definition) {
      message += `\n${definition}`;
    } else if (description) {
      message += `\n${description}`;
    } else if (search_context) {
      message += `\n${search_context}`;
    } else {
      message += ` is a ${entity_type.toLowerCase()} in this realm.`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * WHICH — Helps differentiate between options.
   */
  async _handleWhich(entityData, realm, ctx) {
    const { entity_name, category, search_context, description } = entityData;

    let message = `${entity_name}`;

    if (category) {
      message += ` is the ${category}`;
    }

    if (description || search_context) {
      message += ` known for: ${description || search_context}`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * IS — Boolean/verification questions.
   */
  async _handleIs(entityData, realm, ctx) {
    const { entity_name, category } = entityData;

    let message = `Yes, **${entity_name}** exists in this realm.`;

    if (category) {
      message += ` It is classified as: ${category}`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * CAN — Capability questions.
   */
  async _handleCan(entityData, realm, ctx) {
    const { entity_name, abilities, skills, description } = entityData;

    let message = `Regarding abilities of **${entity_name}**:`;

    if (abilities || skills) {
      const caps = abilities || skills;
      message += `\n${Array.isArray(caps) ? caps.join(', ') : caps}`;
    } else if (description) {
      message += `\n${description}`;
    } else {
      message += `\nSpecific capabilities are not documented, but they are a ${entityData.category || entityData.entity_type}.`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * WHEN — Temporal questions.
   */
  async _handleWhen(entityData, realm, ctx) {
    const { entity_name, timestamp, created_at, event_date } = entityData;

    let message = `Regarding **${entity_name}**:`;

    const time = timestamp || event_date || created_at;

    if (time) {
      const dateObj = new Date(time);
      message += `\nThis is associated with the date: ${dateObj.toLocaleString()}`;
    } else {
      message += `\nNo specific timestamp information is available.`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * WHERE — Location questions.
   */
  async _handleWhere(entityData, realm, ctx) {
    const { entity_name, entity_type, location, current_location, coordinates, realm: entityRealm } = entityData;

    let message = `**${entity_name}**`;

    if (entity_type === 'PERSON' || entity_type === 'CHARACTER') {
      if (current_location || location) {
        message += ` is currently located at: ${current_location || location}`;
      } else {
        message += ` location is currently unknown.`;
      }
    } else if (entity_type === 'LOCATION' || entity_type === 'PLACE') {
      message += ` is located in realm ${entityRealm || realm}.`;
      if (coordinates) {
        message += ` (Coordinates: ${coordinates})`;
      }
      if (entityData.description) {
        message += `\n${entityData.description}`;
      }
    } else {
      if (location) {
        message += ` is found at: ${location}`;
      } else {
        message += ` is located within realm ${entityRealm || realm}.`;
      }
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * WHY — Reason/explanation questions.
   */
  async _handleWhy(entityData, realm, ctx) {
    const { entity_name, search_context, description, outcome, notes } = entityData;

    let message = `Regarding **${entity_name}**:`;

    if (notes) {
      message += `\n${notes}`;
    } else if (outcome) {
      message += `\nOutcome: ${outcome}`;
    } else if (description) {
      message += `\n${description}`;
    } else {
      message += `\n${search_context || 'Detailed context is not available.'}`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * HOW — Process/method questions.
   */
  async _handleHow(entityData, realm, ctx) {
    const { entity_name, description, mechanics, instructions } = entityData;

    let message = `**${entity_name}**`;

    if (mechanics) {
      message += ` works via:\n${mechanics}`;
    } else if (instructions) {
      message += `:\n${instructions}`;
    } else if (description) {
      message += `\n${description}`;
    } else {
      message += `\nOperational details are not specified.`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * SEARCH — General search.
   */
  async _handleSearch(entityData, realm, ctx) {
    const { entity_name, description, search_context } = entityData;

    let message = `**${entity_name}**`;
    if (description || search_context) {
      message += `\n${description || search_context}`;
    }

    return { success: true, message, data: entityData, realm };
  }

  /**
   * SHOW_IMAGE — Image display requests.
   * Queries character_image_gallery + multimedia_assets for image URLs.
   */
  async _handleShowImage(entityData, realm, ctx) {
    if (!entityData || !entityData.entity_name) {
      return {
        success: false,
        message: 'Could not identify the target entity for an image request.',
        realm,
        code: ERROR_CODES.IMAGE_NOT_FOUND
      };
    }

    const entityName = entityData.entity_name;
    const characterId = entityData.source_hex_id || entityData.character_id;

    if (characterId) {
      try {
        const result = await withRetry(
          async () => pool.query(
            `SELECT ma.url, ma.description
             FROM character_image_gallery cig
             JOIN multimedia_assets ma ON cig.asset_id = ma.asset_id
             WHERE cig.character_id = $1 AND cig.is_active = true
             ORDER BY cig.display_order
             LIMIT 1`,
            [characterId]
          ),
          { maxAttempts: 2, backoffMs: 150 }
        );

        if (result.rows.length > 0) {
          Counters.increment('query_engine_image', 'found');
          return {
            success: true,
            message: `Here is an image of **${entityName}**.`,
            data: entityData,
            realm,
            action: 'show_image',
            image: result.rows[0].url
          };
        }
      } catch (error) {
        Counters.increment('query_engine_image', 'db_error');
        logger.error('Image gallery query failed', error, {
          correlationId: ctx?.correlationId,
          characterId,
          entityName
        });
      }
    }

    const imageUrl = entityData.profile_image || entityData.image_url;
    if (imageUrl) {
      Counters.increment('query_engine_image', 'fallback');
      return {
        success: true,
        message: `Here is an image of **${entityName}**.`,
        data: entityData,
        realm,
        action: 'show_image',
        image: imageUrl
      };
    }

    Counters.increment('query_engine_image', 'not_found');
    return {
      success: true,
      message: `I do not have any images of **${entityName}** in my records.`,
      data: entityData,
      realm,
      image: null
    };
  }

  /**
   * EDIT_PROFILE — Returns data and action flag for client to open editor UI.
   * Includes audit logging for security traceability.
   */
  async _handleEditProfile(entityData, realm, ctx) {
    const { entity_name } = entityData;

    logger.info('Profile edit requested', {
      correlationId: ctx?.correlationId,
      entityName: entity_name,
      entityId: entityData.entity_id || entityData.source_hex_id,
      realm
    });

    Counters.increment('query_engine_edit_profile', 'requested');

    return {
      success: true,
      message: `Opening editor for **${entity_name}**. The client MUST now switch to the full editing UI.`,
      data: entityData,
      realm,
      action: 'edit_profile'
    };
  }

  /*
   * ============================================================================
   * Disambiguation Response Handlers
   * ============================================================================
   */

  _notFoundResponse(entity, realm, ctx) {
    Counters.increment('query_engine_disambiguation', 'not_found');
    return {
      success: false,
      message: `I couldn't find "${entity}" in this realm.`,
      realm,
      action: 'not_found'
    };
  }

  _confirmResponse(searchResult, ctx) {
    Counters.increment('query_engine_disambiguation', 'confirm');
    return {
      success: true,
      message: searchResult.message,
      data: searchResult.entity,
      confidence: searchResult.confidence,
      realm: searchResult.realm,
      action: 'confirm'
    };
  }

  _clarifyResponse(searchResult, ctx) {
    Counters.increment('query_engine_disambiguation', 'clarify');
    return {
      success: true,
      message: searchResult.message,
      data: searchResult.entity,
      confidence: searchResult.confidence,
      realm: searchResult.realm,
      action: 'clarify'
    };
  }

  _disambiguateResponse(searchResult, ctx) {
    Counters.increment('query_engine_disambiguation', 'disambiguate');
    const optionsList = searchResult.options
      .map(opt => `${opt.number}. ${opt.entity_name} (${opt.entity_type})`)
      .join('\n');

    return {
      success: true,
      message: `${searchResult.message}\n${optionsList}`,
      options: searchResult.options,
      realm: searchResult.realm,
      action: 'disambiguate'
    };
  }

  _refineResponse(searchResult, ctx) {
    Counters.increment('query_engine_disambiguation', 'refine');
    const matchesList = searchResult.top_matches
      .map(m => `- ${m.entity_name} (${m.entity_type})`)
      .join('\n');

    return {
      success: true,
      message: `${searchResult.message}\n\nSome examples:\n${matchesList}`,
      realm: searchResult.realm,
      action: 'refine'
    };
  }

  /**
   * Structured error response with optional error code.
   *
   * @param {string} message - Human-readable error message
   * @param {Object} ctx - Context with correlationId
   * @param {string} [code] - Machine-readable error code from ERROR_CODES
   * @returns {Object} Error response object
   */
  _errorResponse(message, ctx, code) {
    if (ctx?.correlationId) {
      logger.warn('Query engine error response', {
        correlationId: ctx.correlationId,
        message,
        code: code || 'UNSPECIFIED'
      });
    }
    Counters.increment('query_engine_error', code || 'unspecified');
    return {
      success: false,
      message: message || 'An error occurred processing your query',
      code: code || null
    };
  }

  /*
   * ============================================================================
   * Utility Methods
   * ============================================================================
   */

  /**
   * List all entities in a realm.
   * Useful for admin/debugging and "show me everything" type queries.
   *
   * @param {string} realm_hex_id - Realm hex ID (e.g., '#F00000')
   * @param {string} entityType - Optional entity type filter
   * @returns {Promise<Object>} Structured response with grouped entity list
   */
  async listAllEntities(realm_hex_id, entityType = null) {
    try {
      const entities = await getAllEntitiesInRealm(realm_hex_id, entityType, 100);

      if (entities.length === 0) {
        return {
          success: false,
          message: `No entities found in realm ${realm_hex_id}`,
          realm: realm_hex_id
        };
      }

      const grouped = entities.reduce((acc, entity) => {
        const type = entity.entity_type;
        if (!acc[type]) acc[type] = [];
        acc[type].push(entity.entity_name);
        return acc;
      }, {});

      let message = 'Entities in this realm:\n\n';

      for (const [type, names] of Object.entries(grouped)) {
        message += `${type}:\n`;
        message += names.map(n => `  - ${n}`).join('\n');
        message += '\n\n';
      }

      Counters.increment('query_engine_list', 'success');
      return {
        data: entities,
        success: true,
        message,
        realm: realm_hex_id
      };
    } catch (error) {
      Counters.increment('query_engine_list', 'failure');
      logger.error('Failed to list entities', error, { realmHexId: realm_hex_id });
      return this._errorResponse('Failed to retrieve entity list', null, ERROR_CODES.ENTITY_LIST_FAILED);
    }
  }

  /**
   * Alias for processQuery — backwards compatibility.
   */
  async executeQuery(intentResult, user, options = {}) {
    return await this.processQuery(intentResult, user, options);
  }
}

export default new CotwQueryEngine();
