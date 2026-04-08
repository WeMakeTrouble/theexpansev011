/**
 * ============================================================================
 * Purchase Codes Manager — CMS View Module
 * File: public/cms/js/modules/purchaseCodesManager.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * View module for managing purchase codes in the CMS admin tool.
 * Follows the drill-down navigation pattern of the left panel menu.
 * All views render in the right-hand content panel (#content-display).
 *
 * NAVIGATION:
 * ---------------------------------------------------------------------------
 * Level 1 — two options: VIEW CODES / GENERATE CODES
 * Level 2a — filtered codes table (back → Level 1)
 * Level 2b — generate form (back → Level 1)
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * merchUtils.js    — _el, _heading, _menuBtn, _logInfo, _logError
 * apiClient.js     — HTTP layer
 * viewController   — View registration and routing
 * toast            — User feedback
 *
 * ============================================================================
 * Project: The Expanse v011
 * Author: James (Project Manager)
 * ============================================================================
 */

import viewController from '../viewController.js';
import toast from '../components/toastNotification.js';
import apiClient from '../apiClient.js';
import {
  _el, _heading, _menuBtn, _logInfo, _logError, _createIdSwatch
} from './merchUtils.js';

const MODULE_NAME = 'purchaseCodesManager';

/* ============================================================================
 * HELPERS
 * ============================================================================ */

function _formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString();
}

function _typeBadge(codeType) {
  const badge = _el('span', '');
  badge.style.cssText = 'font-family:monospace; font-size:0.75em; padding:1px 6px; border:1px solid;';
  if (codeType === 'vip') {
    badge.textContent = 'VIP';
    badge.style.cssText += 'color:#ffd700; border-color:#ffd700;';
  } else {
    badge.textContent = 'STD';
    badge.style.cssText += 'color:#008844; border-color:#008844;';
  }
  return badge;
}

function _claimedBadge(isClaimed) {
  const badge = _el('span', '');
  badge.style.cssText = 'font-family:monospace; font-size:0.75em; padding:1px 6px; border:1px solid;';
  if (isClaimed) {
    badge.textContent = 'CLAIMED';
    badge.style.cssText += 'color:#008844; border-color:#008844;';
  } else {
    badge.textContent = 'UNCLAIMED';
    badge.style.cssText += 'color:#00ff75; border-color:#00ff75;';
  }
  return badge;
}

function _backBtn(label, onClick) {
  const btn = _menuBtn(label || '\u2190 BACK', 'nav');
  btn.style.marginBottom = '12px';
  btn.addEventListener('click', onClick);
  return btn;
}

/* ============================================================================
 * LEVEL 1 — Main Menu
 * ============================================================================ */

function _renderMainMenu(container, signal) {
  const wrapper = _el('div', 'purchase-codes-menu');
  wrapper.dataset.testid = 'purchase-codes-menu';
  wrapper.style.cssText = 'padding:4px;';

  wrapper.appendChild(_heading('PURCHASE CODES'));

  const viewBtn = _menuBtn('VIEW CODES');
  viewBtn.addEventListener('click', () => {
    if (signal.aborted) return;
    _renderCodesList(container, signal, { code_type: null, is_claimed: null });
  });
  wrapper.appendChild(viewBtn);

  const generateBtn = _menuBtn('GENERATE CODES');
  generateBtn.addEventListener('click', () => {
    if (signal.aborted) return;
    _renderGenerateForm(container, signal);
  });
  wrapper.appendChild(generateBtn);

  container.replaceChildren(wrapper);
}

/* ============================================================================
 * LEVEL 2a — Codes List
 * ============================================================================ */

