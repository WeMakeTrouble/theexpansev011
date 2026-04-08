/**
 * ============================================================================
 * Merch API Layer — Thin wrapper around apiClient for merch endpoints
 * File: public/cms/js/modules/merchApi.js
 * ============================================================================
 */

import apiClient from '../apiClient.js';
import { API_PATHS, VALID_TRANSITIONS, ALL_STATUSES } from './merchUtils.js';

function _buildDropPayload(data) {
  if (typeof data.auPrice !== 'number' || data.auPrice <= 0 || !Number.isInteger(data.auPrice)) {
    throw new Error('auPrice must be a positive integer (cents)');
  }
  if (typeof data.rowPrice !== 'number' || data.rowPrice <= 0 || !Number.isInteger(data.rowPrice)) {
    throw new Error('rowPrice must be a positive integer (cents)');
  }

  const pricing = [
    {
      region_code: 'AU',
      price_cents: data.auPrice,
      stripe_product_id: data.auStripeProduct || 'pending',
      stripe_price_id: data.auStripePrice || 'pending',
    },
    {
      region_code: 'ROW',
      price_cents: data.rowPrice,
      stripe_product_id: data.rowStripeProduct || 'pending',
      stripe_price_id: data.rowStripePrice || 'pending',
    },
  ];

  const payload = {
    title: data.title,
    total_units: data.totalUnits,
    status: data.status,
    pricing,
  };

  if (data.description) payload.description = data.description;
  if (data.optionGroups && data.optionGroups.length > 0) payload.option_groups = data.optionGroups;

  return payload;
}

function _requireDropId(dropId, method) {
  if (!dropId) throw new Error(method + ': dropId is required');
}

function _requireMediaId(mediaId, method) {
  if (!mediaId) throw new Error(method + ': mediaId is required');
}

export const merchApi = {

  getDrops(statusFilter, signal) {
    const endpoint = statusFilter
      ? API_PATHS.DROPS + '?status=' + encodeURIComponent(statusFilter)
      : API_PATHS.DROPS;
    return apiClient.get(endpoint, { signal });
  },

  createDrop(data, signal) {
    const payload = _buildDropPayload(data);
    return apiClient.post(API_PATHS.DROPS, payload, { signal });
  },

  updateDrop(dropId, fields, signal) {
    _requireDropId(dropId, 'updateDrop');
    return apiClient.patch(
      API_PATHS.DROPS + '/' + encodeURIComponent(dropId),
      { title: fields.title, description: fields.description },
      { signal }
    );
  },

  changeStatus(dropId, newStatus, signal) {
    _requireDropId(dropId, 'changeStatus');
    if (!ALL_STATUSES.includes(newStatus)) {
      throw new Error('changeStatus: invalid status "' + newStatus + '"');
    }
    return apiClient.patch(
      API_PATHS.DROPS + '/' + encodeURIComponent(dropId) + '/status',
      { status: newStatus },
      { signal }
    );
  },

  getMedia(dropId, signal) {
    _requireDropId(dropId, 'getMedia');
    return apiClient.get(
      API_PATHS.DROPS + '/' + encodeURIComponent(dropId) + '/media',
      { signal }
    );
  },

  uploadImage(dropId, file, signal) {
    _requireDropId(dropId, 'uploadImage');
    if (!file) throw new Error('uploadImage: file is required');
    return apiClient.upload(
      API_PATHS.DROPS + '/' + encodeURIComponent(dropId) + '/media/image',
      file,
      {},
      { signal }
    );
  },

  deleteMedia(dropId, mediaId, signal) {
    _requireDropId(dropId, 'deleteMedia');
    _requireMediaId(mediaId, 'deleteMedia');
    return apiClient.delete(
      API_PATHS.DROPS + '/' + encodeURIComponent(dropId) + '/media/' + encodeURIComponent(mediaId),
      { signal }
    );
  },

  setPrimaryImage(dropId, mediaId, signal) {
    _requireDropId(dropId, 'setPrimaryImage');
    _requireMediaId(mediaId, 'setPrimaryImage');
    return apiClient.patch(
      API_PATHS.DROPS + '/' + encodeURIComponent(dropId) + '/media/' + encodeURIComponent(mediaId) + '/primary',
      {},
      { signal }
    );
  },


  getOrders(statusFilter, signal) {
    const endpoint = statusFilter
      ? API_PATHS.ORDERS + '?status=' + encodeURIComponent(statusFilter)
      : API_PATHS.ORDERS;
    return apiClient.get(endpoint, { signal });
  },

  getAudit(dropId, signal) {
    const endpoint = dropId
      ? API_PATHS.AUDIT + '?drop_id=' + encodeURIComponent(dropId)
      : API_PATHS.AUDIT;
    return apiClient.get(endpoint, { signal });
  },

  addVideo(dropId, videoData, signal) {
    _requireDropId(dropId, 'addVideo');
    if (!videoData || !videoData.externalUrl || !videoData.externalPlatform) {
      throw new Error('addVideo: externalUrl and externalPlatform are required');
    }
    return apiClient.post(
      API_PATHS.DROPS + '/' + encodeURIComponent(dropId) + '/media/video',
      { external_url: videoData.externalUrl, external_platform: videoData.externalPlatform },
      { signal }
    );
  },
};
