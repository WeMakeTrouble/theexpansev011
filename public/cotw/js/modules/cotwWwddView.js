/**
 * ============================================================================
 * COTW WWDD Gunsight View — User Terminal Integration
 * File: public/cotw/js/modules/cotwWwddView.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Embeds the WWDD Gunsight instrument into the COTW user terminal layout:
 *   - Canvas renders in the TOP panel (persistent, stateful)
 *   - Hypothesis breakdown renders in the right panel via cotwViewController
 *
 * DATA SOURCE:
 * ---------------------------------------------------------------------------
 * Listens for CustomEvent('wwdd:update') dispatched by terminalSocketHandler.js
 * when a wwdd_update socket event arrives from the terminal socket.
 * No separate socket connection — decoupled via DOM events.
 *
 * SURFACING:
 * ---------------------------------------------------------------------------
 * When gaugeState === 'surfacing', the right panel shows a reveal button.
 * Calls GET /api/user/wwdd/surface/:conversationId.
 * Surfacing is ALWAYS user-initiated — never automatic.
 *
 * ============================================================================
 * Project: The Expanse v010
 * ============================================================================
 */

import WwddGunsightCanvas from '/shared/js/wwddGunsightCanvas.js';
import cotwViewController from '../cotwViewController.js';

const PANEL_ID = 'panel-top';

let _canvas         = null;
let _gunsightActive = false;
let _lastState      = null;

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
 * PUBLIC: ACTIVATE GUNSIGHT
 * ============================================================================ */

function activateGunsight() {
    const topBody = _getTopPanelBody();
    if (!topBody) return;

    // Check if our canvas is still in the DOM — may have been displaced
    const isDisplaced = _gunsightActive && _canvas && !topBody.contains(_canvas._canvas);
    if (isDisplaced) {
        // Canvas was displaced by another instrument — destroy and rebuild
        document.removeEventListener('wwdd:update', _onWwddUpdate);
        if (_canvas) { _canvas.destroy(); _canvas = null; }
        _gunsightActive = false;
    }

    if (_gunsightActive) return;

    _showTopPanel();
    topBody.innerHTML = '';

    _canvas = new WwddGunsightCanvas(topBody);
    _canvas.start();

    if (_lastState) {
        _canvas.update(_lastState);
    }

    document.addEventListener('wwdd:update', _onWwddUpdate);

    _gunsightActive = true;
}

function closeGunsight() {
    document.removeEventListener('wwdd:update', _onWwddUpdate);

    if (_canvas) {
        _canvas.destroy();
        _canvas = null;
    }

    _hideTopPanel();
    _gunsightActive = false;
}

/* ============================================================================
 * RIGHT PANEL — Hypothesis breakdown + surfacing
 * ============================================================================ */

function _buildRightPanelHTML(state) {
    if (!state) {
        return '<div class="wwdd-right"><div class="wwdd-waiting">Awaiting session data...</div></div>';
    }

    const gauge     = state.gaugeState ?? 'warming';
    const clarity   = state.clarity ?? 0;
    const alignment = state.alignment;
    const active    = state.activeHypothesis;
    const hyps      = state.hypotheses ?? {};
    const turnCount = state.turnCount ?? 0;

    const gaugeLabel = gauge === 'warming' ? 'SCANNING'
        : gauge === 'tracking' ? 'TRACKING' : 'LOCKED';

    let html = '<div class="wwdd-right">';

    html += '<div class="wwdd-header">';
    html += '<span class="wwdd-title">WWDD ENGINE</span>';
    html += '<span class="wwdd-badge wwdd-badge--' + gauge + '">' + gaugeLabel + '</span>';
    html += '</div>';

    html += '<div class="wwdd-readouts">';
    html += '<div class="wwdd-readout-row"><span class="wwdd-rkey">Clarity</span>';
    html += '<span class="wwdd-rval">' + (clarity * 100).toFixed(0) + '%</span></div>';
    html += '<div class="wwdd-readout-row"><span class="wwdd-rkey">Alignment</span>';
    html += '<span class="wwdd-rval">' +
        (alignment !== null && alignment !== undefined
            ? (alignment * 100).toFixed(0) + '%' : '--') + '</span></div>';
    html += '<div class="wwdd-readout-row"><span class="wwdd-rkey">Turns</span>';
    html += '<span class="wwdd-rval">' + turnCount + '</span></div>';
    html += '</div>';

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
            const res  = await fetch('/api/user/wwdd/surface/' + convId, {
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
 * VIEWCONTROLLER HANDLER
 * ============================================================================ */

cotwViewController.register('wwdd-gunsight', async (ctx) => {
    activateGunsight();

    ctx.container.innerHTML = _buildRightPanelHTML(_lastState);
    _wireSurfaceButton(_lastState);

    const updateHandler = (event) => {
        const state = event?.detail;
        if (!state) return;
        _lastState = state;
        ctx.container.innerHTML = _buildRightPanelHTML(state);
        _wireSurfaceButton(state);
    };

    document.addEventListener('wwdd:update', updateHandler);

    ctx.signal.addEventListener('abort', () => {
        document.removeEventListener('wwdd:update', updateHandler);
    });
});

/* ============================================================================
 * EXPORTS
 * ============================================================================ */

export { activateGunsight, closeGunsight };

export default Object.freeze({ activateGunsight, closeGunsight });
