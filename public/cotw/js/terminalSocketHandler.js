/**
 * ============================================================================
 * terminalSocketHandler.js — COTW Terminal Socket Controller (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Frontend transport layer between the user terminal and ClaudeBrain.
 * Sends user commands via Socket.io, receives processed responses,
 * and renders them with typewriter effect. All intelligence lives
 * server-side (EarWig + 7-phase pipeline). This file is display only.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Auth guard: check /auth/check on load, redirect if unauthenticated
 *  - Connect to Socket.io /terminal namespace with credentials
 *  - Display connection status (connected/disconnected/reconnecting)
 *  - Send terminal-command events on user input
 *  - Receive and route command-response events
 *  - Render Claude responses with typewriter engine
 *  - Handle omiyage (gift) offer/accept/decline flow
 *  - Handle TSE (teaching) task/pause/resume events
 *  - Queue messages during typewriter playback
 *  - Queue commands during disconnection (replay on reconnect)
 *  - Update dossier panel (username, access, belt, turn, status)
 *  - Mobile tab switching between panels
 *  - AbortController cleanup on unload
 *
 * NON-GOALS
 * ---------
 *  - No input interpretation (EarWig does this server-side)
 *  - No emotional analysis (pipeline phases do this server-side)
 *  - No business logic (purely transport + display)
 *  - No innerHTML (all text via textContent for XSS safety)
 *
 * SOCKET EVENTS
 * -------------
 *  Outbound:
 *    terminal-command    { command }         User sends command
 *    omiyage:accept      { choiceId, chosenNumber }
 *    omiyage:decline     { choiceId }
 *    tse:respond          { sessionId, response }
 *    tse:pause            { sessionId }
 *    tse:resume           { sessionId }
 *    user:logout          {}
 *
 *  Inbound:
 *    command-response    { output|text, type?, isStatusReport?, ... }
 *    omiyage:offer       { choiceId, offerCount, narrative, giverName }
 *    omiyage:fulfilled   { choiceId, object, narrative }
 *    omiyage:declined    { choiceId, narrative }
 *    tse:task            { sessionId, task, evaluation, status }
 *    tse:paused          { sessionId, status }
 *    tse:resumed         { sessionId, completedTasks, status }
 *    tse:error           { error }
 *
 * TYPEWRITER ENGINE
 * -----------------
 *  Base character delay:   15ms
 *  Punctuation (. ! ?):    100ms
 *  Comma delay:            50ms
 *  HTML tags:              Instant (not character-by-character)
 *  Concurrent messages:    Queued, played sequentially
 *
 * FRONTEND LOGGING
 * ----------------
 *  console.info/warn/error with [TerminalSocket] prefix
 *  No console.log (v010 frontend standard)
 *
 * DEPENDENCIES
 * ------------
 *  - Socket.io client (loaded via CDN in cotw-dossier.html)
 *  - /cms/css/cms-styles.css (terminal aesthetic)
 *  - css/cotw-styles.css (chat message classes, connection indicators)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Date: February 13, 2026
 * ============================================================================
 */

const MODULE = '[TerminalSocket]';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants (Frozen)                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const CONSTANTS = Object.freeze({
  AUTH_CHECK_URL: '/auth/check',
  LOGIN_REDIRECT: '/cotw/cotw-login.html',
  TERMINAL_NAMESPACE: '/terminal',
  RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY_MS: 2000,
  RECONNECT_DELAY_MAX_MS: 30000,
  COMMAND_MAX_LENGTH: 5000,
  PENDING_QUEUE_MAX: 10
});

const TYPEWRITER = Object.freeze({
  CHAR_DELAY_MS: 15,
  PUNCTUATION_DELAY_MS: 100,
  COMMA_DELAY_MS: 50,
  PUNCTUATION_CHARS: '.!?',
  COMMA_CHARS: ',;:'
});

const CSS = Object.freeze({
  MSG_USER: 'chat-message chat-message--user',
  MSG_CLAUDE: 'chat-message chat-message--claude',
  MSG_SYSTEM: 'chat-message chat-message--system',
  MSG_STATUS: 'chat-message chat-message--status',
  MSG_TYPING: 'chat-message--typing',
  CONN_CONNECTED: 'connection--connected',
  CONN_DISCONNECTED: 'connection--disconnected',
  CONN_RECONNECTING: 'connection--reconnecting',
  TAB_ACTIVE: 'cotw-tabs__tab--active',
  PANEL_VISIBLE: 'panel--visible',
  PANEL_HIDDEN: 'panel--hidden'
});

