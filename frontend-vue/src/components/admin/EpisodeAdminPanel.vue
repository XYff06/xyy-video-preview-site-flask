<script setup>
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute } from 'vue-router';

import SeriesPicker from '../SeriesPicker.vue';
import TagMultiSelect from '../TagMultiSelect.vue';
import { episodesApi, getSuccessMessage } from '../../api';
import { useAdminStore } from '../../stores/admin';
import { useDetailStore } from '../../stores/detail';
import { useEpisodesStore } from '../../stores/episodes';
import { useHomeStore } from '../../stores/home';
import { useTagsStore } from '../../stores/tags';
import { useUiStore } from '../../stores/ui';
import { normalizeBatchDraft } from '../../utils/normalize';

const route = useRoute();

const uiStore = useUiStore();
const adminStore = useAdminStore();
const tagsStore = useTagsStore();
const homeStore = useHomeStore();
const detailStore = useDetailStore();
const episodesStore = useEpisodesStore();

const { activeEpisodeAction } = storeToRefs(adminStore);
const submitting = ref(false);

const createForm = ref({
  titleName: '',
  titleEpisodeNo: '',
  titleEpisodeVideo: ''
});

const updateForm = ref({
  titleName: '',
  titleEpisodeNo: '',
  newTitleEpisodeNo: '',
  newTitleEpisodeVideo: ''
});

const deleteForm = ref({
  titleName: '',
  titleEpisodeNo: ''
});

const updateEpisodeOptions = ref([]);
const deleteEpisodeOptions = ref([]);

const availableTags = computed(() => tagsStore.allTags);
const batchDraft = computed({
  get: () => episodesStore.batchDraft,
  set: (value) => episodesStore.setBatchDraft(value)
});

watch(
  () => updateForm.value.titleName,
  async (titleName) => {
    try {
      updateEpisodeOptions.value = titleName ? await episodesStore.fetchEpisodeOptions(titleName, true) : [];
      const targetEpisode = updateEpisodeOptions.value[0];
      if (!targetEpisode) {
        updateForm.value.titleEpisodeNo = '';
        updateForm.value.newTitleEpisodeNo = '';
        updateForm.value.newTitleEpisodeVideo = '';
        return;
      }
      updateForm.value.titleEpisodeNo = String(targetEpisode.episodeNo);
      updateForm.value.newTitleEpisodeNo = String(targetEpisode.episodeNo);
      updateForm.value.newTitleEpisodeVideo = targetEpisode.episodeUrl;
    } catch (error) {
      uiStore.showFlash(error.message, 'error', 0);
    }
  }
);

watch(
  () => updateForm.value.titleEpisodeNo,
  (episodeNo) => {
    const targetEpisode = updateEpisodeOptions.value.find((episode) => episode.episodeNo === Number(episodeNo));
    if (!targetEpisode) return;
    updateForm.value.newTitleEpisodeNo = String(targetEpisode.episodeNo);
    updateForm.value.newTitleEpisodeVideo = targetEpisode.episodeUrl;
  }
);

watch(
  () => deleteForm.value.titleName,
  async (titleName) => {
    try {
      deleteEpisodeOptions.value = titleName ? await episodesStore.fetchEpisodeOptions(titleName, true) : [];
      deleteForm.value.titleEpisodeNo = deleteEpisodeOptions.value[0] ? String(deleteEpisodeOptions.value[0].episodeNo) : '';
    } catch (error) {
      uiStore.showFlash(error.message, 'error', 0);
    }
  }
);

watch(
  () => batchDraft.value,
  () => {
    if (episodesStore.batchPendingConfirmation) {
      episodesStore.clearBatchConfirmation();
    }
  },
  { deep: true }
);

async function refreshAfterMutation(targetTitleName) {
  await tagsStore.fetchTags(true);
  await homeStore.fetchList();
  if (targetTitleName) {
    await episodesStore.fetchEpisodeOptions(targetTitleName, true);
  }
  if (route.name === 'detail' && targetTitleName && route.params.titleName === targetTitleName) {
    await detailStore.loadDetail(targetTitleName, { force: true });
  }
}

