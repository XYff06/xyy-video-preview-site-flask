import { request } from './http';

export function createEpisode(payload) {
  return request('/api/episodes', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function updateEpisode(payload) {
  return request('/api/episodes', {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export function deleteEpisode(payload) {
  return request('/api/episodes', {
    method: 'DELETE',
    body: JSON.stringify(payload)
  });
}

export function batchImportEpisodes(payload) {
  return request('/api/episodes/batch-directory', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}
