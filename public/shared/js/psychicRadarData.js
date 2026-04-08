/**
 * ============================================================================
 * Psychic Radar Data Panels — Reusable Data Display
 * File: public/shared/js/psychicRadarData.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Renders the data panels for the Psychic Radar: Instruments, PAD State,
 * Contacts list, and Relationship Types legend. Can be embedded in any
 * container element — standalone page or CMS admin right panel.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import PsychicRadarData from '/shared/js/psychicRadarData.js';
 *
 *   const dataPanel = new PsychicRadarData(containerElement);
 *   dataPanel.updateInstruments({ scanCycle: 5, contacts: 9, tick: 42, fps: 60 });
 *   dataPanel.selectEntity(blip);
 *   dataPanel.deselectEntity();
 *   dataPanel.updateEntityList(blips);
 *   dataPanel.destroy();
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Extracted: February 24, 2026
 * ============================================================================
 */

import { REL_HEX } from './psychicRadarCanvas.js';

const scheduleIdle = window.requestIdleCallback || function (cb) {
    return setTimeout(function () { cb({ timeRemaining: function () { return 50; } }); }, 1);
};
const cancelIdle = window.cancelIdleCallback || clearTimeout;

class PsychicRadarData {
    constructor(container) {
        if (!(container instanceof HTMLElement)) {
            throw new TypeError('PsychicRadarData: container must be an HTMLElement');
        }

        this._container = container;
        this._entityListPending = null;
        this._selectedBlipId = null;

        this._els = {};

        this._onEntityClick = null;

        this._buildDom();
    }

    _buildDom() {
        this._container.innerHTML = '';
        this._container.classList.add('radar-side-panel');

        const html = `
            <div class="radar-panel-section">
                <h3>Instruments</h3>
                <div class="readout-row">
                    <span class="readout-label">Scan Cycle</span>
                    <span class="readout-value" data-ref="scanCycle">---</span>
                </div>
                <div class="readout-row">
                    <span class="readout-label">Contacts</span>
                    <span class="readout-value" data-ref="contactCount">0</span>
                </div>
                <div class="readout-row">
                    <span class="readout-label">Engine Tick</span>
                    <span class="readout-value" data-ref="tickValue">--</span>
                </div>
                <div class="readout-row">
                    <span class="readout-label">FPS</span>
                    <span class="readout-value" data-ref="fpsValue">--</span>
                </div>
            </div>

            <div class="radar-panel-section">
                <h3>PAD State</h3>
                <div data-ref="padEntityName" style="font-size: 11px; margin-bottom: 6px; color: var(--crt-green);">No selection</div>
                <div>
                    <div class="pad-bar-row">
                        <span class="pad-bar-label">P</span>
                        <div class="pad-bar-track"><div class="pad-bar-fill" data-ref="padP" style="left:50%;width:0;background:var(--pad-pleasure);"></div></div>
                        <span class="pad-bar-value" data-ref="padPVal">0.00</span>
                    </div>
                    <div class="pad-bar-row">
                        <span class="pad-bar-label">A</span>
                        <div class="pad-bar-track"><div class="pad-bar-fill" data-ref="padA" style="left:50%;width:0;background:var(--pad-arousal);"></div></div>
                        <span class="pad-bar-value" data-ref="padAVal">0.00</span>
                    </div>
                    <div class="pad-bar-row">
                        <span class="pad-bar-label">D</span>
                        <div class="pad-bar-track"><div class="pad-bar-fill" data-ref="padD" style="left:50%;width:0;background:var(--pad-dominance);"></div></div>
                        <span class="pad-bar-value" data-ref="padDVal">0.00</span>
                    </div>
                </div>
                <div class="readout-row" data-ref="relTypeRow" style="display:none;">
                    <span class="readout-label">Relationship</span>
                    <span class="readout-value" data-ref="relTypeValue">--</span>
                </div>
                <div class="readout-row" data-ref="catRow" style="display:none;">
                    <span class="readout-label">Category</span>
                    <span class="readout-value" data-ref="catValue">--</span>
                </div>
            </div>

            <div class="radar-panel-section">
                <h3>Contacts</h3>
                <div class="entity-list" data-ref="entityList">
                    <div style="font-size:10px;color:rgba(0,255,127,0.4);padding:8px 0;">Awaiting data...</div>
                </div>
            </div>

            <div class="radar-panel-section">
                <h3>Relationship Types</h3>
                <div class="legend-grid">
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-bound);"></div>Bound</div>
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-council);"></div>Council</div>
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-protagonist);"></div>Protagonist</div>
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-ally);"></div>Ally</div>
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-chaotic);"></div>Chaotic</div>
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-neutral);"></div>Neutral</div>
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-hostile);"></div>Hostile</div>
                    <div class="legend-item"><div class="legend-dot" style="background:var(--rel-antagonist);"></div>Antagonist</div>
                </div>
            </div>
        `;

        this._container.innerHTML = html;

        const refs = this._container.querySelectorAll('[data-ref]');
        for (let i = 0; i < refs.length; i++) {
            this._els[refs[i].dataset.ref] = refs[i];
        }

        this._els.entityList.addEventListener('click', (e) => {
            const item = e.target.closest('.entity-item');
            if (!item) return;
            const id = item.getAttribute('data-id');
            if (id && this._onEntityClick) {
                this._onEntityClick(id);
            }
        });
    }

