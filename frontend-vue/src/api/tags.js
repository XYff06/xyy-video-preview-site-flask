import { request } from './http';
import { encodeTitleName } from '../utils/format';

export function getTags() {
  return request('/api/tags');
}

export function createTag(payload) {
  return request('/api/tags', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function updateTag(oldName, payload) {
  return request(`/api/tags/${encodeTitleName(oldName)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export function deleteTag(oldName) {
  return request(`/api/tags/${encodeTitleName(oldName)}`, {
    method: 'DELETE'
  });
}
