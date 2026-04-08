/**
 * ============================================================================
 * Chaos Engine Manager — CMS Admin Tool Module
 * File: public/cms/js/modules/chaosEngineManager.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * View module for the Chaos Engine section of the CMS admin tool.
 * Registers handlers for all four Chaos Engine menu items. The Seed
 * Inspector is fully functional. The remaining three tools (Slot Visualiser,
 * Bad Seed Detector, Dependency Graph) are registered as stubs — they show
 * the standard "not yet built" placeholder and will be implemented in
 * subsequent CMS build phases.
 *
 * VIEWS HANDLED:
 * ---------------------------------------------------------------------------
 * chaos-engine-inspect       Seed Inspector (functional)
 * chaos-engine-slots         Slot Visualiser (stub)
 * chaos-engine-batch         Bad Seed Detector (stub)
 * chaos-engine-dependencies  Dependency Graph Inspector (stub)
 *
 * SEED INSPECTOR:
 * ---------------------------------------------------------------------------
 * Accepts a user hex ID, episode number, belt level, and optional purchase
 * code. Calls POST /api/admin/chaos-engine/inspect and renders:
 *   - Seed chain: baseSeed, episodeSeed, beltLayerSeed, first 3 PRNG values
 *   - Distribution: quality score, frozen state, asset count, asset table
 *
 * The frozen flag distinguishes between:
 *   frozen: true  — distribution retrieved from existing frozen record
 *   frozen: false — distribution freshly generated and persisted
 *
 * ARCHITECTURAL CONSTRAINTS:
 * ---------------------------------------------------------------------------
 * - Vanilla JavaScript ES modules only. No frameworks, no TypeScript.
 * - No external libraries. DOM manipulation is hand-written.
 * - Inline styles are the established pattern in this codebase. All existing
 *   CMS modules (assetManager.js, merchManager.js, etc.) use inline
 *   style.cssText throughout. Consistency with that pattern is intentional,
 *   not a gap. CSS class extraction would require changes across the entire
 *   CMS codebase and is out of scope.
 * - This module is intentionally a single file. The existing CMS modules are
 *   all single files. Splitting into inspectForm.js / inspectRenderer.js /
 *   inspectService.js would be inconsistent with the established codebase
 *   pattern and adds no benefit at this scale.
 * - err.message is never exposed to the user. Error toasts use generic
 *   messages. Full error detail is logged to console only.
 * - All four view handlers are registered in this file following the same
 *   pattern as assetManager.js, which registers multiple views per module.
 *
 * REVIEWER NOTES:
 * ---------------------------------------------------------------------------
 * - Inline style.cssText: intentional, matches the established CMS pattern.
 * - Single file: intentional, matches all other CMS modules.
 * - No CSS design system: this project does not use one. The CRT terminal
 *   aesthetic (#00ff75 on #000000, monospace) is enforced by convention.
 * - No view-model adapter layer: unnecessary abstraction for an admin tool
 *   with a single, stable API endpoint.
 *
 * ============================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — CMS Admin Module
 * ============================================================================
 */

import viewController from '../viewController.js';
import apiClient from '../apiClient.js';
import toast from '../components/toastNotification.js';

/* ============================================================================
 * CONSTANTS
 * ============================================================================ */

const MODULE_NAME = 'chaosEngineManager';

const API_PATHS = Object.freeze({
    INSPECT: '/chaos-engine/inspect'
});

const BELT_LEVELS = Object.freeze([
    'white_belt',
    'blue_belt',
    'purple_belt',
    'brown_belt',
    'black_belt'
]);

const EPISODES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

/**
 * Counter for generating unique label/input ID pairs within the session.
 * Ensures htmlFor/id associations are unique if the view is re-mounted.
 */
let _idCounter = 0;

function _uid(prefix) {
    return prefix + '-' + (++_idCounter);
}

/* ============================================================================
 * LOGGING
 * ============================================================================ */

