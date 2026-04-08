/**
 * ============================================================================
 * Narrative Blueprint Manager — Blueprint Tool View Module for CMS Admin Tool
 * File: public/cms/js/modules/narrativeBlueprintManager.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * View module for the Narrative Blueprint Tool. Handles blueprint browsing,
 * instance creation/editing, and storytelling heuristics views in the
 * right-hand tools panel. Registers handlers with viewController for each
 * blueprint menu item dispatched by adminMenu.js.
 *
 * VIEWS HANDLED:
 * ---------------------------------------------------------------------------
 * narrative-blueprints    Browse the 7 blueprint frameworks (Vogler, Harmon,
 *                         etc.) with their beats and metadata
 *
 * narrative-instances     List/create/edit filled narrative instances
 *                         params.id null = list view
 *                         params.id set  = detail/edit view
 *
 * narrative-heuristics    Browse and filter the 41 storytelling heuristics
 *                         by situation, beat context, and source author
 *
 * HOW IT WORKS:
 * ---------------------------------------------------------------------------
 * 1. Module is dynamically imported by cmsBootstrap.js on page load
 * 2. On import, it immediately registers handlers with viewController
 * 3. When user clicks a blueprint menu item in the admin menu:
 *    - adminMenu.js dispatches admin:navigate with the item ID
 *    - viewController calls our registered handler
 *    - Handler receives { container, params, signal, api, navigateTo }
 *
 * API ENDPOINTS CONSUMED:
 * ---------------------------------------------------------------------------
 * GET /api/admin/narrative-blueprints              List all blueprints
 * GET /api/admin/narrative-blueprints/:id          Single blueprint + beats
 * GET /api/admin/narrative-blueprints/by-scale/:s  Filter by scale
 * POST /api/admin/narrative-blueprints/instances   Create instance
 * GET /api/admin/narrative-blueprints/instances     List instances
 * GET /api/admin/narrative-blueprints/instances/:id Single instance + beats
 * PUT /api/admin/narrative-blueprints/instances/:id Update instance
 * DELETE /api/admin/narrative-blueprints/instances/:id Archive instance
 * POST /api/admin/narrative-blueprints/instances/:id/beats  Upsert beat content
 * GET /api/admin/narrative-blueprints/instances/:id/beats   Get beat content
 * PUT /api/admin/narrative-blueprints/beat-content/:id      Update beat content
 * GET /api/admin/narrative-blueprints/instances/:id/children Nested children
 * GET /api/admin/narrative-blueprints/heuristics            List heuristics
 * GET /api/admin/narrative-blueprints/heuristics/random     Random heuristic
 *
 * BLUEPRINT LIST RESPONSE FIELDS:
 * ---------------------------------------------------------------------------
 * blueprint_id          Hex ID (displayed in list)
 * blueprint_name        Framework name (displayed in list)
 * blueprint_source      Author citation e.g. Vogler, C. (1992/2007)
 * evidence_quality      peer_reviewed | practitioner | mixed
 * scale_suitability     scene | arc | series | overlay (displayed in list)
 * total_beats           Number of beats in framework (displayed in list)
 * conflict_required     Boolean
 * description           Full text description
 * usage_guidance        When to use this framework
 * display_order         Sort order integer
 *
 * List view shows: ID, Name, Scale, Beats (4 columns)
 * Detail view shows: all fields
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * viewController.js       Registration target (viewController.register)
 * apiClient.js            HTTP communication (passed as ctx.api)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: C — Narrative Blueprint Frontend
 * Author: James (Project Manager)
 * Created: February 25, 2026
 * ============================================================================
 */

import viewController from '../viewController.js';
import dataTable from '../components/dataTable.js';

/* ============================================================================
 * CONSTANTS
 * ============================================================================ */

const LOG_PREFIX = '[narrativeBlueprintManager]';

const API_PATHS = Object.freeze({
  BLUEPRINTS: '/narrative-blueprints',
  INSTANCES: '/narrative-blueprints/instances',
  HEURISTICS: '/narrative-blueprints/heuristics',
  HEURISTICS_RANDOM: '/narrative-blueprints/heuristics/random',
});

const VALID_SCALES = Object.freeze([
  'season', 'episode', 'event', 'scene', 'conversation', 'narration'
]);

const VALID_SITUATIONS = Object.freeze([
  'weak_inciting_incident', 'flat_complications', 'no_crisis',
  'weak_climax', 'flat_resolution', 'character_inert',
  'lost_focus', 'creative_block', 'audience_disengaged', 'craft_visible'
]);

const VALID_BEAT_CONTEXTS = Object.freeze([
  'opening', 'early', 'midpoint', 'late',
  'climax', 'resolution', 'any'
]);

const PROMPT_PREVIEW_LENGTH = 80;

/* ============================================================================
 * LOGGING
 * ============================================================================ */

function _logInfo(msg, data) {
  if (typeof console !== 'undefined') {
    console.info(`${LOG_PREFIX} ${msg}`, data ?? '');
  }
}

function _logError(msg, err) {
  if (typeof console !== 'undefined') {
    console.error(`${LOG_PREFIX} ${msg}`, err ?? '');
  }
}

