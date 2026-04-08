/**
 * ============================================================================
 * Merch Manager — Drop Management UI
 * File: public/cms/js/modules/merchManager.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * View module for managing limited-edition merchandise drops in the CMS admin
 * tool. Handles drop listing, creation, editing, status transitions, and media.
 * All views render in the right-hand content panel (#content-display).
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * merchUtils.js   DOM helpers, constants, formatters
 * merchApi.js     API calls (wraps apiClient)
 * viewController  View registration and routing
 * toast           User feedback
 *
 * BUGS FIXED FROM v1:
 * ---------------------------------------------------------------------------
 * - Double onSuccess() call removed (line 870 original)
 * - u2190 malformed unicode fixed to literal arrow on back buttons
 * - Raw fetch for image upload replaced with apiClient.upload() via merchApi
 * - submitBtn stays disabled on aborted/falsy result — now re-enabled
 * - drop.id.replace() crash on null — defensive String() wrap via _createIdSwatch
 * - Video URL not validated against platform — client-side regex added
 * ============================================================================
 */

import viewController from '../viewController.js';
import toast from '../components/toastNotification.js';
import {
  _el, _heading, _label, _input, _textarea, _btn, _statusBadge,
  _dollarsToCents, _centsToDisplay, _logInfo, _logError, _createIdSwatch, _menuBtn,
  VALID_TRANSITIONS, ALL_STATUSES, VARIANTS
} from './merchUtils.js';
import { merchApi } from './merchApi.js';

const MODULE_NAME = 'merchManager';

/* ============================================================================
 * DROP DETAIL VIEW
 * ============================================================================ */

