<script setup>
import { computed, ref, watch } from 'vue';

import { buildPageNumbers } from '../utils/normalize';

const props = defineProps({
  page: {
    type: Number,
    required: true
  },
  totalPages: {
    type: Number,
    required: true
  },
  total: {
    type: Number,
    default: 0
  }
});

const emit = defineEmits(['change']);

const jumpInput = ref(String(props.page || 1));

watch(
  () => props.page,
  (nextPage) => {
    jumpInput.value = String(nextPage || 1);
  }
);

const pages = computed(() => buildPageNumbers(props.page, props.totalPages));

function emitPage(page) {
  if (page < 1 || page > props.totalPages || page === props.page) return;
  emit('change', page);
}

function submitJump() {
  const parsedPage = Number(jumpInput.value);
  if (!Number.isFinite(parsedPage)) return;
  emitPage(Math.floor(parsedPage));
}
</script>

<template>
  <section class="pagination">
    <button type="button" class="page-btn" :disabled="page <= 1" @click="emitPage(page - 1)">
      上一页
    </button>

    <div class="page-numbers">
      <template v-for="(pageNo, index) in pages" :key="pageNo">
        <span v-if="index > 0 && pageNo - pages[index - 1] > 1" class="page-ellipsis">...</span>
        <button
          type="button"
          class="page-number-btn"
          :class="{ active: pageNo === page }"
          @click="emitPage(pageNo)"
        >
          {{ pageNo }}
        </button>
      </template>
    </div>

    <button type="button" class="page-btn" :disabled="page >= totalPages" @click="emitPage(page + 1)">
      下一页
    </button>

    <span class="page-meta">第 {{ page }}/{{ totalPages }} 页，共 {{ total }} 条</span>

    <form class="page-jump-form" @submit.prevent="submitJump">
      <label class="page-jump-label" for="page-jump-input">跳转</label>
      <input id="page-jump-input" v-model="jumpInput" type="number" min="1" :max="totalPages" />
      <button type="submit" class="page-jump-btn">确定</button>
    </form>
  </section>
</template>
