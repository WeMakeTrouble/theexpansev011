/**
 * ============================================================================
 * Psychic Radar Canvas — Reusable Radar Renderer
 * File: public/shared/js/psychicRadarCanvas.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * The canvas rendering engine for the Psychic Radar. Draws the sweep arm,
 * contact blips, range rings, and crosshairs. Can be embedded in any
 * container element — standalone page or CMS admin panel.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import PsychicRadarCanvas from '/shared/js/psychicRadarCanvas.js';
 *
 *   const radar = new PsychicRadarCanvas(containerElement);
 *   radar.start();
 *   radar.updateContacts(contactsArray);
 *   radar.selectEntity(hexId);
 *   radar.destroy();
 *
 * DESIGN:
 * ---------------------------------------------------------------------------
 * Claude the Tanuki is always at center — he is the observer, not a data
 * point. All contacts are relative distance FROM Claude. No geographic
 * data — The Expanse has no physical space. The sweep represents the
 * engine scanning emotional states.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Extracted: February 24, 2026
 * ============================================================================
 */

const CONFIG = Object.freeze({
    SWEEP_SPEED: 0.018,
    SWEEP_TRAIL_ANGLE: 0.5,
    RING_COUNT: 4,
    DPR_MAX: 2,
    FONT_FAMILY: '"IBM Plex Mono", "SF Mono", "Consolas", monospace',
    LABEL_FONT_SIZE: 9,
    RING_LABEL_FONT_SIZE: 8,
    BLIP_GLOW_BASE: 18,
    BLIP_GLOW_INTENSITY: 12,
    BLIP_CORE_MIN: 2,
    BLIP_CORE_MAX: 5,
    MIN_LABEL_ALPHA: 0.25,
    PULSE_SPEED: 0.003,
    DELTA_MAX_MS: 100,
});

const RING_LABELS = Object.freeze(['BOUND', 'ALLY', 'NEUTRAL', 'HOSTILE']);

const REL_HEX = Object.freeze({
    bound:       '#00ffff',
    council:     '#7fff00',
    protagonist: '#ffd700',
    ally:        '#00ff7f',
    chaotic:     '#ff6600',
    neutral:     '#888888',
    hostile:     '#ff3333',
    antagonist:  '#ff0066',
});

function _hexToRgbString(hex) {
    let clean = (hex || '').replace('#', '');
    if (clean.length === 3) {
        clean = clean.split('').map(c => c + c).join('');
    }
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return `${r}, ${g}, ${b}`;
}

const REL_RGB = Object.freeze(
    Object.keys(REL_HEX).reduce((acc, key) => {
        acc[key] = _hexToRgbString(REL_HEX[key]);
        return acc;
    }, {})
);

class PsychicRadarCanvas {
    constructor(container) {
        if (!(container instanceof HTMLElement)) {
            throw new TypeError('PsychicRadarCanvas: container must be an HTMLElement');
        }

        this._container = container;
        this._canvas = null;
        this._ctx = null;
        this._offCanvas = null;
        this._offCtx = null;
        this._offDirty = true;

        this._w = 0;
        this._h = 0;
        this._cx = 0;
        this._cy = 0;
        this._radius = 0;

        this._sweepAngle = 0;
        this._previousSweepAngle = 0;
        this._scanCycleCount = 0;

        this._blips = [];
        this._selectedBlipId = null;

        this._animationId = null;
        this._lastFrameTime = 0;
        this._fpsFrames = 0;
        this._fpsLastTime = 0;
        this._currentFps = 0;

        this._resizeHandler = this._debounce(() => this._resize(), 100);
        this._clickHandler = (e) => this._handleClick(e);

        this._onScanCycle = null;
        this._onEntitySelect = null;
        this._onEntityDeselect = null;
        this._onFpsUpdate = null;

        this._buildDom();
        this._initCanvas();
    }

    _buildDom() {
        this._container.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.classList.add('crt-wrapper');

        const consoleEl = document.createElement('div');
        consoleEl.classList.add('console');

        this._canvas = document.createElement('canvas');
        this._canvas.classList.add('radar-canvas');

        const marker = document.createElement('div');
        marker.classList.add('center-marker');

        const label = document.createElement('div');
        label.classList.add('claude-label');
        label.textContent = 'CLAUDE';

        consoleEl.appendChild(this._canvas);
        consoleEl.appendChild(marker);
        consoleEl.appendChild(label);
        wrapper.appendChild(consoleEl);
        this._container.appendChild(wrapper);
    }