async function _renderCodesList(container, signal, filters) {
  const wrapper = _el('div', 'purchase-codes-list-view');
  wrapper.dataset.testid = 'purchase-codes-list-view';
  wrapper.style.cssText = 'padding:4px;';

  wrapper.appendChild(_backBtn('\u2190 BACK', () => {
    if (!signal.aborted) _renderMainMenu(container, signal);
  }));

  wrapper.appendChild(_heading('VIEW CODES'));

  // Filter toolbar
  const toolbar = _el('div', '');
  toolbar.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; align-items:center;';

  const typeLabel = _el('span', '', 'Type:');
  typeLabel.style.cssText = 'color:#008844; font-family:monospace; font-size:0.75em;';
  toolbar.appendChild(typeLabel);

  for (const f of ['all', 'standard', 'vip']) {
    const fb = _menuBtn(f.toUpperCase(), 'sub');
    fb.dataset.filterType = f;
    if (f === (filters.code_type || 'all')) fb.classList.add('menu-button--active');
    fb.addEventListener('click', () => {
      if (signal.aborted) return;
      _renderCodesList(container, signal, {
        ...filters,
        code_type: f === 'all' ? null : f
      });
    });
    toolbar.appendChild(fb);
  }

  const claimedLabel = _el('span', '', 'Status:');
  claimedLabel.style.cssText = 'color:#008844; font-family:monospace; font-size:0.75em; margin-left:8px;';
  toolbar.appendChild(claimedLabel);

  for (const f of ['all', 'unclaimed', 'claimed']) {
    const fb = _menuBtn(f.toUpperCase(), 'sub');
    const activeVal = filters.is_claimed === null ? 'all' : filters.is_claimed ? 'claimed' : 'unclaimed';
    if (f === activeVal) fb.classList.add('menu-button--active');
    fb.addEventListener('click', () => {
      if (signal.aborted) return;
      _renderCodesList(container, signal, {
        ...filters,
        is_claimed: f === 'all' ? null : f === 'claimed'
      });
    });
    toolbar.appendChild(fb);
  }

  wrapper.appendChild(toolbar);

  const listArea = _el('div', '');
  listArea.dataset.testid = 'purchase-codes-list';

  const loading = _el('div', '', 'Loading...');
  loading.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em;';
  listArea.appendChild(loading);

  wrapper.appendChild(listArea);
  container.replaceChildren(wrapper);

  try {
    const params = new URLSearchParams();
    if (filters.code_type) params.set('code_type', filters.code_type);
    if (filters.is_claimed !== null && filters.is_claimed !== undefined) {
      params.set('is_claimed', String(filters.is_claimed));
    }
    params.set('limit', '200');

    const data = await apiClient.get('/purchase-codes?' + params.toString(), { signal });
    if (signal.aborted) return;

    listArea.innerHTML = '';

    if (!data || !Array.isArray(data.codes)) {
      const errMsg = _el('div', '', 'Failed to load purchase codes');
      errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
      listArea.appendChild(errMsg);
      return;
    }

    if (data.codes.length === 0) {
      const empty = _el('div', '', 'No codes found.');
      empty.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:16px 0; text-align:center;';
      listArea.appendChild(empty);
      return;
    }

    const countLabel = _el('div', '',
      data.codes.length + ' of ' + data.pagination.total + ' code' + (data.pagination.total !== 1 ? 's' : '')
    );
    countLabel.style.cssText = 'color:#008844; font-family:monospace; font-size:0.7em; margin-bottom:6px;';
    listArea.appendChild(countLabel);

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-family:monospace; font-size:0.78em;';
    table.dataset.testid = 'purchase-codes-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.cssText = 'border-bottom:1px solid #004422;';
    for (const h of ['ID', 'Code', 'Type', 'Status', 'Claimed By', 'Batch', 'Created', '']) {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left; color:#008844; padding:4px 8px; font-weight:normal;';
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const fragment = document.createDocumentFragment();

    for (const code of data.codes) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid #001a0a;';
      tr.dataset.testid = 'code-row-' + code.code_id;

      const idCell = document.createElement('td');
      idCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
      idCell.appendChild(_createIdSwatch(code.code_id));
      idCell.appendChild(document.createTextNode(code.code_id));
      tr.appendChild(idCell);

      const codeCell = document.createElement('td');
      codeCell.style.cssText = 'padding:5px 8px; color:#00ff75; font-weight:bold; letter-spacing:1px;';
      codeCell.textContent = code.code;
      tr.appendChild(codeCell);

      const typeCell = document.createElement('td');
      typeCell.style.cssText = 'padding:5px 8px;';
      typeCell.appendChild(_typeBadge(code.code_type));
      tr.appendChild(typeCell);

      const statusCell = document.createElement('td');
      statusCell.style.cssText = 'padding:5px 8px;';
      statusCell.appendChild(_claimedBadge(code.is_claimed));
      tr.appendChild(statusCell);

      const claimedByCell = document.createElement('td');
      claimedByCell.style.cssText = 'padding:5px 8px; color:#008844;';
      claimedByCell.textContent = code.claimed_by_username || '—';
      tr.appendChild(claimedByCell);

      const batchCell = document.createElement('td');
      batchCell.style.cssText = 'padding:5px 8px; color:#008844;';
      batchCell.textContent = code.batch_label || '—';
      tr.appendChild(batchCell);

      const createdCell = document.createElement('td');
      createdCell.style.cssText = 'padding:5px 8px; color:#008844;';
      createdCell.textContent = _formatDate(code.created_at);
      tr.appendChild(createdCell);

      const actionsCell = document.createElement('td');
      actionsCell.style.cssText = 'padding:5px 8px;';

      if (!code.is_claimed) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = 'DELETE';
        delBtn.style.cssText = 'font-family:monospace; font-size:0.7em; padding:2px 6px; background:#1a0000; border:1px solid #ff4444; color:#ff4444; cursor:pointer;';
        delBtn.addEventListener('click', async () => {
          if (signal.aborted) return;
          if (!confirm('Delete code ' + code.code + '?')) return;
          delBtn.disabled = true;
          delBtn.textContent = '...';
          try {
            const result = await apiClient.delete(
              '/purchase-codes/' + encodeURIComponent(code.code_id),
              { signal }
            );
            if (signal.aborted) return;
            if (result && result.success) {
              toast.success('Code deleted');
              _renderCodesList(container, signal, filters);
            } else {
              toast.error(result?.error || 'Delete failed');
              delBtn.disabled = false;
              delBtn.textContent = 'DELETE';
            }
          } catch (err) {
            if (signal.aborted) return;
            toast.error('Delete failed: ' + err.message);
            delBtn.disabled = false;
            delBtn.textContent = 'DELETE';
            _logError(MODULE_NAME, 'Delete failed', err);
          }
        });
        actionsCell.appendChild(delBtn);
      }

      tr.appendChild(actionsCell);
      fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
    table.appendChild(tbody);
    listArea.appendChild(table);

  } catch (err) {
    if (signal.aborted) return;
    listArea.innerHTML = '';
    const errMsg = _el('div', '', 'Error loading codes: ' + err.message);
    errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
    listArea.appendChild(errMsg);
    _logError(MODULE_NAME, 'Load failed', err);
  }
}

