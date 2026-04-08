/**
 * ============================================================================
 * Asset Manager — Media Asset View Module for CMS Admin Tool
 * File: public/cms/js/modules/assetManager.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * View module handling image upload and listing in the CMS admin tool.
 * Asset list renders in the right sidebar panel with compact cards.
 * Detail views open in the shared modal overlay for editing
 * and variant preview.
 *
 * VIEWS HANDLED:
 * ---------------------------------------------------------------------------
 * media-assets        Compact asset list with upload form
 * media-attachments   (Placeholder — entity-to-asset linking)
 *
 * ACCESSIBILITY:
 * ---------------------------------------------------------------------------
 * - Asset cards are semantic buttons with keyboard support
 * - All interactive elements have data-testid attributes
 * - Images use loading="lazy" for performance
 * - Modal integration provides focus trap and scroll lock
 * - Focus returns to triggering card when modal closes
 * - AbortSignal respected for view cancellation
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 6 — Asset Management
 * ============================================================================
 */

import viewController from '../viewController.js';
import apiClient from '../apiClient.js';
import toast from '../components/toastNotification.js';
import modal from '../components/modal.js';

/* ============================================================================
 * CONSTANTS
 * ============================================================================ */

const MODULE_NAME = 'assetManager';

const API_PATHS = Object.freeze({
  ASSETS: '/assets',
  UPLOAD: '/assets/upload'
});

const FOCAL_PRESETS = Object.freeze([
  { value: '', label: 'Default' },
  { value: 'face', label: 'Face' },
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Centre' },
  { value: 'bottom', label: 'Bottom' }
]);

const BLUEPRINT_LABELS = Object.freeze({
  profile: 'Profile (1080x1350)',
  profile_hd: 'Profile HD (2160x2700)',
  gallery: 'Gallery (1080x810)',
  thumbnail: 'Thumbnail (128x128)',
  banner: 'Banner (1200x400)',
  radar: 'Radar (512x512)',
  card_mobile: 'Card (1080x1920)'
});

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
 * DOM HELPERS
 * ============================================================================ */

function _el(tag, classes, text) {
  const el = document.createElement(tag);
  if (classes) el.className = classes;
  if (text) el.textContent = text;
  return el;
}

function _heading(text) {
  const h = _el('h2', 'section-heading', text);
  h.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.95em; border-bottom:1px solid #00ff75; padding-bottom:6px; margin:0 0 10px 0;';
  return h;
}

function _label(text) {
  const l = _el('label', '', text);
  l.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.75em; display:block; margin-bottom:2px;';
  return l;
}

/* ============================================================================
 * ASSET DETAIL (MODAL CONTENT)
 * ============================================================================ */

