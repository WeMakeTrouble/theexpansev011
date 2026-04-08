/**
 * ============================================================================
 * Character Manager — Character Entity View Module for CMS Admin Tool
 * File: public/cms/js/modules/characterManager.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * View module handling all character-related views in the right-hand content
 * panel. Registers 9 handlers with viewController for each character sub-menu
 * item dispatched by adminMenu.js.
 *
 * VIEWS HANDLED:
 * ---------------------------------------------------------------------------
 * character-profiles        Profile info (name, category, status, settings)
 * character-personalities   Big Five + PAD + archetype + facets (by domain)
 * character-images          Media attachments (click-through to detail)
 * character-inventory       (Placeholder — needs backend endpoint)
 * character-knowledge       (Placeholder — needs backend endpoint)
 * character-psychic         (Placeholder — needs backend endpoint)
 * character-narratives      (Placeholder — needs backend endpoint)
 * character-progression     (Placeholder — needs backend endpoint)
 * character-sessions        (Placeholder — needs backend endpoint)
 *
 * NAVIGATION FLOW:
 * ---------------------------------------------------------------------------
 * adminMenu.js handles category -> character -> sub-section drill-down.
 * Each handler receives ctx.params.id as the character hex ID.
 * Detail data is fetched once and cached (_characterCache) to avoid
 * re-fetching when switching between sub-sections of the same character.
 *
 * API ENDPOINTS CONSUMED:
 * ---------------------------------------------------------------------------
 * GET /api/admin/characters/:id   Single character detail
 *   Returns: { success, character: { profile, personality, facets, images } }
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Rewrite)
 * Author: James (Project Manager)
 * Created: February 23, 2026
 * Updated: February 28, 2026
 * ============================================================================
 */

import viewController from '../viewController.js';
import dataTable from '../components/dataTable.js';
import toast from '../components/toastNotification.js';
import modal from '../components/modal.js';

/* ============================================================================
 * CONSTANTS
 * ============================================================================ */

const MODULE_NAME = 'characterManager';

const API_PATHS = Object.freeze({
  CHARACTER_DETAIL: '/characters/',
});

const BIG_FIVE_DOMAINS = Object.freeze([
  { key: 'openness', label: 'Openness', code: 'O' },
  { key: 'conscientiousness', label: 'Conscientiousness', code: 'C' },
  { key: 'extraversion', label: 'Extraversion', code: 'E' },
  { key: 'agreeableness', label: 'Agreeableness', code: 'A' },
  { key: 'neuroticism', label: 'Neuroticism', code: 'N' },
]);

const PERSONALITY_GROUP_KEYS = Object.freeze({
  BIG_FIVE: "bigfive",
  PAD: "pad",
  META: "meta",
  FACETS: "facets",
});

const NAV_BACK_LABEL = "\u2190 BACK";

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
 * STATE
 * ============================================================================ */

/** @type {{cleanup: function}|null} */
let _activeTable = null;

/**
 * Cached character detail data.
 * Avoids re-fetching when navigating between sub-sections of the same character.
 * Cleared when a different character is loaded.
 * @type {{characterId: string, data: object}|null}
 */
let _characterCache = null;

/* ============================================================================
 * CLEANUP
 * ============================================================================ */

function _cleanupActiveTable() {
  if (_activeTable && typeof _activeTable.cleanup === 'function') {
    _activeTable.cleanup();
  }
  _activeTable = null;
}

/* ============================================================================
 * DOM HELPERS
 * ============================================================================ */

/**
 * Create a section heading row.
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

/**
 * Create a label/value info row. Returns null if value is missing.
 * @param {string} label - Row label
 * @param {*} value - Row value
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
 * Create a score row with visual bar indicator.
 * @param {string} label - Score label
 * @param {number|null} value - Score value
 * @param {number} min - Minimum for percentage calc
 * @param {number} max - Maximum for percentage calc
 * @returns {HTMLElement}
 */
function _buildScoreRow(label, value, min, max) {
  const row = document.createElement('div');
  row.classList.add('info-row');

  const labelEl = document.createElement('span');
  labelEl.classList.add('info-row__label');
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const valueWrapper = document.createElement('span');
  valueWrapper.classList.add('info-row__value');

  if (value === null || value === undefined) {
    valueWrapper.textContent = '\u2014';
  } else {
    const numValue = Number(value);
    const percentage = ((numValue - min) / (max - min)) * 100;
    const clampedPct = Math.max(0, Math.min(100, percentage));

    const bar = document.createElement('span');
    bar.classList.add('score-bar');

    const fill = document.createElement('span');
    fill.classList.add('score-bar__fill');
    fill.style.width = clampedPct + '%';
    bar.appendChild(fill);

    valueWrapper.appendChild(bar);

    const numText = document.createElement('span');
    numText.textContent = ' ' + String(numValue);
    valueWrapper.appendChild(numText);
  }

  row.appendChild(valueWrapper);
  return row;
}

/**
 * Create a loading placeholder.
 * @param {string} label - What is loading
 * @returns {HTMLElement}
 */
function _createLoadingState(label) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  const block = document.createElement('div');
  block.classList.add('info-block');
  const row = document.createElement('div');
  row.classList.add('info-row');
  const msg = document.createElement('span');
  msg.classList.add('info-row__value');
  msg.setAttribute('aria-live', 'polite');
  msg.textContent = 'Loading ' + label + '...';
  row.appendChild(msg);
  block.appendChild(row);
  wrapper.appendChild(block);
  return wrapper;
}

/* ============================================================================
 * DATA FETCHER — Cached character detail
 * ============================================================================ */

/**
 * Fetch character detail, using cache if available for the same ID.
 *
 * @param {string} characterId - Hex ID of the character
 * @param {object} api - apiClient instance
 * @param {AbortSignal} signal - Cancellation signal
 * @returns {Promise<object|null>} Character data or null if failed/aborted
 */
async function _fetchCharacterDetail(characterId, api, signal) {
  if (_characterCache && _characterCache.characterId === characterId) {
    _logInfo('Cache hit for character', { characterId });
    return _characterCache.data;
  }

  _logInfo('Fetching character detail', { characterId });

  const response = await api.get(
    API_PATHS.CHARACTER_DETAIL + encodeURIComponent(characterId),
    { signal }
  );

  if (!response || signal.aborted) return null;

  if (!response.success || !response.character) {
    throw new Error('Unexpected response format from character detail endpoint');
  }

  _characterCache = {
    characterId: characterId,
    data: response.character,
  };

  return response.character;
}

/* ============================================================================
 * VIEW: character-profiles
 * ============================================================================ */

/**
 * Render character profile view.
 * Shows identity, status, settings, and metadata fields.
 *
 * @param {object} ctx - View context from viewController
 * @returns {Promise<void>}
 */
/**
 * Profile field groups for click-through navigation.
 * Each group becomes a button on Level 1.
 * @type {Array<{key: string, label: string, fields: function}>}
 */
const PROFILE_GROUPS = Object.freeze([
  {
    key: "identity",
    label: "IDENTITY",
    getFields: function(p) {
      return [
        { label: "Name", value: p.character_name, field: "character_name", type: "text", editable: true, maxLength: 100 },
        { label: "ID", value: p.character_id, field: "character_id", type: "readonly" },
        { label: "Category", value: p.category, field: "category", type: "readonly" },
        { label: "Status", value: p.is_active, field: "is_active", type: "toggle", editable: true },
      ];
    },
  },
  {
    key: "description",
    label: "DESCRIPTION",
    getFields: function(p) {
      return [
        { label: "Description", value: p.description, field: "description", type: "textarea", editable: true },
      ];
    },
  },
  {
    key: "settings",
    label: "SETTINGS",
    getFields: function(p) {
      var fields = [
        { label: "Location", value: p.current_location, field: "current_location", type: "text", editable: true, maxLength: 255 },
        { label: "Image URL", value: p.image_url, field: "image_url", type: "text", editable: true, maxLength: 255 },
        { label: "Trait Generation", value: p.trait_generation_enabled, field: "trait_generation_enabled", type: "toggle", editable: true },
        { label: "Forgetting Enabled", value: p.forgetting_enabled, field: "forgetting_enabled", type: "toggle", editable: true },
        { label: "Omiyage Give", value: p.omiyage_giving_affinity, field: "omiyage_giving_affinity", type: "slider", editable: true, min: 0, max: 100 },
        { label: "Omiyage Receive", value: p.omiyage_receiving_comfort, field: "omiyage_receiving_comfort", type: "slider", editable: true, min: 0, max: 100 },
      ];
      if (p.category === "B-Roll Chaos" || p.category === "Machines") {
        fields.splice(2, 0, { label: "B-Roll Autonomous", value: p.is_b_roll_autonomous, field: "is_b_roll_autonomous", type: "toggle", editable: true });
      }
      return fields;
    },
  },
  {
    key: "timestamps",
    label: "TIMESTAMPS",
    getFields: function(p) {
      return [
        { label: "Created", value: p.created_at ? new Date(p.created_at).toLocaleString("en-AU") : null, field: "created_at", type: "readonly" },
        { label: "Updated", value: p.updated_at ? new Date(p.updated_at).toLocaleString("en-AU") : null, field: "updated_at", type: "readonly" },
      ];
    },
  },
]);

/**
 * Level 1 — Render profile group buttons.
 *
 * @param {object} ctx - View context from viewController
 * @returns {Promise<void>}
 */
