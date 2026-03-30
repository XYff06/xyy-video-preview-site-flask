export function normalizeStringList(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

export function areSameStringSets(leftValues = [], rightValues = []) {
  const leftSet = new Set(normalizeStringList(leftValues));
  const rightSet = new Set(normalizeStringList(rightValues));
  if (leftSet.size !== rightSet.size) return false;
  return [...leftSet].every((value) => rightSet.has(value));
}

export function normalizeSeriesSummaryRecord(seriesRecord = {}) {
  return {
    name: String(seriesRecord.name || '').trim(),
    poster: String(seriesRecord.poster || seriesRecord.cover_url || '').trim(),
    currentMaxEpisodeNo: Number(seriesRecord.currentMaxEpisodeNo || 0),
    totalEpisodeCount: Number(seriesRecord.totalEpisodeCount || 0),
    updatedAt: seriesRecord.updatedAt || null,
    firstIngestedAt: seriesRecord.firstIngestedAt || null,
    tags: normalizeStringList(seriesRecord.tags || [])
  };
}

export function normalizeTitleOptionRecord(titleRecord = {}) {
  return {
    name: String(titleRecord.name || '').trim(),
    poster: String(titleRecord.poster || titleRecord.cover_url || '').trim(),
    tags: normalizeStringList(titleRecord.tags || [])
  };
}

export function normalizeEpisodeRecords(episodes = []) {
  const latestEpisodeByNo = new Map();

  episodes.forEach((episode) => {
    const episodeNo = Number(episode.episodeNo);
    if (!Number.isFinite(episodeNo)) return;

    const nextRecord = {
      episodeNo,
      episodeUrl: String(episode.episodeUrl || '').trim(),
      firstIngestedAt: episode.firstIngestedAt || null,
      updatedAt: episode.updatedAt || null
    };

    const previousRecord = latestEpisodeByNo.get(episodeNo);
    if (!previousRecord) {
      latestEpisodeByNo.set(episodeNo, nextRecord);
      return;
    }

    const previousUpdatedAt = new Date(previousRecord.updatedAt || 0).getTime();
    const nextUpdatedAt = new Date(nextRecord.updatedAt || 0).getTime();
    if (nextUpdatedAt >= previousUpdatedAt) {
      latestEpisodeByNo.set(episodeNo, nextRecord);
    }
  });

  return [...latestEpisodeByNo.values()].sort((left, right) => left.episodeNo - right.episodeNo);
}

export function normalizeBatchDraft(draft = {}) {
  return {
    titleName: String(draft.titleName || '').trim(),
    titlePoster: String(draft.titlePoster || '').trim(),
    directory: String(draft.directory || '').trim(),
    titleTags: normalizeStringList(draft.titleTags || [])
  };
}

export function buildPageNumbers(currentPage, totalPages) {
  if (totalPages <= 1) return [1];
  const pageSet = new Set([1, totalPages]);
  for (let pageNo = currentPage - 2; pageNo <= currentPage + 2; pageNo += 1) {
    if (pageNo >= 1 && pageNo <= totalPages) {
      pageSet.add(pageNo);
    }
  }
  return [...pageSet].sort((left, right) => left - right);
}
