/**
 * ============================================================================
 * Psychic Radar View — CMS Admin Panel Integration
 * File: public/cms/js/modules/psychicRadarView.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Embeds the Psychic Radar into the CMS admin layout:
 * - Canvas (sweep arm + blips) renders in the TOP panel (persistent)
 * - Data panels (Instruments, PAD, Contacts, Legend) render in the RIGHT panel
 * - Both share the same WebSocket connection
 *
 * TOP PANEL BEHAVIOUR:
 * ---------------------------------------------------------------------------
 * The radar canvas persists in the top panel until explicitly closed or
 * replaced by another tool. Navigating away in the left menu does NOT
 * close the radar. The canvas keeps animating and receiving data.
 *
 * RIGHT PANEL BEHAVIOUR:
 * ---------------------------------------------------------------------------
 * The data panels are managed by viewController like any other view.
 * When the user navigates to a different view, the data panels are replaced.
 * The radar canvas continues running in the top panel independently.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 * Registered with viewController for psychic-radar item.
 * Also exports activateRadar() for direct calls from menu.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Date: February 24, 2026
 * ============================================================================
 */

import PsychicRadarCanvas from '/shared/js/psychicRadarCanvas.js';
import PsychicRadarData from '/shared/js/psychicRadarData.js';
import PsychicRadarSocket from '/shared/js/psychicRadarSocket.js';
import viewController from '../viewController.js';

const PANEL_IDS = Object.freeze({
    TOP: 'panel-top',
});

let radarCanvas = null;
let radarData = null;
let radarSocket = null;
let radarActive = false;
let socketScriptLoaded = false;

/* ============================================================================
 * SOCKET.IO LOADER
 * ============================================================================ */

function _loadSocketIO() {
    return new Promise((resolve, reject) => {
        if (typeof io !== 'undefined') {
            socketScriptLoaded = true;
            resolve();
            return;
        }
        if (socketScriptLoaded) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = '/socket.io/socket.io.js';
        script.onload = () => {
            socketScriptLoaded = true;
            resolve();
        };
        script.onerror = () => {
            const cdn = document.createElement('script');
            cdn.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
            cdn.onload = () => {
                socketScriptLoaded = true;
                resolve();
            };
            cdn.onerror = () => reject(new Error('Failed to load Socket.IO'));
            document.head.appendChild(cdn);
        };
        document.head.appendChild(script);
    });
}

/* ============================================================================
 * TOP PANEL HELPERS
 * ============================================================================ */

function _getTopPanelBody() {
    const panel = document.getElementById(PANEL_IDS.TOP);
    if (!panel) return null;
    return panel.querySelector('.panel__body') || panel;
}

function _showTopPanel() {
    const panel = document.getElementById(PANEL_IDS.TOP);
    if (panel) panel.removeAttribute('hidden');
}

function _hideTopPanel() {
    const panel = document.getElementById(PANEL_IDS.TOP);
    if (panel) panel.setAttribute('hidden', '');
}

/* ============================================================================
 * SOCKET WIRING — Connects socket to canvas and data panels
 * ============================================================================ */

function _wireSocket() {
    if (!radarSocket) return;

    radarSocket.onContacts((contacts, tick) => {
        if (radarCanvas) {
            radarCanvas.updateContacts(contacts);
        }
        if (radarData) {
            radarData.updateInstruments({
                contacts: contacts.length,
                tick: tick,
            });
            radarData.updateEntityList(
                radarCanvas ? radarCanvas.getBlips() : []
            );

            if (radarCanvas && radarCanvas._selectedBlipId) {
                const selected = radarCanvas.getBlips().find(
                    b => b.id === radarCanvas._selectedBlipId
                );
                if (selected) {
                    radarData.selectEntity(selected);
                }
            }
        }
    });

    radarSocket.onStatusChange((status, text) => {
        /* Status can be shown in the top panel header if needed */
    });
}

