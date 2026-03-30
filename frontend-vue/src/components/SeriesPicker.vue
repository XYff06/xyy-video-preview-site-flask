<script setup>
import { computed, onMounted, ref, watch } from 'vue';

import { useTitlesStore } from '../stores/titles';

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  placeholder: {
    type: String,
    default: '选择漫剧'
  },
  pageSize: {
    type: Number,
    default: 5
  }
});

const emit = defineEmits(['update:modelValue', 'change']);

const titlesStore = useTitlesStore();

const search = ref('');
const page = ref(1);
const loading = ref(false);
const error = ref('');
const options = ref([]);
const pagination = ref({
  page: 1,
  pageSize: props.pageSize,
  total: 0,
  totalPages: 1
});

const currentLabel = computed(() => props.modelValue || props.placeholder);

async function loadOptions() {
  loading.value = true;
  error.value = '';

  try {
    const payload = await titlesStore.fetchTitlesPage({
      search: search.value,
      page: page.value,
      pageSize: props.pageSize
    });
    options.value = payload.options;
    pagination.value = payload.pagination;
    page.value = payload.pagination.page;
  } catch (requestError) {
    error.value = requestError.message;
    options.value = [];
  } finally {
    loading.value = false;
  }
}

function selectTitle(name) {
  emit('update:modelValue', name);
  emit('change', name);
}

watch(search, () => {
  if (page.value !== 1) {
    page.value = 1;
    return;
  }
  loadOptions();
});

watch(page, () => {
  loadOptions();
});

onMounted(loadOptions);
</script>

<template>
  <section class="series-picker">
    <div class="series-picker-current" :class="{ 'is-empty': !modelValue }">
      {{ currentLabel }}
    </div>

    <input v-model.trim="search" type="search" class="series-picker-search" placeholder="搜索漫剧" />

    <div class="series-picker-options">
      <p v-if="loading" class="series-picker-empty">正在加载...</p>
      <p v-else-if="error" class="series-picker-empty">{{ error }}</p>
      <p v-else-if="!options.length" class="series-picker-empty">当前条件下没有漫剧</p>
      <template v-else>
        <button
          v-for="option in options"
          :key="option.name"
          type="button"
          class="series-picker-option"
          :class="{ active: option.name === modelValue }"
          @click="selectTitle(option.name)"
        >
          <span class="series-picker-option-name">{{ option.name }}</span>
        </button>
      </template>
    </div>

    <div class="series-picker-pagination">
      <button
        type="button"
        class="series-picker-page-btn"
        :disabled="pagination.page <= 1 || loading"
        @click="page -= 1"
      >
        上一页
      </button>
      <span class="series-picker-page-meta">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
      <button
        type="button"
        class="series-picker-page-btn"
        :disabled="pagination.page >= pagination.totalPages || loading"
        @click="page += 1"
      >
        下一页
      </button>
    </div>
  </section>
</template>
