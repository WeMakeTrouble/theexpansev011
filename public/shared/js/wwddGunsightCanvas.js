/**
 * ============================================================================
 * WWDD Gunsight Canvas — What Would Danique Do
 * File: public/shared/js/wwddGunsightCanvas.js
 * ============================================================================
 *
 * WHAT THIS IS:
 * ---------------------------------------------------------------------------
 * Canvas renderer for the WWDD Engine instrument.
 * Draws a vintage fighter-plane gunsight reflecting session outcome inference.
 *
 * Two constructs visualised:
 *   CLARITY   — How tight the lock is. Reticle ring shrinks as Clarity rises.
 *               Wide/scanning = warming. Tight/locked = surfacing.
 *
 *   ALIGNMENT — How centred the target is. Target marker drifts outward
 *               toward the dominant competing hypothesis when misaligned.
 *               Invisible when Clarity < 0.70 (null alignment state).
 *
 * THREE GAUGE STATES:
 *   warming   — Clarity < 0.70. Reticle rotates slowly. Target not shown.
 *               Six hypothesis zones visible but unlabelled. Scanning.
 *
 *   tracking  — Clarity >= 0.70. Reticle locks. Target appears.
 *               Active hypothesis label shown. Target drifts on misalignment.
 *
 *   surfacing — Clarity >= 0.85. Full lock. Target centred. Pulse animation.
 *               User may request outcome reveal.
 *
 * VISUAL LANGUAGE:
 *   - Amber/green phosphor on black (CRT aesthetic)
 *   - IBM Plex Mono + Orbitron fonts (matches system standard)
 *   - Scanlines overlay
 *   - No geographic concepts — no N S E W
 *   - Six hypothesis zones around perimeter (named in tracking/surfacing state)
 *   - Target drift = distance from centre (not directional compass)
 *
 * HYPOTHESIS ZONE LAYOUT (clock positions, no compass meaning):
 *   knowledge_seeking    — 12 o'clock
 *   emotional_processing — 2 o'clock
 *   exploration          — 4 o'clock
 *   social_connection    — 6 o'clock
 *   problem_resolution   — 8 o'clock
 *   creative_play        — 10 o'clock
 *
 * SINGLETON STATE:
 *   Last known WWDD state is preserved on canvas destroy.
 *   Restored immediately when canvas is recreated (panel displacement).
 *   State lives in the module — not in the class instance.
 *
 * USAGE:
 *   import WwddGunsightCanvas from '/shared/js/wwddGunsightCanvas.js';
 *   const canvas = new WwddGunsightCanvas(containerElement);
 *   canvas.start();
 *   canvas.update(wwddState);  // called on wwdd:update event
 *   canvas.destroy();
 *
 * ============================================================================
 * Project: The Expanse v010
 * ============================================================================
 */

/* ============================================================================
 * MODULE-LEVEL SINGLETON STATE
 * Survives canvas destroy/recreate (panel displacement pattern).
 * ============================================================================ */

let _persistedState = null;

/* ============================================================================
 * CONFIGURATION
 * ============================================================================ */

const CONFIG = Object.freeze({
    FONT_LABEL:       '"Orbitron", "IBM Plex Mono", monospace',
    FONT_MONO:        '"IBM Plex Mono", "SF Mono", "Consolas", monospace',
    DPR_MAX:          2,
    DELTA_MAX_MS:     100,

    // Colours
    COLOR_PRIMARY:    '#00ff7f',
    COLOR_AMBER:      '#ffaa00',
    COLOR_DIM:        'rgba(0, 255, 127, 0.35)',
    COLOR_FAINT:      'rgba(0, 255, 127, 0.12)',
    COLOR_TARGET:     '#ffaa00',
    COLOR_LOCK:       '#00ff7f',

    // Reticle geometry
    RETICLE_OUTER:    0.82,   // fraction of canvas radius
    RETICLE_INNER:    0.38,   // fraction when fully locked
    RETICLE_GAP:      0.12,   // crosshair gap fraction

    // Animation
    ROTATE_SPEED:     0.004,  // radians per frame (warming state)
    PULSE_SPEED:      0.04,   // radians per frame (surfacing pulse)
    TARGET_LERP:      0.06,   // target position interpolation speed

    // Clarity/alignment thresholds (match WwddEngine CONFIG)
    CLARITY_DISPLAY:  0.70,
    CLARITY_SURFACE:  0.85,
});