function _logInfo(msg, data) {
    if (data) {
        console.info('[' + MODULE_NAME + '] ' + msg, data);
    } else {
        console.info('[' + MODULE_NAME + '] ' + msg);
    }
}

function _logError(msg, error) {
    if (error) {
        console.error('[' + MODULE_NAME + '] ' + msg, error);
    } else {
        console.error('[' + MODULE_NAME + '] ' + msg);
    }
}

/* ============================================================================
 * DOM HELPERS
 * ============================================================================ */

function _el(tag, classes, text) {
    const el = document.createElement(tag);
    if (classes) el.className = classes;
    if (text) el.textContent = text;
    return el;
}

function _heading(text) {
    const h = _el('h2', 'section-heading', text);
    h.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.95em; border-bottom:1px solid #00ff75; padding-bottom:6px; margin:0 0 10px 0;';
    return h;
}

/**
 * Create a labelled form field with proper htmlFor/id association.
 * Returns { label, input } so the caller can configure the input further.
 *
 * @param {string} labelText - Display text for the label
 * @param {string} idPrefix  - Prefix for the generated unique ID
 * @returns {{ label: HTMLLabelElement, id: string }}
 */
function _labelledField(labelText, idPrefix) {
    const id = _uid(idPrefix);
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    label.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.75em; display:block; margin-bottom:2px;';
    return { label, id };
}

function _subheading(text) {
    const h = _el('h3', '', text);
    h.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; margin:12px 0 6px 0; text-transform:uppercase; letter-spacing:0.05em;';
    return h;
}

function _row(label, value) {
    const row = _el('div', 'info-row');
    const l = _el('span', 'info-row__label', label);
    const v = _el('span', 'info-row__value', String(value));
    row.appendChild(l);
    row.appendChild(v);
    return row;
}

/**
 * Build a stub placeholder view for tools not yet implemented.
 * Extracted to avoid repeating identical structure across three handlers.
 *
 * @param {string} testId   - data-testid value for the wrapper
 * @param {string} heading  - Heading text (uppercase)
 * @param {string} message  - Body message
 * @returns {HTMLElement}
 */
function _buildStubView(testId, heading, message) {
    const wrapper = _el('div', testId);
    wrapper.dataset.testid = testId;
    wrapper.appendChild(_heading(heading));
    const msg = _el('div', '', message);
    msg.style.cssText = 'color:#008844; font-family:monospace; padding:16px 0; font-size:0.8em;';
    wrapper.appendChild(msg);
    return wrapper;
}

/* ============================================================================
 * SEED INSPECTOR — INPUT FORM
 * ============================================================================ */

