import { createModuleLogger } from '../../utils/logger.js';
import { mulberry32 } from '../imageProcessor/prng.js';
import { computeAnimationModifiers, calculateTalkDuration } from './personalityEngine.js';

const logger = createModuleLogger('stateController');

/**
 * Priority hierarchy for conflict resolution
 * Higher number = higher priority (interrupts lower)
 */
const PRIORITIES = Object.freeze({
  speech: 100,
  emotion: 70,
  surprise: 70,
  alert: 60,
  joy: 50,
  distress: 50,
  idleFidget: 10,
  idleBlink: 10,
  sleep: 5,
  auto: 0
});

/**
 * Creates an animation state controller for a single character
 * 
 * @param {string} characterId - Hex character ID
 * @param {Object} sequences - Map of sequenceName -> SequenceData from spriteManager
 * @param {Object} personality - { oceanScores, padCoordinates }
 * @returns {Object} State controller with methods
 */
export const createStateController = (characterId, sequences, personality) => {
  let currentState = 'idle_breathe';
  let previousState = null;
  let stateStartTime = Date.now();
  let currentFrameIndex = 0;
  let lastFrameTime = 0;
  let timers = [];
  let isDisposed = false;
  
  // Initialize PRNG for deterministic variation
  const prng = mulberry32(parseInt(characterId.slice(1), 16) + Date.now());
  
  // Compute personality modifiers
  const modifiers = computeAnimationModifiers(
    personality?.oceanScores ?? {},
    personality?.padCoordinates ?? {}
  );
  
  // Get available transitions for current state
  const getAvailableTransitions = () => {
    const stateSeq = sequences.get(currentState);
    if (!stateSeq) return [];
    
    // TODO: Load from animation_transitions table
    // For now, hardcoded based on blueprint state diagram
    const transitions = [];
    
    // Always available: speech interrupt
    transitions.push({
      trigger: 'on_speech_start',
      target: 'talk_start',
      priority: PRIORITIES.speech,
      interrupt: true
    });
    
    // Auto-return from non-looping sequences
    if (!stateSeq.loop && stateSeq.totalFrames > 0) {
      const seqDuration = stateSeq.totalFrames * (1000 / (stateSeq.frameRate * modifiers.frameRateMultiplier));
      const elapsed = Date.now() - stateStartTime;
      
      if (elapsed >= seqDuration) {
        transitions.push({
          trigger: 'on_sequence_complete',
          target: currentState.startsWith('idle_') ? currentState : 'idle_breathe',
          priority: PRIORITIES.auto,
          interrupt: false
        });
      }
    }
    
    // Emotion availability based on PAD
    if (modifiers.emotionJoyAvailable) {
      transitions.push({
        trigger: 'on_emotion_joy',
        target: 'emotion_joy',
        priority: PRIORITIES.joy,
        interrupt: false
      });
    }
    
    if (modifiers.emotionDistressAvailable) {
      transitions.push({
        trigger: 'on_emotion_distress',
        target: 'emotion_distress',
        priority: PRIORITIES.distress,
        interrupt: false
      });
    }
    
    if (modifiers.emotionAlertAvailable) {
      transitions.push({
        trigger: 'on_emotion_alert',
        target: 'emotion_alert',
        priority: PRIORITIES.alert,
        interrupt: false
      });
    }
    
    return transitions;
  };
  
  /**
   * Evaluates and executes highest priority transition
   * 
   * @param {string} eventType - Trigger event
   * @param {Object} eventData - Additional event data
   * @returns {boolean} Whether transition occurred
   */
  const handleEvent = (eventType, eventData = {}) => {
    if (isDisposed) {
      logger.warn('Event %s received on disposed controller for %s', eventType, characterId);
      return false;
    }
    
    const transitions = getAvailableTransitions().filter(t => t.trigger === eventType);
    
    if (transitions.length === 0) {
      logger.debug('No transition for %s in state %s', eventType, currentState);
      return false;
    }
    
    // Sort by priority descending
    transitions.sort((a, b) => b.priority - a.priority);
    const selected = transitions[0];
    
    // Execute transition
    previousState = currentState;
    currentState = selected.target;
    stateStartTime = Date.now();
    currentFrameIndex = 0;
    
    logger.info('State transition: %s -> %s (trigger: %s, priority: %d)',
      previousState, currentState, eventType, selected.priority);
    
    return true;
  };
  
  /**
   * Gets current frame data for rendering
   * 
   * @param {number} currentTime - Current timestamp (ms)
   * @returns {Object|null} Frame data or null if disposed
   */
  const getCurrentFrame = (currentTime) => {
    if (isDisposed) return null;
    
    const sequence = sequences.get(currentState);
    if (!sequence || sequence.frames.length === 0) {
      return null;
    }
    
    // Calculate frame based on timing
    const effectiveFrameRate = sequence.frameRate * modifiers.frameRateMultiplier;
    const frameDuration = 1000 / effectiveFrameRate;
    const elapsed = currentTime - stateStartTime;
    
    let frameIdx;
    if (sequence.loop) {
      frameIdx = Math.floor(elapsed / frameDuration) % sequence.totalFrames;
    } else {
      frameIdx = Math.min(Math.floor(elapsed / frameDuration), sequence.totalFrames - 1);
    }
    
    // Check for per-frame duration override
    const frame = sequence.frames[frameIdx] ?? sequence.frames[0];
    const effectiveDuration = frame.durationMs ?? frameDuration;
    
    return {
      frame: frame.data,
      frameIndex: frameIdx,
      isLastFrame: !sequence.loop && frameIdx >= sequence.totalFrames - 1,
      state: currentState,
      nextState: (!sequence.loop && frameIdx >= sequence.totalFrames - 1) ? 'idle_breathe' : null
    };
  };
  
  /**
   * Gets current state info
   */
  const getCurrentState = () => ({
    state: currentState,
    previousState,
    startTime: stateStartTime,
    modifiers
  });
  
  /**
   * Cleanup resources
   */
  const dispose = () => {
    isDisposed = true;
    timers.forEach(t => clearTimeout(t));
    timers = [];
    logger.info('State controller disposed for %s', characterId);
  };
  
  /**
   * Process tick for timing-based events (idle timers)
   */
  const tick = (deltaMs) => {
    if (isDisposed) return;
    
    // Handle idle timer events
    if (currentState === 'idle_breathe') {
      // Blink timer: random interval based on personality
      if (prng() < (0.001 * modifiers.fidgetFrequencyMultiplier)) { // proposed — requires calibration
        handleEvent('on_blink_timer');
      }
      
      // Fidget timer
      if (prng() < (0.0005 * modifiers.fidgetFrequencyMultiplier)) { // proposed — requires calibration
        handleEvent('on_fidget_timer');
      }
    }
  };
  
  return Object.freeze({
    characterId,
    getCurrentState,
    handleEvent,
    getCurrentFrame,
    tick,
    dispose
  });
};

logger.info('State controller factory initialized');
