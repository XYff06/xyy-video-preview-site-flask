import { defineStore } from 'pinia';

import { healthApi } from '../api';

let flashTimer = null;

export const useUiStore = defineStore('ui', {
  state: () => ({
    appLoading: true,
    appError: '',
    flashMessage: '',
    flashType: 'info',
    flashVersion: 0
  }),
  actions: {
    async bootstrap() {
      this.appLoading = true;
      this.appError = '';

      try {
        await healthApi.getHealth();
      } catch (error) {
        this.appError = error.message;
      } finally {
        this.appLoading = false;
      }
    },
    showFlash(message, type = 'info', duration = 5000) {
      this.flashMessage = String(message || '').trim();
      this.flashType = type;
      this.flashVersion += 1;

      if (flashTimer) {
        clearTimeout(flashTimer);
        flashTimer = null;
      }

      if (this.flashMessage && duration > 0) {
        flashTimer = setTimeout(() => {
          this.clearFlash();
        }, duration);
      }
    },
    clearFlash() {
      this.flashMessage = '';
      this.flashType = 'info';
      if (flashTimer) {
        clearTimeout(flashTimer);
        flashTimer = null;
      }
    }
  }
});
