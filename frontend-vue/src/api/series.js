import { request } from './http';
import { encodeTitleName } from '../utils/format';

export function getSeriesList(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    searchParams.set(key, String(value));
  });

  return request(`/api/series?${searchParams.toString()}`);
}

export function getSeriesDetail(titleName) {
  return request(`/api/series/${encodeTitleName(titleName)}`);
}
