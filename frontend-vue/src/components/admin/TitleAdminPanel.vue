<script setup>
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';

import SeriesPicker from '../SeriesPicker.vue';
import TagMultiSelect from '../TagMultiSelect.vue';
import { getSuccessMessage, titlesApi } from '../../api';
import { useAdminStore } from '../../stores/admin';
import { useDetailStore } from '../../stores/detail';
import { useHomeStore } from '../../stores/home';
import { useTagsStore } from '../../stores/tags';
import { useTitlesStore } from '../../stores/titles';
import { useUiStore } from '../../stores/ui';
import { areSameStringSets, normalizeStringList } from '../../utils/normalize';

const route = useRoute();
const router = useRouter();

const uiStore = useUiStore();
const adminStore = useAdminStore();
const tagsStore = useTagsStore();
const titlesStore = useTitlesStore();
const homeStore = useHomeStore();
const detailStore = useDetailStore();

const { activeTitleAction } = storeToRefs(adminStore);
const submitting = ref(false);

const createForm = ref({
  titleName: '',
  titlePoster: '',
  titleTags: []
});

const renameForm = ref({
  oldName: '',
  newTitleName: '',
  newTitlePoster: '',
  titleTags: []
});

const deleteOldName = ref('');

const availableTags = computed(() => tagsStore.allTags);

watch(
  () => renameForm.value.oldName,
  async (titleName) => {
    if (!titleName) {
      renameForm.value.newTitleName = '';
      renameForm.value.newTitlePoster = '';
      renameForm.value.titleTags = [];
      return;
    }

    try {
      const targetTitle = await titlesStore.ensureTitleLoaded(titleName);
      if (!targetTitle) return;

      renameForm.value.newTitleName = targetTitle.name;
      renameForm.value.newTitlePoster = targetTitle.poster || '';
      renameForm.value.titleTags = normalizeStringList(targetTitle.tags || []);
    } catch (error) {
      uiStore.showFlash(error.message, 'error', 0);
    }
  }
);

async function refreshAfterMutation(nextDetailTitleName) {
  await tagsStore.fetchTags(true);
  await homeStore.fetchList();
  if (route.name === 'detail' && nextDetailTitleName) {
    await detailStore.loadDetail(nextDetailTitleName, { force: true });
  }
}

async function submitCreate() {
  if (!createForm.value.titleName.trim()) return;
  submitting.value = true;

  try {
    const response = await titlesApi.createTitle({
      titleName: createForm.value.titleName.trim(),
      titlePoster: createForm.value.titlePoster.trim(),
      titleTags: normalizeStringList(createForm.value.titleTags)
    });
    uiStore.showFlash(getSuccessMessage(response, '漫剧创建成功'));
    createForm.value = { titleName: '', titlePoster: '', titleTags: [] };
    await refreshAfterMutation();
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}

async function submitRename() {
  const oldName = renameForm.value.oldName.trim();
  const newName = renameForm.value.newTitleName.trim();
  if (!oldName || !newName) return;

  const currentRecord = await titlesStore.ensureTitleLoaded(oldName);
  if (!currentRecord) return;

  const hasChanged =
    newName !== currentRecord.name ||
    renameForm.value.newTitlePoster.trim() !== String(currentRecord.poster || '').trim() ||
    !areSameStringSets(renameForm.value.titleTags, currentRecord.tags || []);

  if (!hasChanged) return;

  submitting.value = true;
  try {
    const response = await titlesApi.updateTitle(oldName, {
      newTitleName: newName,
      newTitlePoster: renameForm.value.newTitlePoster.trim(),
      titleTags: normalizeStringList(renameForm.value.titleTags)
    });
    uiStore.showFlash(getSuccessMessage(response, '漫剧修改成功'));

    if (route.name === 'detail' && route.params.titleName === oldName) {
      await router.replace({ name: 'detail', params: { titleName: newName } });
    }

    renameForm.value.oldName = newName;
    await refreshAfterMutation(newName);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}

async function submitDelete() {
  if (!deleteOldName.value.trim()) return;
  const confirmed = window.confirm(`确认删除漫剧“${deleteOldName.value}”？该漫剧下全部剧集会被删除`);
  if (!confirmed) return;

  submitting.value = true;
  try {
    const response = await titlesApi.deleteTitle(deleteOldName.value.trim());
    uiStore.showFlash(getSuccessMessage(response, '漫剧删除成功'));

    if (route.name === 'detail' && route.params.titleName === deleteOldName.value.trim()) {
      await router.replace({ name: 'home' });
      detailStore.reset();
    }

    titlesStore.removeTitleFromCache(deleteOldName.value.trim());
    deleteOldName.value = '';
    await refreshAfterMutation();
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
        :class="{ active: activeTitleAction === 'create' }"
        @click="adminStore.setTitleAction('create')"
      >
        新增漫剧
      </button>
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeTitleAction === 'rename' }"
        @click="adminStore.setTitleAction('rename')"
      >
        修改漫剧
      </button>
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeTitleAction === 'delete' }"
        @click="adminStore.setTitleAction('delete')"
      >
        删除漫剧
      </button>
    </div>

    <section v-show="activeTitleAction === 'create'" class="action-panel">
      <form class="stack-form" @submit.prevent="submitCreate">
        <input v-model.trim="createForm.titleName" placeholder="漫剧名" required />
        <input v-model.trim="createForm.titlePoster" placeholder="海报资源地址：支持 https://... 或服务器本地绝对路径" />
        <TagMultiSelect v-model="createForm.titleTags" :options="availableTags" />
        <button type="submit" :disabled="submitting">新增</button>
      </form>
    </section>

    <section v-show="activeTitleAction === 'rename'" class="action-panel">
      <form class="stack-form" @submit.prevent="submitRename">
        <SeriesPicker v-model="renameForm.oldName" placeholder="选择漫剧" />
        <input v-model.trim="renameForm.newTitleName" placeholder="新漫剧名" required />
        <input v-model.trim="renameForm.newTitlePoster" placeholder="新海报资源地址：支持 https://... 或服务器本地绝对路径" />
        <TagMultiSelect v-model="renameForm.titleTags" :options="availableTags" />
        <button type="submit" :disabled="submitting">修改</button>
      </form>
    </section>

    <section v-show="activeTitleAction === 'delete'" class="action-panel">
      <form class="stack-form" @submit.prevent="submitDelete">
        <SeriesPicker v-model="deleteOldName" placeholder="选择漫剧" />
        <button type="submit" :disabled="submitting">删除</button>
      </form>
    </section>
  </section>
</template>