async function _buildDetailContent(assetId, signal) {
  const wrapper = _el('div', 'asset-detail');
  wrapper.dataset.testid = 'asset-detail';

  try {
    const data = await apiClient.get(
      `${API_PATHS.ASSETS}/${encodeURIComponent(assetId)}`,
      { signal }
    );

    if (!data || !data.success || !data.asset) {
      wrapper.appendChild(_el('div', '', `Asset ${assetId} not found`));
      wrapper.style.color = '#ff4444';
      return wrapper;
    }

    const asset = data.asset;
    const hexDigits = asset.asset_id.replace('#', '');

    const infoGrid = _el('div', 'info-grid');
    infoGrid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:4px 16px; margin-bottom:20px; font-size:0.8em;';

    const fields = [
      ['ID', asset.asset_id],
      ['Type', asset.asset_type],
      ['Filename', asset.original_filename || 'unknown'],
      ['Size', asset.file_size ? `${Math.round(asset.file_size / 1024)}KB` : 'unknown'],
      ['MIME', asset.mime_type || 'unknown'],
      ['Colour', asset.dominant_color || 'not set'],
      ['Focal', asset.focal_point ? JSON.stringify(asset.focal_point) : 'default'],
      ['Created', asset.created_at ? new Date(asset.created_at).toLocaleDateString() : '']
    ];

    for (const [lbl, val] of fields) {
      const l = _el('span', '', `${lbl}:`);
      l.style.cssText = 'color:#008844;';
      const v = _el('span', '', String(val));
      v.style.cssText = 'color:#00ff75; word-break:break-all;';
      infoGrid.appendChild(l);
      infoGrid.appendChild(v);
    }
    wrapper.appendChild(infoGrid);

    wrapper.appendChild(_heading('ORIGINAL'));
    const origImg = document.createElement('img');
    origImg.src = `/assets/${hexDigits}/original.png`;
    origImg.alt = 'Original upload';
    origImg.loading = 'lazy';
    origImg.decoding = 'async';
    origImg.style.cssText = 'max-width:100%; height:auto; border:1px solid #004422; margin-bottom:20px;';
    origImg.onerror = () => {
      origImg.style.display = 'none';
      wrapper.appendChild(_el('div', '', 'Original not available'));
    };
    wrapper.appendChild(origImg);

    wrapper.appendChild(_heading('BLUEPRINT VARIANTS'));

    const grid = _el('div', 'variant-grid');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:10px; margin-bottom:20px;';

    const fragment = document.createDocumentFragment();

    for (const [bp, label] of Object.entries(BLUEPRINT_LABELS)) {
      const cell = _el('div', 'variant-cell');
      cell.style.cssText = 'border:1px solid #004422; padding:6px; background:#050505; text-align:center;';
      cell.dataset.testid = `variant-${bp}`;

      const bpLabel = _el('div', '', label);
      bpLabel.style.cssText = 'color:#008844; font-size:0.7em; margin-bottom:4px;';
      cell.appendChild(bpLabel);

      const img = document.createElement('img');
      img.src = `/assets/${hexDigits}/${bp}.png`;
      img.alt = `${bp} variant`;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.style.cssText = 'max-width:100%; height:auto; border:1px solid #002211;';
      img.onerror = () => {
        img.style.display = 'none';
        const missing = _el('div', '', 'not found');
        missing.style.cssText = 'color:#ff4444; font-size:0.65em; padding:16px 0;';
        cell.appendChild(missing);
      };
      cell.appendChild(img);
      fragment.appendChild(cell);
    }

    grid.appendChild(fragment);
    wrapper.appendChild(grid);

    if (asset.edit_metadata) {
      wrapper.appendChild(_heading('EDIT HISTORY'));
      const pre = _el('pre', '', JSON.stringify(asset.edit_metadata, null, 2));
      pre.style.cssText = 'color:#00aa55; background:#050505; border:1px solid #004422; padding:10px; overflow-x:auto; font-size:0.7em; max-height:200px; overflow-y:auto;';
      pre.dataset.testid = 'asset-edit-history';
      wrapper.appendChild(pre);
    }

  } catch (err) {
    if (err.name === 'AbortError') return wrapper;
    _logError('Failed to load asset detail', err);
    wrapper.appendChild(_el('div', '', 'Error loading asset'));
    wrapper.style.color = '#ff4444';
  }

  return wrapper;
}

/* ============================================================================
 * UPLOAD FORM (COMPACT)
 * ============================================================================ */

