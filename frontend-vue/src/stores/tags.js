import { defineStore } from 'pinia';

import { tagsApi } from '../api';

export const useTagsStore = defineStore('tags', {
  state: () => ({
    allTags: [],
    loading: false,
    error: '',
    initialized: false
  }),
  actions: {
    async fetchTags(force = false) {
      if (this.loading) return this.allTags;
      if (this.initialized && !force) return this.allTags;

      this.loading = true;
      this.error = '';

      try {
        const payload = await tagsApi.getTags();
        this.allTags = Array.isArray(payload.data) ? payload.data : [];
        this.initialized = true;
        return this.allTags;
      } catch (error) {
        this.error = error.message;
        throw error;
      } finally {
        this.loading = false;
      }
    }
  }
});
