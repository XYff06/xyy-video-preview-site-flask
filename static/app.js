/**
 * 前端单页应用入口
 *
 * 职责说明:
 * 1) 维护统一的UI状态树(uiState)
 * 2) 通过REST API与后端通信
 * 3) 渲染首页、详情页、管理弹窗并绑定交互事件
 */

/**
 * 统一格式化日期时间字符串
 *
 * @param {string|number|Date} iso - 可被Date解析的时间值
 * @returns {string} 以zh-CN规则输出的24小时制时间文本
 */
const formatDateTimeZhCN = (iso) => new Date(iso).toLocaleString('zh-CN', {hour12: false});

/**
 * 全局页面状态容器
 *
 * 说明: 集中管理首页、详情页与管理弹窗的UI状态，避免散落的全局变量
 */
const uiState = {
    allSeries: [], // 全量漫剧数据(含剧集列表)
    allTags: [], // 标签全集(来自后端/api/tags)
    selectedTag: null, // 首页当前选中的标签，null表示"全部"
    searchQuery: '', // 首页搜索关键字
    sortBy: 'updated_desc', // 首页排序方式
    currentPage: 1, // 首页当前页码
    pageSize: 25, // 首页每页条数
    homeSeries: [], // 当前筛选条件下的首页列表数据
    homeTotal: 0, // 当前筛选条件下的总条数
    homeLoading: false, // 首页列表加载状态
    homeError: null, // 首页列表错误信息
    selectedEpisode: null, // 详情页当前选中的剧集集号
    episodePage: 1, // 详情页剧集标签分页的当前页
    episodePageSize: 10, // 详情页剧集标签分页大小
    detailSeriesName: '', // 当前详情页绑定的漫剧名称
    tagExpanded: false, // 首页标签栏是否展开更多项
    loading: true, // 首屏初始化加载状态
    error: null, // 首屏初始化错误信息
    activeAdminTab: 'tag', // 管理弹窗当前主Tab(tag/title/episode)
    adminModalOpen: false, // 管理弹窗开关状态
    flashMessage: '', // 顶部闪现提示文案
    flashAutoCloseTimeout: null, // 闪现提示自动关闭定时器句柄
    flashVersion: 0, // 闪现提示版本号(用于控制重复计时)
    flashVersionRendered: 0, // 已渲染的闪现提示版本号
    activeTagAction: 'create', // 标签管理子动作(create/rename/delete)
    activeTitleAction: 'create', // 漫剧管理子动作(create/rename/delete)
    activeEpisodeAction: 'create' // 剧集管理子动作(create/batch/rename/delete)
};

/**
 * 读取当前URL Path对应的漫剧名
 *
 * @returns {string} 解码后的Path名称；首页时返回空字符串
 */
function getCurrentRouteSeriesName() {
    return decodeURIComponent(location.pathname.slice(1));
}

/**
 * 发起 JSON API 请求，并统一处理错误响应
 *
 * @param {string} url - 请求地址
 * @param {RequestInit} [options={}] - fetch 配置项
 * @returns {Promise<any>} 解析后的 JSON 数据
 */
async function fetchJsonOrThrow(url, options = {}) {
    const response = await fetch(url, {
        headers: {'Content-Type': 'application/json'}, ...options
    });
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload.message || '请求失败');
    }
    return payload;
}

/**
 * 加载标签全集，供首页筛选与管理表单复用
 */
async function loadTags() {
    const payload = await fetchJsonOrThrow('/api/tags');
    uiState.allTags = payload.data;
}

/**
 * 初始化加载首页基础数据(漫剧 + 标签)，并触发首屏渲染
 */
async function bootstrapInitialSeriesData() {
    // 初始化加载: 拉取漫剧和标签后，完成数据规范化并触发首屏渲染
    try {
        const [seriesPayload] = await Promise.all([fetchJsonOrThrow('/api/series?page=1&pageSize=10000'), loadTags()]);
        uiState.allSeries = seriesPayload.data.map((item) => ({
            ...item, tags: new Set(item.tags), episodes: buildCanonicalEpisodeList(item.episodes || [])
        }));
        uiState.loading = false;
        uiState.error = null;
    } catch (error) {
        uiState.loading = false;
        uiState.error = error.message;
    }

    render();

    if (!getCurrentRouteSeriesName()) {
        await loadHomePageSeriesData();
    }
}

/**
 * 按当前筛选、搜索、排序和分页条件加载首页列表
 */
async function loadHomePageSeriesData() {
    uiState.homeLoading = true;
    uiState.homeError = null;
    render();

    const params = new URLSearchParams();
    params.set('page', String(uiState.currentPage));
    params.set('pageSize', String(uiState.pageSize));
    if (uiState.selectedTag) params.set('tag', uiState.selectedTag);
    if (uiState.searchQuery.trim()) params.set('search', uiState.searchQuery.trim());
    params.set('sort', uiState.sortBy);

    try {
        const payload = await fetchJsonOrThrow(`/api/series?${params.toString()}`);
        uiState.homeSeries = payload.data.map((item) => ({
            ...item, episodes: buildCanonicalEpisodeList(item.episodes || [])
        }));
        uiState.homeTotal = payload.pagination?.total ?? payload.data.length;
        uiState.currentPage = payload.pagination?.page ?? uiState.currentPage;
        uiState.homeLoading = false;
        uiState.homeError = null;
    } catch (error) {
        uiState.homeSeries = [];
        uiState.homeTotal = 0;
        uiState.homeLoading = false;
        uiState.homeError = error.message;
    }

    render();
}

