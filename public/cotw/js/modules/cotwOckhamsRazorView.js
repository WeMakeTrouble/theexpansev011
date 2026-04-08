/**
 * ============================================================================
 * Ockham's Razor View — CMS Admin Panel Integration
 * File: public/cms/js/modules/ockhamsRazorView.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Renders the Ockham's Razor diagnostic instrument across two CMS panels:
 *   - BOTTOM PANEL: Compact instrument strip (gauges, LEDs, readouts)
 *   - RIGHT PANEL:  Controls + CRT diagnostic display (verdict, hypotheses)
 *
 * Styles live in public/cms/css/ockhamsRazorView.css (CSP compliant).
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 9b — Ockham's Razor Diagnostic
 * ============================================================================
 */

import viewController from '../cotwViewController.js';

const PANEL_ID = 'panel-bottom';

const TEMPLATE_LABELS = {
    PAD_DIRECT: 'Direct PAD Assignment',
    PROX_CONTAGION: 'Proximity Contagion',
    TRANSITIVE_CONTAGION: 'Chain Contagion',
    IKIGAI_DRAIN: 'Ikigai Need Drain',
    IKIGAI_DIVERSITY_COLLAPSE: 'Ikigai Diversity Collapse',
    MOAI_WEAKEN: 'Bond Weakening',
    OCEAN_FACET_VULN: 'Personality Vulnerability',
    PAD_DECAY_BASELINE: 'Baseline Drift',
    COMPOUND_2WAY: 'Compound (2-way)',
};

let charMap = {};
let razorActive = false;

function cn(id) { return charMap[id] || id; }
function tl(id) { return TEMPLATE_LABELS[id] || id; }
function rh(t) { return t.replace(/#[0-9A-Fa-f]{6}/g, m => cn(m)); }

function flatEv(obj, pfx) {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        const lbl = pfx ? pfx + '.' + k : k;
        if (v === null || v === undefined) continue;
        if (typeof v === 'object' && !Array.isArray(v)) { out.push(...flatEv(v, lbl)); }
        else {
            let d = v;
            if (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v)) d = cn(v);
            if (typeof v === 'number') d = Number.isInteger(v) ? v : v.toFixed(4);
            out.push([lbl, d]);
        }
    }
    return out;
}

function _getBottomPanel() { return document.getElementById(PANEL_ID); }
function _getBottomBody() {
    const p = _getBottomPanel();
    if (!p) return null;
    return p.querySelector('.panel__body') || p;
}
function _showBottomPanel() {
    const p = _getBottomPanel();
    if (p) p.removeAttribute('hidden');
}
function _hideBottomPanel() {
    const p = _getBottomPanel();
    if (p) p.setAttribute('hidden', '');
}

async function fetchCharacters(signal) {
    const res = await fetch('/api/admin/characters', { signal });
    const data = await res.json();
    if (!data.success) return [];
    return (data.characters || []).filter(c => c.is_active !== false);
}

async function runEvaluation(body, signal) {
    const res = await fetch('/api/user/razor/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
    });
    return res.json();
}

function setNeedle(el, frac) {
    el.style.setProperty('--needle-angle', (-55 + frac * 110) + 'deg');
}

function setLed(el, cls) {
    el.className = 'rz-led';
    if (cls) el.classList.add(cls);
}

/* =========================================================================
 * BOTTOM PANEL — Compact instrument strip: gauges + LEDs + readouts
 * ========================================================================= */

