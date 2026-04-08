/**
 * ============================================================================
 * Psychic Radar Socket — WebSocket Connection Manager
 * File: public/shared/js/psychicRadarSocket.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Manages the Socket.IO connection to /ws/psychic-radar namespace.
 * Receives contact data from the server and forwards it to the canvas
 * renderer and data panel modules via callbacks.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import PsychicRadarSocket from '/shared/js/psychicRadarSocket.js';
 *
 *   const radarSocket = new PsychicRadarSocket();
 *   radarSocket.onContacts((contacts, tick) => { ... });
 *   radarSocket.onStatusChange((status, text) => { ... });
 *   radarSocket.connect();
 *   radarSocket.requestUpdate();
 *   radarSocket.destroy();
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Extracted: February 24, 2026
 * ============================================================================
 */

const SOCKET_CONFIG = Object.freeze({
    RECONNECT_BASE_MS: 1000,
    RECONNECT_MAX_MS: 30000,
    RECONNECT_MULTIPLIER: 1.5,
    RECONNECT_JITTER: 0.5,
});

class PsychicRadarSocket {
    constructor() {
        this._socket = null;
        this._reconnectAttempts = 0;
        this._reconnectTimer = null;

        this._onContacts = null;
        this._onStatusChange = null;
    }

    _getSocketUrl() {
        const host = window.location.host || 'localhost:3000';
        return window.location.protocol + '//' + host;
    }

    _validateContact(c) {
        if (!c || typeof c !== 'object') return false;
        if (typeof c.id !== 'string' || c.id.length === 0) return false;
        if (typeof c.distance !== 'number' || isNaN(c.distance)) return false;
        if (typeof c.angle !== 'number' || isNaN(c.angle)) return false;
        if (c.distance < 0 || c.distance > 1) return false;
        return true;
    }

    _validatePayload(data) {
        if (!data || typeof data !== 'object') return false;
        if (data.type !== 'contacts') return false;
        if (!Array.isArray(data.contacts)) return false;
        return true;
    }

    _setStatus(status, text) {
        if (this._onStatusChange) {
            this._onStatusChange(status, text);
        }
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectAttempts++;

        const baseDelay = Math.min(
            SOCKET_CONFIG.RECONNECT_BASE_MS * Math.pow(
                SOCKET_CONFIG.RECONNECT_MULTIPLIER,
                this._reconnectAttempts - 1
            ),
            SOCKET_CONFIG.RECONNECT_MAX_MS
        );

        const jitteredDelay = baseDelay * (
            SOCKET_CONFIG.RECONNECT_JITTER +
            Math.random() * (1 - SOCKET_CONFIG.RECONNECT_JITTER)
        );

        this._setStatus(
            'reconnecting',
            'RECONNECTING (' + Math.round(jitteredDelay / 1000) + 's)'
        );

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._socket) {
                this._socket.close();
                this._socket = null;
            }
            this.connect();
        }, jitteredDelay);
    }

    /* ===== PUBLIC API ===== */

    connect() {
        if (typeof io === 'undefined') {
            this._setStatus('offline', 'NO SOCKET.IO');
            return;
        }

        const url = this._getSocketUrl();
        this._socket = io(url + '/ws/psychic-radar', {
            reconnection: false,
            transports: ['websocket', 'polling'],
        });

        this._socket.on('connect', () => {
            this._reconnectAttempts = 0;
            this._setStatus('online', 'ONLINE');
        });

        this._socket.on('contacts', (data) => {
            if (!this._validatePayload(data)) return;

            const validContacts = data.contacts.filter(c => this._validateContact(c));

            if (this._onContacts) {
                this._onContacts(validContacts, data.tick);
            }
        });

        this._socket.on('disconnect', () => {
            this._setStatus('offline', 'DISCONNECTED');
            this._scheduleReconnect();
        });

        this._socket.on('connect_error', () => {
            this._setStatus('offline', 'ERROR');
            this._scheduleReconnect();
        });
    }

    requestUpdate() {
        if (this._socket && this._socket.connected) {
            this._socket.emit('request-update');
        }
    }

    isConnected() {
        return this._socket && this._socket.connected;
    }

    onContacts(callback) { this._onContacts = callback; }
    onStatusChange(callback) { this._onStatusChange = callback; }

    destroy() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._socket) {
            this._socket.close();
            this._socket = null;
        }
        this._reconnectAttempts = 0;
    }
}

export default PsychicRadarSocket;
