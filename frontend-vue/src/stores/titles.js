import { defineStore } from 'pinia';

import { titlesApi } from '../api';
import { normalizeTitleOptionRecord } from '../utils/normalize';

export const useTitlesStore = defineStore('titles', {
  state: () => ({
    optionsByName: {},
    latestOptions: [],
    pagination: {
      page: 1,
      pageSize: 5,
      total: 0,
      totalPages: 1
    },
    loading: false,
    error: ''
  }),
  getters: {
    optionMap(state) {
      return state.optionsByName;
    }
  },
  actions: {
    cacheTitleRecord(record) {
      const normalized = normalizeTitleOptionRecord(record);
      if (!normalized.name) return null;

      const previous = this.optionsByName[normalized.name] || {};
      const nextRecord = {
        ...previous,
        ...normalized,
        tags: normalized.tags.length ? normalized.tags : previous.tags || []
      };

      this.optionsByName = {
        ...this.optionsByName,
        [normalized.name]: nextRecord
      };

      return nextRecord;
    },
    async fetchTitlesPage({ search = '', page = 1, pageSize = 5 } = {}) {
      this.loading = true;
      this.error = '';

      try {
        const payload = await titlesApi.getTitles({
          search: String(search || '').trim(),
          page,
          pageSize
        });

        const options = Array.isArray(payload.data)
          ? payload.data.map((item) => this.cacheTitleRecord(item)).filter(Boolean)
          : [];

        this.latestOptions = options;
        this.pagination = {
          page: Number(payload.pagination?.page || page),
          pageSize: Number(payload.pagination?.pageSize || pageSize),
          total: Number(payload.pagination?.total || options.length),
          totalPages: Number(payload.pagination?.totalPages || 1)
        };

        return {
          options,
          pagination: this.pagination
        };
      } catch (error) {
        this.error = error.message;
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async ensureTitleLoaded(titleName) {
      const normalizedName = String(titleName || '').trim();
      if (!normalizedName) return null;
      if (this.optionsByName[normalizedName]) {
        return this.optionsByName[normalizedName];
      }

      const payload = await this.fetchTitlesPage({
        search: normalizedName,
        page: 1,
        pageSize: 10
      });

      return payload.options.find((item) => item.name === normalizedName) || null;
    },
    removeTitleFromCache(titleName) {
      const nextMap = { ...this.optionsByName };
      delete nextMap[titleName];
      this.optionsByName = nextMap;
    }
  }
});