/* ============================================================================
 * HYPOTHESIS ZONE DEFINITIONS
 * Clock positions — no compass meaning.
 * ============================================================================ */

const HYPOTHESIS_ZONES = Object.freeze([
    { id: 'knowledge_seeking',    label: 'Knowledge',  angle: -Math.PI / 2 },           // 12
    { id: 'emotional_processing', label: 'Emotional',  angle: -Math.PI / 2 + Math.PI / 3 },   // 2
    { id: 'exploration',          label: 'Explore',    angle: -Math.PI / 2 + 2 * Math.PI / 3 }, // 4
    { id: 'social_connection',    label: 'Social',     angle: Math.PI / 2 },             // 6
    { id: 'problem_resolution',   label: 'Problem',    angle: Math.PI / 2 + Math.PI / 3 }, // 8
    { id: 'creative_play',        label: 'Creative',   angle: Math.PI / 2 + 2 * Math.PI / 3 }  // 10
]);

/* ============================================================================
 * CANVAS CLASS
 * ============================================================================ */

class WwddGunsightCanvas {

    /**
     * @param {HTMLElement} container - Element to mount canvas into
     */
    constructor(container) {
        this._container  = container;
        this._canvas     = null;
        this._ctx        = null;
        this._animId     = null;
        this._lastFrame  = 0;
        this._destroyed  = false;

        // Animation state
        this._rotAngle   = 0;    // warming rotation
        this._pulseAngle = 0;    // surfacing pulse

        // Target position (lerped toward computed position)
        this._targetX    = 0;
        this._targetY    = 0;

        // Current WWDD state
        this._state      = _persistedState ? { ..._persistedState } : null;

        this._build();
    }

    /* ========================================================================
     * BUILD
     * ======================================================================== */

    _build() {
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'width:100%;height:100%;display:block;';
        this._ctx = this._canvas.getContext('2d', { desynchronized: true });
        this._container.appendChild(this._canvas);
        this._resize();
        window.addEventListener('resize', this._onResize.bind(this));
    }

