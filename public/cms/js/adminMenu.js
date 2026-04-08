/**
 * ============================================================================
 * Admin Menu — The Expanse v010
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Left-panel cascading drill-down navigation for the CMS admin terminal.
 * Renders a multi-level menu that replaces its contents at each level.
 *
 * NAVIGATION LEVELS:
 * ---------------------------------------------------------------------------
 * Level 1 (Main Menu):
 *   11 section buttons from MENU_SECTIONS (hardcoded structure).
 *   Clicking any section drills down to Level 2.
 *
 * Level 2 (Section Drill-Down):
 *   For Characters: fetches categories from GET /api/admin/characters,
 *   groups by category field, displays unique categories as buttons.
 *   For other sections: displays static sub-items from MENU_SECTIONS.
 *   Back arrow returns to Level 1. COTW returns to Level 1.
 *
 * Level 3 (Characters Only — Category Drill-Down):
 *   Filters fetched character data by selected category.
 *   Displays character names as buttons.
 *   Clicking a character fires admin:navigate with character_id.
 *   Back arrow returns to Level 2. COTW returns to Level 1.
 *
 * PATTERN:
 * ---------------------------------------------------------------------------
 * Every drill-down level shows:
 *   - Clicked item name at the top (as a header)
 *   - Child items as buttons below
 *   - Back arrow button (goes up one level)
 *   - COTW button (goes to main menu)
 *
 * DATA SOURCE:
 * ---------------------------------------------------------------------------
 * Characters are fully database-driven from Level 2 onwards.
 * Other sections use MENU_SECTIONS items as temporary stand-in until
 * their database endpoints are built.
 *
 * EVENTS DISPATCHED:
 * ---------------------------------------------------------------------------
 * - admin:navigate on document — { section, item, label, id, returnFocus }
 *   Fired when a leaf-level button is clicked (character name or sub-item).
 *   Other modules listen for this to load content into the right panel.
 *
 * EXPORTS:
 * ---------------------------------------------------------------------------
 * - MENU_SECTIONS   — frozen menu data for other modules to read
 * - EVENTS          — event name constants
 * - init()          — manual initialisation (auto-runs on DOMContentLoaded)
 * - destroy()       — cleanup all listeners (for testing / teardown)
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * - apiClient.js (for character database fetch)
 * - css/cms-styles.css (menu-button, menu-nav classes)
 * - index.html #admin-menu container
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Date: February 24, 2026
 * ============================================================================
 */

import apiClient from './apiClient.js';

/* ============================================================================
 * CONSTANTS
 * ============================================================================ */

const EVENTS = Object.freeze({
    NAVIGATE: 'admin:navigate',
});

const SELECTORS = Object.freeze({
    MENU_CONTAINER: 'admin-menu',
    TOOLS_DISPLAY: 'content-display',
    TOOL_STATUS: 'content-status',
    MENU_BUTTON_CLASS: 'menu-button',
    MENU_BUTTON_ACTIVE: 'menu-button--active',
});

/* ============================================================================
 * MENU DATA — Frozen structure aligned to database entity groups
 * ============================================================================ */

