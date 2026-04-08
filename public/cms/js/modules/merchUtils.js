/**
 * ============================================================================
 * Merch Utilities — Constants, DOM Helpers, Formatters
 * File: public/cms/js/modules/merchUtils.js
 * ============================================================================
 */

export const STATUS_COLOURS = Object.freeze({
  draft:    '#008844',
  upcoming: '#00aaff',
  live:     '#00ff75',
  sold_out: '#ff8800',
  closed:   '#ff4444',
});

export const VALID_TRANSITIONS = Object.freeze({
  draft:    ['upcoming', 'closed'],
  upcoming: ['live', 'closed'],
  live:     ['sold_out', 'closed'],
  sold_out: ['closed'],
  closed:   [],
});

export const ALL_STATUSES = Object.freeze(['draft', 'upcoming', 'live', 'sold_out', 'closed']);

export const API_PATHS = Object.freeze({
  DROPS:  '/merch/drops',
  ORDERS: '/merch/orders',
  AUDIT:  '/merch/audit',
});

export const VARIANTS = Object.freeze([
  { name: 'original',    label: 'Original',    dims: 'source' },
  { name: 'profile',     label: 'Portrait',    dims: '1080x1350' },
  { name: 'profile_hd',  label: 'Portrait HD', dims: '2160x2700' },
  { name: 'gallery',     label: 'Gallery',     dims: '1080x810' },
  { name: 'thumbnail',   label: 'Thumbnail',   dims: '128x128' },
  { name: 'banner',      label: 'Banner',      dims: '1200x400' },
  { name: 'radar',       label: 'Radar',       dims: '512x512' },
  { name: 'card_mobile', label: 'Mobile Card', dims: '1080x1920' },
]);

export function _el(tag, classes, text) {
  const el = document.createElement(tag);
  if (classes) el.className = classes;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

export function _heading(text) {
  const h = _el('h2', 'section-heading', text);
  h.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.95em; border-bottom:1px solid #00ff75; padding-bottom:6px; margin:0 0 10px 0;';
  return h;
}

export function _label(text, forId) {
  const l = _el('label', '', text);
  if (forId) {
    l.htmlFor = forId;
    l.setAttribute('for', forId);
  }
  l.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.75em; display:block; margin-bottom:2px;';
  return l;
}

export function _input(type, id, placeholder) {
  const inp = document.createElement('input');
  inp.type = type;
  inp.id = id;
  inp.dataset.testid = id;
  inp.placeholder = placeholder || '';
  inp.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; font-size:0.8em; padding:4px 6px; width:100%; box-sizing:border-box; margin-bottom:6px;';
  return inp;
}

export function _textarea(id, placeholder, rows) {
  rows = rows || 3;
  const ta = document.createElement('textarea');
  ta.id = id;
  ta.dataset.testid = id;
  ta.placeholder = placeholder || '';
  ta.rows = rows;
  ta.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; font-size:0.8em; padding:4px 6px; width:100%; box-sizing:border-box; margin-bottom:6px; resize:vertical;';
  return ta;
}

export function _btn(text, testid, variant) {
  variant = variant || 'primary';
  const b = _el('button', '', text);
  b.type = 'button';
  b.dataset.testid = testid || '';
  const base = 'border:none; padding:4px 14px; font-family:monospace; cursor:pointer; font-size:0.8em; margin-right:6px;';
  if (variant === 'danger') {
    b.style.cssText = base + 'background:#ff4444; color:#000; font-weight:bold;';
  } else if (variant === 'secondary') {
    b.style.cssText = base + 'background:#000; color:#00ff75; border:1px solid #00ff75;';
  } else {
    b.style.cssText = base + 'background:#00ff75; color:#000; font-weight:bold;';
  }
  return b;
}

export function _statusBadge(status) {
  const colour = STATUS_COLOURS[status] || '#008844';
  const badge = _el('span', '', status.replace('_', ' ').toUpperCase());
  badge.style.cssText = 'color:#000; background:' + colour + '; font-family:monospace; font-size:0.65em; padding:1px 6px; font-weight:bold; letter-spacing:1px;';
  return badge;
}

export function _centsToDisplay(cents) {
  if (cents === null || cents === undefined) return '$0.00';
  return '$' + (cents / 100).toFixed(2);
}

export function _dollarsToCents(dollarStr) {
  const s = String(dollarStr !== null && dollarStr !== undefined ? dollarStr : '').trim();
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const parts = s.split('.');
  const whole = parts[0];
  const frac = parts[1] || '';
  const cents = parseInt(whole + frac.padEnd(2, '0'), 10);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function _logInfo(module, msg, data) {
  if (data !== undefined) {
    console.info('[' + module + '] ' + msg, data);
  } else {
    console.info('[' + module + '] ' + msg);
  }
}

export function _logError(module, msg, error) {
  if (error !== undefined) {
    console.error('[' + module + '] ' + msg, error);
  } else {
    console.error('[' + module + '] ' + msg);
  }
}

export function _createIdSwatch(dropId) {
  const rawId = String(dropId !== null && dropId !== undefined ? dropId : '');
  const hexDigits = rawId.replace('#', '');
  const isHex = /^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{3}$/.test(hexDigits);
  const swatch = _el('span', '');
  swatch.style.cssText = 'display:inline-block; width:8px; height:8px; background:' + (isHex ? '#' + hexDigits : '#008844') + '; margin-right:4px; vertical-align:middle;';
  return swatch;
}

export function _menuBtn(label, variant) {
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('menu-button');
  if (variant === 'sub') button.classList.add('menu-button--sub');
  if (variant === 'nav') button.classList.add('menu-button--nav');
  const span = document.createElement('span');
  span.textContent = label;
  button.appendChild(span);
  return button;
}