/**
 * Currently active DataTable instance for cleanup on view change
 * @type {{cleanup: function}|null}
 */
let _activeTable = null;

/**
 * Clean up any active DataTable before rendering a new view.
 * Removes event listeners from the previous table to prevent leaks.
 */
function _cleanupActiveTable() {
  if (_activeTable && typeof _activeTable.cleanup === 'function') {
    _activeTable.cleanup();
  }
  _activeTable = null;
}

/* ============================================================================
 * SHARED HELPERS
 * ============================================================================ */

/**
 * Build a styled placeholder element for wiring verification.
 * Will be replaced with real views in subsequent tasks.
 *
 * @param {string} title - View title
 * @param {string} description - View description
 * @returns {HTMLElement}
 */
function _buildPlaceholder(title, description) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('info-block');

  const heading = document.createElement('div');
  heading.classList.add('info-row');

  const titleEl = document.createElement('span');
  titleEl.classList.add('info-row__label');
  titleEl.style.fontWeight = 'bold';
  titleEl.style.letterSpacing = '2px';
  titleEl.textContent = title;
  heading.appendChild(titleEl);

  wrapper.appendChild(heading);

  const descRow = document.createElement('div');
  descRow.classList.add('info-row');

  const descEl = document.createElement('span');
  descEl.classList.add('info-row__value');
  descEl.textContent = description;
  descRow.appendChild(descEl);

  wrapper.appendChild(descRow);

  return wrapper;
}

/* ============================================================================
 * VIEW: narrative-blueprints (Browse Frameworks)
 * ============================================================================ */

async function _renderBlueprintList(ctx) {
  const { container, signal, api, navigateTo } = ctx;

  _logInfo('Rendering blueprint list');

  _cleanupActiveTable();

  const response = await api.get(API_PATHS.BLUEPRINTS, { signal });

  if (!response || signal.aborted) return;

  if (!response.success || !Array.isArray(response.blueprints)) {
    throw new Error('Unexpected response format from blueprint list endpoint');
  }

  const wrapper = document.createElement('div');
  wrapper.classList.add('info-block');

  const heading = document.createElement('div');
  heading.classList.add('info-row');
  const titleEl = document.createElement('span');
  titleEl.classList.add('info-row__label');
  titleEl.style.fontWeight = 'bold';
  titleEl.style.letterSpacing = '2px';
  titleEl.textContent = 'NARRATIVE BLUEPRINTS (' + response.count + ')';
  heading.appendChild(titleEl);
  wrapper.appendChild(heading);

  const table = dataTable.create({
    columns: [
      { key: 'blueprint_id', label: 'ID', renderer: 'hexId' },
      { key: 'blueprint_name', label: 'Name' },
      { key: 'scale_suitability', label: 'Scale' },
      { key: 'total_beats', label: 'Beats', renderer: 'number' }
    ],
    data: response.blueprints,
    onRowClick: (row) => {
      navigateTo('narratives', 'narrative-blueprints', row.blueprint_name || 'Detail', row.blueprint_id);
    },
    emptyMessage: 'No blueprints found'
  });

  _activeTable = table;

  wrapper.appendChild(table);

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/**
 * Cached blueprint data for detail view navigation.
 * Avoids re-fetching when navigating between profile and beat views.
 * Cleared when a different blueprint is loaded.
 * @type {{blueprintId: string, data: object}|null}
 */
let _blueprintDetailCache = null;

/**
 * Maximum allowed length for instance title input.
 * Enforced client-side before POST.
 * @type {number}
 */
const INSTANCE_TITLE_MAX_LENGTH = 200;

/* ============================================================================
 * REUSABLE DOM HELPERS — DRY element factories
 * ============================================================================ */

/**
 * Create a standard info row (label + value pair).
 * Returns null if value is null/undefined so callers can skip.
 *
 * @param {string} label - Row label text
 * @param {*} value - Row value (converted to string)
 * @returns {HTMLElement|null}
 */
function _createInfoRow(label, value) {
  if (value === null || value === undefined) return null;
  const row = document.createElement('div');
  row.classList.add('info-row');
  const labelEl = document.createElement('span');
  labelEl.classList.add('info-row__label');
  labelEl.textContent = label;
  row.appendChild(labelEl);
  const valueEl = document.createElement('span');
  valueEl.classList.add('info-row__value');
  valueEl.textContent = String(value);
  row.appendChild(valueEl);
  return row;
}

/**
 * Create a navigation back button with consistent styling.
 *
 * @returns {HTMLButtonElement}
 */
function _createBackButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.classList.add('menu-button', 'menu-button--nav');
  const span = document.createElement('span');
  span.textContent = '\u2190 BACK';
  btn.appendChild(span);
  return btn;
}

/**
 * Create a section heading row.
 *
 * @param {string} text - Heading text
 * @returns {HTMLElement}
 */
function _createSectionHeading(text) {
  const heading = document.createElement('div');
  heading.classList.add('info-row');
  const label = document.createElement('span');
  label.classList.add('info-row__label');
  label.style.fontWeight = 'bold';
  label.style.letterSpacing = '2px';
  label.textContent = text;
  heading.appendChild(label);
  return heading;
}

