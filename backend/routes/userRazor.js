/**
 * ============================================================================
 * User Razor Sub-Router — Ockham's Razor Diagnostic API
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Express sub-router handling all /api/user/razor/* endpoints.
 * Mounted by admin.js at /razor. Provides the API for the Ockham's Razor
 * Engine — a diagnostic instrument that evaluates WHY a character's
 * emotional state changed by generating competing hypotheses and scoring
 * them by structural parsimony (simplest adequate explanation wins).
 *
 * ENDPOINTS:
 * ---------------------------------------------------------------------------
 * POST /evaluate              Run a Razor evaluation for a character
 *
 * SECURITY:
 * ---------------------------------------------------------------------------
 * All routes inherit verifyUserAuth from server.js mount.
 * Any authenticated user can run Razor evaluations.
 *
 * ============================================================================
 * PROJECT CONSTRAINTS — READ BEFORE REVIEWING
 * ============================================================================
 *
 * 1. VANILLA JAVASCRIPT ONLY — No TypeScript.
 * 2. NO EXTERNAL AI APIs — All processing is deterministic and rule-based.
 * 3. NO EXTERNAL VALIDATION LIBRARIES — Native regex and type checks only.
 * 4. HEX COLOUR CODE ID SYSTEM — All entity IDs are #XXXXXX format.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 9 — Psychic Monitoring (Razor Diagnostic)
 * ============================================================================
 */

import { Router } from 'express';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import { evaluate } from '../services/ockhamsRazor/index.js';

const logger = createModuleLogger('UserRazor');
const router = Router();

const VALID_DIMENSIONS = ['PLEASURE', 'AROUSAL', 'DOMINANCE'];
const VALID_BELT_LEVELS = ['WHITE', 'YELLOW', 'ORANGE', 'GREEN', 'BLUE', 'PURPLE', 'BLACK'];

/**
 * POST /api/user/razor/evaluate
 *
 * Run a Razor evaluation for a character. Accepts an observation
 * describing a PAD change and returns ranked hypotheses with
 * arbitration, anomaly detection, and context availability.
 *
 * Request body:
 *   characterId      string  REQUIRED  Hex ID e.g. "#700004"
 *   observationType  string  REQUIRED  "pad_change"
 *   dimension        string  REQUIRED  "PLEASURE" | "AROUSAL" | "DOMINANCE"
 *   oldValue         number  REQUIRED  -1.000 to 1.000
 *   newValue         number  REQUIRED  -1.000 to 1.000
 *   userBeltLevel    string  OPTIONAL  Belt level for display gating
 *
 * Response: Full evaluation result (see RAZOR_DATA_CONTRACT.md)
 */
router.post('/evaluate', async (req, res) => {
    const startMs = Date.now();
    const correlationId = req.correlationId || null;

    try {
        const { characterId, observationType, dimension, oldValue, newValue, userBeltLevel } = req.body;

        if (!characterId || !observationType || !dimension || oldValue === undefined || newValue === undefined) {
            logger.warn('Missing required fields', { correlationId, body: req.body });
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: characterId, observationType, dimension, oldValue, newValue'
            });
        }

        if (!isValidHexId(characterId)) {
            logger.warn('Invalid characterId format', { correlationId, characterId });
            return res.status(400).json({
                success: false,
                error: 'Invalid characterId format. Must be #XXXXXX (6 hex digits)'
            });
        }

        if (observationType !== 'pad_change') {
            logger.warn('Invalid observationType', { correlationId, observationType });
            return res.status(400).json({
                success: false,
                error: 'Invalid observationType. Must be "pad_change"'
            });
        }

        if (!VALID_DIMENSIONS.includes(dimension)) {
            logger.warn('Invalid dimension', { correlationId, dimension });
            return res.status(400).json({
                success: false,
                error: 'Invalid dimension. Must be PLEASURE, AROUSAL, or DOMINANCE'
            });
        }

        const oldVal = parseFloat(oldValue);
        const newVal = parseFloat(newValue);

        if (isNaN(oldVal) || isNaN(newVal) || oldVal < -1 || oldVal > 1 || newVal < -1 || newVal > 1) {
            logger.warn('Invalid PAD values', { correlationId, oldValue, newValue });
            return res.status(400).json({
                success: false,
                error: 'oldValue and newValue must be numbers between -1.000 and 1.000'
            });
        }

        if (userBeltLevel && !VALID_BELT_LEVELS.includes(userBeltLevel)) {
            logger.warn('Invalid userBeltLevel', { correlationId, userBeltLevel });
            return res.status(400).json({
                success: false,
                error: 'Invalid userBeltLevel. Must be WHITE, YELLOW, ORANGE, GREEN, BLUE, PURPLE, or BLACK'
            });
        }

        const observation = {
            characterId,
            observationType,
            dimension,
            oldValue: oldVal,
            newValue: newVal,
            timestamp: Date.now(),
            userBeltLevel: userBeltLevel || null
        };

        logger.info('Running Razor evaluation', {
            correlationId,
            characterId,
            dimension,
            oldValue: oldVal,
            newValue: newVal
        });

        const result = await evaluate(observation, { logEvaluation: true });

        logger.info('Razor evaluation complete', {
            correlationId,
            characterId,
            hypothesisCount: result.hypothesisCount,
            winner: result.winner ? result.winner.hypothesis.templateId : null,
            durationMs: result.durationMs,
            routeDurationMs: Date.now() - startMs
        });

        return res.json(result);

    } catch (error) {
        logger.error('Razor evaluation failed', error, {
            correlationId,
            body: req.body,
            durationMs: Date.now() - startMs
        });

        return res.status(500).json({
            success: false,
            error: 'Razor evaluation failed'
        });
    }
});

export default router;