const PANEL_MAP = Object.freeze({
  terminal: 'panel-terminal',
  dossier: 'panel-dossier',
  tools: 'panel-tools'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Module State (Sealed)                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const state = Object.seal({
  isInitialized: false,
  socket: null,
  isConnected: false,
  turnCount: 0,
  user: null,
  typewriterActive: false,
  typewriterQueue: [],
  pendingCommands: [],
  activePanel: 'terminal',
  lifecycleController: new AbortController()
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  DOM References (cached on init)                                          */
/* ────────────────────────────────────────────────────────────────────────── */

let chatOutputEl = null;
let commandInputEl = null;
let connectionStatusEl = null;
let dossierUsernameEl = null;
let dossierAccessEl = null;
let dossierBeltEl = null;
let dossierTurnEl = null;
let dossierStatusEl = null;
let dossierPadPEl = null;
let dossierPadAEl = null;
let dossierPadDEl = null;
let userBeltEl = null;
let toastContainerEl = null;

/**
 * Cache all required DOM references.
 *
 * @returns {boolean} True if all critical elements found
 */
function cacheDomRefs() {
  chatOutputEl = document.getElementById('chat-output');
  commandInputEl = document.getElementById('command-input');
  connectionStatusEl = document.getElementById('connection-status');
  dossierUsernameEl = document.getElementById('dossier-username');
  dossierAccessEl = document.getElementById('dossier-access');
  dossierBeltEl = document.getElementById('dossier-belt');
  dossierTurnEl = document.getElementById('dossier-turn');
  dossierStatusEl = document.getElementById('dossier-status');
  dossierPadPEl = document.getElementById('dossier-pad-p');
  dossierPadAEl = document.getElementById('dossier-pad-a');
  dossierPadDEl = document.getElementById('dossier-pad-d');
  userBeltEl = document.getElementById('user-belt');
  toastContainerEl = document.getElementById('toast-container');

  if (!chatOutputEl || !commandInputEl || !connectionStatusEl) {
    console.error(MODULE, 'Critical DOM elements missing');
    return false;
  }
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Auth Guard                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Check authentication status. Redirect to login if not authenticated.
 *
 * @returns {Promise<Object|null>} User object if authenticated, null if redirecting
 */
async function checkAuth() {
  try {
    const response = await fetch(CONSTANTS.AUTH_CHECK_URL, {
      credentials: 'include'
    });

    if (!response.ok) {
      console.warn(MODULE, 'Auth check failed with status', response.status);
      window.location.href = CONSTANTS.LOGIN_REDIRECT;
      return null;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.error(MODULE, 'Auth check response not valid JSON');
      window.location.href = CONSTANTS.LOGIN_REDIRECT;
      return null;
    }

    if (!data.authenticated) {
      console.info(MODULE, 'Not authenticated, redirecting to login');
      window.location.href = CONSTANTS.LOGIN_REDIRECT;
      return null;
    }

    console.info(MODULE, 'Authenticated as', data.user.username);
    return data.user;

  } catch (err) {
    console.error(MODULE, 'Auth check network error', err.message);
    window.location.href = CONSTANTS.LOGIN_REDIRECT;
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Chat Display (XSS-Safe)                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Append a chat message to the output panel.
 *
 * @param {string} text - Message text
 * @param {string} cssClass - CSS class string for the message
 * @returns {HTMLDivElement} The created message element
 */
function appendMessage(text, cssClass) {
  if (!chatOutputEl) return null;

  const msgEl = document.createElement('div');
  msgEl.className = cssClass;

  const spanEl = document.createElement('span');
  spanEl.textContent = text;
  msgEl.appendChild(spanEl);

  chatOutputEl.appendChild(msgEl);
  chatOutputEl.scrollTop = chatOutputEl.scrollHeight;

  return msgEl;
}

/**
 * Append a user command to chat display.
 *
 * @param {string} command - The user's input text
 */
function displayUserMessage(command) {
  appendMessage(command, CSS.MSG_USER);
}

/**
 * Append a system message to chat display.
 *
 * @param {string} text - System message text
 */
function displaySystemMessage(text) {
  appendMessage(text, CSS.MSG_SYSTEM);
}

/**
 * Append a status message to chat display.
 *
 * @param {string} text - Status message text
 */
function displayStatusMessage(text) {
  appendMessage(text, CSS.MSG_STATUS);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Typewriter Engine                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Render text with typewriter effect. Queues if another is active.
 *
 * @param {string} text - Text to render character by character
 * @param {string} [cssClass] - CSS class for the message
 * @returns {Promise<void>}
 */
function enqueueTypewriter(text, cssClass) {
  return new Promise((resolve) => {
    state.typewriterQueue.push({ text, cssClass: cssClass || CSS.MSG_CLAUDE, resolve });
    processTypewriterQueue();
  });
}

/**
 * Process the typewriter queue sequentially.
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

    const spanEl = document.createElement('span');
    msgEl.appendChild(spanEl);
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
      spanEl.textContent += char;
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

    typeNext();
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Connection Status                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Update connection status indicator.
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
      break;
    case 'disconnected':
      connectionStatusEl.textContent = 'Disconnected';
      connectionStatusEl.classList.add(CSS.CONN_DISCONNECTED);
      break;
    case 'reconnecting':
      connectionStatusEl.textContent = 'Reconnecting...';
      connectionStatusEl.classList.add(CSS.CONN_RECONNECTING);
      break;
  }

  if (dossierStatusEl) {
    dossierStatusEl.textContent = connectionStatusEl.textContent;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Dossier Updates                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Populate dossier panel with user data.
 *
 * @param {Object} user - User object from auth check
 */
function updateDossierUser(user) {
  if (!user) return;
  if (dossierUsernameEl) dossierUsernameEl.textContent = user.username || '—';
  if (dossierAccessEl) dossierAccessEl.textContent = user.access_level || '—';
}

/**
 * Update dossier turn count.
 */
function updateDossierTurn() {
  if (dossierTurnEl) dossierTurnEl.textContent = String(state.turnCount);
}

/**
 * Update dossier PAD values from response data.
 *
 * @param {Object} [pad] - PAD coordinates { p, a, d }
 */
function updateDossierPad(pad) {
  if (!pad) return;
  if (dossierPadPEl && pad.p !== undefined) dossierPadPEl.textContent = Number(pad.p).toFixed(2);
  if (dossierPadAEl && pad.a !== undefined) dossierPadAEl.textContent = Number(pad.a).toFixed(2);
  if (dossierPadDEl && pad.d !== undefined) dossierPadDEl.textContent = Number(pad.d).toFixed(2);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Command Sending                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Send a command to the server via socket.
 *
 * @param {string} command - User command text
 */
function sendCommand(command) {
  if (!command || command.length > CONSTANTS.COMMAND_MAX_LENGTH) return;

  if (!state.isConnected || !state.socket) {
    if (state.pendingCommands.length < CONSTANTS.PENDING_QUEUE_MAX) {
      state.pendingCommands.push(command);
      displaySystemMessage('Queued — waiting for connection...');
      console.warn(MODULE, 'Command queued, not connected');
    } else {
      displaySystemMessage('Message queue full. Please wait for connection.');
    }
    return;
  }

  state.turnCount++;
  updateDossierTurn();
  displayUserMessage(command);

  state.socket.emit('terminal-command', { command });
}

/**
 * Replay any commands that were queued during disconnection.
 */
function replayPendingCommands() {
  if (state.pendingCommands.length === 0) return;

  console.info(MODULE, 'Replaying', state.pendingCommands.length, 'queued commands');
  const commands = [...state.pendingCommands];
  state.pendingCommands = [];

  for (const command of commands) {
    sendCommand(command);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Response Handling                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Route an incoming command-response to the appropriate handler.
 *
 * @param {Object} response - Server response object
 */
function handleCommandResponse(response) {
  if (!response) return;
  console.log("DIAG FRONTEND:", JSON.stringify(response.diagnosticReport, null, 2));

  if (response.error) {
    displaySystemMessage('Error: ' + (response.error === 'NOT_AUTHENTICATED' ? 'Session expired. Please log in again.' : 'Something went wrong.'));
    if (response.error === 'NOT_AUTHENTICATED') {
      setTimeout(() => { window.location.href = CONSTANTS.LOGIN_REDIRECT; }, 2000);
    }
    return;
  }

  if (response.isStatusReport) {
    enqueueTypewriter(response.output || 'Welcome back.', CSS.MSG_CLAUDE);
    return;
  }

  if (response.welcomeBeat) {
    const beatText = response.welcomeBeat.narrative || response.welcomeBeat.text || response.text || 'Welcome to COTW.';
    enqueueTypewriter(beatText, CSS.MSG_CLAUDE);
    return;
  }

  const text = response.output || response.text || '';
  if (text) {
    enqueueTypewriter(text, CSS.MSG_CLAUDE);
  }

  if (response.image) {
    const topPanel = document.getElementById('panel-top');
    const topDisplay = document.getElementById('top-bar-display');
    if (topPanel && topDisplay) {
      topPanel.hidden = false;
      const img = document.createElement('img');
      img.src = response.image;
      img.alt = 'Character image';
      img.style.cssText = 'max-width:100%; max-height:300px; border:1px solid #00ff75; image-rendering:pixelated;';
      topDisplay.replaceChildren(img);
    }
  }

  if (response.pad) {
    updateDossierPad(response.pad);
  }

  if (response.diagnosticReport && response.diagnosticReport.compositeEmotionalState) {
    updateDossierPad(response.diagnosticReport.compositeEmotionalState);
  }
}

/**
 * Handle omiyage offer from server.
 *
 * @param {Object} data - Omiyage offer data
 */
function handleOmiyageOffer(data) {
  if (!data) return;
  const narrative = data.narrative || 'Claude offers you a gift...';
  enqueueTypewriter(narrative, CSS.MSG_CLAUDE);
  displaySystemMessage('Type "accept" or "decline" to respond to the gift.');
}

/**
 * Handle omiyage fulfilment from server.
 *
 * @param {Object} data - Omiyage fulfilled data
 */
function handleOmiyageFulfilled(data) {
  if (!data) return;
  const narrative = data.narrative || 'Gift received!';
  enqueueTypewriter(narrative, CSS.MSG_CLAUDE);
}

/**
 * Handle omiyage decline response from server.
 *
 * @param {Object} data - Omiyage declined data
 */
function handleOmiyageDeclined(data) {
  if (!data) return;
  const narrative = data.narrative || 'Perhaps another time...';
  enqueueTypewriter(narrative, CSS.MSG_CLAUDE);
}

/**
 * Handle TSE task delivery from server.
 *
 * @param {Object} data - TSE task data
 */
function handleTseTask(data) {
  if (!data) return;
  if (data.teachingContent) {
    enqueueTypewriter(data.teachingContent, CSS.MSG_CLAUDE);
  } else if (data.task && (data.task.question || data.task.input)) {
    enqueueTypewriter(data.task.question || data.task.input, CSS.MSG_CLAUDE);
  }
  if (data.status === 'complete') {
    displaySystemMessage('Teaching session complete.');
  }
}

/**
 * Handle TSE error from server.
 *
 * @param {Object} data - TSE error data
 */
function handleTseError(data) {
  if (!data) return;
  displaySystemMessage('Teaching error: ' + (data.error || 'Unknown'));
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

  const command = commandInputEl.value.trim();
  if (!command) return;

  commandInputEl.value = '';
  sendCommand(command);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Mobile Tab Switching                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Handle mobile tab click to switch visible panel.
 *
 * @param {Event} event - Click event on tab bar
 */
function handleTabClick(event) {
  const tab = event.target.closest('[data-panel]');
  if (!tab) return;

  const targetPanel = tab.dataset.panel;
  if (!targetPanel || targetPanel === state.activePanel) return;

  const tabBar = tab.parentElement;
  const tabs = tabBar.querySelectorAll('[data-panel]');
  tabs.forEach((t) => {
    t.classList.remove(CSS.TAB_ACTIVE);
    t.setAttribute('aria-selected', 'false');
  });
  tab.classList.add(CSS.TAB_ACTIVE);
  tab.setAttribute('aria-selected', 'true');

  const panelIds = Object.values(PANEL_MAP);
  panelIds.forEach((id) => {
    const el = document.querySelector('[data-testid="' + id + '"]');
    if (!el) return;
    el.classList.remove(CSS.PANEL_VISIBLE);
    el.classList.add(CSS.PANEL_HIDDEN);
  });

  const targetTestId = PANEL_MAP[targetPanel];
  if (targetTestId) {
    const targetEl = document.querySelector('[data-testid="' + targetTestId + '"]');
    if (targetEl) {
      targetEl.classList.remove(CSS.PANEL_HIDDEN);
      targetEl.classList.add(CSS.PANEL_VISIBLE);
    }
  }

  state.activePanel = targetPanel;

  if (targetPanel === 'terminal' && commandInputEl) {
    commandInputEl.focus();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Socket Connection                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Establish Socket.io connection to /terminal namespace.
 *
 * @returns {Object} Socket.io socket instance
 */
/**
 * Handle inbound wwdd_update event from the terminal socket.
 * Dispatches a CustomEvent on document so cotwWwddView can
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
    console.error(MODULE, 'Socket.io client not loaded');
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

  socket.on('connect', () => {
    state.isConnected = true;
    setConnectionStatus('connected');
    console.info(MODULE, 'Connected to /terminal');
    displayStatusMessage('COTW Connection Secure');
    replayPendingCommands();
  });

  socket.on('disconnect', (reason) => {
    state.isConnected = false;
    setConnectionStatus('disconnected');
    console.warn(MODULE, 'Disconnected:', reason);
    displayStatusMessage('Disconnected — ' + reason);
  });

  socket.on('reconnect_attempt', (attemptNumber) => {
    setConnectionStatus('reconnecting');
    console.info(MODULE, 'Reconnect attempt', attemptNumber);
  });

  socket.on('reconnect', () => {
    state.isConnected = true;
    setConnectionStatus('connected');
    console.info(MODULE, 'Reconnected');
    displayStatusMessage('COTW Connection Restored');
    replayPendingCommands();
  });

  socket.on('reconnect_failed', () => {
    setConnectionStatus('disconnected');
    console.error(MODULE, 'Reconnection failed after', CONSTANTS.RECONNECT_ATTEMPTS, 'attempts');
    displaySystemMessage('Connection lost. Please refresh the page.');
  });

  socket.on('connect_error', (err) => {
    console.error(MODULE, 'Connection error:', err.message);
    if (err.message === 'Unauthorized') {
      displaySystemMessage('Session expired. Redirecting to login...');
      setTimeout(() => { window.location.href = CONSTANTS.LOGIN_REDIRECT; }, 2000);
    }
  });

  socket.on('command-response', handleCommandResponse);
  socket.on('omiyage:offer', handleOmiyageOffer);
  socket.on('omiyage:fulfilled', handleOmiyageFulfilled);
  socket.on('omiyage:declined', handleOmiyageDeclined);
  socket.on('tse:task', handleTseTask);
  socket.on('tse:paused', (data) => displayStatusMessage('Teaching session paused'));
  socket.on('tse:resumed', (data) => displayStatusMessage('Teaching session resumed'));
  socket.on('tse:error', handleTseError);
  socket.on('omiyage:error', (data) => displaySystemMessage('Gift error: ' + (data.error || 'Unknown')));
  socket.on('wwdd_update', handleWwddUpdate);

  return socket;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Lifecycle                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Initialize the terminal socket handler. Idempotent.
 *
 * @returns {Promise<boolean>} True if initialization succeeded
 */
async function init() {
  if (state.isInitialized) {
    console.warn(MODULE, 'Already initialized');
    return true;
  }

  if (!cacheDomRefs()) {
    return false;
  }

  const user = await checkAuth();
  if (!user) return false;

  state.user = user;
  updateDossierUser(user);

  state.socket = connectSocket();
  if (!state.socket) return false;

  commandInputEl.addEventListener('keydown', handleInputKeydown, {
    signal: state.lifecycleController.signal
  });

  const tabBar = document.querySelector('[data-testid="panel-tabs"]');
  if (tabBar) {
    tabBar.addEventListener('click', handleTabClick, {
      signal: state.lifecycleController.signal
    });
  }

  state.isInitialized = true;
  console.info(MODULE, 'Initialized for user', user.username);
  return true;
}

/**
 * Destroy the terminal socket handler. Cleans up all resources.
 */
function destroy() {
  state.lifecycleController.abort();

  if (state.socket) {
    state.socket.off('connect');
    state.socket.off('disconnect');
    state.socket.off('reconnect_attempt');
    state.socket.off('reconnect');
    state.socket.off('reconnect_failed');
    state.socket.off('connect_error');
    state.socket.off('command-response');
    state.socket.off('omiyage:offer');
    state.socket.off('omiyage:fulfilled');
    state.socket.off('omiyage:declined');
    state.socket.off('tse:task');
    state.socket.off('tse:paused');
    state.socket.off('tse:resumed');
    state.socket.off('tse:error');
    state.socket.off('omiyage:error');
    state.socket.off('wwdd_update');
    state.socket.disconnect();
    state.socket = null;
  }

  state.isConnected = false;
  state.isInitialized = false;
  state.typewriterQueue = [];
  state.pendingCommands = [];

  chatOutputEl = null;
  commandInputEl = null;
  connectionStatusEl = null;

  console.info(MODULE, 'Destroyed');
}

window.addEventListener('unload', destroy, { once: true });

init();

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports (for testability)                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export {
  init,
  destroy,
  sendCommand,
  handleCommandResponse,
  enqueueTypewriter,
  setConnectionStatus,
  checkAuth,
  updateDossierUser,
  updateDossierPad
};

export default { init, destroy };