/**
 * 获取标签列表
 * 优先使用后端标签全集，缺失时从漫剧数据反推
 *
 * @returns {string[]} 排序后的标签列表
 */
function collectAvailableTags() {
    /**
     * 如果后端已经单独返回过完整标签列表uiState.allTags，就直接用它
     * [...uiState.allTags]是复制一份数组返回，避免外面改到原始状态
     */
    if (uiState.allTags.length) return [...uiState.allTags];
    /**
     * 如果allTags还没有数据，就从所有漫剧uiState.allSeries里临时推导标签列表
     */
    return [...new Set(uiState.allSeries.flatMap((item) => [...item.tags]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}


/**
 * 转义 HTML 特殊字符，防止字符串注入到模板时破坏 DOM 结构
 *
 * @param {any} value - 待转义的值
 * @returns {string} 安全的 HTML 文本
 */
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 规范化剧集列表: 同一集号仅保留更新时间最新的记录
 *
 * @param {Array<Object>} episodes - 原始剧集列表
 * @returns {Array<Object>} 规范化后并按集号升序的剧集列表
 */
function buildCanonicalEpisodeList(episodes) {
    const latestEpisodeByNumber = new Map();

    episodes.forEach((episode) => {
        const episodeNo = Number(episode.episode);
        if (!Number.isFinite(episodeNo)) return;

        const existingEpisode = latestEpisodeByNumber.get(episodeNo);
        if (!existingEpisode) {
            latestEpisodeByNumber.set(episodeNo, {...episode, episode: episodeNo});
            return;
        }

        const currentUpdatedAt = new Date(existingEpisode.updatedAt || 0).getTime();
        const nextUpdatedAt = new Date(episode.updatedAt || 0).getTime();
        if (nextUpdatedAt >= currentUpdatedAt) {
            latestEpisodeByNumber.set(episodeNo, {...episode, episode: episodeNo});
        }
    });

    return [...latestEpisodeByNumber.values()].sort((a, b) => a.episode - b.episode);
}

/**
 * 根据漫剧名称获取对应的剧集选项
 *
 * @param {string} titleName - 漫剧名称
 * @returns {Array<Object>} 可用于下拉框的剧集列表
 */
function getEpisodeOptionsForSeries(titleName) {
    const matchedSeries = uiState.allSeries.find((series) => series.name === titleName);
    if (!matchedSeries) return [];
    return buildCanonicalEpisodeList(matchedSeries.episodes);
}

/**
 * 渲染标签多选下拉 HTML。
 *
 * @param {string} fieldName - 表单字段名
 * @param {string[]} tags - 可选标签列表
 * @param {string[]} selectedTags - 已选标签
 */
function renderTagMultiSelectHtml(fieldName, tags, selectedTags = []) {
    if (!tags.length) {
        return '<div class="multi-select-empty">暂无可选标签</div>';
    }

    const selected = new Set(selectedTags);
    const selectedText = selected.size ? [...selected].map((tag) => escapeHtml(tag)).join('、') : '选择标签(可多选)';

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

/**
 * 绑定多选组件 summary 文案同步逻辑。
 *
 * @param {ParentNode} scope - 事件委托的作用域容器
 */
function bindMultiSelectSummaryEvents(scope) {
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

/**
 * 根据当前选中的漫剧，刷新集号下拉框。
 */
function fillEpisodeSelectForSeries(titleSelect, episodeSelect, placeholderText) {
    const episodes = getEpisodeOptionsForSeries(titleSelect.value);
    episodeSelect.innerHTML = `<option value="">${placeholderText}</option>${episodes
        .map((episode) => `<option value="${episode.episode}">第${episode.episode}集</option>`)
        .join('')}`;
}

function setFormFieldError(errorNode, message = '') {
    if (!errorNode) return;
    errorNode.textContent = message;
    errorNode.classList.toggle('hidden', !message);
}

function validateMultiTagSelection(form, fieldName, errorNode, message) {
    const checkboxes = [...form.querySelectorAll(`input[name="${fieldName}"]`)];
    if (checkboxes.length === 0) return false;

    const hasSelection = checkboxes.some((checkbox) => checkbox.checked);
    setFormFieldError(errorNode, hasSelection ? '' : message);
    return hasSelection;
}

function renderFlashMessageHtml() {
    if (!uiState.flashMessage) return '';
    return `
    <div class="flash-msg" role="status">
      <span class="flash-text">${uiState.flashMessage}</span>
      <button type="button" class="flash-close" id="flash-close-btn" aria-label="关闭提示">✕</button>
    </div>
  `;
}

function showFlashMessage(message) {
    uiState.flashMessage = message;
    uiState.flashVersion += 1;
}

function hideFlashMessage() {
    uiState.flashMessage = '';
    if (uiState.flashAutoCloseTimeout) {
        clearTimeout(uiState.flashAutoCloseTimeout);
        uiState.flashAutoCloseTimeout = null;
    }
}

function renderAdminModalHtml() {
    if (!uiState.adminModalOpen) return '';
    return `
    <div class="modal-mask" id="admin-modal-mask">
      <section class="admin-modal" role="dialog" aria-modal="true" aria-label="管理">
        <header class="admin-modal-header">
          <h3>管理</h3>
          <button id="close-admin" class="icon-btn" type="button">✕</button>
        </header>
        <div class="admin-modal-tabs">
          <button class="admin-nav-btn ${uiState.activeAdminTab === 'tag' ? 'active' : ''}" data-admin-tab="tag">标签管理</button>
          <button class="admin-nav-btn ${uiState.activeAdminTab === 'title' ? 'active' : ''}" data-admin-tab="title">漫剧管理</button>
          <button class="admin-nav-btn ${uiState.activeAdminTab === 'episode' ? 'active' : ''}" data-admin-tab="episode">内容管理</button>
        </div>
        <section id="admin-content"></section>
      </section>
    </div>
  `;
}

/**
 * 顶层渲染函数：根据 URL 与 uiState 决定渲染首页/详情页及弹窗。
 */
function render() {
    const app = document.getElementById('app');

    if (uiState.loading) {
        app.innerHTML = '<p>正在加载剧集数据...</p>';
        return;
    }

    if (uiState.error) {
        app.innerHTML = `<p>加载失败：${uiState.error}</p>`;
        return;
    }

    app.innerHTML = `
    <section class="layout-shell">
      <aside class="side-rail left-rail">
        <div id="top-row-left"></div>
      </aside>
      <section class="content-shell">
        ${renderFlashMessageHtml()}
        <section id="page-content"></section>
      </section>
      <aside class="side-rail right-rail">
        <button id="open-admin" class="primary-btn manage-btn" type="button">管理</button>
      </aside>
    </section>
    ${renderAdminModalHtml()}
  `;

    document.getElementById('open-admin').onclick = () => {
        uiState.adminModalOpen = true;
        render();
    };

    const flashCloseBtn = document.getElementById('flash-close-btn');
    if (uiState.flashMessage && uiState.flashVersionRendered !== uiState.flashVersion) {
        if (uiState.flashAutoCloseTimeout) {
            clearTimeout(uiState.flashAutoCloseTimeout);
        }
        uiState.flashVersionRendered = uiState.flashVersion;
        uiState.flashAutoCloseTimeout = setTimeout(() => {
            hideFlashMessage();
            render();
        }, 5000);
    }
    if (flashCloseBtn) {
        flashCloseBtn.onclick = () => {
            hideFlashMessage();
            render();
        };
    }

    if (uiState.adminModalOpen) {
        document.getElementById('close-admin').onclick = () => {
            uiState.adminModalOpen = false;
            render();
        };

        document.getElementById('admin-modal-mask').onclick = (event) => {
            if (event.target.id !== 'admin-modal-mask') return;
            uiState.adminModalOpen = false;
            render();
        };

        document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
            btn.onclick = () => {
                uiState.activeAdminTab = btn.dataset.adminTab;
                render();
            };
        });

        renderAdminPanel(document.getElementById('admin-content'));
    }

    const pageContent = document.getElementById('page-content');
    const activeName = getCurrentRouteSeriesName();
    if (activeName) {
        const series = uiState.allSeries.find((s) => s.name === activeName);
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
      <input id="global-search" class="global-search" type="search" placeholder="全局搜索：输入漫剧名称" value="${escapeHtml(uiState.searchQuery)}" />
      <button type="submit" class="primary-btn search-btn">搜索</button>
      <select id="global-sort" class="global-sort" aria-label="排序依据">
        <option value="updated_desc" ${uiState.sortBy === 'updated_desc' ? 'selected' : ''}>最后更新时间(倒序)</option>
        <option value="updated_asc" ${uiState.sortBy === 'updated_asc' ? 'selected' : ''}>最后更新时间(顺序)</option>
        <option value="ingested_asc" ${uiState.sortBy === 'ingested_asc' ? 'selected' : ''}>最早入库时间(顺序)</option>
        <option value="ingested_desc" ${uiState.sortBy === 'ingested_desc' ? 'selected' : ''}>最早入库时间(倒序)</option>
        <option value="name_asc" ${uiState.sortBy === 'name_asc' ? 'selected' : ''}>名称(顺序)</option>
        <option value="name_desc" ${uiState.sortBy === 'name_desc' ? 'selected' : ''}>名称(倒序)</option>
      </select>
    </form>
  `;
    homePage.insertBefore(searchBar, grid);

    const allTags = collectAvailableTags();
    const visibleTags = uiState.tagExpanded ? allTags : allTags.slice(0, 5);
    const selectedHiddenTag = !uiState.tagExpanded && uiState.selectedTag !== null && !visibleTags.includes(uiState.selectedTag);

    const navItems = [{type: 'all', label: '全部'}, ...visibleTags.map((tag) => ({
        type: 'tag', label: tag
    })), {type: 'more', label: uiState.tagExpanded ? '收起' : '更多'}];

    navItems.forEach((item) => {
        const btn = document.createElement('button');
        const isActive = item.type === 'all' ? uiState.selectedTag === null : item.type === 'tag' ? uiState.selectedTag === item.label : uiState.tagExpanded || selectedHiddenTag;

        btn.className = `category-pill ${isActive ? 'active' : ''}`;
        btn.textContent = item.label;

        btn.onclick = () => {
            if (item.type === 'all') {
                uiState.selectedTag = null;
            } else if (item.type === 'tag') {
                uiState.selectedTag = item.label;
            } else {
                uiState.tagExpanded = !uiState.tagExpanded;
            }
            uiState.currentPage = 1;
            loadHomePageSeriesData();
        };
        categoryList.appendChild(btn);
    });

    const searchForm = document.getElementById('global-search-form');
    const searchInput = document.getElementById('global-search');
    const sortSelect = document.getElementById('global-sort');
    searchForm.onsubmit = (event) => {
        event.preventDefault();
        uiState.searchQuery = searchInput.value;
        uiState.sortBy = sortSelect.value;
        uiState.currentPage = 1;
        loadHomePageSeriesData();
    };

    sortSelect.onchange = () => {
        uiState.sortBy = sortSelect.value;
        uiState.currentPage = 1;
        loadHomePageSeriesData();
    };

    if (uiState.homeError) {
        grid.innerHTML = `<p class="empty-uiState">加载失败：${uiState.homeError}</p>`;
    }

    if (uiState.homeLoading) {
        grid.innerHTML = '<p class="empty-uiState">正在加载列表...</p>';
    }

    const totalPages = Math.max(1, Math.ceil(uiState.homeTotal / uiState.pageSize));
    const pageSeries = uiState.homeSeries;

    pageSeries.forEach((series) => {
        const maxEpisode = Math.max(...series.episodes.map((ep) => Number(ep.episode) || 0), 0);
        const totalEpisodes = series.episodes.length;
        const card = document.createElement('article');
        card.className = 'poster-card';
        card.innerHTML = `
        <div class="poster" style="background-image:url('${series.poster}')"></div>
        <p class="poster-title">${escapeHtml(series.name)}</p>
        <p class="poster-meta">最大集数：${maxEpisode}<br>总集数：${totalEpisodes}<br>最后更新时间：<br>${escapeHtml(formatDateTimeZhCN(series.updatedAt))}<br>入库时间：<br>${escapeHtml(formatDateTimeZhCN(series.firstIngestedAt))}</p>
      `;
        card.onclick = () => {
            history.pushState({}, '', `/${encodeURIComponent(series.name)}`);
            uiState.selectedEpisode = series.episodes[0]?.episode ?? null;
            render();
        };
        grid.appendChild(card);
    });

    if (pageSeries.length === 0) {
        grid.innerHTML = '<p class="empty-uiState">没有匹配的漫剧</p>';
    }

    const buildPageList = () => {
        const pages = new Set([1, totalPages]);
        for (let i = uiState.currentPage - 2; i <= uiState.currentPage + 2; i += 1) {
            if (i >= 1 && i <= totalPages) pages.add(i);
        }
        return [...pages].sort((a, b) => a - b);
    };

    const pageItems = buildPageList();
    const pagination = document.createElement('div');
    pagination.className = 'pagination';
    pagination.innerHTML = `
    <button type="button" class="page-btn" data-page="prev" ${uiState.currentPage === 1 ? 'disabled' : ''}>上一页</button>
    <div class="page-numbers">
      ${pageItems.map((pageNo, idx) => {
        const prev = pageItems[idx - 1];
        const ellipsis = prev && pageNo - prev > 1 ? '<span class="page-ellipsis">…</span>' : '';
        return `${ellipsis}<button type="button" class="page-number-btn ${pageNo === uiState.currentPage ? 'active' : ''}" data-page-no="${pageNo}">${pageNo}</button>`;
    }).join('')}
    </div>
    <button type="button" class="page-btn" data-page="next" ${uiState.currentPage === totalPages ? 'disabled' : ''}>下一页</button>
    <span class="page-meta">第 ${uiState.currentPage} / ${totalPages} 页(共 ${uiState.homeTotal} 个)</span>
    <form class="page-jump-form" id="page-jump-form">
      <label for="page-jump-input">跳转</label>
      <input id="page-jump-input" type="number" min="1" max="${totalPages}" value="${uiState.currentPage}" />
      <button type="submit" class="page-jump-btn">确定</button>
    </form>
  `;

    const prevBtn = pagination.querySelector('[data-page="prev"]');
    const nextBtn = pagination.querySelector('[data-page="next"]');
    prevBtn.onclick = () => {
        if (uiState.currentPage <= 1) return;
        uiState.currentPage -= 1;
        loadHomePageSeriesData();
    };
    nextBtn.onclick = () => {
        if (uiState.currentPage >= totalPages) return;
        uiState.currentPage += 1;
        loadHomePageSeriesData();
    };

    pagination.querySelectorAll('[data-page-no]').forEach((btn) => {
        btn.onclick = () => {
            const pageNo = Number(btn.dataset.pageNo);
            if (!Number.isFinite(pageNo) || pageNo === uiState.currentPage) return;
            uiState.currentPage = pageNo;
            loadHomePageSeriesData();
        };
    });

    const jumpForm = pagination.querySelector('#page-jump-form');
    jumpForm.onsubmit = (event) => {
        event.preventDefault();
        const input = jumpForm.querySelector('#page-jump-input');
        const nextPage = Number(input.value);
        if (!Number.isFinite(nextPage)) return;
        const safePage = Math.min(totalPages, Math.max(1, Math.floor(nextPage)));
        if (safePage === uiState.currentPage) return;
        uiState.currentPage = safePage;
        loadHomePageSeriesData();
    };

    container.querySelector('.home-page').appendChild(pagination);
}

/**
 * 渲染详情页（播放器 + 剧集分页切换 + 元数据）。
 */
function renderDetail(container, series) {
    if (series.episodes.length > 0 && !series.episodes.some((ep) => ep.episode === uiState.selectedEpisode)) {
        uiState.selectedEpisode = series.episodes[0].episode;
    }

    if (uiState.detailSeriesName !== series.name) {
        const selectedIndex = series.episodes.findIndex((ep) => ep.episode === uiState.selectedEpisode);
        uiState.episodePage = selectedIndex >= 0 ? Math.floor(selectedIndex / uiState.episodePageSize) + 1 : 1;
        uiState.detailSeriesName = series.name;
    }

    const topRowLeft = document.getElementById('top-row-left');
    topRowLeft.innerHTML = '<button id="back-home" class="back-btn">⬅ 首页</button>';
    container.innerHTML = document.getElementById('detail-template').innerHTML;

    document.getElementById('back-home').onclick = () => {
        history.pushState({}, '', '/');
        loadHomePageSeriesData();
    };

    const episodeRow = document.getElementById('episode-row');
    const totalEpisodePages = Math.max(1, Math.ceil(series.episodes.length / uiState.episodePageSize));
    uiState.episodePage = Math.min(totalEpisodePages, Math.max(1, uiState.episodePage));

    const pageStartIndex = (uiState.episodePage - 1) * uiState.episodePageSize;
    const visibleEpisodes = series.episodes.slice(pageStartIndex, pageStartIndex + uiState.episodePageSize);

    visibleEpisodes.forEach((ep) => {
        const tab = document.createElement('button');
        tab.className = `episode-tab ${uiState.selectedEpisode === ep.episode ? 'active' : ''}`;
        tab.textContent = `第${ep.episode}集`;
        tab.onclick = () => {
            uiState.selectedEpisode = ep.episode;
            render();
        };
        episodeRow.appendChild(tab);
    });

    const prevEpisodePageBtn = document.getElementById('episode-prev');
    const nextEpisodePageBtn = document.getElementById('episode-next');
    prevEpisodePageBtn.disabled = uiState.episodePage <= 1;
    nextEpisodePageBtn.disabled = uiState.episodePage >= totalEpisodePages;

    prevEpisodePageBtn.onclick = () => {
        if (uiState.episodePage <= 1) return;
        uiState.episodePage -= 1;
        render();
    };

    nextEpisodePageBtn.onclick = () => {
        if (uiState.episodePage >= totalEpisodePages) return;
        uiState.episodePage += 1;
        render();
    };

    const selected = series.episodes.find((e) => e.episode === uiState.selectedEpisode) || series.episodes[0];
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
      <span>首次入库：${escapeHtml(formatDateTimeZhCN(selected.firstIngestedAt))}</span>
      <span>最近更新：${escapeHtml(formatDateTimeZhCN(selected.updatedAt))}</span>
    </p>
    <p class="player-meta-url">${escapeHtml(selected.videoUrl)}</p>
  `;
}

/**
 * 渲染管理面板(标签/漫剧/剧集三大管理分区)
 */
function renderAdminPanel(adminPanelContainer) {
    if (uiState.activeAdminTab === 'tag') {
        /**
         * 标签管理页每次渲染时都重新读取当前可用标签，确保表单选项和最新数据一致
         * 这里不缓存，是因为标签可能刚被创建、重命名或删除
         * @type {string[]}
         */
        const availableTags = collectAvailableTags();
        /**
         * 先用innerHTML一次性生成当前子操作页(create/rename/delete)的结构
         * 由于render()会整体重绘管理面板，所以这里采用重绘后重新绑定事件的模式
         */
        adminPanelContainer.innerHTML = `
      <section class="admin-panel">
        <div class="action-tabs">
          <button type="button" class="action-tab-btn ${uiState.activeTagAction === 'create' ? 'active' : ''}" data-tag-action="create">新增标签</button>
          <button type="button" class="action-tab-btn ${uiState.activeTagAction === 'rename' ? 'active' : ''}" data-tag-action="rename">修改标签</button>
          <button type="button" class="action-tab-btn ${uiState.activeTagAction === 'delete' ? 'active' : ''}" data-tag-action="delete">删除标签</button>
        </div>

        <section class="action-panel ${uiState.activeTagAction === 'create' ? '' : 'hidden'}">
          <form id="tag-create-form" class="inline-form">
            <input name="tagName" required placeholder="标签名" />
            <button type="submit">新增</button>
          </form>
        </section>

        <section class="action-panel ${uiState.activeTagAction === 'rename' ? '' : 'hidden'}">
          <form id="tag-rename-form" class="inline-form">
            <select name="tagName" required>
              <option value="">选择标签</option>
              ${availableTags.map((tagName) => `<option value="${tagName}">${tagName}</option>`).join('')}
            </select>
            <input name="newTagName" required placeholder="新标签名" />
            <button type="submit">修改</button>
          </form>
        </section>

        <section class="action-panel ${uiState.activeTagAction === 'delete' ? '' : 'hidden'}">
          <form id="tag-delete-form" class="inline-form">
            <select name="tagName" required>
              <option value="">选择标签</option>
              ${availableTags.map((tagName) => `<option value="${tagName}">${tagName}</option>`).join('')}
            </select>
            <button type="submit">删除</button>
          </form>
        </section>
      </section>
    `;

        // 操作切换按钮只负责切换 uiState，再统一交给 render() 做界面重绘。
        document.querySelectorAll('[data-tag-action]').forEach((actionSwitchButton) => {
            actionSwitchButton.onclick = () => {
                uiState.activeTagAction = actionSwitchButton.dataset.tagAction;
                render();
            };
        });

        const tagCreateForm = document.getElementById('tag-create-form');
        if (tagCreateForm) {
            // 新建标签:
            // 1. 阻止表单默认提交
            // 2. 从表单提取标签名并清洗空白
            // 3. 调用后端创建接口
            // 4. 创建成功后重新拉取基础数据，让筛选区、表单选项、列表状态全部同步
            tagCreateForm.onsubmit = async (submitEvent) => {
                submitEvent.preventDefault();
                const submittedFormData = new FormData(submitEvent.target);
                const createdTagName = String(submittedFormData.get('tagName') || '').trim();
                try {
                    await fetchJsonOrThrow('/api/tags', {
                        method: 'POST', body: JSON.stringify({tagName: createdTagName})
                    });
                    showFlashMessage(`标签「${createdTagName}」已创建`);
                    await bootstrapInitialSeriesData();
                } catch (error) {
                    showFlashMessage(error.message);
                    render();
                }
            };
        }

        const tagRenameForm = document.getElementById('tag-rename-form');
        if (tagRenameForm) {
            const currentTagSelect = tagRenameForm.elements.namedItem('tagName');
            const renamedTagInput = tagRenameForm.elements.namedItem('newTagName');

            // 选中旧标签后，默认把新标签输入框预填为旧值。
            // 这样用户只需要在原名字基础上微调，不用手动再输入一遍。
            currentTagSelect.onchange = () => {
                renamedTagInput.value = currentTagSelect.value;
            };

            // 重命名标签:
            // - 旧标签为空不提交
            // - 新标签为空不提交
            // - 新旧名称一致不提交，避免无意义请求
            tagRenameForm.onsubmit = async (submitEvent) => {
                submitEvent.preventDefault();
                const submittedFormData = new FormData(submitEvent.target);
                const originalTagName = String(submittedFormData.get('tagName') || '').trim();
                const updatedTagName = String(submittedFormData.get('newTagName') || '').trim();
                if (!originalTagName || !updatedTagName || updatedTagName === originalTagName) return;

                try {
                    await fetchJsonOrThrow(`/api/tags/${encodeURIComponent(originalTagName)}`, {
                        method: 'PATCH', body: JSON.stringify({newTagName: updatedTagName})
                    });
                    showFlashMessage('标签改名成功');
                    // 如果首页当前正筛选的是旧标签，这里要同步切到新标签名，
                    // 否则刷新后会出现“筛选值已不存在”的状态不一致问题。
                    if (uiState.selectedTag === originalTagName) uiState.selectedTag = updatedTagName;
                    await bootstrapInitialSeriesData();
                } catch (error) {
                    showFlashMessage(error.message);
                    render();
                }
            };
        }

        const tagDeleteForm = document.getElementById('tag-delete-form');
        if (tagDeleteForm) {
            // 删除标签前先做两层保护:
            // 1. 没选标签直接返回
            // 2. 弹出 confirm 二次确认，避免误删
            tagDeleteForm.onsubmit = async (submitEvent) => {
                submitEvent.preventDefault();
                const submittedFormData = new FormData(submitEvent.target);
                const deletedTagName = String(submittedFormData.get('tagName') || '').trim();
                if (!deletedTagName) return;
                if (!confirm(`确认删除标签"${deletedTagName}"？会从所有漫剧里移除该标签`)) return;

                try {
                    await fetchJsonOrThrow(`/api/tags/${encodeURIComponent(deletedTagName)}`, {method: 'DELETE'});
                    showFlashMessage('标签删除成功');
                    // 被删标签如果正处于首页筛选中，需要清空筛选条件。
                    if (uiState.selectedTag === deletedTagName) uiState.selectedTag = null;
                    await bootstrapInitialSeriesData();
                } catch (error) {
                    showFlashMessage(error.message);
                    render();
                }
            };
        }
        return;
    }

    if (uiState.activeAdminTab === 'title') {
        const tags = collectAvailableTags();
        adminPanelContainer.innerHTML = `
      <section class="admin-panel">
        <div class="action-tabs">
          <button type="button" class="action-tab-btn ${uiState.activeTitleAction === 'create' ? 'active' : ''}" data-title-action="create">新增漫剧</button>
          <button type="button" class="action-tab-btn ${uiState.activeTitleAction === 'rename' ? 'active' : ''}" data-title-action="rename">修改漫剧</button>
          <button type="button" class="action-tab-btn ${uiState.activeTitleAction === 'delete' ? 'active' : ''}" data-title-action="delete">删除漫剧</button>
        </div>

        <section class="action-panel ${uiState.activeTitleAction === 'create' ? '' : 'hidden'}">
          <form id="title-create-form" class="stack-form">
            <input name="name" required placeholder="漫剧名" />
            <input name="poster" required placeholder="海报资源地址: 支持https://...或服务端本地绝对路径" />
            ${renderTagMultiSelectHtml('tags', tags)}
            <p id="title-create-tags-error" class="field-error hidden" role="alert" aria-live="polite"></p>
            <button type="submit">新增</button>
          </form>
        </section>

        <section class="action-panel ${uiState.activeTitleAction === 'rename' ? '' : 'hidden'}">
          <form id="title-rename-form" class="stack-form">
            <select name="name" required>
              <option value="">选择漫剧</option>
              ${uiState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
            </select>
            <input name="newName" required placeholder="漫剧名" />
            <input name="newPoster" required placeholder="海报资源地址: 支持https://...或服务端本地绝对路径" />
            ${renderTagMultiSelectHtml('newTags', tags)}
            <button type="submit">修改</button>
          </form>
        </section>

        <section class="action-panel ${uiState.activeTitleAction === 'delete' ? '' : 'hidden'}">
          <form id="title-delete-form" class="inline-form">
            <select name="name" required>
              <option value="">选择漫剧</option>
              ${uiState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
            </select>
            <button type="submit">删除</button>
          </form>
        </section>
      </section>
    `;

        document.querySelectorAll('[data-title-action]').forEach((btn) => {
            btn.onclick = () => {
                uiState.activeTitleAction = btn.dataset.titleAction;
                render();
            };
        });

        bindMultiSelectSummaryEvents(adminPanelContainer);

        const titleCreateForm = document.getElementById('title-create-form');
        if (titleCreateForm) {
            const tagsErrorNode = titleCreateForm.querySelector('#title-create-tags-error');
            titleCreateForm.querySelectorAll('input[name="tags"]').forEach((checkbox) => {
                checkbox.onchange = () => {
                    validateMultiTagSelection(titleCreateForm, 'tags', tagsErrorNode, '请至少选择一个标签');
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
                if (!validateMultiTagSelection(event.target, 'tags', tagsErrorNode, '请至少选择一个标签')) {
                    return;
                }
                try {
                    await fetchJsonOrThrow('/api/titles', {
                        method: 'POST', body: JSON.stringify({name, poster, tags: titleTags})
                    });
                    showFlashMessage(`漫剧「${name}」已创建`);
                    await bootstrapInitialSeriesData();
                } catch (error) {
                    showFlashMessage(error.message);
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
                const targetSeries = uiState.allSeries.find((series) => series.name === titleName);
                if (!targetSeries) return;
                newNameInput.value = targetSeries.name;
                newPosterInput.value = targetSeries.poster;
                titleRenameForm.querySelectorAll('input[name="newTags"]').forEach((checkbox) => {
                    checkbox.checked = targetSeries.tags.has(checkbox.value);
                });
                bindMultiSelectSummaryEvents(titleRenameForm);
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
                    await fetchJsonOrThrow(`/api/titles/${encodeURIComponent(oldName)}`, {
                        method: 'PATCH', body: JSON.stringify({newName, poster: newPoster, tags: newTags})
                    });
                    showFlashMessage('漫剧信息修改成功');
                    if (getCurrentRouteSeriesName() === oldName) history.replaceState({}, '', `/${encodeURIComponent(newName)}`);
                    await bootstrapInitialSeriesData();
                } catch (error) {
                    showFlashMessage(error.message);
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
                if (!confirm(`确认删除漫剧"${oldName}"？该漫剧下全部剧集会删除`)) return;

                try {
                    await fetchJsonOrThrow(`/api/titles/${encodeURIComponent(oldName)}`, {method: 'DELETE'});
                    showFlashMessage('漫剧删除成功');
                    if (getCurrentRouteSeriesName() === oldName) history.replaceState({}, '', '/');
                    await bootstrapInitialSeriesData();
                } catch (error) {
                    showFlashMessage(error.message);
                    render();
                }
            };
        }
        return;
    }

    adminPanelContainer.innerHTML = `
    <section class="admin-panel">
      <div class="action-tabs episode-action-tabs">
        <button type="button" class="action-tab-btn ${uiState.activeEpisodeAction === 'create' ? 'active' : ''}" data-episode-action="create">新增剧集</button>
        <button type="button" class="action-tab-btn ${uiState.activeEpisodeAction === 'batch' ? 'active' : ''}" data-episode-action="batch">批量导入</button>
        <button type="button" class="action-tab-btn ${uiState.activeEpisodeAction === 'rename' ? 'active' : ''}" data-episode-action="rename">修改剧集</button>
        <button type="button" class="action-tab-btn ${uiState.activeEpisodeAction === 'delete' ? 'active' : ''}" data-episode-action="delete">删除剧集</button>
      </div>

      <section class="action-panel ${uiState.activeEpisodeAction === 'create' ? '' : 'hidden'}">
        <form id="episode-create-form" class="stack-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${uiState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
          </select>
          <input type="number" min="1" name="episodeNo" required placeholder="集号" />
          <input name="videoUrl" required placeholder="播放资源地址: 支持https://...或服务端本地绝对路径" />
          <button type="submit">新增</button>
        </form>
      </section>

      <section class="action-panel ${uiState.activeEpisodeAction === 'batch' ? '' : 'hidden'}">
        <form id="episode-batch-form" class="stack-form">
          <input name="name" required placeholder="漫剧名" />
          <input name="poster" required placeholder="海报资源地址: 支持https://...或服务端本地绝对路径" />
          <input name="directoryUrl" required placeholder="视频目录资源地址: 支持https://...或服务端本地绝对路径" />
          ${renderTagMultiSelectHtml('batchTags', collectAvailableTags())}
          <p id="episode-batch-tags-error" class="field-error hidden" role="alert" aria-live="polite"></p>
          <p class="hint">会自动解析目录下视频链接并按文件名中的"第1集/第一集/EP01"等集号排序导入</p>
          <button type="submit">批量导入</button>
        </form>
      </section>

      <section class="action-panel ${uiState.activeEpisodeAction === 'rename' ? '' : 'hidden'}">
        <form id="episode-update-form" class="stack-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${uiState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
          </select>
          <select name="episodeNo" required>
            <option value="">选择集号</option>
          </select>
          <input type="number" min="1" name="newEpisodeNo" required placeholder="新集号" />
          <input name="videoUrl" required placeholder="新资源地址: 支持https://...或服务端本地绝对路径" />
          <button type="submit">修改</button>
        </form>
      </section>

      <section class="action-panel ${uiState.activeEpisodeAction === 'delete' ? '' : 'hidden'}">
        <form id="episode-delete-form" class="inline-form">
          <select name="titleName" required>
            <option value="">选择漫剧</option>
            ${uiState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
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
            uiState.activeEpisodeAction = btn.dataset.episodeAction;
            render();
        };
    });

    bindMultiSelectSummaryEvents(adminPanelContainer);

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
                await fetchJsonOrThrow('/api/episodes', {method: 'POST', body: JSON.stringify(payload)});
                if (getCurrentRouteSeriesName() === payload.titleName) {
                    uiState.selectedEpisode = payload.episodeNo;
                }
                showFlashMessage('剧集新增成功');
                await bootstrapInitialSeriesData();
            } catch (error) {
                showFlashMessage(error.message);
                render();
            }
        };
    }


    const episodeBatchForm = document.getElementById('episode-batch-form');
    if (episodeBatchForm) {
        const tagsErrorNode = episodeBatchForm.querySelector('#episode-batch-tags-error');
        episodeBatchForm.querySelectorAll('input[name="batchTags"]').forEach((checkbox) => {
            checkbox.onchange = () => {
                validateMultiTagSelection(episodeBatchForm, 'batchTags', tagsErrorNode, '请至少选择一个标签');
            };
        });

        episodeBatchForm.onsubmit = async (event) => {
            event.preventDefault();
            if (!validateMultiTagSelection(episodeBatchForm, 'batchTags', tagsErrorNode, '请至少选择一个标签')) return;

            const formData = new FormData(event.target);
            const payload = {
                name: String(formData.get('name') || '').trim(),
                poster: String(formData.get('poster') || '').trim(),
                directoryUrl: String(formData.get('directoryUrl') || '').trim(),
                tags: formData.getAll('batchTags').map((item) => String(item).trim()).filter(Boolean)
            };

            try {
                const result = await fetchJsonOrThrow('/api/episodes/batch-directory', {
                    method: 'POST', body: JSON.stringify(payload)
                });
                const total = result.data?.total ?? 0;
                const inserted = result.data?.inserted ?? 0;
                const updated = result.data?.updated ?? 0;
                showFlashMessage(`批量导入成功：共 ${total} 集，新增 ${inserted} 集，更新 ${updated} 集`);
                if (getCurrentRouteSeriesName() === payload.name) {
                    uiState.selectedEpisode = 1;
                }
                await bootstrapInitialSeriesData();
            } catch (error) {
                showFlashMessage(error.message);
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
            const episodes = getEpisodeOptionsForSeries(titleSelect.value);
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
            fillEpisodeSelectForSeries(titleSelect, episodeSelect, '选择集号');
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
                await fetchJsonOrThrow('/api/episodes', {method: 'PATCH', body: JSON.stringify(payload)});
                showFlashMessage('剧集信息修改成功');
                await bootstrapInitialSeriesData();
            } catch (error) {
                showFlashMessage(error.message);
                render();
            }
        };
    }

    const episodeDeleteForm = document.getElementById('episode-delete-form');
    if (episodeDeleteForm) {
        const titleSelect = episodeDeleteForm.elements.namedItem('titleName');
        const episodeSelect = episodeDeleteForm.elements.namedItem('episodeNo');

        const syncEpisodeOptions = () => {
            fillEpisodeSelectForSeries(titleSelect, episodeSelect, '选择集号');
        };

        titleSelect.onchange = syncEpisodeOptions;
        syncEpisodeOptions();

        episodeDeleteForm.onsubmit = async (event) => {
            event.preventDefault();
            const formData = new FormData(event.target);
            const payload = {
                titleName: String(formData.get('titleName') || '').trim(), episodeNo: Number(formData.get('episodeNo'))
            };
            if (!payload.titleName || Number.isNaN(payload.episodeNo)) return;
            if (!confirm(`确认删除「${payload.titleName}」第${payload.episodeNo}集？`)) return;

            try {
                await fetchJsonOrThrow('/api/episodes', {method: 'DELETE', body: JSON.stringify(payload)});
                showFlashMessage('剧集删除成功');
                await bootstrapInitialSeriesData();
            } catch (error) {
                showFlashMessage(error.message);
                render();
            }
        };
    }
}

window.addEventListener('popstate', () => {
    if (getCurrentRouteSeriesName()) {
        render();
        return;
    }
    loadHomePageSeriesData();
});
render();
bootstrapInitialSeriesData();