/* ============================================================================
 * CROSS-MODULE WIRING — Canvas ↔ Data panel event bridging
 * ============================================================================ */

function _wireCanvasToData() {
    if (!radarCanvas) return;

    radarCanvas.onScanCycle((count) => {
        if (radarData) {
            radarData.updateInstruments({ scanCycle: count });
        }
        if (radarSocket) {
            radarSocket.requestUpdate();
        }
    });

    radarCanvas.onFpsUpdate((fps) => {
        if (radarData) {
            radarData.updateInstruments({ fps });
        }
    });

    radarCanvas.onEntitySelect((blip) => {
        if (radarData) {
            radarData.selectEntity(blip);
        }
    });

    radarCanvas.onEntityDeselect(() => {
        if (radarData) {
            radarData.deselectEntity();
        }
    });
}

function _wireDataToCanvas() {
    if (!radarData) return;

    radarData.onEntityClick((id) => {
        if (radarCanvas) {
            radarCanvas.selectEntity(id);
        }
    });
}

/* ============================================================================
 * PUBLIC: ACTIVATE RADAR (Top Panel — Persistent)
 * ============================================================================ */

/**
 * Activate the radar canvas in the top panel.
 * Starts the animation loop and WebSocket connection.
 * Persists until closeRadar() is called or replaced.
 */
async function activateRadar() {
    const topBody = _getTopPanelBody();
    if (!topBody) return;

    // Check if our canvas was displaced by another instrument
    const isDisplaced = radarActive && radarCanvas && !topBody.contains(radarCanvas._canvas);
    if (isDisplaced) {
        if (radarSocket) { radarSocket.destroy(); radarSocket = null; }
        if (radarCanvas) { radarCanvas.destroy(); radarCanvas = null; }
        radarActive = false;
    }

    if (radarActive) return;

    _showTopPanel();
    topBody.innerHTML = '';

    radarCanvas = new PsychicRadarCanvas(topBody);
    _wireCanvasToData();
    radarCanvas.start();

    try {
        await _loadSocketIO();
        radarSocket = new PsychicRadarSocket();
        _wireSocket();
        radarSocket.connect();
    } catch (err) {
        /* Socket failed but canvas still runs with no data */
    }

    radarActive = true;
}

/**
 * Close the radar canvas in the top panel.
 * Stops animation, disconnects socket, hides panel.
 */
function closeRadar() {
    if (radarSocket) {
        radarSocket.destroy();
        radarSocket = null;
    }
    if (radarCanvas) {
        radarCanvas.destroy();
        radarCanvas = null;
    }

    _hideTopPanel();
    radarActive = false;
}

/**
 * Check if the radar is currently active in the top panel.
 */
function isRadarActive() {
    return radarActive;
}

/* ============================================================================
 * VIEWCONTROLLER HANDLER — Data Panels (Right Panel — Replaceable)
 * ============================================================================ */

/**
 * Handler registered with viewController for 'psychic-radar' item.
 * Renders data panels into the right panel container.
 * If radar canvas is not yet active, starts it in the top panel.
 */
viewController.register('psychic-radar', async (ctx) => {
    if (radarData) {
        radarData.destroy();
        radarData = null;
    }

    radarData = new PsychicRadarData(ctx.container);
    _wireDataToCanvas();

    await activateRadar();
    _wireCanvasToData();

    if (radarCanvas) {
        const blips = radarCanvas.getBlips();
        if (blips.length > 0) {
            radarData.updateEntityList(blips);
            radarData.updateInstruments({
                scanCycle: radarCanvas.getScanCycleCount(),
                contacts: blips.length,
                fps: radarCanvas.getFps(),
            });
        }
    }
});

/* ============================================================================
 * MODULE EXPORTS
 * ============================================================================ */

export { activateRadar, closeRadar, isRadarActive };

export default Object.freeze({
    activateRadar,
    closeRadar,
    isRadarActive,
});
