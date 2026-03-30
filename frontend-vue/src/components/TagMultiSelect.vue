<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: {
    type: Array,
    default: () => []
  },
  options: {
    type: Array,
    default: () => []
  },
  placeholder: {
    type: String,
    default: '选择标签(可多选)'
  }
});

const emit = defineEmits(['update:modelValue']);

const selectedValues = computed(() => new Set(props.modelValue));
const summaryText = computed(() => (props.modelValue.length ? props.modelValue.join('、') : props.placeholder));

function toggleValue(tagName, checked) {
  const nextValues = new Set(props.modelValue);
  if (checked) {
    nextValues.add(tagName);
  } else {
    nextValues.delete(tagName);
  }
  emit('update:modelValue', [...nextValues]);
}
</script>

<template>
  <div v-if="!options.length" class="multi-select-empty">暂无可选标签</div>

  <details v-else class="multi-select">
    <summary class="multi-select-summary">{{ summaryText }}</summary>
    <div class="multi-select-list">
      <label v-for="tagName in options" :key="tagName" class="multi-select-item">
        <input
          type="checkbox"
          :checked="selectedValues.has(tagName)"
          @change="toggleValue(tagName, $event.target.checked)"
        />
        <span>{{ tagName }}</span>
      </label>
    </div>
  </details>
</template>