function _buildUploadForm(onUpload) {
  const form = _el('div', 'upload-form');
  form.style.cssText = 'border:1px solid #00ff75; padding:10px; margin-bottom:12px; background:#0a0a0a;';
  form.dataset.testid = 'asset-upload-form';

  form.appendChild(_heading('UPLOAD NEW IMAGE'));

  form.appendChild(_label('Image (PNG/JPEG/WEBP):'));
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.dataset.testid = 'asset-upload-file';
  fileInput.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.7em; width:100%; margin-bottom:8px;';
  form.appendChild(fileInput);

  const row = _el('div', '');
  row.style.cssText = 'display:flex; gap:6px; margin-bottom:8px; align-items:center;';

  const focalWrap = _el('div', '');
  focalWrap.style.cssText = 'flex:1;';
  focalWrap.appendChild(_label('Focal:'));
  const focalSelect = document.createElement('select');
  focalSelect.dataset.testid = 'asset-upload-focal';
  focalSelect.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; padding:2px 4px; font-size:0.7em; width:100%;';
  for (const preset of FOCAL_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.value;
    opt.textContent = preset.label;
    focalSelect.appendChild(opt);
  }
  focalWrap.appendChild(focalSelect);
  row.appendChild(focalWrap);

  const crtWrap = _el('div', '');
  crtWrap.style.cssText = 'flex:0 0 auto;';
  const crtLabel = document.createElement('label');
  crtLabel.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.7em; cursor:pointer; white-space:nowrap;';
  const crtCheck = document.createElement('input');
  crtCheck.type = 'checkbox';
  crtCheck.checked = true;
  crtCheck.dataset.testid = 'asset-upload-crt';
  crtCheck.style.cssText = 'margin-right:4px;';
  crtLabel.appendChild(crtCheck);
  crtLabel.appendChild(document.createTextNode('CRT'));
  crtWrap.appendChild(crtLabel);
  row.appendChild(crtWrap);

  form.appendChild(row);

  const btnRow = _el('div', '');
  btnRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

  const uploadBtn = _el('button', '', 'UPLOAD');
  uploadBtn.type = 'button';
  uploadBtn.dataset.testid = 'asset-upload-submit';
  uploadBtn.style.cssText = 'background:#00ff75; color:#000; border:none; padding:4px 16px; font-family:monospace; font-weight:bold; cursor:pointer; font-size:0.8em;';

  const statusMsg = _el('span', '', '');
  statusMsg.dataset.testid = 'asset-upload-status';
  statusMsg.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.7em;';
  statusMsg.setAttribute('aria-live', 'polite');

  uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) {
      toast.warn('No file selected');
      return;
    }

    uploadBtn.disabled = true;
    statusMsg.textContent = 'Processing...';

    try {
      const metadata = {};
      if (focalSelect.value) {
        metadata.focalPreset = focalSelect.value;
      }
      metadata.applyCrt = crtCheck.checked ? 'true' : 'false';

      const result = await apiClient.upload(API_PATHS.UPLOAD, file, metadata);

      if (result && result.success) {
        toast.success(`Asset ${result.assetId} created`);
        statusMsg.textContent = result.assetId;
        fileInput.value = '';
        focalSelect.value = '';
        crtCheck.checked = true;
        if (onUpload) onUpload(result);
      } else {
        toast.error(result?.error || 'Upload failed');
        statusMsg.textContent = 'Failed';
      }
    } catch (err) {
      _logError('Upload failed', err);
      toast.error('Upload failed: ' + err.message);
      statusMsg.textContent = 'Error';
    } finally {
      uploadBtn.disabled = false;
    }
  });

  btnRow.appendChild(uploadBtn);
  btnRow.appendChild(statusMsg);
  form.appendChild(btnRow);

  return form;
}

/* ============================================================================
 * ASSET LIST (COMPACT CARDS)
 * ============================================================================ */

