/**
 * ============================================================================
 * ConciergeStatusReportService.js — Login Status Report Generator (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Generates a conversational status report when a user logs in.
 * This is the implementation of Goal 6: "Claude remembers last session
 * on login." When a user connects, this service gathers real data from
 * 12 sources in parallel, then weaves it into a natural-language report
 * using LTLM utterance selection for personality-consistent tone.
 *
 * DATA SOURCES (12 parallel queries)
 * -----------------------------------
 * 1. Onboarding state (user_onboarding_state)
 * 2. Omiyage gift state (omiyage_choice_state + objects)
 * 3. Belt progression (user_belt_progression + knowledge_domains)
 * 4. Knowledge state (user_knowledge_state aggregates)
 * 5. Language learned (cotw_user_language)
 * 6. Psychological profile (cotw_dossiers)
 * 7. User record (users — username, access_level, last_login)
 * 8. Inventory (character_inventory + objects via owned_character_id)
 * 9. Tanuki profile (user_tanuki_profile via owned_character_id)
 * 10. Narrative beats (narrative_beat_play_log count)
 * 11. Full COTW dossier (cotw_dossiers — pad_snapshot, notes, helpdesk)
 * 12. Interaction summary (userInteractionMemoryService — optional)
 *
 * REPORT STRUCTURE
 * ----------------
 * 1. Greeting (LTLM utterance, context-aware: first visit / same day /
 *    returning / long absence)
 * 2. Last visit timestamp
 * 3. Onboarding status
 * 4. Omiyage gift status
 * 5. Belt progression per domain
 * 6. Knowledge learning stats
 * 7. Dossier notes or language learned
 * 8. Psychological profile (PAD averages, volatility, labels)
 * 9. Current PAD snapshot
 * 10. Helpdesk context (learning gaps, pending escalations)
 * 11. Inventory status
 * 12. Open invitation
 *
 * All report text comes from real database state. No hardcoded
 * placeholder text except graceful fallbacks when LTLM has no match.
 *
 * CONSUMERS
 * ---------
 * - PhaseClaudesHelpDesk: calls generateStatusReport on login
 * - socketHandler: triggers on user connect
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, ltlmUtteranceSelector.js
 * Optional: userInteractionMemoryService.js (graceful if missing)
 * External: None
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { CLAUDE_CHARACTER_ID } from '../councilTerminal/config/constants.js';
import { createModuleLogger } from '../utils/logger.js';
import { selectLtlmUtteranceForBeat } from './ltlmUtteranceSelector.js';

const logger = createModuleLogger('ConciergeStatusReport');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Optional import: userInteractionMemoryService                             */
/*  If not yet migrated to v010, interactionSummary will be null              */
/* ────────────────────────────────────────────────────────────────────────── */

let getInteractionSummary = null;
try {
  const uimsModule = await import('./userInteractionMemoryService.js');
  getInteractionSummary = uimsModule.getInteractionSummary;
} catch (_importErr) {
  logger.warn('userInteractionMemoryService not available, interaction summary disabled');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Timeout Utility                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function _withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    })
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */


const DEFAULT_PAD_TARGET = Object.freeze({
  pleasure: 0.5,
  arousal: 0.2,
  dominance: 0
});

const GREETING_CATEGORIES = Object.freeze({
  FIRST_MEETING: 'social.greeting.first_meeting',
  SAME_DAY: 'social.greeting.returning_same_day',
  SHORT_ABSENCE: 'social.greeting.returning_after_absence',
  LONG_ABSENCE: 'social.greeting.returning_long_absence'
});

const LTLM_DEFAULTS = Object.freeze({
  SPEECH_ACT: 'social.inform',
  OUTCOME_INTENT: 'relational_outcomes.acknowledge',
  GREETING_SPEECH_ACT: 'social.greet',
  GREETING_OUTCOME: 'relational_outcomes.build_rapport'
});

