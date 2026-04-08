/**
 * ============================================================================
 * CMS Socket Handler — Admin Terminal Socket Controller (v010)
 * File: public/cms/js/cmsSocketHandler.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Frontend transport layer between the CMS admin terminal and ClaudeBrain.
 * Sends admin commands via Socket.io, receives processed responses, and
 * renders them with typewriter effect in the Claude terminal panel.
 *
 * This is a simplified version of the user-facing terminalSocketHandler.js,
 * stripped of omiyage, TSE, dossier panel, and mobile tab logic. The admin
 * talks to Claude, Claude does the work.
 *
 * RESPONSIBILITIES:
 * ---------------------------------------------------------------------------
 *  - Auth guard: check /auth/check, require access_level >= 11
 *  - Connect to Socket.io /terminal namespace with credentials
 *  - Display connection status (connected/disconnected/reconnecting)
 *  - Send terminal-command events on user input (Enter key)
 *  - Receive and display command-response events
 *  - Typewriter effect for Claude responses (respects prefers-reduced-motion)
 *  - Queue messages during typewriter playback
 *  - Queue commands during disconnection (replay on reconnect)
 *  - AbortController cleanup on unload
 *
 * SOCKET EVENTS:
 * ---------------------------------------------------------------------------
 *  Outbound:
 *    terminal-command    { command: string }
 *
 *  Inbound:
 *    command-response    { output?: string, text?: string, type?: string,
 *                          isStatusReport?: boolean, error?: string,
 *                          welcomeBeat?: { narrative?: string, text?: string },
 *                          pad?: { p: number, a: number, d: number } }
 *
 * RESPONSE VALIDATION:
 * ---------------------------------------------------------------------------
 * All inbound command-response payloads are validated before processing.
 * Unexpected shapes are logged and discarded — never rendered to DOM.
 *
 * ACCESSIBILITY:
 * ---------------------------------------------------------------------------
 * - Chat output uses role="log" and aria-live="polite" (set in HTML)
 * - Typewriter effect is disabled when prefers-reduced-motion is active
 * - Messages rendered via textContent only (no innerHTML, XSS-safe)
 * - Connection status updates use role="status" (set in HTML)
 *
 * LIFECYCLE:
 * ---------------------------------------------------------------------------
 * - init() is called on DOMContentLoaded (not module top-level)
 * - destroy() aborts lifecycle controller, removes all socket listeners,
 *   disconnects socket, and nullifies DOM references
 * - AbortController signal guards async continuations after destroy
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 *  - Socket.io client (loaded via script tag from js/vendor/socket.io.min.js)
 *  - DOM elements: chat-output, command-input, connection-status
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *  public/cms/index.html — loaded via <script type="module">
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Created: February 24, 2026
 * ============================================================================
 */

const MODULE = '[CMSSocket]';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Structured Logger (frontend-grade, prefixed, level-filtered)             */
/* ────────────────────────────────────────────────────────────────────────── */

const LOG_LEVELS = Object.freeze({ ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 });
const ACTIVE_LOG_LEVEL = LOG_LEVELS.INFO;