async function submitCreate() {
  if (!createForm.value.titleName.trim()) return;
  submitting.value = true;

  try {
    const titleName = createForm.value.titleName.trim();
    const response = await episodesApi.createEpisode({
      titleName,
      titleEpisodeNo: Number(createForm.value.titleEpisodeNo),
      titleEpisodeVideo: createForm.value.titleEpisodeVideo.trim()
    });
    uiStore.showFlash(getSuccessMessage(response, '剧集新增成功'));
    createForm.value = { titleName: '', titleEpisodeNo: '', titleEpisodeVideo: '' };
    await refreshAfterMutation(titleName);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}

async function submitBatch(continueImportForExistingTitle = false) {
  const currentDraft = normalizeBatchDraft(batchDraft.value);
  episodesStore.setBatchDraft(currentDraft);

  try {
    const response = await episodesStore.submitBatchImport(continueImportForExistingTitle);
    if (response.requiresConfirmation) return;

    uiStore.showFlash(getSuccessMessage(response, '批量导入成功'));
    await refreshAfterMutation(currentDraft.titleName);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  }
}

async function submitUpdate() {
  if (!updateForm.value.titleName.trim()) return;
  submitting.value = true;

  try {
    const titleName = updateForm.value.titleName.trim();
    const response = await episodesApi.updateEpisode({
      titleName,
      titleEpisodeNo: Number(updateForm.value.titleEpisodeNo),
      newTitleEpisodeNo: Number(updateForm.value.newTitleEpisodeNo),
      newTitleEpisodeVideo: updateForm.value.newTitleEpisodeVideo.trim()
    });
    uiStore.showFlash(getSuccessMessage(response, '剧集修改成功'));
    await refreshAfterMutation(titleName);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}

async function submitDelete() {
  if (!deleteForm.value.titleName.trim() || !deleteForm.value.titleEpisodeNo) return;
  const confirmed = window.confirm(`确认删除「${deleteForm.value.titleName}」第${deleteForm.value.titleEpisodeNo}集？`);
  if (!confirmed) return;

  submitting.value = true;
  try {
    const titleName = deleteForm.value.titleName.trim();
    const response = await episodesApi.deleteEpisode({
      titleName,
      titleEpisodeNo: Number(deleteForm.value.titleEpisodeNo)
    });
    uiStore.showFlash(getSuccessMessage(response, '剧集删除成功'));
    await refreshAfterMutation(titleName);
  } catch (error) {
    uiStore.showFlash(error.message, 'error', 0);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="admin-panel">
    <div class="action-tabs episode-action-tabs">
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeEpisodeAction === 'create' }"
        @click="adminStore.setEpisodeAction('create')"
      >
        新增剧集
      </button>
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeEpisodeAction === 'batch' }"
        @click="adminStore.setEpisodeAction('batch')"
      >
        批量导入
      </button>
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeEpisodeAction === 'rename' }"
        @click="adminStore.setEpisodeAction('rename')"
      >
        修改剧集
      </button>
      <button
        type="button"
        class="admin-action-tab-button"
        :class="{ active: activeEpisodeAction === 'delete' }"
        @click="adminStore.setEpisodeAction('delete')"
      >
        删除剧集
      </button>
    </div>

    <section v-show="activeEpisodeAction === 'create'" class="action-panel">
      <form class="stack-form" @submit.prevent="submitCreate">
        <SeriesPicker v-model="createForm.titleName" placeholder="选择漫剧" />
        <input v-model="createForm.titleEpisodeNo" type="number" min="1" placeholder="集号" required />
        <input
          v-model.trim="createForm.titleEpisodeVideo"
          placeholder="播放资源地址：支持 https://... 或服务器本地绝对路径"
          required
        />
        <button type="submit" :disabled="submitting">新增</button>
      </form>
    </section>

    <section v-show="activeEpisodeAction === 'batch'" class="action-panel">
      <form class="stack-form" @submit.prevent="submitBatch(false)">
        <input
          :value="batchDraft.titleName"
          placeholder="漫剧名"
          required
          @input="episodesStore.patchBatchDraft({ titleName: $event.target.value })"
        />
        <input
          :value="batchDraft.titlePoster"
          placeholder="海报资源地址：支持 https://... 或服务器本地绝对路径"
          @input="episodesStore.patchBatchDraft({ titlePoster: $event.target.value })"
        />
        <input
          :value="batchDraft.directory"
          placeholder="视频目录资源地址：支持 https://... 或服务器本地绝对路径"
          required
          @input="episodesStore.patchBatchDraft({ directory: $event.target.value })"
        />
        <TagMultiSelect
          :model-value="batchDraft.titleTags"
          :options="availableTags"
          @update:model-value="episodesStore.patchBatchDraft({ titleTags: $event })"
        />
        <p class="hint">会自动解析目录下视频链接，并按文件名里的“第1集”“第一集”“EP01”等集号排序导入。</p>
        <button type="submit" :disabled="episodesStore.batchSubmitting">
          {{ episodesStore.batchSubmitting ? '导入中...' : '批量导入' }}
        </button>
      </form>

      <section v-if="episodesStore.batchPendingConfirmation" class="batch-confirm-card">
        <p class="batch-confirm-title">漫剧《{{ episodesStore.batchPendingConfirmation.payload.titleName }}》已存在</p>
        <p class="batch-confirm-text">
          {{ episodesStore.batchPendingConfirmation.message || '继续导入可能会新增或更新已有剧集，请确认是否继续。' }}
        </p>
        <div class="batch-confirm-actions">
          <button type="button" class="batch-confirm-cancel" @click="episodesStore.clearBatchConfirmation()">取消</button>
          <button type="button" class="batch-confirm-submit" @click="submitBatch(true)">继续导入</button>
        </div>
      </section>
    </section>

    <section v-show="activeEpisodeAction === 'rename'" class="action-panel">
      <form class="stack-form" @submit.prevent="submitUpdate">
        <SeriesPicker v-model="updateForm.titleName" placeholder="选择漫剧" />
        <select v-model="updateForm.titleEpisodeNo" required>
          <option value="">选择集号</option>
          <option v-for="episode in updateEpisodeOptions" :key="episode.episodeNo" :value="episode.episodeNo">
            第{{ episode.episodeNo }}集
          </option>
        </select>
        <input v-model="updateForm.newTitleEpisodeNo" type="number" min="1" placeholder="新集号" required />
        <input
          v-model.trim="updateForm.newTitleEpisodeVideo"
          placeholder="新资源地址：支持 https://... 或服务器本地绝对路径"
          required
        />
        <button type="submit" :disabled="submitting">修改</button>
      </form>
    </section>

    <section v-show="activeEpisodeAction === 'delete'" class="action-panel">
      <form class="stack-form" @submit.prevent="submitDelete">
        <SeriesPicker v-model="deleteForm.titleName" placeholder="选择漫剧" />
        <select v-model="deleteForm.titleEpisodeNo" required>
          <option value="">选择集号</option>
          <option v-for="episode in deleteEpisodeOptions" :key="episode.episodeNo" :value="episode.episodeNo">
            第{{ episode.episodeNo }}集
          </option>
        </select>
        <button type="submit" :disabled="submitting">删除</button>
      </form>
    </section>
  </section>
</template>