    _updatePadBar(barRef, valRef, value) {
        const bar = this._els[barRef];
        const valEl = this._els[valRef];
        if (!bar || !valEl) return;

        const clamped = Math.max(-1, Math.min(1, value));
        const pct = Math.abs(clamped) * 50;
        const leftPos = clamped >= 0 ? 50 : 50 - pct;
        bar.style.left = leftPos + '%';
        bar.style.width = pct + '%';
        valEl.textContent = clamped >= 0 ? '+' + clamped.toFixed(2) : clamped.toFixed(2);
    }

    /* ===== PUBLIC API ===== */

    updateInstruments(data) {
        if (data.scanCycle !== undefined && this._els.scanCycle) {
            this._els.scanCycle.textContent = data.scanCycle;
        }
        if (data.contacts !== undefined && this._els.contactCount) {
            this._els.contactCount.textContent = data.contacts;
        }
        if (data.tick !== undefined && this._els.tickValue) {
            this._els.tickValue.textContent = data.tick;
        }
        if (data.fps !== undefined && this._els.fpsValue) {
            this._els.fpsValue.textContent = data.fps;
        }
    }

    selectEntity(blip) {
        this._selectedBlipId = blip.id;

        if (this._els.padEntityName) {
            this._els.padEntityName.textContent = blip.label + ' (' + blip.id + ')';
        }

        if (blip.pad) {
            this._updatePadBar('padP', 'padPVal', blip.pad.p || 0);
            this._updatePadBar('padA', 'padAVal', blip.pad.a || 0);
            this._updatePadBar('padD', 'padDVal', blip.pad.d || 0);
        } else {
            this._updatePadBar('padP', 'padPVal', 0);
            this._updatePadBar('padA', 'padAVal', 0);
            this._updatePadBar('padD', 'padDVal', 0);
        }

        if (blip.relationship && this._els.relTypeRow) {
            this._els.relTypeRow.style.display = 'flex';
            this._els.relTypeValue.textContent = blip.relationship;
            this._els.relTypeValue.style.color = REL_HEX[blip.relationship] || 'var(--crt-green)';
        } else if (this._els.relTypeRow) {
            this._els.relTypeRow.style.display = 'none';
        }

        if (blip.category && this._els.catRow) {
            this._els.catRow.style.display = 'flex';
            this._els.catValue.textContent = blip.category;
        } else if (this._els.catRow) {
            this._els.catRow.style.display = 'none';
        }

        this._updateEntityListSelection(blip.id);
    }

    deselectEntity() {
        this._selectedBlipId = null;

        if (this._els.padEntityName) {
            this._els.padEntityName.textContent = 'No selection';
        }
        this._updatePadBar('padP', 'padPVal', 0);
        this._updatePadBar('padA', 'padAVal', 0);
        this._updatePadBar('padD', 'padDVal', 0);

        if (this._els.relTypeRow) this._els.relTypeRow.style.display = 'none';
        if (this._els.catRow) this._els.catRow.style.display = 'none';

        this._updateEntityListSelection(null);
    }

    updateEntityList(blips) {
        if (this._entityListPending) {
            cancelIdle(this._entityListPending);
        }
        this._entityListPending = scheduleIdle(() => {
            this._entityListPending = null;
            this._renderEntityList(blips);
        });
    }

    _renderEntityList(blips) {
        const container = this._els.entityList;
        if (!container) return;

        if (!blips || blips.length === 0) {
            container.innerHTML = '<div style="font-size:10px;color:rgba(0,255,127,0.4);padding:8px 0;">Awaiting data...</div>';
            return;
        }

        const sorted = blips.slice().sort((a, b) => a.distanceRaw - b.distanceRaw);
        let html = '';
        for (let i = 0; i < sorted.length; i++) {
            const b = sorted[i];
            const col = REL_HEX[b.relationship] || '#888';
            const sel = b.id === this._selectedBlipId ? ' selected' : '';
            html += '<div class="entity-item' + sel + '" data-id="' + b.id + '">';
            html += '<div class="entity-dot" style="background:' + col + ';box-shadow:0 0 4px ' + col + ';"></div>';
            html += '<span class="entity-name">' + (b.label || b.id) + '</span>';
            html += '<span class="entity-dist">' + (b.distanceRaw !== undefined ? b.distanceRaw.toFixed(2) : '--') + '</span>';
            html += '</div>';
        }
        container.innerHTML = html;
    }

    _updateEntityListSelection(id) {
        const items = this._container.querySelectorAll('.entity-item');
        for (let i = 0; i < items.length; i++) {
            if (items[i].getAttribute('data-id') === id) {
                items[i].classList.add('selected');
            } else {
                items[i].classList.remove('selected');
            }
        }
    }

    onEntityClick(callback) { this._onEntityClick = callback; }

    destroy() {
        if (this._entityListPending) {
            cancelIdle(this._entityListPending);
        }
        this._container.innerHTML = '';
        this._container.classList.remove('radar-side-panel');
        this._els = {};
    }
}

export default PsychicRadarData;