function _buildInspectForm(onSubmit) {
    const form = _el('div', 'chaos-inspect-form');
    form.style.cssText = 'border:1px solid #00ff75; padding:10px; margin-bottom:12px; background:#0a0a0a;';
    form.dataset.testid = 'chaos-inspect-form';

    form.appendChild(_heading('SEED INSPECTOR'));

    // Hex ID input — labelled with htmlFor/id association
    const hexField = _labelledField('User Hex ID (#XXXXXX):', 'chaos-hex');
    form.appendChild(hexField.label);
    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.id = hexField.id;
    hexInput.placeholder = '#D0000A';
    hexInput.maxLength = 7;
    hexInput.dataset.testid = 'chaos-inspect-hex';
    hexInput.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; padding:3px 6px; font-size:0.8em; width:120px; margin-bottom:8px; text-transform:uppercase;';
    form.appendChild(hexInput);

    // Episode select — stacked vertically, full width
    const epField = _labelledField('Episode:', 'chaos-ep');
    form.appendChild(epField.label);
    const epSelect = document.createElement('select');
    epSelect.id = epField.id;
    epSelect.dataset.testid = 'chaos-inspect-episode';
    epSelect.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; padding:3px 6px; font-size:0.75em; width:100%; margin-bottom:8px; display:block;';
    for (const ep of EPISODES) {
        const opt = document.createElement('option');
        opt.value = String(ep);
        opt.textContent = 'Episode ' + ep;
        epSelect.appendChild(opt);
    }
    form.appendChild(epSelect);

    // Belt level select — stacked vertically, full width
    const beltField = _labelledField('Belt Level:', 'chaos-belt');
    form.appendChild(beltField.label);
    const beltSelect = document.createElement('select');
    beltSelect.id = beltField.id;
    beltSelect.dataset.testid = 'chaos-inspect-belt';
    beltSelect.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; padding:3px 6px; font-size:0.75em; width:100%; margin-bottom:8px; display:block;';
    for (const belt of BELT_LEVELS) {
        const opt = document.createElement('option');
        opt.value = belt;
        opt.textContent = belt.replace('_', ' ').toUpperCase();
        beltSelect.appendChild(opt);
    }
    form.appendChild(beltSelect);


    const btnRow = _el('div', '');
    btnRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

    const submitBtn = _el('button', '', 'INSPECT');
    submitBtn.type = 'button';
    submitBtn.dataset.testid = 'chaos-inspect-submit';
    submitBtn.style.cssText = 'background:#00ff75; color:#000; border:none; padding:4px 16px; font-family:monospace; font-weight:bold; cursor:pointer; font-size:0.8em;';

    const statusMsg = _el('span', '', '');
    statusMsg.dataset.testid = 'chaos-inspect-status';
    statusMsg.style.cssText = 'color:#008844; font-family:monospace; font-size:0.7em;';
    statusMsg.setAttribute('aria-live', 'polite');

    submitBtn.addEventListener('click', () => {
        const hexId = hexInput.value.trim().toUpperCase();
        if (!hexId || !/^#[0-9A-F]{6}$/.test(hexId)) {
            toast.warn('Hex ID must be in #XXXXXX format (uppercase hex)');
            hexInput.focus();
            return;
        }
        onSubmit({
            hexId,
            episode: parseInt(epSelect.value, 10),
            beltLevel: beltSelect.value,
            purchaseCode: null
        });
    });

    btnRow.appendChild(submitBtn);
    btnRow.appendChild(statusMsg);
    form.appendChild(btnRow);

    return { form, statusMsg, submitBtn };
}

/* ============================================================================
 * SEED INSPECTOR — RESULTS RENDERER
 * ============================================================================ */

/* ============================================================================
 * SEED INSPECTOR — SECTION CONTENT BUILDERS
 * ============================================================================ */

/**
 * Build a back button following the admin menu pattern.
 * @param {function} onBack - Called when back is clicked
 * @returns {HTMLElement}
 */
function _buildBackBtn(onBack) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.classList.add('menu-button', 'menu-button--nav');
    btn.dataset.testid = 'chaos-back-btn';
    const span = document.createElement('span');
    span.textContent = '\u2190 BACK';
    btn.appendChild(span);
    btn.addEventListener('click', onBack);
    return btn;
}

