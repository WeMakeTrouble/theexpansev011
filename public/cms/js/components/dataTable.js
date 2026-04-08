/**
 * ============================================================================
 * Data Table — Sortable List Component for CMS Admin Tool
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * A reusable table component that renders arrays of data as sortable,
 * accessible HTML tables. Every list view in the admin tool uses this
 * to display entities. Supports column-click sorting, custom cell
 * renderers, row click handlers, and empty state display.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import dataTable from '../components/dataTable.js';
 *
 *   const table = dataTable.create({
 *     columns: [
 *       { key: 'character_id', label: 'ID', renderer: 'hexId' },
 *       { key: 'character_name', label: 'Name' },
 *       { key: 'category', label: 'Category' },
 *       { key: 'is_active', label: 'Active', renderer: 'boolean' }
 *     ],
 *     data: characters,
 *     onRowClick: (row) => ctx.navigateTo('characters', 'character-profiles', 'Edit', row.character_id),
 *     emptyMessage: 'No characters found'
 *   });
 *   container.appendChild(table);
 *
 *   // Cleanup when view changes
 *   table.cleanup();
 *
 * COLUMN DEFINITION:
 * ---------------------------------------------------------------------------
 *   key:       Property name in data objects (required)
 *   label:     Column header text (required)
 *   sortable:  Enable sort on this column (default: true)
 *   renderer:  Built-in renderer name or custom function
 *              Built-in: 'hexId', 'boolean', 'date', 'json', 'number'
 *              Custom: (value, row) => HTMLElement | string
 *
 * SORTING:
 * ---------------------------------------------------------------------------
 * Click a column header to sort ascending. Click again to sort descending.
 * Click a third time to return to original order. Sort indicators (arrows)
 * show current sort state. Only one column sorts at a time.
 *
 * EVENT HANDLING:
 * ---------------------------------------------------------------------------
 * Uses event delegation on thead and tbody rather than per-element
 * listeners. This means:
 *   - No listener accumulation when re-sorting (rows rebuilt without rebinding)
 *   - Only 4 listeners total (thead click + keydown, tbody click + keydown)
 *   - Cleanup removes all 4 in one call
 *
 * ACCESSIBILITY:
 * ---------------------------------------------------------------------------
 * - Proper table semantics (thead, tbody, th, td)
 * - Sortable headers use a button element inside th (correct ARIA pattern)
 * - aria-sort on sortable column headers
 * - scope="col" on header cells
 * - Clickable rows have role="button" and tabindex for keyboard access
 * - Sort state change announced via aria-live polite region
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 0 — Foundation
 * Version: v010.2
 * ============================================================================
 */

import hexIdDisplay from './hexIdDisplay.js';

const DATA_TABLE_VERSION = 'v010.2';

const SORT_STATES = Object.freeze({
  NONE: 'none',
  ASC: 'ascending',
  DESC: 'descending'
});

const _metrics = {
  totalCreated: 0,
  totalSorts: 0,
  totalRowClicks: 0,
  totalCleanups: 0,
  totalConfigErrors: 0
};

/**
 * Sanitise text for safe innerHTML insertion
 * @param {string} str - Raw string
 * @returns {string} HTML-safe string
 */
function _sanitise(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Validate column configuration. Throws on invalid config.
 * @param {Array<object>} columns
 * @throws {Error} If columns are invalid
 */
function _validateColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    _metrics.totalConfigErrors++;
    throw new Error('dataTable: columns must be a non-empty array');
  }

  const seenKeys = new Set();

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];

    if (!col.key || typeof col.key !== 'string') {
      _metrics.totalConfigErrors++;
      throw new Error(`dataTable: column[${i}] requires a string "key" property`);
    }

    if (!col.label || typeof col.label !== 'string') {
      _metrics.totalConfigErrors++;
      throw new Error(`dataTable: column[${i}] (${col.key}) requires a string "label" property`);
    }

    if (seenKeys.has(col.key)) {
      _metrics.totalConfigErrors++;
      throw new Error(`dataTable: duplicate column key "${col.key}" at index ${i}`);
    }

    seenKeys.add(col.key);

    if (col.renderer !== undefined
        && typeof col.renderer !== 'string'
        && typeof col.renderer !== 'function') {
      _metrics.totalConfigErrors++;
      throw new Error(`dataTable: column[${i}] (${col.key}) renderer must be a string or function`);
    }
  }
}

/**
 * Built-in cell renderers
 */