    _initCanvas() {
        this._ctx = this._canvas.getContext('2d', { desynchronized: true });
        this._lastFrameTime = performance.now();
        this._fpsLastTime = performance.now();
        this._resize();
        window.addEventListener('resize', this._resizeHandler);
        this._canvas.addEventListener('click', this._clickHandler);
    }

    _debounce(fn, delay) {
        let timer = null;
        return function () {
            clearTimeout(timer);
            timer = setTimeout(() => fn(), delay);
        };
    }

    _resize() {
        const rect = this._canvas.parentElement.getBoundingClientRect();
        const size = Math.min(rect.width, rect.height);
        if (size <= 0) return;

        const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_MAX);

        this._canvas.width = Math.floor(size * dpr);
        this._canvas.height = Math.floor(size * dpr);
        this._canvas.style.width = size + 'px';
        this._canvas.style.height = size + 'px';
        this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this._w = size;
        this._h = size;
        this._cx = size / 2;
        this._cy = size / 2;
        this._radius = size * 0.44;

        this._offCanvas = document.createElement('canvas');
        this._offCanvas.width = this._canvas.width;
        this._offCanvas.height = this._canvas.height;
        this._offCtx = this._offCanvas.getContext('2d');
        this._offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._offDirty = true;

        for (let i = 0; i < this._blips.length; i++) {
            this._blips[i].r = this._blips[i].distanceRaw * this._radius;
        }
    }

    _renderStaticBackground() {
        const oc = this._offCtx;
        const r = this._radius;
        const cx = this._cx;
        const cy = this._cy;

        oc.fillStyle = '#000';
        oc.fillRect(0, 0, this._w, this._h);

        oc.save();
        oc.translate(cx, cy);
        oc.beginPath();
        oc.arc(0, 0, r, 0, Math.PI * 2);
        oc.clip();

        const grad = oc.createRadialGradient(0, 0, 0, 0, 0, r);
        grad.addColorStop(0, 'rgba(0, 40, 16, 1)');
        grad.addColorStop(1, 'rgba(0, 6, 3, 1)');
        oc.fillStyle = grad;
        oc.fillRect(-r, -r, r * 2, r * 2);

        for (let i = 1; i <= CONFIG.RING_COUNT; i++) {
            const rr = (r / CONFIG.RING_COUNT) * i;
            oc.beginPath();
            oc.arc(0, 0, rr, 0, Math.PI * 2);
            oc.strokeStyle = `rgba(0, 255, 127, ${0.08 + i * 0.02})`;
            oc.lineWidth = 1;
            oc.stroke();
        }

        oc.strokeStyle = 'rgba(0, 255, 127, 0.06)';
        oc.lineWidth = 1;
        oc.beginPath();
        oc.moveTo(-r, 0);
        oc.lineTo(r, 0);
        oc.moveTo(0, -r);
        oc.lineTo(0, r);
        oc.stroke();

        oc.font = CONFIG.RING_LABEL_FONT_SIZE + 'px ' + CONFIG.FONT_FAMILY;
        oc.textAlign = 'left';
        for (let j = 0; j < RING_LABELS.length; j++) {
            const rr = (r / CONFIG.RING_COUNT) * (j + 1);
            oc.fillStyle = 'rgba(0, 255, 127, 0.18)';
            oc.fillText(RING_LABELS[j], 4, -rr + 10);
        }

        oc.restore();
        this._offDirty = false;
    }

    _normalizeAngle(a) {
        while (a < 0) a += Math.PI * 2;
        while (a >= Math.PI * 2) a -= Math.PI * 2;
        return a;
    }

    _angleBetween(prev, curr, target) {
        const p = this._normalizeAngle(prev);
        const c = this._normalizeAngle(curr);
        const t = this._normalizeAngle(target);
        if (p <= c) return t >= p && t <= c;
        return t >= p || t <= c;
    }

    _drawFrame(now, delta) {
        if (this._offDirty) this._renderStaticBackground();
        this._ctx.drawImage(
            this._offCanvas, 0, 0,
            this._canvas.width, this._canvas.height,
            0, 0, this._w, this._h
        );
        this._drawBlips(now);
        this._drawSweep(now, delta);
    }

    _drawSweep(now, delta) {
        this._previousSweepAngle = this._sweepAngle;
        const sweepStep = CONFIG.SWEEP_SPEED * (delta / 16.667);
        this._sweepAngle += sweepStep;

        if (this._sweepAngle >= Math.PI * 2) {
            this._sweepAngle -= Math.PI * 2;
            this._scanCycleCount++;
            if (this._onScanCycle) {
                this._onScanCycle(this._scanCycleCount);
            }
        }

        for (let i = 0; i < this._blips.length; i++) {
            const b = this._blips[i];
            if (b.r <= 0) continue;
            if (this._angleBetween(this._previousSweepAngle, this._sweepAngle, b.theta)) {
                b.lastSwept = now;
            }
        }

        const ctx = this._ctx;
        const r = this._radius;

        ctx.save();
        ctx.translate(this._cx, this._cy);
        ctx.rotate(this._sweepAngle);

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, -CONFIG.SWEEP_TRAIL_ANGLE, 0);
        ctx.closePath();

        const tg = ctx.createLinearGradient(0, 0, r, 0);
        tg.addColorStop(0, 'rgba(0, 255, 127, 0.35)');
        tg.addColorStop(0.5, 'rgba(0, 255, 127, 0.12)');
        tg.addColorStop(1, 'rgba(0, 255, 127, 0.03)');
        ctx.fillStyle = tg;
        ctx.fill();

        const lg = ctx.createLinearGradient(0, 0, r, 0);
        lg.addColorStop(0, 'rgba(0, 255, 127, 0.85)');
        lg.addColorStop(0.5, 'rgba(0, 255, 127, 0.35)');
        lg.addColorStop(1, 'rgba(0, 255, 127, 0.08)');
        ctx.strokeStyle = lg;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(r, 0);
        ctx.stroke();

        ctx.restore();
    }

    _drawBlips(now) {
        const sweepPeriodMs = ((Math.PI * 2) / CONFIG.SWEEP_SPEED / 60) * 1000;
        const ctx = this._ctx;

        ctx.save();
        ctx.translate(this._cx, this._cy);

        for (let i = 0; i < this._blips.length; i++) {
            const b = this._blips[i];
            const x = Math.cos(b.theta) * b.r;
            const y = Math.sin(b.theta) * b.r;

            let alpha;
            if (b.r <= 0) {
                alpha = 1.0;
            } else {
                const timeSince = now - b.lastSwept;
                const decay = Math.min(timeSince / sweepPeriodMs, 1);
                const base = 0.4 + (b.intensity * 0.6);
                alpha = base * (1 - (decay * 0.92));
                alpha = Math.max(alpha, 0.04);
            }

            const rgb = REL_RGB[b.relationship] || REL_RGB.neutral;
            const isSel = (b.id === this._selectedBlipId);

            b.pulsePhase += CONFIG.PULSE_SPEED;
            const pulseScale = 1 + Math.sin(b.pulsePhase) * 0.08;

            const glowSize = (CONFIG.BLIP_GLOW_BASE + (alpha * CONFIG.BLIP_GLOW_INTENSITY)) * pulseScale;
            const ga = isSel ? Math.min(alpha * 1.5, 1) : alpha;

            const g = ctx.createRadialGradient(x, y, 0, x, y, glowSize);
            g.addColorStop(0, `rgba(${rgb}, ${ga})`);
            g.addColorStop(0.5, `rgba(${rgb}, ${ga * 0.3})`);
            g.addColorStop(1, `rgba(${rgb}, 0)`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            const cs = CONFIG.BLIP_CORE_MIN + (alpha * (CONFIG.BLIP_CORE_MAX - CONFIG.BLIP_CORE_MIN));
            ctx.fillStyle = `rgba(${rgb}, ${Math.min(alpha * 1.5, 1)})`;
            ctx.beginPath();
            ctx.arc(x, y, cs, 0, Math.PI * 2);
            ctx.fill();

            if (isSel) {
                ctx.strokeStyle = `rgba(${rgb}, ${0.5 + Math.sin(now / 300) * 0.3})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(x, y, glowSize + 4, 0, Math.PI * 2);
                ctx.stroke();
            }

            if (b.r > 5 && alpha > CONFIG.MIN_LABEL_ALPHA) {
                ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
                ctx.font = CONFIG.LABEL_FONT_SIZE + 'px ' + CONFIG.FONT_FAMILY;
                ctx.textAlign = 'center';
                ctx.fillText(b.label, x, y + glowSize + 10);
            }
        }

        ctx.restore();
    }

    _updateFps(now) {
        this._fpsFrames++;
        if (now - this._fpsLastTime >= 1000) {
            this._currentFps = this._fpsFrames;
            this._fpsFrames = 0;
            this._fpsLastTime = now;
            if (this._onFpsUpdate) {
                this._onFpsUpdate(this._currentFps);
            }
        }
    }

    _loop() {
        const now = performance.now();
        const delta = Math.min(now - this._lastFrameTime, CONFIG.DELTA_MAX_MS);
        this._drawFrame(now, delta);
        this._updateFps(now);
        this._lastFrameTime = now;
        this._animationId = requestAnimationFrame(() => this._loop());
    }

    _handleClick(e) {
        const rect = this._canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left - this._cx;
        const my = e.clientY - rect.top - this._cy;

        let closest = null;
        let closestDist = Infinity;

        for (let i = 0; i < this._blips.length; i++) {
            const b = this._blips[i];
            const bx = Math.cos(b.theta) * b.r;
            const by = Math.sin(b.theta) * b.r;
            const d = Math.sqrt((mx - bx) * (mx - bx) + (my - by) * (my - by));
            if (d < 30 && d < closestDist) {
                closest = b;
                closestDist = d;
            }
        }

        if (closest) {
            this.selectEntity(closest.id);
        } else {
            this.deselectEntity();
        }
    }

    /* ===== PUBLIC API ===== */

    start() {
        if (!this._animationId) {
            this._lastFrameTime = performance.now();
            this._fpsLastTime = performance.now();
            this._loop();
        }
    }

    stop() {
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
    }

    updateContacts(contacts) {
        const now = performance.now();
        const newBlips = [];

        for (let i = 0; i < contacts.length; i++) {
            const c = contacts[i];
            if (!c || typeof c.id !== 'string' || typeof c.distance !== 'number' || typeof c.angle !== 'number') {
                continue;
            }
            if (c.distance < 0 || c.distance > 1 || isNaN(c.distance) || isNaN(c.angle)) {
                continue;
            }

            let existing = null;
            for (let j = 0; j < this._blips.length; j++) {
                if (this._blips[j].id === c.id) { existing = this._blips[j]; break; }
            }

            newBlips.push({
                id: c.id,
                r: c.distance * this._radius,
                distanceRaw: c.distance,
                theta: (c.angle * Math.PI) / 180,
                intensity: typeof c.intensity === 'number' ? Math.max(0, Math.min(1, c.intensity)) : 0.5,
                label: c.name || c.id.slice(0, 7),
                lastSwept: existing ? existing.lastSwept : (now - 1000),
                pulsePhase: existing ? existing.pulsePhase : (Math.random() * Math.PI * 2),
                category: c.category || null,
                mood: c.mood || null,
                relationship: c.relationship || 'neutral',
                pad: c.pad || null,
            });
        }

        this._blips = newBlips;
    }

    selectEntity(id) {
        this._selectedBlipId = id;
        const blip = this._blips.find(b => b.id === id) || null;
        if (this._onEntitySelect && blip) {
            this._onEntitySelect(blip);
        }
    }

    deselectEntity() {
        this._selectedBlipId = null;
        if (this._onEntityDeselect) {
            this._onEntityDeselect();
        }
    }

    getBlips() {
        return this._blips.slice();
    }

    getScanCycleCount() {
        return this._scanCycleCount;
    }

    getFps() {
        return this._currentFps;
    }

    onScanCycle(callback) { this._onScanCycle = callback; }
    onEntitySelect(callback) { this._onEntitySelect = callback; }
    onEntityDeselect(callback) { this._onEntityDeselect = callback; }
    onFpsUpdate(callback) { this._onFpsUpdate = callback; }

    destroy() {
        this.stop();
        window.removeEventListener('resize', this._resizeHandler);
        if (this._canvas) {
            this._canvas.removeEventListener('click', this._clickHandler);
        }
        this._container.innerHTML = '';
        this._canvas = null;
        this._ctx = null;
        this._offCanvas = null;
        this._offCtx = null;
        this._blips = [];
    }
}

export default PsychicRadarCanvas;
export { REL_HEX, REL_RGB };