async function _renderProfile(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError("No character ID provided to profile view");
    return;
  }

  _logInfo("Rendering profile groups", { characterId });

  container.replaceChildren(_createLoadingState("profile"));

  try {
    const data = await _fetchCharacterDetail(characterId, api, signal);
    if (!data || signal.aborted) return;

    const { profile } = data;

    if (!profile || !profile.character_id) {
      _logError("Invalid profile data", { characterId });
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.classList.add("character-detail");
    wrapper.dataset.testid = "character-profile";
    wrapper.setAttribute("aria-live", "polite");

    const block = document.createElement("div");
    block.classList.add("info-block");

    block.appendChild(_createSectionHeading(profile.character_name || "PROFILE"));

    for (let i = 0; i < PROFILE_GROUPS.length; i++) {
      const group = PROFILE_GROUPS[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.classList.add("menu-button", "menu-button--sub");
      btn.dataset.testid = "profile-group-" + group.key;
      btn.dataset.groupIndex = String(i);
      btn.setAttribute("aria-label", group.label);
      const span = document.createElement("span");
      span.textContent = group.label;
      btn.appendChild(span);
      block.appendChild(btn);
    }

    block.addEventListener("click", function(e) {
      const target = e.target.closest("[data-group-index]");
      if (target) {
        const idx = parseInt(target.dataset.groupIndex, 10);
        const group = PROFILE_GROUPS[idx];
        if (group) {
          _renderProfileGroup(container, characterId, group, profile, signal, api);
        }
      }
    }, { signal });

    wrapper.appendChild(block);

    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError("Failed to render profile", error);
    const errBlock = document.createElement("div");
    errBlock.classList.add("info-block");
    const errRow = _createInfoRow("Error", error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

/**
 * Level 2 — Render fields within a single profile group.
 * Back button returns to Level 1 group buttons.
 *
 * @param {HTMLElement} container - Target DOM container
 * @param {string} characterId - Character hex ID
 * @param {object} group - Profile group definition
 * @param {object} profile - Profile data from API
 * @param {AbortSignal} signal - Cancellation signal
 * @param {object} api - apiClient instance
 */
function _renderProfileGroup(container, characterId, group, profile, signal, api) {
  const wrapper = document.createElement("div");
  wrapper.classList.add("character-detail");
  wrapper.dataset.testid = "profile-" + group.key;
  wrapper.setAttribute("aria-live", "polite");

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.classList.add("menu-button", "menu-button--nav");
  backBtn.setAttribute("aria-label", "Back to profile groups");
  backBtn.dataset.testid = "profile-group-back";
  const backSpan = document.createElement("span");
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const block = document.createElement("div");
  block.classList.add("info-block");

  block.appendChild(_createSectionHeading(group.label));

  const fields = group.getFields(profile);
  const inputRefs = {};
  var hasEditable = false;

  for (const f of fields) {
    if (!f.editable || f.type === "readonly") {
      var displayVal = f.value;
      if (typeof f.value === "boolean") displayVal = f.value ? "Yes" : "No";
      var row = _createInfoRow(f.label, displayVal);
      if (row) block.appendChild(row);
      continue;
    }

    hasEditable = true;
    var fieldRow = document.createElement("div");
    fieldRow.classList.add("info-row");
    fieldRow.dataset.testid = "edit-field-" + f.field;

    var labelEl = document.createElement("span");
    labelEl.classList.add("info-label");
    labelEl.textContent = f.label;
    fieldRow.appendChild(labelEl);

    if (f.type === "text") {
      var input = document.createElement("input");
      input.type = "text";
      input.classList.add("cms-input");
      input.value = f.value || "";
      if (f.maxLength) input.maxLength = f.maxLength;
      input.dataset.field = f.field;
      inputRefs[f.field] = input;
      fieldRow.appendChild(input);

    } else if (f.type === "textarea") {
      var textarea = document.createElement("textarea");
      textarea.classList.add("cms-textarea");
      textarea.value = f.value || "";
      textarea.rows = 5;
      textarea.dataset.field = f.field;
      inputRefs[f.field] = textarea;
      fieldRow.appendChild(textarea);

    } else if (f.type === "toggle") {
      var toggleWrap = document.createElement("div");
      toggleWrap.classList.add("cms-toggle-wrap");
      var toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.classList.add("cms-toggle");
      toggleBtn.dataset.field = f.field;
      toggleBtn.dataset.state = f.value ? "on" : "off";
      toggleBtn.textContent = f.value ? "ON" : "OFF";
      toggleBtn.setAttribute("aria-pressed", f.value ? "true" : "false");
      toggleBtn.addEventListener("click", function() {
        var current = this.dataset.state === "on";
        this.dataset.state = current ? "off" : "on";
        this.textContent = current ? "OFF" : "ON";
        this.setAttribute("aria-pressed", current ? "false" : "true");
      });
      inputRefs[f.field] = toggleBtn;
      toggleWrap.appendChild(toggleBtn);
      fieldRow.appendChild(toggleWrap);

    } else if (f.type === "slider") {
      var sliderWrap = document.createElement("div");
      sliderWrap.classList.add("cms-slider-wrap");
      var slider = document.createElement("input");
      slider.type = "range";
      slider.classList.add("cms-slider");
      slider.min = String(f.min || 0);
      slider.max = String(f.max || 100);
      slider.step = "1";
      slider.value = String(f.value != null ? f.value : 50);
      slider.dataset.field = f.field;
      let sliderVal = document.createElement("span");
      sliderVal.classList.add("cms-slider-value");
      sliderVal.textContent = slider.value;
      slider.addEventListener("input", function() {
        sliderVal.textContent = this.value;
      });
      inputRefs[f.field] = slider;
      sliderWrap.appendChild(slider);
      sliderWrap.appendChild(sliderVal);
      fieldRow.appendChild(sliderWrap);
    }

    block.appendChild(fieldRow);
  }

  if (hasEditable) {
    var statusEl = document.createElement("div");
    statusEl.classList.add("cms-save-status");
    statusEl.dataset.testid = "save-status";
    block.appendChild(statusEl);

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.classList.add("menu-button", "menu-button--save");
    saveBtn.dataset.testid = "profile-save";
    saveBtn.setAttribute("aria-label", "Save profile changes");
    var saveSpan = document.createElement("span");
    saveSpan.textContent = "SAVE";
    saveBtn.appendChild(saveSpan);
    block.appendChild(saveBtn);

    saveBtn.addEventListener("click", async function() {
      var updates = {};

      for (var key in inputRefs) {
        var el = inputRefs[key];
        if (el.tagName === "BUTTON") {
          updates[key] = el.dataset.state === "on";
        } else if (el.type === "range") {
          updates[key] = Number(el.value);
        } else {
          updates[key] = el.value || null;
        }
      }

      statusEl.textContent = "Saving...";
      statusEl.classList.remove("cms-save-error");
      saveBtn.disabled = true;

      try {
        var result = await api.put(
          '/characters/' + encodeURIComponent(characterId) + '/profile',
          updates
        );

        if (!result || signal.aborted) return;

        if (result.success) {
          statusEl.textContent = "Saved";
          setTimeout(function() { statusEl.textContent = ""; }, 2000);
        } else {
          statusEl.textContent = result.error || "Save failed";
          statusEl.classList.add("cms-save-error");
        }
      } catch (err) {
        statusEl.textContent = err.message || "Save failed";
        statusEl.classList.add("cms-save-error");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  wrapper.appendChild(block);

  backBtn.addEventListener("click", async function() {
    await _renderProfile({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}
/* ============================================================================
 * VIEW: character-personalities
 * ============================================================================
 * Level 1: Big Five scores + PAD baselines + archetype + meta
 *          Plus 5 domain buttons for facet drill-down
 * Level 2: Facets within a single Big Five domain
 * ============================================================================ */

/**
 * Render personality overview with domain facet click-through.
 *
 * @param {object} ctx - View context from viewController
 * @returns {Promise<void>}
 */
/**
 * Level 1 — Render personality group buttons.
 *
 * @param {object} ctx - View context from viewController
 * @returns {Promise<void>}
 */
async function _renderPersonality(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError("No character ID provided to personality view");
    return;
  }

  _logInfo("Rendering personality groups", { characterId });

  container.replaceChildren(_createLoadingState("personality"));

  try {
    const data = await _fetchCharacterDetail(characterId, api, signal);
    if (!data || signal.aborted) return;

    const { personality, facets } = data;

    const wrapper = document.createElement("div");
    wrapper.classList.add("character-detail");
    wrapper.dataset.testid = "character-personality";
    wrapper.setAttribute("aria-live", "polite");

    const block = document.createElement("div");
    block.classList.add("info-block");

    block.appendChild(_createSectionHeading("PERSONALITY"));

    if (!personality) {
      const row = _createInfoRow("Status", "No personality data found");
      if (row) block.appendChild(row);
      wrapper.appendChild(block);
      if (signal.aborted) return;
      container.replaceChildren(wrapper);
      return;
    }

    const groups = [
      { key: PERSONALITY_GROUP_KEYS.BIG_FIVE, label: "BIG FIVE" },
      { key: PERSONALITY_GROUP_KEYS.PAD, label: "PAD BASELINE" },
      { key: PERSONALITY_GROUP_KEYS.META, label: "ARCHETYPE & META" },
    ];

    if (facets && facets.length > 0) {
      groups.push({ key: PERSONALITY_GROUP_KEYS.FACETS, label: "FACETS (" + facets.length + ")" });
    }

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.classList.add("menu-button", "menu-button--sub");
      btn.dataset.testid = "personality-group-" + g.key;
      btn.dataset.groupKey = g.key;
      btn.setAttribute("aria-label", g.label);
      const span = document.createElement("span");
      span.textContent = g.label;
      btn.appendChild(span);
      block.appendChild(btn);
    }

    block.addEventListener("click", function(e) {
      const target = e.target.closest("[data-group-key]");
      if (target) {
        _renderPersonalityGroup(container, characterId, target.dataset.groupKey, personality, facets, signal, api);
      }
    }, { signal });

    wrapper.appendChild(block);

    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError("Failed to render personality", error);
    const errBlock = document.createElement("div");
    errBlock.classList.add("info-block");
    const errRow = _createInfoRow("Error", error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

/**
 * Level 2 — Render a single personality group.
 * Routes to score bars, info rows, or facet domain buttons
 * based on group key. Back button returns to Level 1.
 *
 * @param {HTMLElement} container - Target DOM container
 * @param {string} characterId - Character hex ID
 * @param {string} groupKey - Group identifier from PERSONALITY_GROUP_KEYS
 * @param {object} personality - Personality data from API
 * @param {Array<object>} facets - Facets array from API
 * @param {AbortSignal} signal - Cancellation signal
 * @param {object} api - apiClient instance
 */
function _renderPersonalityGroup(container, characterId, groupKey, personality, facets, signal, api) {
  const wrapper = document.createElement("div");
  wrapper.classList.add("character-detail");
  wrapper.dataset.testid = "personality-" + groupKey;
  wrapper.setAttribute("aria-live", "polite");

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.classList.add("menu-button", "menu-button--nav");
  backBtn.setAttribute("aria-label", "Back to personality groups");
  backBtn.dataset.testid = "personality-group-back";
  const backSpan = document.createElement("span");
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const block = document.createElement("div");
  block.classList.add("info-block");

  var inputRefs = {};
  var isDangerZone = false;

  if (groupKey === PERSONALITY_GROUP_KEYS.BIG_FIVE) {
    block.appendChild(_createSectionHeading("BIG FIVE (EDITABLE)"));
    isDangerZone = true;
    for (var i = 0; i < BIG_FIVE_DOMAINS.length; i++) {
      var domain = BIG_FIVE_DOMAINS[i];
      var row = document.createElement("div");
      row.classList.add("info-row");
      var label = document.createElement("span");
      label.classList.add("info-label");
      label.textContent = domain.label;
      row.appendChild(label);
      var sliderWrap = document.createElement("div");
      sliderWrap.classList.add("cms-slider-wrap");
      var slider = document.createElement("input");
      slider.type = "range";
      slider.classList.add("cms-slider");
      slider.min = "0";
      slider.max = "100";
      slider.step = "1";
      slider.value = String(personality[domain.key] != null ? personality[domain.key] : 50);
      slider.dataset.field = domain.key;
      var valSpan = document.createElement("span");
      valSpan.classList.add("cms-slider-value");
      valSpan.textContent = slider.value;
      slider.addEventListener("input", (function(vs) {
        return function() { vs.textContent = this.value; };
      })(valSpan));
      inputRefs[domain.key] = slider;
      sliderWrap.appendChild(slider);
      sliderWrap.appendChild(valSpan);
      row.appendChild(sliderWrap);
      block.appendChild(row);
    }

  } else if (groupKey === PERSONALITY_GROUP_KEYS.PAD) {
    block.appendChild(_createSectionHeading("PAD BASELINE (EDITABLE)"));
    isDangerZone = true;
    var padFields = [
      { label: "Pleasure", key: "pad_baseline_p" },
      { label: "Arousal", key: "pad_baseline_a" },
      { label: "Dominance", key: "pad_baseline_d" },
    ];
    for (var pi = 0; pi < padFields.length; pi++) {
      var pf = padFields[pi];
      var pRow = document.createElement("div");
      pRow.classList.add("info-row");
      var pLabel = document.createElement("span");
      pLabel.classList.add("info-label");
      pLabel.textContent = pf.label;
      pRow.appendChild(pLabel);
      var pSliderWrap = document.createElement("div");
      pSliderWrap.classList.add("cms-slider-wrap");
      var pSlider = document.createElement("input");
      pSlider.type = "range";
      pSlider.classList.add("cms-slider");
      pSlider.min = "-100";
      pSlider.max = "100";
      pSlider.step = "1";
      pSlider.value = String(Math.round((personality[pf.key] || 0) * 100));
      pSlider.dataset.field = pf.key;
      var pValSpan = document.createElement("span");
      pValSpan.classList.add("cms-slider-value");
      pValSpan.textContent = (Number(pSlider.value) / 100).toFixed(2);
      pSlider.addEventListener("input", (function(vs) {
        return function() { vs.textContent = (Number(this.value) / 100).toFixed(2); };
      })(pValSpan));
      inputRefs[pf.key] = pSlider;
      pSliderWrap.appendChild(pSlider);
      pSliderWrap.appendChild(pValSpan);
      pRow.appendChild(pSliderWrap);
      block.appendChild(pRow);
    }

  } else if (groupKey === PERSONALITY_GROUP_KEYS.META) {
    block.appendChild(_createSectionHeading("ARCHETYPE & META (EDITABLE)"));

    var archetypeRow = document.createElement("div");
    archetypeRow.classList.add("info-row");
    var arcLabel = document.createElement("span");
    arcLabel.classList.add("info-label");
    arcLabel.textContent = "Archetype";
    archetypeRow.appendChild(arcLabel);
    var arcRow = _createInfoRow("Archetype", personality.archetype_name || "None");
    if (arcRow) block.appendChild(arcRow);
    var arcIdRow = _createInfoRow("Archetype ID", personality.archetype_id);
    if (arcIdRow) block.appendChild(arcIdRow);
    var genRow = _createInfoRow("Generation", personality.archetype_generation);
    if (genRow) block.appendChild(genRow);

    var idiolectFields = [
      { label: "Idiolect Region", key: "idiolect_region", type: "text" },
      { label: "Idiolect Education", key: "idiolect_education_level", type: "text" },
      { label: "Idiolect Age", key: "idiolect_age", type: "number", min: 1, max: 200 },
    ];

    for (var mi = 0; mi < idiolectFields.length; mi++) {
      var mf = idiolectFields[mi];
      var mRow = document.createElement("div");
      mRow.classList.add("info-row");
      var mLabel = document.createElement("span");
      mLabel.classList.add("info-label");
      mLabel.textContent = mf.label;
      mRow.appendChild(mLabel);
      var mInput = document.createElement("input");
      mInput.type = mf.type;
      mInput.classList.add("cms-input");
      mInput.value = personality[mf.key] != null ? String(personality[mf.key]) : "";
      mInput.dataset.field = mf.key;
      if (mf.min !== undefined) mInput.min = String(mf.min);
      if (mf.max !== undefined) mInput.max = String(mf.max);
      inputRefs[mf.key] = mInput;
      mRow.appendChild(mInput);
      block.appendChild(mRow);
    }

    var dangerMeta = [
      { label: "Working Memory", key: "working_memory_capacity", min: 1, max: 10, step: 1 },
      { label: "Stress Threshold", key: "trait_activation_stress_threshold", min: 0, max: 100, step: 1, scale: 100 },
    ];

    isDangerZone = true;
    for (var di = 0; di < dangerMeta.length; di++) {
      var df = dangerMeta[di];
      var dRow = document.createElement("div");
      dRow.classList.add("info-row");
      var dLabel = document.createElement("span");
      dLabel.classList.add("info-label");
      dLabel.textContent = df.label;
      dRow.appendChild(dLabel);
      var dSliderWrap = document.createElement("div");
      dSliderWrap.classList.add("cms-slider-wrap");
      var dSlider = document.createElement("input");
      dSlider.type = "range";
      dSlider.classList.add("cms-slider");
      dSlider.min = String(df.min);
      dSlider.max = String(df.max);
      dSlider.step = String(df.step);
      var currentVal = personality[df.key] != null ? personality[df.key] : df.min;
      if (df.scale) currentVal = Math.round(currentVal * df.scale);
      dSlider.value = String(currentVal);
      dSlider.dataset.field = df.key;
      if (df.scale) dSlider.dataset.scale = String(df.scale);
      var dValSpan = document.createElement("span");
      dValSpan.classList.add("cms-slider-value");
      dValSpan.textContent = df.scale ? (Number(dSlider.value) / df.scale).toFixed(2) : dSlider.value;
      dSlider.addEventListener("input", (function(vs, sc) {
        return function() { vs.textContent = sc ? (Number(this.value) / sc).toFixed(2) : this.value; };
      })(dValSpan, df.scale || 0));
      inputRefs[df.key] = dSlider;
      dSliderWrap.appendChild(dSlider);
      dSliderWrap.appendChild(dValSpan);
      dRow.appendChild(dSliderWrap);
      block.appendChild(dRow);
    }

  } else if (groupKey === PERSONALITY_GROUP_KEYS.FACETS) {
    block.appendChild(_createSectionHeading("FACETS BY DOMAIN"));
    for (var fi = 0; fi < BIG_FIVE_DOMAINS.length; fi++) {
      var facetDomain = BIG_FIVE_DOMAINS[fi];
      var domainFacets = facets.filter(function(f) { return f.domain === facetDomain.code; });
      var count = domainFacets.length;
      var fBtn = document.createElement("button");
      fBtn.type = "button";
      fBtn.classList.add("menu-button", "menu-button--sub");
      fBtn.dataset.testid = "facet-domain-" + facetDomain.code;
      fBtn.dataset.domain = facetDomain.code;
      fBtn.setAttribute("aria-label", facetDomain.label + " facets");
      var fSpan = document.createElement("span");
      fSpan.textContent = facetDomain.label + " (" + count + " facets)";
      fBtn.appendChild(fSpan);
      block.appendChild(fBtn);
    }
    block.addEventListener("click", function(e) {
      var target = e.target.closest("[data-domain]");
      if (target) {
        _renderFacetsByDomain(container, characterId, target.dataset.domain, facets, signal, api);
      }
    }, { signal });
  }

  if (Object.keys(inputRefs).length > 0) {
    var statusEl = document.createElement("div");
    statusEl.classList.add("cms-save-status");
    statusEl.dataset.testid = "personality-save-status";
    block.appendChild(statusEl);

    if (isDangerZone) {
      var warnEl = document.createElement("div");
      warnEl.classList.add("cms-save-status", "cms-save-error");
      warnEl.textContent = "WARNING: These changes affect core personality and dialogue generation.";
      block.appendChild(warnEl);
    }

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.classList.add("menu-button", "menu-button--save");
    saveBtn.dataset.testid = "personality-save";
    saveBtn.setAttribute("aria-label", "Save personality changes");
    var saveSpan = document.createElement("span");
    saveSpan.textContent = "SAVE";
    saveBtn.appendChild(saveSpan);
    block.appendChild(saveBtn);

    saveBtn.addEventListener("click", async function() {
      if (isDangerZone) {
        var proceed = confirm("This will change core personality values that affect dialogue generation. Continue?");
        if (!proceed) return;
      }

      var updates = {};
      for (var key in inputRefs) {
        var el = inputRefs[key];
        if (el.type === "range") {
          var rawVal = Number(el.value);
          if (el.dataset.scale) {
            updates[key] = rawVal / Number(el.dataset.scale);
          } else if (key.indexOf("pad_baseline") === 0) {
            updates[key] = rawVal / 100;
          } else {
            updates[key] = rawVal;
          }
        } else if (el.type === "number") {
          updates[key] = el.value ? Number(el.value) : null;
        } else {
          updates[key] = el.value || null;
        }
      }

      if (isDangerZone) updates.confirmed = true;

      statusEl.textContent = "Saving...";
      statusEl.classList.remove("cms-save-error");
      saveBtn.disabled = true;

      try {
        var result = await api.put(
          '/characters/' + encodeURIComponent(characterId) + '/personality',
          updates
        );

        if (!result || signal.aborted) return;

        if (result.success) {
          statusEl.textContent = "Saved";
          setTimeout(function() { statusEl.textContent = ""; }, 2000);
        } else {
          statusEl.textContent = result.error || "Save failed";
          statusEl.classList.add("cms-save-error");
        }
      } catch (err) {
        statusEl.textContent = err.message || "Save failed";
        statusEl.classList.add("cms-save-error");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  wrapper.appendChild(block);

  backBtn.addEventListener("click", async function() {
    await _renderPersonality({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/**
 * Render facets for a single Big Five domain.
 * Back button returns to personality overview.
 *
 * @param {HTMLElement} container - Target DOM container
 * @param {string} characterId - Character hex ID
 * @param {string} domainCode - Single letter domain code (O, C, E, A, N)
 * @param {Array<object>} allFacets - Full facets array from API
 * @param {AbortSignal} signal - Cancellation signal
 * @param {object} api - apiClient instance
 */
function _renderFacetsByDomain(container, characterId, domainCode, allFacets, signal, api) {
  const domainFacets = allFacets
    .filter(function(f) { return f.domain === domainCode; })
    .sort(function(a, b) { return (a.facet_number || 0) - (b.facet_number || 0); });

  const domainInfo = BIG_FIVE_DOMAINS.find(function(d) { return d.code === domainCode; });
  const domainLabel = domainInfo ? domainInfo.label : domainCode;

  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'facets-' + domainCode;

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to personality overview');
  backBtn.dataset.testid = 'facets-back';
  const backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const block = document.createElement('div');
  block.classList.add('info-block');

  block.appendChild(_createSectionHeading(domainLabel.toUpperCase() + ' FACETS'));

  if (domainFacets.length === 0) {
    const row = _createInfoRow('Result', 'No facets recorded for this domain');
    if (row) block.appendChild(row);
  } else {
    for (const f of domainFacets) {
      block.appendChild(
        _buildScoreRow(f.facet_name || f.facet_code, f.score, 0, 100)
      );
      if (f.source) {
        const srcRow = _createInfoRow('Source', f.source);
        if (srcRow) block.appendChild(srcRow);
      }
    }
  }

  wrapper.appendChild(block);

  backBtn.addEventListener('click', async function() {
    await _renderPersonality({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/* ============================================================================
 * VIEW: character-images
 * ============================================================================
 * Level 1: Button per image (role + description)
 * Level 2: Full image detail
 * ============================================================================ */

/**
 * Render images list as click-through buttons.
 *
 * @param {object} ctx - View context from viewController
 * @returns {Promise<void>}
 */

/* ============================================================================
 * VIEW: character-images
 * ============================================================================
 * Shows attached images with thumbnails and role badges.
 * ASSIGN IMAGE button opens asset picker modal.
 * Each attachment has REMOVE and SET PRIMARY controls.
 * ============================================================================ */

/**
 * Render character images view with attach/remove controls.
 *
 * @param {object} ctx - View context from viewController
 */
async function _renderImages(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError('No character ID provided to images view');
    return;
  }

  _logInfo('Rendering images', { characterId });
  container.replaceChildren(_createLoadingState('images'));

  try {
    const data = await _fetchCharacterDetail(characterId, api, signal);
    if (!data || signal.aborted) return;

    const { images } = data;

    const wrapper = document.createElement('div');
    wrapper.classList.add('character-detail');
    wrapper.dataset.testid = 'character-images';
    wrapper.setAttribute('aria-live', 'polite');

    const block = document.createElement('div');
    block.classList.add('info-block');

    block.appendChild(_createSectionHeading('IMAGES'));

    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    assignBtn.classList.add('menu-button');
    assignBtn.dataset.testid = 'image-assign-btn';
    assignBtn.setAttribute('aria-label', 'Assign an image to this character');
    assignBtn.style.cssText = 'background:#00ff75; color:#000; border:none; padding:4px 12px; font-family:monospace; font-weight:bold; cursor:pointer; font-size:0.75em; margin-bottom:10px; display:block;';
    const assignSpan = document.createElement('span');
    assignSpan.textContent = '+ ASSIGN IMAGE';
    assignBtn.appendChild(assignSpan);
    assignBtn.addEventListener('click', () => {
      _openAssetPicker(characterId, api, signal, () => {
        _renderImages(ctx);
      });
    });
    block.appendChild(assignBtn);

    if (!images || images.length === 0) {
      const row = _createInfoRow('Status', 'No images attached');
      if (row) block.appendChild(row);
      wrapper.appendChild(block);
      if (signal.aborted) return;
      container.replaceChildren(wrapper);
      return;
    }

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const card = document.createElement('div');
      card.classList.add('info-block');
      card.dataset.testid = 'image-card-' + i;
      card.style.cssText = 'border:1px solid #004422; padding:8px; margin-bottom:8px; background:#0a0a0a; display:flex; gap:8px; align-items:flex-start;';

      const hexDigits = img.asset_id ? img.asset_id.replace('#', '') : '';
      const thumb = document.createElement('img');
      thumb.src = hexDigits ? '/assets/' + hexDigits + '/thumbnail.png' : '';
      thumb.alt = img.attachment_role || 'attachment';
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      thumb.style.cssText = 'width:48px; height:48px; object-fit:cover; border:1px solid #004422; image-rendering:pixelated; flex-shrink:0;';
      thumb.onerror = function() {
        this.style.cssText = 'width:48px; height:48px; background:#001a0a; border:1px solid #004422; flex-shrink:0;';
      };
      card.appendChild(thumb);

      const info = document.createElement('div');
      info.style.cssText = 'flex:1; min-width:0; font-family:monospace;';

      const roleTag = document.createElement('div');
      roleTag.style.cssText = img.attachment_role === 'primary'
        ? 'color:#000; background:#00ff75; display:inline-block; padding:1px 6px; font-size:0.7em; font-weight:bold; margin-bottom:4px;'
        : 'color:#00ff75; border:1px solid #004422; display:inline-block; padding:1px 6px; font-size:0.7em; margin-bottom:4px;';
      roleTag.textContent = (img.attachment_role || 'gallery').toUpperCase();
      info.appendChild(roleTag);

      const assetRow = document.createElement('div');
      assetRow.style.cssText = 'color:#008844; font-size:0.65em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      assetRow.textContent = img.asset_id + (img.original_filename ? ' — ' + img.original_filename : '');
      info.appendChild(assetRow);

      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex; gap:4px; margin-top:4px;';

      if (img.attachment_role !== 'primary') {
        const primaryBtn = document.createElement('button');
        primaryBtn.type = 'button';
        primaryBtn.dataset.testid = 'image-set-primary-' + i;
        primaryBtn.textContent = 'SET PRIMARY';
        primaryBtn.style.cssText = 'background:transparent; color:#00ff75; border:1px solid #00ff75; padding:2px 6px; font-family:monospace; font-size:0.6em; cursor:pointer;';
        primaryBtn.addEventListener('click', async function(e) {
          e.stopPropagation();
          try {
            const result = await api.post('/assets/attach', {
              entityType: 'character',
              entityId: characterId,
              assetId: img.asset_id,
              role: 'primary'
            });
            if (result && result.success) {
              toast.success('Set as primary');
              _renderImages(ctx);
            } else {
              toast.error(result?.error || 'Failed');
            }
          } catch (err) {
            _logError('Set primary failed', err);
            toast.error('Failed to set primary');
          }
        });
        controls.appendChild(primaryBtn);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.dataset.testid = 'image-remove-' + i;
      removeBtn.textContent = 'REMOVE';
      removeBtn.style.cssText = 'background:transparent; color:#ff4444; border:1px solid #ff4444; padding:2px 6px; font-family:monospace; font-size:0.6em; cursor:pointer;';
      removeBtn.addEventListener('click', async function(e) {
        e.stopPropagation();
        try {
          const result = await api.delete('/assets/attach/' + encodeURIComponent(img.attachment_id));
          if (result && result.success) {
            toast.success('Removed');
            _renderImages(ctx);
          } else {
            toast.error(result?.error || 'Failed to remove');
          }
        } catch (err) {
          _logError('Remove attachment failed', err);
          toast.error('Failed to remove');
        }
      });
      controls.appendChild(removeBtn);

      info.appendChild(controls);
      card.appendChild(info);
      block.appendChild(card);
    }

    wrapper.appendChild(block);

    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError('Failed to render images', error);
    const errBlock = document.createElement('div');
    errBlock.classList.add('info-block');
    const errRow = _createInfoRow('Error', error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

/**
 * Open asset picker modal for assigning an image to a character.
 * Shows all available assets with thumbnails and role selector.
 *
 * @param {string} characterId - Character hex ID
 * @param {object} api - apiClient instance
 * @param {AbortSignal} signal - Cancellation signal
 * @param {function} onAttach - Callback after successful attachment
 */
async function _openAssetPicker(characterId, api, signal, onAttach) {
  const content = document.createElement('div');
  content.dataset.testid = 'asset-picker';
  content.style.cssText = 'font-family:monospace;';

  const statusDiv = document.createElement('div');
  statusDiv.style.cssText = 'color:#008844; font-size:0.8em; margin-bottom:12px;';
  statusDiv.textContent = 'Loading assets...';
  content.appendChild(statusDiv);

  modal.open(content, { title: 'ASSIGN IMAGE TO CHARACTER' });

  try {
    const data = await api.get('/assets', { signal });

    if (!data || !data.success || !data.assets) {
      statusDiv.textContent = 'Failed to load assets';
      statusDiv.style.color = '#ff4444';
      return;
    }

    if (data.assets.length === 0) {
      statusDiv.textContent = 'No assets available. Upload images in Media > Assets first.';
      return;
    }

    statusDiv.textContent = data.assets.length + ' asset' + (data.assets.length !== 1 ? 's' : '') + ' available. Click to attach.';

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px; margin-top:10px;';

    for (const asset of data.assets) {
      const cell = document.createElement('div');
      cell.dataset.testid = 'picker-asset-' + asset.asset_id;
      cell.style.cssText = 'border:1px solid #004422; padding:8px; background:#050505;';

      const hexDigits = asset.asset_id.replace('#', '');
      const thumb = document.createElement('img');
      thumb.src = '/assets/' + hexDigits + '/thumbnail.png';
      thumb.alt = asset.asset_id;
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      thumb.style.cssText = 'width:100%; height:auto; max-height:120px; object-fit:cover; border:1px solid #002211; image-rendering:pixelated; margin-bottom:6px;';
      thumb.onerror = function() {
        this.style.cssText = 'width:100%; height:60px; background:#001a0a; border:1px solid #002211; margin-bottom:6px;';
      };
      cell.appendChild(thumb);

      const idLabel = document.createElement('div');
      idLabel.style.cssText = 'color:#00ff75; font-size:0.7em; font-weight:bold; margin-bottom:4px;';
      idLabel.textContent = asset.asset_id;
      cell.appendChild(idLabel);

      if (asset.original_filename) {
        const nameLabel = document.createElement('div');
        nameLabel.style.cssText = 'color:#008844; font-size:0.6em; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        nameLabel.textContent = asset.original_filename;
        cell.appendChild(nameLabel);
      }

      const roleRow = document.createElement('div');
      roleRow.style.cssText = 'display:flex; gap:4px; align-items:center;';

      const roleSelect = document.createElement('select');
      roleSelect.dataset.testid = 'picker-role-' + asset.asset_id;
      roleSelect.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; padding:2px 4px; font-size:0.65em; flex:1;';
      var roles = ['gallery', 'primary', 'thumbnail', 'background'];
      for (var r = 0; r < roles.length; r++) {
        var opt = document.createElement('option');
        opt.value = roles[r];
        opt.textContent = roles[r].toUpperCase();
        roleSelect.appendChild(opt);
      }
      roleRow.appendChild(roleSelect);

      const attachBtn = document.createElement('button');
      attachBtn.type = 'button';
      attachBtn.dataset.testid = 'picker-attach-' + asset.asset_id;
      attachBtn.textContent = 'ATTACH';
      attachBtn.style.cssText = 'background:#00ff75; color:#000; border:none; padding:2px 8px; font-family:monospace; font-weight:bold; font-size:0.65em; cursor:pointer;';
      attachBtn.addEventListener('click', async function() {
        attachBtn.disabled = true;
        attachBtn.textContent = '...';
        try {
          var result = await api.post('/assets/attach', {
            entityType: 'character',
            entityId: characterId,
            assetId: asset.asset_id,
            role: roleSelect.value
          });
          if (result && result.success) {
            toast.success('Attached ' + asset.asset_id + ' as ' + roleSelect.value);
            modal.close();
            if (onAttach) onAttach();
          } else {
            toast.error(result?.error || 'Attach failed');
            attachBtn.disabled = false;
            attachBtn.textContent = 'ATTACH';
          }
        } catch (err) {
          _logError('Attach failed', err);
          toast.error('Attach failed');
          attachBtn.disabled = false;
          attachBtn.textContent = 'ATTACH';
        }
      });
      roleRow.appendChild(attachBtn);

      cell.appendChild(roleRow);
      grid.appendChild(cell);
    }

    content.appendChild(grid);

  } catch (err) {
    if (err.name === 'AbortError') return;
    _logError('Asset picker load failed', err);
    statusDiv.textContent = 'Error loading assets';
    statusDiv.style.color = '#ff4444';
  }
}



/* ============================================================================
 * VIEW: character-inventory
 * ============================================================================
 * Level 1: Button per inventory item (object name + type)
 * Level 2: Full item detail (object info, PAD, source, slot)
 * ============================================================================ */

async function _renderInventory(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError('No character ID provided to inventory view');
    return;
  }

  _logInfo('Rendering inventory', { characterId });
  container.replaceChildren(_createLoadingState('inventory'));

  try {
    const response = await api.get(
      API_PATHS.CHARACTER_DETAIL + encodeURIComponent(characterId) + '/inventory',
      { signal }
    );

    if (!response || signal.aborted) return;

    if (!response.success || !Array.isArray(response.inventory)) {
      throw new Error('Unexpected response format from inventory endpoint');
    }

    const wrapper = document.createElement('div');
    wrapper.classList.add('character-detail');
    wrapper.dataset.testid = 'character-inventory';
    wrapper.setAttribute('aria-live', 'polite');

    const block = document.createElement('div');
    block.classList.add('info-block');
    block.appendChild(_createSectionHeading('INVENTORY (' + response.count + ')'));

    if (response.inventory.length === 0) {
      const row = _createInfoRow('Status', 'No items in inventory');
      if (row) block.appendChild(row);
      wrapper.appendChild(block);
      if (signal.aborted) return;
      container.replaceChildren(wrapper);
      return;
    }

    for (let i = 0; i < response.inventory.length; i++) {
      const item = response.inventory[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('menu-button', 'menu-button--sub');
      btn.dataset.testid = 'inventory-item-' + i;
      btn.dataset.itemIndex = String(i);
      btn.setAttribute('aria-label', 'View ' + (item.object_name || 'item'));
      const span = document.createElement('span');
      const typeText = item.object_type ? ' [' + item.object_type + ']' : '';
      span.textContent = (item.object_name || 'Unknown Object') + typeText;
      btn.appendChild(span);
      block.appendChild(btn);
    }

    block.addEventListener('click', function(e) {
      const target = e.target.closest('[data-item-index]');
      if (target) {
        const idx = parseInt(target.dataset.itemIndex, 10);
        const item = response.inventory[idx];
        if (item) {
          _renderInventoryDetail(container, characterId, item, signal, api);
        }
      }
    }, { signal });

    wrapper.appendChild(block);
    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError('Failed to render inventory', error);
    const errBlock = document.createElement('div');
    errBlock.classList.add('info-block');
    const errRow = _createInfoRow('Error', error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

function _renderInventoryDetail(container, characterId, item, signal, api) {
  if (!item || !item.inventory_entry_id) {
    _logError('Invalid inventory item', { item });
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'inventory-detail';
  wrapper.setAttribute('aria-live', 'polite');

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to inventory list');
  backBtn.dataset.testid = 'inventory-detail-back';
  const backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const objectBlock = document.createElement('div');
  objectBlock.classList.add('info-block');
  objectBlock.appendChild(_createSectionHeading(item.object_name || 'OBJECT'));

  const objectFields = [
    { label: 'Object ID', value: item.object_id },
    { label: 'Type', value: item.object_type },
    { label: 'Rarity', value: item.rarity },
    { label: 'Description', value: item.object_description },
    { label: 'Alignment', value: item.alignment },
    { label: 'Psychic Signature', value: item.psychic_signature },
  ];

  for (const f of objectFields) {
    const row = _createInfoRow(f.label, f.value);
    if (row) objectBlock.appendChild(row);
  }

  if (item.object_p !== null || item.object_a !== null || item.object_d !== null) {
    objectBlock.appendChild(_buildScoreRow('Pleasure', item.object_p, -1, 1));
    objectBlock.appendChild(_buildScoreRow('Arousal', item.object_a, -1, 1));
    objectBlock.appendChild(_buildScoreRow('Dominance', item.object_d, -1, 1));
    objectBlock.appendChild(_buildScoreRow('Entropy', item.creation_entropy, -1, 1));
    objectBlock.appendChild(_buildScoreRow('Order/Chaos', item.order_chaos, -1, 1));
  }

  wrapper.appendChild(objectBlock);

  const acqBlock = document.createElement('div');
  acqBlock.classList.add('info-block');
  acqBlock.appendChild(_createSectionHeading('ACQUISITION'));

  const acqFields = [
    { label: 'Entry ID', value: item.inventory_entry_id },
    { label: 'Slot Trait', value: item.slot_trait_hex_id },
    { label: 'Method', value: item.acquisition_method },
    { label: 'Binding', value: item.binding_type },
    { label: 'Source', value: item.source_character_name },
    { label: 'Acquired', value: item.acquired_at ? new Date(item.acquired_at).toLocaleString('en-AU') : null },
  ];

  for (const f of acqFields) {
    const row = _createInfoRow(f.label, f.value);
    if (row) acqBlock.appendChild(row);
  }

  wrapper.appendChild(acqBlock);

  var xferBlock = document.createElement('div');
  xferBlock.classList.add('info-block');
  xferBlock.appendChild(_createSectionHeading('TRANSFER'));

  var xferStatus = document.createElement('div');
  xferStatus.classList.add('cms-save-status');
  xferStatus.dataset.testid = 'transfer-status';

  var targetRow = document.createElement('div');
  targetRow.classList.add('info-row');
  targetRow.dataset.testid = 'transfer-target';
  var targetLabel = document.createElement('span');
  targetLabel.classList.add('info-label');
  targetLabel.textContent = 'Transfer To';
  targetRow.appendChild(targetLabel);
  var targetSelect = document.createElement('select');
  targetSelect.classList.add('cms-input');
  targetSelect.dataset.testid = 'transfer-target-select';
  var loadingOpt = document.createElement('option');
  loadingOpt.value = '';
  loadingOpt.textContent = 'Loading characters...';
  targetSelect.appendChild(loadingOpt);
  targetSelect.disabled = true;
  targetRow.appendChild(targetSelect);
  xferBlock.appendChild(targetRow);

  var reasonRow = document.createElement('div');
  reasonRow.classList.add('info-row');
  reasonRow.dataset.testid = 'transfer-reason';
  var reasonLabel = document.createElement('span');
  reasonLabel.classList.add('info-label');
  reasonLabel.textContent = 'Reason';
  reasonRow.appendChild(reasonLabel);
  var reasonInput = document.createElement('input');
  reasonInput.type = 'text';
  reasonInput.classList.add('cms-input');
  reasonInput.value = 'admin_transfer';
  reasonInput.maxLength = 100;
  reasonRow.appendChild(reasonInput);
  xferBlock.appendChild(reasonRow);

  var bindRow = document.createElement('div');
  bindRow.classList.add('info-row');
  bindRow.dataset.testid = 'transfer-binding';
  var bindLabel = document.createElement('span');
  bindLabel.classList.add('info-label');
  bindLabel.textContent = 'New Binding';
  bindRow.appendChild(bindLabel);
  var bindInput = document.createElement('input');
  bindInput.type = 'text';
  bindInput.classList.add('cms-input');
  bindInput.value = item.binding_type || '';
  bindRow.appendChild(bindInput);
  xferBlock.appendChild(bindRow);

  xferBlock.appendChild(xferStatus);

  var xferBtn = document.createElement('button');
  xferBtn.type = 'button';
  xferBtn.classList.add('menu-button', 'menu-button--save');
  xferBtn.dataset.testid = 'transfer-submit';
  xferBtn.setAttribute('aria-label', 'Transfer object');
  xferBtn.disabled = true;
  var xferSpan = document.createElement('span');
  xferSpan.textContent = 'TRANSFER';
  xferBtn.appendChild(xferSpan);
  xferBlock.appendChild(xferBtn);

  wrapper.appendChild(xferBlock);

  (async function() {
    try {
      var charList = await api.get('/characters/', { signal });
      if (!charList || signal.aborted) return;
      targetSelect.innerHTML = '';
      var defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '-- Select character --';
      targetSelect.appendChild(defaultOpt);
      var chars = charList.characters || [];
      for (var i = 0; i < chars.length; i++) {
        if (chars[i].character_id === characterId) continue;
        var opt = document.createElement('option');
        opt.value = chars[i].character_id;
        opt.textContent = chars[i].character_name + ' (' + chars[i].character_id + ')';
        targetSelect.appendChild(opt);
      }
      targetSelect.disabled = false;
      xferBtn.disabled = false;
    } catch (err) {
      xferStatus.textContent = 'Failed to load characters';
      xferStatus.classList.add('cms-save-error');
    }
  })();

  xferBtn.addEventListener('click', async function() {
    var toId = targetSelect.value;
    if (!toId) {
      xferStatus.textContent = 'Select a target character';
      xferStatus.classList.add('cms-save-error');
      return;
    }

    var targetName = targetSelect.options[targetSelect.selectedIndex].textContent;
    var objectName = item.object_name || item.object_id;
    var confirmed = confirm('Transfer "' + objectName + '" to ' + targetName + '?');
    if (!confirmed) return;

    xferStatus.textContent = 'Transferring...';
    xferStatus.classList.remove('cms-save-error');
    xferBtn.disabled = true;

    try {
      var result = await api.post(
        '/characters/' + encodeURIComponent(characterId) + '/inventory/transfer',
        {
          object_id: item.object_id,
          to_character_id: toId,
          transfer_reason: reasonInput.value || 'admin_transfer',
          new_binding_type: bindInput.value || null,
        }
      );

      if (!result || signal.aborted) return;

      if (result.success) {
        xferStatus.textContent = 'Transferred (' + result.transfer.transfer_id + ')';
        setTimeout(function() {
          _renderInventory({
            container: container,
            params: { id: characterId },
            signal: signal,
            api: api,
          });
        }, 1500);
      } else {
        xferStatus.textContent = result.error || 'Transfer failed';
        xferStatus.classList.add('cms-save-error');
        xferBtn.disabled = false;
      }
    } catch (err) {
      xferStatus.textContent = err.message || 'Transfer failed';
      xferStatus.classList.add('cms-save-error');
      xferBtn.disabled = false;
    }
  }, { once: true });

  backBtn.addEventListener('click', async function() {
    await _renderInventory({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/* ============================================================================
 * VIEW: character-knowledge
 * ============================================================================
 * Level 1: Button per knowledge item (concept + domain)
 * Level 2: Full item detail (FSRS state, content, metadata)
 * ============================================================================ */

async function _renderKnowledge(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError('No character ID provided to knowledge view');
    return;
  }

  _logInfo('Rendering knowledge', { characterId });
  container.replaceChildren(_createLoadingState('knowledge'));

  try {
    const response = await api.get(
      API_PATHS.CHARACTER_DETAIL + encodeURIComponent(characterId) + '/knowledge',
      { signal }
    );

    if (!response || signal.aborted) return;

    if (!response.success || !Array.isArray(response.knowledge)) {
      throw new Error('Unexpected response format from knowledge endpoint');
    }

    const wrapper = document.createElement('div');
    wrapper.classList.add('character-detail');
    wrapper.dataset.testid = 'character-knowledge';
    wrapper.setAttribute('aria-live', 'polite');

    const block = document.createElement('div');
    block.classList.add('info-block');
    block.appendChild(_createSectionHeading('KNOWLEDGE (' + response.count + ')'));

    if (response.knowledge.length === 0) {
      const row = _createInfoRow('Status', 'No knowledge items');
      if (row) block.appendChild(row);
      wrapper.appendChild(block);
      if (signal.aborted) return;
      container.replaceChildren(wrapper);
      return;
    }

    for (let i = 0; i < response.knowledge.length; i++) {
      const item = response.knowledge[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('menu-button', 'menu-button--sub');
      btn.dataset.testid = 'knowledge-item-' + i;
      btn.dataset.itemIndex = String(i);
      const label = (item.concept || 'Unknown') + (item.domain_name ? ' [' + item.domain_name + ']' : '');
      btn.setAttribute('aria-label', 'View ' + label);
      const span = document.createElement('span');
      const statusIcon = item.is_mastered ? ' \u2713' : item.is_forgotten ? ' \u2717' : '';
      span.textContent = label + statusIcon;
      btn.appendChild(span);
      block.appendChild(btn);
    }

    block.addEventListener('click', function(e) {
      const target = e.target.closest('[data-item-index]');
      if (target) {
        const idx = parseInt(target.dataset.itemIndex, 10);
        const item = response.knowledge[idx];
        if (item) {
          _renderKnowledgeDetail(container, characterId, item, signal, api);
        }
      }
    }, { signal });

    wrapper.appendChild(block);
    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError('Failed to render knowledge', error);
    const errBlock = document.createElement('div');
    errBlock.classList.add('info-block');
    const errRow = _createInfoRow('Error', error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

function _renderKnowledgeDetail(container, characterId, item, signal, api) {
  if (!item || !item.knowledge_id) {
    _logError('Invalid knowledge item', { item });
    return;
  }

  var wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'knowledge-detail';
  wrapper.setAttribute('aria-live', 'polite');

  var backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to knowledge list');
  backBtn.dataset.testid = 'knowledge-detail-back';
  var backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  var block = document.createElement('div');
  block.classList.add('info-block');
  block.appendChild(_createSectionHeading(item.concept || 'KNOWLEDGE ITEM'));

  var groups = [
    { key: 'item-info', label: 'ITEM INFO' },
    { key: 'fsrs-state', label: 'FSRS STATE' },
    { key: 'edit-state', label: 'EDIT STATE' },
  ];

  for (var i = 0; i < groups.length; i++) {
    var grpBtn = document.createElement('button');
    grpBtn.type = 'button';
    grpBtn.classList.add('menu-button', 'menu-button--sub');
    grpBtn.dataset.testid = 'knowledge-group-' + groups[i].key;
    grpBtn.dataset.groupIndex = String(i);
    grpBtn.setAttribute('aria-label', groups[i].label);
    var grpSpan = document.createElement('span');
    grpSpan.textContent = groups[i].label;
    grpBtn.appendChild(grpSpan);
    block.appendChild(grpBtn);
  }

  block.addEventListener('click', function(e) {
    var target = e.target.closest('[data-group-index]');
    if (target) {
      var idx = parseInt(target.dataset.groupIndex, 10);
      var grp = groups[idx];
      if (grp) {
        _renderKnowledgeSubGroup(container, characterId, item, grp, signal, api);
      }
    }
  }, { signal });

  wrapper.appendChild(block);

  backBtn.addEventListener('click', async function() {
    await _renderKnowledge({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

function _renderKnowledgeSubGroup(container, characterId, item, group, signal, api) {
  var wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'knowledge-' + group.key;
  wrapper.setAttribute('aria-live', 'polite');

  var backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to knowledge groups');
  backBtn.dataset.testid = 'knowledge-subgroup-back';
  var backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  var block = document.createElement('div');
  block.classList.add('info-block');
  block.appendChild(_createSectionHeading(group.label));

  if (group.key === 'item-info') {
    var itemFields = [
      { label: 'Knowledge ID', value: item.knowledge_id },
      { label: 'Domain', value: item.domain_name },
      { label: 'Content', value: item.content },
      { label: 'Answer', value: item.answer_statement },
      { label: 'Source Type', value: item.source_type },
      { label: 'Attribution', value: item.source_attribution },
      { label: 'Entry Type', value: item.entry_type },
      { label: 'Belt Level', value: item.belt_level },
    ];

    for (var fi = 0; fi < itemFields.length; fi++) {
      var row = _createInfoRow(itemFields[fi].label, itemFields[fi].value);
      if (row) block.appendChild(row);
    }

    block.appendChild(_buildScoreRow('Complexity', item.complexity_score, 0, 1));

  } else if (group.key === 'fsrs-state') {
    block.appendChild(_buildScoreRow('Retrievability', item.current_retrievability, 0, 1));
    block.appendChild(_buildScoreRow('Stability', item.stability, 0, 100));
    block.appendChild(_buildScoreRow('Difficulty', item.difficulty, 0, 10));
    block.appendChild(_buildScoreRow('Expertise', item.current_expertise_score, 0, 100));

    var stateFields = [
      { label: 'Mastered', value: item.is_mastered ? 'Yes' : 'No' },
      { label: 'Forgotten', value: item.is_forgotten ? 'Yes' : 'No' },
      { label: 'Acquisition Done', value: item.acquisition_completed ? 'Yes' : 'No' },
      { label: 'Method', value: item.acquisition_method },
      { label: 'Practice Count', value: item.practice_count },
      { label: 'Last Review', value: item.last_review_timestamp ? new Date(item.last_review_timestamp).toLocaleString('en-AU') : null },
      { label: 'Next Review', value: item.next_review_timestamp ? new Date(item.next_review_timestamp).toLocaleString('en-AU') : null },
    ];

    for (var si = 0; si < stateFields.length; si++) {
      var sRow = _createInfoRow(stateFields[si].label, stateFields[si].value);
      if (sRow) block.appendChild(sRow);
    }

  } else if (group.key === 'edit-state') {
    var editStatus = document.createElement('div');
    editStatus.classList.add('cms-save-status');
    editStatus.dataset.testid = 'knowledge-save-status';

    var editRefs = {};

    var masteredRow = document.createElement('div');
    masteredRow.classList.add('info-row');
    masteredRow.dataset.testid = 'edit-field-is_mastered';
    var masteredLabel = document.createElement('span');
    masteredLabel.classList.add('info-label');
    masteredLabel.textContent = 'Mastered';
    masteredRow.appendChild(masteredLabel);
    var masteredBtn = document.createElement('button');
    masteredBtn.type = 'button';
    masteredBtn.classList.add('cms-toggle');
    masteredBtn.dataset.state = item.is_mastered ? 'on' : 'off';
    masteredBtn.textContent = item.is_mastered ? 'YES' : 'NO';
    masteredBtn.addEventListener('click', function() {
      if (masteredBtn.dataset.state === 'on') {
        masteredBtn.dataset.state = 'off';
        masteredBtn.textContent = 'NO';
      } else {
        masteredBtn.dataset.state = 'on';
        masteredBtn.textContent = 'YES';
      }
    });
    editRefs.is_mastered = masteredBtn;
    masteredRow.appendChild(masteredBtn);
    block.appendChild(masteredRow);

    var forgottenRow = document.createElement('div');
    forgottenRow.classList.add('info-row');
    forgottenRow.dataset.testid = 'edit-field-is_forgotten';
    var forgottenLabel = document.createElement('span');
    forgottenLabel.classList.add('info-label');
    forgottenLabel.textContent = 'Forgotten';
    forgottenRow.appendChild(forgottenLabel);
    var forgottenBtn = document.createElement('button');
    forgottenBtn.type = 'button';
    forgottenBtn.classList.add('cms-toggle');
    forgottenBtn.dataset.state = item.is_forgotten ? 'on' : 'off';
    forgottenBtn.textContent = item.is_forgotten ? 'YES' : 'NO';
    forgottenBtn.addEventListener('click', function() {
      if (forgottenBtn.dataset.state === 'on') {
        forgottenBtn.dataset.state = 'off';
        forgottenBtn.textContent = 'NO';
      } else {
        forgottenBtn.dataset.state = 'on';
        forgottenBtn.textContent = 'YES';
      }
    });
    editRefs.is_forgotten = forgottenBtn;
    forgottenRow.appendChild(forgottenBtn);
    block.appendChild(forgottenRow);

    var acqDoneRow = document.createElement('div');
    acqDoneRow.classList.add('info-row');
    acqDoneRow.dataset.testid = 'edit-field-acquisition_completed';
    var acqDoneLabel = document.createElement('span');
    acqDoneLabel.classList.add('info-label');
    acqDoneLabel.textContent = 'Acquisition Done';
    acqDoneRow.appendChild(acqDoneLabel);
    var acqDoneBtn = document.createElement('button');
    acqDoneBtn.type = 'button';
    acqDoneBtn.classList.add('cms-toggle');
    acqDoneBtn.dataset.state = item.acquisition_completed ? 'on' : 'off';
    acqDoneBtn.textContent = item.acquisition_completed ? 'YES' : 'NO';
    acqDoneBtn.addEventListener('click', function() {
      if (acqDoneBtn.dataset.state === 'on') {
        acqDoneBtn.dataset.state = 'off';
        acqDoneBtn.textContent = 'NO';
      } else {
        acqDoneBtn.dataset.state = 'on';
        acqDoneBtn.textContent = 'YES';
      }
    });
    editRefs.acquisition_completed = acqDoneBtn;
    acqDoneRow.appendChild(acqDoneBtn);
    block.appendChild(acqDoneRow);

    var methodRow = document.createElement('div');
    methodRow.classList.add('info-row');
    methodRow.dataset.testid = 'edit-field-acquisition_method';
    var methodLabel = document.createElement('span');
    methodLabel.classList.add('info-label');
    methodLabel.textContent = 'Method';
    methodRow.appendChild(methodLabel);
    var methodInput = document.createElement('input');
    methodInput.type = 'text';
    methodInput.classList.add('cms-input');
    methodInput.value = item.acquisition_method || '';
    methodInput.maxLength = 50;
    editRefs.acquisition_method = methodInput;
    methodRow.appendChild(methodInput);
    block.appendChild(methodRow);

    var pracRow = document.createElement('div');
    pracRow.classList.add('info-row');
    pracRow.dataset.testid = 'edit-field-practice_count';
    var pracLabel = document.createElement('span');
    pracLabel.classList.add('info-label');
    pracLabel.textContent = 'Practice Count';
    pracRow.appendChild(pracLabel);
    var pracInput = document.createElement('input');
    pracInput.type = 'number';
    pracInput.classList.add('cms-input');
    pracInput.value = item.practice_count != null ? item.practice_count : 0;
    pracInput.min = 0;
    pracInput.step = 1;
    editRefs.practice_count = pracInput;
    pracRow.appendChild(pracInput);
    block.appendChild(pracRow);

    var reviewRow = document.createElement('div');
    reviewRow.classList.add('info-row');
    reviewRow.dataset.testid = 'edit-field-last_review_timestamp';
    var reviewLabel = document.createElement('span');
    reviewLabel.classList.add('info-label');
    reviewLabel.textContent = 'Last Review';
    reviewRow.appendChild(reviewLabel);
    var reviewInput = document.createElement('input');
    reviewInput.type = 'datetime-local';
    reviewInput.classList.add('cms-input');
    if (item.last_review_timestamp) {
      var dt = new Date(item.last_review_timestamp);
      reviewInput.value = dt.toISOString().slice(0, 16);
    }
    editRefs.last_review_timestamp = reviewInput;
    reviewRow.appendChild(reviewInput);
    block.appendChild(reviewRow);

    block.appendChild(editStatus);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.classList.add('menu-button', 'menu-button--save');
    saveBtn.dataset.testid = 'knowledge-save';
    saveBtn.setAttribute('aria-label', 'Save knowledge state changes');
    var saveSpan = document.createElement('span');
    saveSpan.textContent = 'SAVE';
    saveBtn.appendChild(saveSpan);
    block.appendChild(saveBtn);

    saveBtn.addEventListener('click', async function() {
      var updates = {
        knowledge_id: item.knowledge_id,
        is_mastered: editRefs.is_mastered.dataset.state === 'on',
        is_forgotten: editRefs.is_forgotten.dataset.state === 'on',
        acquisition_completed: editRefs.acquisition_completed.dataset.state === 'on',
        acquisition_method: editRefs.acquisition_method.value || null,
        practice_count: parseInt(editRefs.practice_count.value, 10) || 0,
      };

      if (editRefs.last_review_timestamp.value) {
        updates.last_review_timestamp = new Date(editRefs.last_review_timestamp.value).toISOString();
      } else {
        updates.last_review_timestamp = null;
      }

      editStatus.textContent = 'Saving...';
      editStatus.classList.remove('cms-save-error');
      saveBtn.disabled = true;

      try {
        var result = await api.put(
          '/characters/' + encodeURIComponent(characterId) + '/knowledge-state',
          updates
        );

        if (!result || signal.aborted) return;

        if (result.success) {
          editStatus.textContent = 'Saved';
          setTimeout(function() { editStatus.textContent = ''; }, 2000);
        } else {
          editStatus.textContent = result.error || 'Save failed';
          editStatus.classList.add('cms-save-error');
        }
      } catch (err) {
        editStatus.textContent = err.message || 'Save failed';
        editStatus.classList.add('cms-save-error');
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  wrapper.appendChild(block);

  backBtn.addEventListener('click', function() {
    _renderKnowledgeDetail(container, characterId, item, signal, api);
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}



/* ============================================================================
 * VIEW: character-narratives
 * ============================================================================
 * Level 1: STORY ARCS, NARRATIVE STATE, DOSSIER buttons
 * Level 2: Detail within each group
 * ============================================================================ */

const NARRATIVE_GROUP_KEYS = Object.freeze({
  ARCS: 'arcs',
  STATE: 'state',
  DOSSIER: 'dossier',
});

async function _renderNarratives(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError('No character ID provided to narratives view');
    return;
  }

  _logInfo('Rendering narratives', { characterId });
  container.replaceChildren(_createLoadingState('narratives'));

  try {
    const response = await api.get(
      API_PATHS.CHARACTER_DETAIL + encodeURIComponent(characterId) + '/narratives',
      { signal }
    );

    if (!response || signal.aborted) return;

    if (!response.success) {
      throw new Error('Unexpected response format from narratives endpoint');
    }

    const wrapper = document.createElement('div');
    wrapper.classList.add('character-detail');
    wrapper.dataset.testid = 'character-narratives';
    wrapper.setAttribute('aria-live', 'polite');

    const block = document.createElement('div');
    block.classList.add('info-block');
    block.appendChild(_createSectionHeading('NARRATIVES'));

    const groups = [
      { key: NARRATIVE_GROUP_KEYS.ARCS, label: 'STORY ARCS (' + response.arcs.length + ')' },
      { key: NARRATIVE_GROUP_KEYS.STATE, label: 'NARRATIVE STATE' },
      { key: NARRATIVE_GROUP_KEYS.DOSSIER, label: 'CHARACTER DOSSIER' },
    ];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('menu-button', 'menu-button--sub');
      btn.dataset.testid = 'narrative-group-' + g.key;
      btn.dataset.groupKey = g.key;
      btn.setAttribute('aria-label', g.label);
      const span = document.createElement('span');
      span.textContent = g.label;
      btn.appendChild(span);
      block.appendChild(btn);
    }

    block.addEventListener('click', function(e) {
      const target = e.target.closest('[data-group-key]');
      if (target) {
        _renderNarrativeGroup(container, characterId, target.dataset.groupKey, response, signal, api);
      }
    }, { signal });

    wrapper.appendChild(block);
    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError('Failed to render narratives', error);
    const errBlock = document.createElement('div');
    errBlock.classList.add('info-block');
    const errRow = _createInfoRow('Error', error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

function _renderNarrativeGroup(container, characterId, groupKey, data, signal, api) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'narrative-' + groupKey;
  wrapper.setAttribute('aria-live', 'polite');

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to narrative groups');
  backBtn.dataset.testid = 'narrative-group-back';
  const backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const block = document.createElement('div');
  block.classList.add('info-block');

  if (groupKey === NARRATIVE_GROUP_KEYS.ARCS) {
    block.appendChild(_createSectionHeading('STORY ARCS'));

    if (data.arcs.length === 0) {
      const row = _createInfoRow('Status', 'Not assigned to any story arcs');
      if (row) block.appendChild(row);
    } else {
      for (const arc of data.arcs) {
        const arcBlock = document.createElement('div');
        arcBlock.classList.add('info-block');
        arcBlock.appendChild(_createSectionHeading(arc.title || arc.arc_id));

        const arcFields = [
          { label: 'Arc ID', value: arc.arc_id },
          { label: "Summary", value: arc.summary },
          { label: "Tags", value: Array.isArray(arc.tags) ? arc.tags.join(", ") : arc.tags },
          { label: 'Role', value: arc.role_in_arc },
        ];

        for (const f of arcFields) {
          const row = _createInfoRow(f.label, f.value);
          if (row) arcBlock.appendChild(row);
        }

        block.appendChild(arcBlock);
      }
    }

  } else if (groupKey === NARRATIVE_GROUP_KEYS.STATE) {
    block.appendChild(_createSectionHeading('NARRATIVE STATE'));

    if (!data.narrative) {
      const row = _createInfoRow('Status', 'No narrative state recorded');
      if (row) block.appendChild(row);
    } else {
      const n = data.narrative;
      const stateFields = [
        { label: "Current Segment", value: n.segment_title || n.current_narrative_segment_id },
        { label: 'Last Interacted', value: n.last_interacted_at ? new Date(n.last_interacted_at).toLocaleString('en-AU') : null },
        { label: 'Created', value: n.created_at ? new Date(n.created_at).toLocaleString('en-AU') : null },
        { label: 'Updated', value: n.updated_at ? new Date(n.updated_at).toLocaleString('en-AU') : null },
      ];

      for (const f of stateFields) {
        const row = _createInfoRow(f.label, f.value);
        if (row) block.appendChild(row);
      }

      if (n.current_narrative_state && Object.keys(n.current_narrative_state).length > 0) {
        const stateRow = _createInfoRow('State Data', JSON.stringify(n.current_narrative_state, null, 2));
        if (stateRow) block.appendChild(stateRow);
      }
    }

  } else if (groupKey === NARRATIVE_GROUP_KEYS.DOSSIER) {
    block.appendChild(_createSectionHeading('CHARACTER DOSSIER'));

    if (!data.dossier) {
      const row = _createInfoRow('Status', 'No character dossier created yet');
      if (row) block.appendChild(row);
    } else {
      const d = data.dossier;
      const dossierFields = [
        { label: 'Dossier ID', value: d.dossier_id },
        { label: 'Relationship', value: d.relationship_status },
        { label: 'Notes', value: d.notes },
        { label: 'Omiyage Summary', value: d.omiyage_summary },
        { label: 'Created', value: d.created_at ? new Date(d.created_at).toLocaleString('en-AU') : null },
        { label: 'Updated', value: d.updated_at ? new Date(d.updated_at).toLocaleString('en-AU') : null },
      ];

      for (const f of dossierFields) {
        const row = _createInfoRow(f.label, f.value);
        if (row) block.appendChild(row);
      }

      if (d.pad_snapshot && Object.keys(d.pad_snapshot).length > 0) {
        const padRow = _createInfoRow('PAD Snapshot', JSON.stringify(d.pad_snapshot));
        if (padRow) block.appendChild(padRow);
      }

      if (d.psychological_profile && Object.keys(d.psychological_profile).length > 0) {
        const profRow = _createInfoRow('Psych Profile', JSON.stringify(d.psychological_profile));
        if (profRow) block.appendChild(profRow);
      }
    }
  }

  wrapper.appendChild(block);

  backBtn.addEventListener('click', async function() {
    await _renderNarratives({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}


/* ============================================================================
 * VIEW: character-progression
 * ============================================================================
 * Level 1: BELT PROGRESSION, DOMAIN EXPERTISE, TSE CYCLES buttons
 * Level 2: Detail within each group
 * ============================================================================ */

const PROGRESSION_GROUP_KEYS = Object.freeze({
  BELTS: 'belts',
  EXPERTISE: 'expertise',
  CYCLES: 'cycles',
});

async function _renderProgression(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError('No character ID provided to progression view');
    return;
  }

  _logInfo('Rendering progression', { characterId });
  container.replaceChildren(_createLoadingState('progression'));

  try {
    const response = await api.get(
      API_PATHS.CHARACTER_DETAIL + encodeURIComponent(characterId) + '/progression',
      { signal }
    );

    if (!response || signal.aborted) return;

    if (!response.success) {
      throw new Error('Unexpected response format from progression endpoint');
    }

    const wrapper = document.createElement('div');
    wrapper.classList.add('character-detail');
    wrapper.dataset.testid = 'character-progression';
    wrapper.setAttribute('aria-live', 'polite');

    const block = document.createElement('div');
    block.classList.add('info-block');
    block.appendChild(_createSectionHeading('PROGRESSION'));

    const groups = [
      { key: PROGRESSION_GROUP_KEYS.BELTS, label: 'BELT PROGRESSION (' + response.belts.length + ')' },
      { key: PROGRESSION_GROUP_KEYS.EXPERTISE, label: 'DOMAIN EXPERTISE (' + response.expertise.length + ')' },
      { key: PROGRESSION_GROUP_KEYS.CYCLES, label: 'TSE CYCLES (' + response.cycles.length + ')' },
    ];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('menu-button', 'menu-button--sub');
      btn.dataset.testid = 'progression-group-' + g.key;
      btn.dataset.groupKey = g.key;
      btn.setAttribute('aria-label', g.label);
      const span = document.createElement('span');
      span.textContent = g.label;
      btn.appendChild(span);
      block.appendChild(btn);
    }

    block.addEventListener('click', function(e) {
      const target = e.target.closest('[data-group-key]');
      if (target) {
        _renderProgressionGroup(container, characterId, target.dataset.groupKey, response, signal, api);
      }
    }, { signal });

    wrapper.appendChild(block);
    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError('Failed to render progression', error);
    const errBlock = document.createElement('div');
    errBlock.classList.add('info-block');
    const errRow = _createInfoRow('Error', error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

function _renderProgressionGroup(container, characterId, groupKey, data, signal, api) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'progression-' + groupKey;
  wrapper.setAttribute('aria-live', 'polite');

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to progression groups');
  backBtn.dataset.testid = 'progression-group-back';
  const backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const block = document.createElement('div');
  block.classList.add('info-block');

  if (groupKey === PROGRESSION_GROUP_KEYS.BELTS) {
    block.appendChild(_createSectionHeading('BELT PROGRESSION'));

    if (data.belts.length === 0) {
      const row = _createInfoRow('Status', 'No belt progression data');
      if (row) block.appendChild(row);
    } else {
      for (const belt of data.belts) {
        const beltBlock = document.createElement('div');
        beltBlock.classList.add('info-block');
        beltBlock.appendChild(_createSectionHeading(
          (belt.current_belt || 'unknown').toUpperCase() + (belt.domain_name ? ' — ' + belt.domain_name : '')
        ));

        const beltFields = [
          { label: 'Progression ID', value: belt.progression_id },
          { label: 'Belt', value: belt.current_belt },
          { label: 'Stripes', value: belt.current_stripes },
          { label: 'Stripe Level', value: belt.stripe_level },
          { label: 'Domain', value: belt.domain_name },
          { label: 'Total Cycles', value: belt.total_tse_cycles },
          { label: 'Successful', value: belt.successful_cycles },
          { label: 'Success Rate', value: belt.current_success_rate },
          { label: 'Last Eval Score', value: belt.last_evaluation_score },
          { label: 'Rusty', value: belt.status_rusty ? 'Yes' : 'No' },
          { label: 'Promoted', value: belt.promoted_at ? new Date(belt.promoted_at).toLocaleString('en-AU') : null },
          { label: 'Updated', value: belt.updated_at ? new Date(belt.updated_at).toLocaleString('en-AU') : null },
        ];

        for (const f of beltFields) {
          const row = _createInfoRow(f.label, f.value);
          if (row) beltBlock.appendChild(row);
        }

        block.appendChild(beltBlock);
      }
    }

  } else if (groupKey === PROGRESSION_GROUP_KEYS.EXPERTISE) {
    block.appendChild(_createSectionHeading('DOMAIN EXPERTISE'));

    if (data.expertise.length === 0) {
      const row = _createInfoRow('Status', 'No domain expertise data');
      if (row) block.appendChild(row);
    } else {
      for (const exp of data.expertise) {
        block.appendChild(_buildScoreRow(
          exp.domain_name || exp.domain_id,
          exp.expertise_level,
          0, 100
        ));
      }
    }

  } else if (groupKey === PROGRESSION_GROUP_KEYS.CYCLES) {
    block.appendChild(_createSectionHeading('TSE CYCLES (RECENT 20)'));

    if (data.cycles.length === 0) {
      const row = _createInfoRow('Status', 'No TSE cycles recorded');
      if (row) block.appendChild(row);
    } else {
      for (let i = 0; i < data.cycles.length; i++) {
        const cycle = data.cycles[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.classList.add('menu-button', 'menu-button--sub');
        btn.dataset.testid = 'cycle-item-' + i;
        btn.dataset.cycleIndex = String(i);
        btn.setAttribute('aria-label', 'View cycle ' + cycle.cycle_number);
        const span = document.createElement('span');
        const statusText = cycle.status === 'completed' ? ' \u2713' : cycle.status === 'failed' ? ' \u2717' : '';
        span.textContent = 'Cycle ' + cycle.cycle_number + ' [' + (cycle.cycle_type || 'standard') + ']' + statusText;
        btn.appendChild(span);
        block.appendChild(btn);
      }

      block.addEventListener('click', function(e) {
        const target = e.target.closest('[data-cycle-index]');
        if (target) {
          const idx = parseInt(target.dataset.cycleIndex, 10);
          const cycle = data.cycles[idx];
          if (cycle) {
            _renderCycleDetail(container, characterId, cycle, data, signal, api);
          }
        }
      }, { signal });
    }
  }

  wrapper.appendChild(block);

  backBtn.addEventListener('click', async function() {
    await _renderProgression({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

function _renderCycleDetail(container, characterId, cycle, fullData, signal, api) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'cycle-detail';
  wrapper.setAttribute('aria-live', 'polite');

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to cycles list');
  backBtn.dataset.testid = 'cycle-detail-back';
  const backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const block = document.createElement('div');
  block.classList.add('info-block');
  block.appendChild(_createSectionHeading('CYCLE ' + cycle.cycle_number));

  const fields = [
    { label: 'Cycle ID', value: cycle.cycle_id },
    { label: 'Type', value: cycle.cycle_type },
    { label: 'Status', value: cycle.status },
    { label: 'Domain', value: cycle.domain_name },
    { label: 'Duration', value: cycle.cycle_duration_ms ? cycle.cycle_duration_ms + 'ms' : null },
    { label: 'Started', value: cycle.started_at ? new Date(cycle.started_at).toLocaleString('en-AU') : null },
    { label: 'Completed', value: cycle.completed_at ? new Date(cycle.completed_at).toLocaleString('en-AU') : null },
  ];

  for (const f of fields) {
    const row = _createInfoRow(f.label, f.value);
    if (row) block.appendChild(row);
  }

  block.appendChild(_buildScoreRow('Optimization', cycle.optimization_score, 0, 1));
  block.appendChild(_buildScoreRow('Effectiveness', cycle.learning_effectiveness, 0, 1));

  wrapper.appendChild(block);

  backBtn.addEventListener('click', function() {
    _renderProgressionGroup(container, characterId, PROGRESSION_GROUP_KEYS.CYCLES, fullData, signal, api);
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}


/* ============================================================================
 * VIEW: character-sessions
 * ============================================================================
 * Level 1: MODE TRACKING, TEACHING DIALOGUES buttons
 * Level 2: Detail within each group
 * ============================================================================ */

const SESSION_GROUP_KEYS = Object.freeze({
  MODES: 'modes',
  DIALOGUES: 'dialogues',
});

async function _renderSessions(ctx) {
  const { container, params, signal, api } = ctx;
  const characterId = params.id;

  if (!characterId) {
    _logError('No character ID provided to sessions view');
    return;
  }

  _logInfo('Rendering sessions', { characterId });
  container.replaceChildren(_createLoadingState('sessions'));

  try {
    const response = await api.get(
      API_PATHS.CHARACTER_DETAIL + encodeURIComponent(characterId) + '/sessions',
      { signal }
    );

    if (!response || signal.aborted) return;

    if (!response.success) {
      throw new Error('Unexpected response format from sessions endpoint');
    }

    const wrapper = document.createElement('div');
    wrapper.classList.add('character-detail');
    wrapper.dataset.testid = 'character-sessions';
    wrapper.setAttribute('aria-live', 'polite');

    const block = document.createElement('div');
    block.classList.add('info-block');
    block.appendChild(_createSectionHeading('SESSIONS'));

    const groups = [
      { key: SESSION_GROUP_KEYS.MODES, label: 'MODE TRACKING (' + response.modes.length + ')' },
      { key: SESSION_GROUP_KEYS.DIALOGUES, label: 'TEACHING DIALOGUES (' + response.dialogues.length + ')' },
    ];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('menu-button', 'menu-button--sub');
      btn.dataset.testid = 'session-group-' + g.key;
      btn.dataset.groupKey = g.key;
      btn.setAttribute('aria-label', g.label);
      const span = document.createElement('span');
      span.textContent = g.label;
      btn.appendChild(span);
      block.appendChild(btn);
    }

    block.addEventListener('click', function(e) {
      const target = e.target.closest('[data-group-key]');
      if (target) {
        _renderSessionGroup(container, characterId, target.dataset.groupKey, response, signal, api);
      }
    }, { signal });

    wrapper.appendChild(block);
    if (signal.aborted) return;
    container.replaceChildren(wrapper);

  } catch (error) {
    _logError('Failed to render sessions', error);
    const errBlock = document.createElement('div');
    errBlock.classList.add('info-block');
    const errRow = _createInfoRow('Error', error.message);
    if (errRow) errBlock.appendChild(errRow);
    container.replaceChildren(errBlock);
  }
}

function _renderSessionGroup(container, characterId, groupKey, data, signal, api) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'session-' + groupKey;
  wrapper.setAttribute('aria-live', 'polite');

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.classList.add('menu-button', 'menu-button--nav');
  backBtn.setAttribute('aria-label', 'Back to session groups');
  backBtn.dataset.testid = 'session-group-back';
  const backSpan = document.createElement('span');
  backSpan.textContent = NAV_BACK_LABEL;
  backBtn.appendChild(backSpan);
  wrapper.appendChild(backBtn);

  const block = document.createElement('div');
  block.classList.add('info-block');

  if (groupKey === SESSION_GROUP_KEYS.MODES) {
    block.appendChild(_createSectionHeading('MODE TRACKING'));

    if (data.modes.length === 0) {
      const row = _createInfoRow('Status', 'No mode tracking data');
      if (row) block.appendChild(row);
    } else {
      for (const mode of data.modes) {
        const modeBlock = document.createElement('div');
        modeBlock.classList.add('info-block');
        modeBlock.appendChild(_createSectionHeading(
          (mode.current_mode || 'unknown').toUpperCase() + (mode.username ? ' — ' + mode.username : '')
        ));

        const modeFields = [
          { label: 'Tracking ID', value: mode.tracking_id },
          { label: 'Conversation', value: mode.conversation_id },
          { label: 'Mode', value: mode.current_mode },
          { label: 'Confidence', value: mode.mode_confidence },
          { label: 'Turns', value: mode.turns_in_current_mode },
          { label: 'Last Shift', value: mode.last_mode_shift_at ? new Date(mode.last_mode_shift_at).toLocaleString('en-AU') : null },
          { label: 'Updated', value: mode.updated_at ? new Date(mode.updated_at).toLocaleString('en-AU') : null },
        ];

        for (const f of modeFields) {
          const row = _createInfoRow(f.label, f.value);
          if (row) modeBlock.appendChild(row);
        }

        block.appendChild(modeBlock);
      }
    }

  } else if (groupKey === SESSION_GROUP_KEYS.DIALOGUES) {
    block.appendChild(_createSectionHeading('TEACHING DIALOGUES'));

    if (data.dialogues.length === 0) {
      const row = _createInfoRow('Status', 'No teaching dialogue data');
      if (row) block.appendChild(row);
    } else {
      for (const dlg of data.dialogues) {
        const dlgBlock = document.createElement('div');
        dlgBlock.classList.add('info-block');
        dlgBlock.appendChild(_createSectionHeading(
          (dlg.curriculum_name || dlg.state_id) + (dlg.username ? ' — ' + dlg.username : '')
        ));

        const dlgFields = [
          { label: 'State ID', value: dlg.state_id },
          { label: 'Conversation', value: dlg.conversation_id },
          { label: 'State', value: dlg.dialogue_state },
          { label: 'Turns', value: dlg.turn_count },
          { label: 'Outcome', value: dlg.outcome },
          { label: 'Started', value: dlg.started_at ? new Date(dlg.started_at).toLocaleString('en-AU') : null },
          { label: 'Completed', value: dlg.completed_at ? new Date(dlg.completed_at).toLocaleString('en-AU') : null },
        ];

        for (const f of dlgFields) {
          const row = _createInfoRow(f.label, f.value);
          if (row) dlgBlock.appendChild(row);
        }

        block.appendChild(dlgBlock);
      }
    }
  }

  wrapper.appendChild(block);

  backBtn.addEventListener('click', async function() {
    await _renderSessions({
      container: container,
      params: { id: characterId },
      signal: signal,
      api: api,
    });
  }, { once: true });

  if (signal.aborted) return;
  container.replaceChildren(wrapper);
}

/* ============================================================================
 * PLACEHOLDER — For sub-views without backend endpoints
 * ============================================================================ */

/**
 * Render a proper placeholder for unbuilt sub-views.
 *
 * @param {object} ctx - View context from viewController
 * @param {string} label - Display name of the section
 */
function _renderPlaceholder(ctx, label) {
  const { container } = ctx;

  const wrapper = document.createElement('div');
  wrapper.classList.add('character-detail');
  wrapper.dataset.testid = 'placeholder-' + label.toLowerCase();

  const block = document.createElement('div');
  block.classList.add('info-block');

  block.appendChild(_createSectionHeading(label.toUpperCase()));

  const statusRow = _createInfoRow('Status', 'Backend endpoint not yet built');
  if (statusRow) block.appendChild(statusRow);

  const noteRow = _createInfoRow('Note', 'This view requires a new API route in adminCharacters.js');
  if (noteRow) block.appendChild(noteRow);

  wrapper.appendChild(block);
  container.replaceChildren(wrapper);
}

/* ============================================================================
 * HANDLER REGISTRATION — Runs on import
 * ============================================================================
 * viewController.register() is called immediately when cmsBootstrap.js
 * dynamically imports this module. No manual init() call needed.
 * ============================================================================ */

viewController.register('character-profiles', async (ctx) => {
  _cleanupActiveTable();
  await _renderProfile(ctx);
});

viewController.register('character-personalities', async (ctx) => {
  _cleanupActiveTable();
  await _renderPersonality(ctx);
});

viewController.register('character-images', async (ctx) => {
  _cleanupActiveTable();
  await _renderImages(ctx);
});

viewController.register("character-inventory", async (ctx) => {
  _cleanupActiveTable();
  await _renderInventory(ctx);
});

viewController.register("character-knowledge", async (ctx) => {
  _cleanupActiveTable();
  await _renderKnowledge(ctx);
});

viewController.register("character-psychic", async (ctx) => {
  const { container } = ctx;
  const wrapper = document.createElement("div");
  wrapper.classList.add("character-detail");
  wrapper.dataset.testid = "character-psychic";
  const block = document.createElement("div");
  block.classList.add("info-block");
  block.appendChild(_createSectionHeading("PSYCHIC ENGINE"));
  const row = _createInfoRow("Location", "Use the PSYCHIC section in the main menu for live radar, moods, frames, events, and proximity data");
  if (row) block.appendChild(row);
  wrapper.appendChild(block);
  container.replaceChildren(wrapper);
});

viewController.register("character-narratives", async (ctx) => {
  _cleanupActiveTable();
  await _renderNarratives(ctx);
});

viewController.register("character-progression", async (ctx) => {
  _cleanupActiveTable();
  await _renderProgression(ctx);
});

viewController.register("character-sessions", async (ctx) => {
  _cleanupActiveTable();
  await _renderSessions(ctx);
});

_logInfo('Module loaded, 9 handlers registered');
