/**
 * 前端单页应用入口
 *
 * 负责维护统一状态
 * 负责和后端 API 通信
 * 负责渲染首页 详情页和管理弹窗
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
 * 首页 详情页和管理弹窗的状态都集中存放在这里
 * 渲染函数只读取 uiState 决定当前页面应该显示什么
 */
const uiState = {
    allSeries: [], // 全量漫剧数据 这里保留完整剧集列表
    allTags: [], // 标签全集 优先使用后端独立返回的数据
    selectedTag: null, // 首页当前选中的标签 null 表示全部
    searchQuery: '', // 首页搜索关键字
    sortBy: 'updated_desc', // 首页排序方式
    currentPage: 1, // 首页当前页码
    pageSize: 25, // 首页每页条数
    homeSeries: [], // 当前筛选条件下的首页结果
    homeTotal: 0, // 当前筛选条件下的总条数
    homeLoading: false, // 首页分页结果是否正在加载
    homeError: null, // 首页分页结果的错误信息
    selectedEpisode: null, // 详情页当前选中的集号
    episodePage: 1, // 详情页剧集分页的当前页
    episodePageSize: 10, // 详情页每页展示多少个剧集按钮
    activeDetailSeriesName: '', // 当前详情页正在展示的漫剧名称
    tagExpanded: false, // 首页标签栏是否展开更多项
    loading: true, // 首屏基础数据是否还在加载
    error: null, // 首屏基础数据加载失败时的错误信息
    activeAdminTab: 'tag', // 管理弹窗当前主分区
    adminModalOpen: false, // 管理弹窗是否打开
    flashMessage: '', // 顶部闪现提示文案
    flashAutoCloseTimeout: null, // 闪现提示自动关闭定时器句柄
    flashVersion: 0, // 闪现提示版本号 用来区分是不是新提示
    renderedFlashVersion: 0, // 当前界面已经处理过的提示版本号
    activeTagAction: 'create', // 标签管理当前子操作
    activeTitleAdminAction: 'create', // 漫剧管理当前子操作
    activeEpisodeAdminAction: 'create' // 剧集管理当前子操作
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
 * 发起JSON API请求，并统一处理错误响应
 *
 * @param {string} requestUrl - 请求地址
 * @param {RequestInit} [requestOptions={}] - fetch配置项
 * @returns {Promise<any>} 解析后的JSON数据
 */
async function requestJsonApiOrThrow(requestUrl, requestOptions = {}) {
    const httpResponse = await fetch(requestUrl, {headers: {'Content-Type': 'application/json'}, ...requestOptions});
    const responseJson = await httpResponse.json();
    if (!httpResponse.ok) {
        throw new Error(responseJson.message || '请求失败');
    }
    return responseJson;
}

/**
 * 刷新漫剧和标签基础数据
 *
 * 成功后会更新 uiState 并重新渲染
 * 如果当前在首页 还会继续补拉首页自己的分页结果
 */
async function reloadBaseDataAndRender() {
    try {
        /**
         * 并发拉取漫剧列表和标签列表
         * 两份数据都返回后再一起写入状态
         * 这样页面不会出现只更新一半的中间态
         */
        const [seriesListResponse, tagListResponse] = await Promise.all([requestJsonApiOrThrow('/api/series?page=1&pageSize=10000'), requestJsonApiOrThrow('/api/tags')]);
        uiState.allTags = tagListResponse.data;
        /**
         * 这里会把后端返回的数据再做一次前端侧归一化
         * tags 转成 Set 便于后面快速判断是否包含某个标签
         * episodes 交给 normalizeEpisodeRecords 统一去重 排序和集号格式
         */
        uiState.allSeries = seriesListResponse.data.map((seriesRecord) => ({
            ...seriesRecord,
            tags: new Set(seriesRecord.tags),
            episodes: normalizeEpisodeRecords(seriesRecord.episodes || [])
        }));

        /**
         * 基础数据刷新成功后
         * 关闭全局 loading 状态并清空旧错误
         */
        uiState.loading = false;
        uiState.error = null;
    } catch (error) {
        /**
         * 任意一个请求失败都会进入这里
         * render 会根据 uiState.error 渲染失败提示
         */
        uiState.loading = false;
        uiState.error = error.message;
    }
    /**
     * 无论成功还是失败都先走一次 render
     * 这样当前界面会立即反映新的全局状态
     */
    render();

    /**
     * 首页展示列表使用的是另一套带分页的查询结果
     * 所以首页场景还需要继续补拉一次首页专用数据
     */
    if (!getCurrentRouteSeriesName()) {
        await loadHomeSeriesPageData();
    }
}

/**
 * 按当前筛选条件加载首页列表
 *
 * 这一步只更新首页列表相关状态
 * 不会覆盖前面拉回来的全量基础数据
 */
async function loadHomeSeriesPageData() {
    uiState.homeLoading = true;
    uiState.homeError = null;
    render();

    // 只把当前真正生效的筛选条件写进查询参数
    // 这样可以避免发送无意义的空字段
    const params = new URLSearchParams();
    params.set('page', String(uiState.currentPage));
    params.set('pageSize', String(uiState.pageSize));
    if (uiState.selectedTag) params.set('tag', uiState.selectedTag);
    if (uiState.searchQuery.trim()) params.set('search', uiState.searchQuery.trim());
    params.set('sort', uiState.sortBy);

    try {
        const payload = await requestJsonApiOrThrow(`/api/series?${params.toString()}`);
        uiState.homeSeries = payload.data.map((item) => ({
            ...item, episodes: normalizeEpisodeRecords(item.episodes || [])
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
 * 获取当前可用的标签列表
 *
 * 优先使用后端独立返回的标签全集
 * 缺失时再从漫剧数据里反推
 *
 * @returns {string[]} 排序后的标签列表
 */
function collectAvailableTags() {
    /**
     * 如果 uiState.allTags 已经有值就直接使用
     * 这里复制一份数组返回 避免外部直接改写原始状态
     */
    if (uiState.allTags.length) return [...uiState.allTags];
    /**
     * 兜底场景会从全部漫剧里临时推导标签列表
     * flatMap 会先把每个漫剧里的标签展开
     * 外层 Set 再把重复标签去掉
     */
    return [...new Set(uiState.allSeries.flatMap((item) => [...item.tags]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}


/**
 * 转义HTML特殊字符，防止字符串注入到模板时破坏DOM结构
 *
 * @param {any} value - 待转义的值
 * @returns {string} 安全的HTML文本
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
 * 规范化剧集列表
 *
 * @param {Array<Object>} episodes - 原始剧集列表
 * @returns {Array<Object>} 同一集号只保留最新记录 并按集号升序返回
 */
function normalizeEpisodeRecords(episodes) {
    /**
     * 先用 Map 暂存 集号 => 剧集记录
     * 遍历过程中如果遇到同一集号的多条记录
     * 就比较 updatedAt 只保留更新的一条
     */
    const latestEpisodeByNumber = new Map();

    episodes.forEach((episode) => {
        // 后端返回的 episode 可能是字符串也可能是数字
        // 这里先统一转成 Number 再参与比较
        const episodeNo = Number(episode.episode);

        // 无法识别成有效集号的记录直接跳过
        // 避免污染后续排序和选择逻辑
        if (!Number.isFinite(episodeNo)) return;

        const existingEpisode = latestEpisodeByNumber.get(episodeNo);
        if (!existingEpisode) {
            // 第一次遇到某个集号时直接保存
            // 同时把 episode 字段规范成数值型
            latestEpisodeByNumber.set(episodeNo, {...episode, episode: episodeNo});
            return;
        }

        // 同一集号出现多条记录时
        // 保留 updatedAt 更晚的那一条
        const currentUpdatedAt = new Date(existingEpisode.updatedAt || 0).getTime();
        const nextUpdatedAt = new Date(episode.updatedAt || 0).getTime();
        if (nextUpdatedAt >= currentUpdatedAt) {
            latestEpisodeByNumber.set(episodeNo, {...episode, episode: episodeNo});
        }
    });

    // 最后把 Map 转回数组并按集号升序返回给渲染层
    return [...latestEpisodeByNumber.values()].sort((a, b) => a.episode - b.episode);
}

/**
 * 根据漫剧名称获取对应的剧集选项
 *
 * @param {string} titleName - 漫剧名称
 * @returns {Array<Object>} 可用于下拉框的剧集列表
 */
function getSeriesEpisodeOptions(titleName) {
    const matchedSeries = uiState.allSeries.find((series) => series.name === titleName);
    if (!matchedSeries) return [];
    return normalizeEpisodeRecords(matchedSeries.episodes);
}

/**
 * 渲染标签多选下拉 HTML
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
    // 这里会先把已选标签转成安全文本
    // 然后再拼成 summary 里展示的文案
    const selectedText = selected.size ? [...selected].map((tag) => escapeHtml(tag)).join('、') : '选择标签(可多选)';
    return `
<details class="multi-select" data-multi-select>
    <summary class="multi-select-summary" data-multi-summary>${selectedText}</summary>
    <div class="multi-select-list">
        ${tags.map((tag) => `<label class="multi-select-item"><input type="checkbox" name="${fieldName}" value="${escapeHtml(tag)}" ${selected.has(tag) ? 'checked' : ''}/><span>${escapeHtml(tag)}</span></label>`).join('')}
    </div>
</details>
    `;
}

/**
 * 绑定多选组件 summary 文案同步逻辑
 *
 * @param {ParentNode} scope - 事件委托的作用域容器
 */
function bindMultiSelectSummaryHandlers(scope) {
    scope.querySelectorAll('[data-multi-select]').forEach((multiSelect) => {
        const summary = multiSelect.querySelector('[data-multi-summary]');
        if (!summary) return;

        const updateSummary = () => {
            // 这段链式调用会先收集所有已选 checkbox
            // 再映射成标签值数组 最后拼成 summary 文案
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
 * 根据当前选中的漫剧刷新集号下拉框
 */
function populateEpisodeSelectForSeries(titleSelect, episodeSelect, placeholderText) {
    const episodes = getSeriesEpisodeOptions(titleSelect.value);
    // map 会把每个剧集对象转换成 option 字符串
    // join 后再一次性写回下拉框
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
    <div class="flash-message" role="status">
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
 * 顶层渲染函数
 *
 * 根据当前 URL 和 uiState 决定要渲染首页 详情页和管理弹窗
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
        <button id="open-admin" class="primary-button manage-button" type="button">管理</button>
      </aside>
    </section>
    ${renderAdminModalHtml()}
  `;

    document.getElementById('open-admin').onclick = () => {
        uiState.adminModalOpen = true;
        render();
    };

    const flashCloseBtn = document.getElementById('flash-close-btn');
    if (uiState.flashMessage && uiState.renderedFlashVersion !== uiState.flashVersion) {
        if (uiState.flashAutoCloseTimeout) {
            clearTimeout(uiState.flashAutoCloseTimeout);
        }
        uiState.renderedFlashVersion = uiState.flashVersion;
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
    topRowLeft.innerHTML = '<header class="categories" id="category-list"></header>';
    const categoryList = document.getElementById('category-list');
    const grid = document.getElementById('series-grid');
    const homePage = container.querySelector('.home-page');

    const searchBar = document.createElement('section');
    searchBar.className = 'home-toolbar';
    searchBar.innerHTML = `
    <form id="global-search-form" class="toolbar">
      <input id="global-search" class="global-search" type="search" placeholder="全局搜索：输入漫剧名称" value="${escapeHtml(uiState.searchQuery)}" />
        <button type="submit" class="primary-button search-btn">搜索</button>
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
            loadHomeSeriesPageData();
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
        loadHomeSeriesPageData();
    };

    sortSelect.onchange = () => {
        uiState.sortBy = sortSelect.value;
        uiState.currentPage = 1;
        loadHomeSeriesPageData();
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
        loadHomeSeriesPageData();
    };
    nextBtn.onclick = () => {
        if (uiState.currentPage >= totalPages) return;
        uiState.currentPage += 1;
        loadHomeSeriesPageData();
    };

    pagination.querySelectorAll('[data-page-no]').forEach((btn) => {
        btn.onclick = () => {
            const pageNo = Number(btn.dataset.pageNo);
            if (!Number.isFinite(pageNo) || pageNo === uiState.currentPage) return;
            uiState.currentPage = pageNo;
            loadHomeSeriesPageData();
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
        loadHomeSeriesPageData();
    };

    container.querySelector('.home-page').appendChild(pagination);
}

/**
 * 渲染详情页
 *
 * 会同时处理播放器 剧集分页切换和元信息区域
 */
function renderDetail(container, series) {
    // 当前选中的剧集如果已经不在数据里
    // 就退回到第一集
    if (series.episodes.length > 0 && !series.episodes.some((ep) => ep.episode === uiState.selectedEpisode)) {
        uiState.selectedEpisode = series.episodes[0].episode;
    }

    // 切换到新的详情页时
    // 根据当前选中集号把详情页分页同步到正确位置
    if (uiState.activeDetailSeriesName !== series.name) {
        const selectedIndex = series.episodes.findIndex((ep) => ep.episode === uiState.selectedEpisode);
        uiState.episodePage = selectedIndex >= 0 ? Math.floor(selectedIndex / uiState.episodePageSize) + 1 : 1;
        uiState.activeDetailSeriesName = series.name;
    }

    const topRowLeft = document.getElementById('top-row-left');
    topRowLeft.innerHTML = '<button id="back-home" class="back-btn">⬅ 首页</button>';
    container.innerHTML = document.getElementById('detail-template').innerHTML;

    document.getElementById('back-home').onclick = () => {
        history.pushState({}, '', '/');
        loadHomeSeriesPageData();
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

    const prevEpisodePageBtn = document.getElementById('episode-previous');
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

    // find 会先尝试匹配当前选中的剧集
    // 找不到时再退回到第一集
    const selected = series.episodes.find((e) => e.episode === uiState.selectedEpisode) || series.episodes[0];
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
 * 渲染管理面板
 *
 * 根据当前主分区切换标签 漫剧和剧集三块管理界面
 */
function renderAdminPanel(adminPanelContainer) {
    if (uiState.activeAdminTab === 'tag') {
        /**
         * 标签管理页每次渲染时都重新读取可用标签
         * 这样新建 重命名 删除后表单选项会立即同步
         * @type {string[]}
         */
        const availableTags = collectAvailableTags();
        /**
         * 先用 innerHTML 一次性生成当前子操作页结构
         * render 会整体重绘管理面板
         * 所以这里统一采用重绘后重新绑定事件的方式
         */
        adminPanelContainer.innerHTML = `
<section class="admin-panel">
    <div class="action-tabs">
        <button type="button" class="admin-action-tab-button ${uiState.activeTagAction === 'create' ? 'active' : ''}"data-tag-action="create">新增标签</button>
        <button type="button" class="admin-action-tab-button ${uiState.activeTagAction === 'rename' ? 'active' : ''}"data-tag-action="rename">修改标签</button>
        <button type="button" class="admin-action-tab-button ${uiState.activeTagAction === 'delete' ? 'active' : ''}"data-tag-action="delete">删除标签</button>
    </div>

    <section class="action-panel ${uiState.activeTagAction === 'create' ? '' : 'hidden'}">
        <form id="tag-create-form" class="inline-form">
            <input name="tagName" required placeholder="标签名"/>
            <button type="submit">新增</button>
        </form>
    </section>

    <section class="action-panel ${uiState.activeTagAction === 'rename' ? '' : 'hidden'}">
        <form id="tag-rename-form" class="inline-form">
            <select name="tagName" required>
                <option value="">选择标签</option>
                ${availableTags.map((tagName) => `<option value="${tagName}">${tagName}</option>`).join('')}
            </select>
            <input name="newTagName" required placeholder="新标签名"/>
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
        /**
         * 操作切换按钮只负责切换 uiState
         * 界面重绘统一交给 render 处理
         */
        document.querySelectorAll('[data-tag-action]').forEach((actionSwitchButton) => {
            actionSwitchButton.onclick = () => {
                uiState.activeTagAction = actionSwitchButton.dataset.tagAction;
                render();
            };
        });

        const tagCreateForm = document.getElementById('tag-create-form');
        if (tagCreateForm) {
            /**
             * 新建标签流程
             * 先阻止默认提交 再提取并清洗表单数据
             * 创建成功后重新拉取基础数据 让筛选区和表单选项一起同步
             * @param submitEvent
             * @returns {Promise<void>}
             */
            tagCreateForm.onsubmit = async (submitEvent) => {
                submitEvent.preventDefault();
                const submittedFormData = new FormData(submitEvent.target);
                const createdTagName = String(submittedFormData.get('tagName') || '').trim();
                try {
                    await requestJsonApiOrThrow('/api/tags', {
                        method: 'POST', body: JSON.stringify({tagName: createdTagName})
                    });
                    showFlashMessage(`标签[${createdTagName}]已创建`);
                    await reloadBaseDataAndRender();
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

            // 选中旧标签后会把新标签输入框预填为旧值
            // 这样用户只需要在原名字基础上微调
            currentTagSelect.onchange = () => {
                renamedTagInput.value = currentTagSelect.value;
            };

            // 重命名标签前会先拦掉无效输入
            // 包括旧值为空 新值为空 和新旧值相同这三种情况
            tagRenameForm.onsubmit = async (submitEvent) => {
                submitEvent.preventDefault();
                const submittedFormData = new FormData(submitEvent.target);
                const originalTagName = String(submittedFormData.get('tagName') || '').trim();
                const updatedTagName = String(submittedFormData.get('newTagName') || '').trim();
                if (!originalTagName || !updatedTagName || updatedTagName === originalTagName) return;

                try {
                    await requestJsonApiOrThrow(`/api/tags/${encodeURIComponent(originalTagName)}`, {
                        method: 'PATCH', body: JSON.stringify({newTagName: updatedTagName})
                    });
                    showFlashMessage('标签改名成功');
                    // 如果首页当前正筛选的是旧标签
                    // 这里要同步切到新标签名 避免刷新后筛选状态失效
                    if (uiState.selectedTag === originalTagName) uiState.selectedTag = updatedTagName;
                    await reloadBaseDataAndRender();
                } catch (error) {
                    showFlashMessage(error.message);
                    render();
                }
            };
        }

        const tagDeleteForm = document.getElementById('tag-delete-form');
        if (tagDeleteForm) {
            // 删除标签前先做两层保护
            // 没选标签不提交 用户确认后才真正发请求
            tagDeleteForm.onsubmit = async (submitEvent) => {
                submitEvent.preventDefault();
                const submittedFormData = new FormData(submitEvent.target);
                const deletedTagName = String(submittedFormData.get('tagName') || '').trim();
                if (!deletedTagName) return;
                if (!confirm(`确认删除标签"${deletedTagName}"？会从所有漫剧里移除该标签`)) return;

                try {
                    await requestJsonApiOrThrow(`/api/tags/${encodeURIComponent(deletedTagName)}`, {method: 'DELETE'});
                    showFlashMessage('标签删除成功');
                    // 被删标签如果正处于首页筛选中
                    // 这里要把筛选条件一起清空
                    if (uiState.selectedTag === deletedTagName) uiState.selectedTag = null;
                    await reloadBaseDataAndRender();
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
        <button type="button" class="admin-action-tab-button ${uiState.activeTitleAdminAction === 'create' ? 'active' : ''}"data-title-action="create">新增漫剧</button>
        <button type="button" class="admin-action-tab-button ${uiState.activeTitleAdminAction === 'rename' ? 'active' : ''}"data-title-action="rename">修改漫剧</button>
        <button type="button" class="admin-action-tab-button ${uiState.activeTitleAdminAction === 'delete' ? 'active' : ''}"data-title-action="delete">删除漫剧</button>
    </div>
    <section class="action-panel ${uiState.activeTitleAdminAction === 'create' ? '' : 'hidden'}">
        <form id="title-create-form" class="stack-form">
            <input name="name" required placeholder="漫剧名"/>
            <input name="poster" required placeholder="海报资源地址: 支持https://...或服务端本地绝对路径"/>
            ${renderTagMultiSelectHtml('tags', tags)}
            <p id="title-create-tags-error" class="field-error hidden" role="alert" aria-live="polite"></p>
            <button type="submit">新增</button>
        </form>
    </section>

    <section class="action-panel ${uiState.activeTitleAdminAction === 'rename' ? '' : 'hidden'}">
        <form id="title-rename-form" class="stack-form">
            <select name="name" required>
                <option value="">选择漫剧</option>
                ${uiState.allSeries.map((series) => `<option value="${series.name}">${series.name}</option>`).join('')}
            </select>
            <input name="newName" required placeholder="新漫剧名"/>
            <input name="newPoster" required placeholder="新海报资源地址: 支持https://...或服务端本地绝对路径"/>
            ${renderTagMultiSelectHtml('newTags', tags)}
            <button type="submit">修改</button>
        </form>
    </section>

    <section class="action-panel ${uiState.activeTitleAdminAction === 'delete' ? '' : 'hidden'}">
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

        /**
         * 子操作标签只负责切换当前状态
         * 具体界面仍然交给 render 重新绘制
         */
        document.querySelectorAll('[data-title-action]').forEach((actionTabButton) => {
            actionTabButton.onclick = () => {
                uiState.activeTitleAdminAction = actionTabButton.dataset.titleAction;
                render();
            };
        });

        // 绑定多选下拉框的 summary 交互
        // 这样展开收起和选中后的文案才能保持同步
        bindMultiSelectSummaryHandlers(adminPanelContainer);

        const titleCreateForm = document.getElementById('title-create-form');
        if (titleCreateForm) {
            // 这个节点专门显示 标签至少选一个 这类错误信息
            const tagsValidationMessageNode = titleCreateForm.querySelector('#title-create-tags-error');

            // 只要标签勾选状态变化 就立即重新校验并更新提示
            titleCreateForm.querySelectorAll('input[name="tags"]').forEach((tagCheckbox) => {
                tagCheckbox.onchange = () => {
                    validateMultiTagSelection(titleCreateForm, 'tags', tagsValidationMessageNode, '请至少选择一个标签');
                };
            });

            // 新增漫剧时会先提取并清洗表单输入
            // 校验通过后再把名称 海报和标签一起发给后端
            titleCreateForm.onsubmit = async (submitEvent) => {
                submitEvent.preventDefault();

                // 从当前表单中提取并清洗用户输入的数据
                const submittedFormData = new FormData(submitEvent.target);
                const titleName = String(submittedFormData.get('name') || '').trim();
                const poster = String(submittedFormData.get('poster') || '').trim();

                // getAll 会先取出同名 checkbox 的全部值
                // 后面的 map 和 filter 再负责裁剪空白并过滤空字符串
                const selectedTagNames = submittedFormData.getAll('tags').map((tagName) => String(tagName).trim()).filter(Boolean);

                // 提交前再做一次兜底校验，防止用户未选择标签直接提交
                if (!validateMultiTagSelection(submitEvent.target, 'tags', tagsValidationMessageNode, '请至少选择一个标签')) {
                    return;
                }
                try {
                    // 后端会用这组数据创建漫剧并写入标签关联
                    await requestJsonApiOrThrow('/api/titles', {
                        method: 'POST', body: JSON.stringify({name: titleName, poster: poster, tags: selectedTagNames})
                    });
                    showFlashMessage(`漫剧[${titleName}]已创建`);
                    await reloadBaseDataAndRender();
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
                // 选中某个漫剧后
                // 把它当前的名称 海报和标签回填到编辑表单
                const targetSeries = uiState.allSeries.find((series) => series.name === titleName);
                if (!targetSeries) return;
                newNameInput.value = targetSeries.name;
                newPosterInput.value = targetSeries.poster;
                titleRenameForm.querySelectorAll('input[name="newTags"]').forEach((checkbox) => {
                    checkbox.checked = targetSeries.tags.has(checkbox.value);
                });
                bindMultiSelectSummaryHandlers(titleRenameForm);
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
                // 这里的链式调用会先取出全部 newTags
                // 再逐项裁剪空白 最后过滤掉空字符串
                const newTags = formData
                    .getAll('newTags')
                    .map((tag) => String(tag).trim())
                    .filter(Boolean);
                if (!oldName || !newName || !newPoster || newTags.length === 0) return;

                try {
                    await requestJsonApiOrThrow(`/api/titles/${encodeURIComponent(oldName)}`, {
                        method: 'PATCH', body: JSON.stringify({newName, poster: newPoster, tags: newTags})
                    });
                    showFlashMessage('漫剧信息修改成功');
                    if (getCurrentRouteSeriesName() === oldName) history.replaceState({}, '', `/${encodeURIComponent(newName)}`);
                    await reloadBaseDataAndRender();
                } catch (error) {
                    showFlashMessage(error.message);
                    render();
                }
            };
        }

        const titleDeleteForm = document.getElementById('title-delete-form');
        if (titleDeleteForm) {
            // 删除漫剧前先做一次确认
            // 避免连带删除整部作品下的剧集时误操作
            titleDeleteForm.onsubmit = async (event) => {
                event.preventDefault();
                const formData = new FormData(event.target);
                const oldName = String(formData.get('name') || '').trim();
                if (!oldName) return;
                if (!confirm(`确认删除漫剧"${oldName}"？该漫剧下全部剧集会删除`)) return;

                try {
                    await requestJsonApiOrThrow(`/api/titles/${encodeURIComponent(oldName)}`, {method: 'DELETE'});
                    showFlashMessage('漫剧删除成功');
                    if (getCurrentRouteSeriesName() === oldName) history.replaceState({}, '', '/');
                    await reloadBaseDataAndRender();
                } catch (error) {
                    showFlashMessage(error.message);
                    render();
                }
            };
        }
        return;
    }

    // 剧集管理分区同样采用 重绘模板后重新绑定事件 的方式
    adminPanelContainer.innerHTML = `
    <section class="admin-panel">
      <div class="action-tabs episode-action-tabs">
        <button type="button" class="admin-action-tab-button ${uiState.activeEpisodeAdminAction === 'create' ? 'active' : ''}" data-episode-action="create">新增剧集</button>
        <button type="button" class="admin-action-tab-button ${uiState.activeEpisodeAdminAction === 'batch' ? 'active' : ''}" data-episode-action="batch">批量导入</button>
        <button type="button" class="admin-action-tab-button ${uiState.activeEpisodeAdminAction === 'rename' ? 'active' : ''}" data-episode-action="rename">修改剧集</button>
        <button type="button" class="admin-action-tab-button ${uiState.activeEpisodeAdminAction === 'delete' ? 'active' : ''}" data-episode-action="delete">删除剧集</button>
      </div>

      <section class="action-panel ${uiState.activeEpisodeAdminAction === 'create' ? '' : 'hidden'}">
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

      <section class="action-panel ${uiState.activeEpisodeAdminAction === 'batch' ? '' : 'hidden'}">
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

      <section class="action-panel ${uiState.activeEpisodeAdminAction === 'rename' ? '' : 'hidden'}">
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

      <section class="action-panel ${uiState.activeEpisodeAdminAction === 'delete' ? '' : 'hidden'}">
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

    // 子操作切换只修改当前状态
    // 具体界面刷新统一交给 render
    document.querySelectorAll('[data-episode-action]').forEach((btn) => {
        btn.onclick = () => {
            uiState.activeEpisodeAdminAction = btn.dataset.episodeAction;
            render();
        };
    });

    bindMultiSelectSummaryHandlers(adminPanelContainer);

    const episodeCreateForm = document.getElementById('episode-create-form');
    if (episodeCreateForm) {
        episodeCreateForm.onsubmit = async (event) => {
            event.preventDefault();
            // 表单数据会在这里统一整理成后端接口需要的 payload
            const formData = new FormData(event.target);
            const payload = {
                titleName: String(formData.get('titleName') || '').trim(),
                episodeNo: Number(formData.get('episodeNo')),
                videoUrl: String(formData.get('videoUrl') || '').trim()
            };

            try {
                await requestJsonApiOrThrow('/api/episodes', {method: 'POST', body: JSON.stringify(payload)});
                if (getCurrentRouteSeriesName() === payload.titleName) {
                    uiState.selectedEpisode = payload.episodeNo;
                }
                showFlashMessage('剧集新增成功');
                await reloadBaseDataAndRender();
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
                // getAll 会先取出全部 batchTags
                // 后面的 map 和 filter 再负责裁剪空白并过滤空字符串
                tags: formData.getAll('batchTags').map((item) => String(item).trim()).filter(Boolean)
            };

            try {
                const result = await requestJsonApiOrThrow('/api/episodes/batch-directory', {
                    method: 'POST', body: JSON.stringify(payload)
                });
                const total = result.data?.total ?? 0;
                const inserted = result.data?.inserted ?? 0;
                const updated = result.data?.updated ?? 0;
                showFlashMessage(`批量导入成功：共 ${total} 集，新增 ${inserted} 集，更新 ${updated} 集`);
                if (getCurrentRouteSeriesName() === payload.name) {
                    uiState.selectedEpisode = 1;
                }
                await reloadBaseDataAndRender();
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

        const syncEpisodeEditFormFields = () => {
            const episodes = getSeriesEpisodeOptions(titleSelect.value);
            const selectedEpisodeNo = Number(episodeSelect.value);
            // find 会从当前漫剧的剧集列表里
            // 找出和下拉框集号一致的那一条记录
            const targetEpisode = episodes.find((episode) => episode.episode === selectedEpisodeNo);

            if (!targetEpisode) {
                newEpisodeInput.value = '';
                videoUrlInput.value = '';
                return;
            }

            newEpisodeInput.value = String(targetEpisode.episode);
            videoUrlInput.value = targetEpisode.videoUrl;
        };

        const syncEpisodeSelectOptions = () => {
            // 先刷新集号下拉框
            // 再根据新的选项同步右侧编辑表单
            populateEpisodeSelectForSeries(titleSelect, episodeSelect, '选择集号');
            syncEpisodeEditFormFields();
        };

        titleSelect.onchange = syncEpisodeSelectOptions;
        episodeSelect.onchange = syncEpisodeEditFormFields;
        syncEpisodeSelectOptions();

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
                await requestJsonApiOrThrow('/api/episodes', {method: 'PATCH', body: JSON.stringify(payload)});
                showFlashMessage('剧集信息修改成功');
                await reloadBaseDataAndRender();
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

        const syncEpisodeSelectOptions = () => {
            // 删除表单只需要跟随漫剧切换刷新集号选项
            populateEpisodeSelectForSeries(titleSelect, episodeSelect, '选择集号');
        };

        titleSelect.onchange = syncEpisodeSelectOptions;
        syncEpisodeSelectOptions();

        episodeDeleteForm.onsubmit = async (event) => {
            event.preventDefault();
            const formData = new FormData(event.target);
            const payload = {
                titleName: String(formData.get('titleName') || '').trim(), episodeNo: Number(formData.get('episodeNo'))
            };
            if (!payload.titleName || Number.isNaN(payload.episodeNo)) return;
            if (!confirm(`确认删除「${payload.titleName}」第${payload.episodeNo}集？`)) return;

            try {
                await requestJsonApiOrThrow('/api/episodes', {method: 'DELETE', body: JSON.stringify(payload)});
                showFlashMessage('剧集删除成功');
                await reloadBaseDataAndRender();
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
    loadHomeSeriesPageData();
});
render();
reloadBaseDataAndRender();
