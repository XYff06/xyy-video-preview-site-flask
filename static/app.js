const fmt = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

const state = {
  allSeries: [],
  allTags: [],
  selectedTag: null,
  searchQuery: '',
  sortBy: 'updated_desc',
  currentPage: 1,
  pageSize: 25,
  homeSeries: [],
  homeTotal: 0,
  homeLoading: false,
  homeError: null,
  selectedEpisode: null,
  episodePage: 1,
  episodePageSize: 10,
  detailSeriesName: '',
  tagExpanded: false,
  loading: true,
  error: null,
  activeAdminTab: 'tag',
  adminModalOpen: false,
  flashMessage: '',
  flashAutoCloseTimeout: null,
  flashVersion: 0,
  flashVersionRendered: 0,
  activeTagAction: 'create',
  activeTitleAction: 'create',
  activeEpisodeAction: 'create'
};

function currentPathName() {
  return decodeURIComponent(location.pathname.slice(1));
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || '请求失败');
  }
  return payload;
}

async function loadTags() {
  const payload = await apiFetch('/api/tags');
  state.allTags = payload.data;
}

async function loadSeries() {
  try {
    const [seriesPayload] = await Promise.all([
      apiFetch('/api/series?page=1&pageSize=10000'),
      loadTags()
    ]);
    state.allSeries = seriesPayload.data.map((item) => ({
      ...item,
      tags: new Set(item.tags),
      episodes: normalizeEpisodes(item.episodes || [])
    }));
    state.loading = false;
    state.error = null;
  } catch (error) {
    state.loading = false;
    state.error = error.message;
  }

  render();

  if (!currentPathName()) {
    await loadHomeSeries();
  }
}

async function loadHomeSeries() {
  state.homeLoading = true;
  state.homeError = null;
  render();

  const params = new URLSearchParams();
  params.set('page', String(state.currentPage));
  params.set('pageSize', String(state.pageSize));
  if (state.selectedTag) params.set('tag', state.selectedTag);
  if (state.searchQuery.trim()) params.set('search', state.searchQuery.trim());
  params.set('sort', state.sortBy);

  try {
    const payload = await apiFetch(`/api/series?${params.toString()}`);
    state.homeSeries = payload.data.map((item) => ({
      ...item,
      episodes: normalizeEpisodes(item.episodes || [])
    }));
    state.homeTotal = payload.pagination?.total ?? payload.data.length;
    state.currentPage = payload.pagination?.page ?? state.currentPage;
    state.homeLoading = false;
    state.homeError = null;
  } catch (error) {
    state.homeSeries = [];
    state.homeTotal = 0;
    state.homeLoading = false;
    state.homeError = error.message;
  }

  render();
}

