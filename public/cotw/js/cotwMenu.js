/**
 * ============================================================================
 * COTW Menu — The Expanse v010
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Left-panel cascading drill-down navigation for the COTW user terminal.
 * Renders a multi-level menu that replaces its contents at each level.
 *
 * NAVIGATION LEVELS:
 * ---------------------------------------------------------------------------
 * Level 1 (Main Menu):
 *   8 section buttons from MENU_SECTIONS (hardcoded structure).
 *   Clicking any section drills down to Level 2.
 *
 * Level 2 (Section Drill-Down):
 *   Displays sub-items from MENU_SECTIONS as buttons.
 *   Back arrow returns to Level 1. Home returns to Level 1.
 *
 * PATTERN:
 * ---------------------------------------------------------------------------
 * Every drill-down level shows:
 *   - Clicked item name at the top (as a header)
 *   - Child items as buttons below
 *   - Back arrow button (goes up one level)
 *   - Home button (goes to main menu)
 *
 * EVENTS DISPATCHED:
 * ---------------------------------------------------------------------------
 * - cotw:navigate on document — { section, item, label }
 *   Fired when a leaf-level button is clicked (sub-item).
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
 * - css/cms-styles.css (menu-button, menu-nav classes)
 * - cotw-dossier.html #cotw-menu container
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Created: March 8, 2026
 * ============================================================================
 */

/* ============================================================================
 * CONSTANTS
 * ============================================================================ */

const EVENTS = Object.freeze({
    NAVIGATE: 'cotw:navigate',
});

const SELECTORS = Object.freeze({
    MENU_CONTAINER: 'cotw-menu',
    CONTENT_DISPLAY: 'content-display',
    CONTENT_STATUS: 'content-status',
    MENU_BUTTON_CLASS: 'menu-button',
    MENU_BUTTON_ACTIVE: 'menu-button--active',
});

/* ============================================================================
 * MENU DATA — 8 sections mapped to real database tables
 * ============================================================================ */