/* ============================================================================
 * BLUEPRINT DETAIL — Entry point, cache, routing
 * ============================================================================ */

async function _renderBlueprintDetail(ctx) {
  const { container, params, signal, api, navigateTo } = ctx;
  const blueprintId = params.id;

  _logInfo('Rendering blueprint detail', { id: blueprintId });

  if (!_blueprintDetailCache || _blueprintDetailCache.blueprintId !== blueprintId) {
    const response = await api.get(API_PATHS.BLUEPRINTS + '/'
      + encodeURIComponent(blueprintId), { signal });

    if (!response || signal.aborted) return;

    if (!response.success || !response.blueprint) {
      throw new Error('Unexpected response format from blueprint detail endpoint');
    }

    _blueprintDetailCache = {
      blueprintId: blueprintId,
      data: response.blueprint
    };
  }

  const bp = _blueprintDetailCache.data;

  if (signal.aborted) return;
  _renderBlueprintProfile(container, bp, signal, api, navigateTo);
}

/* ============================================================================
 * BLUEPRINT PROFILE — Beat buttons + CREATE NARRATIVE
 * ============================================================================ */

/**
 * Render blueprint beats view with CREATE NARRATIVE button.
 * Beats are read-only reference. CREATE button opens creation form.
 */
function _renderBlueprintProfile(container, bp, signal, api, navigateTo) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.classList.add('menu-button', 'menu-button--active');
  const createSpan = document.createElement('span');
  createSpan.textContent = 'CREATE NARRATIVE FROM THIS BLUEPRINT';
  createBtn.appendChild(createSpan);
  createBtn.dataset.action = 'show-create-form';
  wrapper.appendChild(createBtn);

  if (bp.beats && bp.beats.length > 0) {
    const beatsSection = document.createElement('div');
    beatsSection.classList.add('info-block');

    const beatsHeading = document.createElement('div');
    beatsHeading.classList.add('info-row');
    const beatsTitle = document.createElement('span');
    beatsTitle.classList.add('info-row__label');
    beatsTitle.style.fontWeight = 'bold';
    beatsTitle.style.letterSpacing = '1px';
    beatsTitle.textContent = bp.blueprint_name + ' — BEATS (' + bp.beats.length + ')';
    beatsHeading.appendChild(beatsTitle);
    beatsSection.appendChild(beatsHeading);

    for (let i = 0; i < bp.beats.length; i++) {
      const beat = bp.beats[i];
      const beatBtn = document.createElement('button');
      beatBtn.type = 'button';
      beatBtn.classList.add('menu-button', 'menu-button--sub');
      const beatSpan = document.createElement('span');
      beatSpan.textContent = beat.beat_number + '. ' + beat.beat_name;
      beatBtn.appendChild(beatSpan);
      beatBtn.dataset.action = 'view-beat';
      beatBtn.dataset.beatIndex = String(i);
      beatsSection.appendChild(beatBtn);
    }

    wrapper.appendChild(beatsSection);
  }

  wrapper.addEventListener('click', function _handleClick(e) {
    const createTarget = e.target.closest('[data-action="show-create-form"]');
    if (createTarget) {
      wrapper.removeEventListener('click', _handleClick);
      _renderCreateForm(container, bp, signal, api, navigateTo);
      return;
    }

    const beatTarget = e.target.closest('[data-action="view-beat"]');
    if (beatTarget) {
      const beatIndex = parseInt(beatTarget.dataset.beatIndex, 10);
      const beat = bp.beats[beatIndex];
      if (beat) {
        wrapper.removeEventListener('click', _handleClick);
        _renderBeatDetail(container, bp, beat, signal, api, navigateTo);
      }
    }
  });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/* ============================================================================
 * CREATE FORM — Title + Scale + Submit
 * ============================================================================ */

/**
 * Render the create narrative form.
 * Title input + scale dropdown + submit.
 * On success, navigates to the new instance for beat authoring.
 */