const MENU_SECTIONS = Object.freeze([
    {
        id: 'characters',
        label: 'Characters',
        dbDriven: true,
        items: Object.freeze([
            { id: 'character-profiles', label: 'Profiles' },
            { id: 'character-traits', label: 'Traits' },
            { id: 'character-personalities', label: 'Personalities' },
            { id: 'character-inventory', label: 'Inventory' },
            { id: 'character-belts', label: 'Belt Progression' },
        ]),
    },
    {
        id: 'knowledge',
        label: 'Knowledge',
        items: Object.freeze([
            { id: 'knowledge-domains', label: 'Domains' },
            { id: 'knowledge-items', label: 'Items' },
            { id: 'knowledge-entities', label: 'Entities' },
            { id: 'knowledge-relationships', label: 'Relationships' },
            { id: 'knowledge-mappings', label: 'Slot Mappings' },
        ]),
    },
    {
        id: 'narratives',
        label: 'Narratives',
        items: Object.freeze([
            { id: 'narrative-arcs', label: 'Arcs' },
            { id: 'narrative-beats', label: 'Beats' },
            { id: 'narrative-paths', label: 'Paths' },
            { id: 'narrative-segments', label: 'Segments' },
            { id: 'narrative-story-arcs', label: 'Story Arcs' },
            { id: 'narrative-blueprints', label: 'Blueprints' },
            { id: 'narrative-instances', label: 'Blueprint Instances' },
            { id: 'narrative-heuristics', label: 'Storytelling Heuristics' },
        ]),
    },
    {
        id: 'chaos-engine',
        label: 'Chaos Engine',
        items: Object.freeze([
            { id: 'chaos-engine-inspect', label: 'Seed Inspector' },
            { id: 'chaos-engine-slots', label: 'Slot Visualiser' },
            { id: 'chaos-engine-batch', label: 'Bad Seed Detector' },
            { id: 'chaos-engine-dependencies', label: 'Dependency Graph' },
        ]),
    },
    {
        id: 'curricula',
        label: 'Curricula',
        items: Object.freeze([
            { id: 'curricula-list', label: 'All Curricula' },
            { id: 'curricula-expectations', label: 'Expectations' },
            { id: 'curricula-hints', label: 'Hints' },
            { id: 'curricula-misconceptions', label: 'Misconceptions' },
        ]),
    },
    {
        id: 'media',
        label: 'Media',
        items: Object.freeze([
            { id: 'media-assets', label: 'Assets' },
            { id: 'media-attachments', label: 'Attachments' },
        ]),
    },
    {
        id: 'world',
        label: 'World',
        items: Object.freeze([
            { id: 'world-locations', label: 'Locations' },
            { id: 'world-objects', label: 'Objects' },
            { id: 'world-events', label: 'Multiverse Events' },
        ]),
    },
    {
        id: 'dialogue',
        label: 'Dialogue',
        items: Object.freeze([
            { id: 'dialogue-categories', label: 'LTLM Categories' },
            { id: 'dialogue-speech-acts', label: 'Speech Acts' },
            { id: 'dialogue-narrative-fn', label: 'Narrative Functions' },
            { id: 'dialogue-outcome-intents', label: 'Outcome Intents' },
            { id: 'dialogue-emotion-registers', label: 'Emotion Registers' },
        ]),
    },
    {
        id: 'tse',
        label: 'TSE',
        items: Object.freeze([
            { id: 'tse-cycles', label: 'Cycles' },
            { id: 'tse-evaluations', label: 'Evaluations' },
            { id: 'tse-sessions', label: 'Sessions' },
            { id: 'tse-tasks', label: 'Tasks' },
        ]),
    },
    {
        id: 'razor',
        label: 'Occam\x27s Razor',
        items: Object.freeze([
            { id: 'ockhams-razor', label: 'Evaluate' },
        ]),
    },
    {
        id: 'wwdd',
        label: 'WWDD',
        items: Object.freeze([
            { id: 'wwdd-gunsight', label: 'Gunsight (Live)' },
        ]),
    },
    {
        id: 'psychic',
        label: 'Psychic',
        items: Object.freeze([
            { id: 'psychic-moods', label: 'Moods' },
            { id: 'psychic-frames', label: 'Frames' },
            { id: 'psychic-proximity', label: 'Proximity' },
            { id: 'psychic-events', label: 'Events' },
            { id: 'psychic-radar', label: 'Radar (Live)' },
        ]),
    },
    {
        id: 'users',
        label: 'Users',
        items: Object.freeze([
            { id: 'users-cotw-dossiers', label: 'COTW Dossiers' },
            { id: 'purchase-codes', label: 'Purchase Codes' },
        ]),
    },
    {
        id: 'system',
        label: 'System',
        items: Object.freeze([
            { id: 'system-hex-ranges', label: 'Hex Ranges' },
            { id: 'system-features', label: 'Features' },
            { id: 'system-audit-log', label: 'Audit Log' },
            { id: 'system-counters', label: 'ID Counters' },
        ]),
    },
    {
        id: 'merch',
        label: 'Merch',
        items: Object.freeze([
            { id: 'merch-drops', label: 'Drops' },
            { id: 'merch-orders', label: 'Orders' },
            { id: 'merch-audit', label: 'Audit Log' },
        ]),
    },
]);

/* ============================================================================
 * STATE
 * ============================================================================ */

const state = Object.seal({
    activeButtonId: null,
    abortController: null,
    isInitialised: false,
    menuContainer: null,
    characterCache: null,
    blueprintCache: null,
    navigationStack: [],
});

