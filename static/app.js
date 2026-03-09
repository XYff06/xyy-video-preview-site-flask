// 统一的时间格式化方法：用于首页卡片、详情页元信息等所有时间展示。
const formatDateTime = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

// 全局页面状态容器：集中管理首页、详情页和管理弹窗的 UI 状态。
const appState = {
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

function getCurrentPathName() {
  return decodeURIComponent(location.pathname.slice(1));
}

async function requestJsonApi(url, options = {}) {
  // 统一处理 JSON 请求与错误抛出，避免每个请求都重复判断 response.ok。
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
  const payload = await requestJsonApi('/api/tags');
  appState.allTags = payload.data;
}

async function loadSeries() {
  // 初始化加载：拉取漫剧和标签后，完成数据规范化并触发首屏渲染。
  try {
    const [seriesPayload] = await Promise.all([
      requestJsonApi('/api/series?page=1&pageSize=10000'),
      loadTags()
    ]);
    appState.allSeries = seriesPayload.data.map((item) => ({
      ...item,
      tags: new Set(item.tags),
      episodes: normalizeEpisodes(item.episodes || [])
    }));
    appState.loading = false;
    appState.error = null;
  } catch (error) {
    appState.loading = false;
    appState.error = error.message;
  }

  render();

  if (!getCurrentPathName()) {
    await loadHomeSeries();
  }
}

async function loadHomeSeries() {
  // 首页列表加载：根据筛选、搜索、排序与分页参数刷新当前列表。
  appState.homeLoading = true;
  appState.homeError = null;
  render();

  const params = new URLSearchParams();
  params.set('page', String(appState.currentPage));
  params.set('pageSize', String(appState.pageSize));
  if (appState.selectedTag) params.set('tag', appState.selectedTag);
  if (appState.searchQuery.trim()) params.set('search', appState.searchQuery.trim());
  params.set('sort', appState.sortBy);

  try {
    const payload = await requestJsonApi(`/api/series?${params.toString()}`);
    appState.homeSeries = payload.data.map((item) => ({
      ...item,
      episodes: normalizeEpisodes(item.episodes || [])
    }));
    appState.homeTotal = payload.pagination?.total ?? payload.data.length;
    appState.currentPage = payload.pagination?.page ?? appState.currentPage;
    appState.homeLoading = false;
    appState.homeError = null;
  } catch (error) {
    appState.homeSeries = [];
    appState.homeTotal = 0;
    appState.homeLoading = false;
    appState.homeError = error.message;
  }

  render();
}

function getAllTags() {
  if (appState.allTags.length) return [...appState.allTags];
  return [...new Set(appState.allSeries.flatMap((item) => [...item.tags]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
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
  const target = appState.allSeries.find((series) => series.name === titleName);
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
  if (!appState.flashMessage) return '';
  return `
    <div class="flash-msg" role="status">
      <span class="flash-text">${appState.flashMessage}</span>
      <button type="button" class="flash-close" id="flash-close-btn" aria-label="关闭提示">✕</button>
    </div>
  `;
}

function setFlashMessage(message) {
  appState.flashMessage = message;
  appState.flashVersion += 1;
}

function clearFlashMessage() {
  appState.flashMessage = '';
  if (appState.flashAutoCloseTimeout) {
    clearTimeout(appState.flashAutoCloseTimeout);
    appState.flashAutoCloseTimeout = null;
  }
}

function getAdminModalHtml() {
  if (!appState.adminModalOpen) return '';
  return `
    <div class="modal-mask" id="admin-modal-mask">
      <section class="admin-modal" role="dialog" aria-modal="true" aria-label="管理">
        <header class="admin-modal-header">
          <h3>管理</h3>
          <button id="close-admin" class="icon-btn" type="button">✕</button>
        </header>
        <div class="admin-modal-tabs">
          <button class="admin-nav-btn ${appState.activeAdminTab === 'tag' ? 'active' : ''}" data-admin-tab="tag">标签管理</button>
          <button class="admin-nav-btn ${appState.activeAdminTab === 'title' ? 'active' : ''}" data-admin-tab="title">漫剧管理</button>
          <button class="admin-nav-btn ${appState.activeAdminTab === 'episode' ? 'active' : ''}" data-admin-tab="episode">内容管理</button>
        </div>
        <section id="admin-content"></section>
      </section>
    </div>
  `;
}

function render() {
  const app = document.getElementById('app');

  if (appState.loading) {
    app.innerHTML = '<p>正在加载剧集数据...</p>';
    return;
  }

  if (appState.error) {
    app.innerHTML = `<p>加载失败：${appState.error}</p>`;
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
    appState.adminModalOpen = true;
    render();
  };

  const flashCloseBtn = document.getElementById('flash-close-btn');
  if (appState.flashMessage && appState.flashVersionRendered !== appState.flashVersion) {
    if (appState.flashAutoCloseTimeout) {
      clearTimeout(appState.flashAutoCloseTimeout);
    }
    appState.flashVersionRendered = appState.flashVersion;
    appState.flashAutoCloseTimeout = setTimeout(() => {
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

  if (appState.adminModalOpen) {
    document.getElementById('close-admin').onclick = () => {
      appState.adminModalOpen = false;
      render();
    };

    document.getElementById('admin-modal-mask').onclick = (event) => {
      if (event.target.id !== 'admin-modal-mask') return;
      appState.adminModalOpen = false;
      render();
    };

    document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
      btn.onclick = () => {
        appState.activeAdminTab = btn.dataset.adminTab;
        render();
      };
    });

    renderAdminPanel(document.getElementById('admin-content'));
  }

  const pageContent = document.getElementById('page-content');
  const activeName = getCurrentPathName();
  if (activeName) {
    const series = appState.allSeries.find((s) => s.name === activeName);
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
      <input id="global-search" class="global-search" type="search" placeholder="全局搜索：输入漫剧名称" value="${escapeHtml(appState.searchQuery)}" />
      <button type="submit" class="primary-btn search-btn">搜索</button>
      <select id="global-sort" class="global-sort" aria-label="排序依据">
        <option value="updated_desc" ${appState.sortBy === 'updated_desc' ? 'selected' : ''}>最后更新时间（倒序）</option>
        <option value="updated_asc" ${appState.sortBy === 'updated_asc' ? 'selected' : ''}>最后更新时间（顺序）</option>
        <option value="ingested_asc" ${appState.sortBy === 'ingested_asc' ? 'selected' : ''}>最早入库时间（顺序）</option>
        <option value="ingested_desc" ${appState.sortBy === 'ingested_desc' ? 'selected' : ''}>最早入库时间（倒序）</option>
        <option value="name_asc" ${appState.sortBy === 'name_asc' ? 'selected' : ''}>名称（顺序）</option>
        <option value="name_desc" ${appState.sortBy === 'name_desc' ? 'selected' : ''}>名称（倒序）</option>
      </select>
    </form>
  `;
  homePage.insertBefore(searchBar, grid);

  const allTags = getAllTags();
  const visibleTags = appState.tagExpanded ? allTags : allTags.slice(0, 5);
  const selectedHiddenTag = !appState.tagExpanded && appState.selectedTag !== null && !visibleTags.includes(appState.selectedTag);

  const navItems = [
    { type: 'all', label: '全部' },
    ...visibleTags.map((tag) => ({ type: 'tag', label: tag })),
    { type: 'more', label: appState.tagExpanded ? '收起' : '更多' }
  ];

  navItems.forEach((item) => {
    const btn = document.createElement('button');
    const isActive = item.type === 'all'
      ? appState.selectedTag === null
      : item.type === 'tag'
        ? appState.selectedTag === item.label
        : appState.tagExpanded || selectedHiddenTag;

    btn.className = `category-pill ${isActive ? 'active' : ''}`;
    btn.textContent = item.label;

    btn.onclick = () => {
      if (item.type === 'all') {
        appState.selectedTag = null;
      } else if (item.type === 'tag') {
        appState.selectedTag = item.label;
      } else {
        appState.tagExpanded = !appState.tagExpanded;
      }
      appState.currentPage = 1;
      loadHomeSeries();
    };
    categoryList.appendChild(btn);
  });

  const searchForm = document.getElementById('global-search-form');
  const searchInput = document.getElementById('global-search');
  const sortSelect = document.getElementById('global-sort');
  searchForm.onsubmit = (event) => {
    event.preventDefault();
    appState.searchQuery = searchInput.value;
    appState.sortBy = sortSelect.value;
    appState.currentPage = 1;
    loadHomeSeries();
  };

  sortSelect.onchange = () => {
    appState.sortBy = sortSelect.value;
    appState.currentPage = 1;
    loadHomeSeries();
  };

  if (appState.homeError) {
    grid.innerHTML = `<p class="empty-appState">加载失败：${appState.homeError}</p>`;
  }

  if (appState.homeLoading) {
    grid.innerHTML = '<p class="empty-appState">正在加载列表...</p>';
  }

  const totalPages = Math.max(1, Math.ceil(appState.homeTotal / appState.pageSize));
  const pageSeries = appState.homeSeries;

  pageSeries.forEach((series) => {
      const maxEpisode = Math.max(...series.episodes.map((ep) => Number(ep.episode) || 0), 0);
      const totalEpisodes = series.episodes.length;
      const card = document.createElement('article');
      card.className = 'poster-card';
      card.innerHTML = `
        <div class="poster" style="background-image:url('${series.poster}')"></div>
        <p class="poster-title">${escapeHtml(series.name)}</p>
        <p class="poster-meta">最大集数：${maxEpisode}<br>总集数：${totalEpisodes}<br>最后更新时间：<br>${escapeHtml(formatDateTime(series.updatedAt))}<br>入库时间：<br>${escapeHtml(formatDateTime(series.firstIngestedAt))}</p>
      `;
      card.onclick = () => {
        history.pushState({}, '', `/${encodeURIComponent(series.name)}`);
        appState.selectedEpisode = series.episodes[0]?.episode ?? null;
        render();
      };
      grid.appendChild(card);
    });

  if (pageSeries.length === 0) {
    grid.innerHTML = '<p class="empty-appState">没有匹配的漫剧</p>';
  }

  const buildPageList = () => {
    const pages = new Set([1, totalPages]);
    for (let i = appState.currentPage - 2; i <= appState.currentPage + 2; i += 1) {
      if (i >= 1 && i <= totalPages) pages.add(i);
    }
    return [...pages].sort((a, b) => a - b);
  };

  const pageItems = buildPageList();
  const pagination = document.createElement('div');
  pagination.className = 'pagination';
  pagination.innerHTML = `
    <button type="button" class="page-btn" data-page="prev" ${appState.currentPage === 1 ? 'disabled' : ''}>上一页</button>
    <div class="page-numbers">
      ${pageItems.map((pageNo, idx) => {
        const prev = pageItems[idx - 1];
        const ellipsis = prev && pageNo - prev > 1 ? '<span class="page-ellipsis">…</span>' : '';
        return `${ellipsis}<button type="button" class="page-number-btn ${pageNo === appState.currentPage ? 'active' : ''}" data-page-no="${pageNo}">${pageNo}</button>`;
      }).join('')}
    </div>
    <button type="button" class="page-btn" data-page="next" ${appState.currentPage === totalPages ? 'disabled' : ''}>下一页</button>
    <span class="page-meta">第 ${appState.currentPage} / ${totalPages} 页（共 ${appState.homeTotal} 个）</span>
    <form class="page-jump-form" id="page-jump-form">
      <label for="page-jump-input">跳转</label>
      <input id="page-jump-input" type="number" min="1" max="${totalPages}" value="${appState.currentPage}" />
      <button type="submit" class="page-jump-btn">确定</button>
    </form>
  `;

  const prevBtn = pagination.querySelector('[data-page="prev"]');
  const nextBtn = pagination.querySelector('[data-page="next"]');
  prevBtn.onclick = () => {
    if (appState.currentPage <= 1) return;
    appState.currentPage -= 1;
    loadHomeSeries();
  };
  nextBtn.onclick = () => {
    if (appState.currentPage >= totalPages) return;
    appState.currentPage += 1;
    loadHomeSeries();
  };

  pagination.querySelectorAll('[data-page-no]').forEach((btn) => {
    btn.onclick = () => {
      const pageNo = Number(btn.dataset.pageNo);
      if (!Number.isFinite(pageNo) || pageNo === appState.currentPage) return;
      appState.currentPage = pageNo;
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
    if (safePage === appState.currentPage) return;
    appState.currentPage = safePage;
    loadHomeSeries();
  };

  container.querySelector('.home-page').appendChild(pagination);
}

function renderDetail(container, series) {
  if (series.episodes.length > 0 && !series.episodes.some((ep) => ep.episode === appState.selectedEpisode)) {
    appState.selectedEpisode = series.episodes[0].episode;
  }

  if (appState.detailSeriesName !== series.name) {
    const selectedIndex = series.episodes.findIndex((ep) => ep.episode === appState.selectedEpisode);
    appState.episodePage = selectedIndex >= 0
      ? Math.floor(selectedIndex / appState.episodePageSize) + 1
      : 1;
    appState.detailSeriesName = series.name;
  }

  const topRowLeft = document.getElementById('top-row-left');
  topRowLeft.innerHTML = '<button id="back-home" class="back-btn">⬅ 首页</button>';
  container.innerHTML = document.getElementById('detail-template').innerHTML;

  document.getElementById('back-home').onclick = () => {
    history.pushState({}, '', '/');
    loadHomeSeries();
  };

  const episodeRow = document.getElementById('episode-row');
  const totalEpisodePages = Math.max(1, Math.ceil(series.episodes.length / appState.episodePageSize));
  appState.episodePage = Math.min(totalEpisodePages, Math.max(1, appState.episodePage));

  const pageStartIndex = (appState.episodePage - 1) * appState.episodePageSize;
  const visibleEpisodes = series.episodes.slice(pageStartIndex, pageStartIndex + appState.episodePageSize);

  visibleEpisodes.forEach((ep) => {
    const tab = document.createElement('button');
    tab.className = `episode-tab ${appState.selectedEpisode === ep.episode ? 'active' : ''}`;
    tab.textContent = `第${ep.episode}集`;
    tab.onclick = () => {
      appState.selectedEpisode = ep.episode;
      render();
    };
    episodeRow.appendChild(tab);
  });

  const prevEpisodePageBtn = document.getElementById('episode-prev');
  const nextEpisodePageBtn = document.getElementById('episode-next');
  prevEpisodePageBtn.disabled = appState.episodePage <= 1;
  nextEpisodePageBtn.disabled = appState.episodePage >= totalEpisodePages;

  prevEpisodePageBtn.onclick = () => {
    if (appState.episodePage <= 1) return;
    appState.episodePage -= 1;
    render();
  };

  nextEpisodePageBtn.onclick = () => {
    if (appState.episodePage >= totalEpisodePages) return;
    appState.episodePage += 1;
    render();
  };

  const selected = series.episodes.find((e) => e.episode === appState.selectedEpisode) || series.episodes[0];
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
      <span>首次入库：${escapeHtml(formatDateTime(selected.firstIngestedAt))}</span>
      <span>最近更新：${escapeHtml(formatDateTime(selected.updatedAt))}</span>
    </p>
    <p class="player-meta-url">${escapeHtml(selected.videoUrl)}</p>
  `;
}

function renderAdminPanel(container) {
  if (appState.activeAdminTab === 'tag') {
    const tags = getAllTags();
    container.innerHTML = `
      <section class="admin-panel">
        <div class="action-tabs">
          <button type="button" class="action-tab-btn ${appState.activeTagAction === 'create' ? 'active' : ''}" data-tag-action="create">新增标签</button>
          <button type="button" class="action-tab-btn ${appState.activeTagAction === 'rename' ? 'active' : ''}" data-tag-action="rename">修改标签</button>
          <button type="button" class="action-tab-btn ${appState.activeTagAction === 'delete' ? 'active' : ''}" data-tag-action="delete">删除标签</button>
        </div>

        <section class="action-panel ${appState.activeTagAction === 'create' ? '' : 'hidden'}">
          <form id="tag-create-form" class="inline-form">
            <input name="tagName" required placeholder="标签名" />
            <button type="submit">新增</button>
          </form>
        </section>

        <section class="action-panel ${appState.activeTagAction === 'rename' ? '' : 'hidden'}">
          <form id="tag-rename-form" class="inline-form">
            <select name="tagName" required>
              <option value="">选择标签</option>
              ${tags.map((tag) => `<option value="${tag}">${tag}</option>`).join('')}
            </select>
            <input name="newTagName" required placeholder="新标签名" />
            <button type="submit">修改</button>
          </form>
        </section>

        <section class="action-panel ${appState.activeTagAction === 'delete' ? '' : 'hidden'}">
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
        appState.activeTagAction = btn.dataset.tagAction;
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
          await requestJsonApi('/api/tags', { method: 'POST', body: JSON.stringify({ tagName }) });
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
          await requestJsonApi(`/api/tags/${encodeURIComponent(tag)}`, { method: 'PATCH', body: JSON.stringify({ newTagName }) });
          setFlashMessage('标签改名成功');
          if (appState.selectedTag === tag) appState.selectedTag = newTagName;
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
          await requestJsonApi(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
          setFlashMessage('标签删除成功');
          if (appState.selectedTag === tag) appState.selectedTag = null;
          await loadSeries();
        } catch (error) {
          setFlashMessage(error.message);
          render();
        }
      };
    }
    return;
  }

  if (appState.activeAdminTab === 'title') {
    const tags = getAllTags();
    container.innerHTML = `
      <section class="admin-panel">
        <div class="action-tabs">
          <button type="button" class="action-tab-btn ${appState.activeTitleAction === 'create' ? 'active' : ''}" data-title-action="create">新增漫剧</button>
          <button type="button" class="action-tab-btn ${appState.activeTitleAction === 'rename' ? 'active' : ''}" data-title-action="rename">修改漫剧</button>
          <button type="button" class="action-tab-btn ${appState.activeTitleAction === 'delete' ? 'active' : ''}" data-title-action="delete">删除漫剧</button>
        </div>

        <section class="action-panel ${appState.activeTitleAction === 'create' ? '' : 'hidden'}">
          <form id="title-create-form" class="stack-form">
            <input name="name" required placeholder="漫剧名" />
            <input name="poster" required placeholder="海报URL" />
            ${getTagMultiSelectHtml('tags', tags)}
            <p id="title-create-tags-error" class="field-error hidden" role="alert" aria-live="polite"></p>
            <button type="submit">新增</button>
          </form>
        </section>

        <section class="action-panel ${appState.activeTitleAction === 'rename' ? '' : 'hidden'}">
          <form id="title-rename-form" class="stack-form">
            <select name="name" required>
              <option value="">选择漫剧</option>
              ${appState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
            </select>
            <input name="newName" required placeholder="漫剧名" />
            <input name="newPoster" required placeholder="海报URL" />
            ${getTagMultiSelectHtml('newTags', tags)}
            <button type="submit">修改</button>
          </form>
        </section>

        <section class="action-panel ${appState.activeTitleAction === 'delete' ? '' : 'hidden'}">
          <form id="title-delete-form" class="inline-form">
            <select name="name" required>
              <option value="">选择漫剧</option>
              ${appState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
            </select>
            <button type="submit">删除</button>
          </form>
        </section>
      </section>
    `;

    document.querySelectorAll('[data-title-action]').forEach((btn) => {
      btn.onclick = () => {
        appState.activeTitleAction = btn.dataset.titleAction;
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
          await requestJsonApi('/api/titles', { method: 'POST', body: JSON.stringify({ name, poster, tags: titleTags }) });
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
        const targetSeries = appState.allSeries.find((series) => series.name === titleName);
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
          await requestJsonApi(`/api/titles/${encodeURIComponent(oldName)}`, { method: 'PATCH', body: JSON.stringify({ newName, poster: newPoster, tags: newTags }) });
          setFlashMessage('漫剧信息修改成功');
          if (getCurrentPathName() === oldName) history.replaceState({}, '', `/${encodeURIComponent(newName)}`);
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
          await requestJsonApi(`/api/titles/${encodeURIComponent(oldName)}`, { method: 'DELETE' });
          setFlashMessage('漫剧删除成功');
          if (getCurrentPathName() === oldName) history.replaceState({}, '', '/');
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
        <button type="button" class="action-tab-btn ${appState.activeEpisodeAction === 'create' ? 'active' : ''}" data-episode-action="create">新增剧集</button>
        <button type="button" class="action-tab-btn ${appState.activeEpisodeAction === 'batch' ? 'active' : ''}" data-episode-action="batch">批量导入</button>
        <button type="button" class="action-tab-btn ${appState.activeEpisodeAction === 'rename' ? 'active' : ''}" data-episode-action="rename">修改剧集</button>
        <button type="button" class="action-tab-btn ${appState.activeEpisodeAction === 'delete' ? 'active' : ''}" data-episode-action="delete">删除剧集</button>
      </div>

      <section class="action-panel ${appState.activeEpisodeAction === 'create' ? '' : 'hidden'}">
        <form id="episode-create-form" class="stack-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${appState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
          </select>
          <input type="number" min="1" name="episodeNo" required placeholder="集号" />
          <input name="videoUrl" required placeholder="播放URL" />
          <button type="submit">新增</button>
        </form>
      </section>

      <section class="action-panel ${appState.activeEpisodeAction === 'batch' ? '' : 'hidden'}">
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

      <section class="action-panel ${appState.activeEpisodeAction === 'rename' ? '' : 'hidden'}">
        <form id="episode-update-form" class="stack-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${appState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
          </select>
          <select name="episodeNo" required>
            <option value="">选择集号</option>
          </select>
          <input type="number" min="1" name="newEpisodeNo" required placeholder="新集号" />
          <input name="videoUrl" required placeholder="新播放URL" />
          <button type="submit">修改</button>
        </form>
      </section>

      <section class="action-panel ${appState.activeEpisodeAction === 'delete' ? '' : 'hidden'}">
        <form id="episode-delete-form" class="inline-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${appState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
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
      appState.activeEpisodeAction = btn.dataset.episodeAction;
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
        await requestJsonApi('/api/episodes', { method: 'POST', body: JSON.stringify(payload) });
        if (getCurrentPathName() === payload.titleName) {
          appState.selectedEpisode = payload.episodeNo;
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
        const result = await requestJsonApi('/api/episodes/batch-directory', { method: 'POST', body: JSON.stringify(payload) });
        const total = result.data?.total ?? 0;
        const inserted = result.data?.inserted ?? 0;
        const updated = result.data?.updated ?? 0;
        setFlashMessage(`批量导入成功：共 ${total} 集，新增 ${inserted} 集，更新 ${updated} 集`);
        if (getCurrentPathName() === payload.name) {
          appState.selectedEpisode = 1;
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
        await requestJsonApi('/api/episodes', { method: 'PATCH', body: JSON.stringify(payload) });
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
        await requestJsonApi('/api/episodes', { method: 'DELETE', body: JSON.stringify(payload) });
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
  if (getCurrentPathName()) {
    render();
    return;
  }
  loadHomeSeries();
});
render();
loadSeries();