/* ============================================================================
 * LEVEL 2b — Generate Form
 * ============================================================================ */

function _renderGenerateForm(container, signal) {
  const wrapper = _el('div', 'purchase-codes-generate-view');
  wrapper.dataset.testid = 'purchase-codes-generate-view';
  wrapper.style.cssText = 'padding:4px;';

  wrapper.appendChild(_backBtn('\u2190 BACK', () => {
    if (!signal.aborted) _renderMainMenu(container, signal);
  }));

  wrapper.appendChild(_heading('GENERATE CODES'));

  const form = _el('div', '');
  form.style.cssText = 'display:flex; flex-direction:column; gap:12px; max-width:320px;';

  // Count
  const countWrap = _el('div', '');
  const countLabel = _el('label', '', 'Count (1–500)');
  countLabel.style.cssText = 'display:block; color:#008844; font-family:monospace; font-size:0.75em; margin-bottom:4px;';
  const countInput = document.createElement('input');
  countInput.type = 'number';
  countInput.min = '1';
  countInput.max = '500';
  countInput.value = '10';
  countInput.style.cssText = 'width:100%; background:#0a0a0a; border:1px solid #004422; color:#00ff75; font-family:monospace; font-size:0.85em; padding:6px 8px; box-sizing:border-box;';
  countWrap.appendChild(countLabel);
  countWrap.appendChild(countInput);
  form.appendChild(countWrap);

  // Type
  const typeWrap = _el('div', '');
  const typeLabel = _el('label', '', 'Type');
  typeLabel.style.cssText = 'display:block; color:#008844; font-family:monospace; font-size:0.75em; margin-bottom:4px;';
  const typeSelect = document.createElement('select');
  typeSelect.style.cssText = 'width:100%; background:#0a0a0a; border:1px solid #004422; color:#00ff75; font-family:monospace; font-size:0.85em; padding:6px 8px; box-sizing:border-box;';
  for (const opt of ['standard', 'vip']) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt.toUpperCase();
    typeSelect.appendChild(o);
  }
  typeWrap.appendChild(typeLabel);
  typeWrap.appendChild(typeSelect);
  form.appendChild(typeWrap);

  // Batch label
  const batchWrap = _el('div', '');
  const batchLabel = _el('label', '', 'Batch Label');
  batchLabel.style.cssText = 'display:block; color:#008844; font-family:monospace; font-size:0.75em; margin-bottom:4px;';
  const batchInput = document.createElement('input');
  batchInput.type = 'text';
  batchInput.maxLength = 100;
  batchInput.placeholder = 'e.g. DROP_001';
  batchInput.style.cssText = 'width:100%; background:#0a0a0a; border:1px solid #004422; color:#00ff75; font-family:monospace; font-size:0.85em; padding:6px 8px; box-sizing:border-box;';
  batchWrap.appendChild(batchLabel);
  batchWrap.appendChild(batchInput);
  form.appendChild(batchWrap);

  // Notes
  const notesWrap = _el('div', '');
  const notesLabel = _el('label', '', 'Notes');
  notesLabel.style.cssText = 'display:block; color:#008844; font-family:monospace; font-size:0.75em; margin-bottom:4px;';
  const notesInput = document.createElement('input');
  notesInput.type = 'text';
  notesInput.maxLength = 255;
  notesInput.placeholder = 'Optional';
  notesInput.style.cssText = 'width:100%; background:#0a0a0a; border:1px solid #004422; color:#00ff75; font-family:monospace; font-size:0.85em; padding:6px 8px; box-sizing:border-box;';
  notesWrap.appendChild(notesLabel);
  notesWrap.appendChild(notesInput);
  form.appendChild(notesWrap);

  // Submit
  const submitBtn = _menuBtn('GENERATE');
  form.appendChild(submitBtn);

  const statusMsg = _el('div', '');
  statusMsg.style.cssText = 'font-family:monospace; font-size:0.8em; min-height:1.2em;';
  form.appendChild(statusMsg);

  wrapper.appendChild(form);
  container.replaceChildren(wrapper);

  submitBtn.addEventListener('click', async () => {
    if (signal.aborted) return;

    const count = parseInt(countInput.value);
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      toast.error('Count must be between 1 and 500');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.querySelector('span').textContent = 'GENERATING...';
    statusMsg.textContent = '';
    statusMsg.style.color = '#008844';

    try {
      const payload = {
        count,
        code_type: typeSelect.value,
        batch_label: batchInput.value.trim() || undefined,
        notes: notesInput.value.trim() || undefined
      };

      const data = await apiClient.post('/purchase-codes/generate', payload, { signal });
      if (signal.aborted) return;

      if (data && data.success) {
        toast.success('Generated ' + data.generated + ' codes');
        statusMsg.textContent = data.generated + ' codes generated successfully.';
        statusMsg.style.color = '#00ff75';
        batchInput.value = '';
        notesInput.value = '';
        countInput.value = '10';
      } else {
        toast.error(data?.error || 'Generation failed');
        statusMsg.textContent = data?.error || 'Generation failed.';
        statusMsg.style.color = '#ff4444';
      }
    } catch (err) {
      if (signal.aborted) return;
      toast.error('Generation failed: ' + err.message);
      statusMsg.textContent = 'Error: ' + err.message;
      statusMsg.style.color = '#ff4444';
      _logError(MODULE_NAME, 'Generate failed', err);
    } finally {
      if (!signal.aborted) {
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'GENERATE';
      }
    }
  });
}

/* ============================================================================
 * VIEW REGISTRATION
 * ============================================================================ */

viewController.register('purchase-codes', async (ctx) => {
  const { container, signal } = ctx;
  _renderMainMenu(container, signal);
});

_logInfo(MODULE_NAME, 'Module loaded, 1 handler registered');