function getAllTags() {
  if (state.allTags.length) return [...state.allTags];
  return [...new Set(state.allSeries.flatMap((item) => [...item.tags]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}


function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEpisodes(episodes) {
  const normalized = new Map();

  episodes.forEach((episode) => {
    const episodeNo = Number(episode.episode);
    if (!Number.isFinite(episodeNo)) return;

    const current = normalized.get(episodeNo);
    if (!current) {
      normalized.set(episodeNo, { ...episode, episode: episodeNo });
      return;
    }

    const currentUpdatedAt = new Date(current.updatedAt || 0).getTime();
    const nextUpdatedAt = new Date(episode.updatedAt || 0).getTime();
    if (nextUpdatedAt >= currentUpdatedAt) {
      normalized.set(episodeNo, { ...episode, episode: episodeNo });
    }
  });

  return [...normalized.values()].sort((a, b) => a.episode - b.episode);
}

function getEpisodeOptionsByTitle(titleName) {
  const target = state.allSeries.find((series) => series.name === titleName);
  if (!target) return [];
  return normalizeEpisodes(target.episodes);
}

function getTagMultiSelectHtml(fieldName, tags, selectedTags = []) {
  if (!tags.length) {
    return '<div class="multi-select-empty">暂无可选标签</div>';
  }

  const selected = new Set(selectedTags);
  const selectedText = selected.size
    ? [...selected].map((tag) => escapeHtml(tag)).join('、')
    : '选择标签(可多选)';

  return `
    <details class="multi-select" data-multi-select>
      <summary class="multi-select-summary" data-multi-summary>${selectedText}</summary>
      <div class="multi-select-list">
        ${tags.map((tag) => `
          <label class="multi-select-item">
            <input type="checkbox" name="${fieldName}" value="${escapeHtml(tag)}" ${selected.has(tag) ? 'checked' : ''} />
            <span>${escapeHtml(tag)}</span>
          </label>
        `).join('')}
      </div>
    </details>
  `;
}

function bindMultiSelectSummary(scope) {
  scope.querySelectorAll('[data-multi-select]').forEach((multiSelect) => {
    const summary = multiSelect.querySelector('[data-multi-summary]');
    if (!summary) return;

    const updateSummary = () => {
      const checked = [...multiSelect.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
      summary.textContent = checked.length ? checked.join('、') : '选择标签(可多选)';
    };

    multiSelect.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      if (input.dataset.summaryBound === '1') return;
      input.addEventListener('change', updateSummary);
      input.dataset.summaryBound = '1';
    });

    updateSummary();
  });
}

function fillEpisodeSelectByTitle(titleSelect, episodeSelect, placeholderText) {
  const episodes = getEpisodeOptionsByTitle(titleSelect.value);
  episodeSelect.innerHTML = `<option value="">${placeholderText}</option>${episodes
    .map((episode) => `<option value="${episode.episode}">第${episode.episode}集</option>`)
    .join('')}`;
}

function setFieldError(errorNode, message = '') {
  if (!errorNode) return;
  errorNode.textContent = message;
  errorNode.classList.toggle('hidden', !message);
}

function validateTagSelection(form, fieldName, errorNode, message) {
  const checkboxes = [...form.querySelectorAll(`input[name="${fieldName}"]`)];
  if (checkboxes.length === 0) return false;

  const hasSelection = checkboxes.some((checkbox) => checkbox.checked);
  setFieldError(errorNode, hasSelection ? '' : message);
  return hasSelection;
}

function getFlashHtml() {
  if (!state.flashMessage) return '';
  return `
    <div class="flash-msg" role="status">
      <span class="flash-text">${state.flashMessage}</span>
      <button type="button" class="flash-close" id="flash-close-btn" aria-label="关闭提示">✕</button>
    </div>
  `;
}

function setFlashMessage(message) {
  state.flashMessage = message;
  state.flashVersion += 1;
}

function clearFlashMessage() {
  state.flashMessage = '';
  if (state.flashAutoCloseTimeout) {
    clearTimeout(state.flashAutoCloseTimeout);
    state.flashAutoCloseTimeout = null;
  }
}

function getAdminModalHtml() {
  if (!state.adminModalOpen) return '';
  return `
    <div class="modal-mask" id="admin-modal-mask">
      <section class="admin-modal" role="dialog" aria-modal="true" aria-label="管理">
        <header class="admin-modal-header">
          <h3>管理</h3>
          <button id="close-admin" class="icon-btn" type="button">✕</button>
        </header>
        <div class="admin-modal-tabs">
          <button class="admin-nav-btn ${state.activeAdminTab === 'tag' ? 'active' : ''}" data-admin-tab="tag">标签管理</button>
          <button class="admin-nav-btn ${state.activeAdminTab === 'title' ? 'active' : ''}" data-admin-tab="title">漫剧管理</button>
          <button class="admin-nav-btn ${state.activeAdminTab === 'episode' ? 'active' : ''}" data-admin-tab="episode">内容管理</button>
        </div>
        <section id="admin-content"></section>
      </section>
    </div>
  `;
}

function render() {
  const app = document.getElementById('app');

  if (state.loading) {
    app.innerHTML = '<p>正在加载剧集数据...</p>';
    return;
  }

  if (state.error) {
    app.innerHTML = `<p>加载失败：${state.error}</p>`;
    return;
  }

  app.innerHTML = `
    <section class="layout-shell">
      <aside class="side-rail left-rail">
        <div id="top-row-left"></div>
      </aside>
      <section class="content-shell">
        ${getFlashHtml()}
        <section id="page-content"></section>
      </section>
      <aside class="side-rail right-rail">
        <button id="open-admin" class="primary-btn manage-btn" type="button">管理</button>
      </aside>
    </section>
    ${getAdminModalHtml()}
  `;

  document.getElementById('open-admin').onclick = () => {
    state.adminModalOpen = true;
    render();
  };

  const flashCloseBtn = document.getElementById('flash-close-btn');
  if (state.flashMessage && state.flashVersionRendered !== state.flashVersion) {
    if (state.flashAutoCloseTimeout) {
      clearTimeout(state.flashAutoCloseTimeout);
    }
    state.flashVersionRendered = state.flashVersion;
    state.flashAutoCloseTimeout = setTimeout(() => {
      clearFlashMessage();
      render();
    }, 5000);
  }
  if (flashCloseBtn) {
    flashCloseBtn.onclick = () => {
      clearFlashMessage();
      render();
    };
  }

  if (state.adminModalOpen) {
    document.getElementById('close-admin').onclick = () => {
      state.adminModalOpen = false;
      render();
    };

    document.getElementById('admin-modal-mask').onclick = (event) => {
      if (event.target.id !== 'admin-modal-mask') return;
      state.adminModalOpen = false;
      render();
    };

    document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
      btn.onclick = () => {
        state.activeAdminTab = btn.dataset.adminTab;
        render();
      };
    });

    renderAdminPanel(document.getElementById('admin-content'));
  }

  const pageContent = document.getElementById('page-content');
  const activeName = currentPathName();
  if (activeName) {
    const series = state.allSeries.find((s) => s.name === activeName);
    if (series) {
      renderDetail(pageContent, series);
    } else {
      history.replaceState({}, '', '/');
      renderHome(pageContent);
    }
  } else {
    renderHome(pageContent);
  }
}