const MENU_SECTIONS = Object.freeze([
    {
        id: 'dossier',
        label: 'Dossier',
        items: Object.freeze([
            { id: 'dossier-profile', label: 'Profile' },
            { id: 'dossier-pad-state', label: 'PAD State' },
            { id: 'dossier-relationship', label: 'Relationship' },
            { id: 'dossier-psychology', label: 'Psychology' },
            { id: 'dossier-helpdesk', label: 'Helpdesk Context' },
            { id: 'dossier-login-history', label: 'Login History' },
        ]),
    },
    {
        id: 'language',
        label: 'Language',
        items: Object.freeze([
            { id: 'language-vocabulary', label: 'Vocabulary' },
            { id: 'language-facts', label: 'Language Facts' },
            { id: 'language-reports', label: 'Language Reports' },
            { id: 'language-taught-entities', label: 'Taught Entities' },
        ]),
    },
    {
        id: 'progression',
        label: 'Progression',
        items: Object.freeze([
            { id: 'progression-belt', label: 'Belt Rank' },
            { id: 'progression-curriculum', label: 'Curriculum State' },
            { id: 'progression-knowledge', label: 'Knowledge State' },
            { id: 'progression-fsrs', label: 'FSRS Calibration' },
        ]),
    },
    {
        id: 'discovery',
        label: 'Discovery',
        items: Object.freeze([
            { id: 'discovery-entities', label: 'Entity Discoveries' },
            { id: 'discovery-arc-state', label: 'Arc State' },
            { id: 'discovery-content-access', label: 'Content Access' },
            { id: 'discovery-observational-depth', label: 'Observational Depth' },
        ]),
    },
    {
        id: 'sessions',
        label: 'Sessions',
        items: Object.freeze([
            { id: 'sessions-history', label: 'Session History' },
            { id: 'sessions-interaction-memory', label: 'Interaction Memory' },
            { id: 'sessions-onboarding', label: 'Onboarding' },
        ]),
    },
    {
        id: 'psychic',
        label: 'Psychic',
        items: Object.freeze([
            { id: 'psychic-moods', label: 'Moods' },
            { id: 'psychic-radar', label: 'Radar (Live)' },
        ]),
    },
    {
        id: 'razor',
        label: 'Ockham\x27s Razor',
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
        id: 'tanuki',
        label: 'Tanuki',
        items: Object.freeze([
            { id: 'tanuki-profile', label: 'Claude Relationship' },
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
    navigationStack: [],
});

/* ============================================================================
 * LOGGING
 * ============================================================================ */

const LOG_PREFIX = '[cotwMenu]';

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
 * Create the navigation footer with back arrow and home buttons.
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

    const homeBtn = _createButton('COTW', { action: 'cotw' });
    homeBtn.classList.add('menu-button--nav');
    footer.appendChild(homeBtn);

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
 * Shows 8 section buttons only. No sub-items.
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
 * Shows sub-items from MENU_SECTIONS as buttons.
 *
 * @param {object} section - The MENU_SECTIONS entry
 */
function renderSectionDrillDown(section) {
    if (!state.menuContainer) return;

    state.navigationStack = [{ level: 'main' }];

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

/* ============================================================================
 * NAVIGATION — Back and Home handlers
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
    } else {
        renderMainMenu();
    }
}

/* ============================================================================
 * EVENT DISPATCH — Fires cotw:navigate for leaf-level clicks
 * ============================================================================ */

/**
 * Dispatch the cotw:navigate custom event.
 *
 * @param {string} sectionId - Section identifier
 * @param {string} itemId - Item identifier
 * @param {string} label - Display label
 * @param {HTMLElement} originButton - The clicked button for focus restoration
 */
function dispatchNavigate(sectionId, itemId, label, originButton) {
    const detail = Object.freeze({
        section: sectionId,
        item: itemId,
        label: label,
        returnFocus: () => originButton.focus(),
    });

    document.dispatchEvent(new CustomEvent(EVENTS.NAVIGATE, { detail }));
    logInfo('Navigate', { section: sectionId, item: itemId });
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
function handleContainerClick(event) {
    const button = event.target?.closest(`.${SELECTORS.MENU_BUTTON_CLASS}`);
    if (!button || button.disabled) return;

    const action = button.dataset.action;

    switch (action) {
        case 'section': {
            const section = MENU_SECTIONS.find(s => s.id === button.dataset.section);
            if (section) {
                renderSectionDrillDown(section);
            }
            break;
        }

        case 'navigate': {
            const section = MENU_SECTIONS.find(s => s.id === button.dataset.section);
            const item = section?.items.find(i => i.id === button.dataset.item);
            if (section && item) {
                dispatchNavigate(section.id, item.id, item.label, button);
                state.activeButtonId = item.id;

                const allButtons = state.menuContainer.querySelectorAll(`.${SELECTORS.MENU_BUTTON_CLASS}`);
                allButtons.forEach(b => {
                    b.classList.remove(SELECTORS.MENU_BUTTON_ACTIVE);
                    b.setAttribute('aria-current', 'false');
                });

                button.classList.add(SELECTORS.MENU_BUTTON_ACTIVE);
                button.setAttribute('aria-current', 'page');
            }
            break;
        }

        case 'back': {
            navigateBack();
            break;
        }

        case 'cotw': {
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
 * Initialises the COTW menu. Safe to call multiple times (idempotent).
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
 * Destroys the COTW menu. Aborts all listeners, clears state.
 */
function destroy() {
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
    }

    state.activeButtonId = null;
    state.menuContainer = null;
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
 * MODULE EXPORTS
 * ============================================================================ */

export { MENU_SECTIONS, EVENTS, init, destroy };

export default Object.freeze({
    MENU_SECTIONS,
    EVENTS,
    init,
    destroy,
});
