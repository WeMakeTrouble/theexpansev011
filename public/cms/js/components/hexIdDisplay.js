/**
 * ============================================================================
 * Hex ID Display — Colour-Coded ID Badge Component for CMS Admin Tool
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * A reusable UI component that renders hex IDs as interactive badges with
 * a colour swatch, the ID text, and click-to-copy functionality. Every
 * entity list and edit form in the admin tool uses this to display IDs.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import hexIdDisplay from '../components/hexIdDisplay.js';
 *
 *   // Returns an HTMLElement ready to append to any container
 *   const badge = hexIdDisplay.create('#700002');
 *   container.appendChild(badge);
 *
 *   // With options
 *   const badge = hexIdDisplay.create('#700002', { label: 'Claude', size: 'large' });
 *
 * FEATURES:
 * ---------------------------------------------------------------------------
 * - Colour swatch showing the actual hex colour
 * - Monospace ID text
 * - Click to copy ID to clipboard
 * - Visual feedback on copy (brief flash)
 * - Optional entity label alongside the ID
 * - Three sizes: small (inline), medium (default), large (detail view)
 * - Accessible: button role, aria-label, keyboard focusable
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 0 — Foundation
 * Version: v010.1
 * ============================================================================
 */

const HEX_ID_DISPLAY_VERSION = 'v010.1';

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const COPY_FEEDBACK_MS = 1200;

const _metrics = {
  totalCreated: 0,
  totalCopied: 0,
  copyFailures: 0
};

/**
 * Copy text to clipboard with fallback for older browsers
 *
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} True if copy succeeded
 */
async function _copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch (err) {
    return false;
  }
}

/**
 * Create a hex ID display badge element
 *
 * @param {string} hexId - The hex ID to display (e.g., '#700002')
 * @param {object} options - Optional configuration
 * @param {string} options.label - Entity name to show alongside ID
 * @param {string} options.size - 'small', 'medium' (default), or 'large'
 * @param {boolean} options.copyable - Enable click-to-copy (default: true)
 * @returns {HTMLElement} The badge element
 */
function create(hexId, options = {}) {
  const {
    label = null,
    size = 'medium',
    copyable = true
  } = options;

  const isValid = typeof hexId === 'string' && HEX_PATTERN.test(hexId);

  const wrapper = document.createElement('span');
  wrapper.classList.add('hex-badge', `hex-badge--${size}`);

  if (copyable && isValid) {
    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('aria-label', `Copy hex ID ${hexId} to clipboard`);
  }

  const swatch = document.createElement('span');
  swatch.classList.add('hex-badge__swatch');
  swatch.setAttribute('aria-hidden', 'true');
  if (isValid) {
    swatch.style.backgroundColor = hexId;
  } else {
    swatch.style.backgroundColor = '#333333';
  }
  wrapper.appendChild(swatch);

  const idText = document.createElement('code');
  idText.classList.add('hex-badge__id');
  idText.textContent = isValid ? hexId : '(invalid)';
  wrapper.appendChild(idText);

  if (label) {
    const labelSpan = document.createElement('span');
    labelSpan.classList.add('hex-badge__label');
    labelSpan.textContent = label;
    wrapper.appendChild(labelSpan);
  }

  if (copyable && isValid) {
    const handleCopy = async () => {
      const success = await _copyToClipboard(hexId);

      if (success) {
        _metrics.totalCopied++;
        wrapper.classList.add('hex-badge--copied');
        idText.textContent = 'Copied!';

        setTimeout(() => {
          wrapper.classList.remove('hex-badge--copied');
          idText.textContent = hexId;
        }, COPY_FEEDBACK_MS);
      } else {
        _metrics.copyFailures++;
      }
    };

    wrapper.addEventListener('click', handleCopy);
    wrapper.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCopy();
      }
    });
  }

  _metrics.totalCreated++;
  return wrapper;
}

/**
 * Create multiple badges from an array of hex IDs
 *
 * @param {Array<string>} hexIds - Array of hex IDs
 * @param {object} options - Options applied to all badges
 * @returns {DocumentFragment} Fragment containing all badges
 */
function createList(hexIds, options = {}) {
  const fragment = document.createDocumentFragment();
  for (const id of hexIds) {
    fragment.appendChild(create(id, options));
  }
  return fragment;
}

/**
 * Get component metrics for diagnostics
 * @returns {object}
 */
function getMetrics() {
  return {
    version: HEX_ID_DISPLAY_VERSION,
    ..._metrics
  };
}

const hexIdDisplay = Object.freeze({
  create,
  createList,
  getMetrics
});

export default hexIdDisplay;
