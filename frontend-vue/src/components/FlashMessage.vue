<script setup>
import { storeToRefs } from 'pinia';

import { useUiStore } from '../stores/ui';

const uiStore = useUiStore();
const { flashMessage } = storeToRefs(uiStore);
</script>

<template>
  <section v-if="flashMessage" class="flash-message" :class="`flash-message-${uiStore.flashType}`" role="status">
    <span class="flash-text">{{ flashMessage }}</span>
    <button type="button" class="flash-close" aria-label="关闭提示" @click="uiStore.clearFlash()">
      ×
    </button>
  </section>
</template>