async function _buildDropDetail(drop, signal, onRefresh, container, onBack) {
  const wrapper = _el('div', 'merch-drop-detail');
  wrapper.dataset.testid = 'merch-drop-detail';
  wrapper.style.cssText = 'font-family:monospace; font-size:0.85em; color:#00ff75;';

  try {
    const infoGrid = _el('div', '');
    infoGrid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:4px 16px; margin-bottom:16px; font-size:0.8em;';

    const fields = [
      ['ID',          drop.id],
      ['Status',      null],
      ['Total Units', drop.total_units],
      ['Remaining',   drop.units_remaining],
      ['Created',     drop.created_at ? new Date(drop.created_at).toLocaleDateString() : ''],
      ['Updated',     drop.updated_at ? new Date(drop.updated_at).toLocaleDateString() : ''],
    ];

    for (const [lbl, val] of fields) {
      const l = _el('span', '', lbl + ':');
      l.style.color = '#008844';
      infoGrid.appendChild(l);
      if (lbl === 'Status') {
        infoGrid.appendChild(_statusBadge(drop.status));
      } else {
        const v = _el('span', '', String(val));
        v.style.color = '#00ff75';
        infoGrid.appendChild(v);
      }
    }
    wrapper.appendChild(infoGrid);

    wrapper.appendChild(_heading('EDIT DETAILS'));

    const titleId = 'drop-edit-title';
    wrapper.appendChild(_label('Title', titleId));
    const titleInput = _input('text', titleId, 'Drop title');
    titleInput.value = drop.title || '';
    titleInput.maxLength = 200;
    wrapper.appendChild(titleInput);

    const descId = 'drop-edit-description';
    wrapper.appendChild(_label('Description', descId));
    const descArea = _textarea(descId, 'Drop description', 4);
    descArea.value = drop.description || '';
    wrapper.appendChild(descArea);

    const editBtn = _menuBtn('SAVE CHANGES');
    const editStatus = _el('span', '', '');
    editStatus.style.cssText = 'color:#008844; font-size:0.75em; margin-left:8px;';
    editStatus.setAttribute('aria-live', 'polite');

    editBtn.addEventListener('click', async () => {
      if (signal.aborted) return;
      const title = titleInput.value.trim();
      const description = descArea.value.trim();
      if (!title) { toast.warn('Title is required'); return; }
      editBtn.disabled = true;
      editStatus.textContent = 'Saving...';
      try {
        const result = await merchApi.updateDrop(drop.id, { title, description }, signal);
        if (!result || signal.aborted) return;
        toast.success('Drop updated');
        editStatus.textContent = 'Saved.';
        drop.title = result.title || title;
        drop.description = result.description || description;
        if (onRefresh) onRefresh();
      } catch (err) {
        _logError(MODULE_NAME, 'Edit drop failed', err);
        toast.error('Save failed: ' + String(err.message).replace(/</g, '&lt;'));
        editStatus.textContent = 'Error.';
        editBtn.disabled = false;
      }
    });

    const editRow = _el('div', '');
    editRow.style.marginBottom = '16px';
    editRow.appendChild(editBtn);
    editRow.appendChild(editStatus);
    wrapper.appendChild(editRow);

    const transitions = VALID_TRANSITIONS[drop.status] || [];
    if (transitions.length > 0) {
      wrapper.appendChild(_heading('CHANGE STATUS'));
      const warn = _el('div', '', 'Warning: status changes cannot be reversed once applied.');
      warn.style.cssText = 'color:#ff8800; font-size:0.75em; margin-bottom:8px;';
      wrapper.appendChild(warn);

      const statusRow = _el('div', '');
      statusRow.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;';
      const warningStatuses = ['live', 'sold_out', 'closed'];

      for (const toStatus of transitions) {
        const isWarning = warningStatuses.includes(toStatus);
        const transBtn = _btn(
          toStatus.replace('_', ' ').toUpperCase(),
          'drop-status-' + toStatus,
          isWarning ? 'danger' : 'secondary'
        );
        transBtn.dataset.toStatus = toStatus;
        transBtn.addEventListener('click', async () => {
          if (signal.aborted) return;
          const confirmed = window.confirm(
            'Change status from ' + drop.status + ' to ' + toStatus + '?\nThis cannot be undone.'
          );
          if (!confirmed) return;
          transBtn.disabled = true;
          try {
            const result = await merchApi.changeStatus(drop.id, toStatus, signal);
            if (!result || signal.aborted) return;
            toast.success('Status changed to ' + toStatus);
            drop.status = toStatus;
            if (onBack) onBack();
            if (onRefresh) onRefresh();
          } catch (err) {
            _logError(MODULE_NAME, 'Status change failed', err);
            toast.error('Status change failed: ' + String(err.message).replace(/</g, '&lt;'));
            transBtn.disabled = false;
          }
        });
        statusRow.appendChild(transBtn);
      }
      wrapper.appendChild(statusRow);
    } else {
      const closedNote = _el('div', '', 'This drop is closed. No further status transitions are available.');
      closedNote.style.cssText = 'color:#ff4444; font-size:0.75em; margin-top:8px;';
      wrapper.appendChild(closedNote);
    }

    wrapper.appendChild(_heading('MEDIA'));
    const mediaSection = _el('div', 'merch-media-section');
    mediaSection.style.cssText = 'margin-top:4px;';

    const imgBtn = _menuBtn('SHOW IMAGES', 'sub');
    imgBtn.addEventListener('click', async () => {
      if (signal.aborted) return;
      const topPanel = document.getElementById('panel-top');
      if (!topPanel) return;
      const body = topPanel.querySelector('.panel__body') || topPanel;
      body.replaceChildren();
      topPanel.removeAttribute('hidden');
      const loading = _el('div', '', 'Loading images...');
      loading.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:8px;';
      body.appendChild(loading);
      try {
        const data = await merchApi.getMedia(drop.id, signal);
        body.replaceChildren();
        const header = _el('div', '');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:4px 8px; border-bottom:1px solid #004422; margin-bottom:8px;';
        const title = _el('span', '', 'IMAGES — ' + drop.title);
        title.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.8em; font-weight:bold;';
        header.appendChild(title);
        const uploadBtn = _menuBtn('+ UPLOAD IMAGE');
        uploadBtn.style.cssText += 'font-size:0.75em;';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files[0];
          if (!file) return;
          uploadBtn.disabled = true;
          uploadBtn.textContent = 'UPLOADING...';
          try {
            await merchApi.uploadImage(drop.id, file, signal);
            toast.success('Image uploaded — all variants generated');
            imgBtn.click();
          } catch (err) {
            _logError(MODULE_NAME, 'Image upload failed', err);
            toast.error('Upload failed: ' + String(err.message).replace(/</g, '&lt;'));
            uploadBtn.disabled = false;
            uploadBtn.textContent = '+ UPLOAD IMAGE';
          }
        });
        uploadBtn.addEventListener('click', () => fileInput.click());
        header.appendChild(uploadBtn);
        header.appendChild(fileInput);
        body.appendChild(header);
        const images = (data.media || []).filter(m => m.media_type === 'image');
        if (images.length === 0) {
          const empty = _el('div', '', 'No images yet. Upload your first image above.');
          empty.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:16px; text-align:center;';
          body.appendChild(empty);
        } else {
          const grid = _el('div', '');
          grid.style.cssText = 'display:flex; flex-wrap:wrap; gap:12px; padding:8px;';
          for (const item of images) {
            const hexDigits = item.asset_id ? item.asset_id.replace('#', '') : null;
            const origUrl = hexDigits ? '/assets/' + hexDigits + '/original.png' : null;
            const card = _el('div', '');
            card.style.cssText = 'border:1px solid ' + (item.is_primary ? '#00ff75' : '#004422') + '; padding:6px; width:180px; font-family:monospace;';
            if (origUrl) {
              const img = document.createElement('img');
              img.src = origUrl;
              img.alt = 'Original upload';
              img.style.cssText = 'width:168px; height:168px; object-fit:contain; display:block; background:#050505; cursor:pointer;';
              img.title = 'Click to view all variants';
              img.addEventListener('click', () => {
                const overlay = _el('div', '');
                overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.92); z-index:9999; overflow-y:auto; padding:24px;';
                const closeBtn = _btn('CLOSE', 'variant-close', 'secondary');
                closeBtn.style.marginBottom = '16px';
                closeBtn.addEventListener('click', () => overlay.remove());
                overlay.appendChild(closeBtn);
                const varTitle = _el('div', '', 'ALL VARIANTS — ' + item.id);
                varTitle.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.85em; font-weight:bold; margin-bottom:16px;';
                overlay.appendChild(varTitle);
                const varGrid = _el('div', '');
                varGrid.style.cssText = 'display:flex; flex-wrap:wrap; gap:16px;';
                for (const v of VARIANTS) {
                  const vCard = _el('div', '');
                  vCard.style.cssText = 'border:1px solid #004422; padding:8px; width:200px;';
                  const vImg = document.createElement('img');
                  vImg.src = '/assets/' + hexDigits + '/' + v.name + '.png';
                  vImg.alt = v.label;
                  vImg.style.cssText = 'width:184px; height:184px; object-fit:contain; display:block; background:#050505;';
                  vCard.appendChild(vImg);
                  const vLabel = _el('div', '', v.label);
                  vLabel.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.7em; font-weight:bold; margin-top:4px;';
                  vCard.appendChild(vLabel);
                  const vDims = _el('div', '', v.dims);
                  vDims.style.cssText = 'color:#008844; font-family:monospace; font-size:0.65em;';
                  vCard.appendChild(vDims);
                  varGrid.appendChild(vCard);
                }
                overlay.appendChild(varGrid);
                document.body.appendChild(overlay);
              });
              card.appendChild(img);
            }
            if (item.is_primary) {
              const badge = _el('div', '', '★ PRIMARY');
              badge.style.cssText = 'background:#00ff75; color:#000; font-family:monospace; font-size:0.6em; font-weight:bold; padding:2px 4px; margin-top:4px; text-align:center;';
              card.appendChild(badge);
            }
            const btnRow = _el('div', '');
            btnRow.style.cssText = 'display:flex; gap:4px; margin-top:6px; flex-wrap:wrap;';
            if (!item.is_primary) {
              const setPrimBtn = _btn('SET PRIMARY', '', 'secondary');
              setPrimBtn.style.cssText += 'font-size:0.6em; padding:2px 4px;';
              setPrimBtn.addEventListener('click', async () => {
                try {
                  await merchApi.setPrimaryImage(drop.id, item.id, signal);
                  toast.success('Primary image updated');
                  imgBtn.click();
                } catch (err) {
                  toast.error('Failed: ' + String(err.message).replace(/</g, '&lt;'));
                }
              });
              btnRow.appendChild(setPrimBtn);
            }
            const delBtn = _btn('DELETE', '', 'danger');
            delBtn.style.cssText += 'font-size:0.6em; padding:2px 4px;';
            delBtn.addEventListener('click', async () => {
              if (!window.confirm('Delete this image and all its variants? This cannot be undone.')) return;
              try {
                await merchApi.deleteMedia(drop.id, item.id, signal);
                toast.success('Image deleted');
                imgBtn.click();
              } catch (err) {
                toast.error('Delete failed: ' + String(err.message).replace(/</g, '&lt;'));
              }
            });
            btnRow.appendChild(delBtn);
            card.appendChild(btnRow);
            grid.appendChild(card);
          }
          body.appendChild(grid);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        _logError(MODULE_NAME, 'Load images failed', err);
        body.replaceChildren();
        const errMsg = _el('div', '', 'Error loading images: ' + err.message);
        errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em; padding:8px;';
        body.appendChild(errMsg);
      }
    });
    mediaSection.appendChild(imgBtn);

    const vidBtn = _menuBtn('SHOW VIDEOS', 'sub');
    vidBtn.style.marginTop = '6px';
    vidBtn.addEventListener('click', async () => {
      if (signal.aborted) return;
      const bottomPanel = document.getElementById('panel-bottom');
      if (!bottomPanel) return;
      const body = bottomPanel.querySelector('.panel__body') || bottomPanel;
      body.replaceChildren();
      bottomPanel.removeAttribute('hidden');
      const loading = _el('div', '', 'Loading videos...');
      loading.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:8px;';
      body.appendChild(loading);
      try {
        const data = await merchApi.getMedia(drop.id, signal);
        body.replaceChildren();
        const header = _el('div', '');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:4px 8px; border-bottom:1px solid #004422; margin-bottom:8px;';
        const title = _el('span', '', 'VIDEOS — ' + drop.title);
        title.style.cssText = 'color:#00ff75; font-family:monospace; font-size:0.8em; font-weight:bold;';
        header.appendChild(title);
        body.appendChild(header);
        const addForm = _el('div', '');
        addForm.style.cssText = 'padding:8px; border-bottom:1px solid #004422; margin-bottom:8px;';
        addForm.appendChild(_label('Platform', 'video-platform'));
        const platSelect = document.createElement('select');
        platSelect.id = 'video-platform';
        platSelect.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; font-size:0.8em; padding:4px 6px; margin-bottom:6px; width:100%;';
        for (const p of ['youtube', 'vimeo']) {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          platSelect.appendChild(opt);
        }
        addForm.appendChild(platSelect);
        addForm.appendChild(_label('Video URL', 'video-url'));
        const urlInput = _input('text', 'video-url', 'YouTube or Vimeo URL');
        addForm.appendChild(urlInput);
        const addVideoBtn = _menuBtn('+ ADD VIDEO');
        addVideoBtn.style.cssText += 'font-size:0.75em;';
        addVideoBtn.addEventListener('click', async () => {
          if (signal.aborted) return;
          const url = urlInput.value.trim();
          const platform = platSelect.value;
          if (!url) { toast.warn('URL is required'); return; }
          if (platform === 'youtube' && !/youtube\.com|youtu\.be/i.test(url)) {
            toast.warn('URL does not appear to be a YouTube link');
            return;
          }
          if (platform === 'vimeo' && !/vimeo\.com/i.test(url)) {
            toast.warn('URL does not appear to be a Vimeo link');
            return;
          }
          addVideoBtn.disabled = true;
          try {
            await merchApi.addVideo(drop.id, { externalUrl: url, externalPlatform: platform }, signal);
            toast.success('Video added');
            vidBtn.click();
          } catch (err) {
            toast.error('Failed: ' + String(err.message).replace(/</g, '&lt;'));
            addVideoBtn.disabled = false;
          }
        });
        addForm.appendChild(addVideoBtn);
        body.appendChild(addForm);
        const videos = (data.media || []).filter(m => m.media_type === 'video');
        if (videos.length === 0) {
          const empty = _el('div', '', 'No videos yet. Add a YouTube or Vimeo link above.');
          empty.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:16px; text-align:center;';
          body.appendChild(empty);
        } else {
          const list = _el('div', '');
          list.style.cssText = 'padding:8px;';
          for (const item of videos) {
            const row = _el('div', '');
            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #001a0a; padding:6px 0; font-family:monospace; font-size:0.75em; color:#00ff75;';
            const info = _el('span', '', item.external_platform.toUpperCase() + ': ' + item.external_url);
            row.appendChild(info);
            const delBtn = _btn('DELETE', '', 'danger');
            delBtn.style.cssText += 'font-size:0.6em; padding:2px 4px;';
            delBtn.addEventListener('click', async () => {
              if (!window.confirm('Delete this video?')) return;
              try {
                await merchApi.deleteMedia(drop.id, item.id, signal);
                toast.success('Video deleted');
                vidBtn.click();
              } catch (err) {
                toast.error('Delete failed: ' + String(err.message).replace(/</g, '&lt;'));
              }
            });
            row.appendChild(delBtn);
            list.appendChild(row);
          }
          body.appendChild(list);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        _logError(MODULE_NAME, 'Load videos failed', err);
        body.replaceChildren();
        const errMsg = _el('div', '', 'Error loading videos: ' + err.message);
        errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em; padding:8px;';
        body.appendChild(errMsg);
      }
    });
    mediaSection.appendChild(vidBtn);
    wrapper.appendChild(mediaSection);

  } catch (err) {
    if (err.name === 'AbortError') return wrapper;
    _logError(MODULE_NAME, 'Failed to build drop detail', err);
    const errMsg = _el('div', '', 'Error loading drop detail');
    errMsg.style.color = '#ff4444';
    wrapper.appendChild(errMsg);
  }

  return wrapper;
}