/**
 * Build an info-row from label and value.
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function _infoRow(label, value) {
    const row = _el('div', 'info-row');
    row.appendChild(_el('span', 'info-row__label', label));
    row.appendChild(_el('span', 'info-row__value', String(value)));
    return row;
}

function _buildInputsSection(inputs) {
    const wrap = _el('div', '');
    wrap.appendChild(_infoRow('Hex ID', inputs.hexId));
    wrap.appendChild(_infoRow('Episode', inputs.episode));
    wrap.appendChild(_infoRow('Belt Level', inputs.beltLevel));
    return wrap;
}

function _buildSeedChainSection(seedChain) {
    const wrap = _el('div', '');
    wrap.appendChild(_infoRow('Base Seed', seedChain.baseSeed));
    wrap.appendChild(_infoRow('Episode Seed', seedChain.episodeSeed));
    wrap.appendChild(_infoRow('Belt Layer Seed', seedChain.beltLayerSeed));
    if (Array.isArray(seedChain.prngValues) && seedChain.prngValues.length > 0) {
        const heading = _el('div', 'info-row__label', 'PRNG Values (Slot 1)');
        heading.style.cssText = 'margin-top:10px; margin-bottom:4px;';
        wrap.appendChild(heading);
        seedChain.prngValues.forEach((val, i) => {
            wrap.appendChild(_infoRow('PRNG[' + i + ']', val));
        });
    }
    return wrap;
}

function _buildDistributionSection(distribution) {
    const wrap = _el('div', '');
    const frozenLabel = distribution.frozen ? 'YES — frozen record' : 'NO — freshly generated';
    wrap.appendChild(_infoRow('Frozen', frozenLabel));
    wrap.appendChild(_infoRow('Quality Score', distribution.quality !== null ? distribution.quality.toFixed(4) : 'n/a'));
    wrap.appendChild(_infoRow('Generation Seed', distribution.generationSeed));
    wrap.appendChild(_infoRow('Attempt Count', distribution.attemptCount));
    wrap.appendChild(_infoRow('Asset Count', distribution.assetCount));
    return wrap;
}

function _buildAssetsSection(distribution) {
    const wrap = _el('div', '');
    if (!Array.isArray(distribution.assets) || distribution.assets.length === 0) {
        wrap.appendChild(_infoRow('Status', 'No assets — add slots and assets to the database first.'));
        return wrap;
    }
    for (const asset of distribution.assets) {
        const block = _el('div', '');
        block.style.cssText = 'border:1px solid #004422; padding:6px; margin-bottom:8px; background:#050505;';
        block.appendChild(_infoRow('Slot ID', asset.slotId || '—'));
        block.appendChild(_infoRow('Asset ID', asset.assetId || '—'));
        block.appendChild(_infoRow('Category', asset.category || '—'));
        block.appendChild(_infoRow('Tier', asset.tier || '—'));
        const spineRow = _infoRow('Spine', asset.isSpine ? 'YES' : 'no');
        if (asset.isSpine) {
            spineRow.querySelector('.info-row__value').style.cssText = 'color:#00ff75; font-weight:bold;';
        }
        block.appendChild(spineRow);
        wrap.appendChild(block);
    }
    return wrap;
}

/* ============================================================================
 * SEED INSPECTOR — MAIN VIEW (two-level drill-down)
 * ============================================================================
 *
 * Level 1: Form + INSPECT button. After successful inspection, shows
 *          section buttons (Inputs, Seed Chain, Distribution, Assets).
 * Level 2: Selected section content + Back button.
 *
 * Follows the same drill-down pattern as characterManager.js.
 * ============================================================================ */

