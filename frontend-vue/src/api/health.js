import { request } from './http';

export function getHealth() {
  return request('/api/health');
}
