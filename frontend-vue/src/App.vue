<script setup>
import { computed, onMounted, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';

import AdminModal from './components/AdminModal.vue';
import FlashMessage from './components/FlashMessage.vue';
import { useAdminStore } from './stores/admin';
import { useHomeStore } from './stores/home';
import { useTagsStore } from './stores/tags';
import { useUiStore } from './stores/ui';

const route = useRoute();
const router = useRouter();

const uiStore = useUiStore();
const homeStore = useHomeStore();
const adminStore = useAdminStore();
const tagsStore = useTagsStore();

const isDetailRoute = computed(() => route.name === 'detail');
const allTags = computed(() => tagsStore.allTags);
const visibleTags = computed(() => (homeStore.tagExpanded ? allTags.value : allTags.value.slice(0, 5)));
const selectedHiddenTag = computed(() => {
  return !homeStore.tagExpanded && homeStore.selectedTag !== null && !visibleTags.value.includes(homeStore.selectedTag);
});
const tagItems = computed(() => {
  return [
    { type: 'all', label: '全部' },
    ...visibleTags.value.map((tagName) => ({ type: 'tag', label: tagName })),
    { type: 'more', label: homeStore.tagExpanded ? '收起' : '更多' }
  ];
});

async function handleTagClick(item) {
  if (item.type === 'more') {
    homeStore.toggleTagExpanded();
    return;
  }

  if (item.type === 'all') {
    await homeStore.setTag(null);
    return;
  }

  await homeStore.setTag(item.label);
}

onMounted(async () => {
  await uiStore.bootstrap();
  if (uiStore.appError) return;

  try {
    await tagsStore.fetchTags();
    homeStore.ensureSelectedTagExists(tagsStore.allTags);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
});

watch(
  () => tagsStore.allTags,
  (nextTags) => {
    homeStore.ensureSelectedTagExists(nextTags);
  },
  { deep: true }
);
</script>

<template>
  <main class="app">
    <section v-if="uiStore.appLoading" class="app-status-wrap">
      <article class="status-card">正在加载基础数据...</article>
    </section>

    <section v-else-if="uiStore.appError" class="app-status-wrap">
      <article class="status-card status-card-error">加载失败：{{ uiStore.appError }}</article>
    </section>

    <section v-else class="layout-shell">
      <aside class="side-rail left-rail">
        <section v-if="!isDetailRoute" class="categories">
          <button
            v-for="item in tagItems"
            :key="`${item.type}-${item.label}`"
            type="button"
            class="category-pill"
            :class="{
              active:
                item.type === 'all'
                  ? homeStore.selectedTag === null
                  : item.type === 'tag'
                    ? homeStore.selectedTag === item.label
                    : homeStore.tagExpanded || selectedHiddenTag
            }"
            @click="handleTagClick(item)"
          >
            {{ item.label }}
          </button>
        </section>

        <button v-else type="button" class="back-btn" @click="router.push({ name: 'home' })">
          返回首页
        </button>
      </aside>

      <section class="content-shell">
        <FlashMessage />
        <RouterView />
      </section>

      <aside class="side-rail right-rail">
        <button type="button" class="primary-button manage-button" @click="adminStore.open()">
          管理
        </button>
      </aside>
    </section>

    <AdminModal />
  </main>
</template>
