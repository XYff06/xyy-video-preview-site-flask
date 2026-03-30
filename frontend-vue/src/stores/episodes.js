import { defineStore } from 'pinia';

import { episodesApi, seriesApi } from '../api';
import { normalizeBatchDraft, normalizeEpisodeRecords } from '../utils/normalize';

function createEmptyBatchDraft() {
  return normalizeBatchDraft({});
}

export const useEpisodesStore = defineStore('episodes', {
  state: () => ({
    optionsByTitleName: {},
    batchDraft: createEmptyBatchDraft(),
    batchPendingConfirmation: null,
    batchSubmitting: false,
    loading: false,
    error: ''
  }),
  actions: {
    setBatchDraft(nextDraft) {
      this.batchDraft = normalizeBatchDraft(nextDraft);
    },
    patchBatchDraft(partialDraft) {
      this.batchDraft = normalizeBatchDraft({
        ...this.batchDraft,
        ...partialDraft
      });
    },
    clearBatchConfirmation() {
      this.batchPendingConfirmation = null;
    },
    resetBatchDraft() {
      this.batchDraft = createEmptyBatchDraft();
      this.batchPendingConfirmation = null;
    },
    cacheEpisodeOptions(titleName, episodes = []) {
      const normalizedTitleName = String(titleName || '').trim();
      if (!normalizedTitleName) return [];

      this.optionsByTitleName = {
        ...this.optionsByTitleName,
        [normalizedTitleName]: normalizeEpisodeRecords(episodes)
      };

      return this.optionsByTitleName[normalizedTitleName];
    },
    async fetchEpisodeOptions(titleName, force = false) {
      const normalizedTitleName = String(titleName || '').trim();
      if (!normalizedTitleName) return [];
      if (!force && this.optionsByTitleName[normalizedTitleName]) {
        return this.optionsByTitleName[normalizedTitleName];
      }

      const payload = await seriesApi.getSeriesDetail(normalizedTitleName);
      return this.cacheEpisodeOptions(normalizedTitleName, payload.data?.episodes || []);
    },
    async submitBatchImport(continueImportForExistingTitle = false) {
      this.batchSubmitting = true;
      this.error = '';

      try {
        const payload = {
          titleName: this.batchDraft.titleName,
          titlePoster: this.batchDraft.titlePoster,
          directory: this.batchDraft.directory,
          titleTags: this.batchDraft.titleTags,
          continueImportForExistingTitle
        };

        const result = await episodesApi.batchImportEpisodes(payload);

        if (result.requiresConfirmation) {
          this.batchPendingConfirmation = {
            payload: normalizeBatchDraft(this.batchDraft),
            data: result.data || {},
            message: result.message || ''
          };
          return result;
        }

        this.batchPendingConfirmation = null;
        this.batchDraft = createEmptyBatchDraft();
        return result;
      } catch (error) {
        this.error = error.message;
        throw error;
      } finally {
        this.batchSubmitting = false;
      }
    }
  }
});