const _renderers = {

  hexId(value) {
    if (!value) return document.createTextNode('\u2014');
    return hexIdDisplay.create(value, { size: 'small' });
  },

  boolean(value) {
    const span = document.createElement('span');
    span.classList.add('data-table__bool', value ? 'data-table__bool--true' : 'data-table__bool--false');
    span.textContent = value ? 'Yes' : 'No';
    span.setAttribute('aria-label', value ? 'True' : 'False');
    return span;
  },

  date(value) {
    if (!value) return document.createTextNode('\u2014');
    const d = new Date(value);
    const span = document.createElement('span');
    span.classList.add('data-table__date');
    span.textContent = d.toLocaleDateString('en-AU', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    span.title = d.toISOString();
    return span;
  },

  json(value) {
    if (!value) return document.createTextNode('\u2014');
    const span = document.createElement('span');
    span.classList.add('data-table__json');
    if (Array.isArray(value)) {
      span.textContent = `[${value.length} items]`;
      span.title = JSON.stringify(value, null, 2);
    } else if (typeof value === 'object') {
      const keys = Object.keys(value).length;
      span.textContent = `{${keys} keys}`;
      span.title = JSON.stringify(value, null, 2);
    } else {
      span.textContent = String(value);
    }
    return span;
  },

  number(value) {
    const span = document.createElement('span');
    span.classList.add('data-table__number');
    span.textContent = value !== null && value !== undefined ? String(value) : '\u2014';
    return span;
  }
};

/**
 * Render a cell value using the specified renderer
 *
 * @param {*} value - Cell value from data
 * @param {object} row - Full data row
 * @param {object} column - Column definition
 * @returns {Node} DOM node for the cell
 */
function _renderCell(value, row, column) {
  if (typeof column.renderer === 'function') {
    const result = column.renderer(value, row);
    if (result instanceof Node) return result;
    const span = document.createElement('span');
    span.innerHTML = _sanitise(String(result));
    return span;
  }

  if (typeof column.renderer === 'string' && _renderers[column.renderer]) {
    return _renderers[column.renderer](value, row);
  }

  if (value === null || value === undefined) {
    return document.createTextNode('\u2014');
  }

  return document.createTextNode(String(value));
}

/**
 * Compare two values for sorting
 *
 * @param {*} a - First value
 * @param {*} b - Second value
 * @param {string} direction - 'ascending' or 'descending'
 * @returns {number} Sort comparison result
 */
function _compare(a, b, direction) {
  const multiplier = direction === SORT_STATES.ASC ? 1 : -1;

  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;

  if (typeof a === 'number' && typeof b === 'number') {
    return (a - b) * multiplier;
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return ((a === b) ? 0 : (a ? -1 : 1)) * multiplier;
  }

  return String(a).localeCompare(String(b)) * multiplier;
}

/**
 * Create a sortable data table
 *
 * @param {object} config - Table configuration
 * @param {Array<object>} config.columns - Column definitions
 * @param {Array<object>} config.data - Row data
 * @param {function} config.onRowClick - Optional row click handler, receives row data
 * @param {string} config.emptyMessage - Message when data is empty
 * @param {string} config.className - Optional additional CSS class
 * @returns {HTMLElement} The table wrapper element with cleanup() method
 */
function create(config) {
  const {
    columns = [],
    data = [],
    onRowClick = null,
    emptyMessage = 'No data available',
    className = ''
  } = config;

  _validateColumns(columns);

  const originalData = [...data];
  let currentData = [...data];
  let sortKey = null;
  let sortDirection = SORT_STATES.NONE;

  const wrapper = document.createElement('div');
  wrapper.classList.add('data-table');
  if (className) wrapper.classList.add(className);

  const listeners = [];

  function _addListener(el, event, handler) {
    el.addEventListener(event, handler);
    listeners.push({ el, event, handler });
  }

  if (data.length === 0) {
    const empty = document.createElement('div');
    empty.classList.add('data-table__empty');
    empty.textContent = emptyMessage;
    wrapper.appendChild(empty);
    wrapper.cleanup = () => { _metrics.totalCleanups++; };
    _metrics.totalCreated++;
    return wrapper;
  }

  const table = document.createElement('table');
  table.classList.add('data-table__table');

  const liveRegion = document.createElement('div');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.classList.add('data-table__sr-only');
  wrapper.appendChild(liveRegion);

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  const columnMap = new Map();

  for (const col of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.dataset.key = col.key;

    const sortable = col.sortable !== false;

    if (sortable) {
      th.setAttribute('aria-sort', 'none');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('data-table__sort-btn');

      const headerText = document.createElement('span');
      headerText.classList.add('data-table__header-text');
      headerText.textContent = col.label;
      btn.appendChild(headerText);

      const arrow = document.createElement('span');
      arrow.classList.add('data-table__sort-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '\u2195';
      btn.appendChild(arrow);

      th.appendChild(btn);
      columnMap.set(col.key, { th, arrow, col });
    } else {
      const headerText = document.createElement('span');
      headerText.classList.add('data-table__header-text');
      headerText.textContent = col.label;
      th.appendChild(headerText);
    }

    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);

  function _handleSort(key) {
    const entry = columnMap.get(key);
    if (!entry) return;

    if (sortKey === key) {
      if (sortDirection === SORT_STATES.ASC) {
        sortDirection = SORT_STATES.DESC;
      } else if (sortDirection === SORT_STATES.DESC) {
        sortDirection = SORT_STATES.NONE;
        sortKey = null;
      }
    } else {
      sortKey = key;
      sortDirection = SORT_STATES.ASC;
    }

    if (sortDirection === SORT_STATES.NONE) {
      currentData = [...originalData];
    } else {
      currentData = [...originalData].sort((a, b) =>
        _compare(a[sortKey], b[sortKey], sortDirection)
      );
    }

    for (const [k, v] of columnMap) {
      const isCurrent = k === sortKey;
      v.th.setAttribute('aria-sort', isCurrent ? sortDirection : 'none');
      v.arrow.textContent = isCurrent
        ? (sortDirection === SORT_STATES.ASC ? '\u2191' : sortDirection === SORT_STATES.DESC ? '\u2193' : '\u2195')
        : '\u2195';
    }

    _renderBody(tbody, columns, currentData, onRowClick);

    const sortLabel = sortDirection === SORT_STATES.NONE
      ? 'Sort removed, original order restored'
      : `Sorted by ${entry.col.label}, ${sortDirection}`;
    liveRegion.textContent = sortLabel;

    _metrics.totalSorts++;
  }

  _addListener(thead, 'click', (e) => {
    const btn = e.target.closest('.data-table__sort-btn');
    if (!btn) return;
    const th = btn.closest('th');
    if (!th || !th.dataset.key) return;
    _handleSort(th.dataset.key);
  });

  _addListener(thead, 'keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const btn = e.target.closest('.data-table__sort-btn');
    if (!btn) return;
    e.preventDefault();
    const th = btn.closest('th');
    if (!th || !th.dataset.key) return;
    _handleSort(th.dataset.key);
  });

  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (onRowClick) {
    _addListener(tbody, 'click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr || !tbody.contains(tr)) return;
      const rowIndex = [...tbody.children].indexOf(tr);
      if (rowIndex >= 0 && rowIndex < currentData.length) {
        _metrics.totalRowClicks++;
        onRowClick(currentData[rowIndex]);
      }
    });

    _addListener(tbody, 'keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr');
      if (!tr || !tbody.contains(tr)) return;
      e.preventDefault();
      const rowIndex = [...tbody.children].indexOf(tr);
      if (rowIndex >= 0 && rowIndex < currentData.length) {
        _metrics.totalRowClicks++;
        onRowClick(currentData[rowIndex]);
      }
    });
  }

  _renderBody(tbody, columns, currentData, onRowClick);
  table.appendChild(tbody);

  wrapper.appendChild(table);

  const count = document.createElement('div');
  count.classList.add('data-table__count');
  count.textContent = `${data.length} record${data.length !== 1 ? 's' : ''}`;
  wrapper.appendChild(count);

  wrapper.cleanup = () => {
    for (const entry of listeners) {
      entry.el.removeEventListener(entry.event, entry.handler);
    }
    listeners.length = 0;
    _metrics.totalCleanups++;
  };

  _metrics.totalCreated++;
  return wrapper;
}

