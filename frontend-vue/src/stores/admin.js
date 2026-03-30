import { defineStore } from 'pinia';

export const useAdminStore = defineStore('admin', {
  state: () => ({
    isOpen: false,
    activeSection: 'tag',
    activeTagAction: 'create',
    activeTitleAction: 'create',
    activeEpisodeAction: 'create'
  }),
  actions: {
    open(section) {
      if (section) {
        this.activeSection = section;
      }
      this.isOpen = true;
    },
    close() {
      this.isOpen = false;
    },
    setSection(section) {
      this.activeSection = section;
    },
    setTagAction(action) {
      this.activeTagAction = action;
    },
    setTitleAction(action) {
      this.activeTitleAction = action;
    },
    setEpisodeAction(action) {
      this.activeEpisodeAction = action;
    }
  }
});
