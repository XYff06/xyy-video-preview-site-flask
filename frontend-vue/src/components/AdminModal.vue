<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useAdminStore } from '../stores/admin';
import EpisodeAdminPanel from './admin/EpisodeAdminPanel.vue';
import TagAdminPanel from './admin/TagAdminPanel.vue';
import TitleAdminPanel from './admin/TitleAdminPanel.vue';

const adminStore = useAdminStore();
const { isOpen, activeSection } = storeToRefs(adminStore);

const activeComponent = computed(() => {
  if (activeSection.value === 'title') return TitleAdminPanel;
  if (activeSection.value === 'episode') return EpisodeAdminPanel;
  return TagAdminPanel;
});

function closeOnMask(event) {
  if (event.target === event.currentTarget) {
    adminStore.close();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-mask" @click="closeOnMask">
      <section class="admin-modal" role="dialog" aria-modal="true" aria-label="管理">
        <header class="admin-modal-header">
          <h3>管理</h3>
          <button type="button" class="icon-btn" @click="adminStore.close()">×</button>
        </header>

        <div class="admin-modal-tabs">
          <button
            type="button"
            class="admin-nav-btn"
            :class="{ active: activeSection === 'tag' }"
            @click="adminStore.setSection('tag')"
          >
            标签管理
          </button>
          <button
            type="button"
            class="admin-nav-btn"
            :class="{ active: activeSection === 'title' }"
            @click="adminStore.setSection('title')"
          >
            漫剧管理
          </button>
          <button
            type="button"
            class="admin-nav-btn"
            :class="{ active: activeSection === 'episode' }"
            @click="adminStore.setSection('episode')"
          >
            内容管理
          </button>
        </div>

        <component :is="activeComponent" />
      </section>
    </div>
  </Teleport>
</template>
