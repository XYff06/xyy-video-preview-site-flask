<script setup>
import { formatDateTimeZhCN } from '../utils/format';

defineProps({
  series: {
    type: Object,
    required: true
  }
});

defineEmits(['click']);
</script>

<template>
  <article class="poster-card" @click="$emit('click', series)">
    <div class="poster" :style="{ backgroundImage: `url('${series.poster || ''}')` }"></div>
    <p class="poster-title">{{ series.name }}</p>
    <p class="poster-meta">
      最大集数：{{ series.currentMaxEpisodeNo }}<br />
      总集数：{{ series.totalEpisodeCount }}<br />
      最后更新时间：<br />
      {{ formatDateTimeZhCN(series.updatedAt) }}<br />
      入库时间：<br />
      {{ formatDateTimeZhCN(series.firstIngestedAt) }}
    </p>
  </article>
</template>