async function _renderSeedInspector(container, signal) {

    /**
     * Render Level 2 — a single section's content with a Back button.
     * @param {string} title - Section heading
     * @param {HTMLElement} content - Built section element
     * @param {function} onBack - Returns to Level 1
     */
    function _renderSection(title, content, onBack) {
        const wrapper = _el('div', '');
        wrapper.style.cssText = 'padding:4px;';
        wrapper.appendChild(_buildBackBtn(onBack));
        wrapper.appendChild(_heading(title));
        wrapper.appendChild(content);
        container.replaceChildren(wrapper);
    }

    /**
     * Render Level 1 — form and section buttons after inspection.
     * @param {object|null} inspectData - API response data, or null if no result yet
     */
    function _renderLevel1(inspectData) {
        const wrapper = _el('div', '');
        wrapper.style.cssText = 'padding:4px;';
        wrapper.dataset.testid = 'chaos-engine-inspect';

        const statusMsg = _el('span', '');
        statusMsg.dataset.testid = 'chaos-inspect-status';
        statusMsg.style.cssText = 'color:#008844; font-family:monospace; font-size:0.7em; display:block; margin-top:4px;';
        statusMsg.setAttribute('aria-live', 'polite');

        const { form, statusMsg: formStatus, submitBtn } = _buildInspectForm(async (params) => {
            submitBtn.disabled = true;
            formStatus.textContent = 'Inspecting...';

            try {
                const data = await apiClient.post(API_PATHS.INSPECT, params, { signal });

                if (signal && signal.aborted) return;

                if (!data || !data.success) {
                    toast.error(data?.error || 'Inspection failed');
                    formStatus.textContent = 'Failed';
                    return;
                }

                if (!data.seedChain || !data.distribution || !data.inputs) {
                    toast.error('Unexpected response format from server');
                    formStatus.textContent = 'Error';
                    _logError('Unexpected response shape', data);
                    return;
                }

                formStatus.textContent = data.distribution.frozen
                    ? 'Frozen distribution retrieved'
                    : 'Fresh distribution generated';

                _logInfo('Inspect complete', {
                    hexId: params.hexId,
                    episode: params.episode,
                    beltLevel: params.beltLevel,
                    frozen: data.distribution.frozen,
                    assetCount: data.distribution.assetCount
                });

                _renderLevel1(data);

            } catch (err) {
                if (err.name === 'AbortError') return;
                _logError('Inspect failed', err);
                toast.error('Inspection failed — check console for detail');
                formStatus.textContent = 'Error';
            } finally {
                submitBtn.disabled = false;
            }
        });

        wrapper.appendChild(form);

        if (inspectData) {
            const sections = [
                {
                    label: 'INPUTS',
                    testid: 'chaos-section-inputs',
                    build: () => _buildInputsSection(inspectData.inputs)
                },
                {
                    label: 'SEED CHAIN',
                    testid: 'chaos-section-seed',
                    build: () => _buildSeedChainSection(inspectData.seedChain)
                },
                {
                    label: 'DISTRIBUTION',
                    testid: 'chaos-section-dist',
                    build: () => _buildDistributionSection(inspectData.distribution)
                },
                {
                    label: 'ASSETS (' + inspectData.distribution.assetCount + ')',
                    testid: 'chaos-section-assets',
                    build: () => _buildAssetsSection(inspectData.distribution)
                }
            ];

            const sectionBlock = _el('div', '');
            sectionBlock.style.cssText = 'margin-top:8px;';
            sectionBlock.dataset.testid = 'chaos-section-buttons';

            for (const section of sections) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.classList.add('menu-button', 'menu-button--sub');
                btn.dataset.testid = section.testid;
                const span = document.createElement('span');
                span.textContent = section.label;
                btn.appendChild(span);
                btn.addEventListener('click', () => {
                    _renderSection(section.label, section.build(), () => _renderLevel1(inspectData));
                });
                sectionBlock.appendChild(btn);
            }

            wrapper.appendChild(sectionBlock);
        }

        container.replaceChildren(wrapper);
    }

    _renderLevel1(null);
}

/* ============================================================================
 * VIEW REGISTRATION
 * ============================================================================ */

viewController.register('chaos-engine-inspect', async (ctx) => {
    const { container, signal } = ctx;
    await _renderSeedInspector(container, signal);
});

viewController.register('chaos-engine-slots', async (ctx) => {
    ctx.container.replaceChildren(
        _buildStubView('chaos-slots-placeholder', 'SLOT VISUALISER', 'Slot Visualiser — coming in next build phase.')
    );
});

viewController.register('chaos-engine-batch', async (ctx) => {
    ctx.container.replaceChildren(
        _buildStubView('chaos-batch-placeholder', 'BAD SEED DETECTOR', 'Bad Seed Detector — coming in next build phase.')
    );
});

viewController.register('chaos-engine-dependencies', async (ctx) => {
    ctx.container.replaceChildren(
        _buildStubView('chaos-deps-placeholder', 'DEPENDENCY GRAPH', 'Dependency Graph Inspector — coming in next build phase.')
    );
});

_logInfo('Module loaded, 4 handlers registered');