function renderHome(container) {
  container.innerHTML = document.getElementById('home-template').innerHTML;
  const topRowLeft = document.getElementById('top-row-left');
  topRowLeft.innerHTML = '<header class="top-categories" id="category-list"></header>';
  const categoryList = document.getElementById('category-list');
  const grid = document.getElementById('series-grid');
  const homePage = container.querySelector('.home-page');

  const searchBar = document.createElement('section');
  searchBar.className = 'home-search-bar';
  searchBar.innerHTML = `
    <form id="global-search-form" class="search-form">
      <input id="global-search" class="global-search" type="search" placeholder="全局搜索：输入漫剧名称" value="${escapeHtml(state.searchQuery)}" />
      <button type="submit" class="primary-btn search-btn">搜索</button>
      <select id="global-sort" class="global-sort" aria-label="排序依据">
        <option value="updated_desc" ${state.sortBy === 'updated_desc' ? 'selected' : ''}>最后更新时间（倒序）</option>
        <option value="updated_asc" ${state.sortBy === 'updated_asc' ? 'selected' : ''}>最后更新时间（顺序）</option>
        <option value="ingested_asc" ${state.sortBy === 'ingested_asc' ? 'selected' : ''}>最早入库时间（顺序）</option>
        <option value="ingested_desc" ${state.sortBy === 'ingested_desc' ? 'selected' : ''}>最早入库时间（倒序）</option>
        <option value="name_asc" ${state.sortBy === 'name_asc' ? 'selected' : ''}>名称（顺序）</option>
        <option value="name_desc" ${state.sortBy === 'name_desc' ? 'selected' : ''}>名称（倒序）</option>
      </select>
    </form>
  `;
  homePage.insertBefore(searchBar, grid);

  const allTags = getAllTags();
  const visibleTags = state.tagExpanded ? allTags : allTags.slice(0, 5);
  const selectedHiddenTag = !state.tagExpanded && state.selectedTag !== null && !visibleTags.includes(state.selectedTag);

  const navItems = [
    { type: 'all', label: '全部' },
    ...visibleTags.map((tag) => ({ type: 'tag', label: tag })),
    { type: 'more', label: state.tagExpanded ? '收起' : '更多' }
  ];

  navItems.forEach((item) => {
    const btn = document.createElement('button');
    const isActive = item.type === 'all'
      ? state.selectedTag === null
      : item.type === 'tag'
        ? state.selectedTag === item.label
        : state.tagExpanded || selectedHiddenTag;

    btn.className = `category-pill ${isActive ? 'active' : ''}`;
    btn.textContent = item.label;

    btn.onclick = () => {
      if (item.type === 'all') {
        state.selectedTag = null;
      } else if (item.type === 'tag') {
        state.selectedTag = item.label;
      } else {
        state.tagExpanded = !state.tagExpanded;
      }
      state.currentPage = 1;
      loadHomeSeries();
    };
    categoryList.appendChild(btn);
  });

  const searchForm = document.getElementById('global-search-form');
  const searchInput = document.getElementById('global-search');
  const sortSelect = document.getElementById('global-sort');
  searchForm.onsubmit = (event) => {
    event.preventDefault();
    state.searchQuery = searchInput.value;
    state.sortBy = sortSelect.value;
    state.currentPage = 1;
    loadHomeSeries();
  };

  sortSelect.onchange = () => {
    state.sortBy = sortSelect.value;
    state.currentPage = 1;
    loadHomeSeries();
  };

  if (state.homeError) {
    grid.innerHTML = `<p class="empty-state">加载失败：${state.homeError}</p>`;
  }

  if (state.homeLoading) {
    grid.innerHTML = '<p class="empty-state">正在加载列表...</p>';
  }

  const totalPages = Math.max(1, Math.ceil(state.homeTotal / state.pageSize));
  const pageSeries = state.homeSeries;

  pageSeries.forEach((series) => {
      const maxEpisode = Math.max(...series.episodes.map((ep) => Number(ep.episode) || 0), 0);
      const totalEpisodes = series.episodes.length;
      const card = document.createElement('article');
      card.className = 'poster-card';
      card.innerHTML = `
        <div class="poster" style="background-image:url('${series.poster}')"></div>
        <p class="poster-title">${escapeHtml(series.name)}</p>
        <p class="poster-meta">最大集数：${maxEpisode}<br>总集数：${totalEpisodes}<br>最后更新时间：<br>${escapeHtml(fmt(series.updatedAt))}<br>入库时间：<br>${escapeHtml(fmt(series.firstIngestedAt))}</p>
      `;
      card.onclick = () => {
        history.pushState({}, '', `/${encodeURIComponent(series.name)}`);
        state.selectedEpisode = series.episodes[0]?.episode ?? null;
        render();
      };
      grid.appendChild(card);
    });

  if (pageSeries.length === 0) {
    grid.innerHTML = '<p class="empty-state">没有匹配的漫剧</p>';
  }

  const buildPageList = () => {
    const pages = new Set([1, totalPages]);
    for (let i = state.currentPage - 2; i <= state.currentPage + 2; i += 1) {
      if (i >= 1 && i <= totalPages) pages.add(i);
    }
    return [...pages].sort((a, b) => a - b);
  };

  const pageItems = buildPageList();
  const pagination = document.createElement('div');
  pagination.className = 'pagination';
  pagination.innerHTML = `
    <button type="button" class="page-btn" data-page="prev" ${state.currentPage === 1 ? 'disabled' : ''}>上一页</button>
    <div class="page-numbers">
      ${pageItems.map((pageNo, idx) => {
        const prev = pageItems[idx - 1];
        const ellipsis = prev && pageNo - prev > 1 ? '<span class="page-ellipsis">…</span>' : '';
        return `${ellipsis}<button type="button" class="page-number-btn ${pageNo === state.currentPage ? 'active' : ''}" data-page-no="${pageNo}">${pageNo}</button>`;
      }).join('')}
    </div>
    <button type="button" class="page-btn" data-page="next" ${state.currentPage === totalPages ? 'disabled' : ''}>下一页</button>
    <span class="page-meta">第 ${state.currentPage} / ${totalPages} 页（共 ${state.homeTotal} 个）</span>
    <form class="page-jump-form" id="page-jump-form">
      <label for="page-jump-input">跳转</label>
      <input id="page-jump-input" type="number" min="1" max="${totalPages}" value="${state.currentPage}" />
      <button type="submit" class="page-jump-btn">确定</button>
    </form>
  `;

  const prevBtn = pagination.querySelector('[data-page="prev"]');
  const nextBtn = pagination.querySelector('[data-page="next"]');
  prevBtn.onclick = () => {
    if (state.currentPage <= 1) return;
    state.currentPage -= 1;
    loadHomeSeries();
  };
  nextBtn.onclick = () => {
    if (state.currentPage >= totalPages) return;
    state.currentPage += 1;
    loadHomeSeries();
  };

  pagination.querySelectorAll('[data-page-no]').forEach((btn) => {
    btn.onclick = () => {
      const pageNo = Number(btn.dataset.pageNo);
      if (!Number.isFinite(pageNo) || pageNo === state.currentPage) return;
      state.currentPage = pageNo;
      loadHomeSeries();
    };
  });

  const jumpForm = pagination.querySelector('#page-jump-form');
  jumpForm.onsubmit = (event) => {
    event.preventDefault();
    const input = jumpForm.querySelector('#page-jump-input');
    const nextPage = Number(input.value);
    if (!Number.isFinite(nextPage)) return;
    const safePage = Math.min(totalPages, Math.max(1, Math.floor(nextPage)));
    if (safePage === state.currentPage) return;
    state.currentPage = safePage;
    loadHomeSeries();
  };

  container.querySelector('.home-page').appendChild(pagination);
}

