<script setup>
defineProps({
  episodes: {
    type: Array,
    default: () => []
  },
  selectedEpisodeNo: {
    type: Number,
    default: null
  },
  page: {
    type: Number,
    default: 1
  },
  totalPages: {
    type: Number,
    default: 1
  }
});

defineEmits(['select', 'page-change']);
</script>

<template>
  <section class="episode-switcher">
    <button
      type="button"
      class="episode-nav"
      :disabled="page <= 1"
      aria-label="上一页"
      @click="$emit('page-change', page - 1)"
    >
      ◀
    </button>

    <div class="episode-row">
      <button
        v-for="episode in episodes"
        :key="episode.episodeNo"
        type="button"
        class="episode-tab"
        :class="{ active: selectedEpisodeNo === episode.episodeNo }"
        @click="$emit('select', episode.episodeNo)"
      >
        第{{ episode.episodeNo }}集
      </button>
    </div>

    <button
      type="button"
      class="episode-nav"
      :disabled="page >= totalPages"
      aria-label="下一页"
      @click="$emit('page-change', page + 1)"
    >
      ▶
    </button>
  </section>
</template>
