<script setup>
import { ref } from 'vue';

import { getSuccessMessage, tagsApi } from '../../api';
import { storeToRefs } from 'pinia';

import { useAdminStore } from '../../stores/admin';
import { useHomeStore } from '../../stores/home';
import { useTagsStore } from '../../stores/tags';
import { useUiStore } from '../../stores/ui';

const tagsStore = useTagsStore();
const homeStore = useHomeStore();
const uiStore = useUiStore();
const adminStore = useAdminStore();
const { activeTagAction } = storeToRefs(adminStore);
const createTagName = ref('');
const renameOldName = ref('');
const renameNewName = ref('');
const deleteTagName = ref('');
const submitting = ref(false);

async function refreshTags() {
  await tagsStore.fetchTags(true);
  homeStore.ensureSelectedTagExists(tagsStore.allTags);
  try {
    await homeStore.fetchList();
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
}

async function submitCreate() {
  if (!createTagName.value.trim()) return;
  submitting.value = true;
  try {
    const response = await tagsApi.createTag({ tagName: createTagName.value.trim() });
    uiStore.showFlash(getSuccessMessage(response, '标签创建成功'));
    createTagName.value = '';
    await refreshTags();
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}

function handleRenameOldNameChange() {
  renameNewName.value = renameOldName.value;
}

async function submitRename() {
  if (!renameOldName.value.trim() || !renameNewName.value.trim()) return;
  if (renameOldName.value.trim() === renameNewName.value.trim()) return;

  submitting.value = true;
  try {
    const response = await tagsApi.updateTag(renameOldName.value.trim(), {
      newTagName: renameNewName.value.trim()
    });
    if (homeStore.selectedTag === renameOldName.value.trim()) {
      homeStore.selectedTag = renameNewName.value.trim();
    }
    uiStore.showFlash(getSuccessMessage(response, '标签修改成功'));
    renameOldName.value = '';
    renameNewName.value = '';
    await refreshTags();
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}

async function submitDelete() {
  if (!deleteTagName.value.trim()) return;
  const confirmed = window.confirm(`确认删除标签“${deleteTagName.value}”？会从所有漫剧里移除该标签`);
  if (!confirmed) return;

  submitting.value = true;
  try {
    const response = await tagsApi.deleteTag(deleteTagName.value.trim());
    if (homeStore.selectedTag === deleteTagName.value.trim()) {
      homeStore.selectedTag = null;
    }
    uiStore.showFlash(getSuccessMessage(response, '标签删除成功'));
    deleteTagName.value = '';
    await refreshTags();
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="admin-panel">
    <div class="action-tabs">
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeTagAction === 'create' }"
        @click="adminStore.setTagAction('create')"
      >
        新增标签
      </button>
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeTagAction === 'rename' }"
        @click="adminStore.setTagAction('rename')"
      >
        修改标签
      </button>
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeTagAction === 'delete' }"
        @click="adminStore.setTagAction('delete')"
      >
        删除标签
      </button>
    </div>

    <section v-show="activeTagAction === 'create'" class="action-panel">
      <form class="inline-form" @submit.prevent="submitCreate">
        <input v-model.trim="createTagName" placeholder="标签名" required />
        <button type="submit" :disabled="submitting">新增</button>
      </form>
    </section>

    <section v-show="activeTagAction === 'rename'" class="action-panel">
      <form class="inline-form" @submit.prevent="submitRename">
        <select v-model="renameOldName" required @change="handleRenameOldNameChange">
          <option value="">选择标签</option>
          <option v-for="tagName in tagsStore.allTags" :key="tagName" :value="tagName">
            {{ tagName }}
          </option>
        </select>
        <input v-model.trim="renameNewName" placeholder="新标签名" required />
        <button type="submit" :disabled="submitting">修改</button>
      </form>
    </section>

    <section v-show="activeTagAction === 'delete'" class="action-panel">
      <form class="inline-form" @submit.prevent="submitDelete">
        <select v-model="deleteTagName" required>
          <option value="">选择标签</option>
          <option v-for="tagName in tagsStore.allTags" :key="tagName" :value="tagName">
            {{ tagName }}
          </option>
        </select>
        <button type="submit" :disabled="submitting">删除</button>
      </form>
    </section>
  </section>
</template>