function _buildAssetCard(asset, signal) {
  const card = _el('button', 'asset-card');
  card.type = 'button';
  card.dataset.testid = `asset-card-${asset.asset_id}`;
  card.setAttribute('aria-label', `View asset ${asset.asset_id}${asset.original_filename ? ' — ' + asset.original_filename : ''}`);
  card.style.cssText = 'border:1px solid #004422; padding:6px; margin-bottom:6px; background:#0a0a0a; display:flex; gap:8px; align-items:center; cursor:pointer; width:100%; text-align:left; font-family:monospace;';

  const thumb = document.createElement('img');
  const hexDigits = asset.asset_id.replace('#', '');
  thumb.src = `/assets/${hexDigits}/thumbnail.png`;
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.decoding = 'async';
  thumb.style.cssText = 'width:36px; height:36px; object-fit:cover; border:1px solid #004422; image-rendering:pixelated; flex-shrink:0;';
  thumb.onerror = () => {
    thumb.style.cssText = 'width:36px; height:36px; background:#001a0a; border:1px solid #004422; flex-shrink:0;';
  };
  card.appendChild(thumb);

  const info = _el('div', '');
  info.style.cssText = 'flex:1; min-width:0; overflow:hidden;';

  const idRow = _el('div', '');
  idRow.style.cssText = 'font-size:0.75em; font-weight:bold; color:#00ff75; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
  const swatch = _el('span', '');
  swatch.style.cssText = `display:inline-block; width:8px; height:8px; background:${asset.asset_id}; margin-right:4px; vertical-align:middle;`;
  idRow.appendChild(swatch);
  idRow.appendChild(document.createTextNode(asset.asset_id));
  info.appendChild(idRow);

  if (asset.original_filename) {
    const nameRow = _el('div', '', asset.original_filename);
    nameRow.style.cssText = 'color:#008844; font-size:0.65em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    info.appendChild(nameRow);
  }

  card.appendChild(info);

  card.addEventListener('click', async () => {
    const content = await _buildDetailContent(asset.asset_id, signal);
    if (signal && signal.aborted) return;
    modal.open(content, {
      title: `ASSET ${asset.asset_id}`,
      onClose: () => { card.focus(); }
    });
  });

  return card;
}

async function _renderAssetList(container, signal) {
  const listWrapper = _el('div', 'asset-list');
  listWrapper.dataset.testid = 'asset-list';

  try {
    const data = await apiClient.get(API_PATHS.ASSETS, { signal });

    if (signal && signal.aborted) return;

    if (!data || !data.success || !data.assets) {
      listWrapper.appendChild(_el('div', '', 'Failed to load assets'));
      listWrapper.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
      container.appendChild(listWrapper);
      return;
    }

    if (data.assets.length === 0) {
      const empty = _el('div', '', 'No assets yet. Upload your first image above.');
      empty.style.cssText = 'color:#008844; font-family:monospace; padding:16px 0; text-align:center; font-size:0.8em;';
      listWrapper.appendChild(empty);
    } else {
      const countLabel = _el('div', '', `${data.pagination.total} asset${data.pagination.total !== 1 ? 's' : ''}`);
      countLabel.style.cssText = 'color:#008844; font-family:monospace; margin-bottom:6px; font-size:0.7em;';
      listWrapper.appendChild(countLabel);

      const fragment = document.createDocumentFragment();
      for (const asset of data.assets) {
        fragment.appendChild(_buildAssetCard(asset, signal));
      }
      listWrapper.appendChild(fragment);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    _logError('Failed to load asset list', err);
    const errMsg = _el('div', '', 'Error loading assets');
    errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
    listWrapper.appendChild(errMsg);
  }

  container.appendChild(listWrapper);
}

/* ============================================================================
 * VIEW REGISTRATION
 * ============================================================================ */

viewController.register('media-assets', async (ctx) => {
  const { container, signal } = ctx;
  const wrapper = _el('div', 'asset-manager');
  wrapper.style.cssText = 'padding:4px;';
  wrapper.dataset.testid = 'asset-manager';

  wrapper.appendChild(_heading('MEDIA ASSETS'));

  const uploadForm = _buildUploadForm(async () => {
    const listContainer = wrapper.querySelector('.asset-list');
    if (listContainer) listContainer.remove();
    await _renderAssetList(wrapper, signal);
  });
  wrapper.appendChild(uploadForm);

  container.replaceChildren(wrapper);

  await _renderAssetList(wrapper, signal);
});

viewController.register('media-attachments', async (ctx) => {
  const { container } = ctx;
  const wrapper = _el('div', 'attachments-placeholder');
  wrapper.dataset.testid = 'attachments-placeholder';
  wrapper.appendChild(_heading('ENTITY ATTACHMENTS'));
  const msg = _el('div', '', 'Entity-to-asset linking — coming soon.');
  msg.style.cssText = 'color:#008844; font-family:monospace; padding:16px 0; font-size:0.8em;';
  wrapper.appendChild(msg);
  container.replaceChildren(wrapper);
});

_logInfo('Module loaded, 2 handlers registered');