const VOLATILITY_THRESHOLDS = Object.freeze({
  STABLE: 0.05,
  VOLATILE: 0.15
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _validateNonEmptyString(value, name) {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    throw new Error('ConciergeStatusReport: ' + name + ' must be a non-empty string, got: ' + typeof value);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  ConciergeStatusReportService Class                                        */
/* ────────────────────────────────────────────────────────────────────────── */

function _poolQueryWithTimeout(sql, params) {
  let timer;
  return Promise.race([
    pool.query(sql, params).then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Query timeout")), 5000);
    })
  ]);
}

class ConciergeStatusReportService {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Generate Status Report                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async generateStatusReport(userId, correlationId) {
    _validateNonEmptyString(userId, 'userId');

    try {
      logger.debug('Starting status report generation', { correlationId, userId });

      const ownedCharacterId = await this._getOwnedCharacterId(userId, correlationId);

      const [
        onboardingState,
        omiyageState,
        beltProgress,
        knowledgeState,
        languageLearned,
        userRecord,
        inventory,
        tanukiProfile,
        narrativeBeats,
        cotwDossier,
        interactionSummary
      ] = await Promise.all([
        this._getOnboardingState(userId, correlationId),
        this._getOmiyageState(userId, correlationId),
        this._getBeltProgression(userId, correlationId),
        this._getKnowledgeState(userId, correlationId),
        this._getLanguageLearned(userId, correlationId),
        this._getUserRecord(userId, correlationId),
        this._getUserInventory(ownedCharacterId, correlationId),
        this._getTanukiProfile(ownedCharacterId, correlationId),
        this._getNarrativeBeats(userId, correlationId),
        this._getFullCotwDossier(userId, correlationId),
        this._getInteractionSummary(userId, correlationId)
      ]);

      const reportData = {
        onboarding: onboardingState,
        omiyage: omiyageState,
        belt: beltProgress,
        knowledge: knowledgeState,
        language: languageLearned,
        user: userRecord,
        inventory,
        tanuki: tanukiProfile,
        narrative: narrativeBeats,
        cotwDossier,
        interactionSummary
      };

      const report = await this._buildConversationalReport(reportData, correlationId);

      logger.info('Report generated successfully', { correlationId, userId });

      return {
        success: true,
        report,
        data: reportData
      };

    } catch (error) {
      logger.error('Error generating report', { correlationId, userId, error: error.message });

      return {
        success: false,
        error: error.message,
        report: "I encountered a moment of confusion. Give me a second to gather my thoughts..."
      };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: LTLM Helper (eliminates repeated call pattern)                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _selectUtterance(dialogueFunctionCode, targetPad, correlationId) {
    try {
      const result = await _withTimeout(selectLtlmUtteranceForBeat({
        speakerCharacterId: CLAUDE_CHARACTER_ID,
        speechActCode: LTLM_DEFAULTS.SPEECH_ACT,
        dialogueFunctionCode,
        outcomeIntentCode: LTLM_DEFAULTS.OUTCOME_INTENT,
        targetPad: targetPad || DEFAULT_PAD_TARGET,
        contextText: null
      }), 5000, 'selectLtlmUtteranceForBeat');
      return result?.utteranceText || null;
    } catch (err) {
      logger.warn('LTLM utterance selection failed', {
        dialogueFunctionCode,
        correlationId,
        error: err.message
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Shared character ID lookup (eliminates duplicate query)        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _getOwnedCharacterId(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT owned_character_id FROM users WHERE user_id = $1',
        [userId]
      );
      return result.rows[0]?.owned_character_id || null;
    } catch (error) {
      logger.error('Error fetching owned character ID', { userId, correlationId, error: error.message });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Data Gathering Methods                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _getOnboardingState(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT current_state, state_version, entered_at FROM user_onboarding_state WHERE user_id = $1',
        [userId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching onboarding state', { userId, correlationId, error: error.message });
      return null;
    }
  }

  async _getOmiyageState(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT ocs.choice_id, ocs.status, ocs.chosen_number, ocs.offer_count, ocs.fulfilled_at, ocs.resolved_object_id, o.object_name ' +
        'FROM omiyage_choice_state ocs ' +
        'LEFT JOIN objects o ON ocs.resolved_object_id = o.object_id ' +
        'WHERE ocs.user_id = $1 LIMIT 1',
        [userId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching omiyage state', { userId, correlationId, error: error.message });
      return null;
    }
  }

  async _getBeltProgression(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT ubp.domain_id, kd.domain_name, ubp.current_belt, ubp.current_stripes, ' +
        'ubp.total_tse_cycles, ubp.successful_cycles, ubp.current_success_rate, ' +
        'ubp.status_rusty, ubp.promoted_at ' +
        'FROM user_belt_progression ubp ' +
        'JOIN knowledge_domains kd ON ubp.domain_id = kd.domain_id ' +
        'WHERE ubp.user_id = $1 ORDER BY ubp.updated_at DESC',
        [userId]
      );
      return result.rows || [];
    } catch (error) {
      logger.error('Error fetching belt progression', { userId, correlationId, error: error.message });
      return [];
    }
  }

  async _getKnowledgeState(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT COUNT(*) as total_items, AVG(stability) as avg_stability, ' +
        'MAX(stability) as max_stability, SUM(practice_count) as total_practice ' +
        'FROM user_knowledge_state WHERE user_id = $1',
        [userId]
      );
      return result.rows[0] || { total_items: 0 };
    } catch (error) {
      logger.error('Error fetching knowledge state', { userId, correlationId, error: error.message });
      return null;
    }
  }

  async _getLanguageLearned(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT COUNT(*) as phrase_count, ' +
        '(array_agg(learned_phrase ORDER BY date_learned DESC))[1:5] as sample_phrases ' +
        'FROM cotw_user_language WHERE user_id = $1',
        [userId]
      );
      return result.rows[0] || { phrase_count: 0 };
    } catch (error) {
      logger.error('Error fetching language learned', { userId, correlationId, error: error.message });
      return null;
    }
  }

  async _getUserRecord(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT username, last_login, access_level FROM users WHERE user_id = $1',
        [userId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching user record', { userId, correlationId, error: error.message });
      return null;
    }
  }

  async _getUserInventory(characterId, correlationId) {
    if (!characterId) return { item_count: 0, items: [] };

    try {
      const result = await _poolQueryWithTimeout(
        'SELECT ci.inventory_entry_id, ci.object_id, o.object_name, ci.acquired_at ' +
        'FROM character_inventory ci ' +
        'LEFT JOIN objects o ON ci.object_id = o.object_id ' +
        'WHERE ci.character_id = $1 ORDER BY ci.acquired_at DESC',
        [characterId]
      );
      const items = result.rows || [];
      return { item_count: items.length, items };
    } catch (error) {
      logger.error('Error fetching inventory', { characterId, correlationId, error: error.message });
      return { item_count: 0, items: [] };
    }
  }

  async _getTanukiProfile(characterId, correlationId) {
    if (!characterId) return null;

    try {
      const result = await _poolQueryWithTimeout(
        'SELECT current_tanuki_level, total_interactions FROM user_tanuki_profile WHERE character_id = $1',
        [characterId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching tanuki profile', { characterId, correlationId, error: error.message });
      return null;
    }
  }

  async _getNarrativeBeats(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT COUNT(*) as beat_count FROM narrative_beat_play_log WHERE user_id = $1',
        [userId]
      );
      return result.rows[0] || { beat_count: 0 };
    } catch (error) {
      logger.error('Error fetching narrative beats', { userId, correlationId, error: error.message });
      return null;
    }
  }

  async _getFullCotwDossier(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        'SELECT dossier_id, psychological_profile, pad_snapshot, helpdesk_context, ' +
        'notes, omiyage_summary, relationship_status, created_at, updated_at, previous_login ' +
        'FROM cotw_dossiers WHERE user_id = $1 AND dossier_type = $2',
        [userId, 'user']
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error fetching full COTW dossier', { userId, correlationId, error: error.message });
      return null;
    }
  }

  async _getInteractionSummary(userId, correlationId) {
    if (!getInteractionSummary) return null;

    try {
      return await _withTimeout(getInteractionSummary(userId, correlationId), 3000, 'getInteractionSummary');
    } catch (error) {
      logger.warn('Interaction summary failed, continuing without', { userId, correlationId, error: error.message });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Formatting Helpers                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  _formatPadSnapshot(padSnapshot) {
    if (!padSnapshot) return null;
    return {
      p: (padSnapshot.p || 0).toFixed(2),
      a: (padSnapshot.a || 0).toFixed(2),
      d: (padSnapshot.d || 0).toFixed(2)
    };
  }

  _formatPsychologicalProfile(psychProfile) {
    if (!psychProfile) return null;
    return {
      avgP: (psychProfile.avg_p || 0).toFixed(2),
      avgA: (psychProfile.avg_a || 0).toFixed(2),
      avgD: (psychProfile.avg_d || 0).toFixed(2),
      volatility: (psychProfile.volatility || 0).toFixed(3),
      labels: psychProfile.labels || []
    };
  }

  _formatTopic(topicName) {
    if (!topicName) return 'Unknown';
    return topicName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  _cleanSubstitutedText(text) {
    if (!text) return text;
    let cleaned = text.trim();
    if (cleaned.startsWith(', ')) {
      cleaned = cleaned.slice(2);
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
    return cleaned;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Conversational Report Builder                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _buildConversationalReport(data, correlationId) {
    const parts = [];

    await this._buildGreeting(parts, data, correlationId);
    await this._buildOnboardingSection(parts, data, correlationId);
    await this._buildOmiyageSection(parts, data, correlationId);
    await this._buildBeltSection(parts, data, correlationId);
    this._buildKnowledgeSection(parts, data);
    this._buildNotesSection(parts, data);
    this._buildPsychologySection(parts, data);
    this._buildHelpdeskSection(parts, data);
    await this._buildInventorySection(parts, data, correlationId);
    parts.push('');
    const closingText = await this._selectUtterance('status.report.closing.invite', null, correlationId);
    const username = data.user?.username || 'traveller';
    parts.push((closingText || 'What would you like to explore today?').replace(/<SUBJECT>/g, username));

    return parts.join('\n\n');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Report Section Builders                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _buildGreeting(parts, data, correlationId) {
    const username = data.user?.username || 'traveller';
    let greetingCategory = GREETING_CATEGORIES.FIRST_MEETING;
    let targetPad = DEFAULT_PAD_TARGET;

    if (data.cotwDossier?.previous_login) {
      const previousLogin = new Date(data.cotwDossier.previous_login);
      const daysSince = Math.floor((Date.now() - previousLogin.getTime()) / (1000 * 60 * 60 * 24));

      if (daysSince === 0) {
        greetingCategory = GREETING_CATEGORIES.SAME_DAY;
      } else if (daysSince < 7) {
        greetingCategory = GREETING_CATEGORIES.SHORT_ABSENCE;
      } else {
        greetingCategory = GREETING_CATEGORIES.LONG_ABSENCE;
      }
    }

    if (data.cotwDossier?.psychological_profile) {
      const psych = data.cotwDossier.psychological_profile;
      targetPad = {
        pleasure: psych.avgP ?? psych.avg_p ?? 0.5,
        arousal: psych.avgA ?? psych.avg_a ?? 0.2,
        dominance: psych.avgD ?? psych.avg_d ?? 0
      };
    }

    try {
      const greetingResult = await _withTimeout(selectLtlmUtteranceForBeat({
        speakerCharacterId: CLAUDE_CHARACTER_ID,
        speechActCode: LTLM_DEFAULTS.GREETING_SPEECH_ACT,
        dialogueFunctionCode: greetingCategory,
        outcomeIntentCode: LTLM_DEFAULTS.GREETING_OUTCOME,
        targetPad,
        contextText: null
      }), 5000, 'selectLtlmUtteranceForBeat.greeting');

      if (greetingResult?.utteranceText) {
        const greetingText = this._cleanSubstitutedText(
          greetingResult.utteranceText.replace(/<SUBJECT>/g, username)
        );
        parts.push(greetingText);
      } else {
        parts.push('Welcome back, ' + username + '.');
      }
    } catch (err) {
      logger.warn('Greeting LTLM failed, using fallback', { correlationId, error: err.message });
      parts.push('Welcome back, ' + username + '.');
    }

    if (data.cotwDossier?.previous_login) {
      const formattedDate = new Date(data.cotwDossier.previous_login).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
      parts.push('Your last visit was ' + formattedDate + '.');
    }

    parts.push('');
  }

  async _buildOnboardingSection(parts, data, correlationId) {
    if (!data.onboarding) return;

    if (data.onboarding.current_state === 'onboarded') {
      const text = await this._selectUtterance('status.report.onboarding.complete', null, correlationId);
      const username = data.user?.username || 'traveller';
      parts.push((text || 'You are fully onboarded and ready for the Realm.').replace(/<SUBJECT>/g, username));
    } else {
      const text = await this._selectUtterance('status.report.onboarding.progress', null, correlationId);
      if (text) {
        const username = data.user?.username || 'traveller';
        parts.push(text.replace(/<STATE>/g, data.onboarding.current_state).replace(/<SUBJECT>/g, username));
      } else {
        parts.push('Your onboarding journey is at: ' + data.onboarding.current_state + '.');
      }
    }
  }

  async _buildOmiyageSection(parts, data, correlationId) {
    if (!data.omiyage || data.omiyage.status !== 'fulfilled') return;

    const username = data.user?.username || 'traveller';
    const date = new Date(data.omiyage.fulfilled_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });

    const text = await this._selectUtterance('status.report.omiyage.received', null, correlationId);
    if (text) {
      const substituted = this._cleanSubstitutedText(
        text
          .replace(/<SUBJECT>/g, username)
          .replace(/<DATE>/g, date)
          .replace(/<COUNT>/g, data.omiyage.chosen_number)
          .replace(/<TOTAL>/g, data.omiyage.offer_count)
          .replace(/<OBJECT>/g, data.omiyage.object_name || 'gift')
      );
      parts.push(substituted);
    } else {
      parts.push('You received your gift on ' + date + '. You chose #' + data.omiyage.chosen_number + ' of ' + data.omiyage.offer_count + '.');
    }

    parts.push('');
  }

  async _buildBeltSection(parts, data, correlationId) {
    if (!data.belt || data.belt.length === 0) {
      parts.push('');
      return;
    }

    const username = data.user?.username || 'traveller';

    for (const beltEntry of data.belt) {
      const text = await this._selectUtterance('status.report.belt.current', null, correlationId);
      if (text) {
        const substituted = this._cleanSubstitutedText(
          text
            .replace(/<SUBJECT>/g, username)
            .replace(/<BELT>/g, this._formatTopic(beltEntry.current_belt))
            .replace(/<DOMAIN>/g, this._formatTopic(beltEntry.domain_name))
        );
        parts.push(substituted);
      } else {
        parts.push('You are a ' + this._formatTopic(beltEntry.current_belt) + ' in ' + this._formatTopic(beltEntry.domain_name) + '.');
      }

      if (beltEntry.total_tse_cycles > 0) {
        const successRate = beltEntry.current_success_rate
          ? ' (' + (parseFloat(beltEntry.current_success_rate) * 100).toFixed(0) + '% success rate)'
          : '';
        parts.push(beltEntry.successful_cycles + ' of ' + beltEntry.total_tse_cycles + ' learning cycles completed' + successRate + '.');
      } else {
        parts.push('No learning cycles completed yet. There is always time.');
      }

      if (beltEntry.status_rusty) {
        parts.push('Your skills have gone a bit rusty from lack of practice.');
      }
    }

    parts.push('');
  }

  _buildKnowledgeSection(parts, data) {
    if (!data.knowledge || data.knowledge.total_items <= 0) return;

    parts.push('You are learning ' + data.knowledge.total_items + ' knowledge items.');

    if (data.knowledge.max_stability > 20) {
      parts.push('Your strongest memory has a stability of ' + Math.floor(data.knowledge.max_stability) + ' days (time before review needed).');
    }

    if (data.knowledge.total_practice > 0) {
      parts.push('You have practiced ' + data.knowledge.total_practice + ' times across all topics.');
    }
  }

  _buildNotesSection(parts, data) {
    if (data.cotwDossier?.notes) {
      parts.push('');
      parts.push('Notes on you: ' + data.cotwDossier.notes);
    } else if (data.language?.phrase_count > 0) {
      parts.push('');
      parts.push('I have been learning how you speak. ' + data.language.phrase_count + ' phrases so far.');

      if (data.language.sample_phrases && data.language.sample_phrases.length > 0) {
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
        const phraseIndex = dayOfYear % data.language.sample_phrases.length;
        parts.push('Like: "' + data.language.sample_phrases[phraseIndex] + '"');
      }
    }
  }

  _buildPsychologySection(parts, data) {
    if (data.cotwDossier?.psychological_profile) {
      const psych = this._formatPsychologicalProfile(data.cotwDossier.psychological_profile);
      parts.push('');

      if (psych.labels && psych.labels.length > 0) {
        parts.push('Your emotional state: ' + psych.labels.join(', ').toLowerCase() + '.');
      }

      const sampleCount = data.cotwDossier.psychological_profile.sample_count || 0;
      parts.push('Emotional average (' + sampleCount + ' readings): P ' + psych.avgP + ', A ' + psych.avgA + ', D ' + psych.avgD + '.');

      let volatilityLabel = 'moderate';
      if (parseFloat(psych.volatility) < VOLATILITY_THRESHOLDS.STABLE) {
        volatilityLabel = 'stable';
      } else if (parseFloat(psych.volatility) > VOLATILITY_THRESHOLDS.VOLATILE) {
        volatilityLabel = 'volatile';
      }
      parts.push('Emotional volatility: ' + psych.volatility + ' (' + volatilityLabel + ').');
    }

    if (data.cotwDossier?.pad_snapshot) {
      const padNow = this._formatPadSnapshot(data.cotwDossier.pad_snapshot);
      parts.push('');
      parts.push('Current state: P ' + padNow.p + ', A ' + padNow.a + ', D ' + padNow.d + '.');
    }
  }

  _buildHelpdeskSection(parts, data) {
    if (!data.cotwDossier?.helpdesk_context) return;

    const hd = data.cotwDossier.helpdesk_context;

    if (hd.b_rollHelpdesk?.learningGapsIdentified && hd.b_rollHelpdesk.learningGapsIdentified.length > 0) {
      parts.push('');
      parts.push('Learning gaps identified: ' + hd.b_rollHelpdesk.learningGapsIdentified.join(', ') + '.');
    }

    if (hd.escalationHistory && hd.escalationHistory.length > 0) {
      const pendingEscalations = hd.escalationHistory.filter(e => e.status === 'pending');
      if (pendingEscalations.length > 0) {
        parts.push('');
        parts.push('Pending escalations: ' + pendingEscalations.map(e => e.intent).join(', ') + '.');
      }
    }
  }

  async _buildInventorySection(parts, data, correlationId) {
    if (!data.inventory) return;

    const itemCount = data.inventory.item_count;
    const username = data.user?.username || 'traveller';

    if (itemCount === 0) {
      const text = await this._selectUtterance('status.report.inventory.empty', null, correlationId);
      parts.push('');
      parts.push((text || 'Your inventory is empty. Ready to gather more?').replace(/<SUBJECT>/g, username));
    } else if (itemCount === 1) {
      const itemName = data.inventory.items[0]?.object_name || 'item';
      const text = await this._selectUtterance('status.report.inventory.single.item', null, correlationId);
      parts.push('');
      if (text) {
        parts.push(text.replace(/<ITEM>/g, itemName).replace(/<SUBJECT>/g, username));
      } else {
        parts.push('You are carrying a single item: the ' + itemName + '.');
      }
    } else {
      const text = await this._selectUtterance('status.report.inventory.count', null, correlationId);
      parts.push('');
      if (text) {
        parts.push(text.replace(/<COUNT>/g, itemCount).replace(/<SUBJECT>/g, username));
      } else {
        parts.push('You are carrying ' + itemCount + ' items.');
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new ConciergeStatusReportService();