function _renderCreateForm(container, bp, signal, api, navigateTo) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');

  const backBtn = _createBackButton();
  wrapper.appendChild(backBtn);

  const formBlock = document.createElement('div');
  formBlock.classList.add('info-block');

  formBlock.appendChild(_createSectionHeading('CREATE NARRATIVE'));

  const bpRow = _createInfoRow('Blueprint', bp.blueprint_name);
  if (bpRow) formBlock.appendChild(bpRow);

  const titleRow = document.createElement('div');
  titleRow.classList.add('info-row');
  const titleLabel = document.createElement('span');
  titleLabel.classList.add('info-row__label');
  titleLabel.textContent = 'Title';
  titleRow.appendChild(titleLabel);
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.maxLength = INSTANCE_TITLE_MAX_LENGTH;
  titleInput.placeholder = 'e.g. Season One Main Arc';
  titleInput.classList.add('cms-input');
  titleRow.appendChild(titleInput);
  formBlock.appendChild(titleRow);

  const scaleRow = document.createElement('div');
  scaleRow.classList.add('info-row');
  const scaleLabel = document.createElement('span');
  scaleLabel.classList.add('info-row__label');
  scaleLabel.textContent = 'Scale';
  scaleRow.appendChild(scaleLabel);
  const scaleSelect = document.createElement('select');
  scaleSelect.classList.add('cms-input');
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '-- Select Scale --';
  scaleSelect.appendChild(defaultOpt);
  for (const scale of VALID_SCALES) {
    const opt = document.createElement('option');
    opt.value = scale;
    opt.textContent = scale;
    scaleSelect.appendChild(opt);
  }
  scaleRow.appendChild(scaleSelect);
  formBlock.appendChild(scaleRow);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.classList.add('menu-button', 'menu-button--active');
  const submitSpan = document.createElement('span');
  submitSpan.textContent = 'CREATE';
  submitBtn.appendChild(submitSpan);
  formBlock.appendChild(submitBtn);

  const statusRow = document.createElement('div');
  statusRow.classList.add('info-row');
  const statusMsg = document.createElement('span');
  statusMsg.classList.add('info-row__value');
  statusRow.appendChild(statusMsg);
  formBlock.appendChild(statusRow);

  wrapper.appendChild(formBlock);

  backBtn.addEventListener('click', function() {
    _renderBlueprintProfile(container, bp, signal, api, navigateTo);
  }, { once: true });

  submitBtn.addEventListener('click', async function() {
    const title = titleInput.value.trim();
    const scale = scaleSelect.value;

    if (!title) {
      statusMsg.textContent = 'Title is required.';
      return;
    }

    if (title.length > INSTANCE_TITLE_MAX_LENGTH) {
      statusMsg.textContent = 'Title must be ' + INSTANCE_TITLE_MAX_LENGTH + ' characters or fewer.';
      return;
    }

    if (!scale) {
      statusMsg.textContent = 'Please select a scale.';
      return;
    }

    submitBtn.disabled = true;
    backBtn.disabled = true;
    statusMsg.textContent = 'Creating...';

    try {
      const response = await api.post(API_PATHS.INSTANCES, {
        blueprint_id: bp.blueprint_id,
        instance_title: title,
        scale: scale
      }, { signal });

      if (!response || signal.aborted) return;

      if (!response.success || !response.instance_id) {
        throw new Error(response.error || 'Failed to create instance');
      }

      _logInfo('Instance created', {
        instanceId: response.instance_id,
        title: title,
        blueprintId: bp.blueprint_id,
        scale: scale
      });

      navigateTo('narratives', 'narrative-instances', title, response.instance_id);

    } catch (error) {
      submitBtn.disabled = false;
      backBtn.disabled = false;
      statusMsg.textContent = 'Error: ' + error.message;
      _logError('Failed to create instance', error);
    }
  });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/* ============================================================================
 * BEAT DETAIL — Single beat read-only view
 * ============================================================================ */

/**
 * Render single beat detail + back arrow.
 */