function buildInstrumentHTML() {
    return '<div class="rz-strip">' +
        '<div class="rz-strip-nameplate"><span>OCKHAMS RAZOR ENGINE</span></div>' +
        '<div class="rz-strip-row">' +
            '<div class="rz-strip-gauges">' +
                buildGauge('rz-sps', 'SPS', 'Score', true) +
                buildGauge('rz-fit', 'Fit', '%', true) +
                buildGauge('rz-conf', 'Conf', '%', false) +
            '</div>' +
            '<div class="rz-strip-leds">' +
                '<div class="rz-strip-ledgroup">' +
                    '<div class="rz-strip-ledtitle">Status</div>' +
                    '<div class="rz-strip-ledrow">' +
                        buildLed('rzLedL1', 'L1') + buildLed('rzLedL2', 'L2') +
                        buildLed('rzLedConsist', 'Con') +
                    '</div>' +
                '</div>' +
                '<div class="rz-strip-ledgroup">' +
                    '<div class="rz-strip-ledtitle">Alerts</div>' +
                    '<div class="rz-strip-ledrow">' +
                        buildLed('rzLedAnomaly', 'Anom') + buildLed('rzLedError', 'Err') +
                    '</div>' +
                '</div>' +
                '<div class="rz-strip-ledgroup">' +
                    '<div class="rz-strip-ledtitle">Data</div>' +
                    '<div class="rz-strip-ledrow">' +
                        buildLed('rzLedPad', 'PAD') + buildLed('rzLedProx', 'Prx') +
                        buildLed('rzLedIkigai', 'Iki') + buildLed('rzLedOcean', 'OCN') +
                        buildLed('rzLedBase', 'Bas') + buildLed('rzLedBeats', 'Bts') +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="rz-strip-readouts">' +
                buildReadout('Arbitration', [
                    ['Source', 'rzArbSrc'], ['Consist', 'rzArbCon'], ['Conf', 'rzArbConf']
                ]) +
                buildReadout('Anomaly', [
                    ['Status', 'rzAnomStat'], ['Conds', 'rzAnomCnt'],
                    ['Fit', 'rzAnomFit'], ['Race', 'rzAnomRace']
                ]) +
                buildReadout('Metrics', [
                    ['Time', 'rzDur'], ['Hyps', 'rzTotal'],
                    ['Simple', 'rzSimple'], ['Comp', 'rzCompound']
                ]) +
            '</div>' +
        '</div>' +
    '</div>';
}

/* =========================================================================
 * RIGHT PANEL — Controls + CRT diagnostic display
 * ========================================================================= */

function buildControlsHTML(characters) {
    const charOpts = characters.map(c =>
        '<option value="' + c.character_id + '">' + c.character_name + ' (' + c.character_id + ')</option>'
    ).join('');

    return '<div class="rz-right">' +
        '<div class="rz-controls">' +
            '<div class="rz-ctrl-title">Occam&#39;s Razor Engine</div>' +
            '<div class="rz-ctrl-field"><label class="rz-ctrl-label">Character</label>' +
                '<select class="rz-ctrl-input rz-ctrl-wide" id="rzChar">' + charOpts + '</select></div>' +
            '<div class="rz-ctrl-field"><label class="rz-ctrl-label">Dimension</label>' +
                '<select class="rz-ctrl-input" id="rzDim"><option value="PLEASURE">Pleasure</option>' +
                '<option value="AROUSAL">Arousal</option><option value="DOMINANCE">Dominance</option></select></div>' +
            '<div class="rz-ctrl-row">' +
                '<div class="rz-ctrl-field"><label class="rz-ctrl-label">Old Value</label>' +
                    '<input class="rz-ctrl-input rz-ctrl-num" id="rzOld" type="number" step="0.001" min="-1" max="1" value="0.017"></div>' +
                '<div class="rz-ctrl-field"><label class="rz-ctrl-label">New Value</label>' +
                    '<input class="rz-ctrl-input rz-ctrl-num" id="rzNew" type="number" step="0.001" min="-1" max="1" value="-0.300"></div>' +
            '</div>' +
            '<div class="rz-ctrl-field"><label class="rz-ctrl-label">Belt Level</label>' +
                '<select class="rz-ctrl-input" id="rzBelt"><option value="WHITE">White</option>' +
                '<option value="YELLOW">Yellow</option><option value="ORANGE">Orange</option>' +
                '<option value="GREEN" selected>Green</option><option value="BLUE">Blue</option>' +
                '<option value="PURPLE">Purple</option><option value="BLACK">Black</option></select></div>' +
            '<button class="rz-ctrl-btn" id="rzEval">Evaluate</button>' +
        '</div>' +
        '<div class="rz-crt">' +
            '<div class="rz-scanlines"></div><div class="rz-vignette"></div>' +
            '<div class="rz-crt-inner" id="rzCrt">' +
                '<div class="rz-crt-bar"><span class="rz-crt-title">Diagnostic</span>' +
                '<span class="rz-badge rz-badge-ready" id="rzBadge">Ready</span></div>' +
                '<div class="rz-empty">Select character and press evaluate</div>' +
            '</div>' +
        '</div>' +
    '</div>';
}

