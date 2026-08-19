// Command Queue 模块 — 指令检测 + FIFO 待办队列（v3.1 统一策略流 + 自定义分隔符）
// 蓝图 §5.1 / §10：解析 mdContent 中 <open>...<close> 标记 → 写入 commands store → FIFO 队列 + 绿色 UI
const CommandQueue = (function() {
  let _running = false;
  let _pollTimer = null;       // 常驻轮询调度器句柄（startScheduler 设置）
  const _statusListeners = [];
  const _statusCache = {};   // raw -> 最新状态（供胶囊渲染同步查询）
  let _uiReady = false;      // UI 是否已初始化

  // ============================================================
  // 2026-08-15 新增：自定义指令前后符号（默认 [、、、 /、 @ai ] × [。。、 ...、 。。。]）
  // 用户可选比如 【 】 《 》 {{ }} 等任意 pair，持久化 localStorage
  // 统一数组格式：{ open: string[], close: string[] }，兼容输入时的单字符串（自动转为数组）
  // ============================================================
  const _DELIM_STORAGE_KEY = 'shuchongu_cmd_delimiters_v1';
  const _DEFAULT_DELIMITERS = {
    open:  ['/', '@ai ', '↺', '、、'],
    close: ['。。', '...', '。。。']
  };
  let _delimiters = null;   // 懒加载，首次 getDelimiters() 时从 localStorage 读

  function _toArr(v) {
    if (v === null || v === undefined) return [];
    if (Array.isArray(v)) return v.filter(function(x) { return typeof x === 'string' && x.length > 0; });
    if (typeof v === 'string') return v.length > 0 ? [v] : [];
    return [];
  }
  function _normDelims(o) {
    var open  = _toArr(o && o.open);
    var close = _toArr(o && o.close);
    // 空数组兜底默认值（避免完全没符号 → 完全检测不到）
    if (!open.length)  open  = _DEFAULT_DELIMITERS.open.slice();
    if (!close.length) close = _DEFAULT_DELIMITERS.close.slice();
    return { open: open, close: close };
  }
  function _loadDelimiters() {
    if (_delimiters) return _delimiters;
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem(_DELIM_STORAGE_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && (o.open !== undefined || o.close !== undefined)) {
            _delimiters = _normDelims(o);
            return _delimiters;
          }
        }
      }
    } catch (e) {}
    _delimiters = { open: _DEFAULT_DELIMITERS.open.slice(), close: _DEFAULT_DELIMITERS.close.slice() };
    return _delimiters;
  }
  function getDelimiters() { return _loadDelimiters(); }
  function setDelimiters(open, close) {
    // 支持两种调用：setDelimiters('、、', '。。') 或 setDelimiters(['、、','/'], ['。。'])
    var openArr  = _toArr(open);
    var closeArr = _toArr(close);
    if (!openArr.length)  throw new Error('setDelimiters: 开头符号不能为空');
    if (!closeArr.length) throw new Error('setDelimiters: 结尾符号不能为空');
    // 校验：任意开头与结尾若相同 → 拒绝（避免死匹配空串）
    for (var i = 0; i < openArr.length; i++) {
      for (var j = 0; j < closeArr.length; j++) {
        if (openArr[i] === closeArr[j]) throw new Error('setDelimiters: 开头符号「' + openArr[i] + '」与结尾符号相同');
      }
    }
    _delimiters = { open: openArr, close: closeArr };
    try { if (typeof localStorage !== 'undefined') {
      localStorage.setItem(_DELIM_STORAGE_KEY, JSON.stringify(_delimiters));
    }} catch (e) {}
    _notify('delimiters_changed', _delimiters);
    return _delimiters;
  }
  function resetDelimiters() {
    _delimiters = { open: _DEFAULT_DELIMITERS.open.slice(), close: _DEFAULT_DELIMITERS.close.slice() };
    try { if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(_DELIM_STORAGE_KEY);
    }} catch (e) {}
    _notify('delimiters_reset', _delimiters);
    return _delimiters;
  }
  // 把分隔符转为 RegExp 字符串字面量（支持任意标点）
  function _escapeForRegex(s) { return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); }
  function _makeDetectRegex() {
    var d = _loadDelimiters();
    var openUnion  = '(' + d.open.map(_escapeForRegex).join('|')  + ')';
    var closeUnion = '(' + d.close.map(_escapeForRegex).join('|') + ')';
    return new RegExp(openUnion + '([\\s\\S]+?)' + closeUnion, 'g');
  }

  // 意图判断（骨架版：关键词启发式；P3 细化为完整意图识别）
  function _inferType(raw) {
    const t = (raw || '').toLowerCase();
    if (/总结|概括|提炼|整理|梳理|归纳|summar/i.test(t)) return 'summarize';
    if (/翻译|translate/i.test(t)) return 'translate';
    if (/生成|generate|写一篇|产出/i.test(t)) return 'generate';
    if (/为什么|是什么|怎么|如何|解释|含义|请回答|问一下|帮我查/i.test(t)) return 'ask';
    return 'edit';
  }

  function _newId() {
    return 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // 提取 (open1|open2)...(close1|close2) → Command[]（不改正文；pageId/notebookId 由上层 enqueue 前补齐）
  function detect(text) {
    if (typeof text !== 'string' || !text) return [];
    const re = _makeDetectRegex();
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[2] || '').trim();
      if (!raw) continue;
      out.push({
        id: _newId(),
        raw: raw,
        mark: m[0],   // 完整指令句原文（含前后符号），供 AI 处理完后从笔记精确删除
        type: _inferType(raw),
        status: 'pending',
        createdAt: Date.now()
      });
    }
    return out;
  }

  // 实时检测未闭合的起始标记（输入任意开头符号后即触发，无需等待完整闭合）
  // 返回 { raw, hasOpenMark, hasContent } 或 null。
  // 规则：取文本中最后一个「任意 open」；若其后（到行尾）不再出现「任意 close」，视为「正在书写」的指令片段。
  function detectLive(text) {
    if (typeof text !== 'string' || !text) return null;
    var d = _loadDelimiters();
    // 找最后一个任意 open 的位置
    var bestIdx = -1, bestOp = null, opLen = 0;
    for (var i = 0; i < d.open.length; i++) {
      var op = d.open[i]; if (!op) continue;
      var idx = text.lastIndexOf(op);
      if (idx > bestIdx) { bestIdx = idx; bestOp = op; opLen = op.length; }
    }
    if (bestIdx < 0 || !bestOp) return null;
    var tail = text.slice(bestIdx + opLen);
    // 后面有任意 close → 已经闭合，交给闭合检测（detect）处理
    for (var j = 0; j < d.close.length; j++) {
      var cl = d.close[j]; if (!cl) continue;
      if (tail.indexOf(cl) >= 0) return null;
    }
    // 只取到行尾，避免跨行误判
    var nl = tail.indexOf('\n');
    if (nl >= 0) tail = tail.slice(0, nl);
    var raw = tail.trim();
    return { raw: raw, hasOpenMark: true, hasContent: raw.length > 0 };
  }

  // 按页码定位章节（与 ai-engine.js 的 _findChapterIdByPage 同源逻辑，独立内联避免跨模块时序依赖）
  function _findChapterByPage(toc, pageNum) {
    var flat = [];
    (function walk(items) {
      for (var i = 0; i < items.length; i++) {
        flat.push(items[i]);
        if (items[i].children && items[i].children.length) walk(items[i].children);
      }
    })(toc || []);
    flat.sort(function(a, b) { return (a.pageNum || 0) - (b.pageNum || 0); });
    var best = null;
    for (var j = 0; j < flat.length; j++) {
      if ((flat[j].pageNum || 0) <= pageNum) best = flat[j]; else break;
    }
    return best;
  }

  // 入队时快照：当前 PDF 状态（页号 + 章节文本 + 页文本 + bookId/pdfId）+ 当前笔记页 mdContent。
  // 供异步执行时 AI 基于「入队时刻」的状态，而非「执行时刻」的实时状态。
  // 2026-08-15 修正：新增 chapterTitle + mdContent 别名（与 ai-engine.js _buildContext 读取的字段对齐）
  async function captureSnapshot(pageId) {
    var snapshot = {
      pageNum: 0,
      chapterTitle: '',
      chapterText: '',
      pageText: '',
      bookId: null,
      pdfId: null,
      noteMd: '',
      mdContent: '',         // 别名，便于 ai-engine 直接读取（入队时刻冻结的笔记全文）
      capturedAt: Date.now()
    };

    // 当前笔记页 mdContent（快照正文）
    if (pageId) {
      try {
        if (typeof DataLayer !== 'undefined' && DataLayer.getPageMd) {
          snapshot.noteMd = await DataLayer.getPageMd(pageId) || '';
        } else if (typeof Notebook !== 'undefined' && Notebook.getPageMd) {
          snapshot.noteMd = Notebook.getPageMd(pageId) || '';
        }
      } catch (e) { snapshot.noteMd = ''; }
      snapshot.mdContent = snapshot.noteMd;   // 双字段统一值，避免读漏
    }

    // PDF 标识（bookId/pdfId）：优先笔记本的 pdfId，兜底 bookId
    if (typeof Notebook !== 'undefined' && Notebook.getNotebook) {
      try {
        var nb = Notebook.getNotebook();
        if (nb) {
          snapshot.pdfId = nb.pdfId || null;
          snapshot.bookId = nb.bookId || null;
        }
      } catch (e) { /* 忽略 */ }
    }

    // PDF 状态：当前页号 + 章节标题/文本 + 页文本
    if (typeof PDFReader !== 'undefined' && PDFReader.getCurrentPage) {
      try {
        var pageNum = PDFReader.getCurrentPage();
        snapshot.pageNum = pageNum || 0;
        if (snapshot.pageNum > 0) {
          // 章节标题 + 完整文本（Layer 1）
          if (PDFReader.getTOC && PDFReader.getChapterText) {
            try {
              var toc = await PDFReader.getTOC();
              if (toc && toc.length) {
                var ch = _findChapterByPage(toc, snapshot.pageNum);
                if (ch) {
                  snapshot.chapterTitle = (ch.title && ch.title.trim()) ? String(ch.title) : '';
                  if (ch.id) {
                    var ct = await PDFReader.getChapterText(ch.id);
                    snapshot.chapterText = (ct && ct.trim()) ? ct : '';
                  }
                }
              }
            } catch (e) { /* 章节快照失败不影响入队 */ }
          }
          // 当前页文本
          if (PDFReader.getPageText) {
            try {
              var pt = await PDFReader.getPageText(snapshot.pageNum);
              snapshot.pageText = (pt && pt.trim()) ? pt : '';
            } catch (e) { /* 页文本快照失败不影响入队 */ }
          }
          // 兜底：若 pageText 为空但 PDFReader.getPageText 未定义，尝试 getPageContent 或其它
          if (!snapshot.pageText && PDFReader.getPageContent) {
            try {
              var pc = await PDFReader.getPageContent(snapshot.pageNum);
              snapshot.pageText = (typeof pc === 'string' && pc.trim()) ? pc : snapshot.pageText;
            } catch (e) {}
          }
        }
      } catch (e) { /* PDF 状态快照失败不影响入队 */ }
    }

    return snapshot;
  }

  // 入 FIFO：写入 DataLayer.commands（pageId/notebookId 由调用方挂到 cmd 上）
  async function enqueue(cmd) {
    if (!cmd) return null;
    if (!cmd.id) cmd.id = _newId();
    if (!cmd.type) cmd.type = _inferType(cmd.raw);
    if (!cmd.status) cmd.status = 'pending';
    if (!cmd.createdAt) cmd.createdAt = Date.now();
    await DataLayer.putCommand(cmd);
    if (cmd.raw) _statusCache[cmd.raw] = cmd.status;
    _notify('pending', cmd);
    return cmd;
  }

  // 从 mdContent 增量同步：提取新指令入队，已存在的跳过（防重复）
  async function syncFromText(text, pageId, notebookId) {
    const cmds = detect(text);
    if (!cmds.length) return [];
    let existing = [];
    try { existing = await DataLayer.listCommands(); } catch (e) { existing = []; }
    const sigs = {};
    existing.forEach(function(c) {
      if (c && c.raw) { sigs[(c.pageId || '') + '::' + c.raw] = true; _statusCache[c.raw] = c.status; }
    });
    // 已提取到完整闭合指令：清理该页残留的 live 指令（未闭合片段使命完成，避免被 FIFO 误消费）
    let cleaned = false;
    for (let i = 0; i < existing.length; i++) {
      const c = existing[i];
      if (c && c.live === true && (c.pageId || '') === (pageId || '')) {
        try { await DataLayer.deleteCommand(c.id); } catch (e) {}
        if (c.raw) { delete sigs[(c.pageId || '') + '::' + c.raw]; delete _statusCache[c.raw]; }
        cleaned = true;
      }
    }
    const added = [];
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      const sig = (pageId || '') + '::' + c.raw;
      if (sigs[sig]) continue;
      c.pageId = pageId;
      c.notebookId = notebookId;
      // 闭合指令入队时快照当前 PDF 状态 + 笔记 mdContent，供异步执行基于入队时刻状态
      c.snapshot = await captureSnapshot(pageId);
      await enqueue(c);
      sigs[sig] = true;
      added.push(c);
    }
    if (added.length || cleaned) {
      _renderQueue();
      // 不在此处触发 run()：由常驻轮询调度器（startScheduler）按 createdAt 升序持续消费
    }
    return added;
  }

  // 实时同步「正在书写」的指令（输入第二个 、 即触发入队；后续字符更新同一条，不重复新建）
  // 用 Promise 链串行化，避免每个字符触发的并发检测竞态导致重复入队。
  let _liveChain = Promise.resolve();
  function syncLive(text, pageId, notebookId) {
    _liveChain = _liveChain
      .then(function() { return _syncLiveInner(text, pageId, notebookId); })
      .catch(function(e) { console.error('[CommandQueue] 实时指令同步异常', e); });
    return _liveChain;
  }

  async function _syncLiveInner(text, pageId, notebookId) {
    var live = detectLive(text);
    if (!live || !live.hasContent) return null;

    // 查找该页最近一条「书写中」的 live 指令
    let existing = [];
    try {
      existing = (typeof DataLayer !== 'undefined' && DataLayer.listCommandsByPage)
        ? await DataLayer.listCommandsByPage(pageId)
        : [];
    } catch (e) {
      existing = [];
    }
    if (!existing.length && typeof DataLayer !== 'undefined' && DataLayer.listCommands) {
      try {
        var all = await DataLayer.listCommands();
        existing = all.filter(function(c) { return c && c.pageId === pageId; });
      } catch (e2) { existing = []; }
    }

    var target = null;
    for (var i = existing.length - 1; i >= 0; i--) {
      var c = existing[i];
      if (c && c.live === true && c.status === 'pending') { target = c; break; }
    }

    if (target) {
      // 更新同一条 live 指令的 raw，不重复入队
      target.raw = live.raw;
      target.type = _inferType(live.raw);
      target.updatedAt = Date.now();
      await DataLayer.updateCommand(target);
      if (target.raw) _statusCache[target.raw] = target.status;
      _notify('update', target);
      _renderQueue();
      return target;
    }

    // 首次出现非空内容：新建一条 live 指令
    var cmd = {
      id: _newId(),
      raw: live.raw,
      type: _inferType(live.raw),
      status: 'pending',
      createdAt: Date.now(),
      live: true,
      pageId: pageId,
      notebookId: notebookId
    };
    await enqueue(cmd);
    _renderQueue();
    return cmd;
  }

  // 全部命令（2026-08-18 改降序：新任务在上优先展示；调度消费顺序不受影响——调度器用 listPendingCommands 独立 FIFO）
  async function list() {
    let all = [];
    try { all = await DataLayer.listCommands(); } catch (e) { all = []; }
    all.sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    all.forEach(function(c) { if (c && c.raw) _statusCache[c.raw] = c.status; });
    return all;
  }

  // 查询指令文本的最新状态（供胶囊渲染同步读取）
  function statusOf(raw) { return _statusCache[raw] || 'pending'; }

  // 2026-08-15 统一状态流：markProcessing 保留兼容（== markStrategizing）
  async function markProcessing(id) { return _setStatus(id, 'strategizing'); }
  async function markStrategizing(id) { return _setStatus(id, 'strategizing'); }
  async function markStrategyReady(id, patch) { return _setStatus(id, 'strategy_ready', patch); }
  // 等待用户审批：patch 必须包含 plan + preApprovalMd（正文基线快照，用于撤回回退）
  async function markAwaitingApproval(id, patch) {
    return _setStatus(id, 'awaiting_approval', patch);
  }
  async function markApproved(id) { return _setStatus(id, 'approved'); }
  async function markApplying(id) { return _setStatus(id, 'applying'); }
  // markDone: patch 可选 postApplyMd / diff / bookmarkId
  async function markDone(id, patch) { return _setStatus(id, 'done', patch); }
  async function markFailed(id, reason, patch) {
    var p = patch || {};
    if (reason) p.failReason = reason;
    return _setStatus(id, 'failed', p);
  }
  async function markRejected(id, reason) {
    return _setStatus(id, 'rejected', { rejectReason: reason || '用户拒绝策略' });
  }
  async function markRolledBack(id) { return _setStatus(id, 'rolled_back'); }
  async function markRollforwardDone(id) { return _setStatus(id, 'done'); } // 取消撤回后回 done

  async function resetToPending(id) {
    var cmd = null;
    try { cmd = await DataLayer.getCommand(id); } catch (e) { cmd = null; }
    if (!cmd) return null;
    cmd.status = 'pending';
    // 清理上一次策略/执行的痕迹（避免混进下次）
    delete cmd.plan;
    delete cmd.preApprovalMd;
    delete cmd.postApplyMd;
    delete cmd.diff;
    delete cmd.bookmarkId;
    delete cmd.failReason;
    delete cmd.rejectReason;
    await DataLayer.updateCommand(cmd);
    if (cmd.raw) _statusCache[cmd.raw] = 'pending';
    _notify('reset_to_pending', cmd);
    _renderQueue();
    return cmd;
  }

  // 2026-08-15 新增：读取单条指令对象（供 ai-engine 的审批流函数消费）
  async function getCommand(id) {
    try {
      if (typeof DataLayer !== 'undefined' && DataLayer.getCommand) {
        return await DataLayer.getCommand(id);
      }
    } catch (e) {}
    return null;
  }

  async function _setStatus(id, status, patch) {
    let cmd = null;
    try { cmd = await DataLayer.getCommand(id); } catch (e) { cmd = null; }
    if (!cmd) return null;
    var prevStatus = cmd.status;
    cmd.status = status;
    if (patch) { for (const k in patch) cmd[k] = patch[k]; }
    await DataLayer.updateCommand(cmd);
    if (cmd.raw) _statusCache[cmd.raw] = status;
    _notify(status, cmd);
    _renderQueue();

    // 2026-08-16 P1-5：新任务完成/失败/待审批时自动弹出可拖动的悬浮卡片
    // 只在「状态变化」时触发（避免 updateCommand 多次重复响铃）
    if (prevStatus !== status) {
      try {
        if (status === 'done' || status === 'failed' || status === 'awaiting_approval') {
          // 延迟 20ms，保证 DataLayer 写入完成 & 页面不忙时再弹
          setTimeout(function() { _showFloatingTaskCard(cmd, status); }, 20);
        }
      } catch (e22) { /* 悬浮窗失败不影响主流程 */ }
    }
    return cmd;
  }

  async function remove(id) {
    let cmd = null;
    try { cmd = await DataLayer.getCommand(id); } catch (e) { cmd = null; }
    try { await DataLayer.deleteCommand(id); } catch (e) {}
    if (cmd && cmd.raw) { delete _statusCache[cmd.raw]; }
    _notify('deleted', cmd || { id: id });
    _renderQueue();
    return true;
  }

  // 2026-08-15 统一策略流调度：空闲时按 FIFO 逐条消费「仅 pending」指令，调用 AIEngine.generateStrategy
  // 生成 strategy（operations[]）后状态转 awaiting_approval，等用户在队列卡片点审批/拒绝
  // 执行阶段（applyApprovedPlan）在 UI 审批弹窗里由用户触发，不占调度器槽。
  async function run() {
    if (_running) return null;
    _running = true;
    try {
      const results = [];
      for (;;) {
        let pending = [];
        try { pending = await DataLayer.listPendingCommands(); } catch (e) { pending = []; }
        if (!pending.length) break;
        // 消费前显式按 createdAt 升序排序，保证严格 FIFO
        pending.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        const head = pending[0];
        if (!head || !head.id) break;
        // 队首是未闭合的 live 片段（用户尚未输入 <close>）：宽限期内跳过，超时视为孤儿移除
        if (head.live === true) {
          var lastActive = head.updatedAt || head.createdAt || 0;
          var liveGraceMs = 30000;
          if (Date.now() - lastActive < liveGraceMs) {
            results.push(head);
            break;
          }
          try { await DataLayer.deleteCommand(head.id); } catch (e) {}
          if (head.raw) { delete _statusCache[head.raw]; }
          _renderQueue();
          continue;
        }
        if (typeof AIEngine === 'undefined' || !AIEngine.generateStrategy) {
          // AI 引擎未就绪：中断（不允许假完成）
          results.push(head);
          break;
        }
        // AI 是否配置好（没 Key 也要尝试生成策略——generateStrategy 内部本地规则兜底，只有 LLM 增强可缺省）
        try {
          results.push(await AIEngine.generateStrategy(head));
        } catch (e) {
          // 单条失败：已在 markFailed 入库，继续消费下一条
          results.push({ command: head, error: e && e.message ? e.message : String(e) });
        }
      }
      return results;
    } finally {
      _running = false;
    }
  }

  // 常驻轮询调度器：持续检查待办指令，按 createdAt 升序逐个消费（run 内部 _running 锁防并发）。
  // 取代「仅靠 syncFromText 输入闭合时触发一次 run()」的触发式调度，在应用初始化处启动。
  function startScheduler(intervalMs) {
    if (_pollTimer) return _pollTimer;
    var interval = (typeof intervalMs === 'number' && intervalMs > 0) ? intervalMs : 1500;
    _pollTimer = setInterval(function() {
      run().catch(function(e) {
        console.error('[CommandQueue] 轮询调度异常', e);
      });
    }, interval);
    return _pollTimer;
  }

  function stopScheduler() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // 状态变更订阅（pending / processing / done / failed）
  function onStatusChange(cb) {
    if (typeof cb === 'function') _statusListeners.push(cb);
  }

  function _notify(status, cmd) {
    _statusListeners.forEach(function(cb) {
      try { cb(status, cmd); } catch (e) { console.error('[CommandQueue] 状态回调异常', e); }
    });
  }

  // ---------- 可拖动 DOM 通用化（P1-5 悬浮窗/队列面板/历史面板）----------
  // 在 el 上挂 .drag-handle（或传入 handleEl），按下 handle 时允许整窗自由拖动
  // 保存最后位置到 localStorage 便于下次同位置出现
  function _makeDraggable(el, handleEl, storageKey) {
    if (!el) return;
    var handle = handleEl || el.querySelector('.drag-handle');
    if (!handle) return;
    var rafId = 0;
    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      // 按下时让 el 变成 fixed + 记住相对父容器的偏移
      if (el.style.position !== 'fixed') el.style.position = 'fixed';
      var startX = e.clientX, startY = e.clientY;
      var rect = el.getBoundingClientRect();
      var curLeft = rect.left, curTop = rect.top;
      var pendX = curLeft, pendY = curTop;
      function commit() {
        rafId = 0;
        el.style.left = pendX + 'px';
        el.style.top = pendY + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
      function move(ev) {
        pendX = curLeft + (ev.clientX - startX);
        pendY = curTop  + (ev.clientY - startY);
        if (!rafId) rafId = requestAnimationFrame(commit);
      }
      function up() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; commit(); }
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify({
              left: parseFloat(el.style.left) || 0,
              top:  parseFloat(el.style.top)  || 0
            }));
          } catch (e) {}
        }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      e.preventDefault && e.preventDefault();
    }
    handle.addEventListener('mousedown', onDown);
    // 如果有保存过的位置，首次打开时恢复
    if (storageKey) {
      try {
        var raw = localStorage.getItem(storageKey);
        if (raw) {
          var p = JSON.parse(raw);
          if (p && typeof p.left === 'number') el.style.left = p.left + 'px';
          if (p && typeof p.top  === 'number') el.style.top  = p.top  + 'px';
          if (p && (typeof p.left === 'number' || typeof p.top === 'number')) {
            el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.position = 'fixed';
          }
        }
      } catch (e) {}
    }
  }

  // ---------- P1-5：任务状态变化悬浮卡片（右上角弹出，可拖动，自动堆叠多张）----------
  const _floatingCardsRoot = '__cmdq_floating_cards__';
  function _ensureCardsRoot() {
    var root = document.getElementById(_floatingCardsRoot);
    if (root) return root;
    root = document.createElement('div');
    root.id = _floatingCardsRoot;
    // 2026-08-17：层级提到最大（2147483000），避免被笔记内容/其它浮层盖到下面一层
    root.setAttribute('style', 'position:fixed;right:20px;top:20px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;pointer-events:none;');
    document.body.appendChild(root);
    return root;
  }
  function _statusBadge(status) {
    return status === 'done'             ? { label: '✅ 完成', color: '#16a34a', bg: '#dcfce7' }
      :    status === 'failed'           ? { label: '❌ 失败', color: '#b91c1c', bg: '#fee2e2' }
      :    status === 'awaiting_approval'? { label: '📝 待审批', color: '#b45309', bg: '#fef3c7' }
      :    status === 'rejected'         ? { label: '⛔ 已拒绝', color: '#6b7280', bg: '#f3f4f6' }
      :    status === 'rolled_back'      ? { label: '↩️ 已撤回', color: '#6d28d9', bg: '#ede9fe' }
      :    status === 'strategizing'     ? { label: '🧠 思考中', color: '#1d4ed8', bg: '#dbeafe' }
      :                                     { label: '● 等待',  color: '#374151', bg: '#f3f4f6' };
  }
  function _cmdSummary(cmd, status) {
    var text = (cmd && cmd.raw) ? String(cmd.raw).replace(/\s+/g, ' ').trim() : '指令';
    if (text.length > 42) text = text.slice(0, 42) + '…';
    return text;
  }
  function _showFloatingTaskCard(cmd, status) {
    if (typeof document === 'undefined' || !cmd || !cmd.id) return;
    var root = _ensureCardsRoot();
    var b = _statusBadge(status);
    var card = document.createElement('div');
    card.className = 'cmdq-floating-card';
    card.setAttribute('data-cmd-id', cmd.id || '');
    card.setAttribute('style',
      'pointer-events:auto;min-width:300px;max-width:380px;border-radius:10px;' +
      'box-shadow:0 8px 24px rgba(15,23,42,.12),0 2px 6px rgba(15,23,42,.08);' +
      'background:#fff;border:1px solid rgba(0,0,0,.06);font:13px/1.5 "Microsoft YaHei",sans-serif;color:#111;' +
      'overflow:hidden;display:flex;flex-direction:column;' +
      'animation:cmdq-card-in .25s ease-out both;'
    );
    // 顶部拖拽条
    var bar = document.createElement('div');
    bar.className = 'drag-handle';
    bar.setAttribute('style',
      'display:flex;align-items:center;justify-content:space-between;cursor:grab;' +
      'padding:6px 10px;background:linear-gradient(135deg,#f8fafc 0%,#eef2ff 100%);' +
      'border-bottom:1px solid rgba(0,0,0,.05);user-select:none;'
    );
    var leftInfo = document.createElement('div');
    leftInfo.setAttribute('style', 'display:flex;align-items:center;gap:6px;');
    var tag = document.createElement('span');
    tag.setAttribute('style', 'display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;color:' + b.color + ';background:' + b.bg + ';font-weight:600;font-size:12px;');
    tag.textContent = b.label;
    var title = document.createElement('span');
    title.setAttribute('style', 'color:#475569;font-weight:600;');
    title.textContent = '书虫任务';
    leftInfo.appendChild(tag);
    leftInfo.appendChild(title);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('style',
      'border:none;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#64748b;' +
      'padding:0 4px;border-radius:4px;'
    );
    closeBtn.addEventListener('mouseenter', function(){ closeBtn.style.background = 'rgba(0,0,0,.06)'; });
    closeBtn.addEventListener('mouseleave', function(){ closeBtn.style.background = 'transparent'; });
    bar.appendChild(leftInfo);
    bar.appendChild(closeBtn);
    card.appendChild(bar);

    // 正文摘要
    var body = document.createElement('div');
    body.setAttribute('style', 'padding:10px 12px;display:flex;flex-direction:column;gap:8px;');
    var desc = document.createElement('div');
    desc.setAttribute('style', 'font-size:13px;color:#0f172a;word-break:break-all;');
    desc.textContent = _cmdSummary(cmd, status);
    body.appendChild(desc);
    if (status === 'failed' && cmd.errorMsg) {
      var err = document.createElement('div');
      err.setAttribute('style', 'padding:6px 8px;border-radius:6px;background:#fef2f2;color:#b91c1c;font-size:12px;');
      err.textContent = '错误：' + String(cmd.errorMsg);
      body.appendChild(err);
    }
    // 按钮行
    var actions = document.createElement('div');
    actions.setAttribute('style', 'display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;');
    function mkBtn(label, onClick, opts) {
      var o = opts || {};
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      var bg = o.bg || '#eff6ff', col = o.color || '#1d4ed8';
      if (o.primary) { bg = '#4f46e5'; col = '#fff'; }
      b.setAttribute('style',
        'border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;' +
        'background:' + bg + ';color:' + col + ';'
      );
      b.addEventListener('click', function(ev){ try { onClick(ev); } finally { _removeCard(card); } });
      return b;
    }
    actions.appendChild(mkBtn('打开队列', function() {
      try {
        var panel = document.getElementById('commandQueuePanel');
        if (panel) { panel.style.display = 'flex'; }
        _renderQueue && _renderQueue();
      } catch (e) {}
    }));
    if (status === 'awaiting_approval') {
      actions.appendChild(mkBtn('立即审批', function() {
        try {
          if (typeof AIEngine !== 'undefined' && Notebook && Notebook._openApprovalForCommand) {
            Notebook._openApprovalForCommand(cmd.id);
          } else {
            // 兜底：尝试在队列卡片里找对应审批按钮点一下
            var panel = document.getElementById('commandQueuePanel');
            if (panel) panel.style.display = 'flex';
            _renderQueue && _renderQueue();
          }
        } catch (e) {}
      }, { primary: true }));
    }
    if (status === 'done' && cmd.pageId) {
      actions.appendChild(mkBtn('跳到笔记', function() {
        try {
          if (typeof Notebook !== 'undefined') {
            if (Notebook.renderPage) Notebook.renderPage(cmd.pageId);
            if (Notebook.ensureNoteActive) Notebook.ensureNoteActive();
          }
        } catch (e) {}
      }, { primary: true }));
    }
    if (status === 'failed' && typeof CommandQueue !== 'undefined' && CommandQueue.resetToPending) {
      actions.appendChild(mkBtn('重试', function() {
        try { CommandQueue.resetToPending(cmd.id); } catch(e){}
      }, { primary: true, bg: '#fee2e2', color: '#b91c1c' }));
    }
    body.appendChild(actions);
    card.appendChild(body);

    closeBtn.addEventListener('click', function() { _removeCard(card); });

    // 5 秒后自动淡出（如果用户还没交互；待审批的停留 20 秒）
    var autoMs = (status === 'awaiting_approval') ? 20000 : 6000;
    card._autoTimer = setTimeout(function() { _removeCard(card, true); }, autoMs);

    root.appendChild(card);
    // 绑定拖动（单独为每张卡片保存位置，但通常用户只拖一张——用不同 key）
    var key = 'shuchongu_cmdq_card_' + (cmd.id || 'x');
    _makeDraggable(card, bar, key);
    // 卡片容器变成 pointer-events:none，拖动后要恢复 card 的 pointer-events: auto（已在 card 设置）
    card.addEventListener('mouseenter', function() { if (card._autoTimer) { clearTimeout(card._autoTimer); card._autoTimer = null; } });
  }
  function _removeCard(card, animate) {
    if (!card || !card.parentNode) return;
    if (card._autoTimer) { clearTimeout(card._autoTimer); card._autoTimer = null; }
    if (animate === false) {
      if (card.parentNode) card.parentNode.removeChild(card);
      return;
    }
    card.style.transition = 'opacity .2s ease, transform .2s ease';
    card.style.opacity = '0';
    card.style.transform = 'translateY(-6px)';
    setTimeout(function() { if (card.parentNode) card.parentNode.removeChild(card); }, 250);
  }

  // ============================================================
  // 队列 UI（侧栏）：待办清单 + 完成状态 + 查看/完成/删除
  // ============================================================
  function initUI() {
    if (_uiReady) return;
    _uiReady = true;
    // 注入卡片动画 keyframes（若 <head> 里还没有）
    try {
      if (!document.getElementById('cmdq-card-keyframes')) {
        var st = document.createElement('style');
        st.id = 'cmdq-card-keyframes';
        st.textContent = '@keyframes cmdq-card-in{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}';
        document.head.appendChild(st);
      }
    } catch (e) {}

    const btn = document.getElementById('btnToggleCommandQueue');
    if (btn) btn.addEventListener('click', function() { _togglePanel(); });
    const close = document.getElementById('btnCloseCommandQueue');
    if (close) close.addEventListener('click', function() { _togglePanel(); });
    // 队列/历史面板 → 整体可拖动
    setTimeout(function() {
      var panel = document.getElementById('commandQueuePanel');
      if (panel) {
        // 给面板加一个 drag-handle 条（如果不存在），直接用其 .cq-header 或 .queue-title 作为拖拽条
        var handle = panel.querySelector('.cq-drag-handle') || panel.querySelector('.cq-header') ||
                     panel.querySelector('.queue-panel-header') || panel.querySelector('[data-panel-title]');
        if (!handle) {
          // 没找到标题条 → 在面板开头补一条
          handle = document.createElement('div');
          handle.className = 'cq-drag-handle drag-handle';
          handle.setAttribute('style', 'cursor:grab;user-select:none;padding:6px 12px;font-size:12px;color:#64748b;border-bottom:1px solid rgba(0,0,0,.05);background:linear-gradient(135deg,#f8fafc,#eef2ff);display:flex;align-items:center;gap:6px;');
          handle.innerHTML = '<span>⋮⋮</span><span style="font-weight:600">指令队列（拖动此条移动窗口）</span>';
          if (panel.firstChild) panel.insertBefore(handle, panel.firstChild);
          else panel.appendChild(handle);
        } else {
          handle.classList.add('drag-handle');
        }
        _makeDraggable(panel, handle, 'shuchongu_cmdq_panel_pos');
      }
    }, 300);

    // 状态变化 → 刷新队列 UI
    onStatusChange(function() { _renderQueue(); });
    // 预加载状态缓存（胶囊状态点）并渲染
    list().then(_renderQueue);
  }

  function _togglePanel() {
    const panel = document.getElementById('commandQueuePanel');
    if (!panel) return;
    const open = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = open ? 'flex' : 'none';
    if (open) _renderQueue();
  }

  function _renderQueue() {
    const listEl = document.getElementById('commandQueueList');
    if (!listEl) return;
    list().then(function(items) {
      _paintQueue(listEl, items);
    });
  }

  // 2026-08-15 重写卡片：完整状态徽章 + 查看审批 / 撤回 / 取消撤回 / 重新设计 / 删除 差异化按钮
  function _paintQueue(listEl, items) {
    if (!items.length) {
      var d = _loadDelimiters();
      var openTip = (Array.isArray(d.open) && d.open.length) ? d.open[0] : '、、';
      var closeTip = (Array.isArray(d.close) && d.close.length) ? d.close[0] : '。。';
      listEl.innerHTML = '<div class="command-queue-empty">暂无指令。在笔记中输入 <code>'
        + _escapeHtml(openTip) + '指令' + _escapeHtml(closeTip)
        + '</code> 即可入队。</div>';
      return;
    }
    const statusText = {
      pending: '待处理',
      strategizing: '策略设计中',
      strategy_ready: '策略就绪',
      awaiting_approval: '待审批',
      approved: '已批准',
      applying: '执行中',
      done: '已完成',
      failed: '失败',
      rejected: '已拒绝',
      rolled_back: '已撤回',
      processing: '执行中' // 兼容旧状态名
    };
    let html = '';
    items.forEach(function(c) {
      const raw = String(c.raw || '').replace(/[<>&"]/g, function(ch) {
        return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch];
      });
      const st = c.status || 'pending';
      const canApprove = (st === 'awaiting_approval' || st === 'strategy_ready' || st === 'rejected');
      const canRedesign = (st === 'rejected' || st === 'failed');
      const canRollback = (st === 'done');
      const canRollforward = (st === 'rolled_back');
      const canCancel = (st === 'pending' || st === 'strategizing');
      const opsCount = (c.plan && Array.isArray(c.plan.operations)) ? c.plan.operations.length : 0;
      const opsBadge = (opsCount > 0) ? (' · ' + opsCount + ' 项操作') : '';
      html += '<div class="command-queue-item cmd-' + st + '" data-cmd-id="' + (c.id || '') + '">'
        + '<div class="cq-item-main">'
        + '<span class="cq-dot cq-dot-' + st + '"></span>'
        + '<span class="cq-item-raw" title="' + raw + '">' + raw + '</span>'
        + '<span class="cq-item-status">' + (statusText[st] || st) + '</span>'
        + '</div>'
        + '<div class="cq-item-meta">类型:' + (c.type || 'edit') + opsBadge + ' · 创建:' + _fmtTime(c.createdAt) + '</div>'
        + '<div class="cq-item-actions">';
      if (canApprove) {
        html += '<button class="cq-btn cq-btn-approve" data-act="openApproval" title="查看策略详情 + 审批">📋 查看 & 审批策略</button>';
      }
      if (canRedesign) {
        html += '<button class="cq-btn cq-btn-redesign" data-act="redesign" title="重新设计策略">♻️ 重新设计</button>';
      }
      if (canRollback) {
        html += '<button class="cq-btn cq-btn-rollback" data-act="rollback" title="撤回：把正文回退到执行前">↶ 撤回</button>';
      }
      if (canRollforward) {
        html += '<button class="cq-btn cq-btn-rollfwd" data-act="rollforward" title="取消撤回：恢复刚才的执行结果">↷ 取消撤回</button>';
      }
      if (canCancel) {
        html += '<button class="cq-btn cq-btn-del" data-act="del">取消</button>';
      } else {
        html += '<button class="cq-btn cq-btn-del" data-act="del">删除</button>';
      }
      html += '</div></div>';
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.cq-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const item = btn.closest('.command-queue-item');
        if (!item) return;
        const id = item.getAttribute('data-cmd-id');
        const act = btn.getAttribute('data-act');
        switch (act) {
          case 'openApproval':
            // 打开策略审批弹窗（Notebook 层 UI，没实现的话 fallback 直接批准）
            try {
              if (typeof Notebook !== 'undefined' && Notebook.openApprovalModal) {
                Notebook.openApprovalModal(id);
              } else if (typeof AIEngine !== 'undefined' && AIEngine.applyApprovedPlan) {
                AIEngine.applyApprovedPlan(id).catch(function(err) {
                  alert('执行失败：' + (err && err.message ? err.message : String(err)));
                });
              }
            } catch (e) {}
            break;
          case 'redesign':
            try {
              if (typeof AIEngine !== 'undefined' && AIEngine.redesignStrategy) {
                AIEngine.redesignStrategy(id).catch(function(err) {
                  alert('重新设计失败：' + (err && err.message ? err.message : String(err)));
                });
              } else {
                resetToPending(id);
              }
            } catch (e2) {}
            break;
          case 'rollback':
            try {
              if (typeof AIEngine !== 'undefined' && AIEngine.rollbackCommand) {
                AIEngine.rollbackCommand(id);
              }
            } catch (e3) {}
            break;
          case 'rollforward':
            try {
              if (typeof AIEngine !== 'undefined' && AIEngine.rollforwardCommand) {
                AIEngine.rollforwardCommand(id);
              }
            } catch (e4) {}
            break;
          case 'done': markDone(id); break;
          case 'retry': _setStatus(id, 'pending'); break;
          case 'del': remove(id); break;
        }
      });
    });
  }

  function _escapeHtml(s) {
    return String(s || '').replace(/[<>&"]/g, function(ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch];
    });
  }

  function _fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  return {
    detect: detect,
    detectLive: detectLive,
    syncLive: syncLive,
    enqueue: enqueue,
    captureSnapshot: captureSnapshot,
    run: run,
    startScheduler: startScheduler,
    stopScheduler: stopScheduler,
    onStatusChange: onStatusChange,
    syncFromText: syncFromText,
    list: list,
    statusOf: statusOf,
    markProcessing: markProcessing,
    markDone: markDone,
    markFailed: markFailed,
    remove: remove,
    initUI: initUI,
    // 2026-08-15 统一状态流 + 自定义分隔符
    getCommand: getCommand,
    markStrategizing: markStrategizing,
    markStrategyReady: markStrategyReady,
    markAwaitingApproval: markAwaitingApproval,
    markApproved: markApproved,
    markApplying: markApplying,
    markRejected: markRejected,
    markRolledBack: markRolledBack,
    markRollforwardDone: markRollforwardDone,
    resetToPending: resetToPending,
    // 2026-08-16 修复：允许外部直接保存已修改的 cmd（如补回 pageId）
    _saveCmd: async function(cmd) {
      if (!cmd || !cmd.id) throw new Error('_saveCmd 需要 cmd.id');
      if (typeof DataLayer !== 'undefined' && DataLayer.updateCommand) {
        return await DataLayer.updateCommand(cmd);
      }
      throw new Error('DataLayer.updateCommand 不可用');
    },
    // 自定义指令前后符号
    getDelimiters: getDelimiters,
    setDelimiters: setDelimiters,
    resetDelimiters: resetDelimiters
  };
})();
