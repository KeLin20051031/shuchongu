// Notebook 模块 — 笔记编辑器 + Operation 队列
// 依赖: DataLayer (IndexedDB 持久化)
const Notebook = (function() {
  'use strict';

  // ---------- 模块状态 ----------
  let currentNotebook = null;  // 当前笔记本 { id, pdfId, title, pages: [...] }
  let currentPageId = null;    // 当前页 ID
  let backgroundMode = false;  // true=当前处于"背景展示模式"（旧默认笔记展示但不允许写入，等用户从NFM打开具体笔记）

  // 空态时「立即新建笔记」按钮的处理函数（由 NFM 外部注入）
  let _emptyCreateHandler = null;
  function setEmptyCreateHandler(handler) {
    _emptyCreateHandler = (typeof handler === 'function') ? handler : null;
  }

  // ---------- 写入权限检查 ----------
  // 处于"背景展示模式"时，禁止任何写入操作，提示先从 NFM 打开具体笔记
  // lastToastTime 用于防止 toast 连点刷屏
  let _lastToastTime = 0;
  function _warnBackgroundMode(actionHint) {
    if (!backgroundMode) return false;
    var now = Date.now();
    if (now - _lastToastTime < 1500) return true;
    _lastToastTime = now;
    var hint = actionHint ? ('（' + actionHint + '）') : '';
    var msg = '当前正在浏览"默认笔记"的旧内容' + hint + '。\n若要新增/编辑，请先在右侧「笔记空间」双击打开一本具体笔记，\n或点击「📝 新建」创建新的独立笔记。';
    try {
      if (window.__showToast) {
        window.__showToast(msg.replace(/\n/g, ' '));
      } else {
        alert(msg);
      }
    } catch (e) {}
    return true;
  }
  function _isWritable(actionHint) {
    if (!currentNotebook) return false;
    if (_warnBackgroundMode(actionHint)) return false;
    return true;
  }

  // ---------- DOM 引用 ----------
  let contentEl = null;        // #notebookContent
  let pageInfoEl = null;       // #notebookPageInfo

  // ---------- 编辑状态 (Task 11+12) ----------
  let operationQueue = [];           // AI 操作 FIFO 队列
  let isProcessingQueue = false;     // 队列处理锁（防止重入）
  let blockChangeCallbacks = [];     // onBlockChange 回调列表
  let detectDebounceTimer = null;    // 双模输入检测去抖计时器
  let isInitialized = false;         // 初始化状态保护（避免重复加载）
  // 撤销/重做栈：元素为 { inverse: 反向操作, original: 正向操作 }
  let undoStack = [];
  let redoStack = [];
  let undoChangeCallbacks = [];      // onUndoChange 回调（同步按钮 disabled 状态）
  let _suppressUndoRecord = false;   // 执行 undo/redo 的反向操作时禁止二次记录

  // ---------- MD 双模式编辑状态 (v2) ----------
  let mdModeActive = true;       // 是否处于 MD 模式（true 走 MD 渲染，false 走块渲染）
  let mdSubMode = 'preview';     // MD 模式子态：'preview' | 'edit'
  let cmView = null;             // CodeMirror EditorView 实例（编辑态）
  let cmViewPageId = null;       // cmView 关联的 pageId（用于销毁/保存时精确定位）
  let mdSaveTimer = null;        // 防抖保存计时器
  let _mdRenderToken = 0;        // 异步渲染令牌，避免快速切换页面时的竞态
  let _liveCmdStyling = false;   // 实时指令格式包裹防重入标志

  // ---------- 拖拽排序状态 (Task 15) ----------
  let _dragBlockId = null;       // 当前拖拽中的块 ID
  let _dropLine = null;          // 复用的放置指示线元素
  let _dropTargetId = null;      // 当前放置目标块 ID
  let _dropBefore = false;       // 放置于目标之前 / 之后

  // ============================================================
  // 数据模型工厂函数
  // ============================================================

  /**
   * 创建笔记块
   * @param {string} type - 'text' | 'heading' | 'quote' | 'pdf-ref' | 'ai-result' | 'command' | 'focus'
   * @param {string} content - 块文本内容
   * @param {object} options - { pdfRef, aiGenerated }
   */
  function createBlock(type, content, options) {
    options = options || {};
    return {
      id: 'blk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: type,
      content: content,
      pdfRef: options.pdfRef || null,
      aiGenerated: options.aiGenerated || false,
      lock: false,
      status: options.status || null,  // null | 'pending' | 'complete' (指令状态)
      placeholderFor: options.placeholderFor || null, // 关联的指令块 ID
      timestamp: Date.now()
    };
  }

  // 页面排序比较器：优先用 order（活页顺序），老数据回退到 createdAt
  function _pageOrderCompare(a, b) {
    var oa = (a && a.order != null) ? a.order : (a ? a.createdAt : 0);
    var ob = (b && b.order != null) ? b.order : (b ? b.createdAt : 0);
    return oa - ob;
  }

  /**
   * 创建笔记页
   * @param {string} notebookId - 所属笔记本 ID
   * @param {number|null} pdfPageNum - 关联的 PDF 页码
   */
  function createPage(notebookId, pdfPageNum) {
    var now = Date.now();
    return {
      id: 'pg_' + now + '_' + Math.random().toString(36).substr(2, 6),
      notebookId: notebookId,
      pdfRef: pdfPageNum ? { pageNum: pdfPageNum } : null,
      name: pdfPageNum ? '第 ' + pdfPageNum + ' 页笔记' : '新笔记页',
      blocks: [],
      createdAt: now,
      updatedAt: now,
      order: now,      // 活页顺序：目录里拖动排序后按此字段排序（新页默认排在最后）
      mdContent: ''   // 笔记栏 v2：页级 Markdown 原文（默认空串，与 blocks 并存）
    };
  }

  /**
   * 创建笔记本
   * @param {string} pdfId - 关联的 PDF ID
   * @param {string} title - 笔记本标题
   */
  function createNotebook(pdfId, title) {
    return {
      id: 'nb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      pdfId: pdfId || 'none',
      title: title || '我的笔记',
      pages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  // ============================================================
  // 持久化辅助
  // ============================================================

  /** 持久化页 — 为 by_pdfPageNum 索引补充顶层 pdfPageNum 字段 */
  async function _persistPage(page) {
    var record = Object.assign({}, page, {
      pdfPageNum: page.pdfRef ? page.pdfRef.pageNum : null
    });
    await DataLayer.put('pages', record);
  }

  /** 持久化块 — 为 by_pageId 索引补充顶层 pageId 字段 */
  async function _persistBlock(block, pageId) {
    var record = Object.assign({}, block, { pageId: pageId });
    // 剔除运行时字段（Timer 等不可结构化克隆的对象，会导致 IndexedDB 抛 DataCloneError）
    delete record._saveTimer;
    await DataLayer.put('blocks', record);
  }

  // ============================================================
  // 初始化
  // ============================================================

  // ---------- MD 工具栏常驻管理 ----------
  // NFM 多笔记模式下，即使未打开任何笔记，工具栏也应可见（MD 编辑/预览按钮）
  // 工具栏用固定 id 标记，renderPage 清空内容时会保留它
  function _ensureMdToolbar() {
    if (!contentEl) return null;
    var existing = contentEl.querySelector('#mdToolbar');
    if (existing) return existing;
    var bar = document.createElement('div');
    bar.id = 'mdToolbar';
    bar.className = 'md-mode-toolbar';

    var hint = document.createElement('span');
    hint.className = 'md-mode-hint';
    hint.textContent = 'MD 模式';
    bar.appendChild(hint);

    var btnPreview = document.createElement('button');
    btnPreview.className = 'md-mode-btn';
    btnPreview.textContent = '预览';
    btnPreview.addEventListener('click', function() {
      if (!currentNotebook) { _warnBackgroundMode('切换预览/源码'); return; }
      var page = _findPageById(currentPageId);
      if (!page) { _warnBackgroundMode('切换预览/源码'); return; }
      _setMdSubMode('preview', page);
    });
    bar.appendChild(btnPreview);

    var btnEdit = document.createElement('button');
    btnEdit.className = 'md-mode-btn';
    btnEdit.textContent = '源码';
    btnEdit.addEventListener('click', function() {
      if (!currentNotebook) { _warnBackgroundMode('切换预览/源码'); return; }
      var page = _findPageById(currentPageId);
      if (!page) { _warnBackgroundMode('切换预览/源码'); return; }
      _setMdSubMode('edit', page);
    });
    bar.appendChild(btnEdit);

    // 空状态提示文字（当 currentNotebook 为 null 时显示）
    var emptyHint = document.createElement('span');
    emptyHint.className = 'md-mode-empty-hint';
    emptyHint.style.cssText = 'margin-left:auto;color:#b5722a;font-size:12px;';
    emptyHint.textContent = '请从右侧「笔记空间」双击打开一本笔记';
    emptyHint.id = 'mdToolbarEmptyHint';
    bar.appendChild(emptyHint);

    contentEl.insertBefore(bar, contentEl.firstChild);
    _updateToolbarState();
    return bar;
  }

  function _updateToolbarState() {
    var bar = contentEl ? contentEl.querySelector('#mdToolbar') : null;
    if (!bar) return;
    var emptyHint = bar.querySelector('#mdToolbarEmptyHint');
    var btns = bar.querySelectorAll('.md-mode-btn');
    var writable = !backgroundMode && !!currentNotebook;
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = !writable;
      btns[i].style.opacity = writable ? '1' : '0.5';
      btns[i].style.cursor = writable ? 'pointer' : 'not-allowed';
    }
    if (emptyHint) {
      emptyHint.style.display = writable ? 'none' : '';
    }
    // 更新按钮激活样式
    var activeText = (mdSubMode === 'edit') ? '源码' : '预览';
    for (var j = 0; j < btns.length; j++) {
      var isActive = btns[j].textContent === activeText;
      btns[j].className = 'md-mode-btn' + (isActive ? ' active' : '');
    }
  }

  // ---------- 初始化 ----------
  function init() {
    contentEl = document.getElementById('notebookContent');
    pageInfoEl = document.getElementById('notebookPageInfo');

    // MD 模式激活时预先创建常驻工具栏（NFM 空状态也可见）
    if (mdModeActive) _ensureMdToolbar();

    var btnPrev = document.getElementById('btnPrevNotePage');
    var btnNext = document.getElementById('btnNextNotePage');
    var btnNew = document.getElementById('btnNewBlock');
    var btnMd = document.getElementById('btnToggleMdMode');

    if (btnPrev) btnPrev.addEventListener('click', _goPrevPage);
    if (btnNext) btnNext.addEventListener('click', _goNextPage);
    if (btnNew) btnNew.addEventListener('click', function() {
      // MD 模式：聚焦 MD 编辑区，不再创建 Block 文本框
      if (mdModeActive) { _focusMdEditor(); return; }
      // 通过 Operation 队列创建新文本块（统一操作入口）
      applyOperation({ type: 'insert', source: 'user', blockType: 'text', content: '' })
        .then(function(newBlock) { if (newBlock) _focusBlock(newBlock.id); });
    });
    if (btnMd) btnMd.addEventListener('click', toggleMdMode);

    // --- 开始工具栏（Word 式格式工具栏）绑定 ---
    _bindHomeToolbar();

    // --- 图片：全局粘贴 / 拖拽导入（2026-08-19） ---
    try { _bindGlobalImageHandlers(); } catch (e) {}

    // ---- P5 书签栏 ----
    var btnBookmarks = document.getElementById('btnToggleBookmarks');
    var btnCloseBookmarks = document.getElementById('btnCloseBookmarks');
    if (btnBookmarks) btnBookmarks.addEventListener('click', toggleBookmarkPanel);
    if (btnCloseBookmarks) btnCloseBookmarks.addEventListener('click', toggleBookmarkPanel);

    // ---- contentEditable 编辑初始化 (Task 11) ----
    if (contentEl) {
      // 容器本身不可编辑，只有 .note-block 子元素可编辑
      // 防止用户在块外输入文字导致事件无法捕获
      contentEl.setAttribute('contenteditable', 'false');
      // MD 模式下禁用全部 Block 编辑监听，避免残留一行行 Block 文本框；
      // 输入/点击/拖拽均交由 MD 预览态 contenteditable 与 CodeMirror 处理。
      if (!mdModeActive) {
        contentEl.addEventListener('input', _onContentInput);
        contentEl.addEventListener('keydown', _onContentKeydown);
        contentEl.addEventListener('blur', _onContentBlur, true); // capture：捕获块级 blur
        // 拖拽排序事件（仅允许从块左侧手柄发起拖拽）
        contentEl.addEventListener('dragstart', _onDragStart);
        contentEl.addEventListener('dragover', _onDragOver);
        contentEl.addEventListener('drop', _onDrop);
        contentEl.addEventListener('dragend', _onDragEnd);
        // 点击空白区域 → 自动创建新块
        contentEl.addEventListener('click', function(e) {
          // Shift+点击块：切换多选（用于合并）
          var blk = e.target.closest ? e.target.closest('.note-block') : null;
          if (e.shiftKey && blk) {
            e.preventDefault();
            e.stopPropagation();
            _toggleSelectBlock(blk.getAttribute('data-block-id'));
            return;
          }
          if (e.target === contentEl) {
            applyOperation({ type: 'insert', source: 'user', blockType: 'text', content: '' })
              .then(function(nb) { if (nb) _focusBlock(nb.id); });
          }
        });
      }
    }

    // 初始化页面目录面板
    _initPageDirectoryPanel();
    // 2026-08-15 扩展：注册 HTML 块 iframe 自适应高度消息监听 + 流程图共享 resize
    _setupHtmlBlockResizeListener();
    _setupDiagramSharedResize();
  }

  // ============================================================
  // 加载或创建笔记本
  // ============================================================

  // 真正执行"加载单本 pdfId 主笔记"的逻辑（existing[0] 或创建新的）
  async function _loadDefaultNotebookByPdfId(pdfId, title, opts) {
    opts = opts || {};
    var isBackground = !!opts.background;

    // 如果已加载相同 pdfId 且模式不冲突
    if (isInitialized && currentNotebook && currentNotebook.pdfId === pdfId && backgroundMode === isBackground) {
      if (title && (!currentNotebook.title || currentNotebook.title === '我的笔记')) {
        currentNotebook.title = title;
      }
      return currentNotebook;
    }
    isInitialized = true;
    backgroundMode = isBackground;

    // 按 pdfId 查询已有笔记本
    var existing = await DataLayer.query('notebooks', 'by_pdfId', pdfId);

    if (existing && existing.length > 0) {
      currentNotebook = existing[0];
      if (title && (!currentNotebook.title || currentNotebook.title === '我的笔记')) {
        currentNotebook.title = title;
        try { await DataLayer.put('notebooks', currentNotebook); } catch (e) {}
      }
      currentNotebook.pages = [];

      var pages = await DataLayer.query('pages', 'by_notebookId', currentNotebook.id);
      pages.sort(_pageOrderCompare);

      for (var i = 0; i < pages.length; i++) {
        var page = pages[i];
        if (page.mdContent === undefined) page.mdContent = '';
        var blocks = await DataLayer.query('blocks', 'by_pageId', page.id);
        blocks.sort(function(a, b) { return a.timestamp - b.timestamp; });
        for (var bi = 0; bi < blocks.length; bi++) {
          var pb = blocks[bi];
          if (pb.lock) {
            pb.lock = false;
            if (pb.type === 'ai-placeholder') {
              pb.type = 'ai-result';
              pb.aiGenerated = true;
              if (!pb.content || pb.content.indexOf('思考中') >= 0) {
                pb.content = '（上一次 AI 生成未完成）';
              }
            }
            try { await _persistBlock(pb, page.id); } catch (e) {}
          }
        }
        page.blocks = blocks;
        currentNotebook.pages.push(page);
      }
    } else {
      currentNotebook = createNotebook(pdfId, title);
      try { await DataLayer.put('notebooks', currentNotebook); } catch (e) {}
      var firstPage = createPage(currentNotebook.id, null);
      currentNotebook.pages.push(firstPage);
      try { await _persistPage(firstPage); } catch (e) {}
    }

    currentPageId = currentNotebook.pages[0]
      ? currentNotebook.pages[0].id
      : null;

    if (currentPageId) {
      renderPage(currentPageId);
    }

    try { renderNotebookTOC(); } catch(e) {}
    return currentNotebook;
  }

  async function loadOrCreateNotebook(pdfId, title) {
    pdfId = pdfId || 'none';

    // =========== 多笔记管理（NFM）决策接入 ===========
    // 原则：永远不把用户卡在"空态不能写"。
    //   1. NFM 有当前打开的 notebookId → 打开那本（正式读写模式）
    //   2. NFM 有笔记条目但未指定打开 → 自动打开第一本（正式读写模式，用户立即能写）
    //      用户如果想切换，随时从 NFM 双击另一本
    //   3. NFM 中没有任何笔记条目 → 传统单笔记兼容逻辑（加载 existing[0]）
    var nfm = (typeof NoteFileManager !== 'undefined') ? NoteFileManager : null;
    if (nfm && typeof nfm.hasAnyNotesForBook === 'function' && nfm.hasAnyNotesForBook(pdfId)) {
      var openNbId = (typeof nfm.getCurrentOpenNotebookId === 'function') ? nfm.getCurrentOpenNotebookId() : null;
      isInitialized = true;
      if (openNbId) {
        // 用户已在 NFM 中打开了某本具体笔记 → 加载那本（正式读写模式）
        backgroundMode = false;
        var explicit = await loadNotebookById(openNbId);
        if (explicit) return explicit;
      }
      // NFM 有笔记条目但无 openNotebookId → 自动打开第一本，用户立即进入可写状态
      // （避免用户因为 NFM 面板折叠看不到入口，导致"不能编辑"的死胡同）
      if (typeof nfm.getFirstNoteForBook === 'function') {
        var firstNote = nfm.getFirstNoteForBook(pdfId);
        if (firstNote && firstNote.notebookId) {
          if (typeof nfm.setOpenNotebook === 'function') {
            nfm.setOpenNotebook(firstNote.id, firstNote.notebookId);
          }
          backgroundMode = false;
          var autoNb = await loadNotebookById(firstNote.notebookId);
          if (autoNb) return autoNb;
        }
      }
      // 兜底：NFM 有笔记但 getFirstNoteForBook 返回空 → 干净空状态
      backgroundMode = true;
      currentNotebook = null;
      currentPageId = null;
      _ensureMdToolbar();
      renderPage(null);
      return null;
    }

    // ===== 传统单笔记兼容逻辑（NFM 无笔记条目时） =====
    backgroundMode = false;
    return _loadDefaultNotebookByPdfId(pdfId, title, { background: false });
  }

  // ============================================================
  // 切换到指定 notebookId 的笔记本（用于多笔记管理）
  // ============================================================

  async function loadNotebookById(id) {
    if (!id) return null;
    try {
      var nb = await DataLayer.get('notebooks', id);
      if (!nb) {
        console.warn('[loadNotebookById] DB 中未找到 notebook id=', id);
        return null;
      }
      // 切到由 NFM 打开的具体笔记 → 退出背景模式，进入正式读写
      backgroundMode = false;
      nb.pages = [];
      var pages;
      try {
        pages = await DataLayer.query('pages', 'by_notebookId', id);
      } catch (qe) {
        console.warn('[loadNotebookById] 查询 pages 失败:', qe);
        pages = [];
      }
      pages.sort(_pageOrderCompare);
      for (var i = 0; i < pages.length; i++) {
        var page = pages[i];
        if (page.mdContent === undefined) page.mdContent = '';
        var blocks = [];
        try {
          blocks = await DataLayer.query('blocks', 'by_pageId', page.id);
          blocks.sort(function(a, b) { return a.timestamp - b.timestamp; });
        } catch (be) {
          console.warn('[loadNotebookById] 查询 blocks 失败 page=', page.id, be);
          blocks = [];
        }
        // 清理锁定块
        var persistNeeded = false;
        for (var bi = 0; bi < blocks.length; bi++) {
          var pb = blocks[bi];
          if (pb.lock) {
            pb.lock = false;
            persistNeeded = true;
            if (pb.type === 'ai-placeholder') {
              pb.type = 'ai-result';
              pb.aiGenerated = true;
              if (!pb.content || pb.content.indexOf('思考中') >= 0) {
                pb.content = '（上一次 AI 生成未完成）';
              }
            }
            try { await _persistBlock(pb, page.id); persistNeeded = false; } catch (e) {}
          }
        }
        page.blocks = blocks;
        if (persistNeeded) {
          try { await DataLayer.put('notebooks', nb); } catch (e) {}
        }
        nb.pages.push(page);
      }
      currentNotebook = nb;
      currentPageId = nb.pages.length > 0 ? nb.pages[0].id : null;
      if (currentPageId) {
        // 2026-08-16：用户要求重新进入笔记 → 默认预览模式（而非源码编辑）。
        // 保持 mdSubMode = 'preview'（初始化已在 L61 设置），只在页面渲染后应用预览态样式。
        if (mdModeActive) {
          mdSubMode = 'preview';
        }
        renderPage(currentPageId);
        if (mdModeActive && mdSubMode === 'preview') {
          setTimeout(function() {
            var page = _findPageById(currentPageId);
            if (page) _renderMdSubMode(page);
          }, 80);
        }
      } else {
        // 无页面的空笔记本 → 立即创建首页，持久化后再打开进入预览态（用户需切换到源码才开始编辑）
        var p1 = createPage(nbId, 1);
        p1.title = '第 1 页';
        nb.pages.push(p1);
        nb.updatedAt = Date.now();
        try {
          await DataLayer.put('notebooks', nb);
          await DataLayer.put('pages', p1);
          currentNotebook = nb;
          currentPageId = p1.id;
          if (mdModeActive) mdSubMode = 'preview';
          renderPage(p1.id);
          if (mdModeActive && mdSubMode === 'preview') {
            setTimeout(function() {
              _renderMdSubMode(currentPageId ? _findPageById(currentPageId) : null);
            }, 80);
          }
        } catch (saveErr) {
          console.warn('[loadNotebookById] 创建空笔记本首页失败:', saveErr);
          _ensureMdToolbar();
          renderPage(null);
        }
      }
      try { renderNotebookTOC(); } catch (e) {}
      _updateToolbarState();
      return nb;
    } catch (e) {
      console.warn('loadNotebookById 失败:', e);
      return null;
    }
  }

  function clearActiveNotebook() {
    currentNotebook = null;
    currentPageId = null;
    backgroundMode = true;
    _destroyCmView();
    // 统一走 renderPage(null) 渲染空态：横线笔记本样式 + 友好提示
    _ensureMdToolbar();
    renderPage(null);
  }

  async function deletePage(pageId) {
    if (!currentNotebook) return false;
    var idx = -1;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === pageId) { idx = i; break; }
    }
    if (idx < 0) return false;
    try {
      // 删除该页的所有块
      var blocks = await DataLayer.query('blocks', 'by_pageId', pageId);
      for (var bi = 0; bi < blocks.length; bi++) {
        await DataLayer.delete('blocks', blocks[bi].id);
      }
      await DataLayer.delete('pages', pageId);
      currentNotebook.pages.splice(idx, 1);
      _normalizePageOrder();
      currentNotebook.updatedAt = Date.now();
      await DataLayer.put('notebooks', currentNotebook);
      _fixCurrentPageAfterDelete(pageId);
      return true;
    } catch (e) {
      console.warn('deletePage 失败:', e);
      return false;
    }
  }

  // 删除页后修正当前页指针：被删的是当前页 → 切到相邻页（或空态）
  function _fixCurrentPageAfterDelete(deletedPageId) {
    if (currentPageId !== deletedPageId) { renderNotebookTOC(); return; }
    if (currentNotebook.pages.length > 0) {
      currentPageId = currentNotebook.pages[0].id;
      renderPage(currentPageId);
    } else {
      currentPageId = null;
      renderPage(null);
    }
  }

  // 批量删除页面（活页管理：允许删到 0 页）
  async function batchDeletePages(pageIds) {
    if (!currentNotebook || !pageIds || !pageIds.length) return 0;
    var set = {};
    pageIds.forEach(function(id) { set[id] = true; });
    var deleted = 0;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      var p = currentNotebook.pages[i];
      if (!set[p.id]) continue;
      try {
        var blocks = await DataLayer.query('blocks', 'by_pageId', p.id);
        for (var bi = 0; bi < blocks.length; bi++) {
          await DataLayer.delete('blocks', blocks[bi].id);
        }
        await DataLayer.delete('pages', p.id);
        deleted++;
      } catch (e) { console.warn('批量删除页失败:', p.id, e); }
    }
    currentNotebook.pages = currentNotebook.pages.filter(function(p) { return !set[p.id]; });
    _normalizePageOrder();
    currentNotebook.updatedAt = Date.now();
    try { await DataLayer.put('notebooks', currentNotebook); } catch (e) {}
    if (currentNotebook.pages.indexOf(_getCurrentPageObj()) < 0) {
      _fixCurrentPageAfterDelete(currentPageId);
    } else {
      renderNotebookTOC();
    }
    return deleted;
  }

  // 新建笔记页（可绑定指定 PDF 页码，也可纯空白页）并立即打开
  async function addPage(name, pdfPageNum) {
    if (!currentNotebook) return null;
    var page = createPage(currentNotebook.id, pdfPageNum);
    if (name) page.name = name;
    currentNotebook.pages.push(page);
    _normalizePageOrder();
    currentNotebook.updatedAt = Date.now();
    try { await DataLayer.put('notebooks', currentNotebook); } catch (e) {}
    try { await _persistPage(page); } catch (e) {}
    currentPageId = page.id;
    renderPage(page.id);
    renderNotebookTOC();
    return page;
  }

  // 活页顺序规范化：按当前数组顺序把 order 重置为 0..n-1（保证排序稳定）
  function _normalizePageOrder() {
    if (!currentNotebook || !currentNotebook.pages) return;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      currentNotebook.pages[i].order = i;
    }
  }

  async function movePageBefore(srcId, dstId) {
    if (!currentNotebook) return false;
    var pages = currentNotebook.pages;
    var sIdx = -1, dIdx = -1;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].id === srcId) sIdx = i;
      if (pages[i].id === dstId) dIdx = i;
    }
    if (sIdx < 0 || dIdx < 0 || sIdx === dIdx) return false;
    var src = pages.splice(sIdx, 1)[0];
    dIdx = -1;
    for (var j = 0; j < pages.length; j++) {
      if (pages[j].id === dstId) { dIdx = j; break; }
    }
    // 移除 src 后 dst 下标可能回退一格：统一插到 dst 之前
    pages.splice(dIdx, 0, src);
    _normalizePageOrder();
    currentNotebook.updatedAt = Date.now();
    try {
      for (var k = 0; k < pages.length; k++) { await _persistPage(pages[k]); }
      await DataLayer.put('notebooks', currentNotebook);
      renderNotebookTOC();
      return true;
    } catch (e) {
      console.warn('movePageBefore 失败:', e);
      return false;
    }
  }

  // 把某页移到数组末尾（活页管理：拖到列表尾部）
  async function movePageToEnd(srcId) {
    if (!currentNotebook) return false;
    var pages = currentNotebook.pages;
    var sIdx = -1;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].id === srcId) { sIdx = i; break; }
    }
    if (sIdx < 0 || sIdx === pages.length - 1) return false;
    var src = pages.splice(sIdx, 1)[0];
    pages.push(src);
    _normalizePageOrder();
    currentNotebook.updatedAt = Date.now();
    try {
      for (var k = 0; k < pages.length; k++) { await _persistPage(pages[k]); }
      await DataLayer.put('notebooks', currentNotebook);
      renderNotebookTOC();
      return true;
    } catch (e) {
      console.warn('movePageToEnd 失败:', e);
      return false;
    }
  }

  // 查找绑定到指定 PDF 页码的笔记页（不创建）
  function findPageByPdfNum(pageNum) {
    if (!currentNotebook || !pageNum) return null;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].pdfRef &&
          currentNotebook.pages[i].pdfRef.pageNum === pageNum) {
        return currentNotebook.pages[i];
      }
    }
    return null;
  }

  // ============================================================
  // 确保有对应 PDF 页的笔记页
  // ============================================================

  async function ensurePageForPdfPage(pageNum) {
    if (!currentNotebook) return null;
    if (_warnBackgroundMode('翻页自动写入笔记')) return null;

    // 查找已有关联该 PDF 页的笔记页
    var page = null;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].pdfRef &&
          currentNotebook.pages[i].pdfRef.pageNum === pageNum) {
        page = currentNotebook.pages[i];
        break;
      }
    }
    if (page) return page;

    // 创建新页
    page = createPage(currentNotebook.id, pageNum);
    currentNotebook.pages.push(page);
    currentNotebook.updatedAt = Date.now();

    try { await DataLayer.put('notebooks', currentNotebook); } catch (e) {}
    try { await _persistPage(page); } catch (e) {}

    return page;
  }

  // ============================================================
  // 渲染笔记页
  // ============================================================

  // ---------- 空态渲染：横线笔记本样式，保持与 MD 预览态一致的视觉 ----------
  function _renderEmptyRuledNotebook(contentHtml, onCreateCb) {
    // 使用 md-content 容器 + md-preview md-ruled-notebook 样式，严格匹配 MD 预览态视觉
    var area = document.createElement('div');
    area.className = 'md-mode-content';
    area.id = 'mdModeContent';

    var preview = document.createElement('div');
    preview.className = 'md-preview md-content md-ruled-notebook preview-mode-active';
    preview.style.cssText = 'min-height: 400px;';
    preview.setAttribute('contenteditable', 'false');

    var empty = document.createElement('div');
    empty.className = 'notebook-empty';
    empty.setAttribute('contenteditable', 'false');
    empty.innerHTML = contentHtml;
    preview.appendChild(empty);

    // 大号「立即新建笔记」入口（让用户一键进入可写状态）
    // 仅在外部显式注册了 handler 时才显示，否则保持空态干净
    if (typeof onCreateCb === 'function') {
      var bigBtn = document.createElement('button');
      bigBtn.className = 'nfm-big-new-btn';
      bigBtn.type = 'button';
      bigBtn.innerHTML = '📝 立即新建笔记';
      bigBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        onCreateCb();
      });
      preview.appendChild(bigBtn);
    }

    area.appendChild(preview);
    return area;
  }

  function renderPage(pageId) {
    // 切换页面前销毁旧 MD 编辑器实例（内部会 flush 未落盘内容，避免泄漏与丢字）
    _destroyCmView();

    // 始终更新当前页 ID（即使 DOM 不存在）
    currentPageId = pageId;

    if (!contentEl) contentEl = document.getElementById('notebookContent');
    if (!pageInfoEl) pageInfoEl = document.getElementById('notebookPageInfo');

    if (!contentEl) {
      _updatePageInfo();
      return;
    }

    // ---------- 分支 1：没有打开任何笔记本 ----------
    if (!currentNotebook) {
      var toolbar = contentEl.querySelector('#mdToolbar');
      contentEl.innerHTML = '';
      if (toolbar) contentEl.appendChild(toolbar);
      _ensureMdToolbar();

      if (mdModeActive) {
        // MD 模式：横线笔记本样式 + 空提示 + 大号新建按钮
        var emptyArea = _renderEmptyRuledNotebook(
          backgroundMode
            ? '当前还没有打开任何笔记<br>点击下方大按钮即可创建一本全新的独立笔记'
            : '当前处于未激活状态<br>请先选择或新建一本笔记',
          _emptyCreateHandler
        );
        contentEl.appendChild(emptyArea);
      } else {
        // 非 MD 模式（块模式）：简单空占位 + 新建按钮
        var simpleWrap = document.createElement('div');
        simpleWrap.className = 'notebook-empty-wrap';
        simpleWrap.style.cssText = 'padding:40px 24px;text-align:center;color:#8b7d65;';
        simpleWrap.innerHTML = '当前还没有打开任何笔记<br><br>';
        var simpleBtn = document.createElement('button');
        simpleBtn.className = 'nfm-big-new-btn';
        simpleBtn.textContent = '📝 立即新建笔记';
        simpleBtn.addEventListener('click', function() {
          try {
            if (window.NoteFileManager && typeof NoteFileManager.newNote === 'function') {
              NoteFileManager.newNote(null);
            } else if (window.NoteFileManager && typeof NoteFileManager._newNote === 'function') {
              NoteFileManager._newNote(null);
            }
          } catch (e) { console.warn(e); }
        });
        simpleWrap.appendChild(simpleBtn);
        contentEl.appendChild(simpleWrap);
      }
      _updateToolbarState();
      _updatePageInfo();
      try { renderNotebookTOC(); } catch (e) {}
      try { renderBookmarks(null); } catch (e) {}
      return;
    }

    var page = null;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === pageId) {
        page = currentNotebook.pages[i];
        break;
      }
    }

    // ---------- 分支 2：打开了笔记本但找不到页面 ----------
    if (!page) {
      var toolbarKeep = contentEl.querySelector('#mdToolbar');
      contentEl.innerHTML = '';
      if (toolbarKeep) contentEl.appendChild(toolbarKeep);
      _ensureMdToolbar();

      var pageEmptyArea = _renderEmptyRuledNotebook(
        '本笔记还没有页面<br>点击上方「📑 目录」→ 新建页面'
      );
      contentEl.appendChild(pageEmptyArea);

      _updateToolbarState();
      _updatePageInfo();
      try { renderNotebookTOC(); } catch (e) {}
      try { renderBookmarks(null); } catch (e) {}
      return;
    }

    // ---------- 分支 3：正常页面渲染 ----------
    var toolbarKeep2 = contentEl.querySelector('#mdToolbar');
    contentEl.innerHTML = '';
    if (toolbarKeep2) contentEl.appendChild(toolbarKeep2);

    // 确保工具栏状态已更新
    _updateToolbarState();

    if (mdModeActive) {
      // MD 模式：异步迁移 + 渲染双态（预览 / 编辑）
      _renderMdModeAsync(page);
    } else if (!page.blocks || page.blocks.length === 0) {
      // 空状态提示
      var empty = document.createElement('div');
      empty.className = 'notebook-empty';
      empty.setAttribute('contenteditable', 'false');
      empty.innerHTML = '在分栏视图下，从 PDF 划选文本即可推送到这里<br>或直接开始输入笔记';
      contentEl.appendChild(empty);
    } else {
      // 逐块渲染
      for (var j = 0; j < page.blocks.length; j++) {
        var el = _renderBlock(page.blocks[j], j, page.blocks.length);
        if (el) contentEl.appendChild(el);
      }
    }

    _updatePageInfo();
    renderNotebookTOC();
    renderBookmarks(pageId);
  }

  // ============================================================
  // P5 书签系统：页边书签栏（绿色主题，默认收起，可展开 / 复现 / 回退 / 删除）
  // ============================================================

  // 非 edit 类书签复现前的正文快照（bookmarkId -> 应用前 mdContent，用于 toggle 回退）
  let _bookmarkBeforeMd = {};

  // 从行级 diff 重建 oldMd / newMd（same/del 行归 old，same/add 行归 new）
  function _reconstructFromDiff(diff) {
    var oldLines = [];
    var newLines = [];
    (diff || []).forEach(function(d) {
      if (d.type === 'same') { oldLines.push(d.text); newLines.push(d.text); }
      else if (d.type === 'del') { oldLines.push(d.text); }
      else if (d.type === 'add') { newLines.push(d.text); }
    });
    return { oldMd: oldLines.join('\n'), newMd: newLines.join('\n') };
  }

  function _fmtBookmarkTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function _escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function(ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch];
    });
  }

  // 2026-08-15 新增：把 diff 数组渲染为红绿差异 HTML（可视化 edit 类变更）
  function _renderDiffHtml(diff) {
    if (!Array.isArray(diff) || !diff.length) return '';
    var rows = [];
    (diff || []).forEach(function(d) {
      var safe = _escapeHtml(d.text || '');
      if (d.type === 'same') {
        rows.push('<div class="diff-row diff-same"><span class="diff-gutter"> </span>' + (safe || '&nbsp;') + '</div>');
      } else if (d.type === 'del') {
        rows.push('<div class="diff-row diff-del"><span class="diff-gutter">−</span>' + (safe || '&nbsp;') + '</div>');
      } else if (d.type === 'add') {
        rows.push('<div class="diff-row diff-add"><span class="diff-gutter">+</span>' + (safe || '&nbsp;') + '</div>');
      }
    });
    return '<div class="diff-block">' + rows.join('') + '</div>';
  }

  // 2026-08-15 新增：书签详情区（点击标题展开/收起），包含：summary、diff、contentMd预览
  function _renderBookmarkDetail(bm) {
    var parts = [];
    // 摘要
    if (bm.summary) {
      parts.push('<div class="bm-summary">' + _escapeHtml(bm.summary) + '</div>');
    }
    // edit 类：diff 红绿可视化
    if (bm.type === 'edit' && Array.isArray(bm.diff) && bm.diff.length) {
      parts.push('<div class="bm-section">');
      parts.push('<div class="bm-section-title">变更差异（红删绿增）</div>');
      parts.push(_renderDiffHtml(bm.diff));
      parts.push('</div>');
    }
    // 非 edit 类：contentMd Markdown 预览（蓝图 §5.3 —— 用户可"采纳"并入正文）
    if (bm.contentMd && bm.type !== 'edit') {
      parts.push('<div class="bm-section">');
      parts.push('<div class="bm-section-title">AI 生成内容预览（点击「采纳并入正文」将其追加到笔记末尾）</div>');
      var preview = '';
      try {
        if (typeof renderMarkdown === 'function') preview = renderMarkdown(bm.contentMd);
        else preview = '<pre>' + _escapeHtml(bm.contentMd) + '</pre>';
      } catch (e) { preview = '<pre>' + _escapeHtml(bm.contentMd) + '</pre>'; }
      parts.push('<div class="bm-content-preview">' + preview + '</div>');
      parts.push('</div>');
    }
    if (!parts.length) return '';
    return '<div class="bm-detail" style="display:none;">' + parts.join('') + '</div>';
  }

  // 2026-08-15 新增：将书签内容并入正文（非 edit 类书签专用，蓝图 §5.3 原则）
  async function acceptBookmark(pageId, bookmarkId) {
    if (!pageId) pageId = currentPageId;
    if (!pageId || !bookmarkId) return false;
    var list = [];
    try { list = await DataLayer.listBookmarks(pageId); } catch (e) { list = []; }
    var bm = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === bookmarkId) { bm = list[i]; break; }
    }
    if (!bm || !bm.contentMd) return false;
    var content = String(bm.contentMd || '').trim();
    if (!content) return false;
    // 追加到当前页 mdContent 末尾（空行分隔，避免粘连）
    var curMd = '';
    try { curMd = await DataLayer.getPageMd(pageId); } catch (e) { curMd = ''; }
    var separator = (curMd.trim() === '') ? '' : (curMd.match(/\n{0,2}$/)[0].length < 2 ? '\n\n' : '');
    var newMd = curMd + separator + content;
    await DataLayer.putPageMd(pageId, newMd);
    // 同步内存页对象
    var page = _findPageById(pageId);
    if (page) page.mdContent = newMd;
    // 采纳后从书签中移除（也可改为保留并打标，这里先移除避免重复）
    try { await DataLayer.removeBookmark(pageId, bookmarkId); } catch (e) {}
    delete _bookmarkBeforeMd[bookmarkId];
    // 若书签来自当前页，触发重渲染
    var cid = null;
    try { if (getCurrentPageId) cid = getCurrentPageId(); } catch (e) { cid = null; }
    if (cid === null || cid === pageId) {
      try { await renderPage(pageId); } catch (e) {}
    }
    renderBookmarks(pageId);
    return true;
  }

  // ============================================================
  // 2026-08-15 策略审批弹窗（队列卡片「查看 & 审批策略」按钮）
  // - 展示：用户原始指令 + AI 设计理由 + 操作列表 + Diff 红绿预览
  // - 操作：批准并执行 / 拒绝让 AI 重设计 / 关闭
  // ============================================================
  var _approvalModalEl = null;
  var _approvalCurrentCmdId = null;

  function _ensureApprovalModal() {
    if (_approvalModalEl) return _approvalModalEl;
    var mask = document.createElement('div');
    mask.className = 'approval-modal-mask';
    mask.innerHTML = [
      '<div class="approval-modal">',
      '  <div class="approval-modal-head">',
      '    <span class="am-title">📋 AI 策略审批</span>',
      '    <button class="am-close" data-am-act="close" title="关闭">✕</button>',
      '  </div>',
      '  <div class="approval-modal-body">',
      '    <div class="am-section">',
      '      <div class="am-label">📝 用户原始指令</div>',
      '      <div class="am-raw"></div>',
      '    </div>',
      '    <div class="am-section">',
      '      <div class="am-row-2">',
      '        <div style="flex:1;">',
      '          <div class="am-label">🧠 AI 判定类型</div>',
      '          <div class="am-meta am-intent"></div>',
      '        </div>',
      '        <div style="flex:1;">',
      '          <div class="am-label">🔢 当前状态</div>',
      '          <div class="am-meta am-status"></div>',
      '        </div>',
      '      </div>',
      '    </div>',
      '    <div class="am-section">',
      '      <div class="am-label">💡 设计理由（AI 为什么这样改）</div>',
      '      <textarea class="am-reason" rows="4" readonly></textarea>',
      '    </div>',
      '    <div class="am-section am-ai-warn-section" style="display:none;">',
      '      <div class="am-label">⚠️ AI 连接状态</div>',
      '      <div class="am-ai-warn"></div>',
      '    </div>',
      '    <div class="am-section am-content-section" style="display:none;">',
      '      <div class="am-label">📄 将写入正文的内容（预览）</div>',
      '      <div class="am-content-preview"></div>',
      '    </div>',
      '    <div class="am-section">',
      '      <div class="am-label">🛠️ 操作列表（统一为 edit 工具 operations[]）</div>',
      '      <div class="am-ops-list"></div>',
      '    </div>',
      '    <div class="am-section">',
      '      <div class="am-label">🎨 变更预览（Diff 红绿可视化）</div>',
      '      <div class="am-diff-box"></div>',
      '    </div>',
      '  </div>',
      '  <div class="approval-modal-foot">',
      '    <button class="am-btn am-btn-cancel" data-am-act="close">关闭</button>',
      '    <button class="am-btn am-btn-reject" data-am-act="reject">❌ 拒绝让 AI 重设计</button>',
      '    <button class="am-btn am-btn-approve" data-am-act="approve">✅ 批准并执行</button>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(mask);
    _approvalModalEl = mask;

    mask.addEventListener('click', function(e) {
      var t = e.target;
      var act = t && t.getAttribute ? t.getAttribute('data-am-act') : null;
      if (!act && t === mask) act = 'close';
      if (!act) return;
      if (act === 'close') { _closeApprovalModal(); return; }
      if (!_approvalCurrentCmdId) return;
      if (act === 'approve') {
        try {
          if (typeof AIEngine !== 'undefined' && AIEngine.applyApprovedPlan) {
            AIEngine.applyApprovedPlan(_approvalCurrentCmdId)
              .then(function() { _closeApprovalModal(); })
              .catch(function(err) { alert('执行失败：' + (err && err.message ? err.message : String(err))); });
          }
        } catch (e) { alert('执行出错：' + String(e)); }
        return;
      }
      if (act === 'reject') {
        try {
          if (typeof AIEngine !== 'undefined' && AIEngine.rejectStrategy) {
            AIEngine.rejectStrategy(_approvalCurrentCmdId, '用户拒绝，需要重新设计').catch(function(err) {
              alert('拒绝操作失败：' + (err && err.message ? err.message : String(err)));
            });
          }
        } catch (e) {}
        _closeApprovalModal();
        return;
      }
    });
    return _approvalModalEl;
  }
  function _closeApprovalModal() {
    if (_approvalModalEl) _approvalModalEl.style.display = 'none';
    _approvalCurrentCmdId = null;
  }
  function _applyOpsPreview(md, operations) {
    var out = String(md || '');
    if (!Array.isArray(operations)) return out;
    // 顺序执行 operations：
    //  - add：把 payload.lines 插到 pos 指定行；未指定行号默认文末
    //  - replace/merge/delete：这里做预览不做精细匹配，用描述性占位
    var lines = out.split('\n');
    // 逆序执行 add：避免前面插入影响后面的行号锚点
    for (var i = operations.length - 1; i >= 0; i--) {
      var op = operations[i];
      var type = op && op.type ? op.type : 'add';
      if (type === 'add') {
        var pos = Number(op.pos);
        var insert = (op.payload && Array.isArray(op.payload.lines)) ? op.payload.lines.slice() :
                     (op.payload && op.payload.text != null ? [String(op.payload.text)] : []);
        if (!isFinite(pos) || pos < 0 || pos > lines.length) pos = lines.length;
        lines.splice(pos, 0, '<!--APPROVAL-ADD-START-->', insert.join('\n'), '<!--APPROVAL-ADD-END-->');
      }
    }
    return lines.join('\n');
  }
  function _renderApprovalDiffBox(mdPre, mdPost, operations) {
    // 把 <!--APPROVAL-ADD-*-- > 包裹区域渲染为绿色 <ins>，其余按行输出
    var lines = String(mdPost || '').split('\n');
    var inAdd = false;
    var parts = [];
    var anyAdd = false;
    var buf = [];
    function flushPlain() {
      if (buf.length) {
        parts.push('<div class="am-diff-line"><code>' + _escapeHtml(buf.join('\n')) + '</code></div>');
        buf = [];
      }
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln === '<!--APPROVAL-ADD-START-->') {
        flushPlain();
        inAdd = true;
        continue;
      }
      if (ln === '<!--APPROVAL-ADD-END-->') {
        // 空 buf 内部收集了 add 行，渲染为绿色
        var addLines = buf;
        buf = [];
        inAdd = false;
        if (addLines.length) {
          anyAdd = true;
          parts.push('<div class="am-diff-line am-diff-insert"><span class="am-diff-tag">+</span><code>'
            + _escapeHtml(addLines.join('\n')) + '</code></div>');
        }
        continue;
      }
      // 展示 delete / replace 操作的标记（仅文字提示，无实际删改，因为预览模式）
      // 这些 operations 我们没有改原行，就显示为 plain；若 operations 有非 add，再单独渲染提示
      buf.push(ln);
    }
    flushPlain();

    // 如果存在 replace/delete 类操作，再追加一个提示行
    var hasStructuralOp = false;
    if (Array.isArray(operations)) {
      for (var k = 0; k < operations.length; k++) {
        var t = operations[k].type;
        if (t !== 'add') { hasStructuralOp = true; break; }
      }
    }
    if (hasStructuralOp) {
      parts.unshift('<div class="am-diff-note">💡 本策略包含「替换 / 删除 / 合并」等结构性 edit 操作，此处仅展示 add 类的绿色插入。批准执行时会严格按 operations 生效。</div>');
    }
    if (!anyAdd && !hasStructuralOp) {
      parts.unshift('<div class="am-diff-note">⚠️ 当前 operations 为空，批准后不会产生任何正文变更。</div>');
    }
    return parts.join('');
  }
  function _renderApprovalOpsList(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      return '<div class="am-ops-empty">⚠️ 无具体操作（operations 为空）</div>';
    }
    var html = '';
    for (var i = 0; i < operations.length; i++) {
      var op = operations[i];
      var type = op.type || 'add';
      var pos = op.pos != null ? ('行 ' + op.pos) : '文末';
      var anchor = op.anchorBlockId ? (' · anchor=' + op.anchorBlockId) : '';
      var linesPreview = '';
      if (op.payload && Array.isArray(op.payload.lines)) {
        var max = op.payload.lines.length;
        var show = op.payload.lines.slice(0, 6);
        var suffix = max > 6 ? ('<div class="am-ops-more">... 另有 ' + (max - 6) + ' 行未展示</div>') : '';
        linesPreview = '<pre class="am-ops-preview">' + _escapeHtml(show.join('\n')) + '</pre>' + suffix;
      } else if (op.payload && op.payload.text != null) {
        linesPreview = '<pre class="am-ops-preview">' + _escapeHtml(String(op.payload.text)) + '</pre>';
      } else if (op.payload && op.payload.toReplaceMd != null) {
        linesPreview = '<div class="am-ops-note">结构性 replace：匹配到原内容后替换</div>';
      } else {
        linesPreview = '<div class="am-ops-note">（操作无文本 payload）</div>';
      }
      var typeClass = 'am-op-type-' + type;
      html += '<div class="am-op-item">'
        + '<div class="am-op-head">'
        + '<span class="am-op-type ' + typeClass + '">' + _escapeHtml(type) + '</span>'
        + '<span class="am-op-pos">' + pos + anchor + '</span>'
        + '</div>'
        + linesPreview
        + '</div>';
    }
    return html;
  }
  async function openApprovalModal(cmdId) {
    if (!cmdId) return;
    if (typeof CommandQueue === 'undefined' || !CommandQueue.getCommand) {
      alert('CommandQueue 未就绪');
      return;
    }
    var cmd = null;
    try { cmd = await CommandQueue.getCommand(cmdId); } catch (e) { cmd = null; }
    if (!cmd) { alert('指令未找到（可能已删除）'); return; }
    _approvalCurrentCmdId = cmdId;
    var el = _ensureApprovalModal();
    el.style.display = 'flex';
    var statusMap = {
      pending:'待处理', strategizing:'策略设计中', strategy_ready:'策略就绪', awaiting_approval:'待审批',
      approved:'已批准', applying:'执行中', done:'已完成', failed:'失败', rejected:'已拒绝', rolled_back:'已撤回'
    };
    var plan = cmd.plan || {};
    var meta = plan.meta || {};
    var intentType = meta.intentType || (cmd.type || 'edit');
    var inferred = meta.inferredCategory || '';
    var preMd = (cmd.snapshot && (cmd.snapshot.mdContent || cmd.snapshot.noteMd)) || '';
    var postMd = _applyOpsPreview(preMd, plan.operations);

    var qs = function(s) { return el.querySelector(s); };
    qs('.am-raw').textContent = cmd.raw || '(空指令)';
    qs('.am-intent').textContent = intentType + (inferred ? ' / ' + inferred : '');
    qs('.am-status').textContent = (statusMap[cmd.status] || cmd.status)
      + (cmd.plan && Array.isArray(cmd.plan.operations) ? (' · ' + cmd.plan.operations.length + ' 项操作') : '');
    qs('.am-reason').value = plan.reason || '(AI 未给出理由)';
    qs('.am-ops-list').innerHTML = _renderApprovalOpsList(plan.operations);
    qs('.am-diff-box').innerHTML = _renderApprovalDiffBox(preMd, postMd, plan.operations);
    // 2026-08-18：审批阶段即可见 AI 连接状态与将写入正文的内容（此前非 edit 指令的 contentMd
    // 只在批准写入正文后才可见，用户无法在批准前发现"AI 未连通 / 只会产出占位"）
    var warnSec = qs('.am-ai-warn-section');
    if (warnSec) {
      var warnBox = qs('.am-ai-warn');
      if (plan.aiError) {
        if (warnBox) warnBox.textContent = plan.aiError;
        warnSec.style.display = '';
      } else {
        warnSec.style.display = 'none';
      }
    }
    var cmSec = qs('.am-content-section');
    if (cmSec) {
      var cmBox = qs('.am-content-preview');
      var cmText = (plan.contentMd && String(plan.contentMd).trim()) ? String(plan.contentMd) : '';
      if (cmText) {
        try { if (cmBox) cmBox.innerHTML = renderMarkdown(cmText); } catch (e) { if (cmBox) cmBox.textContent = cmText; }
        try { if (cmBox) _resolvePreviewImages(cmBox); } catch (e) {}
        cmSec.style.display = '';
      } else {
        cmSec.style.display = 'none';
      }
    }
  }

  // 2026-08-15 P2 重构：书签栏 → 历史任务栏
  // 审批通过的任务已直接执行到正文，此面板仅做已完成任务的查看记录
  // 移除 toggle/accept/revert 按钮，保留：详情展开 + diff 可视化 + 删除
  async function renderBookmarks(pageId) {
    var listEl = document.getElementById('bookmarkList');
    if (!listEl) return;
    if (!pageId) pageId = currentPageId;
    if (!pageId) { listEl.innerHTML = ''; return; }

    var list = [];
    try { list = await DataLayer.listBookmarks(pageId); } catch (e) { list = []; }

    if (!list.length) {
      listEl.innerHTML = '<div class="bookmark-empty">暂无历史任务。审批通过的 AI 任务完成后会自动记录在这里。</div>';
      return;
    }

    var html = '';
    list.forEach(function(bm) {
      var bmId = _escapeHtml(bm.id || '');
      var title = _escapeHtml(bm.title || bm.summary || 'AI 任务');
      var opCount = (Array.isArray(bm.operations) && bm.operations.length)
        ? ' · ' + bm.operations.length + ' 项操作' : '';
      var hasDiff = Array.isArray(bm.diff) && bm.diff.length;

      html += '<div class="bookmark-item bm-history" data-bookmark-id="' + bmId + '">'
        + '<div class="bm-main" data-act="expand" title="点击展开 / 收起详情">'
        + '<span class="bm-dot bm-dot-done"></span>'
        + '<span class="bm-title">' + title + '</span>'
        + '<span class="bm-expand-icon">▾</span>'
        + '</div>'
        + '<div class="bm-meta">已完成' + opCount + ' · ' + _fmtBookmarkTime(bm.createdAt) + '</div>'
        + _renderBookmarkDetail(bm)
        + '<div class="bm-actions">'
        + (hasDiff ? '<button class="bm-btn bm-btn-diff" data-act="view-diff">查看变更</button>' : '')
        + '<button class="bm-btn bm-btn-del" data-act="del">删除</button>'
        + '</div></div>';
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll('.bookmark-item').forEach(function(item) {
      var id = item.getAttribute('data-bookmark-id');
      var main = item.querySelector('.bm-main');
      if (main) {
        main.addEventListener('click', function() {
          var detail = item.querySelector('.bm-detail');
          if (!detail) return;
          var open = detail.style.display === 'block';
          detail.style.display = open ? 'none' : 'block';
          var icon = main.querySelector('.bm-expand-icon');
          if (icon) icon.textContent = open ? '▾' : '▴';
        });
      }
      item.querySelectorAll('.bm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var act = btn.getAttribute('data-act');
          if (act === 'del') { deleteBookmark(pageId, id); }
          else if (act === 'view-diff') {
            var detail = item.querySelector('.bm-detail');
            if (detail) {
              detail.style.display = 'block';
              var icon = item.querySelector('.bm-expand-icon');
              if (icon) icon.textContent = '▴';
              if (detail.scrollIntoView) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }
        });
      });
    });
  }

  // 复现 / 回退一次 AI 编辑：
  // edit 类按 diff 重建 old/new，与当前正文比较后 toggle；非 edit 类按 contentMd + 快照 toggle
  async function toggleBookmark(pageId, bookmarkId) {
    if (!pageId) pageId = currentPageId;
    if (!pageId || !bookmarkId) return;

    var list = [];
    try { list = await DataLayer.listBookmarks(pageId); } catch (e) { list = []; }
    var bm = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === bookmarkId) { bm = list[i]; break; }
    }
    if (!bm) return;

    var currentMd = await DataLayer.getPageMd(pageId);

    if (bm.type === 'edit' && Array.isArray(bm.diff) && bm.diff.length > 0) {
      var rec = _reconstructFromDiff(bm.diff);
      var nextMd = (currentMd === rec.newMd) ? rec.oldMd : rec.newMd;
      await DataLayer.putPageMd(pageId, nextMd);
    } else {
      var targetMd = bm.contentMd || '';
      if (_bookmarkBeforeMd[bookmarkId] !== undefined) {
        await DataLayer.putPageMd(pageId, _bookmarkBeforeMd[bookmarkId]);
        delete _bookmarkBeforeMd[bookmarkId];
      } else {
        _bookmarkBeforeMd[bookmarkId] = currentMd;
        await DataLayer.putPageMd(pageId, targetMd);
      }
    }

    // 同步内存页对象并重渲染当前页（renderPage 内部会再次渲染书签栏）
    var page = _findPageById(pageId);
    if (page) page.mdContent = await DataLayer.getPageMd(pageId);
    renderPage(pageId);
  }

  // 删除单个书签
  async function deleteBookmark(pageId, bookmarkId) {
    if (!pageId) pageId = currentPageId;
    if (!pageId || !bookmarkId) return;
    try { await DataLayer.removeBookmark(pageId, bookmarkId); } catch (e) {}
    delete _bookmarkBeforeMd[bookmarkId];
    renderBookmarks(pageId);
  }

  // 展开 / 收起书签栏
  function toggleBookmarkPanel() {
    var panel = document.getElementById('bookmarkPanel');
    if (!panel) return;
    var open = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = open ? 'flex' : 'none';
    if (open) renderBookmarks(currentPageId);
  }

  // ============================================================
  // MD 双模式编辑（v2）— 预览 / 编辑双态 + CodeMirror 6 接入
  // ============================================================

  /** 按 id 查找当前笔记本中的页对象 */
  function _findPageById(pageId) {
    if (!currentNotebook || !currentNotebook.pages) return null;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === pageId) return currentNotebook.pages[i];
    }
    return null;
  }

  // 2026-08-15 P1 修复：外部模块（AIEngine）写 DataLayer 后，同步内存 page.mdContent
  // 这样 renderPage 才能渲染最新内容，不需要用户手动点书签 toggle
  function syncPageMd(pageId, newMd) {
    var page = _findPageById(pageId);
    if (page) {
      page.mdContent = newMd;
      // 如果当前正在显示这一页，且 MD 模式下 CodeMirror 已存在，也同步 CodeMirror
      if (pageId === currentPageId && mdModeActive) {
        try {
          var _cm = (typeof window !== 'undefined' && window.__cm) ? window.__cm : null;
          var _host = document.getElementById('mdEditorHost');
          if (_cm && _host && _cm.EditorView && _cm.EditorView.findFromDOM) {
            var _view = _cm.EditorView.findFromDOM(_host);
            if (_view) {
              _view.dispatch({ changes: { from: 0, to: _view.state.doc.length, insert: newMd } });
            }
          }
        } catch (e) {}
      }
    }
    return !!page;
  }

  /** 切换 MD 子态：预览 <-> 源码（工具栏「MD」按钮，默认恒处 MD 模式） */
  function toggleMdMode() {
    if (!mdModeActive) mdModeActive = true;
    var page = _findPageById(currentPageId);
    if (!page) return;
    _setMdSubMode(mdSubMode === 'edit' ? 'preview' : 'edit', page);
  }

  /** 异步迁移 + 渲染 MD 双态（令牌防竞态） */
  async function _renderMdModeAsync(page) {
    var token = ++_mdRenderToken;
    // 首次进入 MD 模式且 mdContent 为空时，从 blocks 迁移为 MD 原文
    if (page.mdContent === undefined || page.mdContent === null || String(page.mdContent).trim() === '') {
      try {
        var md = await DataLayer.migratePageToMd(page.id);
        page.mdContent = md || '';
      } catch (e) {
        console.warn('MD 迁移失败，回退为空内容:', e);
        page.mdContent = '';
      }
    }
    // 异步期间可能已切页 / 切模式，令牌不匹配则放弃渲染
    if (token !== _mdRenderToken || !mdModeActive) return;
    _buildMdModeDom(page);
  }

  /** 构建 MD 模式内容区（工具栏已常驻，由 _ensureMdToolbar 创建） */
  function _buildMdModeDom(page) {
    if (!contentEl) return;

    // 确保工具栏存在
    _ensureMdToolbar();

    // 创建/替换内容区
    var existingArea = contentEl.querySelector('#mdModeContent');
    if (existingArea) existingArea.remove();

    var area = document.createElement('div');
    area.className = 'md-mode-content';
    area.id = 'mdModeContent';
    contentEl.appendChild(area);

    _renderMdSubMode(page);
  }

  // 2026-08-18：预览态末尾空输入行补齐——统计末尾连续空 P 段落，不足则追加 <p><br></p>。
  // 解决「每次都要先换行才能编辑下一行」的体验问题：点击任意空行即可直接输入，
  // 输入后空行仍保持在最下方，永不污染 mdContent（htmlToMarkdown 后经 md.trim() 清理）。
  var _PREVIEW_TRAILING_LINES = 20;
  function _ensurePreviewTrailingLines(preview, target) {
    if (!preview || !preview.appendChild) return;
    target = (typeof target === 'number' && target > 0) ? target : _PREVIEW_TRAILING_LINES;
    var nodes = preview.childNodes;
    var blank = 0;
    var i = nodes.length - 1;
    while (i >= 0) {
      var n = nodes[i];
      var isBlankP = (n.nodeType === 1 && n.tagName === 'P' && !(n.textContent || '').trim());
      if (!isBlankP) break;
      blank++;
      i--;
    }
    var need = target - blank;
    for (var k = 0; k < need; k++) {
      var p = document.createElement('p');
      p.innerHTML = '<br>';
      preview.appendChild(p);
    }
  }

  /** 渲染 MD 子态：预览态 / 编辑态 */
  function _renderMdSubMode(page) {
    var area = document.getElementById('mdModeContent');
    if (!area) return;
    area.innerHTML = '';

    // 更新子态工具栏激活样式 + 主工具栏「MD」按钮文案（预览<->源码）
    var btnMdMain = document.getElementById('btnToggleMdMode');
    if (btnMdMain) btnMdMain.textContent = (mdSubMode === 'edit') ? '预览' : '源码';

    var btns = contentEl.querySelectorAll('.md-mode-btn');
    for (var i = 0; i < btns.length; i++) {
      var isActive = (mdSubMode === 'preview' && btns[i].textContent === '预览') ||
                     (mdSubMode === 'edit' && btns[i].textContent === '源码');
      btns[i].className = 'md-mode-btn' + (isActive ? ' active' : '');
    }

    if (mdSubMode === 'edit') {
      // 编辑态：CodeMirror 源码编辑（兼容 ESM 模块延迟加载——最多等 5s）
      // 2026-08-17：进入编辑模式前先把 mdContent 中的 HTML 源码块持久化迁移为 @[html:ID] 占位符，
      // 保证源码编辑区绝无 HTML 源码（否则与 Markdown 渲染冲突）
      try { _persistMigrateHtmlBlocks(page); } catch (e) {}
      var host = document.createElement('div');
      host.id = 'mdEditorHost';
      host.className = 'md-editor-host';
      area.appendChild(host);

      function _tryBuildCm(attemptLeft) {
        var cm = (typeof window !== 'undefined' && window.__cm) ? window.__cm : null;
        if (!cm) {
          if ((attemptLeft | 0) > 0) {
            host.innerHTML = '<div class="notebook-empty" style="padding:18px;">⏳ 编辑器加载中…(' + Math.ceil((attemptLeft|0) * 0.1) + 's)</div>';
            setTimeout(function () { _tryBuildCm((attemptLeft | 0) - 1); }, 100);
          } else {
            host.innerHTML = '<div class="notebook-empty">CodeMirror 加载超时，请检查 <code>lib/codemirror/codemirror.bundle.js</code> 是否存在，或刷新页面重试。</div>';
          }
          return;
        }
        host.innerHTML = '';
        cmView = new cm.EditorView({
          doc: page.mdContent || '',
          extensions: [
            cm.basicSetup,
            cm.markdown({ base: cm.markdownLanguage }),
            cm.EditorView.updateListener.of(function(update) {
              if (update.docChanged) _onMdEditorChange();
            })
          ],
          parent: host
        });
        cmViewPageId = page.id;
      }

      // 如 __cm 还没准备好，优先订阅 __cmReady 事件；否则直接构建
      if ((typeof window !== 'undefined' && window.__cm) || window.__cmReadyFlag) {
        _tryBuildCm(0);
      } else {
        var fired = false;
        try {
          document.addEventListener('__cmReady', function once() {
            if (fired) return; fired = true;
            document.removeEventListener('__cmReady', once);
            _tryBuildCm(0);
          });
        } catch (e) {}
        // 兜底轮询上限 50 × 100ms = 5s
        _tryBuildCm(50);
      }
    } else {
      // 预览态：marked 渲染 mdContent（横线笔记本样式）+ 所见即所得编辑
      var preview = document.createElement('div');
      preview.className = 'md-preview md-content md-ruled-notebook';
      preview.setAttribute('contenteditable', 'true');
      preview.setAttribute('data-md-preview', '1');
      if (page.mdContent && String(page.mdContent).trim() !== '') {
        preview.innerHTML = renderMarkdown(page.mdContent);
        // 2026-08-19 图片：异步加载 IndexedDB 中的图片并应用尺寸/对齐设置
        try { _resolvePreviewImages(preview); } catch (e) {}
      } else {
        preview.innerHTML = '<p><br></p>';
      }
      // 2026-08-18：渲染后末尾补足空输入行（点击任意空行即可直接输入）
      try { _ensurePreviewTrailingLines(preview); } catch (e) {}
      preview.classList.add('preview-mode-active');
      preview.addEventListener('input', function() { _onMdPreviewInput(page, preview); });
      preview.addEventListener('blur', function() { _onMdPreviewBlur(page, preview); });
      area.appendChild(preview);
      // 2026-08-15 扩展：初始化流程图 Canvas 编辑器（HTML 块 iframe 由 postMessage 自适应高度，无需在此初始化）
      _initDiagramBlocks(preview, true);
      // 绑定流程图/HTML块的 AI 改进 + 删除按钮
      _initBlockActionButtons(preview, page);
      // 绑定块的拖拽 + 调整大小（仅预览模式生效）
      _initBlockResizeAndDrag(preview, page);
      // 2026-08-19 图片：绑定点击 → 尺寸/对齐/删除 浮动操作条
      try { _bindImageInteractions(preview); } catch (e) {}
    }
    // 最后再同步一次工具栏启用/禁用状态（防止被样式更新覆盖）
    _updateToolbarState();
  }

  /** 切换 MD 子态 */
  function _setMdSubMode(mode, page) {
    if (mdSubMode === mode) return;
    // 切出前先 flush 未落盘内容：源码态销毁 CM 编辑器，预览态写回 WYSIWYG 内容
    if (mdSubMode === 'edit') {
      _destroyCmView();
    } else if (mdSubMode === 'preview') {
      _flushPreviewBeforeSwitch(page);
    }
    mdSubMode = mode;
    _renderMdSubMode(page);
  }

  /** 销毁 CodeMirror 编辑器实例（先 flush 未落盘内容） */
  function _destroyCmView() {
    if (mdSaveTimer) { clearTimeout(mdSaveTimer); mdSaveTimer = null; }
    if (cmView) {
      _flushMdContent();
      cmView.destroy();
      cmView = null;
      cmViewPageId = null;
    }
  }

  /** 聚焦 MD 编辑区（源码态聚焦 CM，预览态聚焦所见即所得编辑区） */
  function _focusMdEditor() {
    if (mdSubMode === 'edit' && cmView) { cmView.focus(); return; }
    var preview = contentEl ? contentEl.querySelector('.md-preview[contenteditable="true"]') : null;
    if (preview) preview.focus();
  }

  /** 实时同步「正在书写」的 、、指令（源码态，输入第二个 、 即触发，无需等闭合/防抖） */
  function _syncLiveFromCm() {
    if (!cmView) return;
    var page = _findPageById(cmViewPageId);
    if (!page) return;
    var md = cmView.state.doc.toString();
    if (typeof CommandQueue !== 'undefined' && CommandQueue.syncLive) {
      CommandQueue.syncLive(md, page.id, page.notebookId);
    }
  }

  /** 实时同步「正在书写」的指令（预览态，textContent 快速短路后再走防抖写回） */
  function _syncLiveFromPreview(page, previewEl) {
    if (!page || !previewEl) return;
    var text = previewEl.textContent || '';
    // 任意开头符号出现才继续（否则无需 syncLive）
    var d = _getCmdDelimiters();
    var need = false;
    for (var k = 0; k < d.open.length; k++) { if (text.indexOf(d.open[k]) >= 0) { need = true; break; } }
    if (!need) return;
    var md = '';
    try {
      md = (typeof MDConverter !== 'undefined' && MDConverter.htmlToMarkdown)
        ? MDConverter.htmlToMarkdown(previewEl.innerHTML)
        : text;
    } catch (e) {
      md = text;
    }
    if (typeof CommandQueue !== 'undefined' && CommandQueue.syncLive) {
      CommandQueue.syncLive(md, page.id, page.notebookId);
    }
  }

  // ============================================================
  // 实时指令书写格式（需求：输入任意开头符号后，后续文字实时切换为指令格式）
  // 仅对 contentEditable 所见即所得编辑区生效（预览态 + 块编辑态）。
  // 策略：找到任意「开头符号」起始标记（且尚未出现任一「结尾符号」），将其后到当前
  // 文本末尾的内容包成 <span class="cmd-live">，光标恢复到包裹前位置，
  // 后续输入自然继承该样式；出现「结尾符号」后撤销包裹，交由胶囊渲染接管。
  // ============================================================

  /** 在 text 中查找最靠后的任意「开头符号」的位置，返回 { idx, op } 或 null */
  function _lastOpenMarker(text) {
    var d = _getCmdDelimiters();
    var best = -1, bestOp = null;
    for (var i = 0; i < d.open.length; i++) {
      var op = d.open[i]; if (!op) continue;
      var idx = text.lastIndexOf(op);
      if (idx > best) { best = idx; bestOp = op; }
    }
    return bestOp ? { idx: best, op: bestOp } : null;
  }
  /** 在 text 中查找任一「结尾符号」的位置，返回首次出现下标（未找到 -1） */
  function _firstCloseMarkerAfter(text, fromIdx) {
    var d = _getCmdDelimiters();
    var best = -1;
    for (var i = 0; i < d.close.length; i++) {
      var cl = d.close[i]; if (!cl) continue;
      var idx = text.indexOf(cl, fromIdx);
      if (idx >= 0 && (best < 0 || idx < best)) best = idx;
    }
    return best;
  }

  /** 计算 contentEditable 内光标相对整段的字符偏移（-1 表示无法计算） */
  function _caretOffsetIn(editable) {
    try {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return -1;
      var range = sel.getRangeAt(0);
      var pre = range.cloneRange();
      pre.selectNodeContents(editable);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    } catch (e) { return -1; }
  }

  /** 按字符偏移恢复光标到 contentEditable（尽量落到文本节点） */
  function _setCaretOffset(editable, offset) {
    try {
      if (offset < 0) return;
      var walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, null);
      var node, total = 0;
      while ((node = walker.nextNode())) {
        var len = node.nodeValue.length;
        if (total + len >= offset) {
          var range = document.createRange();
          range.setStart(node, offset - total);
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
        total += len;
      }
      var sel2 = window.getSelection();
      sel2.selectAllChildren(editable);
      sel2.collapseToEnd();
    } catch (e) {}
  }

  /** 撤销编辑区内已有的 .cmd-live 包裹（还原为纯文本，保留光标） */
  function _clearLiveCmdStyle(editable) {
    var spans = editable.querySelectorAll('.cmd-live');
    if (!spans.length) return;
    var caret = _caretOffsetIn(editable);
    spans.forEach(function(sp) {
      var parent = sp.parentNode;
      if (!parent) return;
      while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
      parent.removeChild(sp);
    });
    editable.normalize();
    if (caret >= 0) _setCaretOffset(editable, caret);
  }

  /** 从字符偏移位置到 editable 末尾创建 Range（供包裹 .cmd-live 使用） */
  function _rangeFromTextOffset(editable, offset) {
    var walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, null);
    var node, total = 0, startNode = null, startOff = 0;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (startNode === null && total + len >= offset) {
        startNode = node;
        startOff = offset - total;
        break;
      }
      total += len;
    }
    if (!startNode) return null;
    var walker2 = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, null);
    var lastNode = null;
    while ((node = walker2.nextNode())) lastNode = node;
    if (!lastNode) return null;
    var range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(lastNode, lastNode.nodeValue.length);
    return range;
  }

  /** 实时格式主函数：未闭合「开头符号」→ 包裹 .cmd-live；已闭合 → 清除包裹 */
  function _applyLiveCmdStyle(editable) {
    if (!editable || _liveCmdStyling) return;
    var text = editable.textContent || '';
    var openHit = _lastOpenMarker(text);
    var hasLiveSpan = editable.querySelector('.cmd-live');

    // 无起始标记 → 清除遗留包裹
    if (!openHit) {
      if (hasLiveSpan) _clearLiveCmdStyle(editable);
      return;
    }
    var openIdx = openHit.idx + openHit.op.length;
    var after = text.slice(openIdx);
    var closed = _firstCloseMarkerAfter(after, 0) >= 0;
    if (closed) {
      if (hasLiveSpan) _clearLiveCmdStyle(editable);
      return;
    }
    // 未闭合且已包裹 → 保持现状
    if (hasLiveSpan) return;

    _liveCmdStyling = true;
    try {
      var caret = _caretOffsetIn(editable);
      var range = _rangeFromTextOffset(editable, openIdx);
      if (range) {
        var span = document.createElement('span');
        span.className = 'cmd-live';
        range.surroundContents(span);
        editable.normalize();
        if (caret >= 0) _setCaretOffset(editable, caret);
      }
    } catch (e) {
      // 跨节点/边界包裹失败：静默降级，不影响指令识别
    } finally {
      _liveCmdStyling = false;
    }
  }

  /** 立即把编辑器内容写回 page 并持久化（不等待防抖） */
  async function _flushMdContent() {
    if (!cmView) return;
    if (_warnBackgroundMode('编辑 Markdown 源码')) return;
    var page = _findPageById(cmViewPageId);
    if (!page) return;
    var md = cmView.state.doc.toString();
    page.mdContent = md;
    page.updatedAt = Date.now();
    // 先落盘最新 mdContent，再触发指令同步（确保 AI 接手执行时读到最新正文）
    await DataLayer.putPageMd(page.id, md);
    // P3：mdContent 变更 → 检测 、、指令。。 增量入队（闭合后由 syncFromText 自动触发 run）
    if (typeof CommandQueue !== 'undefined' && CommandQueue.syncFromText) {
      await CommandQueue.syncFromText(md, page.id, page.notebookId);
    }
  }

  /** 编辑态输入 → 防抖 800ms 保存 */
  function _onMdEditorChange() {
    // 实时：输入第二个 、 即触发指令识别入队（不等 800ms 防抖，也不等闭合标记）
    _syncLiveFromCm();
    if (mdSaveTimer) clearTimeout(mdSaveTimer);
    mdSaveTimer = setTimeout(function() {
      mdSaveTimer = null;
      _flushMdContent();
    }, 800);
  }

  /** 预览态 WYSIWYG：把当前 HTML 转回 Markdown 写回 mdContent（统一入口） */
  // 在 DOM 序列化前，先把 html-block-container / diagram-block 替换为对应的占位符段落，
  // 避免 MDConverter.htmlToMarkdown 把 iframe 等 HTML 语法当成正文转义，
  // 导致 mdContent 中再次出现内联 HTML 源码 → 再次渲染时双重编码
  function _prepPreviewHtmlForConvert(previewEl) {
    if (!previewEl) return '';
    // 在副本上操作，不影响真实 DOM
    var tmpWrap = document.createElement('div');
    tmpWrap.innerHTML = previewEl.innerHTML;
    // 1) HTML 块 → <p>@[html:ID]</p>
    var htmlBlocks = tmpWrap.querySelectorAll('.html-block-container');
    for (var i = 0; i < htmlBlocks.length; i++) {
      var blk = htmlBlocks[i];
      var keep = blk.querySelector('.html-source');
      var id = blk.getAttribute ? blk.getAttribute('data-html-id') : null;
      var placeholder = (keep && keep.textContent) ? keep.textContent.trim()
        : (id ? ('@[html:' + id + ']') : '');
      if (!placeholder) {
        // 非常旧的形态：从 data-html 恢复（尽量不丢内容）
        var b64 = blk.getAttribute ? blk.getAttribute('data-html') : null;
        if (b64) {
          try {
            var raw = atob(b64);
            var newId = _generateHtmlId();
            saveHtml(newId, raw);
            placeholder = '@[html:' + newId + ']';
          } catch (e) {}
        }
      }
      if (placeholder) {
        var repl = document.createElement('p');
        repl.textContent = placeholder;
        // 移除前后相邻的纯空 <p><br></p>（避免回写后多空行）
        var pv = blk.previousElementSibling;
        var nx = blk.nextElementSibling;
        blk.parentNode.replaceChild(repl, blk);
        if (pv && pv.tagName === 'P' && pv.innerHTML.replace(/\s|<br\s*\/?>/gi, '') === '') pv.remove();
        if (nx && nx.tagName === 'P' && nx.innerHTML.replace(/\s|<br\s*\/?>/gi, '') === '') nx.remove();
      }
    }
    // 2) 流程图块 → <p>@[diagram:ID]</p>
    var diagramBlocks = tmpWrap.querySelectorAll('.diagram-block');
    for (var j = 0; j < diagramBlocks.length; j++) {
      var dblk = diagramBlocks[j];
      var dkeep = dblk.querySelector('.diagram-source');
      var did = dblk.getAttribute ? dblk.getAttribute('data-diagram-id') : null;
      var dplaceholder = (dkeep && dkeep.textContent) ? dkeep.textContent.trim()
        : (did ? ('@[diagram:' + did + ']') : '');
      if (dplaceholder) {
        var drepl = document.createElement('p');
        drepl.textContent = dplaceholder;
        var dpv = dblk.previousElementSibling;
        var dnx = dblk.nextElementSibling;
        dblk.parentNode.replaceChild(drepl, dblk);
        if (dpv && dpv.tagName === 'P' && dpv.innerHTML.replace(/\s|<br\s*\/?>/gi, '') === '') dpv.remove();
        if (dnx && dnx.tagName === 'P' && dnx.innerHTML.replace(/\s|<br\s*\/?>/gi, '') === '') dnx.remove();
      }
    }
    return tmpWrap.innerHTML;
  }

  async function _flushMdPreview(page, previewEl) {
    if (!page || !previewEl) return;
    // 背景模式：只读到内存里展示，不落盘也不改 page 持久化对象，避免用户无意写入默认共享笔记
    if (_warnBackgroundMode('编辑 Markdown 内容')) return;
    var md = '';
    try {
      var safeHtml = _prepPreviewHtmlForConvert(previewEl);
      md = (typeof MDConverter !== 'undefined' && MDConverter.htmlToMarkdown)
        ? MDConverter.htmlToMarkdown(safeHtml)
        : previewEl.textContent;
    } catch (e) {
      md = previewEl.textContent || '';
    }
    md = md.trim();
    page.mdContent = md;
    page.updatedAt = Date.now();
    // 先落盘最新 mdContent，再触发指令同步（确保 AI 接手执行时读到最新正文）
    await DataLayer.putPageMd(page.id, md);
    // P3：mdContent 变更 → 检测 、、指令。。 增量入队（闭合后由 syncFromText 自动触发 run）
    if (typeof CommandQueue !== 'undefined' && CommandQueue.syncFromText) {
      await CommandQueue.syncFromText(md, page.id, page.notebookId);
    }
  }

  /** 预览态输入 → 防抖写回（不重渲染，保留光标） */
  function _onMdPreviewInput(page, previewEl) {
    // 2026-08-18：输入后末尾空输入行保持补足（不移动光标；用户在新空行里输入 → 该行变实 → 末尾自动再补一行）
    try { _ensurePreviewTrailingLines(previewEl); } catch (e) {}
    // 实时：输入第二个 、 即触发指令识别入队（textContent 快速短路后再走防抖写回）
    _syncLiveFromPreview(page, previewEl);
    // 实时：未闭合「、、」后续文字切换为指令书写格式（所见即所得）
    _applyLiveCmdStyle(previewEl);
    if (mdSaveTimer) clearTimeout(mdSaveTimer);
    mdSaveTimer = setTimeout(function() {
      mdSaveTimer = null;
      _flushMdPreview(page, previewEl);
    }, 800);
  }

  /** 预览态失焦 → 立即写回 + 重渲染规范化 */
  function _onMdPreviewBlur(page, previewEl) {
    if (mdSaveTimer) { clearTimeout(mdSaveTimer); mdSaveTimer = null; }
    _flushMdPreview(page, previewEl);
    if (mdModeActive && mdSubMode === 'preview') {
      _renderMdSubMode(page);
    }
  }

  /** 切出预览态前 flush（供 _setMdSubMode 调用，避免丢字） */
  function _flushPreviewBeforeSwitch(page) {
    if (mdSaveTimer) { clearTimeout(mdSaveTimer); mdSaveTimer = null; }
    var preview = document.querySelector('.md-preview[contenteditable="true"]');
    _flushMdPreview(page, preview);
  }

  // ---------- 渲染单个块（自由横线纸风格：无边框、无角标） ----------
  // AI 生成的块渲染为 Markdown（表格/标题/列表等美观展示），
  // 点击块即进入无框原文编辑（与普通笔记一致的直接打字体验），失焦后自动保存并重新渲染。
  function _renderBlock(block, index, total) {
    var div = document.createElement('div');
    div.className = 'note-block';
    div.setAttribute('data-block-id', block.id);
    // 计算块序号与总数（用于上移/下移按钮的边界禁用）
    if (typeof index !== 'number') index = _getBlockIndex(block.id);
    if (typeof total !== 'number') { var _pg = _getCurrentPageObj(); total = _pg ? _pg.blocks.length : 0; }
    // AI 生成的块默认可直接编辑（所见即所得：直接在渲染的表格/内容里修改，
    // 失焦自动转回 Markdown 保存）；hover 显示"原文"按钮可切换 Markdown 原文编辑（次选）
    var isAiBlock = block.aiGenerated || block.type === 'ai-result' || block.type === 'ai-placeholder';

    // 真正可编辑的内容容器：与左侧 gutter 工具簇（⠿↑↓✕）隔离，避免两大问题：
    //  1) 空块的 editable 内只有不可编辑的工具簇子节点 → 光标无法落入，首字打不进；
    //  2) 工具簇文字被误当作块内容存进 IndexedDB 从而污染每条笔记。
    var content = document.createElement('div');
    content.className = 'note-block-content';
    content.setAttribute('contenteditable', block.lock ? 'false' : 'true');

    switch (block.type) {
      case 'heading':
        div.classList.add('heading');
        content.textContent = block.content;
        break;

      case 'quote':
        div.classList.add('quote');
        content.textContent = block.content;
        break;

      case 'pdf-ref':
        div.classList.add('pdf-ref');
        content.textContent = block.content;
        // 页码以行内文字形式附在末尾（非角标）
        if (block.pdfRef && block.pdfRef.pageNum) {
          var refSpan = document.createElement('span');
          refSpan.className = 'ref-page';
          refSpan.textContent = ' (P.' + block.pdfRef.pageNum + ')';
          refSpan.setAttribute('contenteditable', 'false');
          content.appendChild(refSpan);
        }
        break;

      case 'ai-result':
        // AI 输出：渲染 Markdown（保留手写体风格），点击进入原文编辑
        div.classList.add('ai-result');
        _renderBlockContent(content, block);
        break;

      case 'ai-placeholder':
        // AI 输出占位：生成期间不可编辑，完成后渲染 Markdown
        div.classList.add('ai-placeholder');
        if (block.lock) {
          content.setAttribute('contenteditable', 'false');
          div.classList.add('streaming');
          content.textContent = block.content || '思考中...';
        } else {
          div.classList.add('done');
          _renderBlockContent(content, block);
        }
        break;

      case 'command':
        div.classList.add('command');
        // 根据状态添加 CSS class，前缀标志由 CSS ::before 控制
        if (block.status === 'pending') {
          div.classList.add('status-pending');
          content.textContent = block.content; // 保留原始内容（含结束标志）
        } else if (block.status === 'complete') {
          div.classList.add('status-complete');
          // 已完成：去除结尾的结束标志
          content.textContent = stripCommandEndMarker(block.content);
        } else {
          // 默认状态（未触发）：▸ 前缀由 CSS 控制
          content.textContent = block.content;
        }
        break;

      case 'focus':
        div.classList.add('focus');
        content.textContent = block.content;
        break;

      case 'text':
      default:
        // AI 生成的文本块渲染 Markdown；用户手写块保持纯文本
        if (block.aiGenerated) {
          _renderBlockContent(content, block);
        } else if (block.content && block.content.trim().startsWith('/') && !block.status) {
          // 用户正在输入 / 指令（尚未触发）：显示 ▸ 前缀
          div.classList.add('command');
          content.textContent = block.content;
        } else if (block.content && block.content.trim().startsWith('/') && block.status) {
          // 已触发或已完成的指令块
          div.classList.add('command');
          if (block.status === 'pending') {
            div.classList.add('status-pending');
            content.textContent = block.content;
          } else if (block.status === 'complete') {
            div.classList.add('status-complete');
            content.textContent = stripCommandEndMarker(block.content);
          } else {
            content.textContent = block.content;
          }
        } else {
          content.textContent = block.content;
        }
        break;
    }

    // 应用自定义字体样式（Issue 6）
    if (block.fontSize) div.style.fontSize = block.fontSize;
    if (block.fontColor) div.style.color = block.fontColor;

    // 锁定状态（AI 正在生成时）
    if (block.lock) {
      div.classList.add('locked');
    }

    // AI 生成的块：默认所见即所得编辑；右上角 hover 显示"原文"按钮（次选：编辑 Markdown 原文）
    if (isAiBlock && !block.lock) {
      div.classList.add('ai-wysiwyg');
      (function(bid) {
        var rawBtn = document.createElement('button');
        rawBtn.type = 'button';
        rawBtn.className = 'md-raw-btn';
        rawBtn.textContent = '原文';
        rawBtn.setAttribute('contenteditable', 'false');
        rawBtn.title = '编辑 Markdown 原文（次选）';
        rawBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          _enterAiRawMode(bid);
        });
        content.appendChild(rawBtn);
      })(block.id);
    }

    // ---- 左侧 gutter 操作簇：拖拽手柄 + 上移/下移 + 删除 ----
    var tools = document.createElement('div');
    tools.className = 'note-block-tools';
    tools.setAttribute('contenteditable', 'false');

    // 拖拽手柄（鼠标拖拽排序）
    var grip = document.createElement('span');
    grip.className = 'note-block-grip';
    grip.textContent = '⠿';
    grip.setAttribute('draggable', 'true');
    grip.setAttribute('contenteditable', 'false');
    grip.title = '拖拽排序（也可点击 ↑/↓ 移动）';
    grip.setAttribute('aria-label', '拖拽排序');
    tools.appendChild(grip);

    // 上移
    var upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'note-block-move';
    upBtn.textContent = '↑';
    upBtn.setAttribute('contenteditable', 'false');
    upBtn.title = '上移此块';
    upBtn.setAttribute('aria-label', '上移此块');
    if (index <= 0) upBtn.disabled = true;
    upBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      _moveRelative(block.id, -1);
    });
    tools.appendChild(upBtn);

    // 下移
    var downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'note-block-move';
    downBtn.textContent = '↓';
    downBtn.setAttribute('contenteditable', 'false');
    downBtn.title = '下移此块';
    downBtn.setAttribute('aria-label', '下移此块');
    if (index >= total - 1) downBtn.disabled = true;
    downBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      _moveRelative(block.id, 1);
    });
    tools.appendChild(downBtn);

    // 删除（可删任意块，含非空块）
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'note-block-del';
    delBtn.textContent = '✕';
    delBtn.setAttribute('contenteditable', 'false');
    delBtn.title = '删除此块';
    delBtn.setAttribute('aria-label', '删除此块');
    delBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var blk = _findBlockById(block.id);
      if (blk && blk.content && blk.content.trim()) {
        if (typeof window.confirm === 'function' && !window.confirm('确定删除此笔记块？')) return;
      }
      deleteBlock(block.id);
    });
    tools.appendChild(delBtn);

    div.appendChild(content);
    div.appendChild(tools);

    return div;
  }

  // ============================================================
  // 块拖拽排序 + 上下移动（Task 15）
  // ============================================================

  // 公开：移动块到目标索引（post-removal 语义，与 _execMove 一致）
  function moveBlock(blockId, toIndex) {
    if (!blockId) return null;
    return applyOperation({ type: 'move', targetBlockId: blockId, position: toIndex, source: 'user' });
  }

  // 相对移动（上移/下移一格）
  function _moveRelative(blockId, dir) {
    var page = _getCurrentPageObj();
    if (!page) return;
    var from = _getBlockIndex(blockId);
    if (from < 0) return;
    var to = from + dir;
    if (to < 0 || to >= page.blocks.length) return; // 边界：不移动
    moveBlock(blockId, to);
  }

  // ---------- 拖放事件 ----------
  function _onDragStart(e) {
    var grip = e.target && e.target.closest ? e.target.closest('.note-block-grip') : null;
    if (!grip) return; // 只允许从手柄发起拖拽
    var blockEl = grip.closest('.note-block');
    if (!blockEl) return;
    _dragBlockId = blockEl.getAttribute('data-block-id');
    blockEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', _dragBlockId); } catch (err) { /* 某些环境不支持 */ }
    e.stopPropagation();
  }

  function _onDragOver(e) {
    if (!_dragBlockId) return;
    e.preventDefault(); // 允许放置
    e.dataTransfer.dropEffect = 'move';
    var t = e.target && e.target.closest ? e.target.closest('.note-block') : null;
    if (!t || t.getAttribute('data-block-id') === _dragBlockId) {
      _clearDropIndicator();
      return;
    }
    var rect = t.getBoundingClientRect();
    var before = (e.clientY - rect.top) < rect.height / 2;
    _dropTargetId = t.getAttribute('data-block-id');
    _dropBefore = before;
    var line = _getDropLine();
    if (before) contentEl.insertBefore(line, t);
    else contentEl.insertBefore(line, t.nextSibling);
  }

  function _onDrop(e) {
    if (!_dragBlockId) return;
    e.preventDefault();
    var draggedId = _dragBlockId;
    var targetId = _dropTargetId;
    var before = _dropBefore;
    _clearDropIndicator();
    var dragEl = contentEl.querySelector('[data-block-id="' + draggedId + '"]');
    if (dragEl) dragEl.classList.remove('dragging');
    _dragBlockId = null;

    if (!targetId || targetId === draggedId) return;

    var page = _getCurrentPageObj();
    if (!page) return;
    var from = _getBlockIndex(draggedId);
    if (from < 0) return;
    // 计算放置后的绝对索引（post-removal 语义）
    var sim = page.blocks.slice();
    sim.splice(from, 1);
    var tIdx = -1;
    for (var i = 0; i < sim.length; i++) { if (sim[i].id === targetId) { tIdx = i; break; } }
    if (tIdx < 0) return;
    var insertAt = before ? tIdx : tIdx + 1;
    if (insertAt < 0) insertAt = 0;
    if (insertAt > sim.length) insertAt = sim.length;
    if (insertAt === from) return; // 无位移，跳过
    moveBlock(draggedId, insertAt);
  }

  function _onDragEnd() {
    _clearDropIndicator();
    if (_dragBlockId && contentEl) {
      var dragEl = contentEl.querySelector('[data-block-id="' + _dragBlockId + '"]');
      if (dragEl) dragEl.classList.remove('dragging');
    }
    _dragBlockId = null;
    _dropTargetId = null;
    _dropBefore = false;
  }

  // 复用的放置指示线
  function _getDropLine() {
    if (!_dropLine) {
      _dropLine = document.createElement('div');
      _dropLine.className = 'note-drop-line';
    }
    return _dropLine;
  }

  function _clearDropIndicator() {
    if (_dropLine && _dropLine.parentNode) _dropLine.parentNode.removeChild(_dropLine);
    _dropTargetId = null;
  }

  // ---------- 渲染块内容（Markdown 或纯文本） ----------
  function _renderBlockContent(div, block) {
    var content = block.content || '';
    if (!content) {
      div.textContent = '';
      return;
    }
    // AI 生成的内容渲染为 Markdown
    if (block.aiGenerated || block.type === 'ai-result' || block.type === 'ai-placeholder') {
      var html = renderMarkdown(content);
      var mdDiv = document.createElement('div');
      mdDiv.className = 'md-content';
      mdDiv.innerHTML = html;
      div.appendChild(mdDiv);
    } else {
      div.textContent = content;
    }
  }

  // ---------- WYSIWYG 保存：编辑后的富文本 HTML 转回 Markdown 并持久化 ----------
  function _saveWysiwygBlock(blockId, blockEl) {
    var block = _findBlockById(blockId);
    var el = blockEl || (contentEl ? contentEl.querySelector('[data-block-id="' + blockId + '"]') : null);
    if (!block || !el) return;
    if (el.classList.contains('editing-raw')) return; // 原文编辑模式不在此处理
    var md = '';
    try {
      // 只转换 .md-content 部分（排除"原文"按钮等 UI 元素）
      var mdEl = el.querySelector('.md-content');
      var innerHtml = mdEl ? mdEl.innerHTML : _contentElOf(el).innerHTML;
      md = (typeof MDConverter !== 'undefined' && MDConverter.htmlToMarkdown)
        ? MDConverter.htmlToMarkdown(innerHtml)
        : _contentElOf(el).textContent;
    } catch (e) {
      md = _contentElOf(el).textContent || '';
    }
    md = md.trim();
    if (md === block.content) return; // 无变化，不重渲染
    block.content = md;
    block.timestamp = Date.now();
    if (block._saveTimer) { clearTimeout(block._saveTimer); block._saveTimer = null; }
    _persistBlock(block, currentPageId);
    renderPage(currentPageId);
  }

  // ---------- 进入 AI 块 Markdown 原文编辑模式（次选方案） ----------
  function _enterAiRawMode(blockId) {
    var block = _findBlockById(blockId);
    var el = contentEl ? contentEl.querySelector('[data-block-id="' + blockId + '"]') : null;
    if (!block || !el || block.lock) return;
    if (el.classList.contains('editing-raw')) return;

    // 若正处于 WYSIWYG 编辑，先保存当前内容
    var _inner = _contentElOf(el);
    if (_inner && _inner.getAttribute('contenteditable') === 'true') {
      _saveWysiwygBlock(blockId, el);
      el = contentEl.querySelector('[data-block-id="' + blockId + '"]');
      if (!el) return;
    }

    el.setAttribute('contenteditable', 'false');
    el.classList.add('editing-raw');
    el.innerHTML = '';

    // 文本域编辑 Markdown 原文
    var ta = document.createElement('textarea');
    ta.className = 'md-raw-textarea';
    ta.value = block.content || '';
    ta.setAttribute('contenteditable', 'false');
    el.appendChild(ta);

    // 完成按钮：保存原文并重新渲染
    var doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'md-raw-done';
    doneBtn.textContent = '✓ 完成';
    doneBtn.setAttribute('contenteditable', 'false');
    doneBtn.addEventListener('click', function() {
      block.content = ta.value || '';
      block.timestamp = Date.now();
      _persistBlock(block, currentPageId);
      renderPage(currentPageId);
    });
    el.appendChild(doneBtn);

    ta.focus();
  }

  // ---------- 更新页码信息 ----------
  function _updatePageInfo() {
    if (!pageInfoEl) pageInfoEl = document.getElementById('notebookPageInfo');
    if (!pageInfoEl || !currentNotebook) return;

    var idx = -1;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === currentPageId) {
        idx = i;
        break;
      }
    }
    var pageNum = idx >= 0 ? idx + 1 : 1;

    // 显示页面名称（可点击编辑）
    var page = idx >= 0 ? currentNotebook.pages[idx] : null;
    var pageName = page ? (page.name || ('第 ' + pageNum + ' 页')) : ('第 ' + pageNum + ' 页');
    pageInfoEl.innerHTML = '';
    var nameSpan = document.createElement('span');
    nameSpan.className = 'notebook-page-name';
    nameSpan.textContent = pageName;
    nameSpan.title = '点击编辑页面名称';
    nameSpan.addEventListener('click', _editPageName);
    pageInfoEl.appendChild(nameSpan);

    // 按钮状态
    var btnPrev = document.getElementById('btnPrevNotePage');
    var btnNext = document.getElementById('btnNextNotePage');
    if (btnPrev) btnPrev.disabled = idx <= 0;
    if (btnNext) btnNext.disabled = idx < 0 || idx >= currentNotebook.pages.length - 1;
  }

  // ---------- 编辑页面名称 ----------
  function _editPageName() {
    var nameSpan = pageInfoEl.querySelector('.notebook-page-name');
    if (!nameSpan) return;
    nameSpan.classList.add('editing');
    nameSpan.setAttribute('contenteditable', 'true');
    nameSpan.focus();
    // 全选文字
    try {
      var range = document.createRange();
      range.selectNodeContents(nameSpan);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }

    function finishEdit() {
      nameSpan.removeEventListener('blur', finishEdit);
      nameSpan.removeEventListener('keydown', onKey);
      nameSpan.setAttribute('contenteditable', 'false');
      nameSpan.classList.remove('editing');
      var newName = nameSpan.textContent.trim();
      if (newName && currentPageId) {
        setPageName(currentPageId, newName).then(function() {
          renderNotebookTOC();
        });
      } else {
        _updatePageInfo();
      }
    }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); nameSpan.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); _updatePageInfo(); }
    }
    nameSpan.addEventListener('blur', finishEdit);
    nameSpan.addEventListener('keydown', onKey);
  }

  // ---------- 设置页面名称 ----------
  async function setPageName(pageId, name) {
    if (!currentNotebook) return;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === pageId) {
        currentNotebook.pages[i].name = name;
        currentNotebook.pages[i].updatedAt = Date.now();
        currentNotebook.updatedAt = Date.now();
        await _persistPage(currentNotebook.pages[i]);
        await DataLayer.put('notebooks', currentNotebook);
        if (pageId === currentPageId) _updatePageInfo();
        return;
      }
    }
  }

  // ============================================================
  // 笔记本目录侧边栏（Issue 3）
  // ============================================================

  // ---------- 活页目录管理状态（v140+） ----------
  var _tocBatchMode = false;   // 批量选择模式
  var _tocSelected = {};       // 批量勾选集合 pageId -> true

  function renderNotebookTOC() {
    var tocEl = document.getElementById('notebookTOCList');
    if (!tocEl || !currentNotebook) return;

    tocEl.innerHTML = '';
    _renderTocToolbar();

    if (currentNotebook.pages.length === 0) {
      tocEl.innerHTML = '<div class="notebook-toc-empty">暂无笔记页<br><span style="font-size:11px;opacity:.7">点击上方「＋ 新建」创建第一个页面</span></div>';
      return;
    }

    // 列表空白区拖放 → 移到末尾（一次性绑定）
    if (!tocEl._tocDndBound) {
      tocEl._tocDndBound = true;
      tocEl.addEventListener('dragover', function(e) { if (e.target === tocEl) e.preventDefault(); });
      tocEl.addEventListener('drop', function(e) {
        if (e.target !== tocEl) return;
        e.preventDefault();
        _tocClearDropHint();
        var srcId = e.dataTransfer.getData('text/plain');
        if (srcId) movePageToEnd(srcId);
      });
    }

    for (var i = 0; i < currentNotebook.pages.length; i++) {
      var page = currentNotebook.pages[i];
      var item = document.createElement('div');
      item.className = 'notebook-toc-item';
      if (page.id === currentPageId) item.classList.add('active');
      item.setAttribute('data-page-id', page.id);
      item.draggable = !_tocBatchMode;

      // 拖拽句柄（活页排序）
      if (!_tocBatchMode) {
        var dragHandle = document.createElement('span');
        dragHandle.className = 'toc-drag';
        dragHandle.textContent = '⠿';
        dragHandle.title = '拖动排序（活页）';
        item.appendChild(dragHandle);
      }

      // 批量勾选框
      if (_tocBatchMode) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'toc-checkbox';
        cb.checked = !!_tocSelected[page.id];
        cb.setAttribute('data-pid', page.id);
        cb.addEventListener('click', function(ev) { ev.stopPropagation(); });
        cb.addEventListener('change', function(ev) {
          var pid = ev.target.getAttribute('data-pid');
          if (ev.target.checked) _tocSelected[pid] = true;
          else delete _tocSelected[pid];
          _renderTocToolbar();
        });
        item.appendChild(cb);
      }

      var numSpan = document.createElement('span');
      numSpan.className = 'toc-page-num';
      numSpan.textContent = (i + 1);
      item.appendChild(numSpan);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'toc-page-name';
      nameSpan.textContent = page.name || ('第 ' + (i + 1) + ' 页');
      nameSpan.title = page.name || ('第 ' + (i + 1) + ' 页');
      item.appendChild(nameSpan);

      // 快捷跳转：跳到该页绑定的 PDF 页
      if (page.pdfRef && page.pdfRef.pageNum) {
        var jumpBtn = document.createElement('span');
        jumpBtn.className = 'toc-jump';
        jumpBtn.textContent = '⤴';
        jumpBtn.title = '跳到 PDF 第 ' + page.pdfRef.pageNum + ' 页';
        jumpBtn.setAttribute('data-pid', page.id);
        jumpBtn.addEventListener('click', function(ev) {
          ev.stopPropagation();
          var pid = this.getAttribute('data-pid');
          var pg = _tocFindPage(pid);
          if (pg && pg.pdfRef && pg.pdfRef.pageNum &&
              typeof PDFReader !== 'undefined' && PDFReader.jumpToPage) {
            PDFReader.jumpToPage(pg.pdfRef.pageNum);
          }
        });
        item.appendChild(jumpBtn);
      }

      // 重命名
      var renameBtn = document.createElement('span');
      renameBtn.className = 'toc-rename';
      renameBtn.textContent = '✎';
      renameBtn.title = '重命名';
      renameBtn.setAttribute('data-pid', page.id);
      renameBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var itemEl = this.closest('.notebook-toc-item');
        var nameEl = itemEl ? itemEl.querySelector('.toc-page-name') : null;
        if (nameEl) _renameFromTOC(this.getAttribute('data-pid'), nameEl);
      });
      item.appendChild(renameBtn);

      // 单个删除（批量模式下隐藏，走批量删除）
      if (!_tocBatchMode) {
        var delBtn = document.createElement('span');
        delBtn.className = 'toc-del';
        delBtn.textContent = '🗑';
        delBtn.title = '删除此页';
        delBtn.setAttribute('data-pid', page.id);
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          var pid = this.getAttribute('data-pid');
          var pg = _tocFindPage(pid);
          var nm = (pg && pg.name) ? pg.name : '此页';
          if (window.confirm('确定删除页面「' + nm + '」吗？该页所有内容将被删除。')) {
            deletePage(pid);
          }
        });
        item.appendChild(delBtn);
      }

      // 点击：批量模式勾选 / 普通模式打开页面（若绑定 PDF 页则同时翻移 PDF）
      item.addEventListener('click', function() {
        var pid = this.getAttribute('data-page-id');
        if (_tocBatchMode) {
          var cbEl = this.querySelector('.toc-checkbox');
          if (cbEl) {
            cbEl.checked = !cbEl.checked;
            cbEl.dispatchEvent(new Event('change'));
          }
          return;
        }
        renderPage(pid);
        renderNotebookTOC();
        var pg = _tocFindPage(pid);
        if (pg && pg.pdfRef && pg.pdfRef.pageNum &&
            typeof PDFReader !== 'undefined' && PDFReader.getCurrentPage && PDFReader.getCurrentPage() > 0 &&
            PDFReader.jumpToPage) {
          PDFReader.jumpToPage(pg.pdfRef.pageNum);
        }
      });

      // 活页拖拽排序（HTML5 DnD）
      item.addEventListener('dragstart', function(e) {
        e.stopPropagation();
        try { e.dataTransfer.setData('text/plain', this.getAttribute('data-page-id')); } catch (err) {}
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        this.classList.add('toc-dragging');
      });
      item.addEventListener('dragend', function(e) {
        e.stopPropagation();
        this.classList.remove('toc-dragging');
        _tocClearDropHint();
      });
      item.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        _tocShowDropHint(this, e);
      });
      item.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        _tocClearDropHint();
        var srcId = e.dataTransfer.getData('text/plain');
        var dstId = this.getAttribute('data-page-id');
        if (!srcId || srcId === dstId) return;
        if (this._tocDropBefore !== false) {
          movePageBefore(srcId, dstId);
        } else {
          var nxt = this.nextElementSibling;
          if (nxt && nxt.classList && nxt.classList.contains('notebook-toc-item')) {
            movePageBefore(srcId, nxt.getAttribute('data-page-id'));
          } else {
            movePageToEnd(srcId);
          }
        }
      });

      tocEl.appendChild(item);
    }
  }

  // 目录头部工具栏：新建 / 批量模式（全选 · 删除选中 · 取消）
  function _renderTocToolbar() {
    var panel = document.getElementById('notebookTOC');
    if (!panel) return;
    var h = panel.querySelector('.notebook-toc-header');
    if (!h) return;
    h.innerHTML = '';
    var title = document.createElement('span');
    title.textContent = '📖 笔记目录';
    h.appendChild(title);

    var right = document.createElement('div');
    right.className = 'toc-toolbar';

    if (_tocBatchMode) {
      var cnt = 0;
      for (var k in _tocSelected) { if (_tocSelected[k]) cnt++; }
      var countEl = document.createElement('span');
      countEl.className = 'toc-toolbar-count';
      countEl.textContent = '已选 ' + cnt;
      right.appendChild(countEl);

      var btnAll = _tocBtn('全选', function() {
        currentNotebook.pages.forEach(function(p) { _tocSelected[p.id] = true; });
        renderNotebookTOC();
      });
      right.appendChild(btnAll);

      var btnDel = _tocBtn('删除选中', function() {
        var ids = currentNotebook.pages.filter(function(p) { return _tocSelected[p.id]; }).map(function(p) { return p.id; });
        if (!ids.length) { alert('请先勾选要删除的页面'); return; }
        if (!window.confirm('确定删除选中的 ' + ids.length + ' 个页面吗？删除后不可恢复。')) return;
        batchDeletePages(ids).then(function() {
          _tocSelected = {};
          _tocBatchMode = false;
          renderNotebookTOC();
        });
      }, 'danger');
      right.appendChild(btnDel);

      var btnExit = _tocBtn('取消', function() {
        _tocBatchMode = false;
        _tocSelected = {};
        renderNotebookTOC();
      });
      right.appendChild(btnExit);
    } else {
      var btnAdd = _tocBtn('＋ 新建', function() {
        if (!currentNotebook) { alert('请先打开一本笔记'); return; }
        addPage('新笔记页', null);
      });
      right.appendChild(btnAdd);

      var btnBatch = _tocBtn('☑ 批量', function() {
        _tocBatchMode = true;
        _tocSelected = {};
        renderNotebookTOC();
      });
      right.appendChild(btnBatch);
    }
    h.appendChild(right);
  }

  function _tocBtn(label, onClick, variant) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'toc-toolbar-btn' + (variant === 'danger' ? ' danger' : '');
    b.textContent = label;
    b.addEventListener('click', function(ev) { ev.stopPropagation(); onClick(); });
    return b;
  }

  function _tocFindPage(pageId) {
    if (!currentNotebook) return null;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === pageId) return currentNotebook.pages[i];
    }
    return null;
  }

  // 拖放位置指示：上半 → 插到该页前，下半 → 插到该页后
  function _tocShowDropHint(item, e) {
    var rect = item.getBoundingClientRect();
    var before = (e.clientY - rect.top) < rect.height / 2;
    item._tocDropBefore = before;
    item.classList.toggle('toc-drop-before', before);
    item.classList.toggle('toc-drop-after', !before);
  }

  function _tocClearDropHint() {
    var list = document.querySelectorAll('#notebookTOCList .notebook-toc-item.toc-drop-before, #notebookTOCList .notebook-toc-item.toc-drop-after');
    for (var i = 0; i < list.length; i++) {
      list[i].classList.remove('toc-drop-before', 'toc-drop-after');
      delete list[i]._tocDropBefore;
    }
  }

  function _renameFromTOC(pageId, nameSpan) {
    nameSpan.setAttribute('contenteditable', 'true');
    nameSpan.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(nameSpan);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }

    function finish() {
      nameSpan.removeEventListener('blur', finish);
      nameSpan.removeEventListener('keydown', onKey);
      nameSpan.setAttribute('contenteditable', 'false');
      var newName = nameSpan.textContent.trim();
      if (newName) {
        setPageName(pageId, newName).then(function() {
          renderNotebookTOC();
          if (pageId === currentPageId) _updatePageInfo();
        });
      } else {
        renderNotebookTOC();
      }
    }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); nameSpan.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); renderNotebookTOC(); }
    }
    nameSpan.addEventListener('blur', finish);
    nameSpan.addEventListener('keydown', onKey);
  }

  function toggleNotebookTOC() {
    var toc = document.getElementById('notebookTOC');
    if (!toc) return;
    if (toc.style.display === 'none' || toc.style.display === '') {
      toc.style.display = 'flex';
      renderNotebookTOC();
    } else {
      toc.style.display = 'none';
    }
  }

  // ============================================================
  // 单页 AI 实时目录（Issue 3）
  // ============================================================

  var _pageDirectoryCache = {}; // pageId -> { html, timestamp }

  async function generatePageDirectory(pageId) {
    var panel = document.getElementById('pageDirectoryPanel');
    if (!panel) return;

    var body = panel.querySelector('.page-directory-body');
    var header = panel.querySelector('.page-directory-header');

    // 获取当前页所有块内容
    var blocks = getPageBlocks(pageId);
    if (!blocks || blocks.length === 0) {
      body.innerHTML = '<div class="dir-loading">当前页暂无笔记内容</div>';
      return;
    }

    // 构建笔记内容摘要
    var blockTexts = blocks.map(function(b, i) {
      return (i + 1) + '. [' + b.type + '] ' + (b.content || '').substring(0, 200);
    }).join('\n');

    // 显示加载中
    body.innerHTML = '<div class="dir-loading">⏳ AI 正在生成目录...</div>';

    // 调用 AI 生成目录
    try {
      var config = (typeof AppShell !== 'undefined' && AppShell.getAIConfig) ? AppShell.getAIConfig() : null;
      if (!config || !config.apiKey) {
        body.innerHTML = '<div class="dir-loading">⚠ 请先配置 AI API Key</div>';
        return;
      }

      var messages = [
        {
          role: 'system',
          content: '你是一个笔记整理助手。请根据用户提供的笔记内容，生成一个简洁的目录大纲。' +
            '要求：\n1. 提取笔记中的关键主题和要点\n2. 用简洁的短语描述每个条目\n' +
            '3. 按逻辑顺序排列\n4. 每行一个条目，格式为 "序号. 条目名称"，序号为该条目对应的笔记块序号（1-based，来自内容前标号）\n' +
            '5. 最多 15 个条目\n6. 只输出目录，不要其他解释'
        },
        { role: 'user', content: '笔记内容（每行前面是块序号）：\n' + blockTexts }
      ];

      var response = await AIAdapter.chat(
        config.provider, config.baseUrl, config.apiKey, messages,
        { model: config.model }
      );

      if (response) {
        // 渲染目录项 — 每项绑定点击跳转
        var lines = response.trim().split('\n');
        body.innerHTML = '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          var item = document.createElement('div');
          item.className = 'dir-item';
          item.textContent = line;

          // 解析条目对应的块序号（格式："3. 标题" / "3、标题"）
          var idxMatch = line.match(/^\s*(\d+)[\.、]\s*/);
          var blockIdx = idxMatch ? parseInt(idxMatch[1], 10) : 0;
          if (blockIdx > 0) {
            item.setAttribute('data-block-idx', blockIdx);
            (function(bidx) {
              item.addEventListener('click', function() {
                _scrollToBlockByIndex(bidx);
              });
            })(blockIdx);
          } else {
            // 无序号时按文本匹配跳转
            var keyword = line.replace(/^[•·\-*\s]+/, '').trim();
            (function(kw) {
              item.addEventListener('click', function() {
                _scrollToBlockByText(kw);
              });
            })(keyword);
          }
          body.appendChild(item);
        }
        _pageDirectoryCache[pageId] = { content: response, timestamp: Date.now() };
      } else {
        body.innerHTML = '<div class="dir-loading">未生成目录内容</div>';
      }
    } catch (e) {
      body.innerHTML = '<div class="dir-loading">⚠ 生成失败: ' + (e.message || '未知错误') + '</div>';
    }
  }

  function togglePageDirectory() {
    var panel = document.getElementById('pageDirectoryPanel');
    if (!panel) return;

    if (panel.classList.contains('collapsed')) {
      // 展开：刷新目录
      panel.classList.remove('collapsed');
      generatePageDirectory(currentPageId);
    } else {
      panel.classList.add('collapsed');
    }
  }

  // ---------- 按块序号滚动（1-based，对应目录项 data-block-idx） ----------
  function _scrollToBlockByIndex(bidx) {
    if (!contentEl || !bidx) return;
    var blocks = contentEl.querySelectorAll('.note-block');
    if (bidx >= 1 && bidx <= blocks.length) {
      _scrollToBlockEl(blocks[bidx - 1]);
    }
  }

  // ---------- 按文本匹配滚动到第一个包含关键词的块 ----------
  function _scrollToBlockByText(keyword) {
    if (!contentEl || !keyword) return;
    var blocks = contentEl.querySelectorAll('.note-block');
    for (var i = 0; i < blocks.length; i++) {
      if ((_contentElOf(blocks[i]).textContent || '').indexOf(keyword) >= 0) {
        _scrollToBlockEl(blocks[i]);
        return;
      }
    }
  }

  // ---------- 滚动到指定块并闪烁高亮 ----------
  function _scrollToBlockEl(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      var paper = document.querySelector('.notebook-paper');
      if (paper) paper.scrollTop = el.offsetTop - paper.offsetTop - 80;
    }
    // 闪烁高亮提示
    el.classList.remove('focus-highlight');
    void el.offsetWidth; // 重置动画
    el.classList.add('focus-highlight');
    setTimeout(function() {
      el.classList.remove('focus-highlight');
    }, 2200);
  }

  // ---------- 初始化页面目录面板 ----------
  function _initPageDirectoryPanel() {
    var panel = document.getElementById('pageDirectoryPanel');
    if (!panel) return;
    var header = panel.querySelector('.page-directory-header');
    if (header) {
      header.addEventListener('click', function(e) {
        if (e.target.classList.contains('dir-refresh')) {
          e.stopPropagation();
          generatePageDirectory(currentPageId);
        } else {
          togglePageDirectory();
        }
      });
    }
  }

  // ============================================================
  // 获取页内所有块
  // ============================================================

  function getPageBlocks(pageId) {
    if (!currentNotebook) return [];
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === pageId) {
        return currentNotebook.pages[i].blocks;
      }
    }
    return [];
  }

  // 获取某页 Markdown 原文全文（笔记栏 v2 双模式：mdContent 与 blocks 并存）
  function getPageMd(pageId) {
    if (!currentNotebook) return '';
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === pageId) {
        return currentNotebook.pages[i].mdContent || '';
      }
    }
    return '';
  }

  // ============================================================
  // 获取当前页号（1-based）
  // ============================================================

  function getCurrentPage() {
    if (!currentNotebook || !currentNotebook.pages || currentNotebook.pages.length === 0) {
      return 1;
    }
    var idx = -1;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === currentPageId) {
        idx = i;
        break;
      }
    }
    return idx >= 0 ? idx + 1 : 1;
  }

  // ============================================================
  // 创建新块并添加到当前页
  // ============================================================

  async function createNewBlock(type, content) {
    if (!currentNotebook || !currentPageId) return null;

    // 找到当前页
    var page = null;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === currentPageId) {
        page = currentNotebook.pages[i];
        break;
      }
    }
    if (!page) return null;

    // 创建块
    var block = createBlock(type, content);
    page.blocks.push(block);
    page.updatedAt = Date.now();
    currentNotebook.updatedAt = Date.now();

    // 持久化
    await _persistBlock(block, page.id);
    await _persistPage(page);
    await DataLayer.put('notebooks', currentNotebook);

    // 重新渲染
    renderPage(currentPageId);

    return block;
  }

  // ============================================================
  // 翻页
  // ============================================================

  function _goPrevPage() {
    if (!currentNotebook || currentNotebook.pages.length === 0) return;
    var idx = -1;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === currentPageId) {
        idx = i;
        break;
      }
    }
    if (idx > 0) {
      renderPage(currentNotebook.pages[idx - 1].id);
    }
  }

  function _goNextPage() {
    if (!currentNotebook || currentNotebook.pages.length === 0) return;
    var idx = -1;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === currentPageId) {
        idx = i;
        break;
      }
    }
    if (idx >= 0 && idx < currentNotebook.pages.length - 1) {
      renderPage(currentNotebook.pages[idx + 1].id);
    }
  }

  // ============================================================
  // 双模输入识别 (Task 11)
  // ============================================================

  /**
   * 输入类型检测 — 纯函数（支持用户自定义指令识别符号，多个开头符号任一命中即视为指令）
   * @param {string} text - 用户输入文本
   * @returns {'command'|'focus'|'note'}
   */
  function detectInputType(text) {
    const trimmed = (text || '').trim();
    // 符号指令：任意开头符号命中 → 指令
    if (_matchCmdOpenPrefix(trimmed)) {
      return 'command';
    }
    // 聚焦关键词
    const focusKeywords = ['找到', '定位', '跳到', '展示', '搜索', '查找', 'find', 'locate', 'show', 'search'];
    const lowerTrimmed = trimmed.toLowerCase();
    for (const kw of focusKeywords) {
      if (lowerTrimmed.includes(kw)) return 'focus';
    }
    return 'note';
  }

  /**
   * 检测指令结束标志 — 任意结尾符号命中即判定为指令输入完成
   * @param {string} text - 用户输入文本
   * @returns {boolean}
   */
  function hasCommandEndMarker(text) {
    return _matchCmdCloseSuffix(text) !== null;
  }

  /**
   * 去除任意命中的结尾符号，返回纯净指令文本
   * @param {string} text
   * @returns {string}
   */
  function stripCommandEndMarker(text) {
    var trimmed = (text || '').trim();
    var hit = _matchCmdCloseSuffix(trimmed);
    if (hit) return trimmed.slice(0, -hit.length).trim();
    return trimmed;
  }

  /**
   * 预处理 Markdown 文本 — 确保 GFM 表格前有空行
   * GFM 规范要求表格块前必须有空行，否则 marked.js 不会解析为表格
   * @param {string} text - 原始 markdown 文本
   * @returns {string} 预处理后的文本
   */
  function _preprocessMarkdown(text) {
    if (!text) return text;
    var lines = text.split('\n');
    var result = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      // 检测表格行：包含 | 且不是纯代码块
      var isTableRow = trimmed.indexOf('|') >= 0 && trimmed.length > 1;
      // 检测表格分隔行：| --- | --- |
      var isTableSeparator = /^\|?[\s-:|]+\|?$/.test(trimmed) && trimmed.indexOf('-') >= 0;

      if (isTableRow && result.length > 0) {
        var prevLine = result[result.length - 1];
        var prevTrimmed = prevLine.trim();
        var prevIsTableRow = prevTrimmed.indexOf('|') >= 0 && prevTrimmed.length > 1;
        var prevIsBlank = prevTrimmed === '';
        // 如果当前行是表格行，前一行不是表格行也不是空行，插入空行
        if (!prevIsTableRow && !prevIsBlank) {
          result.push('');
        }
      }
      result.push(line);
    }
    return result.join('\n');
  }

  /**
   * 转义 HTML 特殊字符
   */
  function _escapeHtml(text) {
    return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  /**
   * Markdown 渲染 — 使用 marked.js 将 markdown 文本转为 HTML
   * 保留手写体字体风格（通过 CSS .md-content 类控制）
   * 增强表格稳定性：预处理确保 GFM 表格前有空行
   * @param {string} text - markdown 文本
   * @returns {string} HTML 字符串
   */
  function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked !== 'undefined' && marked.parse) {
      try {
        // 2026-08-16：先将内联 ```html``` 代码块迁移为 @[html:ID] 引用
        // （保证源码与预览切换全程只出现占位符，不再有 HTML 源码参与 Markdown 解析/反序列化）
        var mdForRender = _migrateHtmlBlocksToRefs(text);
        // 保护 、、指令。。 标记：避免 Markdown 解析吞掉指令，渲染为绿色胶囊
        var protectedMarks = _protectCommandMarks(mdForRender);
        var processed = _preprocessMarkdown(protectedMarks.text);
        var html = marked.parse(processed, { breaks: true, gfm: true });
        html = _restoreCommandMarks(html, protectedMarks.marks);
        // 2026-08-16 改造：@[html:ID] → 沙盒 iframe；@[diagram:ID] → Canvas 编辑器容器
        html = _postProcessHtmlRefs(html);
        html = _postProcessDiagramBlocks(html);
        // 2026-08-19 图片：scimg:// 引用 → 可交互图片容器（真实 src 由 _resolvePreviewImages 异步加载）
        html = _postProcessImageRefs(html);
        // 验证输出：确保 HTML 标签存在（非纯文本）
        if (html && html.indexOf('<') >= 0) return html;
        // 纯文本输出时手动转换换行
        return html || _escapeHtml(text);
      } catch (e) {
        console.warn('Markdown 渲染失败，降级为纯文本:', e);
        return _escapeHtml(text);
      }
    }
    // marked.js 未加载时降级为纯文本
    return _escapeHtml(text);
  }

  // 2026-08-15 新增：读取当前指令分隔符配置（优先 CommandQueue → AppShell → 默认 、、/。。）
  // 返回 { open: string[], close: string[] } —— 两端都可能是多个候选符号
  function _getCmdDelimiters() {
    var openArr = null, closeArr = null;
    try {
      if (typeof CommandQueue !== 'undefined' && CommandQueue.getDelimiters) {
        var d = CommandQueue.getDelimiters();
        if (d) {
          if (d.open)  openArr  = Array.isArray(d.open)  ? d.open  : [d.open];
          if (d.close) closeArr = Array.isArray(d.close) ? d.close : [d.close];
        }
      }
    } catch (e) {}
    try {
      if ((!openArr || !openArr.length) && (typeof AppShell !== 'undefined' && AppShell.getCmdMarkers)) {
        var m = AppShell.getCmdMarkers();
        if (m) {
          if (!openArr  || !openArr.length)  openArr  = m.open  ? (Array.isArray(m.open)  ? m.open  : [m.open])  : null;
          if (!closeArr || !closeArr.length) closeArr = m.close ? (Array.isArray(m.close) ? m.close : [m.close]) : null;
        }
      }
    } catch (e) {}
    return {
      open:  (openArr  && openArr.length)  ? openArr  : ['/', '@ai ', '↺', '、、'],
      close: (closeArr && closeArr.length) ? closeArr : ['。。', '...', '。。。']
    };
  }

  /**
   * 检测 text 是否以任意"开头符号"起始
   * @returns {string|null} 命中的开头符号（未命中时 null）
   */
  function _matchCmdOpenPrefix(text) {
    var d = _getCmdDelimiters();
    var t = (text || '');
    for (var i = 0; i < d.open.length; i++) {
      var op = d.open[i];
      if (!op) continue;
      // '/' 只能严格地在行首才触发（避免路径 /usr 这种误触发）
      if (op === '/') {
        if (t.indexOf('/') === 0) return op;
      } else if (t.toLowerCase().indexOf(op.toLowerCase()) === 0) {
        return op;
      }
    }
    return null;
  }

  /**
   * 检测 text 是否以任意"结尾符号"结束
   * @returns {string|null} 命中的结尾符号（未命中时 null）
   */
  function _matchCmdCloseSuffix(text) {
    var d = _getCmdDelimiters();
    var t = (text || '').trim();
    for (var i = 0; i < d.close.length; i++) {
      var cl = d.close[i];
      if (!cl) continue;
      if (t.length >= cl.length && t.slice(-cl.length) === cl) return cl;
    }
    return null;
  }

  function _delimRegexEscape(s) {
    return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  /**
   * 保护 <open>指令<close> 标记 → HTML 注释占位，避免 Markdown 解析吞掉指令
   * 2026-08-15：支持多组开头/结尾符号（任一对匹配即生效）
   * @returns {{text: string, marks: string[]}}
   */
  function _protectCommandMarks(text) {
    var marks = [];
    if (!text) return { text: text, marks: marks };
    var d = _getCmdDelimiters();
    var openArr = d.open || [], closeArr = d.close || [];
    if (!openArr.length || !closeArr.length) return { text: text, marks: marks };
    // 构建多对符号的联合正则：(open1|open2|...)([\s\S]+?)(close1|close2|...)
    // 注意：open/close 中若有 @ai 这种带空格的，也应被正确转义和分组
    var openUnion  = '(' + openArr.map(_delimRegexEscape).join('|')  + ')';
    var closeUnion = '(' + closeArr.map(_delimRegexEscape).join('|') + ')';
    var re = new RegExp(openUnion + '([\\s\\S]+?)' + closeUnion, 'g');
    var idx = 0;
    var escaped = String(text).replace(re, function(m, _op, raw, _cl) {
      raw = (raw || '').trim();
      if (!raw) return m;
      marks.push(raw);
      return '<!--CMDQ' + (idx++) + '-->';
    });
    return { text: escaped, marks: marks };
  }

  /** 恢复指令胶囊（绿色标记 + 状态点） */
  function _restoreCommandMarks(html, marks) {
    if (!marks.length) return html;
    for (var i = 0; i < marks.length; i++) {
      html = html.split('<!--CMDQ' + i + '-->').join(_commandCapsuleHtml(marks[i]));
    }
    return html;
  }

  /** 指令胶囊 HTML：绿色内联标记 + 待办状态点（蓝图 §4.4） */
  function _commandCapsuleHtml(raw) {
    var st = 'pending';
    if (typeof CommandQueue !== 'undefined' && CommandQueue.statusOf) {
      st = CommandQueue.statusOf(raw) || 'pending';
    }
    // 2026-08-15 状态文案丰富：awaiting_approval 显示"待审批"，rejected 显示"已拒绝"等
    var stLabel = '';
    switch (st) {
      case 'strategizing':   stLabel = '策略设计中'; break;
      case 'strategy_ready': stLabel = '策略就绪'; break;
      case 'awaiting_approval': stLabel = '待审批'; break;
      case 'approved':       stLabel = '已批准'; break;
      case 'applying':       stLabel = '执行中'; break;
      case 'done':           stLabel = '已完成'; break;
      case 'failed':         stLabel = '失败'; break;
      case 'rejected':       stLabel = '已拒绝'; break;
      case 'rolled_back':    stLabel = '已撤回'; break;
      default:               stLabel = '';
    }
    var safe = String(raw).replace(/[<>&"]/g, function(ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch];
    });
    var labelHtml = stLabel ? '<span class="cmd-mark-label">' + stLabel + '</span>' : '';
    return '<span class="cmd-mark cmd-st-' + st + '" data-cmd-raw="' + safe + '"><span class="cmd-mark-dot"></span>' + safe + labelHtml + '</span>';
  }

  // ============================================================
  // contentEditable 编辑事件处理 (Task 11)
  // ============================================================

  // 获取当前页对象
  function _getCurrentPageObj() {
    if (!currentNotebook) return null;
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      if (currentNotebook.pages[i].id === currentPageId) return currentNotebook.pages[i];
    }
    return null;
  }

  // 在当前页中查找块
  function _findBlockById(id) {
    var page = _getCurrentPageObj();
    if (!page) return null;
    for (var i = 0; i < page.blocks.length; i++) {
      if (page.blocks[i].id === id) return page.blocks[i];
    }
    return null;
  }

  // 获取块在当前页中的索引
  function _getBlockIndex(id) {
    var page = _getCurrentPageObj();
    if (!page) return -1;
    for (var i = 0; i < page.blocks.length; i++) {
      if (page.blocks[i].id === id) return i;
    }
    return -1;
  }

  // 获取上一块的 ID
  function _getPrevBlockId(id) {
    var idx = _getBlockIndex(id);
    if (idx <= 0) return null;
    var page = _getCurrentPageObj();
    return page.blocks[idx - 1].id;
  }

  // 聚焦到指定块并把光标置于末尾
  function _focusBlock(id) {
    if (!contentEl) return;
    var el = contentEl.querySelector('[data-block-id="' + id + '"]');
    if (!el) return;
    var ce = _contentElOf(el) || el;
    ce.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(ce);
      range.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }
  }

  // 取最近的 .note-block 祖先（兼容无 Element.closest 的环境）
  function _closestBlock(node) {
    if (!node) return null;
    if (node.closest) return node.closest('.note-block');
    while (node && node !== contentEl) {
      if (node.classList && node.classList.contains('note-block')) return node;
      node = node.parentNode;
    }
    return null;
  }

  // 取块内真正可编辑的内容容器（.note-block-content）；找不到时回退到块本身
  function _contentElOf(blockEl) {
    if (!blockEl) return null;
    var ce = blockEl.querySelector ? blockEl.querySelector('.note-block-content') : null;
    return ce || blockEl;
  }

  // input 事件 — 实时更新块内容到内存与 DataLayer
  function _onContentInput(e) {
    var blockEl = _closestBlock(e.target);
    if (!blockEl) return;
    // 背景模式：普通块/AI块输入都拦截（防止写入默认笔记），并提示先从 NFM 打开具体笔记
    if (_warnBackgroundMode('编辑块内容')) {
      // 回退输入内容（不让 DOM 里留脏数据）
      try { e.preventDefault && e.preventDefault(); } catch(err) {}
      var blockId0 = blockEl.getAttribute('data-block-id');
      var block0 = _findBlockById(blockId0);
      if (block0) {
        var content0 = _contentElOf(blockEl);
        if (content0 && block0.content != null) content0.textContent = block0.content;
      }
      return;
    }
    var blockId = blockEl.getAttribute('data-block-id');
    var block = _findBlockById(blockId);
    if (!block || block.lock) {
      // AI 正在处理该块，忽略输入
      return;
    }

    // 实时：未闭合「、、」后续文字切换为指令书写格式（块编辑态所见即所得）
    _applyLiveCmdStyle(_contentElOf(blockEl));

    // AI 生成的块：所见即所得编辑，HTML 结构在失焦时统一转回 Markdown 保存。
    // 这里不实时更新 content（避免丢失表格等结构），但保留指令检测（需求1：支持文本段内任意位置指令）
    if (block.aiGenerated || block.type === 'ai-result' || block.type === 'ai-placeholder') {
      if (blockEl.classList.contains('editing-raw')) return; // 原文模式由"完成"按钮保存
      var aiCmd = _extractCommandCandidate(_contentElOf(blockEl).textContent);
      if (aiCmd) {
        var aiT = detectInputType(aiCmd);
        if ((aiT === 'command' || aiT === 'focus') && hasCommandEndMarker(aiCmd)) {
          if (detectDebounceTimer) { clearTimeout(detectDebounceTimer); detectDebounceTimer = null; }
          // 指令行是整块 → 直接触发；否则拆分出指令行独立执行
          if (_contentElOf(blockEl).textContent.trim() === aiCmd.trim()) {
            block.content = _contentElOf(blockEl).textContent;
            _fireBlockChange(block, aiT === 'focus' ? 'focus' : 'command');
          } else {
            block.content = _contentElOf(blockEl).textContent;
            _splitCommandLine(block, aiCmd, aiT);
          }
        }
      }
      return;
    }

    // 实时更新内存（普通块）
    block.content = _contentElOf(blockEl).textContent;
    block.timestamp = Date.now();

    // 去抖持久化（800ms），避免每输入一个字符都写入 IndexedDB，减少大笔记卡顿
    if (block._saveTimer) clearTimeout(block._saveTimer);
    block._saveTimer = setTimeout(function() {
      _persistBlock(block, currentPageId);
      block._saveTimer = null;
    }, 800);

    // 指令结束标志检测：任意位置以 "/" / "@ai " / "、、" 开头的行，且以 "..." / "。。。" / "。。" 结尾时触发（需求1）
    var cmdCandidate = _extractCommandCandidate(block.content);
    if (cmdCandidate) {
      var cInputType = detectInputType(cmdCandidate);
      if ((cInputType === 'command' || cInputType === 'focus') && hasCommandEndMarker(cmdCandidate)) {
        // 指令输入完成（检测到结束标记），立即触发
        if (detectDebounceTimer) { clearTimeout(detectDebounceTimer); detectDebounceTimer = null; }
        if (block.content.trim() === cmdCandidate.trim()) {
          // 整块指令 → 直接触发
          _fireBlockChange(block, cInputType === 'focus' ? 'focus' : 'command');
        } else {
          // 文本段内嵌指令 → 拆分出指令行独立执行
          _splitCommandLine(block, cmdCandidate, cInputType);
        }
        return;
      }
    }

    // 普通笔记更新
    if (detectDebounceTimer) clearTimeout(detectDebounceTimer);
    detectDebounceTimer = setTimeout(function() {
      if (!block) return;
      _fireBlockChange(block, 'update');
    }, 1000);
  }

  /**
   * 提取块内容中的指令候选文本（支持自定义开头符号）
   * 从后往前查找以任意"开头符号"起始的行；整块是指令时返回整块
   * @param {string} text
   * @returns {string|null}
   */
  function _extractCommandCandidate(text) {
    if (!text) return null;
    var trimmed = text.trim();
    if (trimmed.indexOf('\n') < 0 && _matchCmdOpenPrefix(trimmed)) {
      return trimmed; // 单行且以指令开头 → 整块指令
    }
    var lines = text.split('\n');
    // 从后往前找指令行（含结束标志的候选）
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (_matchCmdOpenPrefix(line)) {
        return line;
      }
    }
    return null;
  }

  // 需求1：从文本段中拆分指令行 → 移除该行 + 新建独立命令块执行
  // 原文本段保留其余内容，指令块插入原块之后，AI 结果插入指令块之后
  function _splitCommandLine(block, cmdLine, type) {
    var lines = (block.content || '').split('\n');
    var kept = [];
    var removed = false;
    for (var i = 0; i < lines.length; i++) {
      if (!removed && lines[i].trim() === cmdLine.trim()) {
        removed = true;
        continue;
      }
      kept.push(lines[i]);
    }
    block.content = kept.join('\n');
    block.timestamp = Date.now();
    _persistBlock(block, currentPageId);
    var idx = _getBlockIndex(block.id) + 1;
    applyOperation({
      type: 'insert', source: 'user', blockType: 'command',
      content: cmdLine, position: idx
    }).then(function(nb) {
      if (nb) {
        renderPage(currentPageId);
        _fireBlockChange(nb, type === 'focus' ? 'focus' : 'command');
      }
    });
  }

  // keydown 事件 — Enter 新建块 / 触发指令 / Backspace 空块删除 / Ctrl+Enter 新建文本段
  function _onContentKeydown(e) {
    var blockEl = _closestBlock(e.target);
    if (!blockEl) return;
    var blockId = blockEl.getAttribute('data-block-id');
    var block = _findBlockById(blockId);
    if (!block || block.lock) return;

    // 需求2：Ctrl+Enter 在当前块之后新建一个空白文本段（任何块类型均生效）
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation(); // 阻止全局 Ctrl+Enter（发送划选指令），块内优先新建文本段
      var newIdx = _getBlockIndex(blockId) + 1;
      applyOperation({
        type: 'insert', source: 'user',
        blockType: 'text', content: '', position: newIdx
      }).then(function(nb) { if (nb) _focusBlock(nb.id); });
      return;
    }

    // AI 生成的块：所见即所得编辑
    if (block.aiGenerated || block.type === 'ai-result' || block.type === 'ai-placeholder') {
      if (blockEl.classList.contains('editing-raw')) return; // 原文模式用文本域，无需处理
      // Enter（非 Shift）：在 AI 块后新建空白文本块，用户可直接继续书写（无需手动建框）
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var aiNewIdx = _getBlockIndex(blockId) + 1;
        applyOperation({
          type: 'insert', source: 'user',
          blockType: 'text', content: '', position: aiNewIdx
        }).then(function(nb) { if (nb) _focusBlock(nb.id); });
        return;
      }
      // Shift+Enter：块内换行（表格/多行编辑）
      if (e.key === 'Enter') return;
      // Backspace 空块删除（内容清空后按 Backspace 删除整个块）
      if (e.key === 'Backspace' && _contentElOf(blockEl).textContent === '') {
        e.preventDefault();
        var aiPrevId = _getPrevBlockId(blockId);
        applyOperation({
          type: 'delete', source: 'user', targetBlockId: blockId
        }).then(function() { if (aiPrevId) _focusBlock(aiPrevId); });
        return;
      }
      return;
    }

    // 普通块 Enter（无 Shift）：若块内存在指令候选（以 /、@ai 或 、、 开头），Enter 直接触发指令；
    // 否则换行创建新块。
    // 指令也可用结束标志触发（见 _onContentInput）。
    if (e.key === 'Enter' && !e.shiftKey) {
      block.content = _contentElOf(blockEl).textContent;
      var candidate = _extractCommandCandidate(block.content);
      if (candidate) {
        var ct = detectInputType(candidate);
        if (ct === 'command' || ct === 'focus') {
          // 仅当块整体是指令时 Enter 触发；多行文本段内的指令行需用结束标志触发（需求1）
          if (block.content.trim() === candidate.trim()) {
            e.preventDefault();
            if (detectDebounceTimer) { clearTimeout(detectDebounceTimer); detectDebounceTimer = null; }
            _fireBlockChange(block, ct === 'focus' ? 'focus' : 'command');
            return;
          }
        }
      }

      e.preventDefault();
      // 连续纸张：Enter 在块内换行（同一文本块内继续书写，无需新建"文本框"）
      // 指令行用结束标志触发（见 _onContentInput），或块整体指令时 Enter 直接触发
      document.execCommand('insertHTML', false, '<br>');
      return;
    }

    // Backspace（块为空）：删除当前块，光标回到上一块
    if (e.key === 'Backspace' && _contentElOf(blockEl).textContent === '') {
      e.preventDefault();
      var prevId = _getPrevBlockId(blockId);
      applyOperation({
        type: 'delete', source: 'user', targetBlockId: blockId
      }).then(function() { if (prevId) _focusBlock(prevId); });
      return;
    }

    // 连续文档体验：光标位于块首且有内容时按 Backspace → 与上一块合并
    if (e.key === 'Backspace' && _isCaretAtBlockStart(_contentElOf(blockEl))) {
      var prevId = _getPrevBlockId(blockId);
      if (prevId) {
        e.preventDefault();
        var prevBlock = _findBlockById(prevId);
        if (prevBlock) {
          var mergedContent = (prevBlock.content || '') + '\n' + (block.content || '');
          applyOperation({
            type: 'update', source: 'user', targetBlockId: prevId, content: mergedContent
          }).then(function() {
            return applyOperation({ type: 'delete', source: 'user', targetBlockId: blockId });
          }).then(function() { _focusBlock(prevId); });
          return;
        }
      }
      // 没有上一块：放行默认行为（正常删除首字符）
    }
  }

  // 光标是否位于块内文本开头（用于 Backspace 合并上一块）
  function _isCaretAtBlockStart(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el) return false;
    var range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return false;
    var pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().trim() === '';
  }

  // ============================================================
  // 多块选中与合并（连续文档体验：跨块文本合并为一段）
  // ============================================================
  var selectedBlocks = {};

  function _toggleSelectBlock(blockId) {
    var el = contentEl ? contentEl.querySelector('[data-block-id="' + blockId + '"]') : null;
    if (selectedBlocks[blockId]) {
      delete selectedBlocks[blockId];
      if (el) el.classList.remove('selected');
    } else {
      selectedBlocks[blockId] = true;
      if (el) el.classList.add('selected');
    }
  }

  function clearSelection() {
    selectedBlocks = {};
    if (contentEl) contentEl.querySelectorAll('.note-block.selected').forEach(function(el) {
      el.classList.remove('selected');
    });
  }

  function getSelectedBlockIds() {
    return Object.keys(selectedBlocks);
  }

  // 合并所选块为一段（按页内顺序拼接内容，保留第一块位置）
  function mergeSelectedBlocks() {
    var pageId = currentPageId;
    var blocks = getPageBlocks(pageId) || [];
    var ordered = blocks.filter(function(b) { return selectedBlocks[b.id]; });
    if (ordered.length < 2) return Promise.resolve(null);
    var firstId = ordered[0].id;
    var merged = ordered.map(function(b) { return b.content || ''; }).join('\n');
    var rest = ordered.slice(1);
    // 更新第一块 + 删除其余
    var op = applyOperation({
      type: 'update', source: 'user', targetBlockId: firstId, content: merged
    });
    var chain = op;
    rest.forEach(function(b) {
      chain = chain.then(function() {
        return applyOperation({ type: 'delete', source: 'user', targetBlockId: b.id });
      });
    });
    return chain.then(function() {
      selectedBlocks = {};
      renderPage(currentPageId);
      _focusBlock(firstId);
      return firstId;
    });
  }

  // blur 事件 — 保存块内容
  function _onContentBlur(e) {
    var blockEl = _closestBlock(e.target);
    if (!blockEl) return;
    var blockId = blockEl.getAttribute('data-block-id');
    var block = _findBlockById(blockId);
    if (!block || block.lock) return;
    // AI 生成的块：所见即所得编辑失焦 → HTML 转回 Markdown 保存并重新渲染
    if (block.aiGenerated || block.type === 'ai-result' || block.type === 'ai-placeholder') {
      _saveWysiwygBlock(blockId, blockEl);
      return;
    }
    block.content = _contentElOf(blockEl).textContent;
    block.timestamp = Date.now();
    // 失焦时立即持久化（清除去抖定时器，防止延迟写入）
    if (block._saveTimer) { clearTimeout(block._saveTimer); block._saveTimer = null; }
    _persistBlock(block, currentPageId);
  }

  // ============================================================
  // Operation 队列 + 并发编辑 (Task 12)
  // ============================================================
  // Operation 结构:
  // { type: 'insert'|'update'|'delete'|'move',
  //   source: 'user'|'ai',
  //   targetBlockId?, position?, block?, content?, blockType?, options? }

  /**
   * 统一操作入口
   * - 用户操作实时执行
   * - AI 操作进入 FIFO 队列串行处理
   * @param {object} op
   * @returns {Promise}
   */
  function applyOperation(op) {
    if (!op) return Promise.resolve(null);
    // 背景模式下拦截所有写入类操作（insert/update/delete/move 全是写）
    if (_warnBackgroundMode('编辑')) return Promise.reject(new Error('background_mode_readonly'));
    if (!currentNotebook) return Promise.reject(new Error('no_notebook_loaded'));
    if (op.source === 'user') {
      // 用户操作实时执行
      return Promise.resolve(_executeOperation(op));
    }
    // AI 操作进入队列
    var p = new Promise(function(resolve, reject) {
      op._resolve = resolve;
      op._reject = reject;
    });
    operationQueue.push(op);
    _processQueue();
    return p;
  }

  // 串行处理 AI 操作队列
  async function _processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (operationQueue.length > 0) {
      var op = operationQueue.shift();
      // 如果操作目标块被锁定，等待解锁后重试。
      // 防御性保护：最多等待 50 次（约 5 秒），防止目标块永久锁定导致队列死锁。
      if (op.targetBlockId) {
        var target = _findBlockById(op.targetBlockId);
        if (target && target.lock) {
          var waited = 0;
          while (target && target.lock && waited < 50) {
            await new Promise(function(r) { setTimeout(r, 100); });
            waited++;
            target = _findBlockById(op.targetBlockId);
          }
          if (!target || target.lock) {
            // 超时或目标块消失：拒绝该操作并跳过（不再重新入队），避免死锁
            var lockErr = new Error('操作超时：目标块持续被锁定，已跳过该操作');
            if (op._reject) op._reject(lockErr);
            else console.warn('AI 操作跳过（锁超时）:', op.type, op.targetBlockId);
            continue;
          }
        }
      }
      try {
        var result = _executeOperation(op);
        // AI 插入等操作可能返回 Promise（含淡入动画时长）
        if (result && typeof result.then === 'function') {
          result = await result; // 捕获 Promise 的解析值（块对象）
        }
        if (op._resolve) op._resolve(result);
      } catch (err) {
        if (op._reject) op._reject(err);
      }
    }
    isProcessingQueue = false;
  }

  // 分发执行
  function _executeOperation(op) {
    switch (op.type) {
      case 'insert': return _execInsert(op);
      case 'update': return _execUpdate(op);
      case 'delete': return _execDelete(op);
      case 'move':   return _execMove(op);
      default: return null;
    }
  }

  // 增量刷新单个块的 DOM（不重建整页，提升大笔记性能）
  function _refreshBlockDom(blockId) {
    // MD 模式无 .note-block，直接返回（数据层由 mdContent 驱动）
    if (mdModeActive) return false;
    var block = _findBlockById(blockId);
    var el = contentEl ? contentEl.querySelector('[data-block-id="' + blockId + '"]') : null;
    if (!block || !el || !el.parentNode) return false;
    var newEl = _renderBlock(block);
    el.parentNode.replaceChild(newEl, el);
    return true;
  }

  // 重算所有块的上移/下移按钮边界禁用态
  // 增量插入/删除/移动不会整页重渲染，旧块的 total 仍是插入时刻的值，
  // 导致"曾为末尾的块"的↓按钮被错误地永久禁用。此函数按当前页顺序刷新。
  function _refreshMoveButtons() {
    if (mdModeActive) return; // MD 模式无块，无需刷新
    if (!contentEl) return;
    var page = _getCurrentPageObj();
    if (!page) return;
    var els = contentEl.querySelectorAll('.note-block');
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute('data-block-id');
      var idx = _getBlockIndex(id);
      var total = page.blocks.length;
      var ups = els[i].querySelectorAll('.note-block-move');
      if (ups.length >= 2) {
        ups[0].disabled = idx <= 0;
        ups[1].disabled = idx >= total - 1;
      }
    }
  }

  // 插入块（AI 插入带淡入动画）
  function _execInsert(op) {
    var page = _getCurrentPageObj();
    if (!page) return null;

    var block = op.block || createBlock(op.blockType || 'text', op.content || '', op.options);
    if (op.blockType) block.type = op.blockType;
    if (op.content !== undefined) block.content = op.content;

    // AI 操作：执行期间锁定，完成后淡入再解锁
    if (op.source === 'ai') {
      block.lock = true;
      block.aiGenerated = true;
    }

    // 插入位置（默认追加到末尾）
    var pos = (typeof op.position === 'number' && op.position >= 0 && op.position <= page.blocks.length)
      ? op.position : page.blocks.length;
    page.blocks.splice(pos, 0, block);
    page.updatedAt = Date.now();
    currentNotebook.updatedAt = Date.now();

    // 记录撤销对：删除该块 ↔ 在原位置重新插入（携带完整块数据）
    _recordUndo({
      inverse:  { type: 'delete', targetBlockId: block.id },
      original: { type: 'insert', block: block, position: pos }
    });

    // 持久化（异步、不阻塞）
    _persistBlock(block, page.id);
    _persistPage(page);
    DataLayer.put('notebooks', currentNotebook);

    // 增量插入 DOM：移除空提示，在对应位置插入新块
    // MD 模式：不渲染 .note-block（blocks 仅作数据兼容保留），保持笔记栏纯 MD
    if (contentEl && !mdModeActive) {
      var emptyEl = contentEl.querySelector('.notebook-empty');
      if (emptyEl) emptyEl.remove();
      var newEl = _renderBlock(block);
      var refEl = contentEl.querySelectorAll('.note-block')[pos];
      if (refEl) contentEl.insertBefore(newEl, refEl);
      else contentEl.appendChild(newEl);
      _refreshMoveButtons();
    }

    if (op.source === 'ai') {
      // 锁定状态先展示（⏳角标），处理完成后解锁并触发 noteFadeIn 淡入动画
      return new Promise(function(resolve) {
        setTimeout(function() {
          block.lock = false;
          _persistBlock(block, page.id);
          // 增量刷新该块 DOM（解锁后重新挂载，CSS noteFadeIn 动画播放）
          _refreshBlockDom(block.id);
          _fireBlockChange(block, 'create');
          resolve(block);
        }, 350); // 与 @keyframes noteFadeIn 时长匹配
      });
    }

    _fireBlockChange(block, 'create');
    return block;
  }

  // 更新块内容
  function _execUpdate(op) {
    var block = op.targetBlockId ? _findBlockById(op.targetBlockId) : null;
    if (!block) return null;
    var _oldContent = block.content;
    var _oldType = block.type;
    if (op.content !== undefined) block.content = op.content;
    if (op.blockType) block.type = op.blockType;
    block.timestamp = Date.now();

    var page = _getCurrentPageObj();
    _persistBlock(block, page ? page.id : currentPageId);
    // 增量更新 DOM；失败时回退整页渲染（MD 模式无块 DOM，无需重渲染，避免打断编辑）
    if (!_refreshBlockDom(block.id)) {
      if (!mdModeActive) renderPage(currentPageId);
    }
    _fireBlockChange(block, 'update');

    // 记录撤销对：改回旧值 ↔ 改为新值
    var _inv = { type: 'update', targetBlockId: block.id };
    var _orig = { type: 'update', targetBlockId: block.id };
    if (_oldContent !== undefined) _inv.content = _oldContent;
    if (_oldType !== undefined) _inv.blockType = _oldType;
    if (op.content !== undefined) _orig.content = op.content;
    if (op.blockType !== undefined) _orig.blockType = op.blockType;
    _recordUndo({ inverse: _inv, original: _orig });
    return block;
  }

  // 删除块
  function _execDelete(op) {
    var page = _getCurrentPageObj();
    if (!page) return null;
    var idx = _getBlockIndex(op.targetBlockId);
    if (idx < 0) return null;
    var block = page.blocks.splice(idx, 1)[0];
    page.updatedAt = Date.now();
    currentNotebook.updatedAt = Date.now();

    // 记录撤销对：在原位置恢复插入完整块 ↔ 删除
    _recordUndo({
      inverse:  { type: 'insert', block: block, position: idx },
      original: { type: 'delete', targetBlockId: block.id }
    });

    DataLayer.delete('blocks', op.targetBlockId);
    _persistPage(page);
    DataLayer.put('notebooks', currentNotebook);

    // 增量移除 DOM
    // MD 模式：无 .note-block，跳过块 DOM 操作（数据层已更新）
    if (!mdModeActive) {
      var el = contentEl ? contentEl.querySelector('[data-block-id="' + op.targetBlockId + '"]') : null;
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
        // 若页面已无块，补回空状态提示
        if (!contentEl.querySelector('.note-block')) {
          var empty = document.createElement('div');
          empty.className = 'notebook-empty';
          empty.setAttribute('contenteditable', 'false');
          empty.innerHTML = '在分栏视图下，从 PDF 划选文本即可推送到这里<br>或直接开始输入笔记';
          contentEl.appendChild(empty);
        }
      } else {
        renderPage(currentPageId);
      }
      _refreshMoveButtons();
    }
    _fireBlockChange(block, 'delete');
    return block;
  }

  // 删除指定块（含非空块）—— 供块删除按钮调用
  function deleteBlock(blockId) {
    if (!blockId) return null;
    return applyOperation({ type: 'delete', targetBlockId: blockId });
  }

  // ============================================================
  // 撤销 / 重做（基于反向操作）
  // ============================================================
  function _recordUndo(pair) {
    if (_suppressUndoRecord) return;
    if (!pair || !pair.inverse || !pair.original) return;
    undoStack.push(pair);
    if (undoStack.length > 200) undoStack.shift(); // 限制栈深，防止无限增长
    redoStack.length = 0; // 新操作清空重做栈
    _fireUndoChange();
  }

  function _fireUndoChange() {
    for (var i = 0; i < undoChangeCallbacks.length; i++) {
      try { undoChangeCallbacks[i](undoStack.length, redoStack.length); }
      catch (e) { /* 回调异常不影响主流程 */ }
    }
  }

  function onUndoChange(callback) {
    if (typeof callback === 'function') undoChangeCallbacks.push(callback);
  }

  // 撤销：弹出最近的反向操作并执行，整个 pair 移入重做栈
  function undo() {
    if (!undoStack.length) return false;
    var pair = undoStack.pop();
    _suppressUndoRecord = true;
    try { _executeOperation(pair.inverse); }
    finally { _suppressUndoRecord = false; }
    redoStack.push(pair);
    _fireUndoChange();
    return true;
  }

  // 重做：弹出最近的 pair 并执行其正向操作，整个 pair 移回撤销栈
  function redo() {
    if (!redoStack.length) return false;
    var pair = redoStack.pop();
    _suppressUndoRecord = true;
    try { _executeOperation(pair.original); }
    finally { _suppressUndoRecord = false; }
    undoStack.push(pair);
    _fireUndoChange();
    return true;
  }

  // 移动块位置
  function _execMove(op) {
    var page = _getCurrentPageObj();
    if (!page) return null;
    var fromIdx = _getBlockIndex(op.targetBlockId);
    if (fromIdx < 0) return null;
    var toIdx = (typeof op.position === 'number') ? op.position : op.toIndex;
    if (typeof toIdx !== 'number' || toIdx < 0 || toIdx >= page.blocks.length) return null;

    var block = page.blocks.splice(fromIdx, 1)[0];
    page.blocks.splice(toIdx, 0, block);
    page.updatedAt = Date.now();

    // 记录撤销对：移回原位置 ↔ 移到目标位置
    _recordUndo({
      inverse:  { type: 'move', targetBlockId: block.id, position: fromIdx },
      original: { type: 'move', targetBlockId: block.id, position: toIdx }
    });

    _persistPage(page);
    // 增量移动 DOM：先移除，再按「内存顺序中 toIdx 之后首个已渲染块」作为锚点插入。
    // 不能直接用 querySelectorAll('.note-block')[toIdx] 作索引：MD 模式下 DOM 中的
    // .note-block 数量可能少于内存 blocks（未渲染成块的 mdContent 不占 DOM 位），
    // 直接用 toIdx 会导致插入位置偏移，进而破坏相对顺序。
    // MD 模式：无 .note-block，跳过块 DOM 移动（数据层已更新）。
    var el = null;
    if (!mdModeActive) {
      el = contentEl ? contentEl.querySelector('[data-block-id="' + op.targetBlockId + '"]') : null;
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
        var refEl = null;
        for (var k = toIdx + 1; k < page.blocks.length; k++) {
          var cand = contentEl.querySelector('[data-block-id="' + page.blocks[k].id + '"]');
          if (cand) { refEl = cand; break; }
        }
        if (refEl) contentEl.insertBefore(el, refEl);
        else contentEl.appendChild(el);
      } else {
        renderPage(currentPageId);
      }
      _refreshMoveButtons();
      // 用户手动移动：短暂高亮反馈（复用 focus-highlight 脉冲）
      if (op.source === 'user' && el) {
        el.classList.remove('focus-highlight');
        void el.offsetWidth;
        el.classList.add('focus-highlight');
        setTimeout(function() { el.classList.remove('focus-highlight'); }, 1200);
      }
    }
    _fireBlockChange(block, 'update');
    return block;
  }

  // ---- 锁定 / 解锁（AI 处理期间锁定目标块） ----
  function lockBlocks(ids) {
    if (!ids || !ids.length) return;
    var changed = [];
    for (var i = 0; i < ids.length; i++) {
      var b = _findBlockById(ids[i]);
      if (b) { b.lock = true; changed.push(b); }
    }
    if (changed.length) {
      if (!mdModeActive) renderPage(currentPageId);
      for (var j = 0; j < changed.length; j++) _persistBlock(changed[j], currentPageId);
    }
  }

  function unlockBlocks(ids) {
    if (!ids || !ids.length) return;
    var changed = [];
    for (var i = 0; i < ids.length; i++) {
      var b = _findBlockById(ids[i]);
      if (b) { b.lock = false; changed.push(b); }
    }
    if (changed.length) {
      if (!mdModeActive) renderPage(currentPageId);
      for (var j = 0; j < changed.length; j++) _persistBlock(changed[j], currentPageId);
    }
  }

  // ============================================================
  // PDF 引用块插入（设计规格 §4.5、§11.3）
  // ============================================================

  function insertPdfRef(pdfRef, text) {
    if (!pdfRef || !text) return false;
    if (!_isWritable('划选文本推送')) return false;
    if (!_getCurrentPageObj()) {
      // 活页模式下：没有打开任何页面时给出引导，不静默丢弃
      var msg = '当前笔记还没有打开的页面，无法写入划选内容。请先在「📑 目录」中新建或打开一个页面。';
      try {
        if (window.__showToast) window.__showToast(msg);
        else alert(msg);
      } catch (e) {}
      return false;
    }
    // MD 模式：划选内容直接写入 mdContent（纯 MD 笔记本体），不创建 Block 文本框
    if (mdModeActive) {
      var page = _getCurrentPageObj();
      if (!page) return false;
      var pageNum = (pdfRef && pdfRef.pageNum != null) ? pdfRef.pageNum : null;
      var mdLine = '> ' + String(text).replace(/\r\n/g, '\n').split('\n').map(function(l) { return '> ' + l; }).join('\n');
      if (pageNum != null) mdLine += ' （P.' + pageNum + '）';
      var cur = page.mdContent || '';
      page.mdContent = cur.trim() ? (cur.replace(/\s*$/, '') + '\n\n' + mdLine) : mdLine;
      page.updatedAt = Date.now();
      DataLayer.putPageMd(page.id, page.mdContent);
      // 刷新当前页 MD 视图，让划词内容立即可见（保留当前子态）
      if (page.id === currentPageId && mdModeActive) _renderMdSubMode(page);
      return true;
    }
    var block = createBlock('pdf-ref', text, { pdfRef: pdfRef });
    // 通过 Operation 队列插入（用户来源，实时执行）
    return applyOperation({
      type: 'insert',
      block: block,
      source: 'user'
    });
  }

  // ============================================================
  // 块搜索（设计规格 §4.5，供聚焦功能调用）
  // ============================================================

  function searchBlocks(query) {
    if (!query || !currentNotebook) return [];
    var lowerQuery = query.toLowerCase();
    var results = [];
    for (var i = 0; i < currentNotebook.pages.length; i++) {
      var page = currentNotebook.pages[i];
      for (var j = 0; j < page.blocks.length; j++) {
        var block = page.blocks[j];
        if (block.content && block.content.toLowerCase().indexOf(lowerQuery) >= 0) {
          results.push({
            block: block,
            blockId: block.id,
            pageId: page.id,
            pageNum: (page.pdfRef && page.pdfRef.pageNum) ? page.pdfRef.pageNum : null,
            content: block.content,
            type: block.type
          });
        }
      }
    }
    return results;
  }

  // ============================================================
  // 辅助查询接口（Task 14）
  // ============================================================

  function getNotebook() { return currentNotebook; }
  function getCurrentPageId() { return currentPageId; }

  // ---- 获取当前选中的块 ----
  function getSelection() {
    if (!contentEl) return null;
    var focused = document.activeElement;
    if (focused && focused.classList && focused.classList.contains('note-block')) {
      var fid = focused.getAttribute('data-block-id');
      if (fid) return _findBlockById(fid);
    }
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.anchorNode && contentEl.contains(sel.anchorNode)) {
      var blockEl = _closestBlock(sel.anchorNode);
      if (blockEl) return _findBlockById(blockEl.getAttribute('data-block-id'));
    }
    return null;
  }

  // ---- 块变更事件 ----
  function onBlockChange(callback) {
    if (typeof callback === 'function') blockChangeCallbacks.push(callback);
  }

  function _fireBlockChange(block, changeType) {
    for (var i = 0; i < blockChangeCallbacks.length; i++) {
      try { blockChangeCallbacks[i](block, changeType); }
      catch (e) { /* 回调异常不影响主流程 */ }
    }
  }

  // ============================================================
  // 指令状态管理（设计规格增强：指令生命周期）
  // ============================================================

  /**
   * 标记指令块为"执行中"状态
   * @param {string} blockId - 指令块 ID
   */
  async function markCommandPending(blockId) {
    var block = _findBlockById(blockId);
    if (!block) return;
    block.status = 'pending';
    block.lock = true;
    await _persistBlock(block, currentPageId);
    renderPage(currentPageId);
  }

  /**
   * 标记指令块为"已完成"状态，去除结尾的结束标志
   * @param {string} blockId - 指令块 ID
   */
  async function markCommandComplete(blockId) {
    var block = _findBlockById(blockId);
    if (!block) return;
    block.status = 'complete';
    block.lock = false;
    // 去除结尾的 "..."、"。。。" 或 "。。"
    block.content = stripCommandEndMarker(block.content);
    await _persistBlock(block, currentPageId);
    renderPage(currentPageId);
  }

  /**
   * 创建 AI 输出占位块（在指令块下方插入）
   * @param {string} afterBlockId - 指令块 ID，占位块插入在其后
   * @param {string} cmdBlockId - 关联的指令块 ID（用于追溯）
   * @returns {Promise<object>} 创建的占位块
   */
  async function createAiPlaceholder(afterBlockId, cmdBlockId) {
    var page = _getCurrentPageObj();
    if (!page) return null;

    var insertIdx = _getBlockIndex(afterBlockId);
    if (insertIdx < 0) insertIdx = page.blocks.length - 1;

    var placeholder = createBlock('ai-placeholder', '⏳ AI 正在思考中...', {
      aiGenerated: true,
      placeholderFor: cmdBlockId || afterBlockId
    });
    placeholder.lock = true;

    page.blocks.splice(insertIdx + 1, 0, placeholder);
    page.updatedAt = Date.now();
    currentNotebook.updatedAt = Date.now();

    await _persistBlock(placeholder, page.id);
    await _persistPage(page);
    await DataLayer.put('notebooks', currentNotebook);

    renderPage(currentPageId);
    return placeholder;
  }

  /**
   * 更新 AI 占位块的流式内容（实时更新 DOM，不重新渲染整页）
   * @param {string} blockId - 占位块 ID
   * @param {string} content - 当前累积的内容
   * @param {string} state - 'streaming' | 'done'
   */
  function updateAiPlaceholder(blockId, content, state) {
    var block = _findBlockById(blockId);
    if (!block) return;

    block.content = content;

    // 实时更新 DOM（不重新渲染整页，避免光标跳动）
    var el = contentEl.querySelector('[data-block-id="' + blockId + '"]');
    if (el) {
      if (state === 'streaming') {
        el.classList.add('streaming');
        _contentElOf(el).textContent = content || '思考中...';
      } else if (state === 'done') {
        // 完成：重新渲染整页以应用 Markdown
        block.lock = false;
        _persistBlock(block, currentPageId);
        renderPage(currentPageId);
      }
    }
  }

  /**
   * 将占位块转为普通 AI 结果块（保留内容，更新类型）
   * @param {string} blockId - 占位块 ID
   */
  async function finalizeAiPlaceholder(blockId) {
    var block = _findBlockById(blockId);
    if (!block) return null;
    block.type = 'ai-result';
    block.lock = false;
    block.aiGenerated = true;
    // 排版规范化：压缩 AI 输出中的多余空行，避免笔记栏显示松散
    block.content = _normalizeAiText(block.content);
    await _persistBlock(block, currentPageId);
    renderPage(currentPageId);
    return block;
  }

  /**
   * 将占位块转为纯文本块（不渲染为 AI 结果样式）。
   * 用于无 API Key 等系统提示场景：提示信息作为普通笔记文本呈现，
   * 与"文字既是笔记"的语义一致，也便于测试断言 type === 'text'。
   * @param {string} blockId - 占位块 ID
   */
  async function finalizeAiPlaceholderAsText(blockId) {
    var block = _findBlockById(blockId);
    if (!block) return null;
    block.type = 'text';
    block.lock = false;
    block.aiGenerated = false;
    block.content = _normalizeAiText(block.content);
    await _persistBlock(block, currentPageId);
    renderPage(currentPageId);
    return block;
  }

  // AI 输出排版规范化：压缩连续空行（段落间最多保留 1 个空行）、列表项间不留空行、清理行尾空白
  function _normalizeAiText(text) {
    if (!text) return text;
    return text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n{2,}(?=(?:[-*]\s|\d+\.\s))/g, '\n')  // 列表项前的空行压掉，列表紧凑
      .trim();
  }

  /**
   * 获取指令块的纯净文本（去除结束标志）
   * @param {string} blockId
   * @returns {string}
   */
  function getCommandText(blockId) {
    var block = _findBlockById(blockId);
    if (!block) return '';
    return stripCommandEndMarker(block.content);
  }

  // ============================================================
  // 字体样式管理（Issue 6）
  // ============================================================

  /**
   * 应用字体样式到指定块
   * @param {string} blockId - 块 ID（为 null 时应用到当前聚焦块）
   * @param {string} fontSize - 字体大小（如 '18px'，为空字符串则清除）
   * @param {string} fontColor - 字体颜色（如 '#5a4a2a'，为空字符串则清除）
   */
  async function applyFontStyle(blockId, fontSize, fontColor) {
    var block = blockId ? _findBlockById(blockId) : null;
    if (!block) {
      // 尝试获取当前聚焦块
      var sel = getSelection();
      if (sel) block = sel;
    }
    if (!block) return;

    if (fontSize !== undefined) {
      block.fontSize = fontSize || null;
    }
    if (fontColor !== undefined) {
      block.fontColor = fontColor || null;
    }
    block.timestamp = Date.now();

    await _persistBlock(block, currentPageId);
    renderPage(currentPageId);
  }

  /**
   * 重置指定块的字体样式
   */
  async function resetFontStyle(blockId) {
    var block = blockId ? _findBlockById(blockId) : null;
    if (!block) {
      var sel = getSelection();
      if (sel) block = sel;
    }
    if (!block) return;

    block.fontSize = null;
    block.fontColor = null;
    block.timestamp = Date.now();

    await _persistBlock(block, currentPageId);
    renderPage(currentPageId);
  }

  // ============================================================
  // P7：打印当前笔记页（window.print + 横线笔记本样式，蓝图 §8.2）
  // ============================================================

  // 打印窗口内联样式（横线笔记本 + 左侧红线，与 .md-ruled-notebook 一致）
  function _printCss() {
    return [
      '* { box-sizing: border-box; }',
      'html, body { margin: 0; padding: 0; background: #fff; }',
      'body { font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #333; }',
      '.print-paper {',
      '  max-width: 700px; margin: 24px auto; padding: 12px 16px 12px 44px; line-height: 32px;',
      '  background-image:',
      '    linear-gradient(to right, transparent 36px, #e57373 36px, #e57373 37px, transparent 37px),',
      '    repeating-linear-gradient(to bottom, transparent 0, transparent 31px, #d8dee9 31px, #d8dee9 32px);',
      '  background-origin: padding-box, content-box;',
      '  background-repeat: no-repeat, no-repeat;',
      '  -webkit-print-color-adjust: exact;',
      '  print-color-adjust: exact;',
      '}',
      '.print-title { margin: 0; font-size: 22px; font-weight: 700; line-height: 32px; color: #3a5a40; }',
      '.print-page { margin: 0 0 8px 0; font-size: 13px; line-height: 32px; color: #999; border-bottom: 1px dashed #d8dee9; }',
      '.print-content p, .print-content h1, .print-content h2, .print-content h3,',
      '.print-content h4, .print-content h5, .print-content h6, .print-content li,',
      '.print-content blockquote, .print-content pre { line-height: 32px; margin: 0; }',
      '.print-content ul, .print-content ol { margin: 0; padding-left: 24px; }',
      '.print-content table { border-collapse: collapse; width: 100%; margin: 8px 0; }',
      '.print-content th, .print-content td { border: 1px solid #d8dee9; padding: 4px 8px; line-height: 1.5; text-align: left; }',
      '.print-content code { background: rgba(0,0,0,.05); padding: 1px 4px; border-radius: 3px; }',
      '.print-content pre { background: rgba(0,0,0,.04); padding: 8px 12px; overflow-x: auto; }',
      '.print-content pre code { background: none; padding: 0; }',
      '.print-content hr { border: none; border-top: 1px dashed #d8dee9; margin: 16px 0; }',
      '@media print { .print-paper { margin: 0; max-width: 100%; } }',
      '@page { size: A4; margin: 15mm; }'
    ].join('\n');
  }

  /**
   * 打印当前笔记页：新开打印窗口（window.print），横线样式保留。
   * 若当前页 mdContent 为空，则先迁移 blocks → MD（同预览逻辑）。
   */
  async function printPdf() {
    var page = _findPageById(currentPageId);
    if (!page) { alert('请先打开一本书的笔记页'); return; }

    var md = page.mdContent || '';
    if (!String(md).trim()) {
      try { md = await DataLayer.migratePageToMd(page.id) || ''; } catch (e) { md = ''; }
    }

    var title = (currentNotebook && currentNotebook.title) || '书虫蛊笔记';
    var pageName = page.name || ('第 ' + getCurrentPage() + ' 页');
    var html = renderMarkdown(md) || _escapeHtml(md);

    var w = window.open('', '_blank', 'width=820,height=1100,menubar=no,toolbar=no,location=no');
    if (!w || !w.document) { alert('打印窗口被浏览器拦截，请允许弹出窗口后重试'); return; }

    var doc = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<title>' + _escapeHtml(title + ' · ' + pageName) + '</title>'
      + '<style>' + _printCss() + '</style></head><body>'
      + '<div class="print-paper">'
      + '<h1 class="print-title">' + _escapeHtml(title) + '</h1>'
      + '<p class="print-page">' + _escapeHtml(pageName) + '</p>'
      + '<div class="print-content">' + html + '</div>'
      + '</div>'
      + '<script>window.onload=function(){setTimeout(function(){window.print();},200);};<\/script>'
      + '</body></html>';

    w.document.open();
    w.document.write(doc);
    w.document.close();
  }

  // ---------- 导出：把笔记页渲染为图片 / PDF（所见即所得）----------
  // 2026-08-18：用 html2canvas 渲染预览 DOM；HTML 组件（iframe）先抓内容图替换为 <img>，
  // 流程图（canvas）原生捕获 → 图片/PDF 与笔记预览一致。
  // 2026-08-19 导出诊断：记录上一次导出的组件渲染成败（供失败时定位，导出文件缺组件时 console/弹窗有据可查）
  var _lastExportDiag = null;
  function _exportDiagSuffix() {
    if (!_lastExportDiag) return '';
    try { return '\n\n组件渲染诊断：' + JSON.stringify(_lastExportDiag); } catch (e) { return ''; }
  }

  async function _buildExportCanvas(pageId) {
    if (typeof html2canvas === 'undefined') throw new Error('导出组件未加载（html2canvas）');
    var page = _findPageById(pageId);
    if (!page) throw new Error('页面不存在');
    var md = (page && page.mdContent) || '';
    // 2026-08-19 修复：mdContent 为空时先迁移 blocks → MD（同打印逻辑），
    // 避免从未打开过 MD 预览的笔记页导出为空白
    if (!String(md).trim() && typeof DataLayer !== 'undefined' && DataLayer.migratePageToMd) {
      try { md = await DataLayer.migratePageToMd(page.id) || ''; } catch (e) { md = ''; }
    }
    var holder = document.createElement('div');
    holder.className = 'md-preview md-content md-ruled-notebook export-holder';
    holder.style.cssText = 'position:fixed;left:-12000px;top:0;width:860px;max-width:860px;background:#fff;z-index:-9999;padding:24px 28px;';
    if (md && String(md).trim()) {
      holder.innerHTML = renderMarkdown(md);
    } else {
      holder.innerHTML = '<p><br></p>';
    }
    document.body.appendChild(holder);
    // 2026-08-19 导出诊断：收集各组件渲染成败
    var diag = { mdLen: String(md || '').length, imgBoxes: 0, imgOk: 0, imgFail: 0, htmlFrames: 0, htmlOk: 0, htmlFail: 0, htmlFailReason: [], diagramBlocks: 0 };
    var editorStart = _diagramEditors.length;
    // 初始化流程图 canvas（渲染到离屏容器同样有效）
    try { _initDiagramBlocks(holder, false); } catch (e) {}
    try { diag.diagramBlocks = holder.querySelectorAll('.diagram-block').length; } catch (e) {}
    // 2026-08-19 修复：导出前恢复块级组件的保存状态（浮动位置/宽高/等比缩放），
    // 与预览栏所见一致——否则组件回到默认流式排布/默认尺寸，放大或移位的组件会显示不全
    try { _applyBlocksUiForExport(holder, page); } catch (e) {}
    // 移除交互元素（操作条/拖拽手柄/名称行/隐藏源码/调整边框），只留展示内容
    try {
      holder.querySelectorAll('.block-action-bar, .block-drag-handle, .html-resize-edge, .block-name-row, .html-source, .diagram-source, .block-mode-toggle').forEach(function(el) {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
    } catch (e) {}
    // 等流程图/iframe 渲染稳定（块 UI 应用 + 流程图 handleResize 需要时间）
    await new Promise(function(res) { setTimeout(res, 650); });
    // 2026-08-19 图片：导出前解析 scimg:// 引用（加载真实 blob URL）
    try { await _resolvePreviewImages(holder); } catch (e) {}
    // 2026-08-19 统计图片解析结果（.img-ready/.img-fail 由 _resolvePreviewImages 设置）
    try {
      diag.imgBoxes = holder.querySelectorAll('.note-img-box').length;
      diag.imgOk = holder.querySelectorAll('.note-img-box.img-ready').length;
      diag.imgFail = holder.querySelectorAll('.note-img-box.img-fail').length;
    } catch (e) {}
    // HTML 组件 iframe（srcdoc 同源）→ 抓取内容渲染为图片并原位替换
    // 2026-08-19 增强：contentDocument 未就绪时重试（srcdoc 加载慢/复杂组件），避免抓图失败导出空白
    var frames = holder.querySelectorAll('.html-block-container .html-iframe');
    diag.htmlFrames = frames.length;
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var fdoc = null;
      for (var attempt = 0; attempt < 4 && !fdoc; attempt++) {
        try { fdoc = frame.contentDocument; } catch (e) { fdoc = null; }
        if (!fdoc || !fdoc.body) {
          await new Promise(function(res) { setTimeout(res, 250); });
          fdoc = null;
        }
      }
      if (!fdoc || !fdoc.body) {
        diag.htmlFail++;
        diag.htmlFailReason.push('iframe-doc-未就绪');
        continue;
      }
      try {
        var fCanvas = await html2canvas(fdoc.body, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false });
        var img = document.createElement('img');
        img.src = fCanvas.toDataURL('image/png');
        img.style.cssText = 'display:block;width:100%;border:none;';
        // 2026-08-19 等比缩放（viewScale）：预览中 HTML 组件经 iframe transform 放大，
        // 抓图后需对替换图施以相同缩放，导出与预览一致（变换边界计入容器扩展）
        try {
          var hc = frame.closest ? frame.closest('.html-block-container') : null;
          if (hc) {
            var hk = _blockUiKey(page, hc);
            var hu = _loadBlockUi(hk);
            if (hu && typeof hu.viewScale === 'number' && hu.viewScale > 0.1 && hu.viewScale < 10 && hu.viewScale !== 1) {
              img.style.transformOrigin = 'top left';
              img.style.transform = 'scale(' + hu.viewScale + ')';
            }
          }
        } catch (e3) {}
        if (frame.parentNode) frame.parentNode.replaceChild(img, frame);
        diag.htmlOk++;
      } catch (e2) {
        diag.htmlFail++;
        diag.htmlFailReason.push(String(e2 && e2.message ? e2.message : e2));
      }
    }
    // 2026-08-19 修复：按实际渲染边界扩展导出容器——浮动组件（absolute）、放大组件（transform
    // scale / 大图）不占文档流，若仍按行数高度计算，底部/右侧组件会被 html2canvas 裁切。
    try { _expandExportHolder(holder); } catch (e) {}
    // 2026-08-19 导出横线背景：html2canvas 不支持 repeating-linear-gradient，
    // 用 DOM 层补画横线/红线（z-index:-1 位于内容下方，与笔记栏 .md-ruled-notebook 所见一致）
    try { _addExportRuledLayer(holder); } catch (e) {}
    // 2026-08-19 输出导出诊断（供失败定位；缺组件时 console 有据可查）
    _lastExportDiag = diag;
    try { console.info('[导出诊断]', JSON.stringify(diag)); } catch (e) {}
    try {
      var canvas = await html2canvas(holder, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false });
      // 释放本次创建的临时 DiagramEditor 实例（避免残留引用）
      if (_diagramEditors.length > editorStart) _diagramEditors.length = editorStart;
      return canvas;
    } catch (e) {
      if (_diagramEditors.length > editorStart) _diagramEditors.length = editorStart;
      throw e;
    } finally {
      try { if (holder.parentNode) holder.parentNode.removeChild(holder); } catch (e) {}
    }
  }

  // 2026-08-19 导出专用：恢复块级组件（HTML/流程图）保存的展示状态（浮动位置/宽高/等比缩放）。
  // 与预览栏 _initBlockResizeAndDrag → _applyBlockUi 同一数据源（shuchongu_blockui_*），
  // 保证导出效果 = 预览所见。无保存数据时保持默认流式排布。
  function _applyBlocksUiForExport(holder, page) {
    if (!holder || !page) return;
    var blocks = holder.querySelectorAll('.html-block-container, .diagram-block');
    for (var i = 0; i < blocks.length; i++) {
      try {
        var key = _blockUiKey(page, blocks[i]);
        var ui = _loadBlockUi(key);
        if (ui) _applyBlockUi(blocks[i], ui);
      } catch (e) {}
    }
  }

  // 2026-08-19 导出专用：按全部内容的实际渲染边界扩展导出容器。
  // 预览中组件可自由移动（absolute 浮动）、放大（transform scale / 自定义宽高 / 大图），
  // 这些组件不占文档流高度，若容器只按行数高度绘制，底部/右侧组件会被 html2canvas 裁切。
  // 此处遍历 holder 内所有可见元素，取其最大 right/bottom 扩展宽高，保证完整呈现。
  function _expandExportHolder(holder) {
    if (!holder) return;
    var cs = window.getComputedStyle(holder);
    var pt = parseFloat(cs.paddingTop) || 0;
    var pb = parseFloat(cs.paddingBottom) || 0;
    var pl = parseFloat(cs.paddingLeft) || 0;
    var pr = parseFloat(cs.paddingRight) || 0;
    var baseW = holder.offsetWidth || 860;
    var baseH = holder.offsetHeight || 400;
    var hr = holder.getBoundingClientRect();
    var maxR = pl + Math.max(0, baseW - pl - pr);
    var maxB = pt + Math.max(0, baseH - pt - pb);
    var els = holder.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      var right = r.left - hr.left + r.width;
      var bottom = r.top - hr.top + r.height;
      if (right > maxR) maxR = right;
      if (bottom > maxB) maxB = bottom;
    }
    var newW = Math.max(baseW, Math.ceil(maxR + pr));
    var newH = Math.max(baseH, Math.ceil(maxB + pb));
    if (newW !== baseW) {
      holder.style.width = newW + 'px';
      holder.style.maxWidth = 'none';
    }
    if (newH !== baseH) holder.style.height = newH + 'px';
  }

  // 2026-08-19 导出专用横线背景层：html2canvas 不支持 repeating-linear-gradient（横线）与
  // background-attachment:local，因此用 DOM 层补画——每 line-height 一条横线（#d8dee9）、
  // 左侧 x=16px 一条红线（#e57373），z-index:-1 置于内容下方，与笔记栏 .md-ruled-notebook 一致。
  function _addExportRuledLayer(holder) {
    if (!holder) return;
    var cs = window.getComputedStyle(holder);
    var pt = parseFloat(cs.paddingTop) || 0;
    var pb = parseFloat(cs.paddingBottom) || 0;
    var pl = parseFloat(cs.paddingLeft) || 0;
    var pr = parseFloat(cs.paddingRight) || 0;
    var lh = parseFloat(cs.lineHeight) || 32;
    if (lh <= 0) lh = 32;
    var innerH = holder.clientHeight || holder.offsetHeight || 400;
    // 横线层（覆盖内容区）
    var layer = document.createElement('div');
    layer.setAttribute('contenteditable', 'false');
    layer.style.cssText = 'position:absolute;left:' + pl + 'px;right:' + pr + 'px;top:' + pt + 'px;bottom:' + pb + 'px;z-index:-1;pointer-events:none;overflow:hidden;';
    var contentH = Math.max(0, innerH - pt - pb);
    var count = Math.floor(contentH / lh) + 1;
    var frag = document.createDocumentFragment();
    for (var k = 1; k <= count; k++) {
      var ln = document.createElement('div');
      ln.style.cssText = 'position:absolute;left:0;right:0;top:' + Math.round(k * lh - 1) + 'px;height:1px;background:#d8dee9;';
      frag.appendChild(ln);
    }
    layer.appendChild(frag);
    holder.appendChild(layer);
    // 左侧红线（padding-box 左缘 x=16px，覆盖整高）
    var red = document.createElement('div');
    red.setAttribute('contenteditable', 'false');
    red.style.cssText = 'position:absolute;left:16px;top:0;bottom:0;width:1px;background:#e57373;z-index:-1;pointer-events:none;';
    holder.appendChild(red);
  }

  // ============================================================
  // 2026-08-15 扩展1：HTML 代码块 → 沙盒 iframe 渲染
  // 扩展2：@[diagram:ID] → Canvas 流程图编辑器（高自由度绘图）
  // ============================================================

  // ---------- Base64（UTF-8 安全）----------
  function _encodeBase64(str) {
    try { return btoa(unescape(encodeURIComponent(str || ''))); }
    catch (e) { return ''; }
  }
  function _decodeBase64(b64) {
    try { return decodeURIComponent(escape(atob(b64 || ''))); }
    catch (e) { return ''; }
  }

  // ---------- 转义 HTML 实体（保留换行，用于 hidden 源码 keeper 文本）----------
  // 注：现有 _escapeHtml 会把 \n 转 <br>，会破坏 ``` 围栏结构，故此处单独实现。
  function _escapeHtmlPlain(s) {
    return (s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- 反转义 marked 输出的 HTML 实体（恢复原始 HTML 文本）----------
  function _decodeHtmlEntities(s) {
    return (s || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'); // 最后还原 & 避免重复解码
  }

  // ---------- 转义为 HTML 属性值（双引号上下文）----------
  function _escapeAttr(s) {
    return (s || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 构造 HTML 块的 srcdoc 文档（注入自适应高度上报脚本）
  // 2026-08-17 修复：剥离源码里的完整文档外壳（<html>/<head>/<body> 与 <style>），
  // 避免嵌套 <html><body> 导致 DOM 异常、scrollHeight 虚高 → iframe 出现大量空白撑高组件
  function _buildHtmlSrcdoc(rawHtml) {
    var src = String(rawHtml || '');
    var extraStyles = [];
    // 1) 提取源码中的 <style> 块，合并进 srcdoc 的 head
    src = src.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function(m, body) {
      if (body && body.trim()) extraStyles.push(body);
      return '';
    });
    // 2) 只取 <body> 内部内容，丢掉完整文档外壳
    var bodyMatch = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) src = bodyMatch[1];
    // 3) 清除残留的 <html>/<head> 标签
    src = src.replace(/<\/?(?:html|head|body)[^>]*>/gi, '');

    var script = '<script>(function(){'
      + 'var paused=false,obs=null,timers=[];'
      + 'function r(){try{'
      // 2026-08-19 修复：改为按「正常流内容下边界」计算高度。
      // 旧逻辑 h=max(body.offsetHeight, body.scrollHeight) 在组件含 height:100vh 与
      // 绝对定位溢出元素（如全屏背景+上升气泡）时形成正反馈：100vh 随 iframe 高度增大 →
      // scrollHeight 计入绝对定位溢出 → 上报高度一路暴涨到 5000 钳制，iframe 被拉得异常长。
      // 现排除 absolute/fixed 浮动层、只统计正常流可见元素最大 bottom（+body paddingBottom），
      // 对 flex 居中的 100vh 组件收敛到内容高度（不动点=内容高），普通组件结果不变。
      + 'if(paused)return;'
      + 'var body=document.body||document.documentElement;'
      + 'var maxB=0;'
      + 'var els=body?body.querySelectorAll(\'*\'):[];'
      + 'for(var i=0;i<els.length;i++){try{'
      + 'var el=els[i];'
      + 'var st=window.getComputedStyle(el);'
      + 'if(st.display===\'none\'||st.visibility===\'hidden\')continue;'
      + 'var pos=st.position;'
      + 'if(pos===\'absolute\'||pos===\'fixed\')continue;'
      + 'var r=el.getBoundingClientRect();'
      + 'if(r.width<=0&&r.height<=0)continue;'
      + 'var b=r.top+r.height;'
      + 'if(b>maxB)maxB=b;'
      + '}catch(e){}}'
      + 'var pb=body?parseFloat(window.getComputedStyle(body).paddingBottom)||0:0;'
      + 'var h=Math.ceil(maxB+pb);'
      + 'if(h<10)h=10;'
      + 'if(h>20000)h=20000;'
      + 'parent.postMessage({__htmlBlock:1,h:h},\'*\');'
      + '}catch(e){}}'
      + 'function connect(){'
      + 'if(window.MutationObserver&&document.body&&!obs){'
      + 'obs=new MutationObserver(function(){r();});'
      + 'obs.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});'
      + '}'
      + '}'
      + 'window.addEventListener(\'load\',function(){if(!paused)r();});'
      + 'window.addEventListener(\'resize\',function(){if(!paused)r();});'
      + 'if(!paused){timers.push(setTimeout(function(){r();},100));'
      + 'timers.push(setTimeout(function(){r();},300));'
      + 'timers.push(setTimeout(function(){r();},800));}'
      + 'connect();'
      // 父页面拖拽调整尺寸时暂停高度上报，避免每次高度变化都触发布局计算导致卡顿
      + 'window.addEventListener(\'message\',function(ev){'
      + 'var d=ev.data;if(!d)return;'
      + 'if(d.__htmlBlockPause===1){paused=true;'
      + 'if(obs){try{obs.disconnect();}catch(e){}obs=null;}'
      + 'for(var i=0;i<timers.length;i++){clearTimeout(timers[i]);}timers=[];}'
      + 'else if(d.__htmlBlockResume===1){paused=false;timers=[];connect();'
      + 'timers.push(setTimeout(function(){r();},0));'
      + 'timers.push(setTimeout(function(){r();},100));}'
      + '});'
      + '})();<\/script>';
    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<style>html,body{margin:0;padding:0;height:auto;min-height:0;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#222;background:#fff;}'
      + 'body{padding:8px 10px;line-height:1.6;}'
      + 'img{max-width:100%;}'
      + 'table{border-collapse:collapse;width:100%;}'
      + 'td,th{border:1px solid #ddd;padding:6px 10px;}'
      + 'pre{white-space:pre-wrap;word-break:break-word;}'
      + 'video,iframe{max-width:100%;}'
      + (extraStyles.length ? '\n' + extraStyles.join('\n') : '')
      + '</style></head><body>'
      + src
      + script
      + '</body></html>';
  }

  function _postProcessHtmlBlocks(html) {
    if (!html || html.indexOf('language-html') < 0) return html;
    var re = /<pre><code[^>]*class="[^"]*language-html[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/g;
    return html.replace(re, function(m, escapedBody) {
      var raw = _decodeHtmlEntities(escapedBody || '');
      // 旧形态兜底：迁移为 @[html:ID] 引用（避免下次再走到这里）
      var id = _generateHtmlId();
      saveHtml(id, raw);
      return _htmlBlockHtmlByRef(id);
    });
  }

  // P1-9 专属名称行：块的默认 AI 命名
  function _defaultBlockName(kind, id, ui) {
    if (ui && ui.name && String(ui.name).trim()) return String(ui.name).trim();
    var ts = (id && /[_\-](\w{4,8})_?/.test(id)) ? RegExp.$1 : String(Date.now()).slice(-4);
    if (kind === 'html')    return '网页卡片 · ' + ts;
    if (kind === 'diagram') return '流程图 · ' + ts;
    return '附件 · ' + ts;
  }
  // P1-9 名称行 HTML（左下角专属行，可点击编辑）
  function _blockNameRowEl(kind, id, ui) {
    var el = document.createElement('div');
    el.className = 'block-name-row';
    el.setAttribute('contenteditable', 'false');
    el.setAttribute('title', '点击重命名（AI 默认命名，可直接修改）');
    el.setAttribute('style',
      'position:absolute;left:0;bottom:0;padding:4px 10px;border-top-right-radius:8px;' +
      'background:linear-gradient(135deg,rgba(238,242,255,.95),rgba(248,250,252,.95));' +
      'backdrop-filter:blur(4px);font-size:12px;color:#4338ca;font-weight:600;' +
      'border-top:1px solid rgba(0,0,0,.06);border-right:1px solid rgba(0,0,0,.06);' +
      'max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'cursor:text;user-select:none;z-index:10;pointer-events:auto;'
    );
    el.textContent = _defaultBlockName(kind, id, ui);
    // 点击 -> 就地编辑
    function startEdit() {
      var cur = el.textContent;
      var input = document.createElement('input');
      input.type = 'text';
      input.value = cur;
      input.setAttribute('style',
        'display:inline-block;min-width:180px;max-width:260px;padding:2px 6px;border:1px solid #a5b4fc;' +
        'border-radius:4px;font:inherit;color:inherit;background:#fff;outline:none;'
      );
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      input.select();
      function finish(cancel) {
        var next = cancel ? cur : (input.value ? String(input.value).trim() : cur);
        if (!next) next = cur;
        el.textContent = next;
        // 持久化到 BlockUI
        try {
          var container = el.closest('.html-block-container, .diagram-block');
          if (container) {
            var block = container.closest('[data-block-id]');
            var page = (typeof currentPage !== 'undefined') ? currentPage : null;
            var key = _blockUiKey(page, block || container);
            var u = _loadBlockUi(key) || {};
            u.name = next;
            _saveBlockUi(key, u);
          }
        } catch (e) {}
      }
      input.addEventListener('blur', function(){ finish(false); });
      input.addEventListener('keydown', function(ev){
        if (ev.key === 'Enter') { ev.preventDefault(); finish(false); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(true); }
      });
    }
    el.addEventListener('click', function(ev){ ev.stopPropagation(); startEdit(); });
    return el;
  }

  // ---------- HTML 块 HTML（基于 @[html:ID] 引用，含 hidden 占位符 keeper）----------
  // 2026-08-17：直接渲染真实效果（iframe），源码不进入 mdContent（只有 @[html:ID] 占位符），
  // 因此 Markdown 解析/序列化 永远不会把 HTML 源码当 Markdown 渲染导致崩溃
  function _htmlBlockHtmlByRef(id) {
    var rawHtml = loadHtml(id) || '';
    var srcdoc = _buildHtmlSrcdoc(rawHtml);
    var srcdocAttr = _escapeAttr(srcdoc);
    var keeper = '<p class="html-source" style="display:none">@[html:' + id + ']</p>';
    return '<p><br></p>'
      + '<div class="html-block-container" contenteditable="false" data-html-id="' + id + '" data-interact-mode="drag" style="position:relative;">'
      + '<div class="block-action-bar" contenteditable="false">'
      + '<div class="block-drag-handle" title="拖动以移动位置">⇱</div>'
      + '<div class="block-mode-toggle" role="tablist" aria-label="交互模式">'
      + '<button class="mode-btn mode-drag active" type="button" title="拖动模式：移动HTML块">▢拖</button>'
      + '<button class="mode-btn mode-resize" type="button" title="调整形状模式：拖拽边界改变大小">⇲调</button>'
      + '</div>'
      + '<button class="block-btn block-ai-btn" type="button" title="AI 改进">AI 改进</button>'
      + '<button class="block-btn block-delete-btn" type="button" title="删除">删除</button>'
      + '</div>'
      + '<iframe class="html-iframe" sandbox="allow-scripts allow-same-origin" srcdoc="' + srcdocAttr + '" style="width:100%;border:none;min-height:80px;"></iframe>'
      + '<div class="html-resize-edge html-resize-edge-top" data-edge="n"></div>'
      + '<div class="html-resize-edge html-resize-edge-right" data-edge="e"></div>'
      + '<div class="html-resize-edge html-resize-edge-bottom" data-edge="s"></div>'
      + '<div class="html-resize-edge html-resize-edge-left" data-edge="w"></div>'
      + keeper
      + '</div>'
      + '<p><br></p>';
  }

  // 后处理：将 @[html:ID] 替换为 HTML 沙盒 iframe 容器
  function _postProcessHtmlRefs(html) {
    if (!html || html.indexOf('@[html:') < 0) return html;
    var processedIds = {};
    // 1) 独占段落：<p>@[html:ID]</p> → 块级容器（避免 <p> 内嵌 <div> 的非法嵌套）
    html = html.replace(/<p>\s*@\[html:([A-Za-z0-9_\-]+)\]\s*<\/p>/g, function(m, id) {
      processedIds[id] = true;
      return _htmlBlockHtmlByRef(id);
    });
    // 2) 行内残留（与其它文字混排时）：直接替换（跳过已处理的 ID）
    html = html.replace(/@\[html:([A-Za-z0-9_\-]+)\]/g, function(m, id) {
      if (processedIds[id]) return m;
      processedIds[id] = true;
      return _htmlBlockHtmlByRef(id);
    });
    return html;
  }

  // ---------- 流程图块 HTML（含 hidden 源码 keeper）----------
  function _diagramBlockHtml(id) {
    var keeper = '<p class="diagram-source" style="display:none">@[diagram:' + id + ']</p>';
    // 添加空行 + 拖拽手柄 + AI/删除按钮 + 容器 + 双尺寸调整手柄（右下变框/左下等比缩放）
    return '<p><br></p>'
      + '<div class="diagram-block" contenteditable="false" data-diagram-id="' + id + '" data-interact-mode="drag" style="position:relative;">'
      + '<div class="block-action-bar diagram-action-bar" contenteditable="false">'
      + '<div class="block-drag-handle" title="拖动以移动位置">⇱</div>'
      + '<div class="block-mode-toggle" role="tablist" aria-label="交互模式">'
      + '<button class="mode-btn mode-drag active" type="button" title="拖动模式：移动流程图">▢拖</button>'
      + '<button class="mode-btn mode-resize" type="button" title="调整形状模式：拖拽边界改变大小">⇲调</button>'
      + '</div>'
      + '<button class="block-btn block-ai-btn" type="button" title="AI 改进">AI 改进</button>'
      + '<button class="block-btn block-delete-btn" type="button" title="删除">删除</button>'
      + '</div>'
      + keeper
      + '<div class="diagram-placeholder"></div>'
      
      + '</div>'
      + '<p><br></p>';
  }

  // 后处理：将 @[diagram:ID] 替换为流程图 Canvas 容器
  function _postProcessDiagramBlocks(html) {
    if (!html || html.indexOf('@[diagram:') < 0) return html;
    // 记录已处理的 ID，防止重复渲染
    var processedIds = {};
    // 1) 独占段落：<p>@[diagram:ID]</p> → 块级容器（避免 <p> 内嵌 <div> 的非法嵌套）
    html = html.replace(/<p>\s*@\[diagram:([A-Za-z0-9_\-]+)\]\s*<\/p>/g, function(m, id) {
      processedIds[id] = true;
      return _diagramBlockHtml(id);
    });
    // 2) 行内残留（与其它文字混排时）：直接替换（跳过已处理的 ID）
    html = html.replace(/@\[diagram:([A-Za-z0-9_\-]+)\]/g, function(m, id) {
      if (processedIds[id]) return m; // 已处理，跳过
      processedIds[id] = true;
      return _diagramBlockHtml(id);
    });
    return html;
  }

  // ============================================================
  // 2026-08-19 笔记图片：IndexedDB 独立存储 + scimg:// 短引用 + 压缩 + 交互
  // 笔记 mdContent 只保存短引用 ![名称](scimg://img_xxx)，图片 Blob 存
  // IndexedDB noteImages store（DataLayer v6），避免 base64 撑爆笔记体积。
  // ============================================================
  var _imgUrlCache = {};      // id → objectURL（防重复创建/泄漏）
  var _imgUrlPromises = {};   // id → Promise<objectURL>
  var _IMG_PH = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  // 2026-08-19 拖拽边界等比缩放：图片四周 8 个手柄（hover 显示，拖拽锁定原图比例）
  var _IMG_HANDLES_HTML =
      '<span class="img-resize-handle irh-nw" data-dir="nw"></span>'
    + '<span class="img-resize-handle irh-n" data-dir="n"></span>'
    + '<span class="img-resize-handle irh-ne" data-dir="ne"></span>'
    + '<span class="img-resize-handle irh-e" data-dir="e"></span>'
    + '<span class="img-resize-handle irh-se" data-dir="se"></span>'
    + '<span class="img-resize-handle irh-s" data-dir="s"></span>'
    + '<span class="img-resize-handle irh-sw" data-dir="sw"></span>'
    + '<span class="img-resize-handle irh-w" data-dir="w"></span>';


  function _imgStorePut(id, blob, meta) {
    if (typeof DataLayer === 'undefined' || !DataLayer.put) return Promise.reject(new Error('DataLayer 不可用'));
    return DataLayer.put('noteImages', {
      id: id, blob: blob,
      name: meta && meta.name ? meta.name : '',
      mime: meta && meta.mime ? meta.mime : (blob && blob.type || 'image/jpeg'),
      w: meta && meta.w ? meta.w : 0,
      h: meta && meta.h ? meta.h : 0,
      createdAt: Date.now()
    });
  }
  function _imgStoreGet(id) {
    if (typeof DataLayer === 'undefined' || !DataLayer.get) return Promise.resolve(null);
    return DataLayer.get('noteImages', id).then(function(r) { return r && r.blob ? r.blob : null; });
  }
  function _imgStoreDelete(id) {
    if (typeof DataLayer === 'undefined' || !DataLayer.delete) return Promise.resolve();
    if (_imgUrlCache[id]) { try { URL.revokeObjectURL(_imgUrlCache[id]); } catch (e) {} delete _imgUrlCache[id]; }
    delete _imgUrlPromises[id];
    return DataLayer.delete('noteImages', id);
  }

  // 2026-08-19 图片镜像到附件空间（与流程图/HTML 组件一致：附件管理器可查看/复用这份图片）
  // 幂等：nodeId 固定为 img_<id>，重复写入覆盖同名附件
  function _imgMirrorToAttachments(id, blob, name) {
    try {
      if (!id || !blob) return Promise.resolve(null);
      if (typeof AttachmentManager === 'undefined' || !AttachmentManager.addSourceBlob) return Promise.resolve(null);
      var bookId = _resolveBookIdForHtml();
      if (!bookId) return Promise.resolve(null);
      var mime = blob.type || 'image/jpeg';
      var ext = (mime.indexOf('png') >= 0) ? 'png' : (mime.indexOf('gif') >= 0 ? 'gif' : (mime.indexOf('webp') >= 0 ? 'webp' : 'jpg'));
      var shortId = String(id).slice(-6);
      return AttachmentManager.addSourceBlob(
        bookId,
        '图片_' + shortId + '.' + ext,
        blob,
        mime,
        'img_' + id
      );
    } catch (e) { return Promise.resolve(null); }
  }
  // 2026-08-19 删除图片时同步移除附件镜像（与其他组件删除行为一致）
  function _imgUnmirrorFromAttachments(id) {
    try {
      if (!id) return;
      if (typeof AttachmentManager === 'undefined' || !AttachmentManager.removeSourceFile) return;
      var bookId = _resolveBookIdForHtml();
      if (!bookId) return;
      AttachmentManager.removeSourceFile(bookId, 'img_' + id);
    } catch (e) {}
  }
  // 取图片 objectURL（内存缓存）
  function _imgGetURL(id) {
    if (!id) return Promise.reject(new Error('缺少图片 id'));
    if (_imgUrlCache[id]) return Promise.resolve(_imgUrlCache[id]);
    if (_imgUrlPromises[id]) return _imgUrlPromises[id];
    _imgUrlPromises[id] = _imgStoreGet(id).then(function(blob) {
      if (!blob) { delete _imgUrlPromises[id]; throw new Error('图片不存在：' + id); }
      var url = URL.createObjectURL(blob);
      _imgUrlCache[id] = url;
      delete _imgUrlPromises[id];
      return url;
    });
    return _imgUrlPromises[id];
  }

  // 渲染后置处理：scimg:// 引用 → 可交互图片容器（真实 src 由 _resolvePreviewImages 异步填充；
  // 加载提示用 CSS ::before，不产生 DOM 文本，避免序列化污染 mdContent）
  function _postProcessImageRefs(html) {
    if (!html || html.indexOf('scimg://') < 0) return html;
    return html.replace(/<img([^>]*)src="scimg:\/\/([A-Za-z0-9_\-]+)"([^>]*)>/g, function(m, pre, id, post) {
      var am = (pre + post).match(/alt="([^"]*)"/);
      var alt = am ? am[1] : '';
      return '<span class="note-img-box" contenteditable="false" data-img-id="' + id + '">'
        + '<span class="note-img-loading"></span>'
        + '<span class="note-img-wrap">'
        + '<img src="' + _IMG_PH + '" data-src="scimg://' + id + '" class="note-img" alt="' + alt + '" loading="lazy">'
        + _IMG_HANDLES_HTML
        + '</span>'
        + '</span>';
    });
  }

  // 解析容器内所有笔记图片：异步加载 blob URL + 应用已保存的尺寸/对齐
  function _resolvePreviewImages(container) {
    if (!container || !container.querySelector) return Promise.resolve();
    var boxes = container.querySelectorAll('.note-img-box');
    if (!boxes.length) return Promise.resolve();
    var tasks = [];
    for (var bi = 0; bi < boxes.length; bi++) (function(box) {
      var id = box.getAttribute('data-img-id');
      var img = box.querySelector('img.note-img');
      if (!id || !img) return;
      tasks.push(_imgGetURL(id).then(function(url) {
        img.src = url;
        _applyImageBoxUi(box, id);
        box.classList.add('img-ready');
        box.classList.remove('img-fail');
        // 2026-08-19 渲染出现的图片实时镜像到附件空间（保证所有笔记图片都进入附件）
        _imgStoreGet(id).then(function(blob) {
          if (blob) _imgMirrorToAttachments(id, blob, img.getAttribute('alt') || '图片');
        }).catch(function() {});
      }).catch(function() {
        box.classList.add('img-fail');
      }));
    })(boxes[bi]);
    return Promise.all(tasks);
  }

  // ---- 图片尺寸/对齐持久化（localStorage：shuchongu_imgui_<id>）----
  function _imgUiGet(id) {
    try { var s = localStorage.getItem('shuchongu_imgui_' + id); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function _imgUiSet(id, ui) {
    try { localStorage.setItem('shuchongu_imgui_' + id, JSON.stringify(ui || {})); } catch (e) {}
  }
  function _applyImageBoxUi(box, id) {
    if (!box) return;
    var ui = _imgUiGet(id);
    var w = ui && ui.w ? ui.w : 'auto';
    var align = ui && ui.align ? ui.align : 'center';
    var img = box.querySelector('img.note-img');
    var wrap = box.querySelector('.note-img-wrap');
    box.classList.remove('img-w-auto', 'img-w-25', 'img-w-50', 'img-w-75', 'img-w-100', 'img-w-custom');
    if (w === 'custom') {
      // 2026-08-19 拖拽自定义尺寸：宽度按百分比持久化（作用于 box，wrap 100% 填满保持原图比例）
      box.classList.add('img-w-custom');
      var pct = (ui && ui.pct) ? ui.pct : 50;
      box.style.width = Math.max(5, Math.min(100, pct)) + '%';
    } else {
      box.style.width = '';
      box.classList.add('img-w-' + w);
    }
    if (img) { img.style.width = ''; img.style.height = ''; }
    if (wrap) wrap.style.width = '';
    box.classList.remove('img-align-left', 'img-align-center', 'img-align-right');
    box.classList.add('img-align-' + align);
    // 2026-08-19 图文混排：图片独占段落时按对齐设置段落 text-align（box 为 inline-block，
    // 自身 text-align 无法控制行内对齐；图片行其余区域可正常输入文字）
    var parent = box.parentElement;
    if (parent && parent.tagName === 'P') {
      var onlyImg = Array.prototype.every.call(parent.childNodes, function(n) {
        return n === box || (n.nodeType === 3 && !n.textContent.trim());
      });
      parent.style.textAlign = onlyImg ? align : '';
    }
    // 2026-08-19 自由拖拽位置（贴纸式）：位移持久化，重新渲染时恢复；
    // 移出原位后 box 高度归零（img-freemoved）不占文档流行，原位置可正常输入文字
    if (wrap) {
      var mx = (ui && ui.moveX) ? ui.moveX : 0;
      var my = (ui && ui.moveY) ? ui.moveY : 0;
      wrap.style.transform = (mx || my) ? ('translate(' + mx + 'px,' + my + 'px)') : '';
      if (mx || my) box.classList.add('img-freemoved');
      else box.classList.remove('img-freemoved');
    }
  }

  // ---- 压缩图片：长边 maxEdge、质量 quality；返回 { blob, w, h, origW, origH } ----
  function _compressImage(file, maxEdge, quality) {
    return new Promise(function(resolve, reject) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) {
        return reject(new Error('非图片文件'));
      }
      var url = null;
      try { url = URL.createObjectURL(file); } catch (e) {}
      if (!url) return reject(new Error('无法读取图片'));
      var img = new Image();
      img.onload = function() {
        try {
          var sw = img.naturalWidth || img.width || 0;
          var sh = img.naturalHeight || img.height || 0;
          if (!sw || !sh) throw new Error('图片尺寸无效');
          var scale = 1, m = Math.max(sw, sh);
          if (m > maxEdge) scale = maxEdge / m;
          var w = Math.max(1, Math.round(sw * scale));
          var h = Math.max(1, Math.round(sh * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          // PNG 保留透明与锐利（截图/插图）；其余转 JPEG 压缩
          var outType = (file.type === 'image/png') ? 'image/png' : 'image/jpeg';
          canvas.toBlob(function(blob) {
            if (url) URL.revokeObjectURL(url);
            if (!blob) return reject(new Error('图片压缩失败'));
            resolve({ blob: blob, w: w, h: h, origW: sw, origH: sh });
          }, outType, quality || 0.82);
        } catch (e) {
          if (url) URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function() { if (url) URL.revokeObjectURL(url); reject(new Error('图片解析失败')); };
      img.src = url;
    });
  }

  // ---- 导入图片到当前笔记（支持批量多选 / 粘贴 / 拖拽）----
  function _importImagesToNote(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function(f) {
      return f && f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) { alert('请选择图片文件（支持 JPG / PNG / GIF / WebP / BMP）'); return; }
    var done = 0, total = files.length;
    var snippets = [];   // Markdown 短引用
    var boxesHtml = [];  // 预览态所见即所得 HTML
    _imgImportTip(total, 0);
    files.forEach(function(file) {
      _compressImage(file, 1600, 0.82).then(function(cp) {
        var id = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        var alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[\[\]"\\\n]/g, '') || '图片';
        return _imgStorePut(id, cp.blob, { name: alt, mime: cp.blob.type || 'image/jpeg', w: cp.w, h: cp.h }).then(function() {
          // 2026-08-19 导入即实时镜像到附件空间（与其他组件一致）
          _imgMirrorToAttachments(id, cp.blob, alt);
          snippets.push('\n![' + alt + '](scimg://' + id + ' "' + alt + '")\n\n');
          boxesHtml.push('<p><span class="note-img-box" contenteditable="false" data-img-id="' + id + '">'
            + '<span class="note-img-loading"></span>'
            + '<span class="note-img-wrap">'
            + '<img src="' + _IMG_PH + '" data-src="scimg://' + id + '" class="note-img" alt="' + alt + '">'
            + _IMG_HANDLES_HTML
            + '</span></span></p>');
        });
      }).then(function() {
        done++;
        _imgImportTip(total, done);
        if (done >= total) _finishImagesInsert(snippets, boxesHtml);
      }).catch(function(err) {
        done++;
        console.warn('图片导入失败:', file && file.name, err);
        _imgImportTip(total, done);
        if (done >= total) _finishImagesInsert(snippets, boxesHtml);
      });
    });
  }

  // 轻量导入进度提示（不阻塞操作）
  function _imgImportTip(total, done) {
    try {
      var el = document.getElementById('imgImportTip');
      if (!el) {
        el = document.createElement('div');
        el.id = 'imgImportTip';
        el.setAttribute('style', 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;'
          + 'background:rgba(43,69,48,.92);color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;'
          + 'box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .3s;pointer-events:none;');
        document.body.appendChild(el);
      }
      el.style.opacity = '1';
      el.textContent = done >= total ? '✅ 已插入 ' + total + ' 张图片' : '🖼 正在处理图片 ' + done + '/' + total + ' …';
      if (done >= total) {
        setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 320); }, 900);
      }
    } catch (e) {}
  }

  // 把图片真正插入当前编辑面（CM 源码态 / 预览态 / 兜底）
  function _finishImagesInsert(snippets, boxesHtml) {
    if (!snippets.length) { alert('没有成功导入任何图片'); return; }
    var md = snippets.join('\n');
    var html = boxesHtml.join('\n');
    // 1) CodeMirror 源码态：直接插入 Markdown 短引用
    if (typeof mdSubMode !== 'undefined' && mdSubMode === 'edit' && typeof cmView !== 'undefined' && cmView && typeof cmView.dispatch === 'function') {
      try {
        var cur = cmView.state.selection.main.head;
        cmView.dispatch({ changes: { from: cur, insert: md }, selection: { anchor: cur + md.length } });
        cmView.focus();
        return;
      } catch (e) {}
    }
    // 2) 预览（contentEditable）态：所见即所得插入图片容器，随后序列化写回 mdContent
    var preview = _getCurrentEditRoot();
    if (preview) {
      try {
        preview.focus();
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) {
          var rr = document.createRange();
          rr.selectNodeContents(preview); rr.collapse(false);
          if (sel) { sel.removeAllRanges(); sel.addRange(rr); }
        }
        document.execCommand('insertHTML', false, html);
      } catch (e) {
        try {
          var r2 = document.createRange();
          r2.selectNodeContents(preview); r2.collapse(false);
          var d2 = document.createElement('div'); d2.innerHTML = html;
          r2.insertNode(d2);
        } catch (e2) {}
      }
      try { _resolvePreviewImages(preview); } catch (e) {}
      try { preview.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      return;
    }
    // 3) 兜底
    _insertMdOrHtml(md, html);
  }

  // ---- 点击图片 → 浮动操作条（尺寸 / 对齐 / 删除）----
  var _imgActionBar = null;
  var _imgActionBox = null;
  function _bindImageInteractions(container) {
    if (!container || container.__imgBound) return;
    container.__imgBound = true;
    container.addEventListener('click', function(e) {
      var box = e.target && e.target.closest ? e.target.closest('.note-img-box') : null;
      if (!box) { _hideImgActions(); _clearImgSelection(); return; }
      // 2026-08-19 点击图片框内空白区域（图片左右两侧）不选中图片：
      // 交给浏览器默认行为，让光标能定位到图片旁输入文本（图文混排）
      var t = e.target;
      var onImg = !!(t && (t.closest ? (t.closest('img.note-img') || t.closest('.note-img-wrap') || t.closest('.img-resize-handle')) : false));
      if (!onImg) { _hideImgActions(); _clearImgSelection(); return; }
      e.preventDefault();
      e.stopPropagation();
      // 2026-08-19 点击图片 = 选中图片：聚焦编辑区并建立选区，
      // 使 Backspace/Delete 删除、Ctrl+C/X/V 复制剪切粘贴可直接生效
      try {
        if (container.focus) container.focus({ preventScroll: true });
        var r = document.createRange();
        r.selectNode(box);
        var sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(r); }
      } catch (e2) {}
      _markImgSelection(box);
      _showImgActions(box, e);
    });
    // 2026-08-19 键盘快捷键：Backspace/Delete 删除选中图片，Ctrl+C/X/V 复制/剪切/粘贴
    container.addEventListener('keydown', function(e) { _onImgKeyDown(e); });
    container.addEventListener('cut', function(e) { _onImgCut(e); });
    container.addEventListener('copy', function(e) { _onImgCopy(e); });
    container.addEventListener('paste', function(e) { _onImgPaste(e); });
    // 2026-08-19 拖拽边界等比缩放（锁定原图比例）
    _bindImgResizeDrag(container);
    // 2026-08-19 拖拽图片本体移动位置（横向吸附左/中/右，与手柄缩放互不冲突）
    _bindImgMoveDrag(container);
  }

  // 拖拽图片四周手柄：按原图宽高比等比缩放，松手后以百分比持久化
  function _bindImgResizeDrag(container) {
    if (!container || container.__imgResizeBound) return;
    container.__imgResizeBound = true;
    container.addEventListener('mousedown', function(e) {
      var h = e.target && e.target.closest ? e.target.closest('.img-resize-handle') : null;
      if (!h) return;
      e.preventDefault();
      e.stopPropagation();
      var box = h.closest('.note-img-box');
      var img = box ? box.querySelector('img.note-img') : null;
      if (!box || !img) return;
      // 2026-08-19 尺寸统一作用于 wrap：img 始终 100% 填满 wrap + height auto →
      // 缩放过程中比例自动保持（不再单独设 img 的 width/height，避免与 max-width 冲突导致比例异常）
      var wrap = box.querySelector('.note-img-wrap') || img;
      var dir = h.getAttribute('data-dir') || 'se';
      // 原图宽高比（默认比例不可变化）
      var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
      if (!nw || !nh) { nw = img.width || 1; nh = img.height || 1; }
      var ratio = nw / nh;
      var rect = wrap.getBoundingClientRect();
      var startW = rect.width || 100;
      var startX = e.clientX, startY = e.clientY;
      // 2026-08-19 box 为 inline-block（宽度=内容），缩放上限与百分比改以父级段落宽度为基准
      var hostW = box.parentElement ? box.parentElement.clientWidth : (box.clientWidth || 600);
      var maxW = Math.max(40, hostW);
      var lastW = startW;
      function move(ev) {
        var dx = ev.clientX - startX, dy = ev.clientY - startY;
        var dw = 0, dh = 0;
        if (dir.indexOf('e') >= 0) dw += dx;
        if (dir.indexOf('w') >= 0) dw -= dx;
        if (dir.indexOf('s') >= 0) dh += dy;
        if (dir.indexOf('n') >= 0) dh -= dy;
        var d = (Math.abs(dw) >= Math.abs(dh)) ? dw : dh;
        var newW = Math.max(40, Math.min(maxW, startW + d));
        lastW = newW;
        wrap.style.width = Math.round(newW) + 'px';
        if (img && wrap !== img) { img.style.width = ''; img.style.height = ''; }
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        var id = box.getAttribute('data-img-id');
        if (id) {
          // 用拖拽最终宽度计算百分比（lastW，相对父级段落宽度），避免布局时序导致读回旧值
          var pct = Math.round(lastW / (hostW || 1) * 100);
          pct = Math.max(5, Math.min(100, pct));
          var u = _imgUiGet(id) || {};
          u.w = 'custom';
          u.pct = pct;
          _imgUiSet(id, u);
        }
        // 换算回百分比 + height auto，保证重渲染一致且始终锁定比例
        _applyImageBoxUi(box, id);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  function _showImgActions(box, ev) {
    _imgActionBox = box;
    if (!_imgActionBar) {
      _imgActionBar = document.createElement('div');
      _imgActionBar.id = 'noteImgActions';
      _imgActionBar.setAttribute('style',
        'position:fixed;z-index:99999;display:flex;gap:4px;align-items:center;padding:6px 8px;'
        + 'background:#fff;border:1px solid rgba(43,69,48,.25);border-radius:10px;'
        + 'box-shadow:0 10px 30px rgba(0,0,0,.22);font-size:12px;user-select:none;');
      _imgActionBar.innerHTML =
        '<span style="color:#6b5d45;font-weight:600;margin-right:4px;">尺寸</span>'
        + '<button type="button" data-w="auto">自适应</button>'
        + '<button type="button" data-w="25">25%</button>'
        + '<button type="button" data-w="50">50%</button>'
        + '<button type="button" data-w="75">75%</button>'
        + '<button type="button" data-w="100">100%</button>'
        + '<span style="width:1px;height:18px;background:#ddd;margin:0 4px;"></span>'
        + '<button type="button" data-align="left">左对齐</button>'
        + '<button type="button" data-align="center">居中</button>'
        + '<button type="button" data-align="right">右对齐</button>'
        + '<span style="width:1px;height:18px;background:#ddd;margin:0 4px;"></span>'
        + '<button type="button" class="del" data-act="delete">🗑 删除</button>';
      // 2026-08-19：点击操作条按钮不夺焦 → 避免预览 blur 触发重渲染把 box 换成新 DOM，
      // 否则 _imgActionBox 变成失效引用导致删除/尺寸/对齐按钮无效
      _imgActionBar.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
      });
      _imgActionBar.addEventListener('click', function(e) {
        var b = e.target;
        if (!b || b.tagName !== 'BUTTON') return;
        e.preventDefault(); e.stopPropagation();
        // 按 id 在当前 DOM 重新定位 box（兜底：blur 重渲染后旧引用失效）
        var box = _imgActionBox;
        if (box && !box.parentNode) {
          var pid = box.getAttribute('data-img-id');
          box = pid ? document.querySelector('.note-img-box[data-img-id="' + pid + '"]') : null;
        }
        if (!box) return;
        var id = box.getAttribute('data-img-id');
        if (b.getAttribute('data-act') === 'delete') {
          _removeImgBox(box);
        } else if (b.hasAttribute('data-w')) {
          var u1 = _imgUiGet(id) || {};
          u1.w = b.getAttribute('data-w');
          _imgUiSet(id, u1);
          _applyImageBoxUi(box, id);
        } else if (b.hasAttribute('data-align')) {
          var u2 = _imgUiGet(id) || {};
          u2.align = b.getAttribute('data-align');
          delete u2.moveX; delete u2.moveY;  // 2026-08-19 选择对齐时复位自由位移
          _imgUiSet(id, u2);
          _applyImageBoxUi(box, id);
        }
      });
      document.body.appendChild(_imgActionBar);
    }
    _imgActionBar.style.display = 'flex';
    var r = box.getBoundingClientRect();
    var bw = _imgActionBar.offsetWidth || 360;
    var left = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    var top = r.top - 48;
    if (top < 8) top = r.bottom + 10;
    _imgActionBar.style.left = left + 'px';
    _imgActionBar.style.top = top + 'px';
  }
  function _hideImgActions() {
    if (_imgActionBar) _imgActionBar.style.display = 'none';
    _imgActionBox = null;
  }
  function _removeImgBox(box) {
    _hideImgActions();
    _clearImgSelection();
    if (!box || !box.parentNode) return;
    var preview = box.closest('.md-preview[contenteditable="true"]');
    var parent = box.parentNode;
    parent.removeChild(box);
    // 若父元素变成空段落，一并清理
    if (parent && parent.tagName === 'P' && !parent.textContent.trim() && !parent.querySelector('img')) {
      parent.remove();
    }
    // 触发序列化 → mdContent 移除该图片引用（Blob 保留，避免其它页面/历史引用失效）
    if (preview) { try { preview.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} }
    // 2026-08-19 同步移除附件镜像（与其他组件删除行为一致；若其它笔记仍引用，重新渲染会再次镜像）
    var rid = box.getAttribute('data-img-id');
    if (rid) _imgUnmirrorFromAttachments(rid);
  }

  // 选中高亮标记：点击图片时标记，供 Backspace/Ctrl+C/X 识别当前操作对象
  function _markImgSelection(box) {
    try {
      var all = document.querySelectorAll('.note-img-box');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('img-selected');
      if (box) box.classList.add('img-selected');
    } catch (e) {}
  }
  function _clearImgSelection() {
    try {
      var all = document.querySelectorAll('.note-img-box');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('img-selected');
    } catch (e) {}
  }

  // 返回选区中"被选中/接触"的图片容器（去重）
  function _getSelectedImgBoxes() {
    var sel = window.getSelection();
    var boxes = [];
    if (sel && sel.rangeCount) {
      for (var ri = 0; ri < sel.rangeCount; ri++) {
        var r = sel.getRangeAt(ri);
        var c = r.commonAncestorContainer;
        var scopeEl = c && c.nodeType === 1 ? c : (c && c.parentElement);
        var scope = scopeEl ? (scopeEl.closest ? (scopeEl.closest('.md-preview') || scopeEl.closest('.note-img-box') || document) : document) : document;
        var list = scope.querySelectorAll ? scope.querySelectorAll('.note-img-box') : [];
        for (var j = 0; j < list.length; j++) {
          var box = list[j];
          if (r.intersectsNode ? r.intersectsNode(box) : scope.contains(box)) {
            if (boxes.indexOf(box) < 0) boxes.push(box);
          }
        }
      }
    }
    // 兜底：选区未命中时，采用点击选中标记的图片（img-selected）
    if (!boxes.length) {
      var marked = document.querySelectorAll('.note-img-box.img-selected');
      for (var k = 0; k < marked.length; k++) boxes.push(marked[k]);
    }
    return boxes;
  }

  // Backspace / Delete：删除选中的图片容器
  function _onImgKeyDown(e) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    var boxes = _getSelectedImgBoxes();
    if (!boxes.length) return;
    e.preventDefault();
    e.stopPropagation();
    for (var i = 0; i < boxes.length; i++) _removeImgBox(boxes[i]);
  }

  // Ctrl+X：复制（Markdown 引用 + HTML）并删除选中图片
  function _onImgCut(e) {
    var boxes = _getSelectedImgBoxes();
    if (!boxes.length) return;
    e.preventDefault();
    e.stopPropagation();
    _copyImgBoxesToClipboard(e, boxes);
    for (var i = 0; i < boxes.length; i++) _removeImgBox(boxes[i]);
  }

  // Ctrl+C：把选中的图片以 Markdown 引用复制（同时保留 HTML，便于内部粘贴还原）
  function _onImgCopy(e) {
    var boxes = _getSelectedImgBoxes();
    if (!boxes.length) return;
    e.preventDefault();
    e.stopPropagation();
    _copyImgBoxesToClipboard(e, boxes);
  }

  function _copyImgBoxesToClipboard(e, boxes) {
    var md = [], html = [];
    for (var i = 0; i < boxes.length; i++) {
      var img = boxes[i].querySelector('img.note-img');
      var alt = img ? (img.getAttribute('alt') || '图片') : '图片';
      var ref = img ? (img.getAttribute('data-src') || img.src || '') : '';
      md.push('![' + alt + '](' + ref + ')');
      html.push(boxes[i].outerHTML);
    }
    if (e.clipboardData) {
      try { e.clipboardData.setData('text/plain', md.join('\n')); } catch (er) {}
      try { e.clipboardData.setData('text/html', html.join('')); } catch (er) {}
    }
  }

  // Ctrl+V：解析剪贴板中的 scimg:// 引用（Markdown 或 HTML）并插入为图片容器
  function _onImgPaste(e) {
    var cd = e.clipboardData;
    if (!cd) return;
    var html = cd.getData('text/html') || '';
    var text = cd.getData('text/plain') || '';
    var src = html + '\n' + text;
    if (src.indexOf('scimg://') < 0) return;  // 普通内容走默认粘贴
    e.preventDefault();
    e.stopPropagation();
    var ids = [];
    var re = /scimg:\/\/([A-Za-z0-9_\-]+)/g, m;
    while ((m = re.exec(src)) !== null) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]); }
    if (!ids.length) return;
    var mdSnippet = [];
    for (var i = 0; i < ids.length; i++) mdSnippet.push('![' + '图片' + '](scimg://' + ids[i] + ')');
    var rendered = renderMarkdown(mdSnippet.join('\n\n'));
    if (rendered && rendered.indexOf('<') >= 0) {
      _insertMdOrHtml('', rendered);
      var preview = _getCurrentEditRoot();
      if (preview) {
        try { _resolvePreviewImages(preview); } catch (e2) {}
        try { preview.dispatchEvent(new Event('input', { bubbles: true })); } catch (e3) {}
      }
    }
  }

  // 拖拽图片本体 → 移动位置：横向跟随，松手按位置吸附 左/中/右 对齐（与手柄缩放互不冲突）
  function _bindImgMoveDrag(container) {
    if (!container || container.__imgMoveBound) return;
    container.__imgMoveBound = true;
    container.addEventListener('mousedown', function(e) {
      var img = e.target && e.target.closest ? e.target.closest('img.note-img') : null;
      if (!img) return;
      var box = img.closest('.note-img-box');
      if (!box || box.__imgMoving) return;
      e.preventDefault();
      e.stopPropagation();
      // 2026-08-19 自由拖拽（贴纸式）：上下左右都能移动，位移作用于 wrap 并持久化；
      // 拖拽前先读取已保存位移作为起点，支持多次连续移动
      var wrap = box.querySelector('.note-img-wrap') || img;
      var id = box.getAttribute('data-img-id');
      var ui0 = _imgUiGet(id) || {};
      var baseX = ui0.moveX || 0, baseY = ui0.moveY || 0;
      var startX = e.clientX, startY = e.clientY;
      var moved = false;
      box.__imgMoving = true;
      function move(ev) {
        var dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        wrap.style.transition = 'none';
        wrap.style.transform = 'translate(' + (baseX + dx) + 'px,' + (baseY + dy) + 'px)';
        if (wrap.style.cursor !== 'grabbing') wrap.style.cursor = 'grabbing';
      }
      function up(ev) {
        var finalDx = ev.clientX - startX, finalDy = ev.clientY - startY;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        box.__imgMoving = false;
        wrap.style.cursor = '';
        if (!moved) return;  // 未拖动视为点击 → 交给 click 显示操作条
        var mx = Math.round(baseX + finalDx), my = Math.round(baseY + finalDy);
        var u = _imgUiGet(id) || {};
        if (mx || my) {
          u.moveX = mx;
          u.moveY = my;
          box.classList.add('img-freemoved');  // 2026-08-19 移出原位：box 高度归零不占行，原位置可输入文字
        } else {
          delete u.moveX; delete u.moveY;  // 2026-08-19 拖回原位：恢复文档流占位
          box.classList.remove('img-freemoved');
        }
        delete u.align;  // 自由摆放后不再受水平对齐约束
        _imgUiSet(id, u);
        // 2026-08-19 只应用位移与对齐类，避免重置已保存的宽度类（custom 百分比）
        wrap.style.transform = 'translate(' + mx + 'px,' + my + 'px)';
        box.classList.remove('img-align-left', 'img-align-center', 'img-align-right');
        box.classList.add('img-align-' + (u.align || 'center'));
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // ---- 全局：粘贴图片 / 拖拽图片 ----
  var _imgGlobalBound = false;
  function _bindGlobalImageHandlers() {
    if (_imgGlobalBound) return;
    _imgGlobalBound = true;
    // 粘贴：剪贴板含图片且当前处于笔记编辑面
    document.addEventListener('paste', function(e) {
      var cd = e.clipboardData || window.clipboardData;
      if (!cd || !cd.files) return;
      var hasImg = false;
      for (var pi = 0; pi < cd.files.length; pi++) {
        if (cd.files[pi] && cd.files[pi].type && cd.files[pi].type.indexOf('image/') === 0) { hasImg = true; break; }
      }
      if (!hasImg) return;
      var root = _getCurrentEditRoot();
      var active = document.activeElement;
      var inEdit = active && active.closest && (active.closest('.md-preview[contenteditable="true"]') || active.closest('.note-block-content[contenteditable="true"]'));
      if (!root || (!inEdit && !(root.contains && root.contains(active)))) return;
      e.preventDefault();
      e.stopPropagation();
      _importImagesToNote(cd.files);
    }, true);
    // 拖拽：图片文件拖入页面（有笔记编辑面时）
    document.addEventListener('dragover', function(e) {
      if (!_getCurrentEditRoot()) return;
      var dt = e.dataTransfer;
      if (!dt || !dt.types) return;
      var hasFiles = false;
      for (var t = 0; t < dt.types.length; t++) {
        if (String(dt.types[t]).toLowerCase() === 'files') { hasFiles = true; break; }
      }
      if (!hasFiles) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        var dv = document.getElementById('imgDropVeil');
        if (!dv) {
          dv = document.createElement('div');
          dv.id = 'imgDropVeil';
          dv.setAttribute('style', 'position:fixed;inset:0;z-index:99998;pointer-events:none;'
            + 'background:rgba(58,90,64,.18);display:none;align-items:center;justify-content:center;'
            + 'border:3px dashed rgba(58,90,64,.6);color:#2b4530;font-size:18px;font-weight:600;');
          dv.textContent = '松开以插入图片';
          document.body.appendChild(dv);
        }
        dv.style.display = 'flex';
      } catch (e) {}
    });
    document.addEventListener('dragleave', function(e) {
      if (!e.relatedTarget) {
        var dv = document.getElementById('imgDropVeil');
        if (dv) dv.style.display = 'none';
      }
    });
    document.addEventListener('drop', function(e) {
      var dv = document.getElementById('imgDropVeil');
      if (dv) dv.style.display = 'none';
      if (!e.dataTransfer || !e.dataTransfer.files) return;
      if (!_getCurrentEditRoot()) return;
      var hasImg = false;
      for (var di = 0; di < e.dataTransfer.files.length; di++) {
        if (e.dataTransfer.files[di] && e.dataTransfer.files[di].type && e.dataTransfer.files[di].type.indexOf('image/') === 0) { hasImg = true; break; }
      }
      if (!hasImg) return;
      e.preventDefault();
      e.stopPropagation();
      _importImagesToNote(e.dataTransfer.files);
    });
    // 全局点击隐藏操作条
    document.addEventListener('click', function(e) {
      if (_imgActionBar && e.target && !e.target.closest('#noteImgActions') && !e.target.closest('.note-img-box')) {
        _hideImgActions();
      }
    });
  }

  // ---------- 流程图存储（localStorage 简单方案）----------
  function saveDiagram(diagramId, data) {
    try {
      localStorage.setItem('shuchongu_diagram_' + diagramId, JSON.stringify(data || { nodes: [], edges: [] }));
      // 2026-08-18：同步镜像到附件（与 HTML 组件一致），附件管理器可查看/复用这份图数据
      _ensureDiagramAttachment(diagramId, data || { nodes: [], edges: [] });
      return true;
    } catch (e) { return false; }
  }
  // 把流程图数据镜像到当前教材的附件（幂等：按 diagramId 覆盖同名文件，保存为 canvas-diagram JSON）
  function _ensureDiagramAttachment(diagramId, data) {
    try {
      if (!diagramId || data == null) return;
      if (typeof AttachmentManager === 'undefined' || !AttachmentManager.addSourceFile) return;
      var bookId = _resolveBookIdForHtml(); // 复用同一本书判定
      if (!bookId) return;
      var shortId = String(diagramId).slice(-6);
      var text = JSON.stringify(data || { nodes: [], edges: [] }, null, 2);
      AttachmentManager.addSourceFile(
        bookId,
        '流程图_' + shortId + '.json',
        text,
        'application/json',
        'diagram_' + diagramId
      );
    } catch (e) {}
  }
  function loadDiagram(diagramId) {
    try {
      var s = localStorage.getItem('shuchongu_diagram_' + diagramId);
      if (!s) return null;
      var d = JSON.parse(s);
      if (!d) return null;
      if (!Array.isArray(d.nodes)) d.nodes = [];
      if (!Array.isArray(d.edges)) d.edges = [];
      return d;
    } catch (e) { return null; }
  }
  function _deleteDiagram(diagramId) {
    try { localStorage.removeItem('shuchongu_diagram_' + diagramId); } catch (e) {}
    // 2026-08-18：同步删除附件镜像，避免孤儿文件残留
    try {
      if (diagramId && typeof AttachmentManager !== 'undefined' && AttachmentManager.removeSourceFile) {
        var bookId = _resolveBookIdForHtml();
        if (bookId) AttachmentManager.removeSourceFile(bookId, 'diagram_' + diagramId);
      }
    } catch (e) {}
  }
  function _generateDiagramId() {
    return 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }
  // 生成新的流程图引用（空数据已落盘），返回可插入 Markdown 的 @[diagram:ID]
  function createDiagramRef() {
    var id = _generateDiagramId();
    saveDiagram(id, { nodes: [], edges: [] });
    return '@[diagram:' + id + ']';
  }

  // ---------- HTML 块独立存储（localStorage + 附件镜像）----------
  // 将 HTML 源码从 mdContent 中剥离，用 @[html:ID] 占位符引用，
  // 避免 Markdown 解析/序列化 与 HTML 语法冲突导致反复切换模式时渲染失败
  // 2026-08-17：保存时同步把完整源码镜像到「附件」（AttachmentManager），
  // 用户可在附件管理器里查看/复用这份 .html 源码文件
  function saveHtml(htmlId, rawHtml) {
    try {
      localStorage.setItem('shuchongu_html_' + htmlId, String(rawHtml || ''));
      _ensureHtmlAttachment(htmlId, String(rawHtml || ''));
      return true;
    } catch (e) { return false; }
  }
  // 确定 HTML 块源码镜像到哪本书的附件（找不到则返回 null，跳过镜像）
  function _resolveBookIdForHtml() {
    try {
      if (typeof PDFReader !== 'undefined' && PDFReader.getBookId) {
        var bid = PDFReader.getBookId();
        if (bid) return bid;
      }
      if (typeof FileManager !== 'undefined' && FileManager._currentBook) {
        var b = FileManager._currentBook;
        if (b && (b.bookId || b.id)) return b.bookId || b.id;
      }
      var saved = localStorage.getItem('shuchongu_current_book');
      if (saved) return saved;
    } catch (e) {}
    return null;
  }
  // 把 HTML 源码写入附件（幂等：按 htmlId 覆盖同名文件）
  function _ensureHtmlAttachment(htmlId, rawHtml) {
    try {
      if (!htmlId || rawHtml == null) return;
      if (typeof AttachmentManager === 'undefined' || !AttachmentManager.addSourceFile) return;
      var bookId = _resolveBookIdForHtml();
      if (!bookId) return;
      var shortId = String(htmlId).slice(-6);
      AttachmentManager.addSourceFile(
        bookId,
        'HTML组件_' + shortId + '.html',
        rawHtml,
        'text/html',
        'html_' + htmlId
      );
    } catch (e) {}
  }
  function loadHtml(htmlId) {
    try {
      var s = localStorage.getItem('shuchongu_html_' + htmlId);
      return (s == null) ? null : String(s);
    } catch (e) { return null; }
  }
  function deleteHtml(htmlId) {
    try { localStorage.removeItem('shuchongu_html_' + htmlId); } catch (e) {}
    // 同步删除附件镜像，避免孤儿文件残留
    try {
      if (htmlId && typeof AttachmentManager !== 'undefined' && AttachmentManager.removeSourceFile) {
        var bookId = _resolveBookIdForHtml();
        if (bookId) AttachmentManager.removeSourceFile(bookId, 'html_' + htmlId);
      }
    } catch (e) {}
  }
  function _generateHtmlId() {
    return 'h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }
  // 生成新的 HTML 引用（内容已落盘），返回可插入 Markdown 的 @[html:ID]
  function createHtmlRef(rawHtml) {
    var id = _generateHtmlId();
    saveHtml(id, rawHtml || '');
    return '@[html:' + id + ']';
  }

  // ---------- 前置迁移：Markdown 源码中的 ```html``` 代码块 → @[html:ID] 引用 ----------
  // 每次 renderMarkdown 之前调用，确保旧笔记里的内联 HTML 代码块也能被统一转换为占位符模式，
  // 从而避免在 md ↔ preview 反复切换中产生语法冲突
  function _migrateHtmlBlocksToRefs(text) {
    if (!text) return '';
    var md = String(text);
    // 支持 ```html / ```HTML / ``` Html 等大小写变体
    var codeRe = /```\s*html\s*\n?([\s\S]*?)```/gi;
    md = md.replace(codeRe, function(m, body) {
      var raw = (body == null) ? '' : String(body);
      var trimmed = raw.trim();
      if (!trimmed) return m;
      var id = _generateHtmlId();
      saveHtml(id, raw);
      return '\n@[html:' + id + ']\n';
    });
    // 支持 <pre><code class="language-html">...</code></pre> 格式
    var preRe = /<pre>\s*<code[^>]*class="[^"]*language-html[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
    md = md.replace(preRe, function(m, escapedBody) {
      var raw = _decodeHtmlEntities(escapedBody || '');
      var trimmed = raw.trim();
      if (!trimmed) return m;
      var id = _generateHtmlId();
      saveHtml(id, raw);
      return '\n@[html:' + id + ']\n';
    });
    return md;
  }

  // ---------- 持久化迁移：把 mdContent 里的 HTML 源码块真正写回为 @[html:ID] 占位符 ----------
  // 2026-08-17：AI 输出 / 旧笔记可能把 ```html 源码块存在 mdContent 中（渲染时虽临时迁移，
  // 但源码编辑模式直接显示 mdContent 原文，源码会出现在编辑区，与 Markdown 渲染冲突）。
  // 此处做「写回式」迁移：一旦发现就生成占位符引用并持久化，保证编辑区永远只见占位符。
  function _persistMigrateHtmlBlocks(page) {
    try {
      if (!page || !page.mdContent) return;
      var md = String(page.mdContent);
      var hasSource = /```\s*html\s*\n/i.test(md) || /language-html/.test(md);
      if (!hasSource) return;
      var migrated = _migrateHtmlBlocksToRefs(md);
      if (migrated === md) return;
      page.mdContent = migrated;
      if (typeof _persistPage === 'function') { try { _persistPage(page); } catch (e) {} }
      if (currentNotebook) { try { DataLayer.put('notebooks', currentNotebook); } catch (e) {} }
    } catch (e) { console.warn('HTML 源码持久化迁移失败:', e); }
  }

  // ---------- HTML 块 iframe 自适应高度（postMessage 全局监听，一次注册）----------
  var _htmlBlockResizeReady = false;
  function _setupHtmlBlockResizeListener() {
    if (_htmlBlockResizeReady) return;
    _htmlBlockResizeReady = true;
    window.addEventListener('message', function(ev) {
      var d = ev.data;
      if (!d || d.__htmlBlock !== 1) return;
      var h = parseInt(d.h, 10);
      // 修复：允许较小高度，只在异常情况下设置最小值
      if (isNaN(h) || h <= 0) h = 30;
      if (h > 5000) h = 5000; // 防止异常高度
      var frames = document.querySelectorAll('iframe.html-iframe');
      for (var i = 0; i < frames.length; i++) {
        try {
          if (frames[i].contentWindow === ev.source) {
            // 2026-08-17：块正在拖拽调整形状时，iframe 高度由拖拽逻辑冻结；
            // 拖拽结束（移除 html-resizing）后恢复内容自适应
            var blk = frames[i].closest ? frames[i].closest('.html-block-container') : null;
            if (blk && blk.classList.contains('html-resizing')) return;
            // 修复：使用 max-height 和 height 同时限制
            frames[i].style.height = h + 'px';
            frames[i].style.minHeight = h + 'px';
            return;
          }
        } catch (e) {}
      }
    });
  }

  // ---------- 流程图共享 resize 监听（适配容器宽度变化）----------
  var _diagramEditors = [];
  var _diagramSharedResizeReady = false;
  function _setupDiagramSharedResize() {
    if (_diagramSharedResizeReady) return;
    _diagramSharedResizeReady = true;
    window.addEventListener('resize', function() {
      for (var i = 0; i < _diagramEditors.length; i++) {
        try { _diagramEditors[i].handleResize(); } catch (e) {}
      }
    });
  }

  // ---------- 初始化容器内所有流程图块 ----------
  // reset=true 时清空全局编辑器列表（主预览重渲染时调用，释放旧实例引用）
  function _initDiagramBlocks(container, reset) {
    if (!container) return;
    _setupDiagramSharedResize();
    if (reset) _diagramEditors = [];
    var blocks = container.querySelectorAll('.diagram-block');
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].querySelector('canvas.diagram-canvas')) continue;
      try { new DiagramEditor(blocks[i]); } catch (e) { console.warn('流程图初始化失败:', e); }
      // —— 关键修复：流程图初始化后，把名称行重新挪到 DOM 末尾 + 强制高 z-index
      //    因为 DiagramEditor 内部会 appendChild(toolbar/canvasWrap) 把 name row 压在下面，
      //    导致名称行虽然有 z-index 但仍被 canvas 鼠标事件拦截
      try {
        var blockEl = blocks[i];
        var nameRow = blockEl.querySelector('.block-name-row');
        if (nameRow) {
          if (nameRow.parentNode) nameRow.parentNode.appendChild(nameRow);
          nameRow.style.zIndex = 9999;
          nameRow.style.position = 'absolute';
          nameRow.style.left = '0';
          nameRow.style.bottom = '0';
          nameRow.style.pointerEvents = 'auto';
          (function(nr) {
            setTimeout(function() { if (nr && nr.parentNode) nr.parentNode.appendChild(nr); nr.style.zIndex = 9999; }, 0);
            setTimeout(function() { if (nr && nr.parentNode) nr.parentNode.appendChild(nr); nr.style.zIndex = 9999; }, 120);
          })(nameRow);
        }
      } catch (ee) {}
    }
  }

  // ---------- 附件编辑同步：笔记预览中同 id 流程图刷新 ----------
  // 附件空间保存流程图后，若当前预览包含同 diagramId 的块，重建该块（读取 localStorage 最新数据）
  function _refreshDiagramAfterAttachEdit(diagramId) {
    try {
      var preview = contentEl ? contentEl.querySelector('.md-preview[contenteditable="true"]') : null;
      if (!preview) return;
      var block = preview.querySelector('.diagram-block[data-diagram-id="' + diagramId + '"]');
      if (!block) return;
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          try {
            // 移除旧 canvas 与工具栏，重建 DiagramEditor（自动读取最新 localStorage 数据）
            var oldWrap = block.querySelector('.diagram-canvas-wrap');
            if (oldWrap && oldWrap.parentNode) oldWrap.parentNode.removeChild(oldWrap);
            var oldTb = block.querySelector(':scope > .diagram-toolbar');
            if (oldTb) oldTb.remove();
            // 若块是浮动定位，重建后恢复浮动样式
            var wasFloat = block.classList.contains('is-floating');
            var fl = block.style.left, ft = block.style.top;
            var editor = new DiagramEditor(block);
            if (wasFloat) {
              block.classList.add('is-floating');
              block.style.position = 'absolute';
              if (fl) block.style.left = fl;
              if (ft) block.style.top = ft;
            }
            // 2026-08-19 修复：附件面板覆盖时块可能处于隐藏状态，重建得到的尺寸为 0/不准。
            // 轮询等待块可见后重新测量渲染，确保返回笔记时正常显示。
            var tries = 0;
            var timer = setInterval(function() {
              tries++;
              try {
                var w = block.clientWidth || block.offsetWidth;
                if ((w && w > 30) || tries >= 10) {
                  clearInterval(timer);
                  if (editor) { editor.handleResize(); editor.render(); }
                }
              } catch (e) { clearInterval(timer); }
            }, 120);
          } catch (e) {}
        });
      });
    } catch (e) {}
  }

  // ---------- 流程图/HTML块：AI 改进 + 删除按钮绑定 ----------
  function _initBlockActionButtons(container, page) {
    if (!container) return;
    var btns = container.querySelectorAll('.block-btn');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i]._actionBound) continue;
      btns[i]._actionBound = true;
      btns[i].addEventListener('click', function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var btn = ev.currentTarget;
        var isDelete = btn.classList.contains('block-delete-btn');
        var isAI = btn.classList.contains('block-ai-btn');
        var htmlBlock = btn.closest ? btn.closest('.html-block-container') : null;
        var diagramBlock = btn.closest ? btn.closest('.diagram-block') : null;
        var targetBlock = htmlBlock || diagramBlock;
        if (!targetBlock) return;
        var currentPage = page || (typeof getCurrentPage === 'function' ? getCurrentPage() : null);

        if (isDelete) {
          // 删除块：从 DOM 和 mdContent 中移除，同时清理独立存储的 HTML/流程图 数据
          if (!confirm('确认删除该块？此操作无法撤销。')) return;
          // 清理 localStorage 中的独立数据（2026-08-16：占位符机制下 HTML/流程图 数据分离存储）
          try {
            if (htmlBlock) {
              var hid = htmlBlock.getAttribute ? htmlBlock.getAttribute('data-html-id') : null;
              if (hid) deleteHtml(hid);
              // 兼容旧形态：如果仍有 b64 data-html，不需要额外处理（已经迁移完成）
            } else if (diagramBlock) {
              var did2 = diagramBlock.getAttribute ? diagramBlock.getAttribute('data-diagram-id') : null;
              if (did2) _deleteDiagram(did2);
            }
          } catch (delErr) {}
          // 移除前后的空行 <p><br></p>
          var prev = targetBlock.previousElementSibling;
          var next = targetBlock.nextElementSibling;
          if (prev && prev.tagName === 'P' && prev.innerHTML.replace(/\s|<br\s*\/?>/gi, '') === '') prev.remove();
          targetBlock.remove();
          if (next && next.tagName === 'P' && next.innerHTML.replace(/\s|<br\s*\/?>/gi, '') === '') next.remove();
          // 如果当前是预览模式，写回 mdContent
          if (currentPage && currentPage.id) {
            if (typeof _flushPreviewBeforeSwitch === 'function') {
              try { _flushPreviewBeforeSwitch(currentPage); } catch(e) {}
            }
          }
          return;
        }

        if (isAI) {
          // AI 改进：弹窗收集需求，然后入队 AI 指令
          var blockType = htmlBlock ? 'HTML' : '流程图';
          var blockData = '';
          if (htmlBlock) {
            // 2026-08-16：优先从独立存储 loadHtml(id) 读取，再兜底旧 b64 data-html
            var hid2 = htmlBlock.getAttribute ? htmlBlock.getAttribute('data-html-id') : null;
            var stored = hid2 ? loadHtml(hid2) : null;
            if (stored != null) {
              blockData = stored;
            } else {
              var b64 = htmlBlock.getAttribute('data-html') || '';
              try { blockData = _decodeBase64(b64); } catch(e) { blockData = '[HTML内容读取失败]'; }
            }
          } else if (diagramBlock) {
            var did = diagramBlock.getAttribute('data-diagram-id') || '';
            var d = loadDiagram(did);
            blockData = d ? JSON.stringify(d, null, 2) : '（流程图为空或未找到）';
          }
          var aiPrompt = window.prompt('请输入对该' + blockType + '的改进需求：\n（例如：把流程图改成上下结构、添加节点XX→YY、调整颜色等）', '');
          if (aiPrompt === null || aiPrompt.trim() === '') return;
          aiPrompt = aiPrompt.trim();
          if (typeof CommandQueue === 'undefined' || !CommandQueue.enqueue) {
            alert('AI 指令队列未加载，无法创建任务。');
            return;
          }
          try {
            var delimiters = (CommandQueue && CommandQueue.getDelimiters) ? CommandQueue.getDelimiters() : { open: ['、、'], close: ['。。'] };
            // 2026-08-18 修复：delimiters.open/close 现在是数组，取第一个符号拼接指令文本
            var open = (Array.isArray(delimiters.open) && delimiters.open.length) ? delimiters.open[0] : '、、';
            var close = (Array.isArray(delimiters.close) && delimiters.close.length) ? delimiters.close[0] : '。。';
            var cmdText = open + '改进' + blockType + '：用户需求=\"' + aiPrompt + '\"；现有' + blockType + '如下：\n\n'
              + (blockType === 'HTML' ? '```html\n' : '```json\n')
              + blockData + '\n```\n\n请在当前笔记页的同一位置替换为改进后的' + blockType + close;
            var cmd = {
              id: 'cmd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
              raw: cmdText,
              type: 'ai',
              status: 'pending',
              createdAt: Date.now(),
              pageId: currentPage && currentPage.id ? currentPage.id : null,
              notebookId: currentPage && currentPage.notebookId ? currentPage.notebookId : null,
              meta: {
                blockType: blockType,
                userPrompt: aiPrompt,  // 修复：使用局部变量 aiPrompt，避免意外引用 window.prompt（原生函数无法克隆导致 IDB put 失败）
                blockData: blockData
              }
            };
            CommandQueue.enqueue(cmd);
            alert('✅ AI 改进任务已创建！将在后台执行，请稍候或查看「队列」面板。');
          } catch (e) {
            alert('创建 AI 改进任务失败：' + e.message);
          }
        }
      });
    }
  }

  // ---------- 工具：Base64 解码 ----------
  function _decodeBase64(s) {
    try {
      if (typeof atob === 'function') return decodeURIComponent(escape(atob(s || '')));
      return (new Function('return atob("' + (s || '').replace(/"/g, '\\"') + '")'))();
    } catch (e) { return ''; }
  }

  // ---------- 开始工具栏（Word 式格式） ----------
  // 判断当前编辑宿主：MD 预览 (.md-preview) 或 Block 内容 (.note-block-content)
  function _getCurrentEditRoot() {
    try {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      var node = sel.anchorNode;
      while (node && node.nodeType === 1 && node.nodeName.toLowerCase() !== 'body') {
        var el = node.nodeType === 1 ? node : node.parentElement;
        if (!el) break;
        if (el.classList && (el.classList.contains('md-preview') || el.classList.contains('note-block-content'))) return el;
        node = el.parentNode;
      }
    } catch (e) {}
    var mdp = document.querySelector('.md-preview[contenteditable="true"]');
    if (mdp) return mdp;
    return document.querySelector('.note-block-content[contenteditable="true"]');
  }

  // P2-15：判断当前"正在编辑"的是预览 contentEditable 还是 CodeMirror 还是 textarea
  function _getCurrentEditorInfo() {
    // 1. 优先：如果 window.__cm 已经 attach，且聚焦状态/光标存在 → CodeMirror
    try {
      var cm = (typeof window !== 'undefined' && window.__cm) ? window.__cm : null;
      if (cm && typeof cm.getCursor === 'function') {
        // 只要 mdModeActive=true 且 cm 存在，我们就认为用户当前在源码模式
        if (typeof mdModeActive !== 'undefined' && mdModeActive) {
          return { type: 'cm', cm: cm };
        }
      }
    } catch (e) {}
    // 2. contentEditable（预览模式）
    var ed = _getCurrentEditRoot();
    if (ed) return { type: 'html', el: ed };
    // 3. 兜底：找 textarea（md 编辑器内部的 textarea，例如 CodeMirror 不启用时）
    var area = document.getElementById('mdEditorArea');
    var txt = area ? area.querySelector('textarea') : null;
    if (txt) return { type: 'txt', el: txt };
    return null;
  }

  // 源码模式下：用 Markdown 语法或 inline HTML span 包裹选区
  function _cmdToMarkdownWrapper(cmd, value) {
    switch (cmd) {
      case 'bold':          return { before: '**', after: '**' };
      case 'italic':        return { before: '*',  after: '*'  };
      case 'underline':     return { before: '<u>', after: '</u>' };
      case 'strikeThrough': return { before: '~~', after: '~~' };
      case 'superscript':   return { before: '<sup>', after: '</sup>' };
      case 'subscript':     return { before: '<sub>', after: '</sub>' };
      case 'insertUnorderedList': return { linePrefix: '-  ' };
      case 'insertOrderedList':   return { linePrefix: '1. ' };
      case 'removeFormat':  return { strip: true };
      case 'fontName': {
        var v = (value || '').replace(/"/g, '&quot;');
        return { before: '<span style="font-family:' + v + ';">', after: '</span>' };
      }
      case 'fontSize': {
        // value 传的是 1-7（上面 _bindHomeToolbar 映射到 size），再映射回 px
        var map = { '1':'12px','2':'14px','3':'16px','4':'20px','5':'26px','6':'32px','7':'40px' };
        var px = map[value] || '16px';
        return { before: '<span style="font-size:' + px + ';">', after: '</span>' };
      }
      case 'foreColor': {
        return { before: '<span style="color:' + (value||'#333') + ';">', after: '</span>' };
      }
      case 'hiliteColor': {
        return { before: '<mark style="background:' + (value||'#fff9a8') + ';">', after: '</mark>' };
      }
    }
    return null;
  }
  function _applyCmCmd(cmd, value) {
    var info = _getCurrentEditorInfo();
    if (!info || info.type !== 'cm') return false;
    var cm = info.cm;
    var w = _cmdToMarkdownWrapper(cmd, value);
    if (!w) return false;
    if (w.linePrefix) {
      var from = cm.getCursor('from');
      var to   = cm.getCursor('to');
      var lines = [];
      for (var ln = from.line; ln <= to.line; ln++) lines.push(ln);
      cm.operation(function() {
        for (var i = lines.length - 1; i >= 0; i--) {
          var L = lines[i];
          var original = cm.getLine(L);
          cm.replaceRange(w.linePrefix + original, { line: L, ch: 0 });
        }
      });
      return true;
    }
    if (w.strip) {
      cm.replaceSelection(cm.getSelection()); // 去掉格式最简单的方法：只保留纯文本
      return true;
    }
    var sel = cm.getSelection() || '';
    if (!sel) {
      // 无选区：直接插入 before + 占位空格 + after，把光标放到中间
      cm.replaceSelection(w.before + ' ' + w.after, 'around');
      return true;
    }
    cm.replaceSelection(w.before + sel + w.after);
    return true;
  }
  function _applyTxtCmd(cmd, value, el) {
    var w = _cmdToMarkdownWrapper(cmd, value);
    if (!w) return false;
    var st = el.selectionStart || 0, en = el.selectionEnd || el.value.length;
    var v = el.value;
    var sel = v.substring(st, en);
    if (w.linePrefix) {
      var before = v.substring(0, st);
      var target = v.substring(st, en);
      var after = v.substring(en);
      target = target.split(/\r?\n/).map(function(line){ return w.linePrefix + line; }).join('\n');
      el.value = before + target + after;
      el.selectionStart = st; el.selectionEnd = st + target.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (w.strip) { sel = sel; } // noop
    var insert = (w.before || '') + sel + (w.after || '');
    el.value = v.substring(0, st) + insert + v.substring(en);
    el.selectionStart = st + (w.before ? w.before.length : 0);
    el.selectionEnd   = st + insert.length - (w.after ? w.after.length : 0);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // 跨浏览器 document.execCommand（兼容 contentEditable + 源码 CM + 源码 TXT）
  function _execFormat(cmd, value) {
    try {
      // 先判断：如果当前是 CodeMirror/textarea，走 Markdown/inline-HTML 包装路径
      var info = _getCurrentEditorInfo();
      if (info && info.type === 'cm') {
        var done = _applyCmCmd(cmd, value);
        if (done) return;
      }
      if (info && info.type === 'txt') {
        var done2 = _applyTxtCmd(cmd, value, info.el);
        if (done2) return;
      }
      // contentEditable 预览模式：走原生 execCommand
      var ed = _getCurrentEditRoot();
      if (ed) ed.focus();
      document.execCommand(cmd, false, value || null);
      var ev = new Event('input', { bubbles: true, cancelable: true });
      if (ed) ed.dispatchEvent(ev);
    } catch (e) { console.warn('格式命令失败:', cmd, value, e); }
  }

  // 插入 Markdown 片段（如果是 MD 模式，优先插入到 mdContent）
  function _insertMdOrHtml(mdSnippet, htmlIfEmpty) {
    var info = _getCurrentEditorInfo();
    // --- 源码模式：CodeMirror 优先 ---
    if (info && (typeof mdModeActive === 'undefined' || mdModeActive)) {
      if (info.type === 'cm') {
        try {
          var cm = info.cm;
          cm.replaceSelection(mdSnippet, 'end');
          // 触发保存 & 预览同步
          var area = document.getElementById('mdEditorArea');
          var txt = area ? area.querySelector('textarea') : null;
          if (txt) { txt.value = cm.getValue(); txt.dispatchEvent(new Event('input', { bubbles: true })); }
          return;
        } catch (e) {}
      }
      if (info.type === 'txt') {
        var el = info.el;
        var st = el.selectionStart || 0, en = el.selectionEnd || el.value.length;
        var v = el.value;
        el.value = v.substring(0, st) + mdSnippet + v.substring(en);
        el.selectionStart = el.selectionEnd = st + mdSnippet.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    if (mdModeActive) {
      var page = getCurrentPage();
      if (page) {
        var area = document.getElementById('mdEditorArea');
        var txt = area ? area.querySelector('textarea') : null;
        if (txt && document.activeElement === txt) {
          var st = txt.selectionStart || 0, en = txt.selectionEnd || txt.value.length;
          var v = txt.value;
          txt.value = v.substring(0, st) + mdSnippet + v.substring(en);
          txt.selectionStart = txt.selectionEnd = st + mdSnippet.length;
          txt.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
    }
    // Block 预览模式：插入 HTML（如果有），或插入纯文本
    // 2026-08-19 修复：点击工具栏按钮会令编辑区失焦/选区丢失 → execCommand 静默失败
    // （图片/表格等插入无效果）。插入前先聚焦并恢复选区。
    var edRoot = _getCurrentEditRoot();
    if (edRoot) {
      try {
        edRoot.focus();
        var _sel = window.getSelection();
        if (_sel && (!_sel.rangeCount || !edRoot.contains(_sel.anchorNode))) {
          var _r = document.createRange();
          _r.selectNodeContents(edRoot); _r.collapse(false);
          _sel.removeAllRanges(); _sel.addRange(_r);
        }
        if (htmlIfEmpty) document.execCommand('insertHTML', false, htmlIfEmpty);
        else document.execCommand('insertText', false, mdSnippet);
        edRoot.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      } catch (e2) {}
    }
    try {
      if (htmlIfEmpty) document.execCommand('insertHTML', false, htmlIfEmpty);
      else document.execCommand('insertText', false, mdSnippet);
      var ed = _getCurrentEditRoot();
      if (ed) ed.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      var ed2 = _getCurrentEditRoot();
      if (ed2) {
        var sel = window.getSelection();
        if (sel && sel.rangeCount) {
          var r = sel.getRangeAt(0);
          r.deleteContents();
          r.insertNode(document.createTextNode(mdSnippet));
          ed2.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
  }

  function _toggleHomeToolbar() {
    var t = document.getElementById('homeToolbar');
    var b = document.getElementById('btnToggleHomeToolbar');
    if (!t) return;
    var open = t.style.display !== 'none';
    t.style.display = open ? 'none' : 'flex';
    if (b) b.style.background = !open ? 'rgba(43,69,48,.22)' : '';
  }

  function _bindHomeToolbar() {
    var toggle = document.getElementById('btnToggleHomeToolbar');
    if (toggle) toggle.addEventListener('click', _toggleHomeToolbar);

    // 字体
    var ff = document.getElementById('htFontFamily');
    if (ff) ff.addEventListener('change', function() {
      if (this.value) _execFormat('fontName', this.value.replace(/['"]/g, ''));
      this.selectedIndex = 0;
    });
    var fs = document.getElementById('htFontSize');
    if (fs) fs.addEventListener('change', function() {
      if (this.value) {
        // 将 px 映射到 execCommand fontSize 1-7
        var px = parseInt(this.value, 10);
        var size = 3;
        if (px <= 12) size = 1;
        else if (px <= 14) size = 2;
        else if (px <= 18) size = 3;
        else if (px <= 22) size = 4;
        else if (px <= 28) size = 5;
        else if (px <= 36) size = 6;
        else size = 7;
        _execFormat('fontSize', size.toString());
      }
      this.selectedIndex = 0;
    });
    var fc = document.getElementById('htFontColor');
    if (fc) fc.addEventListener('input', function() { _execFormat('foreColor', this.value); });
    var bc = document.getElementById('htBgColor');
    if (bc) bc.addEventListener('input', function() { _execFormat('hiliteColor', this.value); });

    // 样式按钮
    var mapBtn = {
      'ht-bold': function() { _execFormat('bold'); },
      'ht-italic': function() { _execFormat('italic'); },
      'ht-underline': function() { _execFormat('underline'); },
      'ht-strike': function() { _execFormat('strikeThrough'); },
      'ht-sup': function() { _execFormat('superscript'); },
      'ht-sub': function() { _execFormat('subscript'); },
      'ht-ul': function() { _execFormat('insertUnorderedList'); },
      'ht-ol': function() { _execFormat('insertOrderedList'); },
      'ht-clear': function() { _execFormat('removeFormat'); }
    };
    for (var cls in mapBtn) {
      (function(c, fn) {
        var b = document.querySelector('.ht-btn.' + c);
        if (b) b.addEventListener('click', function(e) { e.preventDefault(); fn(); });
      })(cls, mapBtn[cls]);
    }

    // 插入：表格
    var tBtn = document.querySelector('.ht-btn.ht-table');
    if (tBtn) tBtn.addEventListener('click', function() {
      var inp = window.prompt('请输入表格规格（列 x 行），例如 3x4：', '3x3');
      if (!inp) return;
      var m = String(inp).match(/(\d+)\s*[xX×]\s*(\d+)/);
      if (!m) { alert('格式错误，请使用 「列数x行数」 例如 3x4'); return; }
      var cols = parseInt(m[1], 10), rows = parseInt(m[2], 10);
      if (!cols || !rows || cols > 20 || rows > 50) { alert('尺寸过大或无效'); return; }
      var md = '\n|' + Array(cols + 1).join(' 列  |') + '\n|' + Array(cols + 1).join(' --- |') + '\n';
      for (var r = 0; r < rows; r++) md += '|' + Array(cols + 1).join('     |') + '\n';
      md += '\n';
      var html = '<table style="border-collapse:collapse;margin:6px 0;width:auto;min-width:60%;">'
        + '<thead><tr>'
        + Array(cols + 1).join('<th style="border:1px solid #bbb;padding:4px 8px;background:#e8f5ea;">列</th>')
        + '</tr></thead><tbody>';
      for (var r2 = 0; r2 < rows; r2++) {
        html += '<tr>' + Array(cols + 1).join('<td style="border:1px solid #bbb;padding:4px 8px;min-width:60px;">&nbsp;</td>') + '</tr>';
      }
      html += '</tbody></table>';
      _insertMdOrHtml(md, html);
    });

    // 插入：图表（AI 指令入队）
    var cBtn = document.querySelector('.ht-btn.ht-chart');
    if (cBtn) cBtn.addEventListener('click', function() {
      var req = window.prompt('请输入要生成的图表描述（例如：「展示2020-2025年中国GDP增长趋势的折线图」）：', '');
      if (!req || !req.trim()) return;
      if (typeof CommandQueue === 'undefined' || !CommandQueue.enqueue) { alert('AI 指令队列未加载'); return; }
      try {
        var delim = (CommandQueue.getDelimiters && CommandQueue.getDelimiters()) || { open: ['、、'], close: ['。。'] };
        // 2026-08-18 修复：delim.open/close 现在是数组，需取第一个符号拼接指令文本（避免数组 toString 产生乱码）
        var openMark = (Array.isArray(delim.open) && delim.open.length) ? delim.open[0] : '、、';
        var closeMark = (Array.isArray(delim.close) && delim.close.length) ? delim.close[0] : '。。';
        var cmdText = openMark + '生成图表：' + req.trim() + '。请插入 HTML/ECharts 代码到当前笔记页的光标位置。' + closeMark;
        var page = getCurrentPage();
        CommandQueue.enqueue({
          id: 'cmd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
          raw: cmdText, type: 'ai', status: 'pending', createdAt: Date.now(),
          pageId: page && page.id ? page.id : null,
          notebookId: page && page.notebookId ? page.notebookId : null
        });
        alert('✅ 图表生成任务已创建！请稍候或查看「队列」。');
      } catch (e) { alert('任务创建失败：' + e.message); }
    });

    // 插入：图片（2026-08-19 完善：支持多选批量、压缩、IndexedDB 独立存储、
    // 粘贴/拖拽导入；插入后点击图片可调大小/对齐/删除）
    var iBtn = document.querySelector('.ht-btn.ht-image');
    var iFile = document.getElementById('htImageFile');
    if (iFile) {
      iFile.multiple = true;
      iFile.setAttribute('accept', 'image/*');
    }
    if (iBtn) {
      iBtn.setAttribute('title', '插入图片（可多选；也支持 Ctrl+V 粘贴 / 拖拽图片）');
      iBtn.addEventListener('click', function() {
        if (iFile) { iFile.value = ''; iFile.click(); }
      });
    }
    if (iFile) iFile.addEventListener('change', function() {
      var files = this.files;
      this.value = '';
      if (files && files.length) _importImagesToNote(files);
    });

    // 插入：链接
    var lBtn = document.querySelector('.ht-btn.ht-link');
    if (lBtn) lBtn.addEventListener('click', function() {
      var url = window.prompt('链接 URL：', 'https://');
      if (url === null) return;
      var title = window.prompt('链接文字：', url);
      if (title === null || title.trim() === '') title = url;
      var md = '[' + title.trim() + '](' + url.trim() + ')';
      var html = '<a href="' + url.trim() + '" target="_blank" style="color:#3a5a40;text-decoration:underline;">' + title.trim() + '</a>';
      _insertMdOrHtml(md, html);
    });

    // 快捷键：Ctrl+B/I/U、Ctrl++/= 上标、Ctrl+, 下标
    document.addEventListener('keydown', function(e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey) return;
      var ed = _getCurrentEditRoot();
      if (!ed) return;
      var k = String(e.key || '').toLowerCase();
      if (k === 'b') { e.preventDefault(); _execFormat('bold'); }
      else if (k === 'i') { e.preventDefault(); _execFormat('italic'); }
      else if (k === 'u') { e.preventDefault(); _execFormat('underline'); }
      else if (k === '=' || k === '+') { e.preventDefault(); _execFormat('superscript'); }
      else if (k === ',') { e.preventDefault(); _execFormat('subscript'); }
    }, true);
  }

  // ---------- 流程图 / HTML 块：拖拽位置 + 调整大小（仅预览模式） ----------
  // 2026-08-16 P1-10 重写：
  //   - key 优先使用 page.id + 外层 block.id（稳定不变），彻底避免 AI 改进后 hash 变化 → 找不到原 w/h/x/y
  //   - UI 应用用 rAF 双延迟，保证容器 layout 稳定后再写 left/top，避免"向右错位"
  //   - mousemove 节流（每 150ms）保存状态，避免中途丢失
  //   value = { x, y, w, h, floating, viewScale, name, updatedAt }
  function _blockUiKey(page, blockEl) {
    var pageId = (page && page.id) ? page.id : 'nopage';
    // 1) 外层 note-block 的稳定 block.id（最高优先级：AI 改进替换内容时不变）
    var outer = (blockEl.closest && blockEl.closest('[data-block-id]')) ? blockEl.closest('[data-block-id]') : null;
    var blockId = outer ? outer.getAttribute('data-block-id') : null;
    if (blockId) return 'shuchongu_blockui_' + pageId + '__b:' + blockId;
    // 2) fallback：diagram-id
    var did = blockEl.getAttribute('data-diagram-id');
    if (did) return 'shuchongu_blockui_' + pageId + '_diagram:' + did;
    // 3) fallback：html-id（来自 iframe 容器，比内容 hash 更稳定）
    var hid = blockEl.getAttribute('data-html-id');
    if (hid) return 'shuchongu_blockui_' + pageId + '_htmlref:' + hid;
    // 4) 最老格式 fallback：内容 hash
    var h = blockEl.getAttribute('data-html') || '';
    var hash = 0;
    for (var i = 0; i < h.length; i++) hash = ((hash << 5) - hash + h.charCodeAt(i)) | 0;
    return 'shuchongu_blockui_' + pageId + '_htmlhash:' + hash;
  }
  function _loadBlockUi(key) {
    try {
      var s = localStorage.getItem(key);
      if (!s) return null;
      var d = JSON.parse(s);
      return d && typeof d === 'object' ? d : null;
    } catch (e) { return null; }
  }
  function _saveBlockUi(key, ui) {
    try {
      if (ui && typeof ui === 'object') ui.updatedAt = Date.now();
      localStorage.setItem(key, JSON.stringify(ui));
      return true;
    } catch (e) { return false; }
  }

  function _applyBlockUi(blockEl, ui) {
    if (!ui) return;
    var style = blockEl.style;
    // 第一步：先加 floating class（并设 position:absolute），让块脱离文档流 → 后续 left/top 基准稳定
    // 2026-08-18 修复：缺少数字型 x/y 坐标的"浮动"不生效（保持流式）——
    // 旧版本/异常数据可能在无坐标时把块定位到 0,0，导致多个块叠在左上角。
    if (ui.floating && typeof ui.x === 'number' && typeof ui.y === 'number') {
      blockEl.classList.add('is-floating');
      style.position = 'absolute';
      style.left = ui.x + 'px';
      style.top = ui.y + 'px';
    } else if (ui.floating) {
      // 数据不完整：忽略浮动，按源码顺序流式排布（保证"刚生成/恢复"不叠放）
      blockEl.classList.remove('is-floating');
      style.position = 'relative';
    }
    // 第二步：宽度（w：展示框宽，viewScale：内容等比缩放 — P1-11 预留字段）
    var iframe = blockEl.querySelector('.html-iframe');
    var canvas = blockEl.querySelector('.diagram-canvas');
    if (typeof ui.w === 'number' && ui.w > 50) {
      style.width = ui.w + 'px';
      if (iframe) iframe.style.width = '100%';
      if (canvas) canvas.style.width = ui.w + 'px';
    }
    if (typeof ui.h === 'number' && ui.h > 40) {
      if (iframe) iframe.style.height = ui.h + 'px';
      else if (canvas) {
        // 2026-08-19 修复：流程图块高度恢复为「块总高」（含工具栏），
        // canvas 实际高度由 handleResize 按「块高 - 工具栏高」填满，避免高度错乱
        style.height = ui.h + 'px';
        try {
          var eds2 = _diagramEditors || [];
          for (var ie2 = 0; ie2 < eds2.length; ie2++) {
            if (eds2[ie2].blockEl === blockEl) { eds2[ie2].handleResize(); break; }
          }
        } catch (e11) {}
      }
      else style.height = ui.h + 'px';
    }
    // 第三步：等比缩放内容（P1-11 预留 — viewScale 默认 1；HTML/流程图都适用）
    if (typeof ui.viewScale === 'number' && ui.viewScale > 0.1 && ui.viewScale < 10) {
      if (iframe) {
        iframe.style.transformOrigin = 'top left';
        iframe.style.transform = 'scale(' + ui.viewScale + ')';
      } else if (canvas) {
        // 流程图 viewScale 通过 DiagramEditor 的视图缩放完成，不在 style 上直接 scale
        try {
          var eds = _diagramEditors || [];
          for (var ie = 0; ie < eds.length; ie++) {
            if (eds[ie].blockEl === blockEl && eds[ie].zoomTo) {
              eds[ie].zoomTo(ui.viewScale);
              break;
            }
          }
        } catch (e10) {}
      }
    }
    // rAF 延迟：通知 DiagramEditor 重新 handleResize（避免字体/尺寸测量时容器还没稳定）
    if (canvas) {
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          try {
            var editors3 = _diagramEditors || [];
            for (var k = 0; k < editors3.length; k++) {
              if (editors3[k].blockEl === blockEl) { editors3[k].handleResize(); editors3[k].render && editors3[k].render(); break; }
            }
          } catch (e2) {}
        });
      });
    }
  }

  // 通用节流器：150ms 内只触发最后一次（避免 localStorage 写入抖动）
  function _throttle(fn, wait) {
    var last = 0, timer = null;
    return function() {
      var now = Date.now();
      var args = arguments, self = this;
      if (now - last >= wait) {
        last = now;
        fn.apply(self, args);
      } else {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function() { last = Date.now(); fn.apply(self, args); }, wait - (now - last));
      }
    };
  }

  function _initBlockResizeAndDrag(container, page) {
    if (!container) return;
    var blocks = container.querySelectorAll('.html-block-container, .diagram-block');
    for (var i = 0; i < blocks.length; i++) _bindOneBlock(blocks[i], page);
  }
  function _bindOneBlock(blockEl, page) {
    if (blockEl._rdBound) return;
    blockEl._rdBound = true;
    var kind = blockEl.classList.contains('html-block-container') ? 'html'
      : blockEl.classList.contains('diagram-block') ? 'diagram' : 'block';
    var key = _blockUiKey(page, blockEl);
    var existing = _loadBlockUi(key);
    if (existing) {
      // 用双 rAF 延迟到 layout 稳定再应用，避免"向右错位"
      var self = this;
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { _applyBlockUi(blockEl, existing); });
      });
    }

    // P1-9 注入左下角名称行（只加一次）；防 diagram-canvas 覆盖
    try {
      var uiNow = _loadBlockUi(key) || {};
      var row = blockEl.querySelector('.block-name-row');
      if (!row) {
        row = _blockNameRowEl(kind,
          kind === 'html'    ? blockEl.getAttribute('data-html-id')
          : kind === 'diagram' ? blockEl.getAttribute('data-diagram-id')
          : null, uiNow);
        blockEl.appendChild(row);
      }
      // 确保名称行在最顶层（避免被流程图 canvas 盖住）
      row.style.zIndex = 10;
      if (kind === 'diagram') {
        // diagram-canvas 会在后续被创建和追加，延迟一下把名称行再次 appendChild 到末尾
        setTimeout(function() { if (row && row.parentNode) row.parentNode.appendChild(row); row.style.zIndex = 10; }, 80);
        setTimeout(function() { if (row && row.parentNode) row.parentNode.appendChild(row); row.style.zIndex = 10; }, 400);
      }
    } catch (e8) {}

    var dragHandle = blockEl.querySelector('.block-drag-handle');
    var actionBar = blockEl.querySelector('.block-action-bar');
    var iframe = blockEl.querySelector('.html-iframe');
    var canvas = blockEl.querySelector('.diagram-canvas');

    // ---- 模式切换：拖动模式 / 调整形状模式 ----
    var modeBtns = blockEl.querySelectorAll('.block-mode-toggle .mode-btn');
    var modeState = blockEl.getAttribute('data-interact-mode') || 'drag';
    function setMode(mode) {
      modeState = mode;
      blockEl.setAttribute('data-interact-mode', mode);
      for (var mi = 0; mi < modeBtns.length; mi++) {
        var b = modeBtns[mi];
        b.classList.toggle('active', b.classList.contains('mode-' + mode));
      }
      // 2026-08-19 改良：调整形状模式 → 显示拖拽手柄 + canvas 内缩让出边缘热区
      blockEl.classList.toggle('block-resize-mode', mode === 'resize');
      if (typeof updateHandles === 'function') updateHandles();
      if (kind === 'diagram') {
        try {
          var eds = _diagramEditors || [];
          for (var ei = 0; ei < eds.length; ei++) {
            if (eds[ei].blockEl === blockEl) { eds[ei].handleResize(); }
          }
        } catch (e9) {}
      }
      var u = _loadBlockUi(key) || {};
      u.interactMode = mode;
      _saveBlockUi(key, u);
    }
    for (var mi2 = 0; mi2 < modeBtns.length; mi2++) {
      (function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var isDrag = btn.classList.contains('mode-drag');
          setMode(isDrag ? 'drag' : 'resize');
        });
      })(modeBtns[mi2]);
    }
    // 从已保存的 UI 恢复模式
    try {
      var savedUi = _loadBlockUi(key);
      if (savedUi && savedUi.interactMode) setMode(savedUi.interactMode);
    } catch(e) {}

    // ---- 调整形状（改良 2026-08-19）：可视化拖拽手柄 + 扩大边缘热区 ----
    // 此前仅靠块边缘 16px 热区触发，而 canvas 几乎铺满整个块 → 边缘几乎无法命中。
    // 现在：resize 模式下块四周显示 8 个拖拽手柄（四角 + 四边），点击即可调整形状；
    // 同时边缘热区扩大到 24px，且 canvasWrap 内缩让出边缘，直接拖边缘也可触发。
    var EDGE = 24;
    var iframe2 = blockEl.querySelector('.html-iframe');
    var canvas2 = blockEl.querySelector('.diagram-canvas');
    blockEl.style.position = blockEl.style.position || 'relative';

    // 可视化拖拽手柄（仅流程图块；drag 模式隐藏，resize 模式显示）
    var resizeHandles = [];
    if (kind === 'diagram') {
      var dirs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      for (var hi = 0; hi < dirs.length; hi++) {
        (function(dir) {
          var h = document.createElement('div');
          h.className = 'block-resize-handle brh-' + dir;
          h.setAttribute('data-dir', dir);
          h.setAttribute('title', '拖拽调整形状');
          h.style.display = 'none';
          blockEl.appendChild(h);
          h.addEventListener('mousedown', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (modeState !== 'resize') return;
            beginResize(dir, ev);
          });
          resizeHandles.push(h);
        })(dirs[hi]);
      }
    }
    function updateHandles() {
      var list = resizeHandles || [];
      var show = (modeState === 'resize') && (kind === 'diagram');
      for (var ui = 0; ui < list.length; ui++) {
        list[ui].style.display = show ? 'block' : 'none';
      }
    }
    // 边缘命中检测：返回 n/w/e/s 组合（如 nw、se、e…）
    function detectResizeDir(ev) {
      var rect = blockEl.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var y = ev.clientY - rect.top;
      var w = rect.width, h = rect.height;
      var dir = '';
      if (x < EDGE) dir += 'w';
      else if (x > w - EDGE) dir += 'e';
      if (y < EDGE) dir += 'n';
      else if (y > h - EDGE) dir += 's';
      return dir;
    }
    // 开始调整形状（dir 为 n/w/e/s 组合；可由手柄或边缘热区触发）
    function beginResize(dir, ev) {
      if (!dir) return;
      ev.preventDefault();
      ev.stopPropagation();
      blockEl.classList.add('html-resizing');
      // 2026-08-19 修复：流程图块拖动调整时不加 dragging-block（opacity .85 + z-index 9999
      // 会半透明浮起，视觉上像空白蒙版盖住流程图）；该效果仅 HTML 块需要
      if (kind === 'html') blockEl.classList.add('dragging-block');
      // 2026-08-17：拖拽期间把 iframe 固定为当前尺寸（不随块变化、不重排内容），
      // 先专心调整块的形状/长宽；松手后再恢复内容自适应 —— 消除拖拽卡顿
      if (iframe2) {
        try {
          iframe2.style.width  = (iframe2.offsetWidth  || blockEl.offsetWidth)  + 'px';
          iframe2.style.height = (iframe2.offsetHeight || 80) + 'px';
          if (iframe2.contentWindow && iframe2.contentWindow.postMessage) {
            iframe2.contentWindow.postMessage({__htmlBlockPause: 1}, '*');
          }
        } catch (e) {}
      }
      var rect = blockEl.getBoundingClientRect();
      var startX = ev.clientX, startY = ev.clientY;
      var startW = rect.width, startH = rect.height;
      var startLeft = 0, startTop = 0;
      if (blockEl.style.position === 'absolute') {
        startLeft = parseFloat(blockEl.style.left) || 0;
        startTop  = parseFloat(blockEl.style.top)  || 0;
      }
      var pending = { w: startW, h: startH, left: startLeft, top: startTop };
      var rafId = 0;
      function commit() {
        rafId = 0;
        blockEl.style.width = pending.w + 'px';
        if (dir.indexOf('w') >= 0) blockEl.style.left = pending.left + 'px';
        if (dir.indexOf('n') >= 0) blockEl.style.top  = pending.top  + 'px';
        if (canvas2) {
          // 2026-08-19 修复：块总高跟随拖拽（含工具栏），canvas 由 handleResize
          // 按「块高 - 工具栏高」填满 —— 此前只设 canvas 高会被 handleResize 重置为 400，
          // 导致下边界拖动无效 + 高度区域留白
          blockEl.style.height = pending.h + 'px';
          try {
            var editors = _diagramEditors || [];
            for (var i = 0; i < editors.length; i++)
              if (editors[i].blockEl === blockEl) { editors[i].handleResize(); }
          } catch(err) {}
        } else {
          blockEl.style.height = pending.h + 'px';
        }
      }
      var throttledSave = _throttle(function() {
        var r = blockEl.getBoundingClientRect();
        var ui = _loadBlockUi(key) || {};
        ui.w = r.width; ui.h = r.height;
        if (blockEl.style.position === 'absolute') {
          ui.x = parseFloat(blockEl.style.left) || 0;
          ui.y = parseFloat(blockEl.style.top)  || 0;
        }
        _saveBlockUi(key, ui);
      }, 120);
      function move(ev) {
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (dir.indexOf('e') >= 0) pending.w = Math.max(180, startW + dx);
        if (dir.indexOf('w') >= 0) {
          pending.w    = Math.max(180, startW - dx);
          pending.left = startLeft + (startW - pending.w);
        }
        if (dir.indexOf('s') >= 0) pending.h = Math.max(80, startH + dy);
        if (dir.indexOf('n') >= 0) {
          pending.h   = Math.max(80, startH - dy);
          pending.top = startTop + (startH - pending.h);
        }
        if (!rafId) rafId = requestAnimationFrame(commit);
        throttledSave();
      }
      function up() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; commit(); }
        blockEl.classList.remove('dragging-block', 'html-resizing');
        // 2026-08-17：拖拽结束，恢复 iframe 跟随块宽 + 内容自适应高度
        if (iframe2) {
          try {
            iframe2.style.width = '100%';
            iframe2.style.height = '';
            if (iframe2.contentWindow && iframe2.contentWindow.postMessage) {
              iframe2.contentWindow.postMessage({__htmlBlockResume: 1}, '*');
            }
          } catch (e) {}
        }
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        var finRect = blockEl.getBoundingClientRect();
        var ui2 = _loadBlockUi(key) || {};
        ui2.w = finRect.width; ui2.h = finRect.height;
        if (blockEl.style.position === 'absolute') {
          ui2.x = parseFloat(blockEl.style.left) || 0;
          ui2.y = parseFloat(blockEl.style.top)  || 0;
        }
        _saveBlockUi(key, ui2);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    blockEl.addEventListener('mousedown', function(e) {
      if (e.target.closest && (
          e.target.closest('.block-action-bar') ||
          e.target.closest('.block-btn') ||
          e.target.closest('.block-mode-toggle') ||
          e.target.closest('.mode-btn') ||
          e.target.closest('.block-drag-handle') ||
          e.target.closest('.block-name-row') ||
          e.target.closest('.html-iframe') ||
          e.target.closest('.diagram-canvas') ||
          e.target.closest('.block-resize-handle')
        )) return;
      // 拖动模式：点击内部直接触发移动
      if (modeState === 'drag') {
        startDrag(e);
        return;
      }
      // 调整形状模式：检测边缘
      var dir = detectResizeDir(e);
      if (!dir) return;
      beginResize(dir, e);
    });
      // hover cursor：根据模式和鼠标位置动态切换
      blockEl.addEventListener('mousemove', function(e) {
        if (e.target.closest && (
            e.target.closest('.block-action-bar') ||
            e.target.closest('.block-btn') ||
            e.target.closest('.block-mode-toggle') ||
            e.target.closest('.mode-btn') ||
            e.target.closest('.block-drag-handle') ||
            e.target.closest('.block-name-row') ||
            e.target.closest('.html-iframe') ||
            e.target.closest('.diagram-canvas')
          )) { blockEl.style.cursor = ''; return; }
        // 拖动模式：内部显示 move 光标
        if (modeState === 'drag') {
          blockEl.style.cursor = 'move';
          return;
        }
        // 调整形状模式：边界显示 resize 光标
        var rect = blockEl.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var y = e.clientY - rect.top;
        var w = rect.width, h = rect.height;
        var cursor = '';
        var onL = x < EDGE, onR = x > w - EDGE;
        var onT = y < EDGE, onB = y > h - EDGE;
        if      (onL && onT) cursor = 'nwse-resize';
        else if (onL && onB) cursor = 'nesw-resize';
        else if (onR && onT) cursor = 'nesw-resize';
        else if (onR && onB) cursor = 'nwse-resize';
        else if (onL || onR) cursor = 'ew-resize';
        else if (onT || onB) cursor = 'ns-resize';
        blockEl.style.cursor = cursor;
      });
      blockEl.addEventListener('mouseleave', function() { blockEl.style.cursor = ''; });

    // ---- 拖拽移动（P1-6：rAF + 节流保存，P1-10：保存 x/y/floating + w/h） ----
    function startDrag(e) {
      if (e.target.closest && e.target.closest('.block-btn')) return;
      e.preventDefault();
      e.stopPropagation();
      blockEl.classList.add('is-floating', 'dragging-block');
      blockEl.style.position = 'absolute';

      var parent = blockEl.offsetParent || blockEl.parentElement;
      var pRect = parent.getBoundingClientRect();
      var bRect0 = blockEl.getBoundingClientRect();
      var curLeft = parseFloat(blockEl.style.left) || 0;
      var curTop  = parseFloat(blockEl.style.top)  || 0;
      if (!blockEl.style.left && !blockEl.style.top) {
        curLeft = bRect0.left - pRect.left;
        curTop  = bRect0.top  - pRect.top;
      }
      blockEl.style.left = curLeft + 'px';
      blockEl.style.top  = curTop  + 'px';
      var startX = e.clientX, startY = e.clientY;
      var pendX = curLeft, pendY = curTop;
      var rafId2 = 0;
      function commit2() {
        rafId2 = 0;
        blockEl.style.left = pendX + 'px';
        blockEl.style.top  = pendY + 'px';
      }
      var throttledSave2 = _throttle(function() {
        var ui = _loadBlockUi(key) || {};
        ui.x = parseFloat(blockEl.style.left) || 0;
        ui.y = parseFloat(blockEl.style.top)  || 0;
        ui.floating = true;
        var wr = blockEl.getBoundingClientRect();
        ui.w = wr.width; ui.h = wr.height;
        _saveBlockUi(key, ui);
      }, 150);

      function move(ev) {
        pendX = curLeft + (ev.clientX - startX);
        pendY = curTop  + (ev.clientY - startY);
        if (!rafId2) rafId2 = requestAnimationFrame(commit2);
        throttledSave2();
      }
      function up() {
        if (rafId2) { cancelAnimationFrame(rafId2); rafId2 = 0; commit2(); }
        blockEl.classList.remove('dragging-block');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        var ui = _loadBlockUi(key) || {};
        ui.x = parseFloat(blockEl.style.left) || 0;
        ui.y = parseFloat(blockEl.style.top)  || 0;
        ui.floating = true;
        var wr = blockEl.getBoundingClientRect();
        ui.w = wr.width; ui.h = wr.height;
        _saveBlockUi(key, ui);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    if (dragHandle) dragHandle.addEventListener('mousedown', function(e) {
      if (modeState === 'resize') return; // 调整形状模式下不响应拖动手柄
      startDrag(e);
    });
    if (actionBar) actionBar.addEventListener('mousedown', function(e) {
      if (e.target === actionBar || (e.target.classList && e.target.classList.contains('block-drag-handle'))) {
        if (modeState === 'resize') return;
        startDrag(e);
      }
    });
  }

  // ============================================================
  // DiagramEditor — 高自由度流程图 Canvas 编辑器
  // 支持：矩形/圆形/菱形节点、拖拽、连线、双击改字、Delete 删除、自动保存
  // 工具栏按钮文字由 CSS ::before 承载（无 DOM 文本），避免 contentEditable
  // 回写时污染 Markdown（MDConverter 读取不到 ::before 生成内容）。
  // ============================================================
  function DiagramEditor(blockEl) {
    this.blockEl = blockEl;
    this.diagramId = blockEl.getAttribute('data-diagram-id') || _generateDiagramId();
    this.data = loadDiagram(this.diagramId) || { nodes: [], edges: [] };
    if (!Array.isArray(this.data.nodes)) this.data.nodes = [];
    if (!Array.isArray(this.data.edges)) this.data.edges = [];
    this.mode = 'select';
    this.selected = null;
    this.edgeStart = null;
    this.drag = null;
    this.W = 0; this.H = 400;
    this._flashTimer = null;
    
    // 视图变换状态
    this.viewX = 0;
    this.viewY = 0;
    this.viewScale = 1;
    this._panning = null;
    // P1-8 流程图增强：多选/撤销重做栈/复制粘贴板/网格吸附
    this.multiSelected = [];   // 多选节点 id 数组（不包含主 selected）
    this._snapGrid = 10;       // 网格吸附像素（0 关闭）
    this._snapEnabled = false;
    this._history = [];        // { data: deepCopy, ts }
    this._historyMax = 40;
    this._historyIdx = -1;
    this._skipNextHistory = false;
    this._clipboardNodes = []; // 复制的节点（复制一份）

    var ph = blockEl.querySelector('.diagram-placeholder');
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);

    // 2026-08-16：修复「流程图两行 AI 改进/删除工具栏」
    if (!blockEl.querySelector(':scope > .block-action-bar.diagram-action-bar')) {
      var actionBar = document.createElement('div');
      actionBar.className = 'block-action-bar diagram-action-bar';
      actionBar.setAttribute('contenteditable', 'false');
      actionBar.innerHTML =
        '<div class="block-drag-handle" title="拖动以移动位置">⇱</div>'
        + '<div class="block-mode-toggle" role="tablist" aria-label="交互模式">'
        + '<button class="mode-btn mode-drag active" type="button" title="拖动模式">▢拖</button>'
        + '<button class="mode-btn mode-resize" type="button" title="调整形状模式">⇲调</button>'
        + '</div>'
        + '<button class="block-btn block-ai-btn" type="button" title="AI 改进流程图">AI 改进</button>'
        + '<button class="block-btn block-delete-btn" type="button" title="删除流程图">删除</button>';
      blockEl.insertBefore(actionBar, blockEl.firstChild);
    }
    
    var toolbar = document.createElement('div');
    toolbar.className = 'diagram-toolbar';
    toolbar.setAttribute('contenteditable', 'false');
    var btns = [
      ['collapse',   '⏷', '折叠工具栏'],
      ['select',     '▢', '选择/移动'],
      ['add-rect',   '▭', '添加矩形'],
      ['add-circle', '◯', '添加圆形'],
      ['add-diamond','◇', '添加菱形'],
      ['add-rounded', '▢', '圆角矩形'],
      ['add-hex',    '⬡', '添加六边形'],
      ['add-edge',   '╱', '添加连线'],
      ['edit-text',  '✎', '编辑文字'],
      ['delete',     '🗑', '删除所选'],
      ['undo',       '↶', '撤销'],
      ['redo',       '↷', '重做'],
      ['duplicate',  '⎘', '复制节点'],
      ['copy-node',  '⧉', '复制到剪贴板'],
      ['paste-node', '⤒', '粘贴节点'],
      ['select-all', '☑', '全选'],
      ['snap',       '⬚', '网格吸附'],
      ['fit-view',   '⤧', '适配视图'],
      ['color',      '🎨', '修改颜色'],
      ['prop',       '⚙', '属性面板'],
      ['zoom-out',   '−', '缩小'],
      ['zoom-in',    '+', '放大'],
      ['zoom-reset', '⟳', '重置视图'],
      ['refresh',    '🔄', '强制刷新'],
      ['save',       '💾', '保存']
    ];
    for (var i = 0; i < btns.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'diag-btn diag-' + btns[i][0] + (btns[i][0] === 'select' ? ' active' : '');
      b.setAttribute('data-action', btns[i][0]);
      b.setAttribute('title', btns[i][2]);
      b.textContent = btns[i][1];
      toolbar.appendChild(b);
    }
    var hint = document.createElement('span');
    hint.className = 'diag-mode-hint';
    hint.setAttribute('data-hint', '选择模式');
    toolbar.appendChild(hint);
    
    var zoomLabel = document.createElement('span');
    zoomLabel.className = 'diag-zoom-label';
    zoomLabel.setAttribute('data-zoom', '100%');
    toolbar.appendChild(zoomLabel);

    var canvasWrap = document.createElement('div');
    canvasWrap.className = 'diagram-canvas-wrap';
    
    var canvas = document.createElement('canvas');
    canvas.className = 'diagram-canvas';
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('contenteditable', 'false');

    canvasWrap.appendChild(canvas);
    blockEl.appendChild(toolbar);
    blockEl.appendChild(canvasWrap);

    this.toolbar = toolbar;
    this.canvasWrap = canvasWrap;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hintEl = hint;
    this.zoomLabel = zoomLabel;

    this._bind();
    
    // 修复：立即初始化并渲染，不依赖 requestAnimationFrame
    var self = this;
    this._ctxReady = true;
    try {
      this.handleResize();
      this.render();
    } catch (e) { console.warn('流程图初始化渲染失败:', e); }
    
    // 额外在多帧后再强制刷新一次，确保布局稳定后的尺寸正确
    setTimeout(function() { try { self.handleResize(); self.render(); } catch(e){} }, 50);
    setTimeout(function() { try { self.handleResize(); self.render(); } catch(e){} }, 200);
    
    _diagramEditors.push(this);
  }

  DiagramEditor.prototype._defaultColor = function(shape) {
    return shape === 'circle' ? '#fef3c7' : (shape === 'diamond' ? '#dcfce7' : '#e0f2fe');
  };

  DiagramEditor.prototype._node = function(id) {
    for (var i = 0; i < this.data.nodes.length; i++) {
      if (this.data.nodes[i].id === id) return this.data.nodes[i];
    }
    return null;
  };

  DiagramEditor.prototype._edge = function(id) {
    for (var i = 0; i < this.data.edges.length; i++) {
      if (this.data.edges[i].id === id) return this.data.edges[i];
    }
    return null;
  };

  DiagramEditor.prototype._newId = function(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  };

  DiagramEditor.prototype._setMode = function(m) {
    this.mode = m;
    this.edgeStart = null;
    var btns = this.toolbar.querySelectorAll('button.diag-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = 'diag-btn diag-' + btns[i].getAttribute('data-action')
        + (btns[i].getAttribute('data-action') === m ? ' active' : '');
    }
    this.updateModeHint();
    this.render();
  };

  DiagramEditor.prototype.updateModeHint = function(text) {
    if (!this.hintEl) return;
    var t = text || '';
    if (!t) {
      switch (this.mode) {
        case 'select': t = '选择模式（Shift 连选；拖拽移动；空白处拖动可平移画布）'; break;
        case 'add-rect': t = '点击画布添加矩形'; break;
        case 'add-circle': t = '点击画布添加圆形'; break;
        case 'add-diamond': t = '点击画布添加菱形'; break;
        case 'add-rounded': t = '点击画布添加圆角矩形'; break;
        case 'add-hex': t = '点击画布添加六边形'; break;
        case 'add-edge': t = '点击起点节点 → 目标节点'; break;
        default: t = '';
      }
    }
    this.hintEl.setAttribute('data-hint', t);
  };

  DiagramEditor.prototype._flash = function(msg) {
    this.updateModeHint(msg);
    var self = this;
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(function() { self.updateModeHint(); }, 1500);
  };

  DiagramEditor.prototype.handleResize = function() {
    // 获取容器宽度
    var w = this.canvasWrap ? this.canvasWrap.clientWidth : 
            (this.blockEl.clientWidth || this.blockEl.offsetWidth || 600);
    // 2026-08-19 修复：块处于隐藏/未布局状态时 clientWidth/offsetWidth 为 0，
    // 会导致 canvas 0 尺寸 → 渲染空白。兜底到块宽度或默认 600，保证始终有可用尺寸。
    if (!w || w <= 30) {
      w = (this.blockEl && (this.blockEl.offsetWidth || this.blockEl.clientWidth)) || 600;
    }
    // 2026-08-19 彻底消除留白：块为 flex 纵向布局，canvasWrap flex:1 自动填满
    // 块内剩余高度（含操作条/工具栏换行等真实占位），直接读 clientHeight 即真实
    // 可用高度，不再做「块高 - 工具栏高」的估算，任何场景下画布都恰好铺满无缝隙。
    var h = 400;
    try {
      if (this.canvasWrap) {
        var wh = this.canvasWrap.clientHeight;
        if (wh > 0) h = Math.max(80, wh);
      }
    } catch (e) { h = 400; }
    var dpr = window.devicePixelRatio || 1;
    
    // 设置 canvas 实际像素尺寸（canvas 与 wrap 同尺寸，不留空白边）
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; 
    this.H = h;
    
    if (this._ctxReady) this.render();
  };

  // 强制刷新：重新测量容器尺寸 → 重设 canvas → 重置 ctx → 立即渲染，确保瞬间显示
  DiagramEditor.prototype.forceRefresh = function() {
    var self = this;
    try {
      // 1. 重置 ctx 状态，防止 transform 残留导致渲染异常
      var dpr = window.devicePixelRatio || 1;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 2. 重新测量容器并设置 canvas 尺寸
      this.handleResize();
      // 3. 确保 ctxReady 并立即渲染
      this._ctxReady = true;
      this.render();
      // 4. 闪烁提示
      this._flash('已刷新');
    } catch (e) {
      console.warn('forceRefresh failed:', e);
    }
    // 5. 备用：下一帧再刷一次，防止 DOM 布局尚未稳定
    requestAnimationFrame(function() {
      try { self.handleResize(); self.render(); } catch (e2) {}
    });
    // 6. 最终保险：200ms 后再刷一次
    setTimeout(function() {
      try { self.handleResize(); self.render(); } catch (e3) {}
    }, 200);
  };

  DiagramEditor.prototype._bind = function() {
    var self = this;
    this.toolbar.addEventListener('mousedown', function(e) { e.preventDefault(); });
    this.toolbar.addEventListener('click', function(e) {
      var btn = e.target.closest ? e.target.closest('button.diag-btn') : null;
      if (!btn) return;
      e.preventDefault();
      self._onAction(btn.getAttribute('data-action'));
    });
    var getScreenPos = function(ev) {
      var r = self.canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    this.canvas.addEventListener('mousedown', function(ev) {
      if (ev.target.closest && ev.target.closest('.block-name-row')) return; // 名字行优先
      self.canvas.focus();
      var sp = getScreenPos(ev);
      var wp = self.screenToWorld(sp.x, sp.y);
      self._onDown(sp.x, sp.y, wp.x, wp.y, ev);
    });
    this.canvas.addEventListener('mousemove', function(ev) {
      var sp = getScreenPos(ev);
      var wp = self.screenToWorld(sp.x, sp.y);
      self._onMove(sp.x, sp.y, wp.x, wp.y, ev);
    });
    this.canvas.addEventListener('mouseup', function(ev) {
      self._onUp();
    });
    this.canvas.addEventListener('mouseleave', function(ev) {
      if (self._panning) self._onUp();
    });
    this.canvas.addEventListener('dblclick', function(ev) {
      var sp = getScreenPos(ev);
      var wp = self.screenToWorld(sp.x, sp.y);
      self._onDbl(wp.x, wp.y);
    });
    this.canvas.addEventListener('wheel', function(ev) {
      ev.preventDefault();
      var sp = getScreenPos(ev);
      var delta = ev.deltaY > 0 ? 0.9 : 1.1;
      var newScale = Math.max(0.2, Math.min(4, self.viewScale * delta));
      self._setZoom(newScale, sp.x, sp.y);
    }, { passive: false });
    this.canvas.addEventListener('keydown', function(ev) {
      // P1-8：扩展键盘快捷键（Ctrl+Z 撤销 / Ctrl+Shift+Z 重做 / Ctrl+A 全选 / Ctrl+C 复制 / Ctrl+V 粘贴 / Ctrl+D 复制）
      var ctrl = ev.ctrlKey || ev.metaKey;
      if (ctrl && !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault(); self.undo(); return;
      }
      if (ctrl && ev.shiftKey && (ev.key === 'z' || ev.key === 'Z' || ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault(); self.redo(); return;
      }
      if (ctrl && (ev.key === 'a' || ev.key === 'A')) {
        ev.preventDefault(); self.selectAll(); return;
      }
      if (ctrl && (ev.key === 'c' || ev.key === 'C')) {
        ev.preventDefault(); self.copySelected(); return;
      }
      if (ctrl && (ev.key === 'v' || ev.key === 'V')) {
        ev.preventDefault(); self.pasteFromClipboard(); return;
      }
      if (ctrl && (ev.key === 'd' || ev.key === 'D')) {
        ev.preventDefault(); self.duplicateSelected(); return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        self._deleteSelected();
      } else if (ev.key === 'Escape') {
        self.selected = null;
        self.multiSelected = [];
        self.edgeStart = null;
        self.render();
      }
    });
  };

  // ---------- P1-8 撤销/重做 ----------
  DiagramEditor.prototype._snapshotForHistory = function() {
    if (this._skipNextHistory) { this._skipNextHistory = false; return; }
    try {
      var snapshot = JSON.parse(JSON.stringify(this.data));
      if (this._historyIdx < this._history.length - 1) {
        this._history = this._history.slice(0, this._historyIdx + 1);
      }
      this._history.push({ data: snapshot, ts: Date.now() });
      if (this._history.length > this._historyMax) this._history.shift();
      this._historyIdx = this._history.length - 1;
    } catch (e) {}
  };
  DiagramEditor.prototype.undo = function() {
    if (this._historyIdx > 0) {
      this._historyIdx--;
      var s = this._history[this._historyIdx];
      if (s && s.data) {
        this._skipNextHistory = true;
        this.data = JSON.parse(JSON.stringify(s.data));
        this._flash('已撤销');
        this.render();
      }
    } else {
      this._flash('无法继续撤销');
    }
  };
  DiagramEditor.prototype.redo = function() {
    if (this._historyIdx < this._history.length - 1) {
      this._historyIdx++;
      var s = this._history[this._historyIdx];
      if (s && s.data) {
        this._skipNextHistory = true;
        this.data = JSON.parse(JSON.stringify(s.data));
        this._flash('已重做');
        this.render();
      }
    } else {
      this._flash('没有可重做的步骤');
    }
  };

  // ---------- P1-8 多选/全选/复制粘贴/复制/属性面板 ----------
  DiagramEditor.prototype.selectAll = function() {
    this.multiSelected = (this.data.nodes || []).map(function(n){ return n.id; });
    this.selected = null;
    this._flash('已全选 ' + this.multiSelected.length + ' 个节点');
    this.render();
  };
  DiagramEditor.prototype.getSelectedIds = function() {
    var ids = [];
    if (this.selected) ids.push(this.selected);
    if (this.multiSelected && this.multiSelected.length) ids = ids.concat(this.multiSelected);
    return ids;
  };
  DiagramEditor.prototype.copySelected = function() {
    var ids = this.getSelectedIds();
    if (!ids.length) { this._flash('请先选择节点'); return; }
    var list = [];
    for (var i = 0; i < ids.length; i++) {
      var n = this._node(ids[i]);
      if (n) list.push(JSON.parse(JSON.stringify(n)));
    }
    this._clipboardNodes = list;
    this._flash('已复制 ' + list.length + ' 个节点');
  };
  DiagramEditor.prototype.pasteFromClipboard = function() {
    if (!this._clipboardNodes || !this._clipboardNodes.length) { this._flash('剪贴板为空'); return; }
    this._snapshotForHistory();
    var offsetX = 30, offsetY = 30;
    var newIds = [];
    for (var i = 0; i < this._clipboardNodes.length; i++) {
      var n = JSON.parse(JSON.stringify(this._clipboardNodes[i]));
      n.id = this._newId('n');
      n.x = (n.x || 0) + offsetX;
      n.y = (n.y || 0) + offsetY;
      this.data.nodes.push(n);
      newIds.push(n.id);
    }
    this._clipboardNodes = this._clipboardNodes.map(function(x){ return JSON.parse(JSON.stringify(x)); });
    this.selected = newIds[0] || null;
    this.multiSelected = newIds.slice(1);
    this._flash('已粘贴 ' + newIds.length + ' 个节点');
    this.render();
  };
  DiagramEditor.prototype.duplicateSelected = function() {
    this.copySelected();
    this.pasteFromClipboard();
  };
  DiagramEditor.prototype._pickColorDialog = function(current) {
    var self = this;
    return new Promise(function(resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;';
      var panel = document.createElement('div');
      panel.style.cssText = 'background:#fff;border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,.2);min-width:280px;';
      panel.innerHTML = '<div style="font-weight:600;margin-bottom:12px;font-size:14px;color:#333;">选择节点颜色</div>'
        + '<div style="margin-bottom:12px;"><input type="color" id="diag-color-picker" value="' + (current || '#dbeafe') + '" style="width:100%;height:48px;border:1px solid #ddd;border-radius:8px;cursor:pointer;"></div>'
        + '<div style="margin-bottom:12px;font-size:12px;color:#666;">或输入颜色值：</div>'
        + '<input type="text" id="diag-color-text" value="' + (current || '') + '" placeholder="#dbeafe / red / rgba(255,0,0,.5)" style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;margin-bottom:12px;box-sizing:box-box;">'
        + '<div style="display:flex;gap:8px;"><button id="diag-color-ok" style="flex:1;padding:8px;background:#3a5a40;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;">确定</button>'
        + '<button id="diag-color-cancel" style="flex:1;padding:8px;background:#eee;color:#333;border:none;border-radius:8px;cursor:pointer;font-size:13px;">取消</button></div>';
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      var picker = panel.querySelector('#diag-color-picker');
      var textInput = panel.querySelector('#diag-color-text');
      picker.addEventListener('input', function() { textInput.value = picker.value; });
      textInput.addEventListener('input', function() {
        var v = textInput.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) picker.value = v;
      });
      panel.querySelector('#diag-color-ok').addEventListener('click', function() {
        var v = textInput.value.trim() || picker.value;
        document.body.removeChild(overlay);
        resolve(v);
      });
      panel.querySelector('#diag-color-cancel').addEventListener('click', function() {
        document.body.removeChild(overlay);
        resolve(null);
      });
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); }
      });
      setTimeout(function() { textInput.focus(); }, 50);
    });
  };
  DiagramEditor.prototype._changeColor = function() {
    var self = this;
    var ids = this.getSelectedIds();
    if (!ids.length) { this._flash('请先选择节点'); return; }
    var sample = this._node(ids[0]);
    this._pickColorDialog(sample ? (sample.fill || sample.color || '') : '').then(function(c) {
      if (!c) return;
      self._snapshotForHistory();
      for (var i = 0; i < ids.length; i++) {
        var n = self._node(ids[i]);
        if (n) { n.fill = c; if (!n.color) n.color = c; }
      }
      self._flash('已修改 ' + ids.length + ' 个节点颜色');
      self.render();
    });
  };
  DiagramEditor.prototype._fitView = function() {
    var nodes = this.data.nodes || [];
    if (!nodes.length) { this.resetView(); this._flash('画布为空'); return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var x1 = n.x || 0, y1 = n.y || 0;
      var w = n.w || 120, h = n.h || 70;
      if (n.shape === 'circle') { w = Math.max(w, h); h = w; }
      var x2 = x1 + w, y2 = y1 + h;
      if (x1 < minX) minX = x1; if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2; if (y2 > maxY) maxY = y2;
    }
    var padding = 40;
    var boxW = Math.max(1, maxX - minX + padding * 2);
    var boxH = Math.max(1, maxY - minY + padding * 2);
    var viewW = this.canvas ? (this.canvas.clientWidth || 600) : 600;
    var viewH = this.canvas ? (this.canvas.clientHeight || 400) : 400;
    var s = Math.min(viewW / boxW, viewH / boxH, 3);
    this.viewScale = Math.max(0.2, Math.min(4, s));
    this.viewX = -minX * this.viewScale + padding + (viewW - boxW * this.viewScale) / 2;
    this.viewY = -minY * this.viewScale + padding + (viewH - boxH * this.viewScale) / 2;
    if (this.zoomLabel) this.zoomLabel.setAttribute('data-zoom', Math.round(this.viewScale * 100) + '%');
    this._flash('已适配全部节点');
    this.render();
  };
  DiagramEditor.prototype._toggleSnap = function() {
    this._snapEnabled = !this._snapEnabled;
    this._flash('网格吸附 ' + (this._snapEnabled ? '开启（' + this._snapGrid + 'px）' : '关闭'));
    var btn = this.toolbar ? this.toolbar.querySelector('.diag-snap') : null;
    if (btn) {
      btn.classList.toggle('active', this._snapEnabled);
    }
    this.render();
  };
  DiagramEditor.prototype._snap = function(v) {
    if (!this._snapEnabled) return v;
    var g = this._snapGrid > 0 ? this._snapGrid : 10;
    return Math.round(v / g) * g;
  };
  DiagramEditor.prototype._openPropPanel = function() {
    var self = this;
    var ids = this.getSelectedIds();
    if (!ids.length) { this._flash('请先选择 1 个节点查看属性'); return; }
    var n = this._node(ids[0]);
    if (!n) return;

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;';
    var panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,.2);min-width:340px;max-height:90vh;overflow-y:auto;';
    panel.innerHTML = '<div style="font-weight:600;margin-bottom:14px;font-size:15px;color:#333;">节点属性</div>'
      + '<div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">填充色</label>'
      + '<div style="display:flex;gap:8px;margin-top:4px;"><input type="color" id="prop-fill-color" value="' + (n.fill || n.color || '#dbeafe') + '" style="width:48px;height:36px;border:1px solid #ddd;border-radius:6px;cursor:pointer;"><input type="text" id="prop-fill-text" value="' + (n.fill || n.color || '') + '" style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;"></div></div>'
      + '<div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">尺寸 (宽×高)</label>'
      + '<div style="display:flex;gap:8px;margin-top:4px;"><input type="number" id="prop-w" value="' + (n.w || 120) + '" min="40" style="width:80px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;"><span style="align-self:center;color:#999;">×</span><input type="number" id="prop-h" value="' + (n.h || 70) + '" min="30" style="width:80px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;"></div></div>'
      + '<div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">边框宽度</label>'
      + '<input type="number" id="prop-bw" value="' + (n.borderWidth != null ? n.borderWidth : 1) + '" min="0" max="10" step="0.5" style="width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-top:4px;"></div>'
      + '<div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">边框颜色</label>'
      + '<div style="display:flex;gap:8px;margin-top:4px;"><input type="color" id="prop-bc-color" value="' + (n.borderColor || '#475569') + '" style="width:48px;height:36px;border:1px solid #ddd;border-radius:6px;cursor:pointer;"><input type="text" id="prop-bc-text" value="' + (n.borderColor || '') + '" style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;"></div></div>'
      + '<div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">字体大小 (px)</label>'
      + '<input type="number" id="prop-fs" value="' + (n.fontSize || 14) + '" min="8" max="48" style="width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-top:4px;"></div>'
      + '<div style="margin-bottom:10px;"><label style="font-size:12px;color:#666;">文字颜色</label>'
      + '<div style="display:flex;gap:8px;margin-top:4px;"><input type="color" id="prop-fc-color" value="' + (n.fontColor || '#0f172a') + '" style="width:48px;height:36px;border:1px solid #ddd;border-radius:6px;cursor:pointer;"><input type="text" id="prop-fc-text" value="' + (n.fontColor || '') + '" style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;"></div></div>'
      + '<div style="display:flex;gap:8px;margin-top:14px;"><button id="prop-ok" style="flex:1;padding:10px;background:#3a5a40;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;">应用</button>'
      + '<button id="prop-cancel" style="flex:1;padding:10px;background:#eee;color:#333;border:none;border-radius:8px;cursor:pointer;font-size:13px;">取消</button></div>';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    var fillPicker = panel.querySelector('#prop-fill-color');
    var fillText = panel.querySelector('#prop-fill-text');
    fillPicker.addEventListener('input', function() { fillText.value = fillPicker.value; });
    fillText.addEventListener('input', function() {
      var v = fillText.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) fillPicker.value = v;
    });
    var bcPicker = panel.querySelector('#prop-bc-color');
    var bcText = panel.querySelector('#prop-bc-text');
    bcPicker.addEventListener('input', function() { bcText.value = bcPicker.value; });
    bcText.addEventListener('input', function() {
      var v = bcText.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) bcPicker.value = v;
    });
    var fcPicker = panel.querySelector('#prop-fc-color');
    var fcText = panel.querySelector('#prop-fc-text');
    fcPicker.addEventListener('input', function() { fcText.value = fcPicker.value; });
    fcText.addEventListener('input', function() {
      var v = fcText.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) fcPicker.value = v;
    });
    panel.querySelector('#prop-ok').addEventListener('click', function() {
      var fv = fillText.value.trim() || fillPicker.value;
      if (fv) { n.fill = fv; if (!n.color) n.color = fv; }
      var nw = parseFloat(panel.querySelector('#prop-w').value);
      var nh = parseFloat(panel.querySelector('#prop-h').value);
      if (!isNaN(nw) && nw >= 40) n.w = nw;
      if (!isNaN(nh) && nh >= 30) n.h = nh;
      var bw = parseFloat(panel.querySelector('#prop-bw').value);
      if (!isNaN(bw) && bw >= 0) n.borderWidth = bw;
      var bcv = bcText.value.trim() || bcPicker.value;
      if (bcv) n.borderColor = bcv;
      var fsv = parseFloat(panel.querySelector('#prop-fs').value);
      if (!isNaN(fsv) && fsv > 0) n.fontSize = fsv;
      var fcv = fcText.value.trim() || fcPicker.value;
      if (fcv) n.fontColor = fcv;
      self._snapshotForHistory();
      self._flash('属性已更新');
      self.render();
      document.body.removeChild(overlay);
    });
    panel.querySelector('#prop-cancel').addEventListener('click', function() {
      document.body.removeChild(overlay);
    });
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
  };

  DiagramEditor.prototype._onAction = function(action) {
    switch (action) {
      case 'collapse':    this.toggleToolbar(); break;
      case 'select': this._setMode('select'); break;
      case 'add-rect':    this._setMode('add-rect'); break;
      case 'add-circle':  this._setMode('add-circle'); break;
      case 'add-diamond': this._setMode('add-diamond'); break;
      case 'add-rounded': this._setMode('add-rounded'); break;
      case 'add-hex':     this._setMode('add-hex'); break;
      case 'add-edge':    this._setMode('add-edge'); break;
      case 'edit-text':   this._editSelectedText(); break;
      case 'delete':      this._deleteSelected(); this._snapshotForHistory(); break;
      case 'undo':        this.undo(); break;
      case 'redo':        this.redo(); break;
      case 'duplicate':   this.duplicateSelected(); break;
      case 'copy-node':   this.copySelected(); break;
      case 'paste-node':  this.pasteFromClipboard(); break;
      case 'select-all':  this.selectAll(); break;
      case 'snap':        this._toggleSnap(); break;
      case 'fit-view':    this._fitView(); break;
      case 'color':       this._changeColor(); break;
      case 'prop':        this._openPropPanel(); break;
      case 'zoom-in':     this.zoomIn(); break;
      case 'zoom-out':    this.zoomOut(); break;
      case 'zoom-reset':  this.resetView(); break;
      case 'refresh':     this.forceRefresh(); break;
      case 'save':        saveDiagram(this.diagramId, this.data); this._flash('已保存到本地'); this._snapshotForHistory(); break;
    }
  };

  // 折叠/展开工具栏：收起后仅保留折叠按钮（其余按钮与提示隐藏），再点展开
  DiagramEditor.prototype.toggleToolbar = function() {
    var tb = this.toolbar;
    if (!tb) return;
    var collapsed = tb.classList.toggle('collapsed');
    var btn = tb.querySelector('.diag-collapse');
    if (btn) {
      btn.textContent = collapsed ? '⏵' : '⏷';
      btn.setAttribute('title', collapsed ? '展开工具栏' : '折叠工具栏');
    }
    // 收起/展开后画布宽度可能变化，重新测量渲染
    var self = this;
    setTimeout(function() { try { self.handleResize(); self.render(); } catch (e) {} }, 50);
  };

  // ---------- 视图控制方法 ----------
  DiagramEditor.prototype.screenToWorld = function(sx, sy) {
    return {
      x: (sx - this.viewX) / this.viewScale,
      y: (sy - this.viewY) / this.viewScale
    };
  };

  DiagramEditor.prototype.zoomIn = function() {
    var newScale = Math.min(this.viewScale * 1.2, 4);
    this._setZoom(newScale);
  };

  DiagramEditor.prototype.zoomOut = function() {
    var newScale = Math.max(this.viewScale / 1.2, 0.2);
    this._setZoom(newScale);
  };

  DiagramEditor.prototype.resetView = function() {
    this.viewX = 0;
    this.viewY = 0;
    this._setZoom(1);
  };

  // P1-11 预留：直接缩放至指定比例（不按当前值连乘/连除），并把 viewScale 回写到块 UI 存储
  DiagramEditor.prototype.zoomTo = function(newScale, noSave) {
    var s = Math.max(0.2, Math.min(4, Number(newScale) || 1));
    this._setZoom(s);
    if (noSave) return s;
    try {
      // 用当前块的 key 持久化 viewScale
      var page = (typeof _getCurrentPageObj === 'function') ? _getCurrentPageObj() : null;
      var k = (typeof _blockUiKey === 'function') ? _blockUiKey(page, this.blockEl) : null;
      if (k && typeof _loadBlockUi === 'function' && typeof _saveBlockUi === 'function') {
        var ui = _loadBlockUi(k) || {};
        ui.viewScale = s;
        _saveBlockUi(k, ui);
      }
    } catch (e12) {}
    return s;
  };

  DiagramEditor.prototype._setZoom = function(newScale, centerX, centerY) {
    var oldScale = this.viewScale;
    if (centerX !== undefined && centerY !== undefined) {
      this.viewX = centerX - (centerX - this.viewX) * (newScale / oldScale);
      this.viewY = centerY - (centerY - this.viewY) * (newScale / oldScale);
    }
    this.viewScale = newScale;
    if (this.zoomLabel) {
      this.zoomLabel.setAttribute('data-zoom', Math.round(newScale * 100) + '%');
    }
    this.render();
  };

  DiagramEditor.prototype._nodeAt = function(x, y) {
    var nodes = this.data.nodes;
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return n;
    }
    return null;
  };

  DiagramEditor.prototype._edgeAt = function(x, y) {
    var edges = this.data.edges;
    for (var i = edges.length - 1; i >= 0; i--) {
      var e = edges[i];
      var a = this._node(e.from), b = this._node(e.to);
      if (!a || !b) continue;
      var x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len, ny = dx / len;
      var cx = mx + nx * (e.curve || 0), cy = my + ny * (e.curve || 0);
      for (var t = 0; t <= 1; t += 0.05) {
        var px = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
        var py = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
        if (Math.abs(px - x) < 6 && Math.abs(py - y) < 6) return e;
      }
    }
    return null;
  };

  DiagramEditor.prototype._onDown = function(sx, sy, wx, wy, ev) {
    // 如果在空白处按下，且是 select 模式，启动视图平移
    if (this.mode === 'select') {
      var n = this._nodeAt(wx, wy);
      var ed = this._edgeAt(wx, wy);
      if (!n && !ed) {
        // 空白处点击：启动视图平移
        this._panning = { startX: sx, startY: sy, viewStartX: this.viewX, viewStartY: this.viewY };
        this.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    
    var n = this._nodeAt(wx, wy);
    if (this.mode === 'add-rect' || this.mode === 'add-circle' || this.mode === 'add-diamond'
        || this.mode === 'add-rounded' || this.mode === 'add-hex') {
      if (n) { this.selected = { type: 'node', id: n.id }; this.render(); return; }
      var shape = this.mode.replace('add-', '');
      var defaultW = (shape === 'hex') ? 140 : 120;
      var defaultH = (shape === 'hex') ? 70 : 40;
      var node = {
        id: this._newId('n'),
        x: this._snap(wx - defaultW / 2),
        y: this._snap(wy - defaultH / 2),
        w: defaultW, h: defaultH,
        text: '新节点', shape: shape, color: this._defaultColor(shape),
        fill: this._defaultColor(shape),
        borderWidth: 1,
        borderColor: '#475569',
        fontSize: 14,
        fontColor: '#0f172a'
      };
      this.data.nodes.push(node);
      this.selected = { type: 'node', id: node.id };
      this._snapshotForHistory();
      this._persist(); this.render();
      return;
    }
    if (this.mode === 'add-edge') {
      if (n) {
        if (!this.edgeStart) {
          this.edgeStart = n.id;
          this._flash('已选起点，点击目标节点连线');
          this.render();
        } else if (this.edgeStart !== n.id) {
          var edge = {
            id: this._newId('e'), from: this.edgeStart, to: n.id,
            label: '', curve: 0, color: '#334155', width: 2
          };
          this.data.edges.push(edge);
          this.edgeStart = null;
          this._snapshotForHistory();
          this._persist(); this.render(); this.updateModeHint();
        } else {
          this.edgeStart = null; this.render();
        }
      } else {
        this.edgeStart = null; this.render();
      }
      return;
    }
    // select 模式：点击节点开始拖拽（Shift 多选，取消 multiSelected 中的点）
    if (n) {
      if (ev && ev.shiftKey) {
        // Shift 加入 multi
        if (this.multiSelected.indexOf(n.id) >= 0) {
          this.multiSelected = this.multiSelected.filter(function(x){ return x !== n.id; });
        } else {
          // 把当前主 selected 先挪到 multi，再把当前点击也加进去
          if (this.selected && this.selected.type === 'node' && this.selected.id !== n.id) {
            if (this.multiSelected.indexOf(this.selected.id) < 0) {
              this.multiSelected.push(this.selected.id);
            }
          }
          if (this.multiSelected.indexOf(n.id) < 0) this.multiSelected.push(n.id);
          this.selected = null;
          this.drag = null;
          this.canvas.style.cursor = 'default';
        }
      } else {
        // 非 Shift：清空多选，只保留主选中
        this.multiSelected = [];
        this.selected = { type: 'node', id: n.id };
        this.drag = { id: n.id, dx: wx - n.x, dy: wy - n.y };
        this.canvas.style.cursor = 'grabbing';
      }
    } else {
      this.multiSelected = [];
      var ed = this._edgeAt(wx, wy);
      this.selected = ed ? { type: 'edge', id: ed.id } : null;
    }
    this.render();
  };

  DiagramEditor.prototype._editNodeText = function(n) {
    var t = window.prompt('编辑节点文字：', n.text || '');
    if (t === null) return;
    n.text = t;
    this._snapshotForHistory();
    this._persist(); this.render();
  };

  DiagramEditor.prototype._editSelectedText = function() {
    if (this.selected && this.selected.type === 'node') {
      var n = this._node(this.selected.id);
      if (n) { this._editNodeText(n); return; }
    }
    this._flash('请先选择一个节点');
  };

  DiagramEditor.prototype._deleteSelected = function() {
    if (!this.selected) { this._flash('未选中任何元素'); return; }
    // 多选优先：删 multiSelected + selected
    var ids = this.getSelectedIds();
    var removedAny = false;
    if (ids.length) {
      removedAny = true;
      var set = {};
      for (var j = 0; j < ids.length; j++) set[ids[j]] = true;
      this.data.nodes = this.data.nodes.filter(function(n){ return !set[n.id]; });
      this.data.edges = this.data.edges.filter(function(e){ return !set[e.from] && !set[e.to]; });
      this.multiSelected = [];
    } else if (this.selected.type === 'node') {
      removedAny = true;
      var id = this.selected.id;
      this.data.nodes = this.data.nodes.filter(function(n) { return n.id !== id; });
      this.data.edges = this.data.edges.filter(function(e) { return e.from !== id && e.to !== id; });
    } else if (this.selected.type === 'edge') {
      removedAny = true;
      var eid = this.selected.id;
      this.data.edges = this.data.edges.filter(function(e) { return e.id !== eid; });
    }
    this.selected = null;
    if (removedAny) this._snapshotForHistory();
    this._persist(); this.render();
    this._flash('已删除');
  };

  DiagramEditor.prototype._onMove = function(sx, sy, wx, wy) {
    if (this._panning) {
      this.viewX = this._panning.viewStartX + (sx - this._panning.startX);
      this.viewY = this._panning.viewStartY + (sy - this._panning.startY);
      this.render();
      return;
    }
    if (!this.drag) return;
    var n = this._node(this.drag.id);
    if (!n) return;
    n.x = this._snap(wx - this.drag.dx);
    n.y = this._snap(wy - this.drag.dy);
    // 如果有多选：按同一个相对位移一起移动
    if (this.multiSelected && this.multiSelected.length) {
      if (!this.drag._ms) this.drag._ms = true;
      var all = this.multiSelected;
      var startX0 = this.drag._startX0;
      var startY0 = this.drag._startY0;
      if (!startX0 || !startY0) {
        this.drag._startX0 = n.x; this.drag._startY0 = n.y;
      } else {
        var dx = n.x - startX0;
        var dy = n.y - startY0;
        for (var k = 0; k < all.length; k++) {
          var nn = this._node(all[k]);
          if (!nn) continue;
          if (this.drag._origX == null) {
            this.drag._origX = {}; this.drag._origY = {};
            this.drag._origX[nn.id] = nn.x;
            this.drag._origY[nn.id] = nn.y;
          }
          var ox = this.drag._origX[nn.id], oy = this.drag._origY[nn.id];
          if (ox == null) continue;
          nn.x = this._snap(ox + dx);
          nn.y = this._snap(oy + dy);
        }
      }
    }
    this.render();
  };

  DiagramEditor.prototype._onUp = function() {
    if (this._panning) {
      this._panning = null;
      if (this.mode === 'select') this.canvas.style.cursor = 'default';
      return;
    }
    if (this.drag) {
      this.drag = null;
      this._snapshotForHistory();
      this._persist();
      if (this.mode === 'select') this.canvas.style.cursor = 'default';
    }
  };

  DiagramEditor.prototype._persist = function() {
    saveDiagram(this.diagramId, this.data);
  };

  // ---------- 渲染 ----------
  DiagramEditor.prototype.render = function() {
    var ctx = this.ctx, W = this.W, H = this.H;
    if (!ctx) return;
    this._ctxReady = true;
    
    // 1. 绘制背景（不应用视图变换）
    ctx.fillStyle = '#fffdf6';
    ctx.fillRect(0, 0, W, H);
    
    // 2. 保存状态并应用视图变换
    ctx.save();
    ctx.translate(this.viewX, this.viewY);
    ctx.scale(this.viewScale, this.viewScale);
    
    // 3. 绘制网格（在视图变换下）
    var gridSize = 20;
    // 计算可见范围内的网格
    var viewLeft = -this.viewX / this.viewScale;
    var viewTop = -this.viewY / this.viewScale;
    var viewRight = viewLeft + W / this.viewScale;
    var viewBottom = viewTop + H / this.viewScale;
    
    var startX = Math.floor(viewLeft / gridSize) * gridSize;
    var startY = Math.floor(viewTop / gridSize) * gridSize;
    
    ctx.strokeStyle = 'rgba(0,0,0,.06)';
    ctx.lineWidth = 1 / this.viewScale;
    for (var x = startX; x <= viewRight + gridSize; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, viewTop); ctx.lineTo(x, viewBottom); ctx.stroke();
    }
    for (var y = startY; y <= viewBottom + gridSize; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(viewLeft, y); ctx.lineTo(viewRight, y); ctx.stroke();
    }
    
    // 4. 绘制连线
    for (var i = 0; i < this.data.edges.length; i++) this._drawEdge(this.data.edges[i]);
    
    // 5. 绘制节点
    for (var j = 0; j < this.data.nodes.length; j++) this._drawNode(this.data.nodes[j]);
    
    // 6. 连线起点高亮
    if (this.edgeStart) {
      var sn = this._node(this.edgeStart);
      if (sn) { 
        ctx.save(); 
        ctx.strokeStyle = '#3a5a40'; 
        ctx.lineWidth = 2 / this.viewScale; 
        ctx.setLineDash([4 / this.viewScale, 3 / this.viewScale]); 
        this._strokeShape(sn); 
        ctx.restore(); 
      }
    }
    
    // 7. 选中高亮
    if (this.selected && this.selected.type === 'node') {
      var sel = this._node(this.selected.id);
      if (sel) { 
        ctx.save(); 
        ctx.strokeStyle = '#d2691e'; 
        ctx.lineWidth = 2 / this.viewScale; 
        this._strokeShape(sel); 
        ctx.restore(); 
      }
    } else if (this.selected && this.selected.type === 'edge') {
      var se = this._edge(this.selected.id);
      if (se) { 
        ctx.save(); 
        ctx.strokeStyle = '#d2691e'; 
        ctx.lineWidth = 3 / this.viewScale; 
        this._strokeEdge(se); 
        ctx.restore(); 
      }
    }
    
    // 8. 恢复状态
    ctx.restore();
  };

  DiagramEditor.prototype._strokeShape = function(n, inset) {
    inset = inset || 0;
    this.ctx.strokeRect(n.x - inset, n.y - inset, n.w + inset * 2, n.h + inset * 2);
  };

  // 2026-08-16 P1-7：节点形状边界与射线的交点（保证连线起/终点落在节点边缘，箭头不被填充遮挡）
  // n: 节点, fromX/fromY: 射线起点（通常是另一个节点的中心）, toX/toY: 射线终点（通常是 n 自己的中心）
  // 返回: { x, y } 在 n 的边界上，位于射线 fromX,fromY → toX,toY 的方向上
  DiagramEditor.prototype._nodeBoundaryIntersect = function(n, fromX, fromY) {
    if (!n) return { x: 0, y: 0 };
    var cx = n.x + n.w / 2;
    var cy = n.y + n.h / 2;
    var dx = cx - fromX;
    var dy = cy - fromY;
    // 当两点重合时，随便给个方向
    if (dx === 0 && dy === 0) dx = 1;
    var shape = n.shape || 'rect';

    if (shape === 'circle') {
      var r = Math.min(n.w, n.h) / 2;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: cx - r * dx / len, y: cy - r * dy / len };
    }

    if (shape === 'diamond') {
      // 菱形四条边：(cx,n.y)→(n.x+n.w,cy)→(cx,n.y+n.h)→(n.x,cy)
      // 参数化：dx≠0 时求斜率线 k=dy/dx 与四条边的交点（取最靠近 from 的那个）
      var halfW = n.w / 2;
      var halfH = n.h / 2;
      // 在相对于 (cx,cy) 的坐标空间内求射线与菱形 |X|/halfW + |Y|/halfH = 1 的交点
      // 方向向量 (dx,dy)，参数 t>0，解 |t*dx|/halfW + |t*dy|/halfH = 1 → t = 1/(|dx|/halfW + |dy|/halfH)
      var denom = Math.abs(dx) / halfW + Math.abs(dy) / halfH;
      if (denom <= 1e-9) return { x: cx, y: cy };
      var t = 1 / denom;
      // 注意：射线方向指向中心，所以从 from → cx,cy，交点在 from 和中心之间 → 取 from + (-dx, -dy) 的反方向... 
      // 实际上我们要沿 from→center 方向、且交点在 center 之前（靠近 from 一侧）：
      // 从 center 反向往 from 走 t·unit 的距离：
      var invLen = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / invLen, uy = dy / invLen;
      return { x: cx - ux * t, y: cy - uy * t };
    }

    // 默认 rect：先看方向决定交于哪条边，再取最大 t（不超出边界的那个）
    // 参数化: X = cx - t*dx, Y = cy - t*dy, t>0。求使得 X ∈ [n.x, n.x+n.w], Y ∈ [n.y, n.y+n.h] 的最小 t 且 |ΔX|≤halfW, |ΔY|≤halfH
    var invLen = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / invLen, uy = dy / invLen;
    var halfW = n.w / 2, halfH = n.h / 2;
    var t = Infinity;
    if (Math.abs(ux) > 1e-9) {
      var tx = halfW / Math.abs(ux);
      if (tx < t) t = tx;
    }
    if (Math.abs(uy) > 1e-9) {
      var ty = halfH / Math.abs(uy);
      if (ty < t) t = ty;
    }
    if (!isFinite(t)) t = 0;
    return { x: cx - ux * t, y: cy - uy * t };
  };

  DiagramEditor.prototype._drawNode = function(n) {
    var ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = n.fill || n.color || '#e0f2fe';
    ctx.strokeStyle = n.borderColor || '#475569';
    ctx.lineWidth = (n.borderWidth == null ? 1.5 : Math.max(0, n.borderWidth)) / this.viewScale;
    var shape = n.shape || 'rect';
    // P1-8：圆角矩形 / 六边形
    if (shape === 'circle') {
      var cx = n.x + n.w / 2, cy = n.y + n.h / 2, r = Math.min(n.w, n.h) / 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      if (ctx.lineWidth > 0) ctx.stroke();
    } else if (shape === 'diamond') {
      var ddx = n.x + n.w / 2, ddy = n.y + n.h / 2;
      ctx.beginPath();
      ctx.moveTo(ddx, n.y); ctx.lineTo(n.x + n.w, ddy); ctx.lineTo(ddx, n.y + n.h); ctx.lineTo(n.x, ddy); ctx.closePath();
      ctx.fill(); if (ctx.lineWidth > 0) ctx.stroke();
    } else if (shape === 'rounded') {
      var rr = Math.min(16, Math.min(n.w, n.h) / 4) / this.viewScale;
      var x = n.x, y = n.y, w = n.w, h = n.h;
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y,     x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x,     y + h, rr);
      ctx.arcTo(x,     y + h, x,     y,     rr);
      ctx.arcTo(x,     y,     x + w, y,     rr);
      ctx.closePath();
      ctx.fill(); if (ctx.lineWidth > 0) ctx.stroke();
    } else if (shape === 'hex') {
      var hx = n.x, hy = n.y, hw = n.w, hh = n.h;
      var v1 = { x: hx + hw * 0.25, y: hy };
      var v2 = { x: hx + hw * 0.75, y: hy };
      var v3 = { x: hx + hw,        y: hy + hh / 2 };
      var v4 = { x: hx + hw * 0.75, y: hy + hh };
      var v5 = { x: hx + hw * 0.25, y: hy + hh };
      var v6 = { x: hx,             y: hy + hh / 2 };
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y); ctx.lineTo(v2.x, v2.y); ctx.lineTo(v3.x, v3.y);
      ctx.lineTo(v4.x, v4.y); ctx.lineTo(v5.x, v5.y); ctx.lineTo(v6.x, v6.y);
      ctx.closePath();
      ctx.fill(); if (ctx.lineWidth > 0) ctx.stroke();
    } else {
      ctx.fillRect(n.x, n.y, n.w, n.h);
      if (ctx.lineWidth > 0) ctx.strokeRect(n.x, n.y, n.w, n.h);
    }
    // 选中描边（高亮）：primary 用青色粗外框，multiSelected 用紫色半透明外框
    var isPrimary = this.selected && this.selected.type === 'node' && this.selected.id === n.id;
    var inMulti = this.multiSelected && this.multiSelected.indexOf(n.id) >= 0;
    if (isPrimary || inMulti) {
      var pad = 3 / this.viewScale;
      ctx.save();
      ctx.strokeStyle = isPrimary ? '#06b6d4' : '#8b5cf6';
      ctx.lineWidth = (isPrimary ? 2.4 : 1.6) / this.viewScale;
      ctx.setLineDash(isPrimary ? [] : [5 / this.viewScale, 3 / this.viewScale]);
      ctx.strokeRect(n.x - pad, n.y - pad, n.w + pad * 2, n.h + pad * 2);
      ctx.restore();
    }
    ctx.fillStyle = n.fontColor || '#1f2937';
    var fs = (n.fontSize && n.fontSize > 0) ? Number(n.fontSize) : 14;
    ctx.font = (fs / this.viewScale) + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this._wrapText(ctx, n.text || '', n.x + n.w / 2, n.y + n.h / 2, n.w - 8, 16 / this.viewScale);
    ctx.restore();
  };

  DiagramEditor.prototype._wrapText = function(ctx, text, cx, cy, maxW, lh) {
    if (!text) return;
    var chars = String(text).split('');
    var line = '', lines = [];
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = chars[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    if (lines.length > 3) { lines = lines.slice(0, 3); lines[2] = lines[2].slice(0, -1) + '…'; }
    var startY = cy - (lines.length - 1) * lh / 2;
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], cx, startY + j * lh);
  };

  DiagramEditor.prototype._drawEdge = function(e) {
    var a = this._node(e.from), b = this._node(e.to);
    if (!a || !b) return;
    var ctx = this.ctx;
    var axc = a.x + a.w / 2, ayc = a.y + a.h / 2;
    var bxc = b.x + b.w / 2, byc = b.y + b.h / 2;

    // 2026-08-16 P1-7：起终点用「节点边界交点」，避免连线/箭头被节点填充遮挡
    var start = this._nodeBoundaryIntersect(a, bxc, byc); // 从 b 中心向 a 中心方向，取 a 边界交点
    var end   = this._nodeBoundaryIntersect(b, axc, ayc); // 从 a 中心向 b 中心方向，取 b 边界交点
    var x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y;

    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var cx = mx + nx * (e.curve || 0), cy = my + ny * (e.curve || 0);

    ctx.save();
    var lineColor = e.color || '#2b2b2b';
    ctx.strokeStyle = lineColor;
    ctx.fillStyle = lineColor;
    ctx.lineWidth = 2 / this.viewScale;
    ctx.lineCap = 'round';

    // 连线主体
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.stroke();

    // 末端箭头（实心大三角 + 描边，指向性极强，紧挨着目标节点）
    var ang = Math.atan2(y2 - cy, x2 - cx); // 终点处切线方向
    var ah = 13 / this.viewScale;           // 箭头大小
    var aw = 8 / this.viewScale;            // 箭头半宽（等价于角度）
    // 提前 1.5px 结束，保证箭头不被节点填充覆盖
    var px = x2 - 1.5 / this.viewScale * Math.cos(ang);
    var py = y2 - 1.5 / this.viewScale * Math.sin(ang);
    var back1x = px - ah * Math.cos(ang) + aw * Math.cos(ang - Math.PI / 2);
    var back1y = py - ah * Math.sin(ang) + aw * Math.sin(ang - Math.PI / 2);
    var back2x = px - ah * Math.cos(ang) - aw * Math.cos(ang - Math.PI / 2);
    var back2y = py - ah * Math.sin(ang) - aw * Math.sin(ang - Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(back1x, back1y);
    ctx.lineTo(back2x, back2y);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1 / this.viewScale;
    ctx.strokeStyle = '#fff';
    ctx.stroke();

    // 中段方向指示：再放一个较小的半透明箭头（沿曲线约 60% 位置），用户远距离就能判断流向
    try {
      // 二次贝塞尔点：B(t) = (1-t)^2*P0 + 2(1-t)t*P1 + t^2*P2，B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1)
      var mt = 0.6;
      var omt = 1 - mt;
      var midX = omt * omt * x1 + 2 * omt * mt * cx + mt * mt * x2;
      var midY = omt * omt * y1 + 2 * omt * mt * cy + mt * mt * y2;
      var ddx = 2 * omt * (cx - x1) + 2 * mt * (x2 - cx);
      var ddy = 2 * omt * (cy - y1) + 2 * mt * (y2 - cy);
      var mang = Math.atan2(ddy, ddx);
      var mah = 7 / this.viewScale;
      var maw = 4.5 / this.viewScale;
      var mpx = midX, mpy = midY;
      var m1x = mpx - mah * Math.cos(mang) + maw * Math.cos(mang - Math.PI / 2);
      var m1y = mpy - mah * Math.sin(mang) + maw * Math.sin(mang - Math.PI / 2);
      var m2x = mpx - mah * Math.cos(mang) - maw * Math.cos(mang - Math.PI / 2);
      var m2y = mpy - mah * Math.sin(mang) - maw * Math.sin(mang - Math.PI / 2);
      ctx.fillStyle = lineColor;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(mpx, mpy);
      ctx.lineTo(m1x, m1y);
      ctx.lineTo(m2x, m2y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    } catch (err1) { /* ignore */ }

    // 标签（在曲线控制点上方，白底+细描边，和箭头不重叠）
    if (e.label) {
      ctx.font = (12 / this.viewScale) + 'px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var tx = cx, ty = cy - 12 / this.viewScale;
      var tw = ctx.measureText(e.label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      var padX = 6 / this.viewScale, padY = 4 / this.viewScale;
      var boxW = tw + padX * 2, boxH = 16 / this.viewScale;
      ctx.fillRect(tx - boxW / 2, ty - boxH / 2, boxW, boxH);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1 / this.viewScale;
      ctx.strokeRect(tx - boxW / 2, ty - boxH / 2, boxW, boxH);
      ctx.fillStyle = lineColor;
      ctx.fillText(e.label, tx, ty);
    }
    ctx.restore();
  };

  DiagramEditor.prototype._strokeEdge = function(e) {
    var a = this._node(e.from), b = this._node(e.to);
    if (!a || !b) return;
    var ctx = this.ctx;
    var axc = a.x + a.w / 2, ayc = a.y + a.h / 2;
    var bxc = b.x + b.w / 2, byc = b.y + b.h / 2;
    var start = this._nodeBoundaryIntersect(a, bxc, byc);
    var end   = this._nodeBoundaryIntersect(b, axc, ayc);
    var x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y;
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var cx = mx + nx * (e.curve || 0), cy = my + ny * (e.curve || 0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.stroke();
  };

  // ============================================================
  // 公开接口
  // ============================================================
  return {
    init: init,
    loadOrCreateNotebook: loadOrCreateNotebook,
    ensurePageForPdfPage: ensurePageForPdfPage,
    renderPage: renderPage,
    getPageBlocks: getPageBlocks,
    getPageMd: getPageMd,
    getCurrentPage: getCurrentPage,
    createNewBlock: createNewBlock,
    createBlock: createBlock,
    createPage: createPage,
    createNotebook: createNotebook,
    // Task 11+12: 编辑、双模输入、Operation 队列、并发编辑
    detectInputType: detectInputType,
    applyOperation: applyOperation,
    lockBlocks: lockBlocks,
    unlockBlocks: unlockBlocks,
    getSelection: getSelection,
    onBlockChange: onBlockChange,
    // Task 13: PDF 引用插入 + 块搜索
    insertPdfRef: insertPdfRef,
    searchBlocks: searchBlocks,
    // Task 14: 辅助查询接口
    getNotebook: getNotebook,
    getCurrentPageId: getCurrentPageId,
    // 增强：指令生命周期管理
    hasCommandEndMarker: hasCommandEndMarker,
    stripCommandEndMarker: stripCommandEndMarker,
    renderMarkdown: renderMarkdown,
    markCommandPending: markCommandPending,
    markCommandComplete: markCommandComplete,
    createAiPlaceholder: createAiPlaceholder,
    updateAiPlaceholder: updateAiPlaceholder,
    finalizeAiPlaceholder: finalizeAiPlaceholder,
    finalizeAiPlaceholderAsText: finalizeAiPlaceholderAsText,
    getCommandText: getCommandText,
    // Issue 3: 页面命名 + 目录系统
    setPageName: setPageName,
    renderNotebookTOC: renderNotebookTOC,
    toggleNotebookTOC: toggleNotebookTOC,
    generatePageDirectory: generatePageDirectory,
    togglePageDirectory: togglePageDirectory,
    // 多笔记管理：按 ID 加载/删除/移动页面/清空
    loadNotebookById: loadNotebookById,
    deletePage: deletePage,
    movePageBefore: movePageBefore,
    clearActiveNotebook: clearActiveNotebook,
    // 活页目录管理（v140+）：新建/批量删除/排序/按 PDF 页码定位
    addPage: addPage,
    batchDeletePages: batchDeletePages,
    movePageToEnd: movePageToEnd,
    findPageByPdfNum: findPageByPdfNum,
    getPageByPdfNum: findPageByPdfNum,
    // 空态时「立即新建笔记」按钮的处理函数注册
    setEmptyCreateHandler: setEmptyCreateHandler,
    // Issue 6: 字体样式管理
    applyFontStyle: applyFontStyle,
    resetFontStyle: resetFontStyle,
    // 多块选中与合并（连续文档）
    toggleSelectBlock: _toggleSelectBlock,
    clearSelection: clearSelection,
    getSelectedBlockIds: getSelectedBlockIds,
    mergeSelectedBlocks: mergeSelectedBlocks,
    deleteBlock: deleteBlock,
    // 块排序（拖拽 + 上下移动）
    moveBlock: moveBlock,
    // 撤销 / 重做
    undo: undo,
    redo: redo,
    onUndoChange: onUndoChange,
    // MD 双模式编辑
    toggleMdMode: toggleMdMode,
    ensureMdToolbar: _ensureMdToolbar,
    updateToolbarState: _updateToolbarState,
    // P7 打印导出
    printPdf: printPdf,
    // P5 书签系统
    renderBookmarks: renderBookmarks,
    toggleBookmark: toggleBookmark,
    toggleBookmarkPanel: toggleBookmarkPanel,
    deleteBookmark: deleteBookmark,
    acceptBookmark: acceptBookmark,
    // 2026-08-15 策略审批弹窗（队列卡片「查看&审批策略」按钮入口）
    openApprovalModal: openApprovalModal,
    // 2026-08-15 P1 修复：让 AIEngine 写 DataLayer 后同步内存 page.mdContent
    syncPageMd: syncPageMd,
    /**
     * 2026-08-16：AI 直接编辑笔记的统一入口（纯 Markdown，无 Block 概念）。
     * 写入流程：DataLayer.putPageMd → 内存 page.mdContent → CodeMirror/预览态 → 重渲染
     * 返回 Promise，完成后内容即在 UI 上可见。
     */
    setPageMd: async function(pageId, newMd) {
      if (!pageId) throw new Error('setPageMd: pageId 必填');
      newMd = (newMd == null) ? '' : String(newMd);
      var page = _findPageById(pageId);
      if (!page) throw new Error('setPageMd: 页面不存在 ' + pageId);
      // 1) 落盘
      if (typeof DataLayer !== 'undefined' && DataLayer.putPageMd) {
        await DataLayer.putPageMd(pageId, newMd);
      }
      // 2) 内存同步（syncPageMd 内部还会尝试同步 CodeMirror 的 DOM 实例）
      syncPageMd(pageId, newMd);
      // 3) 如果用户当前就在 CodeMirror 源码编辑态，直接把内容注入到编辑器，避免"内存已更新但编辑器显示旧内容"
      if (mdModeActive && cmView && cmViewPageId === pageId) {
        try {
          var curDoc = cmView.state.doc.toString();
          if (curDoc !== newMd) {
            cmView.dispatch({ changes: { from: 0, to: curDoc.length, insert: newMd } });
          }
        } catch (e) {}
      }
      // 4) 触发重渲染（预览态）
      try { await renderPage(pageId); } catch (_) {}
      return true;
    },
    /**
     * 获取当前笔记页的 Markdown 原文（优先读内存，兜底读存储）
     */
    getPageMdDirect: function(pageId) {
      var pid = pageId || getCurrentPageId();
      if (!pid) return '';
      var page = _findPageById(pid);
      var md = page ? (page.mdContent || '') : '';
      // 编辑态下优先取编辑器里的实时内容（避免"刚输入的内容 AI 读不到"）
      if (mdModeActive && cmView && cmViewPageId === pid) {
        try { md = cmView.state.doc.toString(); } catch (e) {}
      }
      return md;
    },
    // 2026-08-15 扩展：HTML 代码块沙盒 iframe + 流程图 Canvas 编辑器
    createDiagramRef: createDiagramRef,
    initDiagramBlocks: function(container, reset) { _initDiagramBlocks(container, reset); },
    saveDiagram: saveDiagram,
    loadDiagram: loadDiagram,
    // 2026-08-16：HTML 独立存储 + @[html:ID] 占位符（解决 MD↔预览 切换时 HTML 语法冲突）
    saveHtml: saveHtml,
    loadHtml: loadHtml,
    deleteHtml: deleteHtml,
    createHtmlRef: createHtmlRef,
    // 2026-08-18：附件空间思维导图/流程图内嵌编辑器（双向同步：编辑→localStorage→附件Blob+笔记刷新）
    createAttachmentDiagramEditor: function(containerEl, data, opts) {
      if (!containerEl) return null;
      opts = opts || {};
      var diagramId = opts.diagramId || _generateDiagramId();
      // 2026-08-19 修复：优先保留 localStorage 中的最新数据（笔记真源），附件 JSON 只是镜像快照。
      // 此前无条件用附件数据覆盖 localStorage——若附件是旧快照/空数据，返回笔记后块读到空数据渲染空白。
      var existing = loadDiagram(diagramId);
      if (existing) {
        data = existing;
      } else {
        try { localStorage.setItem('shuchongu_diagram_' + diagramId, JSON.stringify(data || { nodes: [], edges: [] })); } catch (e) {}
      }
      containerEl.innerHTML = '';
      var blockEl = document.createElement('div');
      blockEl.className = 'diagram-block';
      blockEl.setAttribute('data-diagram-id', diagramId);
      blockEl.setAttribute('contenteditable', 'false');
      blockEl.style.position = 'relative';
      containerEl.appendChild(blockEl);
      var editor = null;
      try { editor = new DiagramEditor(blockEl); } catch (e) { console.warn('附件流程图编辑器初始化失败:', e); return null; }
      // 附件场景去掉「AI改进/删除」操作条（那是笔记预览块的能力）
      try {
        var actBar = blockEl.querySelector(':scope > .block-action-bar.diagram-action-bar');
        if (actBar) actBar.remove();
      } catch (e) {}
      // 包装保存：原逻辑写 localStorage → onSave 更新附件源文件 → 刷新笔记中同 id 流程图
      var origPersist = editor._persist.bind(editor);
      editor._persist = function() {
        try { origPersist(); } catch (e) {}
        try { if (typeof opts.onSave === 'function') opts.onSave(diagramId, editor.data || { nodes: [], edges: [] }); } catch (e) {}
        try { _refreshDiagramAfterAttachEdit(diagramId); } catch (e) {}
        try { if (editor._flash) editor._flash('已保存 · 笔记与附件已同步'); } catch (e) {}
      };
      editor.attachDiagramId = diagramId;
      return editor;
    },
    // 2026-08-18：导出当前笔记页为图片（png/jpeg），所见即所得
    exportPageAsImage: async function(pageId, format) {
      try {
        var canvas = await _buildExportCanvas(pageId);
        var fmt = (format === 'jpeg' || format === 'jpg') ? 'jpeg' : 'png';
        var dataUrl = canvas.toDataURL('image/' + fmt, 0.95);
        var a = document.createElement('a');
        a.href = dataUrl;
        a.download = '笔记_' + String(pageId || 'page').slice(-8) + '.' + fmt;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() { a.remove(); }, 200);
      } catch (e) { alert('导出图片失败：' + (e && e.message ? e.message : e) + _exportDiagSuffix()); }
    },
    // 2026-08-18：导出当前笔记页为 PDF（A4 分页），所见即所得
    exportPageAsPdf: async function(pageId) {
      try {
        if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) throw new Error('jsPDF 未加载');
        var canvas = await _buildExportCanvas(pageId);
        var pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
        var pw = pdf.internal.pageSize.getWidth();
        var ph = pdf.internal.pageSize.getHeight();
        var imgH = canvas.height * pw / canvas.width;
        var pages = Math.max(1, Math.ceil(imgH / ph - 0.001));
        for (var i = 0; i < pages; i++) {
          if (i > 0) pdf.addPage();
          var sliceTop = Math.round(i * ph * canvas.width / pw);
          var sliceHpx = Math.round(Math.min(ph, imgH - i * ph) * canvas.width / pw);
          var tmp = document.createElement('canvas');
          tmp.width = canvas.width;
          tmp.height = Math.max(1, sliceHpx);
          var tctx = tmp.getContext('2d');
          tctx.drawImage(canvas, 0, sliceTop, canvas.width, sliceHpx, 0, 0, canvas.width, sliceHpx);
          pdf.addImage(tmp.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, Math.min(ph, imgH - i * ph));
        }
        pdf.save('笔记_' + String(pageId || 'page').slice(-8) + '.pdf');
      } catch (e) { alert('导出 PDF 失败：' + (e && e.message ? e.message : e) + _exportDiagSuffix()); }
    },
    // 开始工具栏
    toggleHomeToolbar: _toggleHomeToolbar,
    execFormat: _execFormat,
    // P2：参考资料 → 写入当前笔记页（追加 MD，标题+内容，走 DataLayer + syncPageMd）
    insertReferenceIntoCurrentPage: function(mat, mdText) {
      var page = getCurrentPage();
      if (!page) { alert('当前还没有打开的笔记页'); return false; }
      var header = '\n\n---\n\n## 📚 参考资料：' + (mat && mat.name ? mat.name : '未命名') + '\n\n';
      var footer = '\n> _来源：参考材料 ID `' + (mat && mat.id ? mat.id : '-') + '`，解析器：`' + (mat && mat.parser ? mat.parser : '-') + '`_\n';
      var append = header + String(mdText || '').trim() + footer;
      var newMd = (page.mdContent || '') + append;
      if (typeof DataLayer !== 'undefined' && DataLayer.putPageMd) DataLayer.putPageMd(page.id, newMd);
      syncPageMd(page.id, newMd);
      if (mdModeActive) {
        try { renderPage(page.id); } catch (_) {}
      } else {
        try { renderPage(page.id); } catch (_) {}
      }
      return true;
    }
  };
})();
window.Notebook = Notebook;
