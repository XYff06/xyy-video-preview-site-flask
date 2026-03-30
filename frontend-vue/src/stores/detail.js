import { defineStore } from 'pinia';

import { seriesApi } from '../api';
import { clamp } from '../utils/format';
import { normalizeEpisodeRecords } from '../utils/normalize';

function normalizeDetailPayload(titleName, payload = {}) {
  return {
    name: String(titleName || '').trim(),
    episodes: normalizeEpisodeRecords(payload.episodes || [])
  };
}

export const useDetailStore = defineStore('detail', {
  state: () => ({
    titleName: '',
    currentSeries: null,
    selectedEpisodeNo: null,
    episodePage: 1,
    episodePageSize: 10,
    loading: false,
    error: ''
  }),
  getters: {
    episodes(state) {
      return state.currentSeries?.episodes || [];
    },
    totalEpisodePages(state) {
      const totalEpisodes = state.currentSeries?.episodes?.length || 0;
      return Math.max(1, Math.ceil(totalEpisodes / state.episodePageSize));
    },
    selectedEpisode(state) {
      const episodes = state.currentSeries?.episodes || [];
      if (!episodes.length) return null;
      return episodes.find((item) => item.episodeNo === state.selectedEpisodeNo) || episodes[0];
    },
    visibleEpisodes(state) {
      const episodes = state.currentSeries?.episodes || [];
      const pageStart = (state.episodePage - 1) * state.episodePageSize;
      return episodes.slice(pageStart, pageStart + state.episodePageSize);
    }
  },
  actions: {
    ensureSelectedEpisode() {
      const episodes = this.currentSeries?.episodes || [];
      if (!episodes.length) {
        this.selectedEpisodeNo = null;
        this.episodePage = 1;
        return;
      }

      const selectedEpisode = episodes.find((episode) => episode.episodeNo === this.selectedEpisodeNo);
      const fallbackEpisode = selectedEpisode || episodes[0];
      this.selectedEpisodeNo = fallbackEpisode.episodeNo;

      const selectedIndex = episodes.findIndex((episode) => episode.episodeNo === this.selectedEpisodeNo);
      this.episodePage = clamp(
        Math.floor(selectedIndex / this.episodePageSize) + 1,
        1,
        Math.max(1, Math.ceil(episodes.length / this.episodePageSize))
      );
    },
    async loadDetail(titleName, options = {}) {
      const normalizedTitleName = String(titleName || '').trim();
      const force = Boolean(options.force);

      if (!normalizedTitleName) {
        this.currentSeries = null;
        this.titleName = '';
        this.selectedEpisodeNo = null;
        this.episodePage = 1;
        return null;
      }

      if (!force && this.currentSeries && this.titleName === normalizedTitleName) {
        this.ensureSelectedEpisode();
        return this.currentSeries;
      }

      this.loading = true;
      this.error = '';

      try {
        const payload = await seriesApi.getSeriesDetail(normalizedTitleName);
        const previousTitleName = this.titleName;
        this.currentSeries = normalizeDetailPayload(normalizedTitleName, payload.data || {});
        this.titleName = normalizedTitleName;

        if (previousTitleName !== normalizedTitleName) {
          this.selectedEpisodeNo = this.currentSeries.episodes[0]?.episodeNo ?? null;
          this.episodePage = 1;
        }

        this.ensureSelectedEpisode();
        return this.currentSeries;
      } catch (error) {
        this.currentSeries = null;
        this.error = error.message;
        throw error;
      } finally {
        this.loading = false;
      }
    },
    setSelectedEpisode(episodeNo) {
      this.selectedEpisodeNo = Number(episodeNo);
      this.ensureSelectedEpisode();
    },
    setEpisodePage(page) {
      this.episodePage = clamp(Number(page) || 1, 1, this.totalEpisodePages);
    },
    reset() {
      this.titleName = '';
      this.currentSeries = null;
      this.selectedEpisodeNo = null;
      this.episodePage = 1;
      this.loading = false;
      this.error = '';
    }
  }
});