/* ============================================================================
 * LOGGING
 * ============================================================================ */

const LOG_PREFIX = '[adminMenu]';

function logInfo(msg, data) {
    if (typeof console !== 'undefined') {
        console.info(`${LOG_PREFIX} ${msg}`, data ?? '');
    }
}

function logWarn(msg, data) {
    if (typeof console !== 'undefined') {
        console.warn(`${LOG_PREFIX} ${msg}`, data ?? '');
    }
}

function logError(msg, err) {
    if (typeof console !== 'undefined') {
        console.error(`${LOG_PREFIX} ${msg}`, err ?? '');
    }
}

/* ============================================================================
 * BUTTON FACTORY — Creates Cold War beveled buttons
 * ============================================================================ */

/**
 * Create a menu button element with consistent styling and accessibility.
 *
 * @param {string} label - Button display text
 * @param {object} dataset - Key-value pairs for data attributes
 * @returns {HTMLButtonElement}
 */
function _createButton(label, dataset = {}) {
    const button = document.createElement('button');
    button.classList.add(SELECTORS.MENU_BUTTON_CLASS);
    button.type = 'button';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    button.appendChild(labelSpan);
    button.setAttribute('aria-current', 'false');

    for (const [key, value] of Object.entries(dataset)) {
        button.dataset[key] = value;
    }

    return button;
}

/**
 * Create the navigation footer with back arrow and COTW buttons.
 *
 * @param {boolean} showBack - Whether to show the back arrow
 * @returns {HTMLElement}
 */
function _createNavFooter(showBack = true) {
    const footer = document.createElement('div');
    footer.classList.add('menu-nav-footer');

    if (showBack) {
        const backBtn = _createButton('\u2190 BACK', { action: 'back' });
        backBtn.classList.add('menu-button--nav');
        footer.appendChild(backBtn);
    }

    const cotwBtn = _createButton('COTW', { action: 'cotw' });
    cotwBtn.classList.add('menu-button--nav');
    footer.appendChild(cotwBtn);

    return footer;
}

/**
 * Create a section header element.
 *
 * @param {string} text - Header text
 * @returns {HTMLElement}
 */
function _createHeader(text) {
    const header = document.createElement('div');
    header.classList.add('menu-drilldown__header');
    header.textContent = text;
    return header;
}

/* ============================================================================
 * RENDER FUNCTIONS — Each level replaces menu container contents
 * ============================================================================ */

/**
 * Render Level 1 — Main Menu.
 * Shows 11 section buttons only. No sub-items.
 */
function renderMainMenu() {
    if (!state.menuContainer) return;

    state.navigationStack = [];
    state.activeButtonId = null;

    const fragment = document.createDocumentFragment();

    for (const section of MENU_SECTIONS) {
        const button = _createButton(section.label, {
            action: 'section',
            section: section.id,
        });
        fragment.appendChild(button);
    }

    state.menuContainer.replaceChildren(fragment);
    logInfo('Rendered main menu', { sections: MENU_SECTIONS.length });
}

/**
 * Render Level 2 — Section Drill-Down.
 * For Characters: fetches categories from database.
 * For other sections: shows static sub-items from MENU_SECTIONS.
 *
 * @param {object} section - The MENU_SECTIONS entry
 */
async function renderSectionDrillDown(section) {
    if (!state.menuContainer) return;

    state.navigationStack = [{ level: 'main' }];

    if (section.dbDriven && section.id === 'characters') {
        await _renderCharacterCategories(section);
    } else {
        _renderStaticSubItems(section);
    }
}

/**
 * Render character categories fetched from database.
 * Groups characters by category and displays category names as buttons.
 *
 * @param {object} section - The characters MENU_SECTIONS entry
 */
