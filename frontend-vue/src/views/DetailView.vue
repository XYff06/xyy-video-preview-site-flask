<script setup>
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';

import EpisodeSwitcher from '../components/EpisodeSwitcher.vue';
import VideoPlayerCard from '../components/VideoPlayerCard.vue';
import { useDetailStore } from '../stores/detail';
import { useEpisodesStore } from '../stores/episodes';
import { useUiStore } from '../stores/ui';

const route = useRoute();

const uiStore = useUiStore();
const detailStore = useDetailStore();
const episodesStore = useEpisodesStore();

const titleName = computed(() => String(route.params.titleName || '').trim());
const selectedEpisode = computed(() => detailStore.selectedEpisode);

async function loadDetail() {
  if (!titleName.value) return;

  try {
    const series = await detailStore.loadDetail(titleName.value, { force: true });
    if (series) {
      episodesStore.cacheEpisodeOptions(series.name, series.episodes);
    }
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
}

watch(titleName, loadDetail, { immediate: true });
</script>

<template>
  <section class="detail-page">
    <section v-if="detailStore.loading" class="detail-state">正在加载详情...</section>
    <section v-else-if="detailStore.error" class="detail-state">加载失败：{{ detailStore.error }}</section>
    <template v-else>
      <VideoPlayerCard :title-name="detailStore.currentSeries?.name" :episode="selectedEpisode">
        <EpisodeSwitcher
          :episodes="detailStore.visibleEpisodes"
          :selected-episode-no="detailStore.selectedEpisodeNo"
          :page="detailStore.episodePage"
          :total-pages="detailStore.totalEpisodePages"
          @select="detailStore.setSelectedEpisode"
          @page-change="detailStore.setEpisodePage"
        />
      </VideoPlayerCard>
    </template>
  </section>
</template>
