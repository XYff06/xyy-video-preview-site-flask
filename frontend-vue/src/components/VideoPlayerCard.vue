<script setup>
import { formatDateTimeZhCN } from '../utils/format';

defineProps({
  titleName: {
    type: String,
    default: ''
  },
  episode: {
    type: Object,
    default: null
  }
});
</script>

<template>
  <section class="player-wrap">
    <video v-if="episode" id="player" controls preload="metadata" :src="episode.episodeUrl"></video>
    <video v-else id="player" controls preload="metadata"></video>

    <slot />

    <section class="player-meta">
      <p class="player-meta-title">{{ titleName }}</p>

      <template v-if="episode">
        <p class="player-meta-time-row">
          <span>首次入库：{{ formatDateTimeZhCN(episode.firstIngestedAt) }}</span>
          <span>最近更新：{{ formatDateTimeZhCN(episode.updatedAt) }}</span>
        </p>
        <p class="player-meta-url">{{ episode.episodeUrl }}</p>
      </template>

      <p v-else class="player-meta-empty">暂无内容</p>
    </section>
  </section>
</template>