async function _renderCharacterCategories(section) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(_createHeader(section.label));

    const loadingBtn = _createButton('Loading...', {});
    loadingBtn.disabled = true;
    fragment.appendChild(loadingBtn);
    fragment.appendChild(_createNavFooter(true));
    state.menuContainer.replaceChildren(fragment);

    try {
        if (!state.characterCache) {
            const response = await apiClient.get('/characters');
            if (!response || !response.success || !Array.isArray(response.characters)) {
                throw new Error('Failed to fetch characters');
            }
            state.characterCache = response.characters;
        }

        const categories = [];
        const seen = new Set();
        for (const char of state.characterCache) {
            if (!seen.has(char.category)) {
                seen.add(char.category);
                categories.push(char.category);
            }
        }
        categories.sort();

        const freshFragment = document.createDocumentFragment();
        freshFragment.appendChild(_createHeader(section.label));

        for (const category of categories) {
            const button = _createButton(category, {
                action: 'character-category',
                category: category,
                section: section.id,
            });
            button.classList.add('menu-button--sub');


            freshFragment.appendChild(button);
        }

        freshFragment.appendChild(_createNavFooter(true));
        state.menuContainer.replaceChildren(freshFragment);

        logInfo('Rendered character categories', { count: categories.length });

    } catch (error) {
        logError('Failed to load character categories', error);

        const errorFragment = document.createDocumentFragment();
        errorFragment.appendChild(_createHeader(section.label));

        const errorBtn = _createButton('Error loading data', {});
        errorBtn.disabled = true;
        errorFragment.appendChild(errorBtn);
        errorFragment.appendChild(_createNavFooter(true));
        state.menuContainer.replaceChildren(errorFragment);
    }
}

/**
 * Render static sub-items from MENU_SECTIONS for non-DB-driven sections.
 *
 * @param {object} section - The MENU_SECTIONS entry
 */
function _renderStaticSubItems(section) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(_createHeader(section.label));

    for (const item of section.items) {
        const button = _createButton(item.label, {
            action: 'navigate',
            section: section.id,
            item: item.id,
        });
            button.classList.add('menu-button--sub');
        fragment.appendChild(button);
    }

    fragment.appendChild(_createNavFooter(true));
    state.menuContainer.replaceChildren(fragment);

    logInfo('Rendered section drill-down', { section: section.id, items: section.items.length });
}

/**
 * Render Blueprint Drill-Down.
 * Fetches blueprints from API and displays names as buttons.
 * Clicking a blueprint name fires admin:navigate with blueprint_id.
 *
 * @param {string} sectionId - The parent section id
 */
async function _renderBlueprintDrillDown(sectionId) {
    if (!state.menuContainer) return;

    state.navigationStack = [
        { level: 'main' },
        { level: 'section', sectionId: sectionId },
    ];

    const fragment = document.createDocumentFragment();
    fragment.appendChild(_createHeader('Blueprints'));

    const loadingBtn = _createButton('Loading...', {});
    loadingBtn.disabled = true;
    fragment.appendChild(loadingBtn);
    fragment.appendChild(_createNavFooter(true));
    state.menuContainer.replaceChildren(fragment);

    try {
        if (!state.blueprintCache) {
            const response = await apiClient.get('/narrative-blueprints');
            if (!response || !response.success || !Array.isArray(response.blueprints)) {
                throw new Error('Failed to fetch blueprints');
            }
            state.blueprintCache = response.blueprints;
        }

        const freshFragment = document.createDocumentFragment();
        freshFragment.appendChild(_createHeader('Blueprints'));

        for (const bp of state.blueprintCache) {
            const button = _createButton(bp.blueprint_name, {
                action: 'blueprint-item',
                blueprintId: bp.blueprint_id,
                blueprintName: bp.blueprint_name,
                section: sectionId,
            });
            button.classList.add('menu-button--sub');
            freshFragment.appendChild(button);
        }

        freshFragment.appendChild(_createNavFooter(true));
        state.menuContainer.replaceChildren(freshFragment);

        logInfo('Rendered blueprint drill-down', { count: state.blueprintCache.length });

    } catch (error) {
        logError('Failed to load blueprints', error);

        const errorFragment = document.createDocumentFragment();
        errorFragment.appendChild(_createHeader('Blueprints'));

        const errorBtn = _createButton('Error loading data', {});
        errorBtn.disabled = true;
        errorFragment.appendChild(errorBtn);
        errorFragment.appendChild(_createNavFooter(true));
        state.menuContainer.replaceChildren(errorFragment);
    }
}

/**
 * Render Level 3 — Character Names within a Category.
 * Filters cached character data by category.
 *
 * @param {string} category - The category name to filter by
 * @param {string} sectionId - The parent section id
 */