    _resize() {
        const rect = this._container.getBoundingClientRect();
        const size = Math.min(rect.width, rect.height) || 200;
        const dpr  = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_MAX);
        this._canvas.width  = Math.floor(size * dpr);
        this._canvas.height = Math.floor(size * dpr);
        this._canvas.style.width  = size + 'px';
        this._canvas.style.height = size + 'px';
        this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._size   = size;
        this._cx     = size / 2;
        this._cy     = size / 2;
        this._radius = size * 0.44;
    }

    _onResize() {
        if (this._destroyed) return;
        this._resize();
    }

    /* ========================================================================
     * PUBLIC API
     * ======================================================================== */

    start() {
        if (this._animId) return;
        this._lastFrame = performance.now();
        this._loop();
    }

    /**
     * Update canvas with new WWDD state from socket event.
     * @param {Object} state - wwdd_update payload
     */
    update(state) {
        if (!state || typeof state !== 'object') return;
        this._state   = state;
        _persistedState = { ...state };
    }

    destroy() {
        this._destroyed = true;
        if (this._animId) {
            cancelAnimationFrame(this._animId);
            this._animId = null;
        }
        window.removeEventListener('resize', this._onResize.bind(this));
        if (this._canvas && this._canvas.parentNode) {
            this._canvas.parentNode.removeChild(this._canvas);
        }
        this._canvas = null;
        this._ctx    = null;
    }

    /* ========================================================================
     * ANIMATION LOOP
     * ======================================================================== */

    _loop() {
        if (this._destroyed) return;
        const now   = performance.now();
        const delta = Math.min(now - this._lastFrame, CONFIG.DELTA_MAX_MS);
        this._lastFrame = now;
        this._tick(delta);
        this._draw();
        this._animId = requestAnimationFrame(this._loop.bind(this));
    }

    _tick(delta) {
        const scale = delta / 16.667;
        const gaugeState = this._state?.gaugeState ?? 'warming';

        if (gaugeState === 'warming') {
            this._rotAngle += CONFIG.ROTATE_SPEED * scale;
            if (this._rotAngle >= Math.PI * 2) this._rotAngle -= Math.PI * 2;
        }

        if (gaugeState === 'surfacing') {
            this._pulseAngle += CONFIG.PULSE_SPEED * scale;
        }

        // Lerp target toward computed position
        const { tx, ty } = this._computeTargetPosition();
        this._targetX += (tx - this._targetX) * CONFIG.TARGET_LERP;
        this._targetY += (ty - this._targetY) * CONFIG.TARGET_LERP;
    }

    /**
     * Compute where the target marker should sit.
     * Centre (0,0) = perfect alignment.
     * Drifts outward toward dominant competing hypothesis when misaligned.
     *
     * @returns {{ tx: number, ty: number }} in canvas coordinates relative to centre
     */
    _computeTargetPosition() {
        const state = this._state;
        if (!state || state.gaugeState === 'warming' || state.alignment === null) {
            return { tx: 0, ty: 0 };
        }

        const alignment  = state.alignment ?? 1;
        const hypotheses = state.hypotheses ?? {};
        const activeId   = state.activeHypothesis;

        // Find the dominant competing hypothesis (highest score that is NOT active)
        let competeId    = null;
        let competeScore = 0;
        for (const [id, score] of Object.entries(hypotheses)) {
            if (id !== activeId && score > competeScore) {
                competeScore = score;
                competeId    = id;
            }
        }

        if (!competeId) return { tx: 0, ty: 0 };

        // Find zone angle for competing hypothesis
        const zone = HYPOTHESIS_ZONES.find(z => z.id === competeId);
        if (!zone) return { tx: 0, ty: 0 };

        // Drift distance = (1 - alignment) * fraction of radius
        const driftFraction = (1 - alignment) * 0.45;
        const driftDist     = driftFraction * this._radius;

        return {
            tx: Math.cos(zone.angle) * driftDist,
            ty: Math.sin(zone.angle) * driftDist
        };
    }

    /* ========================================================================
     * DRAWING
     * ======================================================================== */

    _draw() {
        const ctx   = this._ctx;
        const cx    = this._cx;
        const cy    = this._cy;
        const r     = this._radius;
        const state = this._state;
        const gauge = state?.gaugeState ?? 'warming';
        const clarity   = state?.clarity   ?? 0;
        const alignment = state?.alignment ?? null;

        // Clear
        ctx.clearRect(0, 0, this._size, this._size);

        // Background circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.02, 0, Math.PI * 2);
        const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        bg.addColorStop(0, 'rgba(0, 20, 10, 1)');
        bg.addColorStop(1, 'rgba(0, 4, 2, 1)');
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.restore();

        // Draw layers
        this._drawScanlines();
        this._drawZoneRings(gauge, clarity);
        this._drawHypothesisZones(gauge, state);
        this._drawReticle(gauge, clarity);
        this._drawCrosshair(gauge);
        this._drawTarget(gauge, alignment);
        this._drawReadouts(gauge, clarity, alignment, state);
        this._drawNameplate();
    }

    _drawScanlines() {
        const ctx = this._ctx;
        ctx.save();
        ctx.globalAlpha = 0.15;
        for (let y = 0; y < this._size; y += 2) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(0, y, this._size, 1);
        }
        ctx.restore();
    }

    _drawZoneRings(gauge, clarity) {
        const ctx = this._ctx;
        const cx  = this._cx;
        const cy  = this._cy;
        const r   = this._radius;

        ctx.save();
        // Outer boundary ring
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = CONFIG.COLOR_DIM;
        ctx.lineWidth   = 1;
        ctx.stroke();

        // Inner range ring — shrinks as clarity rises
        const innerFrac = CONFIG.RETICLE_OUTER - (clarity * (CONFIG.RETICLE_OUTER - CONFIG.RETICLE_INNER));
        const innerR    = r * innerFrac;
        ctx.beginPath();
        ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
        ctx.strokeStyle = gauge === 'surfacing'
            ? CONFIG.COLOR_PRIMARY
            : CONFIG.COLOR_DIM;
        ctx.lineWidth   = gauge === 'surfacing' ? 1.5 : 1;
        ctx.stroke();

        ctx.restore();
    }

    _drawHypothesisZones(gauge, state) {
        const ctx    = this._ctx;
        const cx     = this._cx;
        const cy     = this._cy;
        const r      = this._radius;
        const active = state?.activeHypothesis;

        ctx.save();

        HYPOTHESIS_ZONES.forEach(zone => {
            const isActive  = zone.id === active;
            const labelDist = r * 0.91;
            const lx = cx + Math.cos(zone.angle) * labelDist;
            const ly = cy + Math.sin(zone.angle) * labelDist;

            // Zone tick mark
            const tickInner = r * 0.78;
            const tickOuter = r * 0.88;
            const tx1 = cx + Math.cos(zone.angle) * tickInner;
            const ty1 = cy + Math.sin(zone.angle) * tickInner;
            const tx2 = cx + Math.cos(zone.angle) * tickOuter;
            const ty2 = cy + Math.sin(zone.angle) * tickOuter;

            ctx.beginPath();
            ctx.moveTo(tx1, ty1);
            ctx.lineTo(tx2, ty2);
            ctx.strokeStyle = isActive && gauge !== 'warming'
                ? CONFIG.COLOR_PRIMARY
                : CONFIG.COLOR_FAINT;
            ctx.lineWidth = isActive && gauge !== 'warming' ? 2 : 1;
            ctx.stroke();

            // Zone label — only in tracking/surfacing
            if (gauge !== 'warming') {
                ctx.font      = '8px ' + CONFIG.FONT_LABEL;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = isActive
                    ? CONFIG.COLOR_PRIMARY
                    : 'rgba(0, 255, 127, 0.25)';
                ctx.fillText(zone.label.toUpperCase(), lx, ly);
            }
        });

        ctx.restore();
    }

    _drawReticle(gauge, clarity) {
        const ctx = this._ctx;
        const cx  = this._cx;
        const cy  = this._cy;
        const r   = this._radius;

        const innerFrac = CONFIG.RETICLE_OUTER - (clarity * (CONFIG.RETICLE_OUTER - CONFIG.RETICLE_INNER));
        const reticleR  = r * innerFrac;

        ctx.save();
        ctx.translate(cx, cy);

        // Rotate in warming state
        if (gauge === 'warming') {
            ctx.rotate(this._rotAngle);
        }

        // Draw four reticle arcs with gaps at crosshair positions
        const gapAngle = Math.PI * 0.18;
        const arcs = [
            { start: gapAngle,            end: Math.PI / 2 - gapAngle },
            { start: Math.PI / 2 + gapAngle, end: Math.PI - gapAngle },
            { start: Math.PI + gapAngle,  end: 3 * Math.PI / 2 - gapAngle },
            { start: 3 * Math.PI / 2 + gapAngle, end: 2 * Math.PI - gapAngle }
        ];

        const alpha = gauge === 'surfacing'
            ? 0.9 + Math.sin(this._pulseAngle) * 0.1
            : 0.6;

        arcs.forEach(arc => {
            ctx.beginPath();
            ctx.arc(0, 0, reticleR, arc.start, arc.end);
            ctx.strokeStyle = gauge === 'surfacing'
                ? `rgba(0, 255, 127, ${alpha})`
                : CONFIG.COLOR_DIM;
            ctx.lineWidth   = gauge === 'surfacing' ? 2 : 1.5;
            ctx.stroke();
        });

        ctx.restore();
    }

    _drawCrosshair(gauge) {
        const ctx = this._ctx;
        const cx  = this._cx;
        const cy  = this._cy;
        const r   = this._radius;
        const gap = r * CONFIG.RETICLE_GAP;

        ctx.save();
        ctx.strokeStyle = gauge === 'warming' ? CONFIG.COLOR_FAINT : CONFIG.COLOR_DIM;
        ctx.lineWidth   = 1;

        // Horizontal
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.75, cy);
        ctx.lineTo(cx - gap, cy);
        ctx.moveTo(cx + gap, cy);
        ctx.lineTo(cx + r * 0.75, cy);
        ctx.stroke();

        // Vertical
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.75);
        ctx.lineTo(cx, cy - gap);
        ctx.moveTo(cx, cy + gap);
        ctx.lineTo(cx, cy + r * 0.75);
        ctx.stroke();

        // Centre dot
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fillStyle = gauge === 'warming'
            ? CONFIG.COLOR_FAINT
            : CONFIG.COLOR_PRIMARY;
        ctx.fill();

        ctx.restore();
    }

    _drawTarget(gauge, alignment) {
        if (gauge === 'warming' || alignment === null) return;

        const ctx = this._ctx;
        const cx  = this._cx + this._targetX;
        const cy  = this._cy + this._targetY;
        const s   = 8; // target marker half-size

        const alpha = gauge === 'surfacing'
            ? 0.9 + Math.sin(this._pulseAngle) * 0.1
            : 0.75;

        ctx.save();
        ctx.strokeStyle = `rgba(255, 170, 0, ${alpha})`;
        ctx.lineWidth   = 1.5;

        // Diamond target marker
        ctx.beginPath();
        ctx.moveTo(cx,     cy - s);
        ctx.lineTo(cx + s, cy);
        ctx.lineTo(cx,     cy + s);
        ctx.lineTo(cx - s, cy);
        ctx.closePath();
        ctx.stroke();

        // Inner dot
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 170, 0, ${alpha})`;
        ctx.fill();

        // Surfacing: lock brackets
        if (gauge === 'surfacing') {
            const lb = s + 6;
            ctx.strokeStyle = `rgba(0, 255, 127, ${alpha})`;
            ctx.lineWidth   = 1;
            const bLen = 5;
            // Top-left
            ctx.beginPath();
            ctx.moveTo(cx - lb, cy - lb + bLen);
            ctx.lineTo(cx - lb, cy - lb);
            ctx.lineTo(cx - lb + bLen, cy - lb);
            ctx.stroke();
            // Top-right
            ctx.beginPath();
            ctx.moveTo(cx + lb - bLen, cy - lb);
            ctx.lineTo(cx + lb, cy - lb);
            ctx.lineTo(cx + lb, cy - lb + bLen);
            ctx.stroke();
            // Bottom-right
            ctx.beginPath();
            ctx.moveTo(cx + lb, cy + lb - bLen);
            ctx.lineTo(cx + lb, cy + lb);
            ctx.lineTo(cx + lb - bLen, cy + lb);
            ctx.stroke();
            // Bottom-left
            ctx.beginPath();
            ctx.moveTo(cx - lb + bLen, cy + lb);
            ctx.lineTo(cx - lb, cy + lb);
            ctx.lineTo(cx - lb, cy + lb - bLen);
            ctx.stroke();
        }

        ctx.restore();
    }

    _drawReadouts(gauge, clarity, alignment, state) {
        const ctx = this._ctx;
        const s   = this._size;

        ctx.save();
        ctx.font      = '9px ' + CONFIG.FONT_MONO;
        ctx.textBaseline = 'top';

        // Clarity — top left
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0, 255, 127, 0.5)';
        ctx.fillText('CLR', 8, 8);
        ctx.fillStyle = CONFIG.COLOR_PRIMARY;
        ctx.fillText((clarity * 100).toFixed(0).padStart(3, ' ') + '%', 8, 18);

        // Alignment — top right
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(0, 255, 127, 0.5)';
        ctx.fillText('ALN', s - 8, 8);
        ctx.fillStyle = alignment !== null ? CONFIG.COLOR_AMBER : 'rgba(0,255,127,0.25)';
        ctx.fillText(
            alignment !== null ? (alignment * 100).toFixed(0).padStart(3, ' ') + '%' : ' --',
            s - 8, 18
        );

        // Gauge state — bottom centre
        ctx.textAlign = 'center';
        const stateLabel = gauge === 'warming'
            ? 'SCANNING'
            : gauge === 'tracking'
                ? 'TRACKING'
                : 'LOCKED';
        ctx.fillStyle = gauge === 'surfacing'
            ? CONFIG.COLOR_PRIMARY
            : 'rgba(0, 255, 127, 0.4)';
        ctx.font = '8px ' + CONFIG.FONT_LABEL;
        ctx.fillText(stateLabel, s / 2, s - 18);

        // Turn count — bottom right
        if (state?.turnCount != null) {
            ctx.textAlign    = 'right';
            ctx.font         = '8px ' + CONFIG.FONT_MONO;
            ctx.fillStyle    = 'rgba(0, 255, 127, 0.3)';
            ctx.fillText('T' + state.turnCount, s - 8, s - 18);
        }

        ctx.restore();
    }

    _drawNameplate() {
        const ctx = this._ctx;
        const s   = this._size;

        ctx.save();
        ctx.font      = '7px ' + CONFIG.FONT_LABEL;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(0, 255, 127, 0.2)';
        ctx.fillText('WWDD', s / 2, s - 4);
        ctx.restore();
    }
}

export default WwddGunsightCanvas;
