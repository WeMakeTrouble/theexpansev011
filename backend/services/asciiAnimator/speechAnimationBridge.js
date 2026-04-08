import { createModuleLogger } from '../../utils/logger.js';
import { calculateTalkDuration } from './personalityEngine.js';

const logger = createModuleLogger('speechAnimationBridge');

/**
 * Creates a bridge between socket.io speech events and animation controllers
 * 
 * @param {Object} socket - Socket.io instance
 * @param {Map<string, Object>} stateControllerRegistry - Map of characterId -> stateController
 * @returns {Object} Bridge with connect/disconnect methods
 */
export const createSpeechAnimationBridge = (socket, stateControllerRegistry) => {
  let isConnected = false;
  
  /**
   * Handles speech:start event
   */
  const onSpeechStart = (data) => {
    const { characterId, utterance, wordCount, oceanExtraversion } = data ?? {};
    
    if (!characterId) {
      logger.error('speech:start received without characterId');
      return;
    }
    
    const controller = stateControllerRegistry.get(characterId);
    if (!controller) {
      logger.error('No state controller found for character %s', characterId);
      return;
    }
    
    // Calculate duration for talk_loop
    const duration = calculateTalkDuration(wordCount ?? 0, oceanExtraversion ?? 50);
    
    logger.info('Speech start for %s: %d words, ~%d ms', characterId, wordCount, duration);
    
    // Trigger animation transition
    controller.handleEvent('on_speech_start', { duration, utterance });
  };
  
  /**
   * Handles speech:end event
   */
  const onSpeechEnd = (data) => {
    const { characterId } = data ?? {};
    
    if (!characterId) {
      logger.error('speech:end received without characterId');
      return;
    }
    
    const controller = stateControllerRegistry.get(characterId);
    if (!controller) {
      logger.error('No state controller found for character %s', characterId);
      return;
    }
    
    logger.info('Speech end for %s', characterId);
    controller.handleEvent('on_speech_end');
  };
  
  /**
   * Connect event listeners
   */
  const connect = () => {
    if (isConnected) {
      logger.warn('Bridge already connected');
      return;
    }
    
    socket.on('speech:start', onSpeechStart);
    socket.on('speech:end', onSpeechEnd);
    
    isConnected = true;
    logger.info('Speech animation bridge connected');
  };
  
  /**
   * Disconnect event listeners
   */
  const disconnect = () => {
    if (!isConnected) return;
    
    socket.off('speech:start', onSpeechStart);
    socket.off('speech:end', onSpeechEnd);
    
    isConnected = false;
    logger.info('Speech animation bridge disconnected');
  };
  
  return Object.freeze({
    connect,
    disconnect,
    get isConnected() { return isConnected; }
  });
};

logger.info('Speech animation bridge factory initialized');