/* ============================================================================
 * CREATE DROP FORM
 * ============================================================================ */

function _buildCreateForm(signal, onSuccess) {
  const wrapper = _el('div', 'merch-create-form');
  wrapper.dataset.testid = 'merch-create-form';
  wrapper.style.cssText = 'font-family:monospace; font-size:0.85em; color:#00ff75;';

  wrapper.appendChild(_heading('BASIC DETAILS'));

  const titleId = 'create-title';
  wrapper.appendChild(_label('Title *', titleId));
  const titleInput = _input('text', titleId, 'Drop title (required)');
  titleInput.maxLength = 200;
  wrapper.appendChild(titleInput);

  const descId = 'create-description';
  wrapper.appendChild(_label('Description', descId));
  const descArea = _textarea(descId, 'Drop description (optional)', 3);
  wrapper.appendChild(descArea);

  const unitsId = 'create-units';
  wrapper.appendChild(_label('Total Units *', unitsId));
  const unitsInput = _input('number', unitsId, '75');
  unitsInput.min = '1';
  unitsInput.max = '1000';
  unitsInput.value = '75';
  wrapper.appendChild(unitsInput);

  wrapper.appendChild(_label('Initial Status', 'create-status'));
  const statusSelect = document.createElement('select');
  statusSelect.id = 'create-status';
  statusSelect.dataset.testid = 'create-status';
  statusSelect.style.cssText = 'background:#000; color:#00ff75; border:1px solid #00ff75; font-family:monospace; font-size:0.8em; padding:4px 6px; width:100%; margin-bottom:12px;';
  for (const s of ['draft', 'upcoming']) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    statusSelect.appendChild(opt);
  }
  wrapper.appendChild(statusSelect);

  wrapper.appendChild(_heading('PRICING'));

  const pricingNote = _el('div', '', 'Enter prices in AUD dollars (e.g. 45.00). Stripe IDs are optional — add them when products are configured in Stripe.');
  pricingNote.style.cssText = 'color:#008844; font-size:0.75em; margin-bottom:10px;';
  wrapper.appendChild(pricingNote);

  const auPriceId = 'create-price-au';
  wrapper.appendChild(_label('AU Price (AUD) *', auPriceId));
  const auPriceInput = _input('number', auPriceId, '45.00');
  auPriceInput.min = '1';
  auPriceInput.step = '0.01';
  wrapper.appendChild(auPriceInput);

  const auProdId = 'create-stripe-product-au';
  wrapper.appendChild(_label('AU Stripe Product ID (optional)', auProdId));
  const auStripeProduct = _input('text', auProdId, 'prod_xxx');
  wrapper.appendChild(auStripeProduct);

  const auStripePriceId = 'create-stripe-price-au';
  wrapper.appendChild(_label('AU Stripe Price ID (optional)', auStripePriceId));
  const auStripePrice = _input('text', auStripePriceId, 'price_xxx');
  wrapper.appendChild(auStripePrice);

  const rowPriceId = 'create-price-row';
  wrapper.appendChild(_label('ROW Price (AUD) *', rowPriceId));
  const rowPriceInput = _input('number', rowPriceId, '35.00');
  rowPriceInput.min = '1';
  rowPriceInput.step = '0.01';
  wrapper.appendChild(rowPriceInput);

  const rowProdId = 'create-stripe-product-row';
  wrapper.appendChild(_label('ROW Stripe Product ID (optional)', rowProdId));
  const rowStripeProduct = _input('text', rowProdId, 'prod_xxx');
  wrapper.appendChild(rowStripeProduct);

  const rowStripePriceId = 'create-stripe-price-row';
  wrapper.appendChild(_label('ROW Stripe Price ID (optional)', rowStripePriceId));
  const rowStripePrice = _input('text', rowStripePriceId, 'price_xxx');
  wrapper.appendChild(rowStripePrice);

  wrapper.appendChild(_heading('OPTION GROUPS'));

  const optNote = _el('div', '', 'Add product options such as Size or Colour. Each group requires at least one option value.');
  optNote.style.cssText = 'color:#008844; font-size:0.75em; margin-bottom:10px;';
  wrapper.appendChild(optNote);

  const groupsContainer = _el('div', '');
  groupsContainer.dataset.testid = 'create-option-groups';
  wrapper.appendChild(groupsContainer);

  const addGroupBtn = _menuBtn('+ ADD OPTION GROUP', 'sub');
  wrapper.appendChild(addGroupBtn);

  const groupsState = [];

  function _buildGroupBlock(groupIndex) {
    const block = _el('div', '');
    block.style.cssText = 'border:1px solid #004422; padding:8px; margin-bottom:8px; background:#050505;';
    block.dataset.testid = 'option-group-' + groupIndex;

    const groupHeader = _el('div', '');
    groupHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';

    const groupLabel = _el('span', '', 'Group ' + (groupIndex + 1));
    groupLabel.style.cssText = 'color:#00ff75; font-size:0.8em; font-weight:bold;';
    groupHeader.appendChild(groupLabel);

    const removeGroupBtn = _btn('REMOVE', 'remove-group-' + groupIndex, 'danger');
    removeGroupBtn.style.cssText += 'font-size:0.7em; padding:2px 8px;';
    groupHeader.appendChild(removeGroupBtn);
    block.appendChild(groupHeader);

    const nameId = 'group-name-' + groupIndex;
    block.appendChild(_label('Group Name', nameId));
    const nameInput = _input('text', nameId, 'Group name (e.g. Size, Colour)');
    block.appendChild(nameInput);

    const reqRow = _el('div', '');
    reqRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';
    const reqCheck = document.createElement('input');
    reqCheck.type = 'checkbox';
    reqCheck.checked = true;
    reqCheck.dataset.testid = 'group-required-' + groupIndex;
    const reqLabel = _el('span', '', 'Required');
    reqLabel.style.cssText = 'color:#008844; font-size:0.75em;';
    reqRow.appendChild(reqCheck);
    reqRow.appendChild(reqLabel);
    block.appendChild(reqRow);

    const optionsContainer = _el('div', '');
    optionsContainer.dataset.testid = 'options-container-' + groupIndex;
    block.appendChild(optionsContainer);

    const addOptionBtn = _menuBtn('+ ADD OPTION', 'sub');
    addOptionBtn.style.cssText += 'font-size:0.7em;';
    block.appendChild(addOptionBtn);

    const optionsState = [];

    function _buildOptionRow(optIndex) {
      const row = _el('div', '');
      row.style.cssText = 'display:grid; grid-template-columns:1fr 80px auto; gap:4px; align-items:center; margin-bottom:4px;';
      row.dataset.testid = 'option-row-' + groupIndex + '-' + optIndex;

      const valId = 'option-val-' + groupIndex + '-' + optIndex;
      const valInput = _input('text', valId, 'Value (e.g. M, Red)');
      valInput.style.marginBottom = '0';
      row.appendChild(valInput);

      const upchargeId = 'option-upcharge-' + groupIndex + '-' + optIndex;
      const upchargeInput = _input('number', upchargeId, '+0.00');
      upchargeInput.min = '0';
      upchargeInput.step = '0.01';
      upchargeInput.value = '0';
      upchargeInput.style.marginBottom = '0';
      row.appendChild(upchargeInput);

      const removeBtn = _btn('X', 'remove-option-' + groupIndex + '-' + optIndex, 'danger');
      removeBtn.style.cssText += 'font-size:0.7em; padding:2px 6px; margin-right:0;';

      const optState = { valInput, upchargeInput };
      removeBtn.addEventListener('click', () => {
        const idx = optionsState.indexOf(optState);
        if (idx !== -1) optionsState.splice(idx, 1);
        row.remove();
      });

      row.appendChild(removeBtn);
      optionsState.push(optState);
      optionsContainer.appendChild(row);
    }

    _buildOptionRow(0);

    addOptionBtn.addEventListener('click', () => {
      _buildOptionRow(optionsState.length);
    });

    const groupState = { nameInput, reqCheck, optionsState };

    removeGroupBtn.addEventListener('click', () => {
      const idx = groupsState.indexOf(groupState);
      if (idx !== -1) groupsState.splice(idx, 1);
      block.remove();
    });

    groupsState.push(groupState);
    groupsContainer.appendChild(block);
  }

  addGroupBtn.addEventListener('click', () => {
    _buildGroupBlock(groupsState.length);
  });

  const divider = _el('div', '');
  divider.style.cssText = 'border-top:1px solid #004422; margin:12px 0;';
  wrapper.appendChild(divider);

  const statusMsg = _el('div', '', '');
  statusMsg.style.cssText = 'color:#008844; font-size:0.75em; margin-top:8px; min-height:1.2em;';
  statusMsg.setAttribute('aria-live', 'polite');

  const submitBtn = _menuBtn('CREATE DROP');
  submitBtn.style.marginTop = '12px';

  submitBtn.addEventListener('click', async () => {
    if (signal.aborted) return;
    const title = titleInput.value.trim();
    const description = descArea.value.trim();
    const totalUnits = parseInt(unitsInput.value, 10);
    const status = statusSelect.value;
    const auPrice = _dollarsToCents(auPriceInput.value);
    const rowPrice = _dollarsToCents(rowPriceInput.value);

    if (!title) { toast.warn('Title is required'); return; }
    if (!totalUnits || totalUnits < 1) { toast.warn('Total units must be at least 1'); return; }
    if (!auPrice) { toast.warn('AU price is required and must be greater than zero'); return; }
    if (!rowPrice) { toast.warn('ROW price is required and must be greater than zero'); return; }

    const option_groups = [];
    for (const g of groupsState) {
      const groupName = g.nameInput.value.trim();
      if (!groupName) { toast.warn('All option groups must have a name'); return; }
      const options = [];
      for (const o of g.optionsState) {
        const val = o.valInput.value.trim();
        if (!val) { toast.warn('All options must have a value'); return; }
        const upcharge = _dollarsToCents(o.upchargeInput.value) ?? 0;
        options.push({ value: val, upcharge_cents: upcharge, metadata: {} });
      }
      if (options.length === 0) { toast.warn('Each option group must have at least one option'); return; }
      option_groups.push({ group_name: groupName, is_required: g.reqCheck.checked, options });
    }

    submitBtn.disabled = true;
    statusMsg.textContent = 'Creating drop...';

    try {
      const result = await merchApi.createDrop({
        title, description, totalUnits, status,
        auPrice, rowPrice,
        auStripeProduct: auStripeProduct.value.trim(),
        auStripePrice:   auStripePrice.value.trim(),
        rowStripeProduct: rowStripeProduct.value.trim(),
        rowStripePrice:   rowStripePrice.value.trim(),
        optionGroups: option_groups,
      }, signal);

      if (!result || signal.aborted) {
        submitBtn.disabled = false;
        statusMsg.textContent = signal.aborted ? 'Cancelled.' : '';
        return;
      }

      toast.success('Drop ' + result.id + ' created successfully');
      if (onSuccess) onSuccess();
    } catch (err) {
      _logError(MODULE_NAME, 'Create drop failed', err);
      toast.error('Create failed: ' + String(err.message).replace(/</g, '&lt;'));
      statusMsg.textContent = 'Error: ' + err.message;
      submitBtn.disabled = false;
    }
  });

  wrapper.appendChild(submitBtn);
  wrapper.appendChild(statusMsg);

  return wrapper;
}