/**
 * Render table body rows.
 * No per-row event listeners — delegation handles interaction on tbody.
 *
 * @param {HTMLElement} tbody - Table body element to populate
 * @param {Array<object>} columns - Column definitions
 * @param {Array<object>} data - Row data
 * @param {function|null} onRowClick - Presence determines clickable styling
 */
function _renderBody(tbody, columns, data, onRowClick) {
  tbody.replaceChildren();

  for (const row of data) {
    const tr = document.createElement('tr');

    if (onRowClick) {
      tr.classList.add('data-table__row--clickable');
      tr.setAttribute('role', 'button');
      tr.setAttribute('tabindex', '0');
    }

    for (const col of columns) {
      const td = document.createElement('td');
      td.appendChild(_renderCell(row[col.key], row, col));
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

/**
 * Get component metrics for diagnostics
 * @returns {object}
 */
function getMetrics() {
  return {
    version: DATA_TABLE_VERSION,
    ..._metrics
  };
}

/**
 * Reset metrics counters (useful for testing)
 */
function resetMetrics() {
  _metrics.totalCreated = 0;
  _metrics.totalSorts = 0;
  _metrics.totalRowClicks = 0;
  _metrics.totalCleanups = 0;
  _metrics.totalConfigErrors = 0;
}

const dataTable = Object.freeze({
  create,
  getMetrics,
  resetMetrics
});

export default dataTable;
