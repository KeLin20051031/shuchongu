// Data Layer 模块 — IndexedDB 封装
const DataLayer = (function() {
  const DB_NAME = 'BookwormDB';
  const DB_VERSION = 5;
  let db = null;
  let _initPromise = null;   // init 幂等：同一 Promise 复用，避免并发重复 open
  let _upgradeInfo = null;   // 记录最近一次 DB 升级信息（oldVersion → newVersion）

  // Object Store 定义（v4：新增 commands / referenceMats，其余全部保留）
  const STORES = {
    books:      { keyPath: 'id', indexes: [] },
    bookblobs:  { keyPath: 'id', indexes: [] },
    pdfs:       { keyPath: 'id', indexes: [] },
    notebooks:  { keyPath: 'id', indexes: [{ name: 'by_pdfId', keyPath: 'pdfId' }] },
    pages:      { keyPath: 'id', indexes: [{ name: 'by_notebookId', keyPath: 'notebookId' }, { name: 'by_pdfPageNum', keyPath: 'pdfPageNum' }] },
    blocks:     { keyPath: 'id', indexes: [{ name: 'by_pageId', keyPath: 'pageId' }] },
    settings:   { keyPath: 'id', indexes: [] },
    skills:     { keyPath: 'id', indexes: [] },
    annotations: { keyPath: 'id', indexes: [] },   // AI 划重点：每本书一份 { id: bookId, pages: { pageNum: [ann] } }
    commands:  { keyPath: 'id', indexes: [{ name: 'by_status', keyPath: 'status' }, { name: 'by_pageId', keyPath: 'pageId' }] },   // v4：、、指令。。 FIFO 待办队列
    referenceMats: { keyPath: 'id', indexes: [{ name: 'by_bookId', keyPath: 'bookId' }] },   // v4：每本书专属参考材料 MD
    attachments: { keyPath: 'id', indexes: [{ name: 'by_bookId', keyPath: 'bookId' }, { name: 'by_parentId', keyPath: 'parentId' }] }   // v5：附件管理（文件树+Blob）
  };

  function _friendlyStorageError(detail) {
    var online = (typeof location !== 'undefined') && location.protocol === 'https:';
    var tail = online
      ? '请使用最新版 Chrome / Edge / Firefox，并确认浏览器未禁用本地存储（IndexedDB），且未处于无痕模式。'
      : '如果你是直接双击 HTML 文件打开（file:// 协议），部分浏览器会禁用本地存储。' +
        '请改用本地服务器打开：在该目录运行 `python -m http.server` 后访问 http://127.0.0.1:8000/index.html，' +
        '或使用 Chrome / Edge / Firefox 桌面版。';
    return '本地数据存储不可用（IndexedDB 未能打开）' +
      (detail ? '：' + detail : '') +
      '。' + tail;
  }

  function _open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error(_friendlyStorageError('当前环境未提供 IndexedDB')));
        return;
      }
      // 关键修复：部分浏览器在 file:// 协议下调用 indexedDB.open 会「永久挂起」
      // （onsuccess/onerror 都不触发），导致 init 永不 settle、导入静默无反应。
      // 这里用一个超时兜底：超过阈值即视为存储不可用并给出明确错误。
      let settled = false;
      const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(_friendlyStorageError('打开本地数据库超时（疑似 file:// 协议禁用本地存储，或浏览器策略限制）'))));
      }, 3500);
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        finish(() => reject(new Error(_friendlyStorageError(e && e.message ? e.message : '打开请求抛出异常'))));
        return;
      }
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        const tx = e.target.transaction;
        const oldVersion = e.oldVersion || 0;
        // 确保所有 store 与其索引都存在：store 不存在则创建，已存在则补建缺失索引，
        // 从而旧库（v3 及更早）升级到 v4 时能平滑补齐索引，数据不丢失。
        for (const [storeName, config] of Object.entries(STORES)) {
          let store;
          if (!database.objectStoreNames.contains(storeName)) {
            store = database.createObjectStore(storeName, { keyPath: config.keyPath });
          } else {
            store = tx.objectStore(storeName);
          }
          config.indexes.forEach(idx => {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, { unique: false });
            }
          });
        }
        // 版本号判断：记录升级路径（oldVersion → DB_VERSION），供迁移逻辑与诊断使用
        _upgradeInfo = { oldVersion: oldVersion, newVersion: DB_VERSION, upgradedAt: Date.now() };
        // 将 schema 版本写入 settings（若 settings store 存在；极旧库可能缺失，忽略失败）
        try {
          if (tx && tx.objectStoreNames && tx.objectStoreNames.contains('settings')) {
            tx.objectStore('settings').put({ id: '__schema__', dbVersion: DB_VERSION, oldVersion: oldVersion, upgradedAt: Date.now() });
          }
        } catch (err) { /* settings 不存在时忽略 */ }
      };
      req.onsuccess = (e) => finish(() => { db = e.target.result; resolve(); });
      req.onerror = (e) => finish(() => reject(new Error(_friendlyStorageError((e.target && e.target.error && e.target.error.message) || '打开失败'))));
      req.onblocked = () => finish(() => reject(new Error('本地数据库被其他标签页占用，无法升级。请关闭其他正在打开本书虫蛊的页面后重试。')));
    });
  }

  // 初始化（幂等）：多次调用共享同一 Promise，避免并发重复 open
  function init() {
    if (!_initPromise) _initPromise = _open();
    return _initPromise;
  }

  // 确保所有读写操作前数据库已就绪：db 已建好则直接 resolve，否则等待 init 完成（或失败）
  function ensure() {
    if (db) return Promise.resolve();
    return init();
  }

  function _tx(storeName, mode) {
    if (!db) {
      throw new Error(_friendlyStorageError('数据库尚未就绪'));
    }
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function get(storeName, key) {
    return ensure().then(() => new Promise((resolve, reject) => {
      const req = _tx(storeName, 'readonly').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function getAll(storeName) {
    return ensure().then(() => new Promise((resolve, reject) => {
      const req = _tx(storeName, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function put(storeName, data) {
    return ensure().then(() => new Promise((resolve, reject) => {
      const req = _tx(storeName, 'readwrite').put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function delete_(storeName, key) {
    return ensure().then(() => new Promise((resolve, reject) => {
      const req = _tx(storeName, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function query(storeName, indexName, value) {
    return ensure().then(() => new Promise((resolve, reject) => {
      const store = _tx(storeName, 'readonly');
      const idx = store.index(indexName);
      const req = idx.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  // ============================================================
  // 笔记栏 v2：blocks → Markdown 原文 序列化（纯函数）
  // 迁移映射规则（向后兼容，只读 blocks，不改写 block 数据）：
  //   text(aiGenerated=false) → 原样作为段落
  //   text(aiGenerated=true)  → 直接拼入（content 已是 Markdown）
  //   ai-result               → 直接拼入（content 已是 Markdown）
  //   heading                 → '# ' + content
  //   quote                   → content 每行加 '> ' 前缀
  //   pdf-ref                 → '> ' + content + ' （P.<pageNum>）'（无 pageNum 则不加）
  //   ai-placeholder          → lock=false 且 content 非空则同 ai-result 拼入，否则丢弃
  //   command / focus         → 丢弃（指令非笔记正文）
  //   块间用空行（\n\n）分隔，空内容块跳过
  // ============================================================
  function blocksToMarkdown(blocks) {
    if (!Array.isArray(blocks)) return '';
    var parts = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || !b.type) continue;
      var type = b.type;
      var content = (b.content == null) ? '' : String(b.content);
      var md = null;

      switch (type) {
        case 'text':
        case 'ai-result':
          md = content; // 普通文本原样保留；AI 块 content 已是 Markdown，直接拼入
          break;
        case 'heading':
          if (!content.trim()) continue;
          md = '# ' + content;
          break;
        case 'quote':
          if (!content.trim()) continue;
          md = content.replace(/\r\n/g, '\n').split('\n').map(function(line) {
            return '> ' + line;
          }).join('\n');
          break;
        case 'pdf-ref':
          if (!content.trim()) continue;
          md = '> ' + content + ((b.pdfRef && b.pdfRef.pageNum != null) ? ' （P.' + b.pdfRef.pageNum + '）' : '');
          break;
        case 'ai-placeholder':
          if (b.lock === false && content.trim()) md = content; // 已完成且非空才拼入，否则丢弃
          break;
        case 'command':
        case 'focus':
          break; // 指令非笔记正文，丢弃
        default:
          md = content; // 未知类型保守保留为纯文本，避免丢内容
          break;
      }

      if (md == null) continue;
      var trimmed = String(md).trim();
      if (!trimmed) continue;
      parts.push(md);
    }
    return parts.join('\n\n');
  }

  // 将一页所有 blocks 合并为 Markdown 原文并写回 page.mdContent。
  // 惰性迁移（蓝图 §3.3）：默认仅在 mdContent 为空且存在 blocks 数据时才迁移；
  // 迁移后保留 blocks 字段（数据不丢、可回滚），仅标记 blocksDeprecated=true。
  async function migratePageToMd(pageId, opts) {
    opts = opts || {};
    if (!pageId) return '';
    var page = await get('pages', pageId);
    if (!page) return ''; // 页面不存在
    var hasMd = (page.mdContent != null && String(page.mdContent).length > 0);
    if (!opts.force && hasMd) return page.mdContent; // 已迁移/已有正文，避免覆盖用户编辑
    var blocks = await query('blocks', 'by_pageId', pageId);
    if (!blocks.length) return page.mdContent || '';
    blocks.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
    var md = blocksToMarkdown(blocks);
    page.mdContent = md;
    page.blocksDeprecated = true; // 标记旧 blocks 弃用，blocks 数据保留可回滚
    page.updatedAt = Date.now();
    await put('pages', page);
    return md;
  }

  // 批量惰性迁移：遍历全部 pages，对「mdContent 为空且存在 blocks」的页执行迁移。
  // 返回统计 { total, migrated, skipped, failed }；blocks 数据保留，不丢失。
  async function migrateAllPages() {
    var pages = await getAll('pages');
    var stats = { total: pages.length, migrated: 0, skipped: 0, failed: 0 };
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (!p || !p.id) { stats.skipped++; continue; }
      try {
        var hasMd = (p.mdContent != null && String(p.mdContent).length > 0);
        if (hasMd) { stats.skipped++; continue; }
        var blocks = await query('blocks', 'by_pageId', p.id);
        if (!blocks.length) { stats.skipped++; continue; }
        await migratePageToMd(p.id, { force: true });
        stats.migrated++;
      } catch (e) {
        stats.failed++;
      }
    }
    return stats;
  }

  // 升级信息 / 版本号（供诊断与迁移判断）
  function getUpgradeInfo() { return _upgradeInfo; }
  function getSchemaVersion() { return DB_VERSION; }

  // ============================================================
  // v4 接口契约：mdContent 读写 / commands 队列 / 书签 / 参考材料
  // （蓝图 §10，P0 落地最小可用实现，供 command-queue / reference-manager 调用）
  // ============================================================

  // 写 mdContent（保留页面其它字段，刷新 updatedAt）
  async function putPageMd(pageId, mdContent) {
    if (!pageId) throw new Error('putPageMd 需要 pageId');
    const page = await get('pages', pageId);
    if (!page) throw new Error('页面不存在：' + pageId);
    page.mdContent = (mdContent == null) ? '' : String(mdContent);
    page.updatedAt = Date.now();
    await put('pages', page);
    return page;
  }

  // 读 mdContent
  async function getPageMd(pageId) {
    const page = await get('pages', pageId);
    return page ? (page.mdContent || '') : '';
  }

  // 写入一条指令待办（补默认 status/createdAt）
  async function putCommand(cmd) {
    if (!cmd || !cmd.id) throw new Error('putCommand 需要 cmd.id');
    if (!cmd.status) cmd.status = 'pending';
    if (!cmd.createdAt) cmd.createdAt = Date.now();
    await put('commands', cmd);
    return cmd;
  }

  // 列出 pending 指令（按 createdAt 升序，即 FIFO 顺序）
  async function listPendingCommands() {
    const list = await query('commands', 'by_status', 'pending');
    list.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    return list;
  }

  // 取队首 pending 指令并置为 processing（供调度器使用）
  async function dequeueNextCommand() {
    const pending = await listPendingCommands();
    if (!pending.length) return null;
    const cmd = pending[0];
    cmd.status = 'processing';
    await put('commands', cmd);
    return cmd;
  }

  // 追加一条 AI 成果书签到页面（内嵌 page.aiBookmarks，不污染 mdContent）
  async function putBookmark(pageId, bm) {
    const page = await get('pages', pageId);
    if (!page) throw new Error('页面不存在：' + pageId);
    if (!Array.isArray(page.aiBookmarks)) page.aiBookmarks = [];
    if (bm && !bm.id) bm.id = 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (bm) {
      if (bm.collapsed !== false) bm.collapsed = true; // 默认收起
      page.aiBookmarks.push(bm);
    }
    page.updatedAt = Date.now();
    await put('pages', page);
    return page;
  }

  // 列出页面全部书签
  async function listBookmarks(pageId) {
    const page = await get('pages', pageId);
    return (page && Array.isArray(page.aiBookmarks)) ? page.aiBookmarks : [];
  }

  // 写入参考材料
  async function putReferenceMat(mat) {
    if (!mat || !mat.id) throw new Error('putReferenceMat 需要 mat.id');
    if (!mat.createdAt) mat.createdAt = Date.now();
    await put('referenceMats', mat);
    return mat;
  }

  // 按 bookId 列出参考材料（createdAt 升序）
  async function getReferenceByBook(bookId) {
    const list = await query('referenceMats', 'by_bookId', bookId);
    list.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    return list;
  }

  // 删除参考材料
  async function deleteReferenceMat(id) {
    await delete_('referenceMats', id);
  }

  // ============================================================
  // v4 完整 CRUD：commands 队列 / referenceMats / aiBookmarks 内嵌
  // ============================================================

  // ---- commands 完整 CRUD ----
  async function getCommand(id) { return get('commands', id); }
  async function listCommands() { return getAll('commands'); }
  async function listCommandsByPage(pageId) { return query('commands', 'by_pageId', pageId); }
  async function updateCommand(cmd) {
    if (!cmd || !cmd.id) throw new Error('updateCommand 需要 cmd.id');
    await put('commands', cmd);
    return cmd;
  }
  async function updateCommandStatus(id, status, patch) {
    var cmd = await get('commands', id);
    if (!cmd) throw new Error('指令不存在：' + id);
    cmd.status = status;
    if (patch) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) cmd[k] = patch[k];
      }
    }
    if (status === 'done' && !cmd.doneAt) cmd.doneAt = Date.now();
    await put('commands', cmd);
    return cmd;
  }
  async function deleteCommand(id) { await delete_('commands', id); }

  // ---- referenceMats 完整 CRUD ----
  async function getReferenceMat(id) { return get('referenceMats', id); }

  // ---- aiBookmarks（内嵌 page.aiBookmarks）----
  async function getBookmark(pageId, bookmarkId) {
    var page = await get('pages', pageId);
    if (!page || !Array.isArray(page.aiBookmarks)) return null;
    for (var i = 0; i < page.aiBookmarks.length; i++) {
      if (page.aiBookmarks[i].id === bookmarkId) return page.aiBookmarks[i];
    }
    return null;
  }
  async function removeBookmark(pageId, bookmarkId) {
    var page = await get('pages', pageId);
    if (!page || !Array.isArray(page.aiBookmarks)) return page;
    page.aiBookmarks = page.aiBookmarks.filter(function(b) { return b.id !== bookmarkId; });
    page.updatedAt = Date.now();
    await put('pages', page);
    return page;
  }
  async function updateBookmark(pageId, bookmarkId, patch) {
    var page = await get('pages', pageId);
    if (!page || !Array.isArray(page.aiBookmarks)) return null;
    var bm = null;
    for (var i = 0; i < page.aiBookmarks.length; i++) {
      if (page.aiBookmarks[i].id === bookmarkId) { bm = page.aiBookmarks[i]; break; }
    }
    if (!bm) return null;
    if (patch) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) bm[k] = patch[k];
      }
    }
    page.updatedAt = Date.now();
    await put('pages', page);
    return bm;
  }

  return {
    init: init,
    get: get,
    getAll: getAll,
    put: put,
    delete: delete_,
    query: query,
    blocksToMarkdown: blocksToMarkdown,
    migratePageToMd: migratePageToMd,
    migrateAllPages: migrateAllPages,
    getUpgradeInfo: getUpgradeInfo,
    getSchemaVersion: getSchemaVersion,
    putPageMd: putPageMd,
    getPageMd: getPageMd,
    putCommand: putCommand,
    listPendingCommands: listPendingCommands,
    dequeueNextCommand: dequeueNextCommand,
    getCommand: getCommand,
    listCommands: listCommands,
    listCommandsByPage: listCommandsByPage,
    updateCommand: updateCommand,
    updateCommandStatus: updateCommandStatus,
    deleteCommand: deleteCommand,
    putBookmark: putBookmark,
    listBookmarks: listBookmarks,
    getBookmark: getBookmark,
    removeBookmark: removeBookmark,
    updateBookmark: updateBookmark,
    putReferenceMat: putReferenceMat,
    getReferenceByBook: getReferenceByBook,
    getReferenceMat: getReferenceMat,
    deleteReferenceMat: deleteReferenceMat,
    get db() { return db; }
  };
})();
window.DataLayer = DataLayer;
