/**
 * ============================================================================
 * COTW Panel Toggle Controller — The Expanse v010
 * File: public/cotw/js/cotwPanelToggle.js
 * ============================================================================
 *
 * WHAT THIS MODULE DOES:
 * ---------------------------------------------------------------------------
 * Controls the visibility of all four collapsible panels (left menu, top bar,
 * bottom bar, right content) via toggle buttons in the terminal header.
 *
 * When a panel is toggled off, it gets the [hidden] attribute and the CSS
 * grid auto-morphs to redistribute space. The terminal always stays visible.
 *
 * Toggle buttons use data-target to identify which panel to control.
 * Button state (toggle-btn--active) and aria-expanded stay synchronised.
 *
 * PANEL TARGETS:
 * ---------------------------------------------------------------------------
 *   data-target="panel--menu"     Left nav panel (by class)
 *   data-target="panel-top"       Top bar (by id)
 *   data-target="panel-bottom"    Bottom bar (by id)
 *   data-target="panel--content"  Right content panel (by class)
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * - cotw-dossier.html toggle buttons with .toggle-btn[data-target]
 * - /cms/css/cms-styles.css (toggle-btn, toggle-btn--active classes)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Created: March 8, 2026
 * ============================================================================
 */

const ACTIVE_CLASS = 'toggle-btn--active';

function findPanel(target) {
    return document.getElementById(target)
        || document.querySelector('.' + target);
}

function initPanelToggles() {
    const buttons = document.querySelectorAll('.toggle-btn[data-target]');

    buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            const panel = findPanel(target);

            if (!panel) return;

            const isCurrentlyVisible = !panel.hasAttribute('hidden');

            if (isCurrentlyVisible) {
                panel.setAttribute('hidden', '');
                btn.classList.remove(ACTIVE_CLASS);
                btn.setAttribute('aria-expanded', 'false');
            } else {
                panel.removeAttribute('hidden');
                btn.classList.add(ACTIVE_CLASS);
                btn.setAttribute('aria-expanded', 'true');
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', initPanelToggles);