/* ============================================================================
 * DROP LIST VIEW
 * ============================================================================ */

async function _renderDropList(container, signal, activeFilter) {
  const wrapper = _el('div', 'merch-drops-view');
  wrapper.dataset.testid = 'merch-drops-view';
  wrapper.style.cssText = 'padding:4px;';

  wrapper.appendChild(_heading('MERCH DROPS'));

  const toolbar = _el('div', '');
  toolbar.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; align-items:center;';

  const createBtn = _menuBtn('+ CREATE DROP');
  createBtn.style.marginRight = '12px';
  toolbar.appendChild(createBtn);

  const filterLabel = _el('span', '', 'Filter:');
  filterLabel.style.cssText = 'color:#008844; font-size:0.75em;';
  toolbar.appendChild(filterLabel);

  const filters = ['all', ...ALL_STATUSES];
  for (const f of filters) {
    const fb = _menuBtn(f.replace('_', ' ').toUpperCase(), 'sub');
    if (f === (activeFilter !== null && activeFilter !== undefined ? activeFilter : 'all')) {
      fb.classList.add('menu-button--active');
    }
    fb.addEventListener('click', () => {
      if (signal.aborted) return;
      _renderDropList(container, signal, f === 'all' ? null : f);
    });
    toolbar.appendChild(fb);
  }

  wrapper.appendChild(toolbar);

  const listArea = _el('div', '');
  listArea.dataset.testid = 'merch-drops-list';
  wrapper.appendChild(listArea);

  container.replaceChildren(wrapper);

  createBtn.addEventListener('click', () => {
    if (signal.aborted) return;
    const formContent = _buildCreateForm(signal, () => {
      if (!signal.aborted) _renderDropList(container, signal, activeFilter);
    });
    const backBtn = _menuBtn('\u2190 BACK TO DROPS', 'nav');
    backBtn.style.marginBottom = '12px';
    backBtn.addEventListener('click', () => {
      if (!signal.aborted) _renderDropList(container, signal, activeFilter);
    });
    formContent.prepend(backBtn);
    container.replaceChildren(formContent);
  });

  try {
    const data = await merchApi.getDrops(activeFilter, signal);
    if (signal.aborted) return;

    if (!data || !Array.isArray(data.drops)) {
      const errMsg = _el('div', '', 'Failed to load drops');
      errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
      listArea.appendChild(errMsg);
      return;
    }

    if (data.drops.length === 0) {
      const empty = _el('div', '', activeFilter
        ? 'No ' + activeFilter.replace('_', ' ') + ' drops found.'
        : 'No drops yet. Create your first drop above.');
      empty.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:16px 0; text-align:center;';
      listArea.appendChild(empty);
      return;
    }

    const countLabel = _el('div', '', data.drops.length + ' drop' + (data.drops.length !== 1 ? 's' : ''));
    countLabel.style.cssText = 'color:#008844; font-family:monospace; font-size:0.7em; margin-bottom:6px;';
    listArea.appendChild(countLabel);

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-family:monospace; font-size:0.78em;';
    table.dataset.testid = 'drops-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.cssText = 'border-bottom:1px solid #004422;';
    for (const h of ['ID', 'Title', 'Status', 'Units', 'Remaining', 'Created']) {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left; color:#008844; padding:4px 8px; font-weight:normal;';
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const fragment = document.createDocumentFragment();

    for (const drop of data.drops) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid #001a0a; cursor:pointer;';
      tr.dataset.testid = 'drop-row-' + drop.id;
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', 'View drop ' + drop.id + ' ' + drop.title);
      tr.addEventListener('mouseenter', () => { tr.style.background = '#0a0a0a'; });
      tr.addEventListener('mouseleave', () => { tr.style.background = ''; });

      const idCell = document.createElement('td');
      idCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
      idCell.appendChild(_createIdSwatch(drop.id));
      idCell.appendChild(document.createTextNode(drop.id));
      tr.appendChild(idCell);

      const titleCell = document.createElement('td');
      titleCell.style.cssText = 'padding:5px 8px; color:#00ff75; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      titleCell.textContent = drop.title;
      tr.appendChild(titleCell);

      const statusCell = document.createElement('td');
      statusCell.style.cssText = 'padding:5px 8px;';
      statusCell.appendChild(_statusBadge(drop.status));
      tr.appendChild(statusCell);

      const unitsCell = document.createElement('td');
      unitsCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
      unitsCell.textContent = drop.total_units;
      tr.appendChild(unitsCell);

      const remainCell = document.createElement('td');
      remainCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
      remainCell.textContent = drop.units_remaining;
      tr.appendChild(remainCell);

      const createdCell = document.createElement('td');
      createdCell.style.cssText = 'padding:5px 8px; color:#008844;';
      createdCell.textContent = drop.created_at
        ? new Date(drop.created_at).toLocaleDateString()
        : '';
      tr.appendChild(createdCell);

      const openDetail = () => {
        if (signal.aborted) return;
        const loadingMsg = _el('div', '', 'Loading...');
        loadingMsg.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em;';
        container.replaceChildren(loadingMsg);
        const onBack = () => {
          if (!signal.aborted) _renderDropList(container, signal, activeFilter);
        };
        _buildDropDetail(drop, signal, () => {
          if (!signal.aborted) _renderDropList(container, signal, activeFilter);
        }, container, onBack).then(content => {
          if (!signal.aborted) {
            const backBtn = _menuBtn('\u2190 BACK TO DROPS', 'nav');
            backBtn.style.marginBottom = '12px';
            backBtn.addEventListener('click', onBack);
            content.prepend(backBtn);
            container.replaceChildren(content);
          }
        }).catch(err => {
          _logError(MODULE_NAME, 'Detail build failed', err);
        });
      };

      tr.addEventListener('click', openDetail);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail();
        }
      });

      fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
    table.appendChild(tbody);
    listArea.appendChild(table);

  } catch (err) {
    if (err.name === 'AbortError') return;
    _logError(MODULE_NAME, 'Failed to load drop list', err);
    const errMsg = _el('div', '', 'Error loading drops: ' + err.message);
    errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
    listArea.appendChild(errMsg);
  }
}