const logger = Object.freeze({
  error(msg, data) {
    if (ACTIVE_LOG_LEVEL >= LOG_LEVELS.ERROR) console.error(MODULE, msg, data !== undefined ? data : '');
  },
  warn(msg, data) {
    if (ACTIVE_LOG_LEVEL >= LOG_LEVELS.WARN) console.warn(MODULE, msg, data !== undefined ? data : '');
  },
  info(msg, data) {
    if (ACTIVE_LOG_LEVEL >= LOG_LEVELS.INFO) console.info(MODULE, msg, data !== undefined ? data : '');
  },
  debug(msg, data) {
    if (ACTIVE_LOG_LEVEL >= LOG_LEVELS.DEBUG) console.debug(MODULE, msg, data !== undefined ? data : '');
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants (Frozen)                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const CONSTANTS = Object.freeze({
  AUTH_CHECK_URL: '/auth/check',
  LOGIN_REDIRECT: '/cms/cms-login.html',
  TERMINAL_NAMESPACE: '/terminal',
  RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY_MS: 2000,
  RECONNECT_DELAY_MAX_MS: 30000,
  COMMAND_MAX_LENGTH: 5000,
  PENDING_QUEUE_MAX: 10,
  MIN_ACCESS_LEVEL: 11,
  MAX_RENDER_LENGTH: 16000,
  AUTH_REDIRECT_DELAY_MS: 2000
});

const TYPEWRITER = Object.freeze({
  CHAR_DELAY_MS: 15,
  PUNCTUATION_DELAY_MS: 100,
  COMMA_DELAY_MS: 50,
  PUNCTUATION_CHARS: '.!?',
  COMMA_CHARS: ',;:',
  CHUNK_SIZE: 30,
  CHUNK_INTERVAL_MS: 16
});

const CSS = Object.freeze({
  MSG_USER: 'chat-message chat-message--user',
  MSG_CLAUDE: 'chat-message chat-message--claude',
  MSG_SYSTEM: 'chat-message chat-message--system',
  MSG_STATUS: 'chat-message chat-message--status',
  MSG_TYPING: 'chat-message--typing',
  CONN_CONNECTED: 'connection--connected',
  CONN_DISCONNECTED: 'connection--disconnected',
  CONN_RECONNECTING: 'connection--reconnecting'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Socket Event Names (centralised contract)                                */
/* ────────────────────────────────────────────────────────────────────────── */

const SOCKET_EVENTS = Object.freeze({
  OUTBOUND_COMMAND: 'terminal-command',
  INBOUND_RESPONSE: 'command-response',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  RECONNECT_ATTEMPT: 'reconnect_attempt',
  RECONNECT: 'reconnect',
  RECONNECT_FAILED: 'reconnect_failed',
  CONNECT_ERROR: 'connect_error',
  WWDD_UPDATE: 'wwdd_update'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Motion Preference Detection                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Response Validation                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Validate that an inbound response has an expected shape.
 * Rejects non-objects, null, arrays, and responses missing all known fields.
 *
 * @param {*} response - Raw payload from socket event
 * @returns {boolean} True if response is safe to process
 */
function isValidResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;

  const hasKnownField = (
    typeof response.output === 'string' ||
    typeof response.text === 'string' ||
    typeof response.error === 'string' ||
    typeof response.isStatusReport === 'boolean' ||
    response.welcomeBeat !== undefined
  );

  return hasKnownField;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Module State (Sealed — prevents accidental property injection)           */
/* ────────────────────────────────────────────────────────────────────────── */

const state = Object.seal({
  isInitialized: false,
  socket: null,
  isConnected: false,
  user: null,
  typewriterActive: false,
  typewriterQueue: [],
  pendingCommands: [],
  lifecycleController: new AbortController()
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  DOM References (cached on init, nullified on destroy)                    */
/* ────────────────────────────────────────────────────────────────────────── */

let chatOutputEl = null;
let commandInputEl = null;
let connectionStatusEl = null;

/**
 * Cache all required DOM references.
 * Verifies that the chat output element has correct ARIA attributes
 * for screen reader compatibility.
 *
 * @returns {boolean} True if all critical elements found
 */
function cacheDomRefs() {
  chatOutputEl = document.getElementById('chat-output');
  commandInputEl = document.getElementById('command-input');
  connectionStatusEl = document.getElementById('connection-status');

  if (!chatOutputEl || !commandInputEl || !connectionStatusEl) {
    logger.error('Critical DOM elements missing', {
      chatOutput: !!chatOutputEl,
      commandInput: !!commandInputEl,
      connectionStatus: !!connectionStatusEl
    });
    return false;
  }

  if (!chatOutputEl.getAttribute('role')) {
    chatOutputEl.setAttribute('role', 'log');
  }
  if (!chatOutputEl.getAttribute('aria-live')) {
    chatOutputEl.setAttribute('aria-live', 'polite');
  }
  if (!chatOutputEl.getAttribute('aria-atomic')) {
    chatOutputEl.setAttribute('aria-atomic', 'false');
  }
  if (!chatOutputEl.getAttribute('aria-relevant')) {
    chatOutputEl.setAttribute('aria-relevant', 'additions');
  }

  return true;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Auth Guard                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Check authentication status. Redirect to login if not authenticated
 * or if access level is below admin threshold.
 *
 * @returns {Promise<Object|null>} User object if authenticated admin, null if redirecting
 */
async function checkAuth() {
  try {
    const response = await fetch(CONSTANTS.AUTH_CHECK_URL, {
      credentials: 'include'
    });

    if (state.lifecycleController.signal.aborted) return null;

    if (!response.ok) {
      logger.warn('Auth check failed with status', { status: response.status });
      window.location.href = CONSTANTS.LOGIN_REDIRECT;
      return null;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      logger.error('Auth check response not valid JSON');
      window.location.href = CONSTANTS.LOGIN_REDIRECT;
      return null;
    }

    if (state.lifecycleController.signal.aborted) return null;

    if (!data.authenticated) {
      logger.info('Not authenticated, redirecting');
      window.location.href = CONSTANTS.LOGIN_REDIRECT;
      return null;
    }

    const accessLevel = data.user.access_level || 0;
    if (accessLevel < CONSTANTS.MIN_ACCESS_LEVEL) {
      logger.warn('Insufficient access level', { level: accessLevel, required: CONSTANTS.MIN_ACCESS_LEVEL });
      window.location.href = CONSTANTS.LOGIN_REDIRECT;
      return null;
    }

    logger.info('Authenticated as admin', { username: data.user.username, level: accessLevel });
    return data.user;

  } catch (err) {
    if (state.lifecycleController.signal.aborted) return null;
    logger.error('Auth check network error', { error: err.message });
    window.location.href = CONSTANTS.LOGIN_REDIRECT;
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Chat Display (XSS-Safe — textContent only, no innerHTML ever)            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Append a chat message to the output panel.
 *
 * @param {string} text - Message text (rendered via textContent, XSS-safe)
 * @param {string} cssClass - CSS class string for the message wrapper
 * @returns {HTMLDivElement|null} The created message element
 */
function appendMessage(text, cssClass) {
  if (!chatOutputEl) return null;

  const msgEl = document.createElement('div');
  msgEl.className = cssClass;

  const bubbleEl = document.createElement('div');
  bubbleEl.classList.add('chat-bubble');
  bubbleEl.textContent = text;
  msgEl.appendChild(bubbleEl);

  chatOutputEl.appendChild(msgEl);
  chatOutputEl.scrollTop = chatOutputEl.scrollHeight;

  return msgEl;
}

function displayUserMessage(command) {
  appendMessage(command, CSS.MSG_USER);
}

function displaySystemMessage(text) {
  appendMessage(text, CSS.MSG_SYSTEM);
}

function displayStatusMessage(text) {
  appendMessage(text, CSS.MSG_STATUS);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Typewriter Engine (respects prefers-reduced-motion)                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Enqueue text for typewriter rendering. If prefers-reduced-motion is
 * active, the text is rendered instantly instead.
 *
 * @param {string} text - Text to render
 * @param {string} [cssClass] - CSS class for the message
 * @returns {Promise<void>}
 */
function enqueueTypewriter(text, cssClass) {
  if (!text) return Promise.resolve();

  if (text.length > CONSTANTS.MAX_RENDER_LENGTH) {
    text = text.slice(0, CONSTANTS.MAX_RENDER_LENGTH) + '\n\n[Output truncated]';
  }

  if (prefersReducedMotion()) {
    appendMessage(text, cssClass || CSS.MSG_CLAUDE);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    state.typewriterQueue.push({ text, cssClass: cssClass || CSS.MSG_CLAUDE, resolve });
    processTypewriterQueue();
  });
}

/**
 * Process the typewriter queue sequentially.
 * Only one typewriter animation runs at a time.
 */
async function processTypewriterQueue() {
  if (state.typewriterActive) return;
  if (state.typewriterQueue.length === 0) return;

  state.typewriterActive = true;

  while (state.typewriterQueue.length > 0) {
    const { text, cssClass, resolve } = state.typewriterQueue.shift();
    await runTypewriter(text, cssClass);
    resolve();
  }

  state.typewriterActive = false;
}

/**
 * Execute typewriter effect for a single message.
 * Uses requestAnimationFrame for smooth rendering and chunks characters
 * to reduce DOM write frequency on long messages.
 *
 * @param {string} text - Full text to type out
 * @param {string} cssClass - CSS class for the message element
 * @returns {Promise<void>}
 */
function runTypewriter(text, cssClass) {
  return new Promise((resolve) => {
    if (!chatOutputEl) {
      resolve();
      return;
    }

    const msgEl = document.createElement('div');
    msgEl.className = cssClass + ' ' + CSS.MSG_TYPING;

    const bubbleEl = document.createElement('div');
    bubbleEl.classList.add('chat-bubble');
    msgEl.appendChild(bubbleEl);
    chatOutputEl.appendChild(msgEl);

    let index = 0;
    const chars = Array.from(text);

    function typeNext() {
      if (index >= chars.length) {
        msgEl.classList.remove(CSS.MSG_TYPING);
        chatOutputEl.scrollTop = chatOutputEl.scrollHeight;
        resolve();
        return;
      }

      const char = chars[index];
      bubbleEl.textContent += char;
      index++;

      chatOutputEl.scrollTop = chatOutputEl.scrollHeight;

      let delay = TYPEWRITER.CHAR_DELAY_MS;
      if (TYPEWRITER.PUNCTUATION_CHARS.includes(char)) {
        delay = TYPEWRITER.PUNCTUATION_DELAY_MS;
      } else if (TYPEWRITER.COMMA_CHARS.includes(char)) {
        delay = TYPEWRITER.COMMA_DELAY_MS;
      }

      setTimeout(typeNext, delay);
    }

    requestAnimationFrame(typeNext);
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Connection Status                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Update connection status indicator and toggle command input state.
 * Disables input when disconnected, re-enables on connect.
 *
 * @param {'connected'|'disconnected'|'reconnecting'} status - Connection state
 */
function setConnectionStatus(status) {
  if (!connectionStatusEl) return;

  connectionStatusEl.classList.remove(
    CSS.CONN_CONNECTED,
    CSS.CONN_DISCONNECTED,
    CSS.CONN_RECONNECTING
  );

  switch (status) {
    case 'connected':
      connectionStatusEl.textContent = 'Connected';
      connectionStatusEl.classList.add(CSS.CONN_CONNECTED);
      if (commandInputEl) {
        commandInputEl.disabled = false;
        commandInputEl.placeholder = 'Type a command...';
      }
      break;
    case 'disconnected':
      connectionStatusEl.textContent = 'Disconnected';
      connectionStatusEl.classList.add(CSS.CONN_DISCONNECTED);
      if (commandInputEl) {
        commandInputEl.disabled = true;
        commandInputEl.placeholder = 'Disconnected — waiting for connection...';
      }
      break;
    case 'reconnecting':
      connectionStatusEl.textContent = 'Reconnecting...';
      connectionStatusEl.classList.add(CSS.CONN_RECONNECTING);
      if (commandInputEl) {
        commandInputEl.disabled = true;
        commandInputEl.placeholder = 'Reconnecting...';
      }
      break;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Command Sending                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Send a command to the server via socket.
 * Queues the command if currently disconnected.
 *
 * @param {string} command - User command text
 */
function sendCommand(command) {
  if (!command || typeof command !== 'string') return;
  if (command.length > CONSTANTS.COMMAND_MAX_LENGTH) {
    displaySystemMessage('Command too long. Maximum ' + CONSTANTS.COMMAND_MAX_LENGTH + ' characters.');
    return;
  }

  if (!state.isConnected || !state.socket) {
    if (state.pendingCommands.length < CONSTANTS.PENDING_QUEUE_MAX) {
      state.pendingCommands.push(command);
      displaySystemMessage('Queued — waiting for connection...');
    } else {
      displaySystemMessage('Message queue full. Please wait for connection.');
    }
    return;
  }

  displayUserMessage(command);
  state.socket.emit(SOCKET_EVENTS.OUTBOUND_COMMAND, { command });
}

/**
 * Replay any commands that were queued during disconnection.
 */
function replayPendingCommands() {
  if (state.pendingCommands.length === 0) return;

  logger.info('Replaying queued commands', { count: state.pendingCommands.length });
  const commands = [...state.pendingCommands];
  state.pendingCommands = [];

  for (const cmd of commands) {
    sendCommand(cmd);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Response Handling                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Route an incoming command-response to the appropriate display handler.
 * Validates response shape before processing.
 *
 * @param {*} response - Raw server response object
 */
function handleCommandResponse(response) {
  if (!isValidResponse(response)) {
    logger.warn('Invalid response shape received, discarding', { type: typeof response });
    return;
  }

  if (response.error) {
    if (response.error === 'NOT_AUTHENTICATED') {
      displaySystemMessage('Session expired. Please log in again.');
      setTimeout(() => { window.location.href = CONSTANTS.LOGIN_REDIRECT; }, CONSTANTS.AUTH_REDIRECT_DELAY_MS);
    } else {
      displaySystemMessage('Something went wrong. Please try again.');
    }
    return;
  }

  if (response.isStatusReport) {
    enqueueTypewriter(response.output || 'Welcome back, Admin.', CSS.MSG_CLAUDE);
    return;
  }

  if (response.welcomeBeat) {
    const beatText = response.welcomeBeat.narrative || response.welcomeBeat.text || response.text || 'Admin terminal ready.';
    enqueueTypewriter(beatText, CSS.MSG_CLAUDE);
    return;
  }

  const text = response.output || response.text || '';
  if (text) {
    enqueueTypewriter(text, CSS.MSG_CLAUDE);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Socket Connection                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Establish Socket.io connection to /terminal namespace.
 * Registers all event listeners using centralised SOCKET_EVENTS constants.
 *
 * @returns {Object|null} Socket.io socket instance, or null on failure
 */

/**
 * Handle inbound wwdd_update event from the terminal socket.
 * Dispatches a CustomEvent on document so wwddGunsightView can
 * listen without coupling directly to this socket instance.
 *
 * @param {Object} data - WWDD state payload from WwddEngine
 */
function handleWwddUpdate(data) {
  if (!data || typeof data !== 'object') return;
  document.dispatchEvent(new CustomEvent('wwdd:update', { detail: data }));
}
function connectSocket() {
  if (typeof io === 'undefined') {
    logger.error('Socket.io client not loaded');
    displaySystemMessage('Connection library not loaded. Please refresh.');
    return null;
  }

  const socket = io(CONSTANTS.TERMINAL_NAMESPACE, {
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: CONSTANTS.RECONNECT_ATTEMPTS,
    reconnectionDelay: CONSTANTS.RECONNECT_DELAY_MS,
    reconnectionDelayMax: CONSTANTS.RECONNECT_DELAY_MAX_MS,
    transports: ['websocket', 'polling']
  });

  socket.on(SOCKET_EVENTS.CONNECT, () => {
    state.isConnected = true;
    setConnectionStatus('connected');
    logger.info('Connected to /terminal');
    displayStatusMessage('Connected to The Expanse — Admin Terminal');
    replayPendingCommands();
  });

  socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {
    state.isConnected = false;
    setConnectionStatus('disconnected');
    logger.warn('Disconnected', { reason });
    displayStatusMessage('Disconnected — ' + reason);
  });

  socket.on(SOCKET_EVENTS.RECONNECT_ATTEMPT, (attemptNumber) => {
    setConnectionStatus('reconnecting');
    logger.info('Reconnect attempt', { attempt: attemptNumber });
  });

  socket.on(SOCKET_EVENTS.RECONNECT, () => {
    state.isConnected = true;
    setConnectionStatus('connected');
    logger.info('Reconnected');
    displayStatusMessage('Reconnected to The Expanse');
    replayPendingCommands();
  });

  socket.on(SOCKET_EVENTS.RECONNECT_FAILED, () => {
    setConnectionStatus('disconnected');
    logger.error('Reconnection failed', { maxAttempts: CONSTANTS.RECONNECT_ATTEMPTS });
    displaySystemMessage('Connection lost. Please refresh the page.');
  });

  socket.on(SOCKET_EVENTS.CONNECT_ERROR, (err) => {
    logger.error('Connection error', { error: err.message });
    if (err.message === 'Unauthorized') {
      displaySystemMessage('Session expired. Redirecting to login...');
      setTimeout(() => { window.location.href = CONSTANTS.LOGIN_REDIRECT; }, CONSTANTS.AUTH_REDIRECT_DELAY_MS);
    }
  });

  socket.on(SOCKET_EVENTS.INBOUND_RESPONSE, handleCommandResponse);
  socket.on(SOCKET_EVENTS.WWDD_UPDATE, handleWwddUpdate);
  return socket;
}

/**
 * Remove all registered listeners from socket and disconnect.
 * Prevents event listener leaks on destroy or reconnect.
 *
 * @param {Object} socket - Socket.io socket instance
 */
function cleanupSocket(socket) {
  if (!socket) return;

  socket.off(SOCKET_EVENTS.CONNECT);
  socket.off(SOCKET_EVENTS.DISCONNECT);
  socket.off(SOCKET_EVENTS.RECONNECT_ATTEMPT);
  socket.off(SOCKET_EVENTS.RECONNECT);
  socket.off(SOCKET_EVENTS.RECONNECT_FAILED);
  socket.off(SOCKET_EVENTS.CONNECT_ERROR);
  socket.off(SOCKET_EVENTS.INBOUND_RESPONSE);
  socket.off(SOCKET_EVENTS.WWDD_UPDATE);
  socket.disconnect();
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Handling                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Handle Enter key press on command input.
 *
 * @param {KeyboardEvent} event - Keyboard event
 */
function handleInputKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();

  if (!commandInputEl) return;

  const command = commandInputEl.value.trim();
  if (!command) return;

  commandInputEl.value = '';
  sendCommand(command);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Lifecycle                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Initialize the CMS socket handler. Idempotent.
 * Checks admin auth, caches DOM, connects socket, binds input.
 *
 * @returns {Promise<boolean>} True if initialization succeeded
 */
async function init() {
  if (state.isInitialized) {
    logger.warn('Already initialized');
    return true;
  }

  if (!cacheDomRefs()) {
    return false;
  }

  const user = await checkAuth();

  if (state.lifecycleController.signal.aborted) return false;

  if (!user) return false;

  state.user = user;

  state.socket = connectSocket();
  if (!state.socket) return false;

  commandInputEl.addEventListener('keydown', handleInputKeydown, {
    signal: state.lifecycleController.signal
  });

  state.isInitialized = true;
  logger.info('Initialized for admin', { username: user.username });
  return true;
}

/**
 * Destroy the CMS socket handler. Cleans up all resources.
 * Explicitly removes socket event listeners before disconnecting
 * to prevent memory leaks.
 */
function destroy() {
  state.lifecycleController.abort();

  if (state.socket) {
    cleanupSocket(state.socket);
    state.socket = null;
  }

  state.isConnected = false;
  state.isInitialized = false;
  state.typewriterQueue = [];
  state.pendingCommands = [];

  chatOutputEl = null;
  commandInputEl = null;
  connectionStatusEl = null;

  logger.info('Destroyed');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Boot (DOMContentLoaded-guarded for testability)                          */
/* ────────────────────────────────────────────────────────────────────────── */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

window.addEventListener('unload', destroy, { once: true });

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports (for testability and external access)                            */
/* ────────────────────────────────────────────────────────────────────────── */

export { init, destroy, sendCommand };
export default { init, destroy };