function renderDetail(container, series) {
  if (series.episodes.length > 0 && !series.episodes.some((ep) => ep.episode === state.selectedEpisode)) {
    state.selectedEpisode = series.episodes[0].episode;
  }

  if (state.detailSeriesName !== series.name) {
    const selectedIndex = series.episodes.findIndex((ep) => ep.episode === state.selectedEpisode);
    state.episodePage = selectedIndex >= 0
      ? Math.floor(selectedIndex / state.episodePageSize) + 1
      : 1;
    state.detailSeriesName = series.name;
  }

  const topRowLeft = document.getElementById('top-row-left');
  topRowLeft.innerHTML = '<button id="back-home" class="back-btn">⬅ 首页</button>';
  container.innerHTML = document.getElementById('detail-template').innerHTML;

  document.getElementById('back-home').onclick = () => {
    history.pushState({}, '', '/');
    loadHomeSeries();
  };

  const episodeRow = document.getElementById('episode-row');
  const totalEpisodePages = Math.max(1, Math.ceil(series.episodes.length / state.episodePageSize));
  state.episodePage = Math.min(totalEpisodePages, Math.max(1, state.episodePage));

  const pageStartIndex = (state.episodePage - 1) * state.episodePageSize;
  const visibleEpisodes = series.episodes.slice(pageStartIndex, pageStartIndex + state.episodePageSize);

  visibleEpisodes.forEach((ep) => {
    const tab = document.createElement('button');
    tab.className = `episode-tab ${state.selectedEpisode === ep.episode ? 'active' : ''}`;
    tab.textContent = `第${ep.episode}集`;
    tab.onclick = () => {
      state.selectedEpisode = ep.episode;
      render();
    };
    episodeRow.appendChild(tab);
  });

  const prevEpisodePageBtn = document.getElementById('episode-prev');
  const nextEpisodePageBtn = document.getElementById('episode-next');
  prevEpisodePageBtn.disabled = state.episodePage <= 1;
  nextEpisodePageBtn.disabled = state.episodePage >= totalEpisodePages;

  prevEpisodePageBtn.onclick = () => {
    if (state.episodePage <= 1) return;
    state.episodePage -= 1;
    render();
  };

  nextEpisodePageBtn.onclick = () => {
    if (state.episodePage >= totalEpisodePages) return;
    state.episodePage += 1;
    render();
  };

  const selected = series.episodes.find((e) => e.episode === state.selectedEpisode) || series.episodes[0];
  const maxEpisode = series.episodes.reduce((max, ep) => Math.max(max, Number(ep.episode) || 0), 0);
  const totalEpisodes = series.episodes.length;
  const player = document.getElementById('player');
  const playerMeta = document.getElementById('player-meta');

  if (!selected) {
    player.removeAttribute('src');
    playerMeta.innerHTML = `
      <p class="player-meta-title">${escapeHtml(series.name)}</p>
      <p class="player-meta-empty">暂无内容</p>
    `;
    return;
  }

  player.src = selected.videoUrl;
  playerMeta.innerHTML = `
    <p class="player-meta-title">${escapeHtml(series.name)}</p>
    <p class="player-meta-time-row">
      <span>首次入库：${escapeHtml(fmt(selected.firstIngestedAt))}</span>
      <span>最近更新：${escapeHtml(fmt(selected.updatedAt))}</span>
    </p>
    <p class="player-meta-url">${escapeHtml(selected.videoUrl)}</p>
  `;
}

