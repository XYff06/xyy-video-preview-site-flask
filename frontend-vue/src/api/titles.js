import { request } from './http';
import { encodeTitleName } from '../utils/format';

export function getTitles(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    searchParams.set(key, String(value));
  });

  return request(`/api/titles?${searchParams.toString()}`);
}

export function createTitle(payload) {
  return request('/api/titles', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function updateTitle(oldName, payload) {
  return request(`/api/titles/${encodeTitleName(oldName)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export function deleteTitle(oldName) {
  return request(`/api/titles/${encodeTitleName(oldName)}`, {
    method: 'DELETE'
  });
}