function renderCharacterList(category, sectionId) {
    if (!state.menuContainer || !state.characterCache) return;

    state.navigationStack = [
        { level: 'main' },
        { level: 'section', sectionId: sectionId },
    ];

    const characters = state.characterCache
        .filter(c => c.category === category)
        .sort((a, b) => a.character_name.localeCompare(b.character_name));

    const fragment = document.createDocumentFragment();
    fragment.appendChild(_createHeader(category));

    for (const char of characters) {
        const button = _createButton(char.character_name, {
            action: 'character',
            characterId: char.character_id,
            characterName: char.character_name,
            section: sectionId,
            category: category,
        });
            button.classList.add('menu-button--sub');
        fragment.appendChild(button);
    }

    fragment.appendChild(_createNavFooter(true));
    state.menuContainer.replaceChildren(fragment);

    logInfo('Rendered character list', { category, count: characters.length });
}

/**
 * Character data section definitions.
 * Each entry becomes a button in the Level 4 drill-down.
 * The item value maps to the viewController handler that loads the right panel.
 */
const CHARACTER_DATA_SECTIONS = Object.freeze([
    { id: 'character-profiles', label: 'Profile' },
    { id: 'character-personalities', label: 'Personality' },
    { id: 'character-images', label: 'Images' },
    { id: 'character-inventory', label: 'Inventory' },
    { id: 'character-knowledge', label: 'Knowledge' },
    { id: 'character-psychic', label: 'Psychic' },
    { id: 'character-narratives', label: 'Narratives' },
    { id: 'character-progression', label: 'Progression' },
    { id: 'character-sessions', label: 'Sessions' },
]);

/**
 * Render Level 4 — Character Data Sections.
 * Shows data section buttons for a specific character.
 *
 * @param {string} characterId - The character hex ID
 * @param {string} characterName - Display name
 * @param {string} category - The category this character belongs to
 * @param {string} sectionId - The parent section id
 */
function renderCharacterDataSections(characterId, characterName, category, sectionId) {
    if (!state.menuContainer) return;

    state.navigationStack = [
        { level: 'main' },
        { level: 'section', sectionId: sectionId },
        { level: 'category', category: category, sectionId: sectionId },
    ];

    const fragment = document.createDocumentFragment();
    fragment.appendChild(_createHeader(characterName));

    for (const ds of CHARACTER_DATA_SECTIONS) {
        const button = _createButton(ds.label, {
            action: 'character-data',
            item: ds.id,
            characterId: characterId,
            characterName: characterName,
            category: category,
            section: sectionId,
        });
        button.classList.add('menu-button--sub');
        fragment.appendChild(button);
    }

    fragment.appendChild(_createNavFooter(true));
    state.menuContainer.replaceChildren(fragment);

    logInfo('Rendered character data sections', { characterId, characterName });
}

/* ============================================================================
 * NAVIGATION — Back and COTW handlers
 * ============================================================================ */

/**
 * Navigate back one level using the navigation stack.
 */
function navigateBack() {
    if (state.navigationStack.length === 0) {
        renderMainMenu();
        return;
    }

    const previous = state.navigationStack[state.navigationStack.length - 1];

    if (previous.level === 'main') {
        renderMainMenu();
    } else if (previous.level === 'section') {
        const section = MENU_SECTIONS.find(s => s.id === previous.sectionId);
        if (section) {
            renderSectionDrillDown(section);
        } else {
            renderMainMenu();
        }
    } else if (previous.level === 'category') {
        renderCharacterList(previous.category, previous.sectionId);
    } else {
        renderMainMenu();
    }
}

/* ============================================================================
 * EVENT DISPATCH — Fires admin:navigate for leaf-level clicks
 * ============================================================================ */

/**
 * Dispatch the admin:navigate custom event.
 *
 * @param {string} sectionId - Section identifier
 * @param {string} itemId - Item identifier
 * @param {string} label - Display label
 * @param {string|null} id - Optional entity hex ID
 * @param {HTMLElement} originButton - The clicked button for focus restoration
 */
function dispatchNavigate(sectionId, itemId, label, id, originButton) {
    const detail = Object.freeze({
        section: sectionId,
        item: itemId,
        label: label,
        id: id || null,
        returnFocus: () => originButton.focus(),
    });

    document.dispatchEvent(new CustomEvent(EVENTS.NAVIGATE, { detail }));
    logInfo('Navigate', { section: sectionId, item: itemId, id });
}