/* ============================================================================
 * PLACEHOLDER BUILDER
 * ============================================================================ */

function _buildPlaceholder(title, message) {
  const wrapper = _el('div', '');
  wrapper.style.cssText = 'padding:4px;';
  wrapper.appendChild(_heading(title));
  const msg = _el('div', '', message);
  msg.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:16px 0;';
  wrapper.appendChild(msg);
  return wrapper;
}

/* ============================================================================
 * VIEW REGISTRATION
 * ============================================================================ */

viewController.register('merch-drops', async (ctx) => {
  const { container, signal } = ctx;
  await _renderDropList(container, signal, null);
});

viewController.register('merch-orders', async (ctx) => {
  const { container, signal } = ctx;

  const wrapper = _el('div', 'merch-orders-view');
  wrapper.dataset.testid = 'merch-orders-view';
  wrapper.style.cssText = 'padding:4px;';

  wrapper.appendChild(_heading('MERCH ORDERS'));

  const toolbar = _el('div', '');
  toolbar.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; align-items:center;';

  const filterLabel = _el('span', '', 'Filter:');
  filterLabel.style.cssText = 'color:#008844; font-size:0.75em;';
  toolbar.appendChild(filterLabel);

  const orderStatuses = ['all', 'pending', 'paid', 'fulfilled', 'cancelled', 'expired', 'refunded'];
  let activeFilter = null;

  const listArea = _el('div', '');
  listArea.dataset.testid = 'merch-orders-list';

  async function renderOrders(statusFilter) {
    activeFilter = statusFilter;

    for (const fb of toolbar.querySelectorAll('button')) {
      const isActive = (statusFilter === null && fb.dataset.filter === 'all') ||
                       fb.dataset.filter === statusFilter;
      fb.classList.toggle('menu-button--active', isActive);
    }

    listArea.innerHTML = '';
    const loading = _el('div', '', 'Loading...');
    loading.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em;';
    listArea.appendChild(loading);

    try {
      const data = await merchApi.getOrders(statusFilter, signal);
      if (signal.aborted) return;
      listArea.innerHTML = '';

      if (!data || !Array.isArray(data.orders)) {
        const errMsg = _el('div', '', 'Failed to load orders');
        errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
        listArea.appendChild(errMsg);
        return;
      }

      if (data.orders.length === 0) {
        const empty = _el('div', '', statusFilter
          ? 'No ' + statusFilter + ' orders found.'
          : 'No orders yet.');
        empty.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:16px 0; text-align:center;';
        listArea.appendChild(empty);
        return;
      }

      const countLabel = _el('div', '', data.orders.length + ' order' + (data.orders.length !== 1 ? 's' : ''));
      countLabel.style.cssText = 'color:#008844; font-family:monospace; font-size:0.7em; margin-bottom:6px;';
      listArea.appendChild(countLabel);

      const table = document.createElement('table');
      table.style.cssText = 'width:100%; border-collapse:collapse; font-family:monospace; font-size:0.78em;';
      table.dataset.testid = 'orders-table';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      headerRow.style.cssText = 'border-bottom:1px solid #004422;';
      for (const h of ['ID', 'User', 'Drop', 'Status', 'Total Paid', 'Paid At', 'Created']) {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = 'text-align:left; color:#008844; padding:4px 8px; font-weight:normal;';
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      const fragment = document.createDocumentFragment();

      for (const order of data.orders) {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid #001a0a;';
        tr.dataset.testid = 'order-row-' + order.id;

        const idCell = document.createElement('td');
        idCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
        idCell.appendChild(_createIdSwatch(order.id));
        idCell.appendChild(document.createTextNode(order.id));
        tr.appendChild(idCell);

        const userCell = document.createElement('td');
        userCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
        userCell.textContent = order.username || order.user_id || '—';
        tr.appendChild(userCell);

        const dropCell = document.createElement('td');
        dropCell.style.cssText = 'padding:5px 8px; color:#00ff75; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        dropCell.textContent = order.drop_title || order.drop_id || '—';
        tr.appendChild(dropCell);

        const statusCell = document.createElement('td');
        statusCell.style.cssText = 'padding:5px 8px;';
        statusCell.appendChild(_statusBadge(order.status));
        tr.appendChild(statusCell);

        const totalCell = document.createElement('td');
        totalCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
        totalCell.textContent = _centsToDisplay(order.total_paid_cents);
        tr.appendChild(totalCell);

        const paidAtCell = document.createElement('td');
        paidAtCell.style.cssText = 'padding:5px 8px; color:#008844;';
        paidAtCell.textContent = order.paid_at
          ? new Date(order.paid_at).toLocaleDateString()
          : '—';
        tr.appendChild(paidAtCell);

        const createdCell = document.createElement('td');
        createdCell.style.cssText = 'padding:5px 8px; color:#008844;';
        createdCell.textContent = order.created_at
          ? new Date(order.created_at).toLocaleDateString()
          : '—';
        tr.appendChild(createdCell);

        fragment.appendChild(tr);
      }

      tbody.appendChild(fragment);
      table.appendChild(tbody);
      listArea.appendChild(table);

    } catch (err) {
      if (signal.aborted) return;
      listArea.innerHTML = '';
      const errMsg = _el('div', '', 'Error loading orders: ' + err.message);
      errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
      listArea.appendChild(errMsg);
      _logError(MODULE_NAME, 'Orders load failed', err);
    }
  }

  for (const f of orderStatuses) {
    const fb = _menuBtn(f.toUpperCase(), 'sub');
    fb.dataset.filter = f;
    fb.style.cssText += 'font-size:0.7em; padding:2px 8px;';
    fb.addEventListener('click', () => {
      if (signal.aborted) return;
      renderOrders(f === 'all' ? null : f);
    });
    toolbar.appendChild(fb);
  }

  wrapper.appendChild(toolbar);
  wrapper.appendChild(listArea);
  container.replaceChildren(wrapper);

  await renderOrders(null);
});

viewController.register('merch-audit', async (ctx) => {
  const { container, signal } = ctx;

  const wrapper = _el('div', 'merch-audit-view');
  wrapper.dataset.testid = 'merch-audit-view';
  wrapper.style.cssText = 'padding:4px;';

  wrapper.appendChild(_heading('MERCH AUDIT LOG'));

  const listArea = _el('div', '');
  listArea.dataset.testid = 'merch-audit-list';

  wrapper.appendChild(listArea);
  container.replaceChildren(wrapper);

  try {
    const data = await merchApi.getAudit(null, signal);
    if (signal.aborted) return;
    listArea.innerHTML = '';

    if (!data || !Array.isArray(data.entries)) {
      const errMsg = _el('div', '', 'Failed to load audit log');
      errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
      listArea.appendChild(errMsg);
      return;
    }

    if (data.entries.length === 0) {
      const empty = _el('div', '', 'No audit entries yet.');
      empty.style.cssText = 'color:#008844; font-family:monospace; font-size:0.8em; padding:16px 0; text-align:center;';
      listArea.appendChild(empty);
      return;
    }

    const countLabel = _el('div', '', data.entries.length + ' entr' + (data.entries.length !== 1 ? 'ies' : 'y'));
    countLabel.style.cssText = 'color:#008844; font-family:monospace; font-size:0.7em; margin-bottom:6px;';
    listArea.appendChild(countLabel);

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-family:monospace; font-size:0.78em;';
    table.dataset.testid = 'audit-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.cssText = 'border-bottom:1px solid #004422;';
    for (const h of ['Timestamp', 'Admin', 'Action', 'Drop', 'IP', 'Details']) {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left; color:#008844; padding:4px 8px; font-weight:normal;';
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const fragment = document.createDocumentFragment();

    for (const entry of data.entries) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid #001a0a;';
      tr.dataset.testid = 'audit-row-' + entry.id;

      const tsCell = document.createElement('td');
      tsCell.style.cssText = 'padding:5px 8px; color:#008844; white-space:nowrap;';
      tsCell.textContent = entry.created_at
        ? new Date(entry.created_at).toLocaleString()
        : '—';
      tr.appendChild(tsCell);

      const adminCell = document.createElement('td');
      adminCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
      adminCell.textContent = entry.admin_username || entry.admin_user_id || '—';
      tr.appendChild(adminCell);

      const actionCell = document.createElement('td');
      actionCell.style.cssText = 'padding:5px 8px; color:#00ff75;';
      actionCell.textContent = entry.action;
      tr.appendChild(actionCell);

      const dropCell = document.createElement('td');
      dropCell.style.cssText = 'padding:5px 8px; color:#00ff75; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      dropCell.textContent = entry.drop_title || entry.drop_id || '—';
      tr.appendChild(dropCell);

      const ipCell = document.createElement('td');
      ipCell.style.cssText = 'padding:5px 8px; color:#008844;';
      ipCell.textContent = entry.ip_address || '—';
      tr.appendChild(ipCell);

      const detailsCell = document.createElement('td');
      detailsCell.style.cssText = 'padding:5px 8px; color:#008844;';
      if (entry.details) {
        const toggle = _btn('SHOW', 'audit-details-' + entry.id, 'secondary');
        toggle.style.cssText += 'font-size:0.65em; padding:1px 6px;';
        const pre = document.createElement('pre');
        pre.style.cssText = 'display:none; margin:4px 0 0 0; color:#008844; font-size:0.85em; white-space:pre-wrap; word-break:break-all;';
        pre.textContent = JSON.stringify(entry.details, null, 2);
        toggle.addEventListener('click', () => {
          const isHidden = pre.style.display === 'none';
          pre.style.display = isHidden ? 'block' : 'none';
          toggle.textContent = isHidden ? 'HIDE' : 'SHOW';
        });
        detailsCell.appendChild(toggle);
        detailsCell.appendChild(pre);
      } else {
        detailsCell.textContent = '—';
      }
      tr.appendChild(detailsCell);

      fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
    table.appendChild(tbody);
    listArea.appendChild(table);

  } catch (err) {
    if (signal.aborted) return;
    listArea.innerHTML = '';
    const errMsg = _el('div', '', 'Error loading audit log: ' + err.message);
    errMsg.style.cssText = 'color:#ff4444; font-family:monospace; font-size:0.8em;';
    listArea.appendChild(errMsg);
    _logError(MODULE_NAME, 'Audit log load failed', err);
  }
});


_logInfo(MODULE_NAME, 'Module loaded, 3 handlers registered');