/* =========================================================================
 * Shared builders
 * ========================================================================= */

function buildGauge(prefix, label, unit, large) {
    const cls = large ? 'rz-gauge rz-gauge-lg' : 'rz-gauge rz-gauge-sm';
    return '<div class="' + cls + '"><div class="rz-gbezel"><div class="rz-ginner">' +
        '<div class="rz-garc"></div>' +
        '<div class="rz-glabel">' + label + '</div>' +
        '<div class="rz-greading" id="' + prefix + 'Val">--</div>' +
        '<div class="rz-gunit">' + unit + '</div>' +
        '<div class="rz-gneedle" id="' + prefix + 'N"></div>' +
        '<div class="rz-gpivot"></div>' +
    '</div></div></div>';
}

function buildLed(id, label) {
    return '<div class="rz-indicator"><div class="rz-led" id="' + id + '"></div>' +
        '<span class="rz-ledlabel">' + label + '</span></div>';
}

function buildReadout(title, rows) {
    let html = '<div class="rz-readout"><div class="rz-rtitle">' + title + '</div>';
    rows.forEach(([label, id]) => {
        html += '<div class="rz-rrow"><span class="rz-rkey">' + label + '</span>' +
            '<span class="rz-rval" id="' + id + '">--</span></div>';
    });
    return html + '</div>';
}

/* =========================================================================
 * Data update + hypothesis rendering
 * ========================================================================= */

function updateAll(d) {
    const $ = id => document.getElementById(id);

    if (d.winner) {
        $('rz-spsVal').textContent = d.winner.spsScore.toFixed(1);
        setNeedle($('rz-spsN'), Math.min(d.winner.spsScore / 20, 1));
        $('rz-fitVal').textContent = Math.round(d.winner.fit * 100);
        setNeedle($('rz-fitN'), d.winner.fit);
        const conf = d.arbitration ? d.arbitration.confidence : 0;
        $('rz-confVal').textContent = Math.round(conf * 100);
        setNeedle($('rz-confN'), conf);
    }

    const a = d.arbitration || {}, av = d.context ? d.context.availability : {}, er = d.context ? d.context.errors : {};
    setLed($('rzLedL1'), a.source && a.source.includes('L1') ? 'rz-on-green' : '');
    setLed($('rzLedL2'), a.source && (a.source.includes('L2') || a.source === 'L1+L2') ? 'rz-on-green' : '');
    if (a.consistency === 'consistent') setLed($('rzLedConsist'), 'rz-on-green');
    else if (a.consistency === 'contradictory') setLed($('rzLedConsist'), 'rz-on-red');
    else setLed($('rzLedConsist'), '');
    setLed($('rzLedAnomaly'), d.anomaly && d.anomaly.isAnomaly ? 'rz-on-red' : '');
    setLed($('rzLedError'), er.hasAnyError ? 'rz-on-red' : '');
    setLed($('rzLedPad'), av.hasPadHistory ? 'rz-on-green' : '');
    setLed($('rzLedProx'), av.hasProximity ? 'rz-on-green' : '');
    setLed($('rzLedIkigai'), av.hasIkigaiNeeds ? 'rz-on-green' : '');
    setLed($('rzLedOcean'), av.hasOceanFacets ? 'rz-on-green' : '');
    setLed($('rzLedBase'), av.hasPadBaseline ? 'rz-on-green' : '');
    setLed($('rzLedBeats'), av.hasRecentBeats ? 'rz-on-green' : '');

    $('rzArbSrc').textContent = a.source || '--';
    $('rzArbCon').textContent = a.consistency ? a.consistency.toUpperCase() : '--';
    $('rzArbConf').textContent = a.confidence != null ? Math.round(a.confidence * 100) + '%' : '--';

    const an = d.anomaly || {}, co = an.conditions || {};
    $('rzAnomStat').textContent = an.isAnomaly ? 'ANOMALY' : 'CLEAR';
    $('rzAnomStat').className = 'rz-rval ' + (an.isAnomaly ? 'rz-miss' : 'rz-ok');
    $('rzAnomCnt').textContent = an.conditionCount != null ? an.conditionCount + '/4' : '--';
    $('rzAnomFit').textContent = co.poorFit != null ? (co.poorFit ? 'YES' : 'NO') : '--';
    $('rzAnomRace').textContent = co.closeRace != null ? (co.closeRace ? 'YES' : 'NO') : '--';

    $('rzDur').textContent = d.durationMs != null ? d.durationMs + 'ms' : '--';
    $('rzTotal').textContent = d.hypothesisCount != null ? d.hypothesisCount : '--';
    $('rzSimple').textContent = d.simpleCount != null ? d.simpleCount : '--';
    $('rzCompound').textContent = d.compoundCount != null ? d.compoundCount : '--';

    renderHypotheses(d);
}

