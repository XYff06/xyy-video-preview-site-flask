import { defineStore } from 'pinia';

import { seriesApi } from '../api';
import { normalizeSeriesSummaryRecord } from '../utils/normalize';

export const useHomeStore = defineStore('home', {
  state: () => ({
    selectedTag: null,
    searchQuery: '',
    sortBy: 'updated_desc',
    currentPage: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
    items: [],
    loading: false,
    error: '',
    tagExpanded: false
  }),
  actions: {
    async fetchList() {
      this.loading = true;
      this.error = '';

      try {
        const payload = await seriesApi.getSeriesList({
          page: this.currentPage,
          pageSize: this.pageSize,
          tag: this.selectedTag,
          search: this.searchQuery.trim(),
          sort: this.sortBy
        });

        this.items = Array.isArray(payload.data)
          ? payload.data.map(normalizeSeriesSummaryRecord)
          : [];
        this.total = Number(payload.pagination?.total || this.items.length);
        this.currentPage = Number(payload.pagination?.page || this.currentPage);
        this.totalPages = Number(payload.pagination?.totalPages || 1);
        return this.items;
      } catch (error) {
        this.items = [];
        this.total = 0;
        this.totalPages = 1;
        this.error = error.message;
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async setTag(tagName) {
      this.selectedTag = tagName || null;
      this.currentPage = 1;
      await this.fetchList();
    },
    async submitSearch({ searchQuery, sortBy }) {
      this.searchQuery = String(searchQuery || '').trim();
      this.sortBy = sortBy || this.sortBy;
      this.currentPage = 1;
      await this.fetchList();
    },
    async setSort(sortBy) {
      this.sortBy = sortBy || 'updated_desc';
      this.currentPage = 1;
      await this.fetchList();
    },
    async setPage(page) {
      this.currentPage = Number(page) || 1;
      await this.fetchList();
    },
    toggleTagExpanded() {
      this.tagExpanded = !this.tagExpanded;
    },
    ensureSelectedTagExists(allTags = []) {
      if (this.selectedTag && !allTags.includes(this.selectedTag)) {
        this.selectedTag = null;
      }
    }
  }
});
