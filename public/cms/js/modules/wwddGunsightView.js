/**
 * ============================================================================
 * WWDD Gunsight View — CMS Admin Panel Integration
 * File: public/cms/js/modules/wwddGunsightView.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Embeds the WWDD Gunsight instrument into the CMS admin layout:
 *   - Canvas renders in the TOP panel (persistent, stateful)
 *   - Data readout (hypothesis breakdown + surfacing controls) renders
 *     in the right panel via viewController
 *
 * TOP PANEL BEHAVIOUR:
 * ---------------------------------------------------------------------------
 * The gunsight canvas persists in the top panel until explicitly closed or
 * displaced by another instrument. Navigating away in the left menu does NOT
 * close the canvas. State is preserved via module-level singleton in
 * wwddGunsightCanvas.js — last known WWDD state survives displacement
 * and is restored immediately when the canvas is recreated.
 *
 * DATA SOURCE:
 * ---------------------------------------------------------------------------
 * Listens for CustomEvent('wwdd:update') dispatched by cmsSocketHandler.js
 * when a wwdd_update socket event arrives from the terminal socket.
 * No separate socket connection — decoupled via DOM events.
 *
 * SURFACING:
 * ---------------------------------------------------------------------------
 * When gaugeState === 'surfacing', the right panel shows a reveal button.
 * This calls GET /api/admin/wwdd/surface/:conversationId.
 * Surfacing is ALWAYS user-initiated — never automatic.
 *
 * DISPLACEMENT PATTERN:
 * ---------------------------------------------------------------------------
 * If another instrument activates in the top panel, closeGunsight() is called.
 * The canvas is destroyed but module-level state persists.
 * When re-activated, the canvas immediately renders the last known state.
 *
 * ============================================================================
 * Project: The Expanse v010
 * ============================================================================
 */

import WwddGunsightCanvas from '/shared/js/wwddGunsightCanvas.js';
import viewController from '../viewController.js';

const PANEL_ID = 'panel-top';

let _canvas       = null;
let _gunsightActive = false;
let _lastState    = null;

/* ============================================================================
 * PANEL HELPERS
 * ============================================================================ */

function _getTopPanelBody() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return null;
    return panel.querySelector('.panel__body') || panel;
}

function _showTopPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.removeAttribute('hidden');
}

function _hideTopPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.setAttribute('hidden', '');
}

/* ============================================================================
 * WWDD UPDATE LISTENER
 * Receives CustomEvent from cmsSocketHandler and passes to canvas.
 * ============================================================================ */

function _onWwddUpdate(event) {
    const state = event?.detail;
    if (!state || typeof state !== 'object') return;
    _lastState = state;
    if (_canvas) {
        _canvas.update(state);
    }
}

/* ============================================================================
 * PUBLIC: ACTIVATE GUNSIGHT (Top Panel — Persistent)
 * ============================================================================ */

/**
 * Activate the WWDD gunsight canvas in the top panel.
 * Starts animation and begins listening for wwdd:update events.
 * Persists until closeGunsight() is called or displaced.
 */
function activateGunsight() {
    const topBody = _getTopPanelBody();
    if (!topBody) return;

    // Check if our canvas was displaced by another instrument
    const isDisplaced = _gunsightActive && _canvas && !topBody.contains(_canvas._canvas);
    if (isDisplaced) {
        document.removeEventListener('wwdd:update', _onWwddUpdate);
        if (_canvas) { _canvas.destroy(); _canvas = null; }
        _gunsightActive = false;
    }

    if (_gunsightActive) return;

    _showTopPanel();
    topBody.innerHTML = '';

    _canvas = new WwddGunsightCanvas(topBody);
    _canvas.start();

    // Restore last known state immediately if available
    if (_lastState) {
        _canvas.update(_lastState);
    }

    // Listen for live updates from terminal socket via cmsSocketHandler
    document.addEventListener('wwdd:update', _onWwddUpdate);

    _gunsightActive = true;
}

/**
 * Close the gunsight canvas in the top panel.
 * Preserves last known state in module singleton for restoration.
 */
function closeGunsight() {
    document.removeEventListener('wwdd:update', _onWwddUpdate);

    if (_canvas) {
        _canvas.destroy();
        _canvas = null;
    }

    _hideTopPanel();
    _gunsightActive = false;
}

/**
 * Check if the gunsight is currently active.
 * @returns {boolean}
 */
function isGunsightActive() {
    return _gunsightActive;
}

/* ============================================================================
 * RIGHT PANEL — Hypothesis breakdown + surfacing controls
 * ============================================================================ */

/**
 * Build the right panel content HTML.
 * Shows current hypothesis scores and surfacing button if applicable.
 *
 * @param {Object|null} state - Current WWDD state
 * @returns {string} HTML string
 */