function renderHypotheses(d) {
    const crt = document.getElementById('rzCrt');
    const bar = crt.querySelector('.rz-crt-bar');
    while (crt.lastChild !== bar) crt.removeChild(crt.lastChild);

    if (!d.success) {
        crt.insertAdjacentHTML('beforeend', '<div class="rz-empty">ERROR: ' + (d.error || 'Unknown') + '</div>');
        return;
    }
    if (d.hypothesisCount === 0) {
        crt.insertAdjacentHTML('beforeend', '<div class="rz-empty">No hypotheses generated</div>');
        return;
    }

    const w = d.winner, wid = w ? w.hypothesis.templateId : null;
    let h = '';

    if (d.anomaly && d.anomaly.isAnomaly) {
        h += '<div class="rz-anomaly-bar">' + d.anomaly.recommendation + '</div>';
    }

    if (w) {
        h += '<div class="rz-verdict"><div class="rz-vtag">Verdict</div>' +
            '<div class="rz-vtitle">' + tl(w.hypothesis.templateId) + '</div>' +
            '<div class="rz-vdesc">' + rh(w.hypothesis.description || '') + '</div>' +
            '<div class="rz-vnums"><span class="rz-nsps">SPS ' + w.spsScore.toFixed(1) + '</span>' +
            '<span class="rz-nfit">FIT ' + Math.round(w.fit * 100) + '%</span>' +
            '<span class="rz-nlayer">' + (w.hypothesis.layer || '') + '</span></div></div>';
    }

    h += '<div class="rz-hyplist">';
    d.ranked.forEach((item, i) => {
        const isW = item.hypothesis.templateId === wid;
        const hy = item.hypothesis, c = item.components;
        let det = '<div class="rz-hypdetail">';
        det += '<div class="rz-detsec"><div class="rz-dethead">Causal Chain</div>';
        if (hy.causalChain && hy.causalChain.length) {
            hy.causalChain.forEach(lk => {
                const src = cn(lk.source) !== lk.source ? cn(lk.source) : lk.source;
                const ts = lk.timestamp ? ' @ ' + new Date(lk.timestamp).toLocaleString() : '';
                det += '<div class="rz-chain">' + src + ts + '</div>';
            });
        }
        det += '</div>';
        det += '<div class="rz-detsec"><div class="rz-dethead">Mechanisms</div>';
        (hy.mechanisms || []).forEach(m => { det += '<div class="rz-evline">' + m + '</div>'; });
        det += '</div>';
        if (hy.assumptions && hy.assumptions.length) {
            det += '<div class="rz-detsec"><div class="rz-dethead">Assumptions</div>';
            hy.assumptions.forEach(a => { det += '<div class="rz-evline rz-warn">' + a + '</div>'; });
            det += '</div>';
        }
        det += '<div class="rz-detsec"><div class="rz-dethead">Evidence</div>';
        if (hy.evidence) flatEv(hy.evidence).forEach(([k, v]) => {
            det += '<div class="rz-evline"><span class="rz-evkey">' + k + ':</span> ' + v + '</div>';
        });
        det += '</div>';
        det += '<div class="rz-detsec"><div class="rz-dethead">SPS Breakdown</div>';
        det += '<div class="rz-evline"><span class="rz-evkey">Links:</span> ' + c.links.count + ' (wt ' + c.links.weighted + ')</div>';
        det += '<div class="rz-evline"><span class="rz-evkey">Mechanisms:</span> ' + c.mechanisms.count + ' (wt ' + c.mechanisms.weighted + ')</div>';
        det += '<div class="rz-evline"><span class="rz-evkey">Assumptions:</span> ' + c.assumptions.count + ' (wt ' + c.assumptions.weighted + ')</div>';
        det += '<div class="rz-evline"><span class="rz-evkey">Fit penalty:</span> ' + c.fit.penalty + ' (score ' + c.fit.score + ')</div>';
        det += '</div></div>';

        h += '<div class="rz-hyprow ' + (isW ? 'rz-winner' : '') + '">' +
            '<div class="rz-hyphead"><span class="rz-hyprank">' + (i + 1) + '</span>' +
            '<span class="rz-hypname">' + tl(hy.templateId) + '</span>' +
            '<span class="rz-hyplayer">' + hy.layer + '</span></div>' +
            '<div class="rz-hypdesc">' + rh(hy.description || '') + '</div>' +
            '<div class="rz-hypstats"><span class="rz-nsps">SPS ' + item.spsScore.toFixed(1) + '</span>' +
            '<span class="rz-nfit">FIT ' + Math.round(item.fit * 100) + '%</span>' +
            '<span>LINKS ' + c.links.count + '</span><span>MECH ' + c.mechanisms.count + '</span></div>' +
            det + '</div>';
    });
    h += '</div>';
    crt.insertAdjacentHTML('beforeend', h);
    crt.querySelectorAll('.rz-hyprow').forEach(r => r.addEventListener('click', () => r.classList.toggle('rz-expanded')));
}