/* ============================================================================
 * CLICK HANDLER — Delegated from container, routes by data-action
 * ============================================================================ */

/**
 * Delegated click handler on the menu container.
 * Routes clicks based on data-action attribute.
 *
 * @param {MouseEvent} event
 */
async function handleContainerClick(event) {
    const button = event.target?.closest(`.${SELECTORS.MENU_BUTTON_CLASS}`);
    if (!button || button.disabled) return;

    const action = button.dataset.action;

    switch (action) {
        case 'section': {
            const section = MENU_SECTIONS.find(s => s.id === button.dataset.section);
            if (section) {
                await renderSectionDrillDown(section);
            }
            break;
        }

        case 'character-category': {
            renderCharacterList(button.dataset.category, button.dataset.section);
            break;
        }

        case 'character': {
            renderCharacterDataSections(
                button.dataset.characterId,
                button.dataset.characterName,
                button.dataset.category,
                button.dataset.section
            );
            break;
        }

        case 'character-data': {
            dispatchNavigate(
                button.dataset.section,
                button.dataset.item,
                button.dataset.characterName,
                button.dataset.characterId,
                button
            );
            state.activeButtonId = button.dataset.item;
            button.classList.add(SELECTORS.MENU_BUTTON_ACTIVE);
            button.setAttribute('aria-current', 'page');
            break;
        }

        case 'navigate': {
            const section = MENU_SECTIONS.find(s => s.id === button.dataset.section);
            const item = section?.items.find(i => i.id === button.dataset.item);
            if (section && item) {
                if (item.id === 'narrative-blueprints') {
                    await _renderBlueprintDrillDown(section.id);
                } else {
                    dispatchNavigate(section.id, item.id, item.label, null, button);
                    state.activeButtonId = item.id;
                    button.classList.add(SELECTORS.MENU_BUTTON_ACTIVE);
                    button.setAttribute('aria-current', 'page');
                }
            }
            break;
        }


        case 'blueprint-item': {
            dispatchNavigate(
                button.dataset.section,
                'narrative-blueprints',
                button.dataset.blueprintName,
                button.dataset.blueprintId,
                button
            );
            state.activeButtonId = 'narrative-blueprints';
            button.classList.add(SELECTORS.MENU_BUTTON_ACTIVE);
            button.setAttribute('aria-current', 'page');
            break;
        }
        case 'back': {
            navigateBack();
            break;
        }

        case 'cotw': {
            state.characterCache = null;
            state.blueprintCache = null;
            renderMainMenu();
            break;
        }

        default:
            logWarn('Unknown menu action', { action });
    }
}

/* ============================================================================
 * INIT / DESTROY — Lifecycle with AbortController cleanup
 * ============================================================================ */

/**
 * Initialises the admin menu. Safe to call multiple times (idempotent).
 */
function init() {
    if (state.isInitialised) {
        logWarn('Already initialised, skipping');
        return;
    }

    try {
        state.menuContainer = document.getElementById(SELECTORS.MENU_CONTAINER);

        if (!state.menuContainer) {
            logError('Menu container not found', { id: SELECTORS.MENU_CONTAINER });
            return;
        }

        state.abortController = new AbortController();
        const { signal } = state.abortController;

        state.menuContainer.addEventListener('click', handleContainerClick, { signal });

        renderMainMenu();

        state.isInitialised = true;
        logInfo('Initialised', { sections: MENU_SECTIONS.length });

    } catch (err) {
        logError('Initialisation failed', err);
    }
}

/**
 * Destroys the admin menu. Aborts all listeners, clears state.
 */
function destroy() {
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
    }

    state.activeButtonId = null;
    state.menuContainer = null;
    state.characterCache = null;
    state.navigationStack = [];
    state.isInitialised = false;

    logInfo('Destroyed');
}

/* ============================================================================
 * AUTO-INIT
 * ============================================================================ */

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/* ============================================================================
 * MODULE EXPORTS — For testing, external access, and inter-module use
 * ============================================================================ */

export { MENU_SECTIONS, EVENTS, init, destroy };

export default Object.freeze({
    MENU_SECTIONS,
    EVENTS,
    init,
    destroy,
});
