import { createModuleLogger } from '../../utils/logger.js';
import { safeFloat } from '../../utils/safeFloat.js';

const logger = createModuleLogger('personalityEngine');

/**
 * Default thresholds for PAD coordinate effects
 * All proposed — requires calibration
 */
const PAD_THRESHOLDS = Object.freeze({
  pleasure: { high: 0.6, low: -0.4 },
  arousal: { high: 0.7, low: 0.3 },
  dominance: { high: 0.6, low: -0.6 }
});

/**
 * OCEAN trait thresholds
 * proposed — requires calibration
 */
const OCEAN_THRESHOLDS = Object.freeze({
  high: 70,
  low: 30
});

/**
 * Computes animation parameter modifiers from personality and emotion
 * 
 * @param {Object} oceanScores - Big Five scores (0-100 each)
 * @param {number} oceanScores.openness
 * @param {number} oceanScores.conscientiousness
 * @param {number} oceanScores.extraversion
 * @param {number} oceanScores.agreeableness
 * @param {number} oceanScores.neuroticism
 * @param {Object} padCoordinates - Emotion coordinates (-1 to 1 each)
 * @param {number} padCoordinates.pleasure
 * @param {number} padCoordinates.arousal
 * @param {number} padCoordinates.dominance
 * @returns {Object} Modifier configuration
 */
export const computeAnimationModifiers = (oceanScores, padCoordinates) => {
  const {
    openness = 50,
    conscientiousness = 50,
    extraversion = 50,
    agreeableness = 50,
    neuroticism = 50
  } = oceanScores ?? {};
  
  const {
    pleasure = 0,
    arousal = 0,
    dominance = 0
  } = padCoordinates ?? {};
  
  const safeExtraversion = safeFloat(extraversion);
  const safeNeuroticism = safeFloat(neuroticism);
  const safeConscientiousness = safeFloat(conscientiousness);
  
  // Frame rate modifiers based on extraversion
  // High extraversion = faster, more energetic animations
  let frameRateMultiplier = 1.0;
  if (safeExtraversion > OCEAN_THRESHOLDS.high) {
    frameRateMultiplier = 1.3; // proposed — requires calibration
  } else if (safeExtraversion < OCEAN_THRESHOLDS.low) {
    frameRateMultiplier = 0.7; // proposed — requires calibration
  }
  
  // Fidget frequency based on neuroticism
  // High neuroticism = more frequent idle fidgets
  let fidgetFrequencyMultiplier = 1.0;
  if (safeNeuroticism > OCEAN_THRESHOLDS.high) {
    fidgetFrequencyMultiplier = 2.0; // proposed — requires calibration
  }
  
  // Predictability based on conscientiousness
  // High conscientiousness = fewer random variations, more consistent timing
  const deterministic = safeConscientiousness > OCEAN_THRESHOLDS.high;
  
  // Emotion availability based on PAD coordinates
  const emotionJoyAvailable = safeFloat(pleasure) > PAD_THRESHOLDS.pleasure.high;
  const emotionDistressAvailable = safeFloat(pleasure) < PAD_THRESHOLDS.pleasure.low;
  const emotionAlertAvailable = safeFloat(arousal) > PAD_THRESHOLDS.arousal.high;
  
  // Arousal affects animation speed
  if (safeFloat(arousal) > PAD_THRESHOLDS.arousal.high) {
    frameRateMultiplier *= 1.4; // proposed — requires calibration
  }
  
  // Dominance affects posture (vertical offset in rows)
  let postureSizeModifier = 0;
  if (safeFloat(dominance) > PAD_THRESHOLDS.dominance.high) {
    postureSizeModifier = 1; // Tall posture
  } else if (safeFloat(dominance) < PAD_THRESHOLDS.dominance.low) {
    postureSizeModifier = -1; // Small/cowering posture
  }
  
  const modifiers = {
    frameRateMultiplier,
    fidgetFrequencyMultiplier,
    deterministic,
    emotionJoyAvailable,
    emotionDistressAvailable,
    emotionAlertAvailable,
    postureSizeModifier
  };
  
  logger.debug('Personality modifiers computed: %j', modifiers);
  return Object.freeze(modifiers);
};

/**
 * Calculates talk animation duration based on word count and personality
 * 
 * @param {number} wordCount - Number of words in utterance
 * @param {number} oceanExtraversion - Extraversion score (0-100)
 * @returns {number} Duration in milliseconds
 */
export const calculateTalkDuration = (wordCount, oceanExtraversion) => {
  const safeWords = Math.max(1, safeFloat(wordCount));
  const safeExtraversion = safeFloat(oceanExtraversion);
  
  // Base: 400ms per word (proposed — requires calibration)
  const baseMsPerWord = 400;
  
  // Fast talkers (high extraversion) finish quicker
  const speedModifier = safeExtraversion > OCEAN_THRESHOLDS.high ? 0.8 : 1.0;
  
  const duration = safeWords * baseMsPerWord * speedModifier;
  
  logger.debug('Talk duration: %d words, extraversion %d = %d ms',
    safeWords, safeExtraversion, duration);
    
  return duration;
};

logger.info('Personality engine initialized');