function _renderBeatDetail(container, bp, beat, signal, api, navigateTo) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');

  const backBtn = _createBackButton();
  wrapper.appendChild(backBtn);

  const beatSection = document.createElement('div');
  beatSection.classList.add('info-block');

  beatSection.appendChild(
    _createSectionHeading('Beat ' + beat.beat_number + ': ' + beat.beat_name)
  );

  const beatFields = [
    { label: 'ID', value: beat.blueprint_beat_id },
    { label: 'Label', value: beat.beat_label },
    { label: 'Pacing Position', value: beat.pacing_position },
    { label: 'Narrative Function', value: beat.narrative_function },
    { label: 'Rigidity', value: beat.beat_rigidity },
    { label: 'Description', value: beat.description },
    { label: 'Guidance', value: beat.guidance },
  ];

  for (const bf of beatFields) {
    const row = _createInfoRow(bf.label, bf.value);
    if (row) beatSection.appendChild(row);
  }

  wrapper.appendChild(beatSection);

  backBtn.addEventListener('click', function() {
    _renderBlueprintProfile(container, bp, signal, api, navigateTo);
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}




/* ============================================================================
 * VIEW: narrative-instances (List / Create / Edit)
 * ============================================================================ */

async function _renderInstanceList(ctx) {
  const { container, signal, api, navigateTo } = ctx;

  _logInfo('Rendering instance list');

  _cleanupActiveTable();

  const response = await api.get(API_PATHS.INSTANCES, { signal });

  if (!response || signal.aborted) return;

  if (!response.success || !Array.isArray(response.instances)) {
    throw new Error('Unexpected response format from instance list endpoint');
  }

  const wrapper = document.createElement('div');
  wrapper.classList.add('info-block');

  const heading = document.createElement('div');
  heading.classList.add('info-row');
  const titleEl = document.createElement('span');
  titleEl.classList.add('info-row__label');
  titleEl.style.fontWeight = 'bold';
  titleEl.style.letterSpacing = '2px';
  titleEl.textContent = 'BLUEPRINT INSTANCES (' + response.count + ')';
  heading.appendChild(titleEl);
  wrapper.appendChild(heading);

  const table = dataTable.create({
    columns: [
      { key: 'instance_id', label: 'ID', renderer: 'hexId' },
      { key: 'instance_title', label: 'Title' },
      { key: 'blueprint_name', label: 'Blueprint' },
      { key: 'scale', label: 'Scale' },
      { key: 'status', label: 'Status' }
    ],
    data: response.instances,
    onRowClick: (row) => {
      navigateTo('narratives', 'narrative-instances', row.instance_title || 'Detail', row.instance_id);
    },
    emptyMessage: 'No instances found. Create one from a blueprint.'
  });

  _activeTable = table;

  wrapper.appendChild(table);

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

async function _renderInstanceDetail(ctx) {
  const { container, params, signal, api, navigateTo } = ctx;
  const instanceId = params.id;

  _logInfo('Rendering instance detail', { id: instanceId });

  const instanceResponse = await api.get(API_PATHS.INSTANCES + '/'
    + encodeURIComponent(instanceId), { signal });

  if (!instanceResponse || signal.aborted) return;

  if (!instanceResponse.success || !instanceResponse.instance) {
    throw new Error('Unexpected response format from instance detail endpoint');
  }

  const instance = instanceResponse.instance;

  const blueprintResponse = await api.get(API_PATHS.BLUEPRINTS + '/'
    + encodeURIComponent(instance.blueprint_id), { signal });

  if (!blueprintResponse || signal.aborted) return;

  if (!blueprintResponse.success || !blueprintResponse.blueprint) {
    throw new Error('Unexpected response format from blueprint detail endpoint');
  }

  const blueprint = blueprintResponse.blueprint;

  const completedMap = new Map();
  if (instance.beat_content && instance.beat_content.length > 0) {
    for (const bc of instance.beat_content) {
      completedMap.set(bc.blueprint_beat_id, bc);
    }
  }

  const completedCount = completedMap.size;
  const totalBeats = blueprint.beats ? blueprint.beats.length : 0;

  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');

  wrapper.appendChild(
    _createSectionHeading(instance.instance_title)
  );

  const metaBlock = document.createElement('div');
  metaBlock.classList.add('info-block');

  const metaRow = _createInfoRow('Blueprint', instance.blueprint_name);
  if (metaRow) metaBlock.appendChild(metaRow);
  const scaleRow = _createInfoRow('Scale', instance.scale);
  if (scaleRow) metaBlock.appendChild(scaleRow);
  const statusRow = _createInfoRow('Status', instance.status);
  if (statusRow) metaBlock.appendChild(statusRow);
  const progressRow = _createInfoRow('Progress', completedCount + ' / ' + totalBeats + ' beats authored');
  if (progressRow) metaBlock.appendChild(progressRow);

  wrapper.appendChild(metaBlock);

  if (blueprint.beats && blueprint.beats.length > 0) {
    const beatsSection = document.createElement('div');
    beatsSection.classList.add('info-block');

    const beatsHeading = document.createElement('div');
    beatsHeading.classList.add('info-row');
    const beatsTitle = document.createElement('span');
    beatsTitle.classList.add('info-row__label');
    beatsTitle.style.fontWeight = 'bold';
    beatsTitle.style.letterSpacing = '1px';
    beatsTitle.textContent = 'BEATS (' + completedCount + '/' + totalBeats + ')';
    beatsHeading.appendChild(beatsTitle);
    beatsSection.appendChild(beatsHeading);

    for (let i = 0; i < blueprint.beats.length; i++) {
      const beat = blueprint.beats[i];
      const hasContent = completedMap.has(beat.blueprint_beat_id);
      const beatContent = hasContent ? completedMap.get(beat.blueprint_beat_id) : null;
      const isComplete = beatContent && beatContent.is_complete;

      const beatBtn = document.createElement('button');
      beatBtn.type = 'button';
      beatBtn.classList.add('menu-button', 'menu-button--sub');

      if (isComplete) {
        beatBtn.style.borderColor = '#00ff75';
        beatBtn.style.textShadow = '0 0 6px rgba(0, 255, 117, 0.4)';
      } else if (hasContent) {
        beatBtn.style.borderColor = '#ffaa00';
      }

      const beatSpan = document.createElement('span');
      const prefix = isComplete ? '\u2713 ' : hasContent ? '\u25CB ' : '';
      beatSpan.textContent = prefix + beat.beat_number + '. ' + beat.beat_name;
      beatBtn.appendChild(beatSpan);
      beatBtn.dataset.action = 'author-beat';
      beatBtn.dataset.beatIndex = String(i);
      beatsSection.appendChild(beatBtn);
    }

    wrapper.appendChild(beatsSection);

    wrapper.addEventListener('click', function _handleClick(e) {
      const beatTarget = e.target.closest('[data-action="author-beat"]');
      if (beatTarget) {
        const beatIndex = parseInt(beatTarget.dataset.beatIndex, 10);
        const beat = blueprint.beats[beatIndex];
        if (beat) {
          const existingContent = completedMap.get(beat.blueprint_beat_id) || null;
          wrapper.removeEventListener('click', _handleClick);
          _renderBeatAuthorForm(container, instance, blueprint, beat, existingContent, signal, api, navigateTo);
        }
      }
    });
  }

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/**
 * Render beat authoring form.
 * Content textarea + save button. PAD sliders and character select in future tasks.
 */
function _renderBeatAuthorForm(container, instance, blueprint, beat, existingContent, signal, api, navigateTo) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');

  const backBtn = _createBackButton();
  wrapper.appendChild(backBtn);

  const formBlock = document.createElement('div');
  formBlock.classList.add('info-block');

  formBlock.appendChild(
    _createSectionHeading('Beat ' + beat.beat_number + ': ' + beat.beat_name)
  );

  const guidanceRow = _createInfoRow('Guidance', beat.guidance);
  if (guidanceRow) formBlock.appendChild(guidanceRow);

  const descRow = _createInfoRow('Description', beat.description);
  if (descRow) formBlock.appendChild(descRow);

  const contentRow = document.createElement('div');
  contentRow.classList.add('info-row');
  const contentLabel = document.createElement('span');
  contentLabel.classList.add('info-row__label');
  contentLabel.textContent = 'Content';
  contentRow.appendChild(contentLabel);
  const contentArea = document.createElement('textarea');
  contentArea.classList.add('cms-input');
  contentArea.rows = 8;
  contentArea.placeholder = 'Write your narrative content for this beat...';
  contentArea.value = existingContent ? existingContent.content || '' : '';
  contentRow.appendChild(contentArea);
  formBlock.appendChild(contentRow);

  const notesRow = document.createElement('div');
  notesRow.classList.add('info-row');
  const notesLabel = document.createElement('span');
  notesLabel.classList.add('info-row__label');
  notesLabel.textContent = 'Notes';
  notesRow.appendChild(notesLabel);
  const notesArea = document.createElement('textarea');
  notesArea.classList.add('cms-input');
  notesArea.rows = 3;
  notesArea.placeholder = 'Optional notes...';
  notesArea.value = existingContent ? existingContent.notes || '' : '';
  notesRow.appendChild(notesArea);
  formBlock.appendChild(notesRow);

  const completeRow = document.createElement('div');
  completeRow.classList.add('info-row');
  const completeLabel = document.createElement('span');
  completeLabel.classList.add('info-row__label');
  completeLabel.textContent = 'Mark Complete';
  completeRow.appendChild(completeLabel);
  const completeCheck = document.createElement('input');
  completeCheck.type = 'checkbox';
  completeCheck.checked = existingContent ? existingContent.is_complete === true : false;
  completeRow.appendChild(completeCheck);
  formBlock.appendChild(completeRow);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.classList.add('menu-button', 'menu-button--active');
  const saveSpan = document.createElement('span');
  saveSpan.textContent = 'SAVE BEAT';
  saveBtn.appendChild(saveSpan);
  formBlock.appendChild(saveBtn);

  const statusRow = document.createElement('div');
  statusRow.classList.add('info-row');
  const statusMsg = document.createElement('span');
  statusMsg.classList.add('info-row__value');
  statusRow.appendChild(statusMsg);
  formBlock.appendChild(statusRow);

  wrapper.appendChild(formBlock);

  backBtn.addEventListener('click', function() {
    navigateTo('narratives', 'narrative-instances', instance.instance_title, instance.instance_id);
  }, { once: true });

  saveBtn.addEventListener('click', async function() {
    const content = contentArea.value.trim();
    const notes = notesArea.value.trim();
    const isComplete = completeCheck.checked;

    saveBtn.disabled = true;
    backBtn.disabled = true;
    statusMsg.textContent = 'Saving...';

    try {
      const response = await api.post(
        API_PATHS.INSTANCES + '/' + encodeURIComponent(instance.instance_id) + '/beats',
        {
          blueprint_beat_id: beat.blueprint_beat_id,
          content: content || null,
          is_complete: isComplete,
          notes: notes || null
        },
        { signal }
      );

      if (!response || signal.aborted) return;

      if (!response.success) {
        throw new Error(response.error || 'Failed to save beat content');
      }

      _logInfo('Beat content saved', {
        instanceId: instance.instance_id,
        beatId: beat.blueprint_beat_id,
        beatName: beat.beat_name,
        isComplete: isComplete
      });

      statusMsg.textContent = 'Saved successfully.';
      saveBtn.disabled = false;
      backBtn.disabled = false;

    } catch (error) {
      saveBtn.disabled = false;
      backBtn.disabled = false;
      statusMsg.textContent = 'Error: ' + error.message;
      _logError('Failed to save beat content', error);
    }
  });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/* ============================================================================
 * VIEW: narrative-heuristics (3-Level Click-Through)
 * ============================================================================
 * Level 1: 10 situation category buttons + RANDOM HEURISTIC
 * Level 2: Heuristics within a situation (click through from Level 1)
 * Level 3: Single heuristic detail (click through from Level 2)
 * No scrolling. All navigation via buttons and back arrows.
 * ============================================================================ */

/**
 * Level 1 — Render situation category buttons.
 *
 * Shows 10 clickable situation buttons (one per category) plus a
 * RANDOM HEURISTIC button. Clicking a situation navigates to Level 2
 * which shows the heuristics within that situation.
 *
 * @param {object} ctx - View context from viewController
 * @param {HTMLElement} ctx.container - Target DOM container
 * @param {AbortSignal} ctx.signal - Cancellation signal
 * @param {object} ctx.api - apiClient instance
 * @returns {Promise<void>}
 */
async function _renderHeuristicsList(ctx) {
  const { container, signal, api } = ctx;

  _logInfo('Rendering heuristics — situation categories');

  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');

  wrapper.appendChild(_createSectionHeading('STORYTELLING HEURISTICS'));

  const catBlock = document.createElement('div');
  catBlock.classList.add('info-block');
  catBlock.dataset.testid = 'heuristics-categories';

  for (const sit of VALID_SITUATIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.classList.add('menu-button', 'menu-button--sub');
    btn.dataset.testid = 'situation-' + sit;
    btn.dataset.situation = sit;
    const span = document.createElement('span');
    span.textContent = sit.replace(/_/g, ' ');
    btn.appendChild(span);
    catBlock.appendChild(btn);
  }

  wrapper.appendChild(catBlock);

  const randomBlock = document.createElement('div');
  randomBlock.classList.add('info-block');

  const randomBtn = document.createElement('button');
  randomBtn.type = 'button';
  randomBtn.classList.add('menu-button', 'menu-button--active');
  randomBtn.setAttribute('aria-label', 'Show a random storytelling heuristic');
  randomBtn.dataset.testid = 'heuristics-random-btn';
  const randomSpan = document.createElement('span');
  randomSpan.textContent = 'RANDOM HEURISTIC';
  randomBtn.appendChild(randomSpan);
  randomBlock.appendChild(randomBtn);

  wrapper.appendChild(randomBlock);

  const statusRow = document.createElement('div');
  statusRow.classList.add('info-row');
  const statusMsg = document.createElement('span');
  statusMsg.classList.add('info-row__value');
  statusMsg.setAttribute('aria-live', 'polite');
  statusRow.appendChild(statusMsg);
  wrapper.appendChild(statusRow);

  catBlock.addEventListener('click', function(e) {
    const target = e.target.closest('[data-situation]');
    if (target) {
      _renderHeuristicsBySituation(container, target.dataset.situation, signal, api);
    }
  }, { signal });

  randomBtn.addEventListener('click', async function() {
    statusMsg.textContent = 'Loading random...';

    try {
      const response = await api.get(API_PATHS.HEURISTICS_RANDOM, { signal });

      if (!response || signal.aborted) return;

      if (!response.success || !response.heuristic) {
        statusMsg.textContent = response.error || 'No heuristic found.';
        return;
      }

      _renderHeuristicDetail(container, response.heuristic, response.heuristic.situation, signal, api);

    } catch (error) {
      statusMsg.textContent = 'Error: ' + error.message;
      _logError('Failed to load random heuristic', error);
    }
  }, { signal });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/**
 * Level 2 — Render heuristics within a single situation category.
 *
 * Fetches heuristics filtered by the given situation and displays
 * each as a clickable button showing its beat context. Back button
 * returns to Level 1 (situation categories).
 *
 * @param {HTMLElement} container - Target DOM container
 * @param {string} situation - Situation category key
 * @param {AbortSignal} signal - Cancellation signal
 * @param {object} api - apiClient instance
 * @returns {Promise<void>}
 */
async function _renderHeuristicsBySituation(container, situation, signal, api) {
  _logInfo('Rendering heuristics for situation', { situation });

  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');

  const backBtn = _createBackButton();
  backBtn.setAttribute('aria-label', 'Back to situation categories');
  backBtn.dataset.testid = 'situation-back';
  wrapper.appendChild(backBtn);

  wrapper.appendChild(
    _createSectionHeading(situation.replace(/_/g, ' ').toUpperCase())
  );

  const statusRow = document.createElement('div');
  statusRow.classList.add('info-row');
  const statusMsg = document.createElement('span');
  statusMsg.classList.add('info-row__value');
  statusMsg.setAttribute('aria-live', 'polite');
  statusMsg.textContent = 'Loading...';
  statusRow.appendChild(statusMsg);
  wrapper.appendChild(statusRow);

  const listBlock = document.createElement('div');
  listBlock.classList.add('info-block');
  listBlock.dataset.testid = 'heuristics-by-situation';
  wrapper.appendChild(listBlock);

  backBtn.addEventListener('click', async function() {
    await _renderHeuristicsList({
      container: container,
      signal: signal,
      api: api,
      params: {},
      navigateTo: function() {}
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);

  try {
    const response = await api.get(
      API_PATHS.HEURISTICS + '?situation=' + encodeURIComponent(situation),
      { signal }
    );

    if (!response || signal.aborted) return;

    if (!response.success || !Array.isArray(response.heuristics)) {
      throw new Error('Unexpected response format from heuristics endpoint');
    }

    statusMsg.textContent = response.count + ' heuristic(s)';

    if (response.heuristics.length === 0) {
      const emptyRow = _createInfoRow('Result', 'No heuristics in this category');
      if (emptyRow) listBlock.appendChild(emptyRow);
      return;
    }

    for (let i = 0; i < response.heuristics.length; i++) {
      const h = response.heuristics[i];
      const hBtn = document.createElement('button');
      hBtn.type = 'button';
      hBtn.classList.add('menu-button', 'menu-button--sub');
      hBtn.dataset.testid = 'heuristic-item-' + i;
      hBtn.dataset.heuristicIndex = String(i);

      const contextText = h.beat_context ? '[' + h.beat_context + '] ' : '';
      const previewText = h.prompt_text
        ? (h.prompt_text.length > PROMPT_PREVIEW_LENGTH
            ? h.prompt_text.substring(0, PROMPT_PREVIEW_LENGTH) + '...'
            : h.prompt_text)
        : 'No prompt text';

      const hSpan = document.createElement('span');
      hSpan.textContent = contextText + previewText;
      hBtn.appendChild(hSpan);
      listBlock.appendChild(hBtn);
    }

    listBlock.addEventListener('click', function(e) {
      const target = e.target.closest('[data-heuristic-index]');
      if (target) {
        const idx = parseInt(target.dataset.heuristicIndex, 10);
        const h = response.heuristics[idx];
        if (h) {
          _renderHeuristicDetail(container, h, situation, signal, api);
        }
      }
    }, { signal });

  } catch (error) {
    statusMsg.textContent = 'Error: ' + error.message;
    _logError('Failed to load heuristics for situation', error);
  }
}

/**
 * Level 3 — Render single heuristic detail view.
 *
 * Displays the full heuristic record including prompt text, follow-up
 * question, source citation, applicable blueprints, beat positions,
 * and tags. Back button returns to Level 2 (situation list).
 *
 * Performs a shape guard on the heuristic object before rendering
 * to prevent silent failures from malformed API responses.
 *
 * @param {HTMLElement} container - Target DOM container
 * @param {object} heuristic - Heuristic data object from API
 * @param {string} fromSituation - Situation to return to on back
 * @param {AbortSignal} signal - Cancellation signal
 * @param {object} api - apiClient instance
 */
function _renderHeuristicDetail(container, heuristic, fromSituation, signal, api) {
  if (!heuristic || !heuristic.heuristic_id) {
    _logError('Invalid heuristic object passed to detail renderer', { heuristic });
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'heuristic-detail';

  const backBtn = _createBackButton();
  backBtn.setAttribute('aria-label', 'Back to heuristics list');
  backBtn.dataset.testid = 'heuristic-detail-back';
  wrapper.appendChild(backBtn);

  const detailBlock = document.createElement('div');
  detailBlock.classList.add('info-block');

  detailBlock.appendChild(
    _createSectionHeading('HEURISTIC DETAIL')
  );

  const fields = [
    { label: 'ID', value: heuristic.heuristic_id },
    { label: 'Situation', value: heuristic.situation ? heuristic.situation.replace(/_/g, ' ') : null },
    { label: 'Beat Context', value: heuristic.beat_context },
    { label: 'Prompt', value: heuristic.prompt_text },
    { label: 'Follow-up Question', value: heuristic.follow_up_question },
    { label: 'Source Author', value: heuristic.source_author },
    { label: 'Source Work', value: heuristic.source_work },
    { label: 'Source Year', value: heuristic.source_year },
  ];

  for (const f of fields) {
    const row = _createInfoRow(f.label, f.value);
    if (row) detailBlock.appendChild(row);
  }

  if (heuristic.applicable_blueprints && heuristic.applicable_blueprints.length > 0) {
    const bpRow = _createInfoRow('Applicable Blueprints', heuristic.applicable_blueprints.join(', '));
    if (bpRow) detailBlock.appendChild(bpRow);
  }

  if (heuristic.applicable_beat_positions && heuristic.applicable_beat_positions.length > 0) {
    const posRow = _createInfoRow('Beat Positions', heuristic.applicable_beat_positions.join(', '));
    if (posRow) detailBlock.appendChild(posRow);
  }

  if (heuristic.tags && heuristic.tags.length > 0) {
    const tagRow = _createInfoRow('Tags', heuristic.tags.join(', '));
    if (tagRow) detailBlock.appendChild(tagRow);
  }

  wrapper.appendChild(detailBlock);

  backBtn.addEventListener('click', async function() {
    if (fromSituation) {
      await _renderHeuristicsBySituation(container, fromSituation, signal, api);
    } else {
      await _renderHeuristicsList({
        container: container,
        signal: signal,
        api: api,
        params: {},
        navigateTo: function() {}
      });
    }
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}



/* ============================================================================
 * HANDLER REGISTRATION — Runs on import
 * ============================================================================
 * viewController.register() is called immediately when cmsBootstrap.js
 * dynamically imports this module. No manual init() call needed.
 * ============================================================================ */

viewController.register('narrative-blueprints', async (ctx) => {
  if (ctx.params.id) {
    await _renderBlueprintDetail(ctx);
  } else {
    await _renderBlueprintList(ctx);
  }
});

viewController.register('narrative-instances', async (ctx) => {
  if (ctx.params.id) {
    await _renderInstanceDetail(ctx);
  } else {
    await _renderInstanceList(ctx);
  }
});

viewController.register('narrative-heuristics', async (ctx) => {
  await _renderHeuristicsList(ctx);
});

_logInfo('Module loaded, 3 handlers registered');