function renderAdminPanel(container) {
  if (state.activeAdminTab === 'tag') {
    const tags = getAllTags();
    container.innerHTML = `
      <section class="admin-panel">
        <div class="action-tabs">
          <button type="button" class="action-tab-btn ${state.activeTagAction === 'create' ? 'active' : ''}" data-tag-action="create">新增标签</button>
          <button type="button" class="action-tab-btn ${state.activeTagAction === 'rename' ? 'active' : ''}" data-tag-action="rename">修改标签</button>
          <button type="button" class="action-tab-btn ${state.activeTagAction === 'delete' ? 'active' : ''}" data-tag-action="delete">删除标签</button>
        </div>

        <section class="action-panel ${state.activeTagAction === 'create' ? '' : 'hidden'}">
          <form id="tag-create-form" class="inline-form">
            <input name="tagName" required placeholder="标签名" />
            <button type="submit">新增</button>
          </form>
        </section>

        <section class="action-panel ${state.activeTagAction === 'rename' ? '' : 'hidden'}">
          <form id="tag-rename-form" class="inline-form">
            <select name="tagName" required>
              <option value="">选择标签</option>
              ${tags.map((tag) => `<option value="${tag}">${tag}</option>`).join('')}
            </select>
            <input name="newTagName" required placeholder="新标签名" />
            <button type="submit">修改</button>
          </form>
        </section>

        <section class="action-panel ${state.activeTagAction === 'delete' ? '' : 'hidden'}">
          <form id="tag-delete-form" class="inline-form">
            <select name="tagName" required>
              <option value="">选择标签</option>
              ${tags.map((tag) => `<option value="${tag}">${tag}</option>`).join('')}
            </select>
            <button type="submit">删除</button>
          </form>
        </section>
      </section>
    `;

    document.querySelectorAll('[data-tag-action]').forEach((btn) => {
      btn.onclick = () => {
        state.activeTagAction = btn.dataset.tagAction;
        render();
      };
    });

    const createForm = document.getElementById('tag-create-form');
    if (createForm) {
      createForm.onsubmit = async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const tagName = String(formData.get('tagName') || '').trim();
        try {
          await apiFetch('/api/tags', { method: 'POST', body: JSON.stringify({ tagName }) });
          setFlashMessage(`标签「${tagName}」已创建`);
          await loadSeries();
        } catch (error) {
          setFlashMessage(error.message);
          render();
        }
      };
    }

    const renameForm = document.getElementById('tag-rename-form');
    if (renameForm) {
      const tagSelect = renameForm.elements.namedItem('tagName');
      const newTagInput = renameForm.elements.namedItem('newTagName');

      tagSelect.onchange = () => {
        newTagInput.value = tagSelect.value;
      };

      renameForm.onsubmit = async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const tag = String(formData.get('tagName') || '').trim();
        const newTagName = String(formData.get('newTagName') || '').trim();
        if (!tag || !newTagName || newTagName === tag) return;

        try {
          await apiFetch(`/api/tags/${encodeURIComponent(tag)}`, { method: 'PATCH', body: JSON.stringify({ newTagName }) });
          setFlashMessage('标签改名成功');
          if (state.selectedTag === tag) state.selectedTag = newTagName;
          await loadSeries();
        } catch (error) {
          setFlashMessage(error.message);
          render();
        }
      };
    }

    const deleteForm = document.getElementById('tag-delete-form');
    if (deleteForm) {
      deleteForm.onsubmit = async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const tag = String(formData.get('tagName') || '').trim();
        if (!tag) return;
        if (!confirm(`确认删除标签“${tag}”？会从所有漫剧里移除该标签。`)) return;

        try {
          await apiFetch(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
          setFlashMessage('标签删除成功');
          if (state.selectedTag === tag) state.selectedTag = null;
          await loadSeries();
        } catch (error) {
          setFlashMessage(error.message);
          render();
        }
      };
    }
    return;
  }

  if (state.activeAdminTab === 'title') {
    const tags = getAllTags();
    container.innerHTML = `
      <section class="admin-panel">
        <div class="action-tabs">
          <button type="button" class="action-tab-btn ${state.activeTitleAction === 'create' ? 'active' : ''}" data-title-action="create">新增漫剧</button>
          <button type="button" class="action-tab-btn ${state.activeTitleAction === 'rename' ? 'active' : ''}" data-title-action="rename">修改漫剧</button>
          <button type="button" class="action-tab-btn ${state.activeTitleAction === 'delete' ? 'active' : ''}" data-title-action="delete">删除漫剧</button>
        </div>

        <section class="action-panel ${state.activeTitleAction === 'create' ? '' : 'hidden'}">
          <form id="title-create-form" class="stack-form">
            <input name="name" required placeholder="漫剧名" />
            <input name="poster" required placeholder="海报URL" />
            ${getTagMultiSelectHtml('tags', tags)}
            <p id="title-create-tags-error" class="field-error hidden" role="alert" aria-live="polite"></p>
            <button type="submit">新增</button>
          </form>
        </section>

        <section class="action-panel ${state.activeTitleAction === 'rename' ? '' : 'hidden'}">
          <form id="title-rename-form" class="stack-form">
            <select name="name" required>
              <option value="">选择漫剧</option>
              ${state.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
            </select>
            <input name="newName" required placeholder="漫剧名" />
            <input name="newPoster" required placeholder="海报URL" />
            ${getTagMultiSelectHtml('newTags', tags)}
            <button type="submit">修改</button>
          </form>
        </section>

        <section class="action-panel ${state.activeTitleAction === 'delete' ? '' : 'hidden'}">
          <form id="title-delete-form" class="inline-form">
            <select name="name" required>
              <option value="">选择漫剧</option>
              ${state.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
            </select>
            <button type="submit">删除</button>
          </form>
        </section>
      </section>
    `;

    document.querySelectorAll('[data-title-action]').forEach((btn) => {
      btn.onclick = () => {
        state.activeTitleAction = btn.dataset.titleAction;
        render();
      };
    });

    bindMultiSelectSummary(container);

    const titleCreateForm = document.getElementById('title-create-form');
    if (titleCreateForm) {
      const tagsErrorNode = titleCreateForm.querySelector('#title-create-tags-error');
      titleCreateForm.querySelectorAll('input[name="tags"]').forEach((checkbox) => {
        checkbox.onchange = () => {
          validateTagSelection(titleCreateForm, 'tags', tagsErrorNode, '请至少选择一个标签');
        };
      });

      titleCreateForm.onsubmit = async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const name = String(formData.get('name') || '').trim();
        const poster = String(formData.get('poster') || '').trim();
        const titleTags = formData
          .getAll('tags')
          .map((tag) => String(tag).trim())
          .filter(Boolean);
        if (!validateTagSelection(event.target, 'tags', tagsErrorNode, '请至少选择一个标签')) {
          return;
        }
        try {
          await apiFetch('/api/titles', { method: 'POST', body: JSON.stringify({ name, poster, tags: titleTags }) });
          setFlashMessage(`漫剧「${name}」已创建`);
          await loadSeries();
        } catch (error) {
          setFlashMessage(error.message);
          render();
        }
      };
    }

    const titleRenameForm = document.getElementById('title-rename-form');
    if (titleRenameForm) {
      const titleSelect = titleRenameForm.elements.namedItem('name');
      const newNameInput = titleRenameForm.elements.namedItem('newName');
      const newPosterInput = titleRenameForm.elements.namedItem('newPoster');

      const fillTitleEditFields = (titleName) => {
        const targetSeries = state.allSeries.find((series) => series.name === titleName);
        if (!targetSeries) return;
        newNameInput.value = targetSeries.name;
        newPosterInput.value = targetSeries.poster;
        titleRenameForm.querySelectorAll('input[name="newTags"]').forEach((checkbox) => {
          checkbox.checked = targetSeries.tags.has(checkbox.value);
        });
        bindMultiSelectSummary(titleRenameForm);
      };

      titleSelect.onchange = () => {
        fillTitleEditFields(titleSelect.value);
      };

      fillTitleEditFields(titleSelect.value);

      titleRenameForm.onsubmit = async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const oldName = String(formData.get('name') || '').trim();
        const newName = String(formData.get('newName') || '').trim();
        const newPoster = String(formData.get('newPoster') || '').trim();
        const newTags = formData
          .getAll('newTags')
          .map((tag) => String(tag).trim())
          .filter(Boolean);
        if (!oldName || !newName || !newPoster || newTags.length === 0) return;

        try {
          await apiFetch(`/api/titles/${encodeURIComponent(oldName)}`, { method: 'PATCH', body: JSON.stringify({ newName, poster: newPoster, tags: newTags }) });
          setFlashMessage('漫剧信息修改成功');
          if (currentPathName() === oldName) history.replaceState({}, '', `/${encodeURIComponent(newName)}`);
          await loadSeries();
        } catch (error) {
          setFlashMessage(error.message);
          render();
        }
      };
    }

    const titleDeleteForm = document.getElementById('title-delete-form');
    if (titleDeleteForm) {
      titleDeleteForm.onsubmit = async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const oldName = String(formData.get('name') || '').trim();
        if (!oldName) return;
        if (!confirm(`确认删除漫剧“${oldName}”？该漫剧下全部剧集会删除。`)) return;

        try {
          await apiFetch(`/api/titles/${encodeURIComponent(oldName)}`, { method: 'DELETE' });
          setFlashMessage('漫剧删除成功');
          if (currentPathName() === oldName) history.replaceState({}, '', '/');
          await loadSeries();
        } catch (error) {
          setFlashMessage(error.message);
          render();
        }
      };
    }
    return;
  }

  container.innerHTML = `
    <section class="admin-panel">
      <div class="action-tabs episode-action-tabs">
        <button type="button" class="action-tab-btn ${state.activeEpisodeAction === 'create' ? 'active' : ''}" data-episode-action="create">新增剧集</button>
        <button type="button" class="action-tab-btn ${state.activeEpisodeAction === 'batch' ? 'active' : ''}" data-episode-action="batch">批量导入</button>
        <button type="button" class="action-tab-btn ${state.activeEpisodeAction === 'rename' ? 'active' : ''}" data-episode-action="rename">修改剧集</button>
        <button type="button" class="action-tab-btn ${state.activeEpisodeAction === 'delete' ? 'active' : ''}" data-episode-action="delete">删除剧集</button>
      </div>

      <section class="action-panel ${state.activeEpisodeAction === 'create' ? '' : 'hidden'}">
        <form id="episode-create-form" class="stack-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${state.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
          </select>
          <input type="number" min="1" name="episodeNo" required placeholder="集号" />
          <input name="videoUrl" required placeholder="播放URL" />
          <button type="submit">新增</button>
        </form>
      </section>

      <section class="action-panel ${state.activeEpisodeAction === 'batch' ? '' : 'hidden'}">
        <form id="episode-batch-form" class="stack-form">
          <input name="name" required placeholder="漫剧名" />
          <input name="poster" required placeholder="海报URL" />
          <input name="directoryUrl" required placeholder="视频目录URL，例如 http://localhost:7777/某个目录/" />
          ${getTagMultiSelectHtml('batchTags', getAllTags())}
          <p id="episode-batch-tags-error" class="field-error hidden" role="alert" aria-live="polite"></p>
          <p class="hint">会自动解析目录下视频链接并按文件名中的“第1集/第一集/EP01”等集号排序导入。</p>
          <button type="submit">批量导入</button>
        </form>
      </section>

      <section class="action-panel ${state.activeEpisodeAction === 'rename' ? '' : 'hidden'}">
        <form id="episode-update-form" class="stack-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${state.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
          </select>
          <select name="episodeNo" required>
            <option value="">选择集号</option>
          </select>
          <input type="number" min="1" name="newEpisodeNo" required placeholder="新集号" />
          <input name="videoUrl" required placeholder="新播放URL" />
          <button type="submit">修改</button>
        </form>
      </section>

      <section class="action-panel ${state.activeEpisodeAction === 'delete' ? '' : 'hidden'}">
        <form id="episode-delete-form" class="inline-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${state.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
          </select>
          <select name="episodeNo" required>
            <option value="">选择集号</option>
          </select>
          <button type="submit">删除</button>
        </form>
      </section>
    </section>
  `;

  document.querySelectorAll('[data-episode-action]').forEach((btn) => {
    btn.onclick = () => {
      state.activeEpisodeAction = btn.dataset.episodeAction;
      render();
    };
  });

  bindMultiSelectSummary(container);

  const episodeCreateForm = document.getElementById('episode-create-form');
  if (episodeCreateForm) {
    episodeCreateForm.onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const payload = {
        titleName: String(formData.get('titleName') || '').trim(),
        episodeNo: Number(formData.get('episodeNo')),
        videoUrl: String(formData.get('videoUrl') || '').trim()
      };

      try {
        await apiFetch('/api/episodes', { method: 'POST', body: JSON.stringify(payload) });
        if (currentPathName() === payload.titleName) {
          state.selectedEpisode = payload.episodeNo;
        }
        setFlashMessage('剧集新增成功');
        await loadSeries();
      } catch (error) {
        setFlashMessage(error.message);
        render();
      }
    };
  }


  const episodeBatchForm = document.getElementById('episode-batch-form');
  if (episodeBatchForm) {
    const tagsErrorNode = episodeBatchForm.querySelector('#episode-batch-tags-error');
    episodeBatchForm.querySelectorAll('input[name="batchTags"]').forEach((checkbox) => {
      checkbox.onchange = () => {
        validateTagSelection(episodeBatchForm, 'batchTags', tagsErrorNode, '请至少选择一个标签');
      };
    });

    episodeBatchForm.onsubmit = async (event) => {
      event.preventDefault();
      if (!validateTagSelection(episodeBatchForm, 'batchTags', tagsErrorNode, '请至少选择一个标签')) return;

      const formData = new FormData(event.target);
      const payload = {
        name: String(formData.get('name') || '').trim(),
        poster: String(formData.get('poster') || '').trim(),
        directoryUrl: String(formData.get('directoryUrl') || '').trim(),
        tags: formData.getAll('batchTags').map((item) => String(item).trim()).filter(Boolean)
      };

      try {
        const result = await apiFetch('/api/episodes/batch-directory', { method: 'POST', body: JSON.stringify(payload) });
        const total = result.data?.total ?? 0;
        const inserted = result.data?.inserted ?? 0;
        const updated = result.data?.updated ?? 0;
        setFlashMessage(`批量导入成功：共 ${total} 集，新增 ${inserted} 集，更新 ${updated} 集`);
        if (currentPathName() === payload.name) {
          state.selectedEpisode = 1;
        }
        await loadSeries();
      } catch (error) {
        setFlashMessage(error.message);
        render();
      }
    };
  }

  const episodeUpdateForm = document.getElementById('episode-update-form');
  if (episodeUpdateForm) {
    const titleSelect = episodeUpdateForm.elements.namedItem('titleName');
    const episodeSelect = episodeUpdateForm.elements.namedItem('episodeNo');
    const newEpisodeInput = episodeUpdateForm.elements.namedItem('newEpisodeNo');
    const videoUrlInput = episodeUpdateForm.elements.namedItem('videoUrl');

    const syncEpisodeEditFields = () => {
      const episodes = getEpisodeOptionsByTitle(titleSelect.value);
      const selectedEpisodeNo = Number(episodeSelect.value);
      const targetEpisode = episodes.find((episode) => episode.episode === selectedEpisodeNo);

      if (!targetEpisode) {
        newEpisodeInput.value = '';
        videoUrlInput.value = '';
        return;
      }

      newEpisodeInput.value = String(targetEpisode.episode);
      videoUrlInput.value = targetEpisode.videoUrl;
    };

    const syncEpisodeOptions = () => {
      fillEpisodeSelectByTitle(titleSelect, episodeSelect, '选择集号');
      syncEpisodeEditFields();
    };

    titleSelect.onchange = syncEpisodeOptions;
    episodeSelect.onchange = syncEpisodeEditFields;
    syncEpisodeOptions();

    episodeUpdateForm.onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const payload = {
        titleName: String(formData.get('titleName') || '').trim(),
        episodeNo: Number(formData.get('episodeNo')),
        newEpisodeNo: Number(formData.get('newEpisodeNo')),
        videoUrl: String(formData.get('videoUrl') || '').trim()
      };
      if (!payload.titleName || Number.isNaN(payload.episodeNo) || Number.isNaN(payload.newEpisodeNo)) return;

      try {
        await apiFetch('/api/episodes', { method: 'PATCH', body: JSON.stringify(payload) });
        setFlashMessage('剧集信息修改成功');
        await loadSeries();
      } catch (error) {
        setFlashMessage(error.message);
        render();
      }
    };
  }

  const episodeDeleteForm = document.getElementById('episode-delete-form');
  if (episodeDeleteForm) {
    const titleSelect = episodeDeleteForm.elements.namedItem('titleName');
    const episodeSelect = episodeDeleteForm.elements.namedItem('episodeNo');

    const syncEpisodeOptions = () => {
      fillEpisodeSelectByTitle(titleSelect, episodeSelect, '选择集号');
    };

    titleSelect.onchange = syncEpisodeOptions;
    syncEpisodeOptions();

    episodeDeleteForm.onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const payload = {
        titleName: String(formData.get('titleName') || '').trim(),
        episodeNo: Number(formData.get('episodeNo'))
      };
      if (!payload.titleName || Number.isNaN(payload.episodeNo)) return;
      if (!confirm(`确认删除「${payload.titleName}」第${payload.episodeNo}集？`)) return;

      try {
        await apiFetch('/api/episodes', { method: 'DELETE', body: JSON.stringify(payload) });
        setFlashMessage('剧集删除成功');
        await loadSeries();
      } catch (error) {
        setFlashMessage(error.message);
        render();
      }
    };
  }
}

window.addEventListener('popstate', () => {
  if (currentPathName()) {
    render();
    return;
  }
  loadHomeSeries();
});
render();
loadSeries();
