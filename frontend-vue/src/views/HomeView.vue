<script setup>
import { computed, onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';

import Pagination from '../components/Pagination.vue';
import PosterCard from '../components/PosterCard.vue';
import { useHomeStore } from '../stores/home';
import { useTagsStore } from '../stores/tags';
import { useUiStore } from '../stores/ui';

const router = useRouter();

const uiStore = useUiStore();
const homeStore = useHomeStore();
const tagsStore = useTagsStore();

const searchForm = reactive({
  searchQuery: homeStore.searchQuery,
  sortBy: homeStore.sortBy
});

const hasData = computed(() => homeStore.items.length > 0);

async function fetchHomeData() {
  try {
    if (!tagsStore.initialized) {
      await tagsStore.fetchTags();
    }
    await homeStore.fetchList();
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
}

async function submitSearch() {
  try {
    await homeStore.submitSearch(searchForm);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
}

async function changeSort() {
  try {
    await homeStore.setSort(searchForm.sortBy);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
}

async function changePage(page) {
  try {
    await homeStore.setPage(page);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
}

function openDetail(series) {
  router.push({ name: 'detail', params: { titleName: series.name } });
}

onMounted(fetchHomeData);
</script>

<template>
  <section class="home-page">
    <section class="home-toolbar">
      <form class="toolbar" @submit.prevent="submitSearch">
        <input v-model.trim="searchForm.searchQuery" type="search" class="global-search" placeholder="输入漫剧名搜索" />
        <button type="submit" class="primary-button search-button">搜索</button>
        <select v-model="searchForm.sortBy" class="global-sort" aria-label="排序依据" @change="changeSort">
          <option value="updated_desc">最后更新时间(倒序)</option>
          <option value="updated_asc">最后更新时间(顺序)</option>
          <option value="ingested_asc">最早入库时间(顺序)</option>
          <option value="ingested_desc">最早入库时间(倒序)</option>
          <option value="name_asc">名称(顺序)</option>
          <option value="name_desc">名称(倒序)</option>
        </select>
      </form>
    </section>

    <section v-if="homeStore.loading" class="poster-grid">
      <p class="empty-state">正在加载列表...</p>
    </section>

    <section v-else-if="homeStore.error" class="poster-grid">
      <p class="empty-state">加载失败：{{ homeStore.error }}</p>
    </section>

    <section v-else-if="!hasData" class="poster-grid">
      <p class="empty-state">没有匹配的漫剧</p>
    </section>

    <section v-else class="poster-grid">
      <PosterCard v-for="series in homeStore.items" :key="series.name" :series="series" @click="openDetail" />
    </section>

    <Pagination
      v-if="!homeStore.loading && !homeStore.error && hasData"
      :page="homeStore.currentPage"
      :total-pages="homeStore.totalPages"
      :total="homeStore.total"
      @change="changePage"
    />
  </section>
</template>