function _buildRightPanelHTML(state) {
    if (!state) {
        return '<div class="wwdd-right">' +
            '<div class="wwdd-waiting">Awaiting session data...</div>' +
            '</div>';
    }

    const gauge      = state.gaugeState ?? 'warming';
    const clarity    = state.clarity ?? 0;
    const alignment  = state.alignment;
    const active     = state.activeHypothesis;
    const hyps       = state.hypotheses ?? {};
    const turnCount  = state.turnCount ?? 0;

    const gaugeLabel = gauge === 'warming'
        ? 'SCANNING'
        : gauge === 'tracking'
            ? 'TRACKING'
            : 'LOCKED';

    let html = '<div class="wwdd-right">';

    // Status header
    html += '<div class="wwdd-header">';
    html += '<span class="wwdd-title">WWDD ENGINE</span>';
    html += '<span class="wwdd-badge wwdd-badge--' + gauge + '">' + gaugeLabel + '</span>';
    html += '</div>';

    // Clarity / Alignment readouts
    html += '<div class="wwdd-readouts">';
    html += '<div class="wwdd-readout-row">';
    html += '<span class="wwdd-rkey">Clarity</span>';
    html += '<span class="wwdd-rval">' + (clarity * 100).toFixed(0) + '%</span>';
    html += '</div>';
    html += '<div class="wwdd-readout-row">';
    html += '<span class="wwdd-rkey">Alignment</span>';
    html += '<span class="wwdd-rval">' +
        (alignment !== null && alignment !== undefined
            ? (alignment * 100).toFixed(0) + '%'
            : '--') +
        '</span>';
    html += '</div>';
    html += '<div class="wwdd-readout-row">';
    html += '<span class="wwdd-rkey">Turns</span>';
    html += '<span class="wwdd-rval">' + turnCount + '</span>';
    html += '</div>';
    html += '</div>';

    // Hypothesis breakdown
    html += '<div class="wwdd-hyp-title">HYPOTHESES</div>';
    html += '<div class="wwdd-hyp-list">';

    const sorted = Object.entries(hyps).sort((a, b) => b[1] - a[1]);
    sorted.forEach(([id, score]) => {
        const isActive = id === active;
        const pct      = (score * 100).toFixed(0);
        const label    = id.replace(/_/g, ' ').toUpperCase();
        html += '<div class="wwdd-hyp-row' + (isActive ? ' wwdd-hyp-active' : '') + '">';
        html += '<span class="wwdd-hyp-label">' + label + '</span>';
        html += '<div class="wwdd-hyp-bar-track">';
        html += '<div class="wwdd-hyp-bar-fill" style="width:' + pct + '%"></div>';
        html += '</div>';
        html += '<span class="wwdd-hyp-pct">' + pct + '%</span>';
        html += '</div>';
    });

    html += '</div>';

    // Surfacing button — only when locked
    if (gauge === 'surfacing') {
        html += '<div class="wwdd-surface-zone">';
        html += '<div class="wwdd-surface-hint">Session outcome inferred with high confidence.</div>';
        html += '<button class="wwdd-surface-btn" id="wwddSurfaceBtn">REVEAL OUTCOME</button>';
        html += '<div class="wwdd-surface-result" id="wwddSurfaceResult"></div>';
        html += '</div>';
    }

    html += '</div>';
    return html;
}

/**
 * Wire surfacing button if present in DOM.
 * @param {Object} state - Current WWDD state
 */
function _wireSurfaceButton(state) {
    const btn = document.getElementById('wwddSurfaceBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'REVEALING...';

        const resultEl = document.getElementById('wwddSurfaceResult');
        const convId   = state?.conversationId;

        if (!convId) {
            if (resultEl) resultEl.textContent = 'No active session.';
            btn.disabled = false;
            btn.textContent = 'REVEAL OUTCOME';
            return;
        }

        try {
            const res  = await fetch('/api/admin/wwdd/surface/' + convId, {
                credentials: 'include'
            });
            const data = await res.json();

            if (data.success) {
                if (resultEl) {
                    resultEl.textContent = data.outcomeName + ' (' +
                        Math.round(data.confidence * 100) + '% confidence)';
                    resultEl.className = 'wwdd-surface-result wwdd-surface-result--success';
                }
                btn.textContent = 'REVEALED';
            } else {
                if (resultEl) {
                    resultEl.textContent = data.error || 'Unable to surface outcome.';
                    resultEl.className = 'wwdd-surface-result wwdd-surface-result--error';
                }
                btn.disabled = false;
                btn.textContent = 'REVEAL OUTCOME';
            }
        } catch (err) {
            if (resultEl) {
                resultEl.textContent = 'Request failed.';
                resultEl.className = 'wwdd-surface-result wwdd-surface-result--error';
            }
            btn.disabled = false;
            btn.textContent = 'REVEAL OUTCOME';
        }
    });
}

/* ============================================================================
 * VIEWCONTROLLER HANDLER — Right Panel (Replaceable)
 * ============================================================================ */

viewController.register('wwdd-gunsight', async (ctx) => {
    // Activate canvas in top panel — displacement check is inside activateGunsight
    activateGunsight();

    // Render right panel with current state
    ctx.container.innerHTML = _buildRightPanelHTML(_lastState);
    _wireSurfaceButton(_lastState);

    // Re-render right panel on each wwdd:update while this view is active
    const updateHandler = (event) => {
        const state = event?.detail;
        if (!state) return;
        _lastState = state;
        ctx.container.innerHTML = _buildRightPanelHTML(state);
        _wireSurfaceButton(state);
    };

    document.addEventListener('wwdd:update', updateHandler);

    // Cleanup when view is replaced
    ctx.signal.addEventListener('abort', () => {
        document.removeEventListener('wwdd:update', updateHandler);
    });
});

/* ============================================================================
 * EXPORTS
 * ============================================================================ */

export { activateGunsight, closeGunsight, isGunsightActive };

export default Object.freeze({
    activateGunsight,
    closeGunsight,
    isGunsightActive
});