/* =========================================================================
 * Lifecycle
 * ========================================================================= */

function closeRazor() {
    const body = _getBottomBody();
    if (body) body.innerHTML = '';
    _hideBottomPanel();
    razorActive = false;
}

viewController.register('ockhams-razor', async (ctx) => {
    const characters = await fetchCharacters(ctx.signal);
    charMap = {};
    characters.forEach(c => { charMap[c.character_id] = c.character_name; });

    const body = _getBottomBody();
    if (!body) {
        ctx.container.innerHTML = '<div class="tool-placeholder"><div class="tool-placeholder__text">Bottom panel not found</div></div>';
        return;
    }

    _showBottomPanel();
    body.innerHTML = buildInstrumentHTML();
    razorActive = true;

    ctx.container.innerHTML = buildControlsHTML(characters);

    const badge = document.getElementById('rzBadge');
    const btn = document.getElementById('rzEval');

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        badge.textContent = 'Evaluating';
        badge.className = 'rz-badge rz-badge-run';

        const crt = document.getElementById('rzCrt');
        const bar = crt.querySelector('.rz-crt-bar');
        while (crt.lastChild !== bar) crt.removeChild(crt.lastChild);
        crt.insertAdjacentHTML('beforeend', '<div class="rz-empty">Gathering context...</div>');

        try {
            const d = await runEvaluation({
                characterId: document.getElementById('rzChar').value,
                observationType: 'pad_change',
                dimension: document.getElementById('rzDim').value,
                oldValue: parseFloat(document.getElementById('rzOld').value),
                newValue: parseFloat(document.getElementById('rzNew').value),
                userBeltLevel: document.getElementById('rzBelt').value
            }, ctx.signal);

            updateAll(d);
            badge.textContent = 'Complete';
            badge.className = 'rz-badge rz-badge-done';
        } catch (err) {
            if (err.name !== 'AbortError') {
                badge.textContent = 'Error';
                badge.className = 'rz-badge';
                badge.style.borderColor = '#ff3333';
                badge.style.color = '#ff3333';
            }
        }

        btn.disabled = false;
        setTimeout(() => {
            badge.textContent = 'Ready';
            badge.className = 'rz-badge rz-badge-ready';
            badge.style.borderColor = '';
            badge.style.color = '';
        }, 3000);
    });
});

export { closeRazor };

export default Object.freeze({
    closeRazor,
    name: 'ockhamsRazorView',
});
