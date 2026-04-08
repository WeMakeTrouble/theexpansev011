/**
 * ============================================================================
 * Modal — Full-Viewport Overlay Component for CMS Admin Tool
 * File: public/cms/js/components/modal.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * A reusable modal overlay that provides a full-viewport container for
 * detail views, pickers, and forms. Renders above all other content with
 * a dark backdrop. Supports Escape key, backdrop click, and X button close.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import modal from '../components/modal.js';
 *
 *   // Open with any DOM content
 *   const content = document.createElement('div');
 *   content.textContent = 'Hello from a modal';
 *   modal.open(content);
 *
 *   // Open with title
 *   modal.open(content, { title: 'ASSET DETAIL' });
 *
 *   // Close programmatically
 *   modal.close();
 *
 *   // Check state
 *   if (modal.isOpen()) { ... }
 *
 * FEATURES:
 * ---------------------------------------------------------------------------
 * - Full-viewport overlay with dark backdrop and body scroll lock
 * - Close via X button, Escape key, or backdrop click
 * - Focus trap for accessibility (Tab cycles within modal)
 * - ARIA role="dialog" and aria-modal="true"
 * - Optional title rendered as heading
 * - CRT terminal aesthetic (green-on-black)
 * - Returns the modal panel for external manipulation
 *
 * ACCESSIBILITY:
 * ---------------------------------------------------------------------------
 * - role="dialog", aria-modal="true"
 * - aria-labelledby when title provided
 * - Focus trapped within modal while open
 * - Focus returned to trigger element on close
 * - Escape key closes modal
 * - Body scroll locked while open
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 6 — Asset Management (Shared Component)
 * ============================================================================
 */

let _activeModal = null;
let _previousFocus = null;
let _previousOverflow = null;
let _titleCounter = 0;

/**
 * Handle Escape key to close modal.
 *
 * @param {KeyboardEvent} e
 */
function _handleEscape(e) {
  if (e.key === 'Escape') modal.close();
}

/**
 * Trap Tab focus within the modal.
 * Shift+Tab from first element wraps to last.
 * Tab from last element wraps to first.
 * Recalculates focusables on every press to handle dynamic content.
 *
 * @param {HTMLElement} container - Modal panel
 * @param {KeyboardEvent} e
 */
function _handleTabTrap(container, e) {
  if (e.key !== 'Tab') return;

  const focusables = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
}

/**
 * Modal component.
 * Singleton — only one modal can be open at a time.
 *
 * @type {Object}
 */
const modal = Object.freeze({

  /**
   * Open a modal with the given content.
   * Closes any existing modal first.
   * Locks body scroll and traps focus within the modal.
   *
   * @param {HTMLElement} content - DOM element to display
   * @param {Object} [options={}]
   * @param {string} [options.title] - Optional heading text
   * @param {string} [options.maxWidth='900px'] - Max width of modal
   * @param {function} [options.onClose] - Callback when modal closes
   * @returns {HTMLElement} The modal panel element
   * @throws {TypeError} If content is not an HTMLElement
   */
  open(content, options = {}) {
    if (!(content instanceof HTMLElement)) {
      throw new TypeError('Modal content must be an HTMLElement');
    }

    modal.close();

    _previousFocus = document.activeElement;
    _previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const backdrop = document.createElement('div');
    backdrop.className = 'cms-modal-backdrop';
    backdrop.dataset.testid = 'cms-modal-backdrop';
    backdrop.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.92); z-index:9999; display:flex; justify-content:center; align-items:flex-start; overflow-y:auto; padding:24px;';

    const panel = document.createElement('div');
    panel.className = 'cms-modal-panel';
    panel.dataset.testid = 'cms-modal-panel';
    panel.style.cssText = `background:#0a0a0a; border:2px solid #00ff75; max-width:${options.maxWidth || '900px'}; width:100%; padding:20px; position:relative; font-family:monospace; margin:auto;`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cms-modal-close';
    closeBtn.dataset.testid = 'cms-modal-close';
    closeBtn.textContent = 'X CLOSE';
    closeBtn.style.cssText = 'position:absolute; top:10px; right:10px; background:transparent; color:#ff4444; border:1px solid #ff4444; padding:4px 10px; font-family:monospace; cursor:pointer; font-size:0.8em;';
    closeBtn.setAttribute('aria-label', 'Close modal');
    closeBtn.addEventListener('click', () => modal.close());
    panel.appendChild(closeBtn);

    if (options.title) {
      _titleCounter++;
      const titleId = 'cms-modal-title-' + _titleCounter;
      const heading = document.createElement('h2');
      heading.id = titleId;
      heading.dataset.testid = 'cms-modal-title';
      heading.textContent = options.title;
      heading.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.95em; border-bottom:1px solid #00ff75; padding-bottom:6px; margin:0 0 16px 0; padding-right:80px;';
      panel.setAttribute('aria-labelledby', titleId);
      panel.appendChild(heading);
    }

    panel.appendChild(content);
    backdrop.appendChild(panel);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) modal.close();
    });

    panel.addEventListener('keydown', (e) => _handleTabTrap(panel, e));

    document.addEventListener('keydown', _handleEscape);

    _activeModal = { backdrop, panel, onClose: options.onClose || null };
    document.body.appendChild(backdrop);

    closeBtn.focus();

    return panel;
  },

  /**
   * Close the active modal if one is open.
   * Restores body scroll and focus to the previous element.
   */
  close() {
    if (!_activeModal) return;

    const { backdrop, onClose } = _activeModal;

    document.removeEventListener('keydown', _handleEscape);
    backdrop.remove();

    document.body.style.overflow = _previousOverflow || '';
    _previousOverflow = null;

    if (onClose) {
      try { onClose(); } catch (e) {
        console.error('[modal] onClose callback error', e);
      }
    }

    _activeModal = null;

    if (_previousFocus && typeof _previousFocus.focus === 'function') {
      _previousFocus.focus();
    }
    _previousFocus = null;
  },

  /**
   * Check if a modal is currently open.
   *
   * @returns {boolean}
   */
  isOpen() {
    return _activeModal !== null;
  }
});

export default modal;
