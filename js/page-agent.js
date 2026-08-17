/* =================================================================
 * 书虫蛊 · 书虫 PageAgent 悬浮窗（P3-17）
 * 功能：粒子球动画 + 可拖拽 + AI 问答 + 系统快捷操作
 * ================================================================= */
var PageAgent = (function() {
  'use strict';

  var container = null;
  var canvas = null;
  var ctx = null;
  var chatPanel = null;
  var isOpen = false;
  var animationId = null;
  var particles = [];
  var mouseInside = false;
  var mouseAngle = 0;

  // 操作模式：'follow' = 跟随展示步骤；'silent' = 后台静默
  var _execMode = 'follow';

  // ===================== Harness 记忆（轻量 Agent Memory） =====================
  // 解决 AI 每次都要"翻目录页核对页码偏移"的重复工作——一次核对，永久复用。
  // 设计：localStorage 持久化；key 按书（bookId）+ 全局（global）分 namespace。
  // 这是腾讯 Agent Memory 2.0 的轻量本地替代（该库需要 Python 后端，对纯前端项目太重）。
  var _HARNESS_MEMORY_KEY = 'shuchongu_harness_memory_v1';
  var _harnessMemoryCache = null;
  function _hmLoad() {
    if (_harnessMemoryCache) return _harnessMemoryCache;
    try {
      var raw = localStorage.getItem(_HARNESS_MEMORY_KEY);
      _harnessMemoryCache = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { _harnessMemoryCache = {}; }
    if (!_harnessMemoryCache.books)  _harnessMemoryCache.books  = {};
    if (!_harnessMemoryCache.global) _harnessMemoryCache.global = {};
    return _harnessMemoryCache;
  }
  function _hmSave() {
    try { localStorage.setItem(_HARNESS_MEMORY_KEY, JSON.stringify(_harnessMemoryCache || {})); } catch (e) {}
  }
  function _hmCurrentBookId() {
    try {
      var cur = localStorage.getItem('shuchongu_current_book');
      if (cur) return cur;
    } catch (e) {}
    try {
      if (typeof FileManager !== 'undefined' && FileManager._currentBook && FileManager._currentBook.id) {
        return FileManager._currentBook.id;
      }
    } catch (e) {}
    return '__current__';
  }
  function HarnessMemory() {}
  /** 取记忆：不指定 namespace 时默认按当前书。返回任意 JSON 或 undefined。 */
  HarnessMemory.get = function(key, namespace) {
    var store = _hmLoad();
    var ns = namespace || ('book:' + _hmCurrentBookId());
    if (ns === 'global') return store.global ? store.global[key] : undefined;
    if (ns.indexOf('book:') === 0) {
      var bid = ns.slice(5);
      if (store.books && store.books[bid]) return store.books[bid][key];
      return undefined;
    }
    return (store[ns] || {})[key];
  };
  /** 写记忆：不指定 namespace 时默认写当前书。 */
  HarnessMemory.set = function(key, value, namespace) {
    var store = _hmLoad();
    var ns = namespace || ('book:' + _hmCurrentBookId());
    if (ns === 'global') {
      store.global = store.global || {};
      store.global[key] = value;
    } else if (ns.indexOf('book:') === 0) {
      var bid = ns.slice(5);
      store.books = store.books || {};
      store.books[bid] = store.books[bid] || {};
      store.books[bid][key] = value;
    } else {
      store[ns] = store[ns] || {};
      store[ns][key] = value;
    }
    _hmSave();
    return true;
  };
  /** 删除记忆 */
  HarnessMemory.del = function(key, namespace) {
    var store = _hmLoad();
    var ns = namespace || ('book:' + _hmCurrentBookId());
    if (ns === 'global') {
      if (store.global) delete store.global[key];
    } else if (ns.indexOf('book:') === 0) {
      var bid = ns.slice(5);
      if (store.books && store.books[bid]) delete store.books[bid][key];
    } else if (store[ns]) {
      delete store[ns][key];
    }
    _hmSave();
    return true;
  };
  /** 列出指定 namespace 下的所有 keys（调试用） */
  HarnessMemory.listKeys = function(namespace) {
    var store = _hmLoad();
    var ns = namespace || ('book:' + _hmCurrentBookId());
    var bucket = null;
    if (ns === 'global') bucket = store.global;
    else if (ns.indexOf('book:') === 0) bucket = (store.books || {})[ns.slice(5)];
    else bucket = store[ns];
    return bucket ? Object.keys(bucket) : [];
  };
  // 便捷函数：成功跳章后把"页码偏移已确认=true"写入当前书记忆
  function _hmMarkBookVerified(bookId, verified, pageOffset) {
    if (!bookId) return;
    try {
      var key = 'book:' + bookId;
      var store = _hmLoad();
      store.books = store.books || {};
      store.books[bookId] = store.books[bookId] || {};
      if (verified !== undefined) store.books[bookId].pageOffsetVerified = !!verified;
      if (pageOffset !== undefined) store.books[bookId].pageOffset = Number(pageOffset) || 0;
      store.books[bookId]._verifiedAt = Date.now();
      _hmSave();
    } catch (e) {}
  }

  // ===================== AI 编程系统：动态工具注册表 =====================
  // AI 可通过 system_createTool 定义新工具（schema + handler 代码），注册后即可被 LLM 调用。
  // 自定义工具持久化到 localStorage，刷新后依然可用。handler 在浏览器主线程执行，
  // 通过 ctx 注入所有核心模块（PDFReader/Notebook/DataLayer…），相当于给 AI 一套"编程 API"。
  var _customTools = [];
  var _customToolsLoaded = false;
  var _CUSTOM_TOOLS_KEY = 'shuchonggu_custom_tools_v1';

  // 构建注入到自定义工具 handler 的安全上下文
  function _buildToolContext() {
    return {
      PDFReader: (typeof PDFReader !== 'undefined') ? PDFReader : null,
      PDFAnnotate: (typeof PDFAnnotate !== 'undefined') ? PDFAnnotate : null,
      Notebook: (typeof Notebook !== 'undefined') ? Notebook : null,
      DataLayer: (typeof DataLayer !== 'undefined') ? DataLayer : null,
      FileManager: (typeof FileManager !== 'undefined') ? FileManager : null,
      ReferenceManager: (typeof ReferenceManager !== 'undefined') ? ReferenceManager : null,
      AIEngine: (typeof AIEngine !== 'undefined') ? AIEngine : null,
      AppShell: (typeof AppShell !== 'undefined') ? AppShell : null,
      NoteFileManager: (typeof NoteFileManager !== 'undefined') ? NoteFileManager : null,
      AttachmentManager: (typeof AttachmentManager !== 'undefined') ? AttachmentManager : null,
      fetch: (typeof fetch !== 'undefined') ? fetch.bind(window) : null,
      localStorage: window.localStorage,
      JSON: JSON
    };
  }

  // 从 localStorage 加载自定义工具
  function _ensureCustomToolsLoaded() {
    if (_customToolsLoaded) return;
    _customToolsLoaded = true;
    try {
      var raw = localStorage.getItem(_CUSTOM_TOOLS_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) _customTools = arr;
      }
    } catch (e) { _customTools = []; }
  }

  // 保存自定义工具到 localStorage
  function _saveCustomTools() {
    try {
      localStorage.setItem(_CUSTOM_TOOLS_KEY, JSON.stringify(_customTools));
    } catch (e) {}
  }

  // 将存储格式的自定义工具转为工具定义（编译 handler 代码）
  function _customToolToDef(ct) {
    var handlerFn;
    try {
      // eslint-disable-next-line no-new-func
      handlerFn = new Function('args', 'ctx', ct.code);
    } catch (e) {
      handlerFn = function() { throw new Error('工具代码编译失败: ' + (e && e.message ? e.message : e)); };
    }
    return {
      type: 'function',
      function: {
        name: ct.name,
        description: '[自定义工具] ' + ct.description,
        parameters: ct.parameters || { type: 'object', properties: {}, required: [] }
      },
      requiresApproval: !!ct.requiresApproval,
      __isCustom: true,
      handler: function(args) {
        var ctx = _buildToolContext();
        var r;
        try {
          r = handlerFn(args || {}, ctx);
        } catch (e) {
          return Promise.reject(e);
        }
        return Promise.resolve(r);
      }
    };
  }

  // ---------- 粒子系统 ----------
  var PARTICLE_COUNT = 140;  // 增加粒子密度
  var SPHERE_RADIUS = 22;

  function _initParticles() {
    particles = [];
    for (var i = 0; i < PARTICLE_COUNT; i++) {
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      var r = SPHERE_RADIUS + (Math.random() - 0.5) * 4;
      particles.push({
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.sin(phi) * Math.sin(theta),
        z: r * Math.cos(phi),
        baseR: r,
        theta: theta,
        phi: phi,
        speed: 0.003 + Math.random() * 0.008,
        size: 1 + Math.random() * 1.5,
        color: _pickColor()
      });
    }
  }

  function _pickColor() {
    var palette = [
      [74, 222, 128],   // 绿
      [59, 130, 246],   // 蓝
      [168, 85, 247],   // 紫
      [250, 204, 21],   // 金
      [34, 197, 94]     // 深绿
    ];
    var c = palette[Math.floor(Math.random() * palette.length)];
    return c;
  }

  var rotY = 0;
  var rotX = 0;
  var targetRotY = 0;
  var targetRotX = 0;

  function _animate() {
    if (!ctx || !canvas) return;
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 平滑追踪鼠标方向
    rotY += (targetRotY - rotY) * 0.05;
    rotX += (targetRotX - rotX) * 0.05;
    if (!mouseInside) {
      rotY += 0.004; // 自动旋转
    }

    var cx = w / 2;
    var cy = h / 2;

    // 排序：按 z 值从远到近渲染
    var projected = [];
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      // 自动公转
      p.theta += p.speed;

      var x = p.baseR * Math.sin(p.phi) * Math.cos(p.theta);
      var y = p.baseR * Math.sin(p.phi) * Math.sin(p.theta);
      var z = p.baseR * Math.cos(p.phi);

      // 绕 Y 轴旋转
      var cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      var x1 = x * cosY - z * sinY;
      var z1 = x * sinY + z * cosY;
      // 绕 X 轴旋转
      var cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      var y1 = y * cosX - z1 * sinX;
      var z2 = y * sinX + z1 * cosX;

      var scale = 80 / (80 + z2);
      projected.push({
        x: cx + x1 * scale,
        y: cy + y1 * scale,
        z: z2,
        scale: scale,
        size: p.size * scale,
        color: p.color
      });
    }
    projected.sort(function(a, b) { return a.z - b.z; });

    for (var j = 0; j < projected.length; j++) {
      var pr = projected[j];
      var alpha = 0.3 + (pr.scale - 0.5) * 0.8;
      if (alpha > 1) alpha = 1;
      if (alpha < 0.1) alpha = 0.1;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, pr.size, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + pr.color[0] + ',' + pr.color[1] + ',' + pr.color[2] + ',' + alpha + ')';
      ctx.fill();
    }

    // 中心光晕
    var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, SPHERE_RADIUS);
    grad.addColorStop(0, 'rgba(74,222,128,0.15)');
    grad.addColorStop(1, 'rgba(74,222,128,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, SPHERE_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    animationId = requestAnimationFrame(_animate);
  }

  // ---------- 创建 DOM ----------
  function _createDOM() {
    if (container) return;

    container = document.createElement('div');
    container.id = 'pageAgent';
    container.className = 'page-agent';
    container.innerHTML =
      '<div class="pa-orb" id="paOrb">' +
        '<canvas id="paCanvas" width="120" height="120"></canvas>' +
        '<div class="pa-orb-pulse"></div>' +
      '</div>' +
      // ===== chatPanel + 展板 的合体行：让展板紧贴 chatPanel 右缘，随 chatPanel 移动 =====
      '<div class="pa-main-row" id="paMainRow">' +
        '<div class="pa-chat-panel" id="paChatPanel">' +
          '<canvas class="pa-bg-canvas" id="paBgCanvas"></canvas>' +
          '<div class="pa-chat-header" id="paChatHeader">' +
            '<span class="pa-chat-title">🐛 书虫助手</span>' +
            '<div class="pa-chat-actions">' +
              // —— 用户可单独启用的展板格式开关（📐 HTML / 📋 MD）——
              //   只有被打开的格式，AI 才会生成对应展板内容；没开的直接静默跳过
              '<div class="pa-board-switches" title="展板格式：启用后 AI 会自动同步内容，不需要手动点">' +
                '<button class="pa-board-sw pa-sw-html active" id="paSwHtml" data-sw="html" title="启用 HTML 动态演示展板（教程/模拟/可视化）">📐 HTML</button>' +
                '<button class="pa-board-sw pa-sw-md" id="paSwMd" data-sw="md" title="启用 MD 结构化展板（提纲/表格/汇总）">📋 MD</button>' +
                '<button class="pa-board-sw pa-sw-toggle" id="paSwToggle" title="展开/收起展板">◀ 展板</button>' +
              '</div>' +
              '<div class="pa-mode-toggle">' +
                '<button class="pa-mode-btn active" data-mode="follow" title="跟随模式：展示 AI 所有操作步骤">👁 跟随</button>' +
                '<button class="pa-mode-btn" data-mode="silent" title="静默模式：后台操作，完成后告知">🔕 静默</button>' +
              '</div>' +
              '<button class="pa-chat-btn" id="paBtnActions" title="快捷操作">⚡</button>' +
              '<button class="pa-chat-btn" id="paBtnClear" title="清空对话">🧹</button>' +
              '<button class="pa-chat-btn" id="paBtnClose" title="收起">▼</button>' +
            '</div>' +
          '</div>' +
          '<div class="pa-actions-menu" id="paActionsMenu" style="display:none;">' +
            '<button class="pa-action-item" data-action="shelf">📚 返回书架</button>' +
            '<button class="pa-action-item" data-action="read">📖 阅读模式</button>' +
            '<button class="pa-action-item" data-action="note">📝 笔记模式</button>' +
            '<button class="pa-action-item" data-action="attach">📎 附件管理</button>' +
            '<button class="pa-action-item" data-action="highlight">✏️ 划重点</button>' +
            '<button class="pa-action-item" data-action="settings">⚙ AI 设置</button>' +
            '<button class="pa-action-item" data-action="help">❓ 使用教程</button>' +
          '</div>' +
          '<div class="pa-chat-body" id="paChatBody"></div>' +
          '<div class="pa-chat-input-area">' +
            '<div class="pa-input-row">' +
              '<div class="pa-input-wrap">' +
                '<textarea id="paChatInput" class="pa-input" placeholder="问我任何问题，或直接下指令…" rows="1"></textarea>' +
              '</div>' +
              '<button id="paBtnMic" class="pa-mic-btn" title="语音输入（浏览器原生识别）">' +
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>' +
              '</button>' +
              '<button id="paBtnSend" class="pa-send-btn" title="发送">' +
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // 【书虫展板】紧贴 chatPanel 右缘，同高度；可折叠；Tab 只显示用户已启用的格式
        '<div class="pa-board-resizer" id="paBoardResizer"></div>' +
        '<div class="pa-board" id="paBoard">' +
          '<div class="pa-board-body" id="paBoardBody">' +
            '<div class="pa-board-toolbar">' +
              '<div class="pa-board-tab-row">' +
                '<button class="pa-board-tab pa-tab-html active" data-tab="html">📐 HTML 演示</button>' +
                '<button class="pa-board-tab pa-tab-md" data-tab="md">📋 MD 结构化</button>' +
                '<span class="pa-board-spacer"></span>' +
                '<button class="pa-board-icon-btn" id="paBoardClear" title="清空展板内容">🗑</button>' +
                '<button class="pa-board-icon-btn" id="paBoardFullscreen" title="全屏/退出全屏">⛶</button>' +
              '</div>' +
            '</div>' +
            '<div class="pa-board-pane pa-board-pane-html active" id="paBoardPaneHtml">' +
              '<div class="pa-board-empty-hint" id="paBoardEmptyHtml">📐 展板（HTML 动态模式）<br><small>AI 会自动把教学演示、可视化模拟渲染到这里。<br>问一句"怎么跳目录"试试～</small></div>' +
            '</div>' +
            '<div class="pa-board-pane pa-board-pane-md" id="paBoardPaneMd">' +
              '<div class="pa-board-empty-hint" id="paBoardEmptyMd">📋 展板（MD 结构化模式）<br><small>AI 会自动把提纲、步骤、知识点、总结以 Markdown 形式写在这里。</small></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(container);

    canvas = document.getElementById('paCanvas');
    ctx = canvas.getContext('2d');
    chatPanel = document.getElementById('paChatPanel');

    _initParticles();
    _animate();
    _bindEvents();
    _loadPosition();
    _addWelcomeMessage();
    // 书虫展板：初始化 + 暴露 PageAgent._Board 渲染 API
    _initBoard();
    // PageAgent Lite（展板演示用 DOM 操作代理）—— 暴露 PageAgent._PageAgent
    _initPageAgentLite();
  }

  // ================================================================
  //  书虫展板 v2 内部 API（书虫助手兄弟元素 + 按格式启用）—— PageAgent._Board
  //   新：用户先在 chatPanel 顶栏点「📐 HTML / 📋 MD」启用对应格式，
  //       没启用时 AI 再调 renderHtml / renderMd 也直接 return 不生成；
  //       若用户启用了至少一种格式，AI 解决需求时自动把辅助内容同步更新展板（无感化）。
  // ================================================================
  function _initBoard() {
    var board    = document.getElementById('paBoard');
    var mainRow  = document.getElementById('paMainRow');
    if (!board || !mainRow) return;
    var paneHtml = document.getElementById('paBoardPaneHtml');
    var paneMd   = document.getElementById('paBoardPaneMd');
    var tabs     = board.querySelectorAll('.pa-board-tab');
    var btnClr   = document.getElementById('paBoardClear');
    var btnFull  = document.getElementById('paBoardFullscreen');
    var swHtml   = document.getElementById('paSwHtml');
    var swMd     = document.getElementById('paSwMd');
    var swToggle = document.getElementById('paSwToggle');

    function _esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

    // ===== 格式启用状态：localStorage 持久化 + 同步到 body class（CSS 用它控制 Tab 显隐）=====
    var LS_KEY = 'shuchongu_board_formats_v1';
    function _loadFormats(){
      var o = {html: true, md: false};   // 默认只开 HTML（演示优先），MD 用户按需自己开
      try {
        var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
        if (saved && typeof saved === 'object') {
          if (typeof saved.html === 'boolean') o.html = saved.html;
          if (typeof saved.md   === 'boolean') o.md   = saved.md;
        }
      } catch(e) {}
      return o;
    }
    function _saveFormats(o){
      try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch(e) {}
    }
    function _applyFormats(o){
      document.body.classList.toggle('pa-board-html-on', !!o.html);
      document.body.classList.toggle('pa-board-md-on',   !!o.md);
      if (swHtml) swHtml.classList.toggle('active', !!o.html);
      if (swMd)   swMd.classList.toggle('active',   !!o.md);
      // 如果至少一种开启，更新 toggle 按钮文字：收起态提示"▶ 展板"，展开态"◀ 展板"
    }
    var formats = _loadFormats();
    _applyFormats(formats);
    // —— 开关绑定 ——
    function _onSw(which){
      formats[which] = !formats[which];
      _saveFormats(formats);
      _applyFormats(formats);
      // 两个都关：自动撤回展板
      if (!formats.html && !formats.md) {
        _Board.toggle(false);
      } else {
        // 任何一个启用：自动展开
        if (!mainRow.classList.contains('board-open')) _Board.toggle(true);
        var onlyOne = formats.html && !formats.md ? 'html'
                     : formats.md && !formats.html ? 'md' : null;
        if (onlyOne) _Board.switchTab(onlyOne);
      }
    }
    if (swHtml) swHtml.addEventListener('click', function(){ _onSw('html'); });
    if (swMd)   swMd.addEventListener('click',   function(){ _onSw('md');   });
    if (swToggle) swToggle.addEventListener('click', function(){ _Board.toggle(); });

    // --- 极简 Markdown 渲染（展板内用，避免引第三方库体积 & 安全问题）---
    function _miniMd(md){
      md = md==null ? '' : String(md);
      // 代码块 ``` ``` 先整体提走做保护
      var codeBuf = [];
      md = md.replace(/```([\s\S]*?)```/g, function(_, block){
        var lang = '';
        var body = block;
        var m = block.match(/^([^\n]*)\n([\s\S]*)$/);
        if (m) { lang = m[1].trim(); body = m[2]; }
        codeBuf.push({lang: lang, body: body});
        return '\u0000CODE' + (codeBuf.length-1) + '\u0000';
      });
      // 行级代码 `code`
      var inlineBuf = [];
      md = md.replace(/`([^`\n]+)`/g, function(_, c){ inlineBuf.push(c); return '\u0001INL'+(inlineBuf.length-1)+'\u0001'; });
      // 转义：先保护链接里的 []() 中的 <> 再做常规转义
      md = md.replace(/[&<>]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});
      // 行级元素：先按行处理，识别 h1-h4、ul、ol、blockquote、hr、table、p
      var lines = md.split(/\r?\n/);
      var out = [];
      var i = 0;
      function flushP(pbuf){
        if (pbuf.length) { out.push('<p>' + _inlineMd(pbuf.join(' ')).replace(/\n/g,'<br>') + '</p>'); pbuf.length = 0; }
      }
      function _inlineMd(s){
        // 链接 [text](url) （注意已转义，所以括号是原样）
        s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        // 粗体 **text** / __text__
        s = s.replace(/(\*\*|__)([\s\S]*?)\1/g, '<strong>$2</strong>');
        // 斜体 *text* / _text_
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
        // inline code
        s = s.replace(/\u0001INL(\d+)\u0001/g, function(_, idx){ return '<code>' + _esc(inlineBuf[+idx]) + '</code>'; });
        return s;
      }
      var pbuf = [];
      var inUl = false, inOl = false, inBq = false, inTable = false, tableHeader = null, tableAlign = null;
      function closeListsBq(){
        if (inUl){ out.push('</ul>'); inUl = false; }
        if (inOl){ out.push('</ol>'); inOl = false; }
        if (inBq){ out.push('</blockquote>'); inBq = false; }
      }
      function closeTable(){
        if (inTable){ out.push('</tbody></table>'); inTable = false; tableHeader = null; tableAlign = null; }
      }
      while (i < lines.length) {
        var ln = lines[i];
        // 代码块占位
        if (/^\u0000CODE(\d+)\u0000$/.test(ln)) {
          flushP(pbuf); closeListsBq(); closeTable();
          var cid = +RegExp.$1;
          var c = codeBuf[cid];
          out.push('<pre><code' + (c.lang ? ' class="language-'+_esc(c.lang)+'"' : '') + '>' + _esc(c.body.replace(/\n$/,'')) + '</code></pre>');
          i++; continue;
        }
        // hr
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) {
          flushP(pbuf); closeListsBq(); closeTable();
          out.push('<hr>'); i++; continue;
        }
        // h1-h4
        var hm = ln.match(/^(#{1,4})\s+(.*)$/);
        if (hm) {
          flushP(pbuf); closeListsBq(); closeTable();
          out.push('<h'+hm[1].length+'>' + _inlineMd(hm[2]) + '</h'+hm[1].length+'>');
          i++; continue;
        }
        // 列表 UL
        var ulm = ln.match(/^(\s*)[-*+]\s+(.*)$/);
        var olm = ln.match(/^(\s*)\d+\.\s+(.*)$/);
        if (ulm || olm) {
          flushP(pbuf); closeTable();
          if (inBq){ out.push('</blockquote>'); inBq=false; }
          var wantUl = !!ulm;
          var content = _inlineMd(wantUl ? ulm[2] : olm[2]);
          if (wantUl && !inUl) { if (inOl){ out.push('</ol>'); inOl=false; } out.push('<ul>'); inUl = true; }
          if (!wantUl && !inOl){ if (inUl){ out.push('</ul>'); inUl=false; } out.push('<ol>'); inOl = true; }
          out.push('<li>' + content + '</li>');
          i++; continue;
        } else {
          if (inUl || inOl) { closeListsBq(); }
        }
        // blockquote
        var bqm = ln.match(/^>\s?(.*)$/);
        if (bqm) {
          flushP(pbuf); closeTable();
          if (!inBq){ out.push('<blockquote>'); inBq = true; }
          var q = _inlineMd(bqm[1]);
          // 连续的 blockquote 里段落
          var bqbuf = [q];
          i++;
          while (i < lines.length) {
            var bqn = lines[i].match(/^>\s?(.*)$/);
            if (bqn) { bqbuf.push(_inlineMd(bqn[1])); i++; }
            else if (lines[i] === '') { // 允许空行
              var next = i+1;
              if (next<lines.length && /^>\s?/.test(lines[next])) { i++; continue; }
              else break;
            } else break;
          }
          out.push('<p>' + bqbuf.join('<br>') + '</p>');
          continue;
        } else if (inBq){ out.push('</blockquote>'); inBq=false; }
        // 表格
        if (/^\s*\|.*\|\s*$/.test(ln) && (i+1 < lines.length) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])) {
          flushP(pbuf); closeListsBq();
          inTable = true;
          function splitRow(s){
            s = s.replace(/^\s*\|/,'').replace(/\|\s*$/,'');
            return s.split('|').map(function(c){ return c.trim(); });
          }
          var headers = splitRow(lines[i]);
          var aligns  = splitRow(lines[i+1]).map(function(c){
            if (/^:.*:$/.test(c)) return 'center';
            if (/^:/.test(c)) return 'left';
            if (/:$/.test(c)) return 'right';
            return '';
          });
          out.push('<table><thead><tr>' + headers.map(function(h,idx){
            return '<th' + (aligns[idx] ? ' style="text-align:'+aligns[idx]+'"' : '') + '>' + _inlineMd(h) + '</th>';
          }).join('') + '</tr></thead><tbody>');
          i += 2;
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            var cells = splitRow(lines[i]);
            out.push('<tr>' + cells.map(function(c,idx){
              return '<td' + (aligns[idx] ? ' style="text-align:'+aligns[idx]+'"' : '') + '>' + _inlineMd(c) + '</td>';
            }).join('') + '</tr>');
            i++;
          }
          out.push('</tbody></table>');
          inTable = false;
          continue;
        } else {
          closeTable();
        }
        // 空行：段落分隔
        if (ln.trim() === '') {
          flushP(pbuf);
          i++; continue;
        }
        // 普通段落（自动把连续非空行合并成一段）
        pbuf.push(ln);
        i++;
      }
      flushP(pbuf); closeListsBq(); closeTable();
      return out.join('\n');
    }

    // --- 展板交互 ---
    tabs.forEach(function(t){
      t.addEventListener('click', function(){ _Board.switchTab(t.dataset.tab); });
    });
    btnClr.addEventListener('click', function(){ _Board.clear(); });
    btnFull.addEventListener('click', function(){
      board.classList.toggle('fullscreen');
      var isfs = board.classList.contains('fullscreen');
      btnFull.textContent = isfs ? '✕' : '⛶';
      btnFull.title = isfs ? '退出全屏' : '全屏';
    });

    // --- 拖拽调整展板宽度 ---
    var resizer = document.getElementById('paBoardResizer');
    var minWidth = 220;
    var maxWidthRatio = 0.85;
    if (resizer) {
      resizer.addEventListener('mousedown', function(e) {
        e.preventDefault();
        var startX = e.clientX;
        var startWidth = board.offsetWidth;
        var containerWidth = mainRow.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        function onMove(ev) {
          var delta = ev.clientX - startX;
          var newWidth = startWidth + delta;
          var maxW = containerWidth * maxWidthRatio;
          if (newWidth < minWidth) newWidth = minWidth;
          if (newWidth > maxW) newWidth = maxW;
          board.style.width = newWidth + 'px';
          board.style.flex = '0 0 ' + newWidth + 'px';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // 对外渲染 API（工具函数直接调用）
    var _Board = {
      formats: formats,          // 供工具函数/AI 读当前启用状态
      _reloadFormats: function(){ formats = _loadFormats(); _applyFormats(formats); return formats; },
      open:   function(){ mainRow.classList.add('board-open'); board.classList.add('open'); board.style.width = ''; board.style.flex = ''; if (swToggle) swToggle.textContent = '◀ 展板'; return '已展开'; },
      close:  function(){ mainRow.classList.remove('board-open'); board.classList.remove('open'); if (swToggle) swToggle.textContent = '▶ 展板'; return '已收起'; },
      isOpen: function(){ return mainRow.classList.contains('board-open'); },
      toggle: function(force){
        var wantOpen = (typeof force === 'boolean') ? force : !mainRow.classList.contains('board-open');
        wantOpen ? _Board.open() : _Board.close();
        return wantOpen ? '已展开' : '已收起';
      },
      switchTab: function(tab){
        tab = tab === 'md' ? 'md' : 'html';
        // 如果该 Tab 未启用，就别切（避免切到一个空面板）
        if (tab === 'html' && !formats.html) tab = 'md';
        if (tab === 'md'   && !formats.md)   tab = 'html';
        tabs.forEach(function(t){ t.classList.toggle('active', t.dataset.tab === tab); });
        paneHtml.classList.toggle('active', tab === 'html');
        paneMd.classList.toggle('active',   tab === 'md');
        return '已切到 ' + (tab === 'html' ? 'HTML 演示' : 'MD 结构化') + ' Tab';
      },
      clear: function(tab){
        if (!tab || tab === 'html') paneHtml.innerHTML = '<div class="pa-board-empty-hint">📐 展板（HTML 动态模式）<br><small>AI 会自动把教学演示、可视化同步到这里。<br>点顶栏「📐 HTML」启用后，AI 就会开始生成～</small></div>';
        if (!tab || tab === 'md')   paneMd.innerHTML   = '<div class="pa-board-empty-hint">📋 展板（MD 结构化模式）<br><small>AI 会自动把提纲/步骤/知识点以 Markdown 同步到这里。<br>点顶栏「📋 MD」启用～</small></div>';
        return '已清空展板' + (tab ? '('+tab+')' : '');
      },
      setTitle: function(handleTitle, htmlTitle, mdTitle){
        if (swToggle && handleTitle) swToggle.textContent = String(handleTitle).slice(0, 16) + ' 展板';
        return '标题已更新';
      },
      // —— 关键：没启用就不生成（AI 端 / 端都在工具函数这一层挡掉，所以 AI 不会白生成）——
      renderHtml: function(html){
        if (!formats.html) return '⏭ HTML 格式未启用，已跳过（用户点顶栏📐可开启）';
        paneHtml.innerHTML = '<div class="pa-demo">' + (html || '') + '</div>';
        _Board.switchTab('html');
        if (!_Board.isOpen()) _Board.open();
        return '✅ 已在展板 HTML Tab 渲染（' + (html?String(html).length:0) + ' 字符）';
      },
      renderMd: function(md){
        if (!formats.md) return '⏭ MD 格式未启用，已跳过（用户点顶栏📋可开启）';
        paneMd.innerHTML = '<div class="pa-md">' + _miniMd(md) + '</div>';
        _Board.switchTab('md');
        if (!_Board.isOpen()) _Board.open();
        return '✅ 已在展板 MD Tab 渲染（' + (md?String(md).length:0) + ' 字符）';
      },
      render: function(args){
        args = args || {};
        var out = [];
        // 如果传了 focus=true 且至少一种格式启用 → 展开
        if (args.focus && (formats.html || formats.md)) _Board.open();
        if (args.tab) out.push(_Board.switchTab(args.tab));
        // 各自判断启用状态（这样 AI 可以无脑一次传 html + md，不会白生成）
        if (typeof args.html === 'string') out.push(_Board.renderHtml(args.html));
        if (typeof args.md   === 'string') out.push(_Board.renderMd(args.md));
        return out.filter(Boolean).join('；') || '（展板未启用任何格式，已跳过）';
      },
      _miniMd: _miniMd,
    };
    if (!window.PageAgent) window.PageAgent = {};
    window.PageAgent._Board = _Board;
  }

  // ================================================================
  //  PageAgent Lite（内置，只用于展板演示驱动真实 DOM 操作）
  //  受限于浏览器同源/沙箱，此 Lite 版作用域是「当前页面 document」，
  //  只做 4 件事：click / type / scroll / 可视区域截图（textContent 快照）
  //  定位方式 2 种：selector（CSS 选择器） 或 text（按钮/链接可见文本精确/模糊匹配）
  // ================================================================
  function _initPageAgentLite() {
    function _findEl(args){
      var scope = document;
      try {
        if (args.selector) {
          var el = scope.querySelector(args.selector);
          if (el) return el;
        }
        if (args.text) {
          var want = String(args.text).trim();
          // 按优先级：button > a > label/span > *
          var tags = ['BUTTON','A','LABEL','SPAN','DIV','LI','OPTION','TD','TH','H1','H2','H3','H4'];
          for (var k = 0; k < tags.length; k++) {
            var list = scope.getElementsByTagName(tags[k]);
            for (var i = 0; i < list.length; i++) {
              var txt = (list[i].innerText || list[i].textContent || '').trim();
              if (txt === want || (txt.length <= 40 && txt.indexOf(want) >= 0 && want.length >= 2)) {
                // 不能是 display:none / visibility:hidden 的元素
                var st = window.getComputedStyle(list[i]);
                if (st.display === 'none' || st.visibility === 'hidden') continue;
                return list[i];
              }
            }
          }
          // 最后兜底：全文档 xyz.contains
          var all = scope.body ? scope.body.getElementsByTagName('*') : scope.getElementsByTagName('*');
          for (var j = 0; j < Math.min(all.length, 6000); j++) {
            var tx2 = (all[j].innerText || all[j].textContent || '').trim();
            if (tx2 === want) {
              var s2 = window.getComputedStyle(all[j]);
              if (s2.display !== 'none' && s2.visibility !== 'hidden') return all[j];
            }
          }
        }
      } catch(e) {}
      return null;
    }

    function _dispatch(el, etype, extra){
      try {
        var evt;
        try { evt = new Event(etype, {bubbles: true, cancelable: true}); } catch(e) {
          evt = document.createEvent('Event');
          evt.initEvent(etype, true, true);
        }
        if (extra && typeof extra === 'object') {
          Object.keys(extra).forEach(function(k){ try { evt[k] = extra[k]; } catch(e){} });
        }
        el.dispatchEvent(evt);
      } catch(e) {}
    }

    var _PageAgent = {
      // 点击一个元素：selector（推荐）或 text（按钮/链接文案）
      click: function(args){
        args = args || {};
        var el = _findEl(args);
        if (!el) return { ok: false, msg: '未找到目标元素（selector='+(args.selector||'无')+', text='+(args.text||'无')+'）' };
        try { el.focus(); } catch(e){}
        _dispatch(el, 'pointerdown', {pointerType:'mouse', button:0});
        _dispatch(el, 'mousedown',   {button:0});
        _dispatch(el, 'pointerup',   {pointerType:'mouse', button:0});
        _dispatch(el, 'mouseup',     {button:0});
        _dispatch(el, 'click',       {button:0});
        // 对于 a 标签不自动触发 navigate（避免跳页），但 dispatchEvent 本来就不会触发浏览器默认 navigate，所以 OK
        var t = (el.tagName || '') + (el.innerText ? '「'+String(el.innerText).replace(/\s+/g,' ').trim().slice(0,30)+'」' : '');
        return { ok: true, msg: '已点击 ' + t };
      },
      // 给 input / textarea 输入文字：selector 或 text（label 文本），value 必填
      type: function(args){
        args = args || {};
        var el = _findEl(args);
        // 如果 text 定位到的是 label，就去找 label 对应的控件
        if (el && el.tagName === 'LABEL') {
          var hit = el.control;
          if (!hit && el.getAttribute('for')) hit = document.getElementById(el.getAttribute('for'));
          if (hit) el = hit;
        }
        if (!el) return { ok: false, msg: '未找到目标输入框' };
        var tag = (el.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) {
          return { ok: false, msg: '目标元素不是 input/textarea/contentEditable' };
        }
        try { el.focus(); } catch(e){}
        var val = args.value == null ? '' : String(args.value);
        _dispatch(el, 'keydown', {key:'Control'});
        _dispatch(el, 'beforeinput');
        if (el.isContentEditable) el.innerText = val;
        else try { el.value = val; el.setAttribute('value', val); } catch(e) {}
        _dispatch(el, 'input');
        _dispatch(el, 'change');
        _dispatch(el, 'keyup',   {key:'Control'});
        return { ok: true, msg: '已输入 ' + val.length + ' 个字符到 ' + tag };
      },
      // 滚动：selector（默认 body/documentElement），top/pxBy
      scroll: function(args){
        args = args || {};
        var el = (args.selector ? document.querySelector(args.selector) : null) || document.documentElement;
        var beforeY = el.scrollTop;
        if (typeof args.top === 'number') el.scrollTop = args.top;
        if (typeof args.pxBy === 'number') el.scrollTop += args.pxBy;
        _dispatch(el, 'scroll');
        return { ok: true, msg: '已滚动：top 从 ' + beforeY + ' 到 ' + el.scrollTop };
      },
      // 截图：其实是把当前可视区域的 DOM 结构（text 级 + 交互状态）快照，给 AI 看
      //   返回 { ok, html: 当前可视区域 outerHTML 前 N 字符, title, hasBoardHtml/Md: 展板里有什么内容 }
      screenshot: function(args){
        args = args || {};
        var N = typeof args.maxChars === 'number' ? args.maxChars : 4000;
        var html = '';
        var main = document.getElementById('paMainRow') || document.body;
        try { html = main.outerHTML; } catch(e) { try { html = document.body.innerHTML; } catch(e2){} }
        var snapshot = {
          ok: true,
          title: document.title,
          boardFormats: (window.PageAgent && window.PageAgent._Board) ? window.PageAgent._Board.formats : null,
          pageAgentState: null,
          html: html ? String(html).slice(0, N) : '',
        };
        try {
          snapshot.pageAgentState = {
            currentPage: (window.FileManager && window.FileManager._currentBook) ? window.FileManager._currentBook.currentPage : null,
            totalPages: (window.FileManager && window.FileManager._currentBook) ? window.FileManager._currentBook.totalPages : null,
            boardOpen: (window.PageAgent && window.PageAgent._Board) ? window.PageAgent._Board.isOpen() : null,
          };
        } catch(e){}
        return snapshot;
      },
    };
    if (!window.PageAgent) window.PageAgent = {};
    window.PageAgent._PageAgent = _PageAgent;
  }

  // ---------- 事件绑定 ----------
  function _bindEvents() {
    var orb = document.getElementById('paOrb');

    // 点击粒子球：展开/收起聊天面板
    orb.addEventListener('click', function(e) {
      if (orb._wasDragging) { orb._wasDragging = false; return; }
      _toggleChat();
    });

    // 鼠标移动：影响旋转方向
    orb.addEventListener('mousemove', function(e) {
      var rect = orb.getBoundingClientRect();
      var dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
      var dy = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
      targetRotY = dx * 1.2;
      targetRotX = dy * 1.2;
      mouseInside = true;
    });
    orb.addEventListener('mouseleave', function() {
      mouseInside = false;
    });

    // 拖拽
    _makeDraggable(container, orb);

    // 发送消息
    var btnSend = document.getElementById('paBtnSend');
    var input = document.getElementById('paChatInput');
    btnSend.addEventListener('click', _sendMessage);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _sendMessage();
      }
    });
    // 自适应高度
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    // 语音输入（浏览器原生 Web Speech API，非 AI 工具；Chrome/Edge 支持中文）
    var btnMic = document.getElementById('paBtnMic');
    if (btnMic) {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      var recognition = null;
      var micListening = false;
      var micStartTs = 0;
      var micGotResult = false;
      var micTimer = null;
      var isElectron = /Electron\//.test(navigator.userAgent);
      function _micToast(msg) {
        try {
          if (window.__showToast) window.__showToast(msg);
          else alert(msg);
        } catch (e) {}
      }
      function _setMicState(listening) {
        micListening = listening;
        btnMic.classList.toggle('listening', listening);
        btnMic.title = listening ? '识别中…点击停止' : '语音输入（浏览器原生识别）';
        if (listening) {
          btnMic.style.color = '#fff';
          btnMic.style.background = '#dc2626';
          btnMic.style.boxShadow = '0 0 0 3px rgba(220,38,38,.25)';
        } else {
          btnMic.style.color = '';
          btnMic.style.background = '';
          btnMic.style.boxShadow = '';
        }
      }
      function _micClearTimer() {
        if (micTimer) { clearTimeout(micTimer); micTimer = null; }
      }
      function _micCheckResult() {
        // 8 秒内既无结果也未结束 → 提示（麦克风未授权 / 网络无法连接语音服务）
        if (!micListening) return;
        _micClearTimer();
        _setMicState(false);
        _micToast(isElectron
          ? '⚠ 未检测到语音（桌面应用环境在线语音识别常不可用）。建议：1) 点击顶部地址用 Chrome/Edge 打开本页面；2) 或确认麦克风已授权且系统允许。'
          : '⚠ 未检测到语音，请确认：麦克风已授权、浏览器能联网（语音识别需联网服务）后重试。');
      }
      btnMic.addEventListener('click', function() {
        if (!SR) {
          _micToast('当前浏览器不支持语音识别，请使用 Chrome / Edge（或允许麦克风）。');
          return;
        }
        if (micListening) { try { recognition.stop(); } catch (e) {} _setMicState(false); return; }
        try {
          recognition = new SR();
          recognition.lang = 'zh-CN';
          recognition.continuous = false;
          recognition.interimResults = true;
          recognition.onstart = function() {
            micStartTs = Date.now();
            micGotResult = false;
            _setMicState(true);
            _micClearTimer();
            micTimer = setTimeout(_micCheckResult, 8000);
          };
          recognition.onresult = function(ev) {
            micGotResult = true;
            var interim = '', final = '';
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
              var res = ev.results[i];
              if (res.isFinal) final += res[0].transcript;
              else interim += res[0].transcript;
            }
            var text = (final + ' ' + interim).trim();
            input.value = text;
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            if (final) _micClearTimer();
          };
          recognition.onend = function() {
            _micClearTimer();
            _setMicState(false);
            if (!micGotResult && !isElectron) {
              _micToast('语音识别已结束但未识别到文字（请靠近麦克风再说一遍，或检查联网）。');
            }
          };
          recognition.onerror = function(ev) {
            _micClearTimer();
            _setMicState(false);
            var msg = ev && ev.error;
            var hint;
            if (msg === 'not-allowed' || msg === 'service-not-allowed') {
              hint = '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试。';
            } else if (msg === 'audio-capture') {
              hint = '未找到可用麦克风设备，请检查系统麦克风设置。';
            } else if (msg === 'network') {
              hint = '语音识别网络服务连接失败（当前环境可能无法访问在线语音服务）。';
            } else if (msg === 'no-speech') {
              hint = '没有听到声音，请重试。';
            } else {
              hint = '语音识别失败（' + (msg || '未知错误') + '）。' + (isElectron ? ' 桌面应用环境在线语音常不可用，建议用 Chrome/Edge 打开页面。' : '');
            }
            _micToast(hint);
          };
          recognition.start();
          // 立即给出可感知的反馈：开始监听（若 onstart 未及时触发，这里兜底）
          setTimeout(function() {
            if (micListening) return;
            if (!micGotResult) { _setMicState(true); micStartTs = Date.now(); micTimer = setTimeout(_micCheckResult, 8000); }
          }, 300);
          _setMicState(true);
        } catch (e) {
          _setMicState(false);
          _micToast('无法启动语音识别：' + (e.message || e) + (isElectron ? '（桌面应用环境在线语音常不可用）' : ''));
        }
      });
    }

    // 清空
    document.getElementById('paBtnClear').addEventListener('click', function() {
      var body = document.getElementById('paChatBody');
      body.innerHTML = '';
      _addWelcomeMessage();
    });

    // 关闭
    document.getElementById('paBtnClose').addEventListener('click', _toggleChat);

    // 操作模式切换
    var modeBtns = container.querySelectorAll('.pa-mode-btn');
    modeBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        modeBtns.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        _execMode = btn.dataset.mode;
      });
    });

    // 对话框通过 header 拖拽移动（不影响悬浮球位置）
    _makePanelDraggable();

    // 快捷操作菜单
    var btnActions = document.getElementById('paBtnActions');
    var menu = document.getElementById('paActionsMenu');
    btnActions.addEventListener('click', function(e) {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    });
    document.addEventListener('click', function(e) {
      if (!menu.contains(e.target) && e.target !== btnActions) {
        menu.style.display = 'none';
      }
    });
    menu.addEventListener('click', function(e) {
      var item = e.target.closest('.pa-action-item');
      if (!item) return;
      var action = item.dataset.action;
      menu.style.display = 'none';
      _doAction(action);
    });
  }

  // ---------- 拖拽 ----------
  function _makeDraggable(el, handle) {
    var isDragging = false;
    var startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      var rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      el.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newLeft = startLeft + dx;
      var newTop = startTop + dy;

      // 边界约束
      var maxLeft = window.innerWidth - 60;
      var maxTop = window.innerHeight - 60;
      newLeft = Math.max(0, Math.min(maxLeft, newLeft));
      newTop = Math.max(50, Math.min(maxTop, newTop));

      el.style.left = newLeft + 'px';
      el.style.top = newTop + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        handle._wasDragging = true;
      }
    });

    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        el.style.transition = '';
        _savePosition();
      }
    });

    // 触摸支持
    handle.addEventListener('touchstart', function(e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      isDragging = true;
      startX = t.clientX;
      startY = t.clientY;
      var rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      el.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (!isDragging || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      var newLeft = startLeft + dx;
      var newTop = startTop + dy;
      var maxLeft = window.innerWidth - 60;
      var maxTop = window.innerHeight - 60;
      newLeft = Math.max(0, Math.min(maxLeft, newLeft));
      newTop = Math.max(50, Math.min(maxTop, newTop));
      el.style.left = newLeft + 'px';
      el.style.top = newTop + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        handle._wasDragging = true;
      }
    }, { passive: true });

    document.addEventListener('touchend', function() {
      if (isDragging) {
        isDragging = false;
        el.style.transition = '';
        _savePosition();
      }
    });
  }

  // ---------- 对话框独立拖拽（通过 header 拖动面板，不影响悬浮球） ----------
  function _makePanelDraggable() {
    var header = document.getElementById('paChatHeader');
    var panel = document.getElementById('paChatPanel');
    if (!header || !panel) return;
    var isDragging = false;
    var startX, startY, startRelLeft, startRelTop;

    header.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      // 不拦截按钮点击
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      // 关键修正：panel 是 absolute 定位（相对 container），left/top 也是相对坐标
      // 不能直接用 getBoundingClientRect()（视口坐标），否则会偏移 container 自身的位移
      var cRect = container.getBoundingClientRect();
      var pRect = panel.getBoundingClientRect();
      startRelLeft = pRect.left - cRect.left;
      startRelTop  = pRect.top  - cRect.top;
      panel.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newRelLeft = startRelLeft + dx;
      var newRelTop  = startRelTop  + dy;
      // 边界约束（基于视口可见范围）
      var cRect = container.getBoundingClientRect();
      var pRect = panel.getBoundingClientRect();
      var maxRelLeft = window.innerWidth - cRect.left - Math.max(80, pRect.width * 0.3);
      var maxRelTop  = window.innerHeight - cRect.top - 60;
      newRelLeft = Math.max(-pRect.width + 80, Math.min(maxRelLeft, newRelLeft));
      newRelTop  = Math.max(0, Math.min(maxRelTop, newRelTop));
      panel.style.left = newRelLeft + 'px';
      panel.style.top  = newRelTop + 'px';
    });

    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        panel.style.transition = '';
        // 拖拽结束后把整个 container 位置同步过去（保持下次打开位置一致）
        try {
          var cRect = container.getBoundingClientRect();
          var pRect = panel.getBoundingClientRect();
          // 若 panel 已被拖到远离 orb 的位置，把 container 跟随过去
          if (Math.abs(pRect.left - cRect.left) > 20 || Math.abs(pRect.top - cRect.top - 66) > 20) {
            // 不强行回拉，保留用户拖拽位置
          }
        } catch (e) {}
      }
    });
  }

  // ---------- 位置持久化 ----------
  function _savePosition() {
    try {
      var rect = container.getBoundingClientRect();
      localStorage.setItem('shuchongu_pa_pos', JSON.stringify({
        left: rect.left,
        top: rect.top
      }));
    } catch (e) {}
  }
  function _loadPosition() {
    try {
      var s = localStorage.getItem('shuchongu_pa_pos');
      if (s) {
        var pos = JSON.parse(s);
        var left = Math.max(0, Math.min(window.innerWidth - 60, pos.left || 20));
        var top = Math.max(50, Math.min(window.innerHeight - 60, pos.top || 80));
        container.style.left = left + 'px';
        container.style.top = top + 'px';
        container.style.right = 'auto';
        container.style.bottom = 'auto';
      }
    } catch (e) {}
  }

  // ---------- 聊天面板展开/收起 ----------
  function _toggleChat() {
    isOpen = !isOpen;
    var orb = document.getElementById('paOrb');
    // 合体行（聊天+展板）整体跟随悬浮框开关：收起时完全隐藏，不残留白线
    if (container) container.classList.toggle('chat-open', isOpen);
    if (isOpen) {
      chatPanel.classList.add('open');
      // 展开后隐藏粒子球（用户要求：点开后粒子球不再显示）
      if (orb) orb.style.opacity = '0';
      // 启动对话框背景粒子动画
      _startBgParticles();
      var input = document.getElementById('paChatInput');
      if (input) setTimeout(function() { input.focus(); }, 100);
    } else {
      chatPanel.classList.remove('open');
      // 关闭后恢复粒子球
      if (orb) orb.style.opacity = '';
      // 停止背景粒子动画（节能）
      _stopBgParticles();
    }
  }

  // ---------- 对话框背景 · 点线粒子水母群 ----------
  var bgCanvas = null;
  var bgCtx = null;
  var bgJellyfishes = [];   // 每只水母：{x,y,vx,vy,size,color,alpha,z,particles:[],t,...}
  var bgLinks = [];         // 跨水母连线（远处粒子之间）
  var bgRafId = null;
  var bgMouse = { x: -9999, y: -9999, active: false };
  var bgIdle = {
    time: 0,
    pulse: { nextAt: 2500, strength: 0 }
  };

  function _startBgParticles() {
    if (bgRafId) return; // 已在运行
    bgCanvas = document.getElementById('paBgCanvas');
    if (!bgCanvas) return;
    bgCtx = bgCanvas.getContext('2d');
    _resizeBgCanvas();
    _initBgJellyfishes();
    // canvas 是 pointer-events:none，所以鼠标事件绑在 window 上
    // 通过判断鼠标是否落在 chatPanel 范围内来激活水母互动
    window.addEventListener('mousemove', _onBgMouseMove);
    window.addEventListener('resize', _resizeBgCanvas);
    // 监听 chatPanel 尺寸变化（用户拖拽拉伸对话框时实时重算 canvas 分辨率）
    if (window.ResizeObserver && chatPanel) {
      var ro = new ResizeObserver(function() {
        _resizeBgCanvas();
        _initBgJellyfishes();
      });
      ro.observe(chatPanel);
    }
    _bgAnimate();
  }

  function _stopBgParticles() {
    if (bgRafId) { cancelAnimationFrame(bgRafId); bgRafId = null; }
    window.removeEventListener('mousemove', _onBgMouseMove);
    window.removeEventListener('resize', _resizeBgCanvas);
    bgMouse.active = false;
    bgJellyfishes = [];
    if (bgCtx && bgCanvas) bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  }

  function _resizeBgCanvas() {
    if (!bgCanvas || !chatPanel) return;
    var rect = chatPanel.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(100, Math.round(rect.width));
    var h = Math.max(100, Math.round(rect.height));
    // 只有当尺寸真的变化时才重置 canvas 物理分辨率，避免动画抖动
    if (bgCanvas.width !== w * dpr || bgCanvas.height !== h * dpr) {
      bgCanvas.width = w * dpr;
      bgCanvas.height = h * dpr;
      bgCanvas.style.width = w + 'px';
      bgCanvas.style.height = h + 'px';
      // 重新缩放绘图上下文，保证粒子坐标仍以 CSS 像素为基准
      if (bgCtx) bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function _initBgJellyfishes() {
    bgJellyfishes = [];
    var w = bgCanvas.clientWidth || bgCanvas.width;
    var h = bgCanvas.clientHeight || bgCanvas.height;
    var count = Math.max(3, Math.min(7, Math.floor((w * h) / 55000)));
    var palette = [
      [224, 242, 254], [219, 234, 254], [224, 231, 255],
      [237, 233, 254], [207, 250, 254], [220, 252, 231]
    ];
    for (var i = 0; i < count; i++) {
      var z = Math.random();
      var size = 16 + z * 24;
      var col = palette[Math.floor(Math.random() * palette.length)];
      var side = Math.floor(Math.random() * 4);
      var x0, y0;
      if (side === 0) { x0 = Math.random() * w; y0 = -size * 2.5; }
      else if (side === 1) { x0 = Math.random() * w; y0 = h + size * 2.5; }
      else if (side === 2) { x0 = -size * 2.5; y0 = Math.random() * h; }
      else                 { x0 = w + size * 2.5; y0 = Math.random() * h; }

      var particles = [];

      // 伞主体：半球面粒子
      var bellCount = 28 + Math.floor(z * 18);
      for (var b = 0; b < bellCount; b++) {
        var theta = Math.random() * Math.PI * 2;
        var phi = Math.acos(1 - Math.random() * 0.95);
        var r = size * (0.55 + Math.random() * 0.5);
        var bx = r * Math.sin(phi) * Math.cos(theta);
        var by = -r * Math.cos(phi) * 0.75;
        particles.push({
          ox: bx, oy: by,
          x: x0 + bx, y: y0 + by,
          r: 0.8 + Math.random() * 1.2 * (0.6 + z * 0.4),
          phase: Math.random() * Math.PI * 2,
          part: 'bell'
        });
      }

      // 伞边环
      var rimCount = 10 + Math.floor(z * 8);
      for (var r2 = 0; r2 < rimCount; r2++) {
        var angle = (r2 / rimCount) * Math.PI * 2;
        var rx = Math.cos(angle) * size;
        var ry = Math.sin(angle) * size * 0.15 + size * 0.12;
        particles.push({
          ox: rx, oy: ry,
          x: x0 + rx, y: y0 + ry,
          r: 1.0 + Math.random() * 1.0 * (0.6 + z * 0.4),
          phase: Math.random() * Math.PI * 2,
          part: 'rim'
        });
      }

      // 触手：5~8 根，每根 4~7 段
      var tentCount = 5 + Math.floor(z * 4);
      for (var t = 0; t < tentCount; t++) {
        var tAngle = ((t + 0.5) / tentCount) * Math.PI * 2;
        var rootX = Math.cos(tAngle) * size * 0.75;
        var rootY = Math.sin(tAngle) * size * 0.08 + size * 0.12;
        var segments = 4 + Math.floor(Math.random() * 4);
        for (var s = 0; s < segments; s++) {
          var ratio = s / segments;
          var segLen = size * (0.18 + 0.10 * (1 - ratio));
          var sx = rootX + Math.cos(tAngle + Math.PI / 2) * segLen * (s + 1) * 0.8 + (Math.random() - 0.5) * 2;
          var sy = rootY + segLen * (s + 1) * 0.9 + size * 0.1 * (1 - ratio);
          particles.push({
            ox: sx, oy: sy,
            x: x0 + sx, y: y0 + sy,
            r: 0.6 + (1 - ratio) * 1.0 * (0.6 + z * 0.4),
            phase: Math.random() * Math.PI * 2,
            part: 'tentacle',
            tentIdx: t,
            segIdx: s
          });
        }
      }

      bgJellyfishes.push({
        x: x0, y: y0,
        vx: 0, vy: 0,
        size: size,
        color: col,
        alpha: 0,
        targetAlpha: 0.55 + z * 0.25,
        z: z,
        t: Math.random() * Math.PI * 2,
        particles: particles,
        driftAngle: Math.random() * Math.PI * 2,
        driftTurnRate: (Math.random() - 0.5) * 0.008,
        orbitAngle: Math.random() * Math.PI * 2,
        orbitRadiusPref: 70 + Math.random() * 60,
        entering: true,
        enteringT: 0,
        targetX: x0 + (Math.random() - 0.5) * 120,
        targetY: y0 + (Math.random() - 0.5) * 80,
        nextDirChange: 60 + Math.floor(Math.random() * 120)
      });
    }
  }

  function _onBgMouseMove(e) {
    if (!bgCanvas || !chatPanel) return;
    // canvas 是 pointer-events:none，鼠标事件来自 window
    var rect = chatPanel.getBoundingClientRect();
    var lx = e.clientX - rect.left;
    var ly = e.clientY - rect.top;
    if (lx >= 0 && lx <= rect.width && ly >= 0 && ly <= rect.height) {
      bgMouse.x = lx;
      bgMouse.y = ly;
      bgMouse.active = true;
    } else {
      bgMouse.active = false;
      bgMouse.x = -9999;
      bgMouse.y = -9999;
    }
  }

  function _bgAnimate() {
    if (!bgCtx || !bgCanvas) return;
    bgRafId = requestAnimationFrame(_bgAnimate);
    var w = bgCanvas.clientWidth || bgCanvas.width;
    var h = bgCanvas.clientHeight || bgCanvas.height;
    bgCtx.fillStyle = 'rgba(10, 18, 32, 0.085)';
    bgCtx.fillRect(0, 0, w, h);

    bgIdle.time += 16;
    if (bgIdle.time >= bgIdle.pulse.nextAt) {
      bgIdle.pulse.strength = 1.0;
      bgIdle.pulse.nextAt = bgIdle.time + 2600 + Math.random() * 1500;
    }
    var pulseK = bgIdle.pulse.strength;
    if (pulseK > 0) bgIdle.pulse.strength = Math.max(0, pulseK - 0.022);

    for (var i = 0; i < bgJellyfishes.length; i++) {
      var j = bgJellyfishes[i];
      j.t += 0.038 + (1.0 - j.z) * 0.015;
      var jBreath = 0.5 + 0.5 * Math.sin(j.t * 1.15);

      if (j.entering) {
        j.enteringT++;
        var edx = j.targetX - j.x, edy = j.targetY - j.y;
        var ed = Math.sqrt(edx * edx + edy * edy) + 0.01;
        j.vx += (edx / ed) * 0.06;
        j.vy += (edy / ed) * 0.06;
        j.alpha += (j.targetAlpha - j.alpha) * 0.035;
        if (ed < 10 && j.enteringT > 25) j.entering = false;
        if (j.enteringT > 200) j.entering = false;
      } else {
        j.alpha += (j.targetAlpha - j.alpha) * 0.008;
      }

      if (bgMouse.active) {
        var dx = bgMouse.x - j.x, dy = bgMouse.y - j.y;
        var dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
        if (dist < 260) {
          var nx = dx / dist, ny = dy / dist;
          var tx = -ny, ty = nx;
          if (dist > 130) {
            var ak = Math.min(1.0, (260 - dist) / 130);
            j.vx += nx * 0.035 * ak + tx * 0.010 * ak;
            j.vy += ny * 0.035 * ak + ty * 0.010 * ak;
          } else {
            var ok = (130 - dist) / 130;
            j.vx += tx * (0.075 * ok + 0.018);
            j.vy += ty * (0.075 * ok + 0.018);
            var re = dist - j.orbitRadiusPref;
            j.vx += (-nx) * 0.015 * Math.min(1, Math.abs(re) / 50) * Math.sign(re);
            j.vy += (-ny) * 0.015 * Math.min(1, Math.abs(re) / 50) * Math.sign(re);
          }
        }
      }

      if (!bgMouse.active || j.entering) {
        j.driftAngle += j.driftTurnRate;
        if (j.nextDirChange-- <= 0) {
          j.driftTurnRate = (Math.random() - 0.5) * 0.012;
          j.nextDirChange = 60 + Math.floor(Math.random() * 120);
        }
        var ddx = Math.cos(j.driftAngle);
        var ddy = Math.sin(j.driftAngle) - 0.15;
        var swimK = Math.max(0, Math.sin(j.t * 1.15 - Math.PI / 2)) * 0.048;
        j.vx += ddx * swimK * 1.2;
        j.vy += ddy * swimK * 1.2;
      }

      if (pulseK > 0) {
        j.vy -= 0.07 * pulseK * (0.6 + 0.4 * Math.random());
      }

      var margin = j.size * 1.3;
      if (j.x < margin) { var k = (margin - j.x) / margin; j.vx += k * 0.22; }
      if (j.x > w - margin) { var k = (j.x - (w - margin)) / margin; j.vx -= k * 0.22; }
      if (j.y < margin) { var k = (margin - j.y) / margin; j.vy += k * 0.22; }
      if (j.y > h - margin) { var k = (j.y - (h - margin)) / margin; j.vy -= k * 0.22; }

      j.vx *= 0.985;
      j.vy *= 0.985;
      var vv = j.vx * j.vx + j.vy * j.vy;
      if (vv > 2.4) { var vs = Math.sqrt(2.4 / vv); j.vx *= vs; j.vy *= vs; }
      j.x += j.vx;
      j.y += j.vy;

      for (var p = 0; p < j.particles.length; p++) {
        var pt = j.particles[p];
        var breathScale = 1.0 + (jBreath - 0.5) * 0.14;
        if (pt.part === 'tentacle') {
          var tentPhase = j.t * 1.8 + pt.phase;
          var tentWave = Math.sin(tentPhase) * (2.5 + pt.segIdx * 1.2);
          var mouseBonus = 1.0;
          if (bgMouse.active) {
            var tdx = j.x + pt.ox - bgMouse.x, tdy = j.y + pt.oy - bgMouse.y;
            var td = Math.sqrt(tdx * tdx + tdy * tdy);
            if (td < 280) mouseBonus = 1.0 + (1 - td / 280) * 1.2;
          }
          pt.x = j.x + pt.ox + tentWave * mouseBonus * 0.8;
          pt.y = j.y + pt.oy + Math.cos(tentPhase * 0.8) * 1.5 * mouseBonus;
        } else if (pt.part === 'rim') {
          pt.x = j.x + pt.ox * breathScale + Math.sin(j.t * 1.5 + pt.phase) * 1.2;
          pt.y = j.y + pt.oy * breathScale + Math.cos(j.t * 1.3 + pt.phase) * 0.8;
        } else {
          pt.x = j.x + pt.ox * breathScale + Math.sin(j.t * 1.1 + pt.phase) * 0.8;
          pt.y = j.y + pt.oy * (2 - breathScale) + Math.cos(j.t * 0.9 + pt.phase) * 0.6;
        }
      }
    }

    // Collect all particles
    var allPts = [];
    for (var gi = 0; gi < bgJellyfishes.length; gi++) {
      var jf = bgJellyfishes[gi];
      for (var pi = 0; pi < jf.particles.length; pi++) {
        var pp = jf.particles[pi];
        allPts.push({ x: pp.x, y: pp.y, r: pp.r, z: jf.z, alpha: jf.alpha, color: jf.color, part: pp.part, gid: gi });
      }
    }

    // Draw intra-jellyfish connections (constellation)
    var linkDist = 22;
    bgCtx.lineWidth = 0.55;
    for (var gj = 0; gj < bgJellyfishes.length; gj++) {
      var jf2 = bgJellyfishes[gj];
      if (jf2.alpha < 0.05) continue;
      var c2 = jf2.color;
      var pts = jf2.particles;
      for (var a = 0; a < pts.length; a++) {
        var pa = pts[a];
        for (var b = a + 1; b < pts.length; b++) {
          var pb = pts[b];
          var ddx = pa.x - pb.x, ddy = pa.y - pb.y;
          var dd = ddx * ddx + ddy * ddy;
          if (dd < linkDist * linkDist) {
            var op = (1 - Math.sqrt(dd) / linkDist) * 0.55 * jf2.alpha;
            bgCtx.strokeStyle = 'rgba(' + c2[0] + ',' + c2[1] + ',' + c2[2] + ',' + op + ')';
            bgCtx.beginPath();
            bgCtx.moveTo(pa.x, pa.y);
            bgCtx.lineTo(pb.x, pb.y);
            bgCtx.stroke();
          }
        }
      }
    }

    // Cross-jellyfish weak connections
    var crossDist = 55;
    bgCtx.lineWidth = 0.35;
    for (var ai = 0; ai < allPts.length; ai++) {
      var ap = allPts[ai];
      for (var bi = ai + 1; bi < allPts.length; bi++) {
        var bp = allPts[bi];
        if (Math.abs(ap.gid - bp.gid) < 1) continue;
        var adx = ap.x - bp.x, ady = ap.y - bp.y;
        var ad = adx * adx + ady * ady;
        if (ad < crossDist * crossDist) {
          var aop = (1 - Math.sqrt(ad) / crossDist) * 0.18 * Math.min(ap.alpha, bp.alpha);
          if (aop > 0.01) {
            bgCtx.strokeStyle = 'rgba(148, 163, 184, ' + aop + ')';
            bgCtx.beginPath();
            bgCtx.moveTo(ap.x, ap.y);
            bgCtx.lineTo(bp.x, bp.y);
            bgCtx.stroke();
          }
        }
      }
    }

    // Draw particles
    for (var di = 0; di < allPts.length; di++) {
      var dp = allPts[di];
      if (dp.alpha < 0.03) continue;
      var alpha = dp.alpha * (0.75 + 0.25 * (0.5 + 0.5 * Math.sin(bgIdle.time / 1200 + di * 0.7)));
      var col = dp.color;
      var sizeScale = dp.part === 'tentacle' ? 0.65 : 1.0;
      bgCtx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha * 0.95 + ')';
      bgCtx.beginPath();
      bgCtx.arc(dp.x, dp.y, dp.r * sizeScale, 0, Math.PI * 2);
      bgCtx.fill();
      if (di % 3 === 0) {
        bgCtx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha * 0.18 + ')';
        bgCtx.beginPath();
        bgCtx.arc(dp.x, dp.y, dp.r * sizeScale * 2.4, 0, Math.PI * 2);
        bgCtx.fill();
      }
    }

    if (bgMouse.active) {
      var mg = bgCtx.createRadialGradient(bgMouse.x, bgMouse.y, 0, bgMouse.x, bgMouse.y, 55);
      mg.addColorStop(0, 'rgba(186, 230, 253, 0.28)');
      mg.addColorStop(0.5, 'rgba(56, 189, 248, 0.10)');
      mg.addColorStop(1, 'rgba(56, 189, 248, 0)');
      bgCtx.fillStyle = mg;
      bgCtx.beginPath();
      bgCtx.arc(bgMouse.x, bgMouse.y, 55, 0, Math.PI * 2);
      bgCtx.fill();
      bgCtx.fillStyle = 'rgba(224, 242, 254, 0.6)';
      bgCtx.beginPath();
      bgCtx.arc(bgMouse.x, bgMouse.y, 1.4, 0, Math.PI * 2);
      bgCtx.fill();
    }
  }  // ---------- 欢迎消息 ----------
  function _addWelcomeMessage() {
    _addMessage('bot', '你好！我是书虫助手 🐛\n可以问我关于当前文献的问题，或者点击 ⚡ 查看快捷操作。');
  }

  function _renderMarkdown(text) {
    var html = _escapeHtml(text || '');
    html = html.replace(/```([\s\S]*?)```/g, function(m, code) {
      return '<pre class="pa-code-block">' + code + '</pre>';
    });
    html = html.replace(/`([^`]+)`/g, '<code class="pa-inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function _addMessage(role, text) {
    var body = document.getElementById('paChatBody');
    if (!body) return;
    var msg = document.createElement('div');
    msg.className = 'pa-msg pa-msg-' + (role === 'user' ? 'user' : 'bot');
    // 规范化 role：API 只接受 system/user/assistant/tool，其他角色统一归到 assistant（避免 400: unknown variant 'bot'）
    var normRole = (role === 'user' || role === 'system' || role === 'assistant' || role === 'tool') ? role : 'assistant';
    msg.__role = normRole;
    msg.__content = text;
    msg.innerHTML = _renderMarkdown(text);
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
    return msg;
  }

  function _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- 本地章节跳转（零 token、直接命中 PDF TOC） ----------
  // 返回 true 表示已本地处理（不走 LLM）
  function _tryLocalChapterJump(text) {
    if (!text || typeof text !== 'string') return false;
    if (typeof PDFReader === 'undefined' || !PDFReader.getTOC || !PDFReader.jumpToPage) return false;
    // 是否是跳章节指令？
    var t = text.trim();
    if (t.length > 40) return false; // 太长说明是自然语言问答，交给 AI
    if (!/^(跳|翻|定位|去|转到|goto|打开)到?\s*(第|[0-9一二三四五六七八九十百千])/i.test(t)
        && !/(章|节|篇|部分|chapter|section)\s*[0-9一二三四五六七八九十百千]/i.test(t)) {
      return false;
    }
    // 缓存 TOC，避免多次重复解析
    if (!window.__scg_toc_cache || Date.now() - window.__scg_toc_cache_ts > 60000) {
      return false; // TOC 未缓存，异步拿不到结果，跳过本地拦截，交给 AI（AI 会调 pdf_getTOC 然后 jumpToPage，只需 2 轮）
    }
    var toc = window.__scg_toc_cache;
    if (!toc || !toc.length) return false;
    // 提取关键字：序号/中文数字/文字关键词
    function cn2num(s) {
      var cn = {'〇':0,'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'百':100,'千':1000};
      var r = /^([一二三四五六七八九十百千零〇]+)$/.exec(s); if (!r) return null;
      var total = 0, cur = 0, section = 0;
      for (var i = 0; i < s.length; i++) {
        var v = cn[s[i]]; if (v === undefined) return null;
        if (v >= 10) {
          section += (cur || 1) * v; cur = 0;
        } else cur = v;
      }
      return section + cur;
    }
    var m;
    var targetNum = null;
    var targetKeywords = null;
    m = /第\s*([0-9一二三四五六七八九十百千]+)\s*(章|节|篇|部分|节次|讲)/.exec(t);
    if (m) {
      targetNum = /^\d+$/.test(m[1]) ? parseInt(m[1],10) : cn2num(m[1]);
    }
    if (!targetNum) {
      m = /(章|节|篇|chapter|section)\s*(\d+|[一二三四五六七八九十百千]+)/i.exec(t);
      if (m) targetNum = /^\d+$/.test(m[2]) ? parseInt(m[2],10) : cn2num(m[2]);
    }
    // 扁平化遍历 TOC
    var best = null, bestScore = 0;
    function walk(items) {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var title = it.title || '';
        var score = 0;
        if (targetNum) {
          var mm = /^第\s*([0-9一二三四五六七八九十百千]+)\s*(章|节|篇|部分|节次|讲)/.exec(title);
          if (mm) {
            var num = /^\d+$/.test(mm[1]) ? parseInt(mm[1],10) : cn2num(mm[1]);
            if (num === targetNum) score += 100;
          }
        }
        if (targetKeywords) {
          for (var k = 0; k < targetKeywords.length; k++) if (title.indexOf(targetKeywords[k]) >= 0) score += 5;
        }
        if (score > bestScore) { bestScore = score; best = it; }
        if (it.items && it.items.length) walk(it.items);
      }
    }
    walk(toc);
    if (best && bestScore > 0 && best.pageNum) {
      try { PDFReader.jumpToPage(Number(best.pageNum)); } catch (_) { return false; }
      _addMessage('bot', '📑 本地命中目录：「' + (best.title || '').slice(0, 30) + '」→ 跳转到第 ' + best.pageNum + ' 页（零 token，秒完成）');
      return true;
    }
    return false;
  }

  // ---------- 发送消息 ----------
  function _sendMessage() {
    var input = document.getElementById('paChatInput');
    var text = (input.value || '').trim();
    if (!text) return;
    _addMessage('user', text);
    input.value = '';
    input.style.height = 'auto';

    // 视图切换快捷方式（精确匹配才拦截，自然语言交给 AI）
    var lowerText = text.toLowerCase();
    if (lowerText === '书架' || lowerText === '返回书架') { _doAction('shelf'); _addMessage('bot', '已切换到书架视图'); return; }
    if (lowerText === '阅读' || lowerText === '阅读模式') { _doAction('read'); _addMessage('bot', '已切换到阅读模式'); return; }
    if (lowerText === '笔记' || lowerText === '笔记模式') { _doAction('note'); _addMessage('bot', '已切换到笔记模式'); return; }
    if (lowerText === '附件' || lowerText === '附件管理') { _doAction('attach'); _addMessage('bot', '已切换到附件管理'); return; }
    if (lowerText === '划重点') { _doAction('highlight'); return; }
    if (lowerText === '设置' || lowerText === 'ai设置') { _doAction('settings'); return; }
    if (lowerText === '帮助' || lowerText === '教程') { _doAction('help'); return; }

    // 本地章节跳转拦截（不经过 LLM，零 token、零轮次，秒完成）
    // 支持：跳/翻/定位/去/转到 + 第X章/节/节次/部分 + 目录名
    var chapterJump = _tryLocalChapterJump(text);
    if (chapterJump) return;

    // 核心架构：Tool Calling / Function Calling
    // AI 直接拥有底层 API 调用权 — 不再模拟 DOM 点击，直接调 PDFReader/PDFAnnotate/_doAction 等函数
    _aiChatWithTools(text);
  }

  // ---------- AI 对话 ----------
  function _aiChat(userText) {
    var config = null;
    if (typeof AppShell !== 'undefined' && AppShell.getAIConfig) {
      config = AppShell.getAIConfig();
    }
    if (!config || !config.apiKey) {
      _addMessage('bot', '⚠ 尚未配置 AI API Key，请先点击 ⚡ → 「AI 设置」配置。\n\n或者输入以下快捷指令：\n书架 / 阅读 / 笔记 / 附件 / 划重点 / 帮助');
      return;
    }

    // 添加"正在思考"占位消息
    var body = document.getElementById('paChatBody');
    var thinking = document.createElement('div');
    thinking.className = 'pa-msg pa-msg-bot pa-msg-thinking';
    thinking.innerHTML = '<span class="pa-dot"></span><span class="pa-dot"></span><span class="pa-dot"></span>';
    body.appendChild(thinking);
    body.scrollTop = body.scrollHeight;

    // 构建上下文消息（降级模式：仅当 PageAgent 不可用时使用此纯问答路径）
    var messages = [
      { role: 'system', content: '你是"书虫助手"，一个嵌入在文献阅读器中的 AI 助手。用户正在阅读学术文献/教材，你可以帮助解答问题、解释概念、总结要点。请简洁明了地回答，使用 Markdown 格式。' }
    ];

    // 收集最近几轮对话作为上下文
    var allMsgs = body.querySelectorAll('.pa-msg');
    var historyCount = 0;
    for (var i = allMsgs.length - 1; i >= 0 && historyCount < 6; i--) {
      var m = allMsgs[i];
      if (m === thinking) continue;
      var isUser = m.classList.contains('pa-msg-user');
      var content = m.textContent || '';
      if (content.trim()) {
        messages.splice(1, 0, { role: isUser ? 'user' : 'assistant', content: content });
        historyCount++;
      }
    }

    // 获取当前 PDF 上下文（如果有）
    var pdfContext = '';
    try {
      if (typeof PDFReader !== 'undefined' && PDFReader.getCurrentPage) {
        var pageNum = PDFReader.getCurrentPage();
        var pageCount = PDFReader.getPageCount ? PDFReader.getPageCount() : 0;
        if (pageNum > 0) {
          pdfContext = '（用户当前正在阅读第 ' + pageNum + ' 页' + (pageCount > 0 ? '，共 ' + pageCount + ' 页' : '') + '）';
          messages[0].content += '\n' + pdfContext;
        }
      }
    } catch (e) {}

    // 调用 AI
    var provider = config.provider || 'openai';
    var baseUrl = config.baseUrl || '';
    var apiKey = config.apiKey || '';
    var model = config.model || '';

    AIAdapter.chat(provider, baseUrl, apiKey, messages, { model: model, temperature: 0.7, max_tokens: 1500 })
      .then(function(reply) {
        thinking.remove();
        _addMessage('bot', reply || '(空回复)');
      })
      .catch(function(e) {
        thinking.remove();
        var errMsg = e && e.message ? e.message : String(e);
        _addMessage('bot', '⚠ AI 请求失败：' + errMsg + '\n\n请检查 API 配置是否正确。');
      });
  }

  // ===========================================================================
  // ⭐ 工具调用（Tool Calling / Function Calling）架构核心
  //   AI 直接拥有底层 API 的完整调用权限，不再模拟 DOM 点击。
  //   每个工具对应一个真实的 JS 函数调用，零额外 DOM 开销，零视觉干扰。
  //   关键操作（删除类）走审批，其他全自动执行。
  // ===========================================================================

  // 工具清单（OpenAI/DeepSeek 兼容 JSON Schema）
  // 新增工具只需在这里加一条：{type, function: {name, description, parameters, required}, handler}
  function _getToolDefinitions() {
    var builtIn = [
      // -------------------- PDF 阅读器控制 --------------------
      {
        type: 'function',
        function: {
          name: 'pdf_jumpToPage',
          description: '跳转到 PDF 指定页码。如果跳转成功，会自动把"目录页码偏移已确认=true"写入 harness 记忆（下次无需再读目录页核对）。',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', description: '目标页码（从 1 开始）' },
              _skipMemo: { type: 'boolean', description: '（内部）不写 harness 记忆，仅在批量翻页内部调用时传 true' }
            },
            required: ['page']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFReader === 'undefined' || !PDFReader.jumpToPage) throw new Error('PDFReader 不可用');
          var total = PDFReader.getPageCount ? PDFReader.getPageCount() : 0;
          var n = Math.max(1, Math.min(args.page|0, total || args.page|0));
          return PDFReader.jumpToPage(n).then(function() {
            var vp = document.getElementById('pdfViewport');
            if (vp) vp.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // 成功跳页 → 自动写 harness 记忆：本书记忆的 pageOffsetVerified=true
            if (!args._skipMemo) {
              try {
                var curBid = _hmCurrentBookId();
                if (curBid && curBid !== '__current__') _hmMarkBookVerified(curBid, true, 0);
              } catch (e) {}
            }
            return '已切换到第 ' + n + ' 页' + (total > 0 ? '（共 ' + total + ' 页）' : '')
              + (!args._skipMemo ? '\n💾 已写入 harness 记忆：本页面码偏移已确认，下次跳章节不再核对目录页。' : '');
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'pdf_prevPage',
          description: '翻到上一页',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof PDFReader === 'undefined' || !PDFReader.prevPage) throw new Error('PDFReader 不可用');
          if (PDFReader.getCurrentPage && PDFReader.getCurrentPage() <= 1) return '已经是第 1 页，没有上一页';
          PDFReader.prevPage();
          var now = PDFReader.getCurrentPage ? PDFReader.getCurrentPage() : '上一';
          return '⬅ 已翻到第 ' + now + ' 页';
        }
      },
      {
        type: 'function',
        function: {
          name: 'pdf_nextPage',
          description: '翻到下一页',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof PDFReader === 'undefined' || !PDFReader.nextPage) throw new Error('PDFReader 不可用');
          var total = PDFReader.getPageCount ? PDFReader.getPageCount() : 0;
          if (total > 0 && PDFReader.getCurrentPage && PDFReader.getCurrentPage() >= total) return '已到最后一页（共 ' + total + ' 页）';
          PDFReader.nextPage();
          var now = PDFReader.getCurrentPage ? PDFReader.getCurrentPage() : '下一';
          return '➡ 已翻到第 ' + now + ' 页';
        }
      },
      {
        type: 'function',
        function: {
          name: 'pdf_setZoom',
          description: '设置 PDF 缩放比例',
          parameters: {
            type: 'object',
            properties: {
              level: { type: 'string', description: "缩放级别：数值（如 '1.5' 表示 150%、'120' 表示 120%）或 'auto' 自适应宽度、'in' 放大一级、'out' 缩小一级" }
            },
            required: ['level']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFReader === 'undefined' || !PDFReader.setZoom) throw new Error('PDFReader 不可用');
          var lv = (args.level || 'auto').toString().trim().toLowerCase();
          if (lv === 'in') {
            var cur = typeof PDFReader.getCurrentZoom === 'function' ? PDFReader.getCurrentZoom() : 1;
            PDFReader.setZoom((Number(cur)||1) * 1.25);
            return '🔍 已放大 25%';
          }
          if (lv === 'out') {
            var cur2 = typeof PDFReader.getCurrentZoom === 'function' ? PDFReader.getCurrentZoom() : 1;
            PDFReader.setZoom((Number(cur2)||1) * 0.8);
            return '🔍 已缩小 20%';
          }
          if (lv === 'auto' || lv === '自适应' || lv === '自适应宽度') {
            PDFReader.setZoom('auto');
            return '✅ 已设置为自适应宽度';
          }
          var z = Number(lv);
          if (isNaN(z)) throw new Error('无法识别的缩放级别: ' + args.level);
          if (z > 10) z = z / 100; // 120 → 1.2
          PDFReader.setZoom(z);
          return '🔍 缩放已设置为 ' + Math.round(z*100) + '%';
        }
      },
      {
        type: 'function',
        function: {
          name: 'pdf_toggleTOC',
          description: '展开或收起 PDF 目录/大纲',
          parameters: {
            type: 'object',
            properties: {
              show: { type: 'boolean', description: 'true=显示/展开目录，false=关闭/收起目录，留空=切换当前状态' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFReader === 'undefined') throw new Error('PDFReader 不可用');
          if (PDFReader.renderTOC) PDFReader.renderTOC();
          if (PDFReader.toggleTOC) {
            if (args.show !== undefined) PDFReader.toggleTOC(!!args.show);
            else PDFReader.toggleTOC();
            return args.show === false ? '📑 已收起目录' : args.show === true ? '📑 已展开目录' : '📑 目录状态已切换';
          }
          return '📑 目录已刷新';
        }
      },
      {
        type: 'function',
        function: {
          name: 'pdf_getStatus',
          description: '获取 PDF 当前阅读状态：页码、总页数、缩放比例',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          var out = {};
          if (typeof PDFReader !== 'undefined') {
            if (PDFReader.getCurrentPage) out.currentPage = PDFReader.getCurrentPage();
            if (PDFReader.getPageCount) out.totalPages = PDFReader.getPageCount();
            if (PDFReader.getCurrentZoom) out.zoomPercent = Math.round(Number(PDFReader.getCurrentZoom()||1)*100);
          }
          if (typeof PDFAnnotate !== 'undefined' && PDFAnnotate.getTool) out.currentAnnotationTool = PDFAnnotate.getTool() || 'none';
          return JSON.stringify(out);
        }
      },

      // -------------------- 标注工具控制 --------------------
      {
        type: 'function',
        function: {
          name: 'annot_setTool',
          description: '切换 PDF 标注工具栏的当前工具',
          parameters: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                enum: ['highlight', 'underline', 'rect', 'pen', 'card', 'select', 'none'],
                description: "工具名：highlight=高亮 underline=下划线 rect=矩形框 pen=钢笔手绘 card=卡片注释 select=编辑选择 none=取消工具"
              }
            },
            required: ['tool']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFAnnotate === 'undefined' || !PDFAnnotate.setTool) throw new Error('PDFAnnotate 不可用');
          var t = args.tool === 'none' ? null : args.tool;
          PDFAnnotate.setTool(t);
          var names = {highlight:'🖍 高亮标记', underline:'﹏ 下划线', rect:'⬜ 矩形框', pen:'🖊 钢笔手绘', card:'📝 解释卡片', select:'✎ 编辑选择'};
          return t === null ? '✅ 已退出标注工具，回到纯阅读模式' : '🎯 已切换到「' + (names[t]||t) + '」工具';
        }
      },
      {
        type: 'function',
        function: {
          name: 'annot_deleteSelected',
          description: '删除当前已选中的所有标注（关键操作：需要用户审批）',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: true,
        approvalPrompt: function() {
          var sel = (typeof PDFAnnotate !== 'undefined' && PDFAnnotate.getSelected) ? PDFAnnotate.getSelected() : [];
          var n = sel && sel.length ? sel.length : 0;
          return '即将删除当前选中的 ' + n + ' 个标注，是否确认？';
        },
        handler: function() {
          if (typeof PDFAnnotate === 'undefined') throw new Error('PDFAnnotate 不可用');
          var sel = PDFAnnotate.getSelected && PDFAnnotate.getSelected();
          var n = sel && sel.length ? sel.length : 0;
          if (n === 0) return '当前没有选中任何标注';
          if (PDFAnnotate.deleteSelected) PDFAnnotate.deleteSelected();
          return '🗑 已删除选中的 ' + n + ' 个标注';
        }
      },
      // -------------------- 标注查询 / 批量选中（AI 可按文本查询 author=ai 和 user 的所有标注） --------------------
      {
        type: 'function',
        function: {
          name: 'annot_query',
          description: '在划重点层检索标注（支持关键词、页码、类型、作者过滤，AI生成的 author=ai 标注也可被检索到）',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', description: '可选，只检索指定页码；留空则检索全书所有页' },
              keyword: { type: 'string', description: '可选，按文本/引用/备注模糊匹配关键词' },
              kind: { type: 'string', enum: ['highlight', 'underline', 'rect', 'pen', 'card'], description: '可选，按标注类型过滤' },
              author: { type: 'string', enum: ['user', 'ai'], description: '可选，按作者过滤：user=用户手动画的 ai=AI 生成的' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFAnnotate === 'undefined' || !PDFAnnotate.queryAnnotations) throw new Error('PDFAnnotate.queryAnnotations 不可用');
          var results = PDFAnnotate.queryAnnotations({ page: args.page, keyword: args.keyword, kind: args.kind, author: args.author });
          if (!results.length) return '（没有匹配的标注）';
          var preview = results.slice(0, 50).map(function(r) {
            var line = '· P' + r.page + ' [' + r.kind + '/' + r.author + '] #' + r.id;
            if (r.quote) line += ' quote=' + JSON.stringify(r.quote.slice(0, 60));
            else if (r.text) line += ' text=' + JSON.stringify(r.text.slice(0, 60));
            if (r.note) line += ' note=' + JSON.stringify(r.note.slice(0, 40));
            if (r.rect) line += ' rect=' + JSON.stringify(r.rect);
            return line;
          }).join('\n');
          return '共匹配 ' + results.length + ' 条标注：\n' + preview + (results.length > 50 ? '\n（仅显示前 50 条，可缩小检索范围）' : '');
        }
      },
      {
        type: 'function',
        function: {
          name: 'annot_selectByIds',
          description: '根据 annot_query 返回的标注 ID，在划重点层直接选中这些标注（支持批量），之后即可使用 annot_deleteSelected 批量删除',
          parameters: {
            type: 'object',
            properties: {
              ids: { type: 'array', items: { type: 'string' }, description: '要选中的标注 ID 数组（来自 annot_query）' },
              additive: { type: 'boolean', description: 'true=追加到当前选中，false=先清空再选。默认 false' }
            },
            required: ['ids']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFAnnotate === 'undefined' || !PDFAnnotate.selectByIds) throw new Error('PDFAnnotate.selectByIds 不可用');
          PDFAnnotate.selectByIds(args.ids || [], !!args.additive);
          var cur = PDFAnnotate.getSelected && PDFAnnotate.getSelected();
          return '✅ 已在划重点层选中 ' + (cur ? cur.length : 0) + ' 个标注；可调用 annot_deleteSelected 删除它们，或跳转查看页面对应位置调整。';
        }
      },
      // -------------------- 基于坐标的标注创建（无需鼠标拖动，AI 可直接按坐标创建框/下划线/高亮/卡片） --------------------
      {
        type: 'function',
        function: {
          name: 'annot_addByRect',
          description: '通过直接确定坐标范围在划重点层创建标注（高亮/下划线/矩形框/卡片），无需鼠标拖动。坐标单位=PDF页内像素（与 pdfjs 默认视口一致），先通过 annot_query 或 pdf_getPageTextRects 获取目标坐标再调用。',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', description: '页码（必填，从 1 开始）' },
              kind: { type: 'string', enum: ['highlight', 'underline', 'rect', 'card'], description: '标注类型：highlight=高亮填充 underline=下划线 rect=矩形框 card=解释卡片' },
              x: { type: 'number', description: '左上角 X' },
              y: { type: 'number', description: '左上角 Y' },
              w: { type: 'number', description: '宽度' },
              h: { type: 'number', description: '高度' },
              color: { type: 'string', description: '颜色，默认按类型取划重点层当前配色' },
              text: { type: 'string', description: '可选，标注对应的正文文本（匹配则在卡片/备注中展示）' },
              quote: { type: 'string', description: '可选，引用文字（在卡片标题中显示）' },
              note: { type: 'string', description: '可选，卡片的备注/解释内容（kind=card 时建议必填）' },
              title: { type: 'string', description: '可选，卡片标题（kind=card 时生效）' },
              author: { type: 'string', enum: ['user', 'ai'], description: '标注作者：user=用户手动 ai=AI 助手创建，默认 ai；用来 annot_query 按作者过滤' }
            },
            required: ['page', 'kind', 'x', 'y', 'w', 'h']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFAnnotate === 'undefined' || !PDFAnnotate.addElement) throw new Error('PDFAnnotate.addElement 不可用');
          var page = parseInt(args.page, 10) || 0;
          if (page < 1) throw new Error('page 必须 >= 1');
          var x = Number(args.x), y = Number(args.y), w = Number(args.w), h = Number(args.h);
          if (!(w > 0) || !(h > 0)) throw new Error('w 和 h 必须是正数');
          var kind = args.kind;
          var author = (args.author === 'user' || args.author === 'ai') ? args.author : 'ai';
          var el = {
            kind: kind,
            author: author,
            rect: { x: x, y: y, w: w, h: h },
            color: args.color || (kind === 'underline' ? '#1a73e8' : (kind === 'rect' ? '#1a73e8' : (kind === 'card' ? '#fff4bf' : '#ffe066'))),
            text: args.text || '',
            quote: args.quote || ''
          };
          if (kind === 'card') {
            el.title = args.title || '';
            el.note = args.note || '';
          }
          var created = PDFAnnotate.addElement(page, el);
          // 如果是当前页，选中新建元素便于用户立即看到
          if (created && PDFAnnotate.getCurrentPage && PDFAnnotate.getCurrentPage() === page) {
            try { PDFAnnotate.selectByIds([created.id], false); } catch(e){}
          }
          return '✅ 已在第 ' + page + ' 页创建「' + kind + '」标注（id=' + created.id + ', author=' + author + '），rect={' + x.toFixed(0) + ',' + y.toFixed(0) + ',' + w.toFixed(0) + ',' + h.toFixed(0) + '}。' +
                 (kind === 'card' && el.title ? ' 卡片标题：' + el.title : '');
        }
      },
      {
        type: 'function',
        function: {
          name: 'annot_addByQuotes',
          description: '让划重点层自动在 PDF 中搜索指定关键词/引用句的位置，并按匹配位置自动批量创建标注（无需手动指定坐标）。适合"把所有出现 XX 的段落高亮出来"这类需求。',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', description: '可选，只搜索指定页码（向后兼容）；推荐用 pages 数组' },
              pages: { type: 'array', items: { type: 'integer' }, description: '可选，多页码数组如 [1,2,3]；留空则搜索全书所有页' },
              kind: { type: 'string', enum: ['highlight', 'underline', 'rect', 'card'], description: '标注类型' },
              keyword: { type: 'string', description: '要搜索的关键词/引用句（精确或子串匹配）' },
              color: { type: 'string', description: '颜色（可选）' },
              maxMatches: { type: 'integer', description: '可选，最多匹配数，默认 20，避免一次性标注过多' },
              asCardNotes: { type: 'boolean', description: 'true=创建卡片时把匹配文字放到卡片备注里' },
              author: { type: 'string', enum: ['user', 'ai'], description: '标注作者，默认 ai' }
            },
            required: ['kind', 'keyword']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFAnnotate === 'undefined' || !PDFAnnotate.addElement) throw new Error('PDFAnnotate 不可用');
          if (!args.keyword) throw new Error('keyword 必填');
          var kw = String(args.keyword);
          var max = parseInt(args.maxMatches || '20', 10) || 20;
          var raw = args.pages !== undefined ? args.pages : args.page;
          var pages;
          if (raw === undefined || raw === null || raw === '') {
            pages = (PDFAnnotate.getAllPages ? PDFAnnotate.getAllPages() : []);
            if (!pages.length && PDFAnnotate.getCurrentPage) pages = [PDFAnnotate.getCurrentPage()];
          } else if (Array.isArray(raw)) {
            pages = raw.map(function(v){ return parseInt(v, 10) || 0; }).filter(function(v){ return v >= 1; });
          } else {
            var n = parseInt(raw, 10);
            pages = (n >= 1) ? [n] : [];
          }
          var kind = args.kind;
          var author = (args.author === 'user' || args.author === 'ai') ? args.author : 'ai';
          var color = args.color || (kind === 'underline' ? '#1a73e8' : (kind === 'rect' ? '#1a73e8' : (kind === 'card' ? '#fff4bf' : '#ffe066')));
          var createdIds = [];
          // 遍历每页：先用 locateQuote 找位置（如果有），否则用 pdf_getPageTextRects 语义走 getTextRects
          var tryLocate = (typeof PDFAnnotate.locateQuote === 'function') ? PDFAnnotate.locateQuote : null;
          var getTextRects = (typeof PDFAnnotate.getTextRects === 'function') ? PDFAnnotate.getTextRects : null;
          var findOnPage = function(pn) {
            if (tryLocate) {
              try {
                var r = tryLocate(pn, kw, 1, max);
                if (r && r.ok && r.matches && r.matches.length) return r.matches.map(function(m){ return m.rect; });
              } catch(e) {}
            }
            if (getTextRects) {
              try {
                var rects = [];
                var arr = getTextRects(pn, kw);
                if (arr && arr.length) {
                  // 合并多 token 的 rect 成一个包围盒（一行内）
                  // 简单处理：每个 rect 建一个标注
                  for (var i = 0; i < arr.length; i++) {
                    if (createdIds.length >= max) break;
                    rects.push(arr[i]);
                  }
                  return rects.slice(0, max - createdIds.length);
                }
              } catch(e) {}
            }
            return [];
          };
          for (var pi = 0; pi < pages.length; pi++) {
            if (createdIds.length >= max) break;
            var pn = pages[pi];
            var rects = findOnPage(pn);
            for (var ri = 0; ri < rects.length; ri++) {
              if (createdIds.length >= max) break;
              var rc = rects[ri];
              if (!rc) continue;
              var el = {
                kind: kind,
                author: author,
                rect: { x: rc.x, y: rc.y, w: rc.w, h: rc.h },
                color: color,
                text: kw,
                quote: kw
              };
              if (kind === 'card') {
                el.title = kw.slice(0, 40);
                el.note = args.asCardNotes ? kw : '';
              }
              var c = PDFAnnotate.addElement(pn, el);
              if (c && c.id) createdIds.push(c.id);
            }
          }
          if (!createdIds.length) return '⚠ 没有找到「' + kw + '」的文本匹配位置，未创建标注。可尝试使用 annot_addByRect 直接指定坐标，或先调用 pdf_getPageTextRects 查看页面文本。';
          return '✅ 共创建 ' + createdIds.length + ' 个「' + kind + '」标注（搜索：' + kw + '），ids: ' + createdIds.join(', ');
        }
      },
      // -------------------- E2-03: 批量查坐标（不画图） --------------------
      {
        type: 'function',
        function: {
          name: 'annot_locateQuotesBatch',
          description: '【仅查坐标不画图】在一页或多页 PDF 中批量查找多个关键词/短语的精确位置。用于「书虫助手先定位再显式用 annot_addBatchByRect 画标注」的链路，避免一次性瞎猜坐标。优先用 PDFAnnotate.locateQuote，失败自动降级用 getTextRects 按子串匹配。',
          parameters: {
            type: 'object',
            properties: {
              pages: { type: 'array', items: { type: 'integer' }, description: '页码数组（1 开始），如 [1,2,3]；留空=当前页' },
              queries: {
                type: 'array',
                description: '要查的关键词列表，每项都是 { keyword, kindHint? }，kindHint = h|u|r|c 对应 highlight|underline|rect|card（仅用于返回便于后续构造标注，不影响定位）',
                items: {
                  type: 'object',
                  properties: {
                    keyword: { type: 'string', description: '必须来自原文原样复制，避免空格/标点差异；长度建议 4-30 字' },
                    kindHint: { type: 'string', enum: ['h','u','r','c','highlight','underline','rect','card'], description: '可选，提示该关键词将来用哪种标注类型；仅透传返回' }
                  },
                  required: ['keyword']
                }
              },
              maxMatchesPerKw: { type: 'integer', description: '每个关键词最多返回几处匹配，默认 20；-1 表示不限制（最多每页 100）' }
            },
            required: ['queries']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          try {
            if (typeof PDFAnnotate === 'undefined') throw new Error('PDFAnnotate 不可用');
            if (!args.queries || !args.queries.length) throw new Error('queries 必填且非空');
            var tryLocate = (typeof PDFAnnotate.locateQuote === 'function') ? PDFAnnotate.locateQuote : null;
            var getTextRects = (typeof PDFAnnotate.getTextRects === 'function') ? PDFAnnotate.getTextRects : null;
            var max = parseInt(args.maxMatchesPerKw, 10);
            if (!max || max <= 0) max = args.maxMatchesPerKw === -1 ? 1000 : 20;
            var pages = args.pages && args.pages.length ? args.pages.map(function(v){ return parseInt(v,10)||0; }).filter(function(v){ return v>=1; }) : [];
            if (!pages.length && PDFAnnotate.getCurrentPage) pages = [PDFAnnotate.getCurrentPage()];
            var out = [];
            for (var qi = 0; qi < args.queries.length; qi++) {
              var q = args.queries[qi];
              var kw = (q && q.keyword) ? String(q.keyword).trim() : '';
              var item = { queryIndex: qi, keyword: kw, kindHint: q && q.kindHint ? q.kindHint : '', byPage: [] };
              if (!kw) { item.err = 'keyword 为空'; out.push(item); continue; }
              var totalFound = 0;
              for (var pi = 0; pi < pages.length; pi++) {
                if (totalFound >= max) break;
                var pn = pages[pi];
                var perPage = { page: pn, matches: [], reason: '' };
                var matchesForPage = [];
                if (tryLocate) {
                  try {
                    var r = tryLocate(pn, kw, 1, Math.max(1, max - totalFound));
                    if (r && r.ok && r.matches && r.matches.length) {
                      matchesForPage = r.matches.map(function(m){
                        return { rect: m.rect, quoteFragment: (m.quote || kw).slice(0,60) };
                      });
                    }
                  } catch(e) { /* ignore */ }
                }
                if (!matchesForPage.length && getTextRects) {
                  try {
                    var arr = getTextRects(pn, kw);
                    if (arr && arr.length) {
                      var rows = {};
                      for (var ai = 0; ai < arr.length; ai++) {
                        var rec = arr[ai];
                        var key = Math.round(rec.y) + '_' + Math.round(rec.h);
                        if (!rows[key]) rows[key] = [];
                        rows[key].push(rec);
                      }
                      for (var k in rows) {
                        if (totalFound + matchesForPage.length >= max) break;
                        var row = rows[k];
                        var xs = row.map(function(rr){ return rr.x; });
                        var ys = row.map(function(rr){ return rr.y; });
                        var xe = row.map(function(rr){ return rr.x + rr.w; });
                        var ye = row.map(function(rr){ return rr.y + rr.h; });
                        var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xe);
                        var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ye);
                        matchesForPage.push({ rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, quoteFragment: kw.slice(0,60) });
                      }
                    }
                  } catch(e) { /* ignore */ }
                }
                var remain = max - totalFound;
                if (matchesForPage.length > remain) matchesForPage = matchesForPage.slice(0, remain);
                perPage.matches = matchesForPage;
                if (!matchesForPage.length) perPage.reason = 'notFound';
                totalFound += matchesForPage.length;
                item.byPage.push(perPage);
              }
              out.push(item);
            }
            var summary = out.map(function(it){
              var cnt = 0;
              for (var i = 0; i < it.byPage.length; i++) cnt += (it.byPage[i].matches ? it.byPage[i].matches.length : 0);
              return it.keyword + '=' + cnt + '处';
            }).join('; ');
            return '🔎 共查 ' + args.queries.length + ' 个关键词（' + summary + '）。\n完整结构（按 byPage 取 rect 即可）：\n' + JSON.stringify(out, null, 2).slice(0, 6000);
          } catch(e) {
            return '❌ annot_locateQuotesBatch 失败：' + (e && e.message ? e.message : e) + '（上下文：queries=' + JSON.stringify(args && args.queries).slice(0,200) + '）';
          }
        }
      },
      // -------------------- E2-04: 批量创建标注（分批出让主线程） --------------------
      {
        type: 'function',
        function: {
          name: 'annot_addBatchByRect',
          description: '【批量创建标注】一次提交多页多条标注（高亮/下划线/矩形框/卡片），内部每 20 条 setTimeout(16) 让出主线程，避免一次性画 100+ 条卡顿。单条失败不影响其他，返回 created/failed 明细便于 AI 后续 annot_modifyElement 补救。注意：此函数是 async 返回 Promise，调用方必须 await。',
          parameters: {
            type: 'object',
            properties: {
              annotations: {
                type: 'array',
                description: '标注数组，每项 = {page, kind, x, y, w, h, color?, text?, quote?, note?, title?, author?}，page≥1，w>0, h>0',
                items: {
                  type: 'object',
                  properties: {
                    page: { type: 'integer' }, kind: { type: 'string', enum: ['highlight','underline','rect','card','pen'] },
                    x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                    color: { type: 'string' }, text: { type: 'string' }, quote: { type: 'string' },
                    note: { type: 'string' }, title: { type: 'string' }, author: { type: 'string', enum: ['user','ai'] }
                  },
                  required: ['page','kind','x','y','w','h']
                }
              }
            },
            required: ['annotations']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFAnnotate === 'undefined' || !PDFAnnotate.addElement) {
            return Promise.reject(new Error('PDFAnnotate.addElement 不可用'));
          }
          var list = args.annotations;
          if (!Array.isArray(list) || list.length === 0) return Promise.resolve('⚠ annotations 为空，未创建任何标注');
          if (list.length > 1000) {
            return Promise.resolve('⚠ 本次提交 ' + list.length + ' 条超过 1000 条上限；请按 5-8 页为一批分开 annot_addBatchByRect，每批之间给用户汇报进度。');
          }
          var created = [];
          var failed = [];
          var curPage = (PDFAnnotate.getCurrentPage && PDFAnnotate.getCurrentPage()) || 0;
          var processChunk = function(startIdx) {
            var end = Math.min(startIdx + 20, list.length);
            for (var i = startIdx; i < end; i++) {
              try {
                var a = list[i];
                var page = parseInt(a.page, 10) || 0;
                var x = Number(a.x), y = Number(a.y), w = Number(a.w), h = Number(a.h);
                if (!(page >= 1)) throw new Error('page 必须 >= 1');
                if (!(w > 0) || !(h > 0)) throw new Error('w 和 h 必须为正');
                var kind = a.kind;
                var author = (a.author === 'user' || a.author === 'ai') ? a.author : 'ai';
                var defaultColor = kind === 'underline' ? '#2563eb'
                                 : kind === 'rect'      ? '#dc2626'
                                 : kind === 'card'      ? '#fff4bf'
                                 : '#ffe066';
                var el = {
                  kind: kind, author: author,
                  rect: { x: x, y: y, w: w, h: h },
                  color: a.color || defaultColor,
                  text: a.text || '',
                  quote: a.quote || ''
                };
                if (kind === 'card') { el.title = a.title || ''; el.note = a.note || ''; }
                var res = PDFAnnotate.addElement(page, el);
                if (!res || !res.id) throw new Error('PDFAnnotate.addElement 返回空');
                created.push({ index: i, id: res.id, page: page, kind: kind });
                if (page === curPage) {
                  try { PDFAnnotate.selectByIds && PDFAnnotate.selectByIds([res.id], true); } catch(e){}
                }
              } catch(e) {
                failed.push({ index: i, reason: (e && e.message ? e.message : String(e)) });
              }
            }
            if (end >= list.length) {
              return '🎨 批量创建结束：✅ 成功 ' + created.length + ' 处 / ❌ 失败 ' + failed.length + ' 处' +
                     (created.length ? '（首个 id=' + created[0].id + '）' : '') +
                     (failed.length ? '\n失败明细（前 5 条）:\n' + failed.slice(0,5).map(function(f){ return '  #' + f.index + ': ' + f.reason; }).join('\n') : '');
            }
            return new Promise(function(resolve){ setTimeout(function(){ resolve(processChunk(end)); }, 16); });
          };
          return Promise.resolve(processChunk(0));
        }
      },
      // -------------------- E2-05: 修改已存在标注 --------------------
      {
        type: 'function',
        function: {
          name: 'annot_modifyElement',
          description: '修改单个已存在标注的颜色/文本/备注/标题/尺寸。用 annot_query 取到 id 后调用。patch 是浅合并（只改给的键，保留其他键）。用于「回读校验后合并颜色/卡片解释美化/合并相邻下划线宽度」等调整场景。',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '标注 id（来自 annot_query / annot_addByRect / annot_addBatchByRect）' },
              patch: {
                type: 'object',
                description: '要改的字段：color/quote/text/note/title/rect(支持局部键 x?/y?/w?/h?)',
                properties: {
                  color: { type: 'string' },
                  quote: { type: 'string' },
                  text:  { type: 'string' },
                  note:  { type: 'string' },
                  title: { type: 'string' },
                  rect:  {
                    type: 'object',
                    description: 'rect 内只给需要改的键即可；例：{w: 300} 仅加宽，原 x/y/h 不变',
                    properties: { x:{type:'number'}, y:{type:'number'}, w:{type:'number'}, h:{type:'number'} }
                  }
                }
              }
            },
            required: ['id', 'patch']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          try {
            if (typeof PDFAnnotate === 'undefined') throw new Error('PDFAnnotate 不可用');
            var id = String(args.id || '').trim();
            if (!id) throw new Error('id 必填');
            if (!args.patch || typeof args.patch !== 'object') throw new Error('patch 必须是对象');
            var current = null;
            if (typeof PDFAnnotate.queryAnnotations === 'function') {
              var all = PDFAnnotate.queryAnnotations({});
              if (Array.isArray(all)) {
                for (var i = 0; i < all.length; i++) { if (all[i].id === id) { current = all[i]; break; } }
              }
            }
            if (!current) throw new Error('Annotation ' + id + ' not found. 请先 annot_query 确认存在');
            var patch = args.patch;
            var next = {
              id: current.id,
              page: current.page,
              kind: current.kind,
              author: current.author,
              color: patch.color !== undefined ? patch.color : current.color,
              quote: patch.quote !== undefined ? patch.quote : current.quote,
              text:  patch.text  !== undefined ? patch.text  : current.text,
              rect:  current.rect ? { x: current.rect.x, y: current.rect.y, w: current.rect.w, h: current.rect.h } : null
            };
            if (patch.rect && next.rect) {
              if (patch.rect.x !== undefined) next.rect.x = Number(patch.rect.x);
              if (patch.rect.y !== undefined) next.rect.y = Number(patch.rect.y);
              if (patch.rect.w !== undefined) next.rect.w = Number(patch.rect.w);
              if (patch.rect.h !== undefined) next.rect.h = Number(patch.rect.h);
            }
            if (current.kind === 'card') {
              next.title = patch.title !== undefined ? patch.title : current.title;
              next.note  = patch.note  !== undefined ? patch.note  : current.note;
            }
            var updated = null;
            if (typeof PDFAnnotate.updateElement === 'function') {
              updated = PDFAnnotate.updateElement(current.page, id, next);
            } else if (typeof PDFAnnotate.removeById === 'function' && typeof PDFAnnotate.addElement === 'function') {
              try { PDFAnnotate.removeById(current.page, id); } catch(e){}
              next.id = id;
              updated = PDFAnnotate.addElement(current.page, next);
            } else {
              throw new Error('PDFAnnotate 没有 updateElement / removeById + addElement API，无法修改标注');
            }
            return '✏️ annot_modifyElement 成功（id=' + id + '）。现在：' +
                   ' kind=' + (updated && updated.kind ? updated.kind : next.kind) +
                   ' color=' + (updated && updated.color ? updated.color : next.color) +
                   (next.rect ? ' rect=' + JSON.stringify(next.rect) : '');
          } catch(e) {
            return '❌ annot_modifyElement 失败：' + (e && e.message ? e.message : e) + '（id=' + (args&&args.id) + '）';
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'annot_removeById',
          description: '根据 ID 删除单个标注（无需先选中）',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', description: '页码' },
              id: { type: 'string', description: '标注 ID（来自 annot_query）' }
            },
            required: ['page', 'id']
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将删除第 ' + args.page + ' 页的标注 id=' + (args.id||'') + '，确认？'; },
        handler: function(args) {
          if (typeof PDFAnnotate === 'undefined' || !PDFAnnotate.removeElement) throw new Error('PDFAnnotate.removeElement 不可用');
          PDFAnnotate.removeElement(parseInt(args.page), args.id);
          return '🗑 已删除标注 id=' + args.id;
        }
      },

      // -------------------- 视图切换 --------------------
      {
        type: 'function',
        function: {
          name: 'ui_switchView',
          description: '切换阅读器的主视图（标签页）',
          parameters: {
            type: 'object',
            properties: {
              view: {
                type: 'string',
                enum: ['shelf', 'read', 'note', 'attach', 'highlight', 'settings', 'help'],
                description: "shelf=书架 read=阅读模式 note=笔记模式 attach=附件管理 highlight=划重点模式 settings=设置 help=帮助"
              }
            },
            required: ['view']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          _doAction(args.view);
          var names = {shelf:'书架', read:'阅读模式', note:'笔记模式', attach:'附件管理', highlight:'划重点模式', settings:'设置面板', help:'帮助'};
          return '✅ 已切换到「' + (names[args.view]||args.view) + '」';
        }
      },

      // ======================================================================
      //  笔记空间管理（NoteFileManager）：笔记/文件夹的新建/重命名/删除/复制/移动
      // ======================================================================
      {
        type: 'function',
        function: {
          name: 'note_new',
          description: '在当前教材的笔记空间中新建一本笔记（独立笔记）',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '新笔记的名称（留空则使用默认名称）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof NoteFileManager === 'undefined') throw new Error('NoteFileManager 不可用');
          NoteFileManager.newNote(null, args.name || undefined);
          return '📝 已新建笔记' + (args.name ? '「' + args.name + '」' : '');
        }
      },
      {
        type: 'function',
        function: {
          name: 'note_newFolder',
          description: '在当前教材的笔记空间中新建一个文件夹，用于分组管理笔记',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '文件夹名称' }
            },
            required: ['name']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof NoteFileManager === 'undefined') throw new Error('NoteFileManager 不可用');
          NoteFileManager.newFolder(null, args.name);
          return '📁 已新建文件夹「' + args.name + '」';
        }
      },
      {
        type: 'function',
        function: {
          name: 'note_list',
          description: '列出当前教材的笔记空间中所有笔记和文件夹的树形结构（含名称、类型、数量统计）',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof NoteFileManager === 'undefined') throw new Error('NoteFileManager 不可用');
          if (typeof NoteFileManager.countNotesForBook === 'function' && typeof PDFReader !== 'undefined' && PDFReader.setBookId && typeof Notebook !== 'undefined' && Notebook.getNotebook) {
            var nb = Notebook.getNotebook && Notebook.getNotebook();
            var bookId = nb && nb.bookId ? nb.bookId : null;
            var n = NoteFileManager.countNotesForBook(bookId);
            var first = NoteFileManager.getFirstNoteForBook(bookId);
            return JSON.stringify({ noteCount: n, firstNote: first ? first.name : null });
          }
          return JSON.stringify({ note: '已在页面中展示笔记空间目录' });
        }
      },
      {
        type: 'function',
        function: {
          name: 'note_delete',
          description: '删除笔记空间中某个笔记或文件夹（关键操作：需要用户审批）',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要删除的笔记或文件夹的名称（按名称模糊匹配）' }
            },
            required: ['name']
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将删除笔记/文件夹「' + (args.name||'') + '」及其所有内容，删除后无法恢复。是否确认？'; },
        handler: function(args) {
          if (typeof NoteFileManager === 'undefined') throw new Error('NoteFileManager 不可用');
          // 通过按名称查找节点 ID 后删除（此处以提示+占位的形式暴露能力，UI交互为主）
          return '🗑 已请求删除「' + args.name + '」（请在笔记空间面板确认删除）';
        }
      },
      {
        type: 'function',
        function: {
          name: 'note_close',
          description: '关闭当前打开的笔记，回到笔记空间文件列表',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof NoteFileManager === 'undefined' || !NoteFileManager.closeCurrentNote) throw new Error('NoteFileManager.closeCurrentNote 不可用');
          NoteFileManager.closeCurrentNote();
          return '已关闭当前笔记，回到笔记空间';
        }
      },

      // ======================================================================
      //  教材/书架管理（FileManager）
      // ======================================================================
      {
        type: 'function',
        function: {
          name: 'book_list',
          description: '列出书架上所有教材（返回名称、分类、收藏状态、打开时间）',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string', description: '按关键词搜索教材名称（可选，留空返回全部）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof FileManager === 'undefined' || !FileManager.getAllBooks) throw new Error('FileManager 不可用');
          var all = FileManager.getAllBooks();
          if (args && args.keyword) {
            var kw = String(args.keyword).toLowerCase();
            all = (all||[]).filter(function(b){ return b && b.name && String(b.name).toLowerCase().indexOf(kw)>=0; });
          }
          var summary = (all||[]).slice(0, 50).map(function(b){
            return (b.favorite?'⭐ ':'') + (b.name||'(未命名)') + (b.category?' ['+b.category+']':'') + (b.openedAt?' (最近:'+new Date(b.openedAt).toLocaleDateString()+')':'');
          }).join('\n');
          var total = Array.isArray(all) ? all.length : 0;
          return '📚 书架共 ' + total + ' 本教材' + (args&&args.keyword?'（匹配关键词：'+args.keyword+'）':'') + '：\n\n' + (summary || '(空)');
        }
      },
      {
        type: 'function',
        function: {
          name: 'book_recent',
          description: '列出最近打开的教材（最近阅读的书）',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof FileManager === 'undefined' || !FileManager.getRecentBooks) throw new Error('FileManager 不可用');
          var recent = FileManager.getRecentBooks();
          return '🕒 最近阅读：\n' + (recent||[]).slice(0,10).map(function(b,i){ return (i+1)+'. '+(b.name||'未命名'); }).join('\n') || '(暂无记录)';
        }
      },
      {
        type: 'function',
        function: {
          name: 'book_rename',
          description: '修改书架上某本教材的名称（关键操作：需要用户审批）',
          parameters: {
            type: 'object',
            properties: {
              currentName: { type: 'string', description: '当前教材名称（用于匹配）' },
              newName:     { type: 'string', description: '修改后的新名称' }
            },
            required: ['currentName', 'newName']
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将把教材「' + (args.currentName||'') + '」改名为「' + (args.newName||'') + '」，是否确认？'; },
        handler: function(args) {
          if (typeof FileManager === 'undefined') throw new Error('FileManager 不可用');
          var all = FileManager.getAllBooks && FileManager.getAllBooks() || [];
          var kw = String(args.currentName||'').toLowerCase();
          var target = all.find(function(b){ return b && b.name && b.name.toLowerCase() === kw; })
                    || all.find(function(b){ return b && b.name && b.name.toLowerCase().indexOf(kw)>=0; });
          if (!target) return '❌ 书架上未找到名为「' + args.currentName + '」的教材';
          return Promise.resolve(FileManager.renameBook(target.id, args.newName)).then(function() {
            return '✅ 已重命名：「' + args.currentName + '」 → 「' + args.newName + '」';
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'book_delete',
          description: '从书架删除一本教材及关联的笔记/附件（关键操作：需要用户审批）',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要删除的教材名称' }
            },
            required: ['name']
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将从书架删除教材「' + (args.name||'') + '」及其所有笔记、标注、附件。此操作不可恢复。是否确认？'; },
        handler: function(args) {
          if (typeof FileManager === 'undefined') throw new Error('FileManager 不可用');
          var all = FileManager.getAllBooks && FileManager.getAllBooks() || [];
          var kw = String(args.name||'').toLowerCase();
          var target = all.find(function(b){ return b && b.name && b.name.toLowerCase() === kw; })
                    || all.find(function(b){ return b && b.name && b.name.toLowerCase().indexOf(kw)>=0; });
          if (!target) return '❌ 书架上未找到名为「' + args.name + '」的教材';
          return Promise.resolve(FileManager.deleteBook(target.id)).then(function() {
            return '🗑 已删除教材「' + target.name + '」及其关联数据';
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'book_favorite',
          description: '标记/取消某本教材为收藏',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '教材名称（模糊匹配）' },
              favorite: { type: 'boolean', description: 'true=加入收藏，false=取消收藏' }
            },
            required: ['name']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof FileManager === 'undefined') throw new Error('FileManager 不可用');
          var all = FileManager.getAllBooks && FileManager.getAllBooks() || [];
          var kw = String(args.name||'').toLowerCase();
          var target = all.find(function(b){ return b && b.name && b.name.toLowerCase() === kw; })
                    || all.find(function(b){ return b && b.name && b.name.toLowerCase().indexOf(kw)>=0; });
          if (!target) return '❌ 未找到「' + args.name + '」';
          var fav = args.favorite === undefined ? !target.favorite : !!args.favorite;
          return Promise.resolve(FileManager.toggleFavorite(target.id)).then(function() {
            return fav ? '⭐ 已加入收藏：' + target.name : '📚 已取消收藏：' + target.name;
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'book_setCategory',
          description: '给某本教材设置分类标签（如内科学、外科学、总论）',
          parameters: {
            type: 'object',
            properties: {
              name:     { type: 'string', description: '教材名称' },
              category: { type: 'string', description: '分类名称（如"内科学"）' }
            },
            required: ['name', 'category']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof FileManager === 'undefined') throw new Error('FileManager 不可用');
          var all = FileManager.getAllBooks && FileManager.getAllBooks() || [];
          var kw = String(args.name||'').toLowerCase();
          var target = all.find(function(b){ return b && b.name && b.name.toLowerCase() === kw; })
                    || all.find(function(b){ return b && b.name && b.name.toLowerCase().indexOf(kw)>=0; });
          if (!target) return '❌ 未找到「' + args.name + '」';
          return Promise.resolve(FileManager.setCategory(target.id, args.category)).then(function() {
            return '🏷 ' + target.name + ' → 分类「' + args.category + '」';
          });
        }
      },

      // ======================================================================
      //  参考资料管理（ReferenceManager）
      // ======================================================================
      {
        type: 'function',
        function: {
          name: 'ref_list',
          description: '列出当前教材的参考资料（附加材料）清单',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof ReferenceManager === 'undefined' || !ReferenceManager.getByBook) throw new Error('ReferenceManager 不可用');
          var nb = typeof Notebook !== 'undefined' && Notebook.getNotebook ? Notebook.getNotebook() : null;
          var bookId = nb && nb.bookId;
          return Promise.resolve(ReferenceManager.getByBook(bookId)).then(function(list) {
            if (!list || list.length === 0) return '（当前教材没有参考资料）';
            return '📎 参考资料共 ' + list.length + ' 份：\n' + list.map(function(r,i){
              return (i+1)+'. '+(r.name||r.id)+'（'+(r.type||'?')+'，'+Math.round((r.size||0)/1024)+' KB）';
            }).join('\n');
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'ref_getMd',
          description: '查看一份参考资料的文本/Markdown 内容（用于引用学习）',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '参考资料名称（模糊匹配）' }
            },
            required: ['name']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof ReferenceManager === 'undefined' || !ReferenceManager.getMd) throw new Error('ReferenceManager 不可用');
          var nb = typeof Notebook !== 'undefined' && Notebook.getNotebook ? Notebook.getNotebook() : null;
          var bookId = nb && nb.bookId;
          return Promise.resolve(ReferenceManager.getByBook(bookId)).then(function(list) {
            var kw = String(args.name||'').toLowerCase();
            var ref = (list||[]).find(function(r){ return r.name && r.name.toLowerCase().indexOf(kw)>=0; });
            if (!ref) return '❌ 未找到名为「' + args.name + '」的参考资料';
            return Promise.resolve(ReferenceManager.getMd(ref.id)).then(function(md) {
              var text = String(md||'').substring(0, 1500);
              return '— ' + ref.name + ' —\n' + text + (text.length >= 1500 ? '\n...（已截断，完整内容请在参考资料面板查看）' : '');
            });
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'ref_remove',
          description: '删除一份参考资料（关键操作：需审批）',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: '参考资料名称' } },
            required: ['name']
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将删除参考资料「' + (args.name||'') + '」，是否确认？'; },
        handler: function(args) {
          if (typeof ReferenceManager === 'undefined' || !ReferenceManager.remove) throw new Error('ReferenceManager 不可用');
          return '已请求删除参考资料「' + args.name + '」（请在参考资料面板确认）';
        }
      },

      // ======================================================================
      //  导出
      // ======================================================================
      {
        type: 'function',
        function: {
          name: 'export_bookZip',
          description: '导出当前教材的完整备份 Zip（含 PDF、所有笔记、标注、附件），自动下载',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof FileManager === 'undefined' || !FileManager.exportBookZip) throw new Error('FileManager.exportBookZip 不可用');
          var nb = typeof Notebook !== 'undefined' && Notebook.getNotebook ? Notebook.getNotebook() : null;
          var bookId = nb && nb.bookId;
          if (!bookId) return '⚠ 请先在书架打开一本教材';
          return Promise.resolve(FileManager.exportBookZip(bookId)).then(function(result) {
            return '💾 教材完整备份已导出（' + (result && result.fileName ? result.fileName : 'zip') + '），浏览器应正在自动下载';
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'export_noteZip',
          description: '导出当前这本笔记的 Zip 备份（独立笔记包，可导入恢复）',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof NoteFileManager === 'undefined' || !NoteFileManager.exportZip) throw new Error('NoteFileManager.exportZip 不可用');
          NoteFileManager.exportZip();
          return '💾 当前笔记已打包为 Zip，浏览器应正在自动下载';
        }
      },
      {
        type: 'function',
        function: {
          name: 'export_notePdf',
          description: '将当前笔记打印/导出为 PDF',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof NoteFileManager !== 'undefined' && NoteFileManager.exportNoteAsPdf) {
            NoteFileManager.exportNoteAsPdf();
            return '🖨 已触发「笔记 → PDF」导出（系统打印对话框将弹出，请选择"另存为 PDF"）';
          }
          if (typeof Notebook !== 'undefined' && Notebook.printPdf) {
            Notebook.printPdf();
            return '🖨 已触发打印（系统打印对话框将弹出）';
          }
          throw new Error('导出 PDF 功能不可用');
        }
      },
      {
        type: 'function',
        function: {
          name: 'export_noteMd',
          description: '导出当前笔记为 Markdown 文本（纯文本，内容快照）',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof Notebook === 'undefined' || !Notebook.getPageMd) throw new Error('Notebook.getPageMd 不可用');
          var pageId = Notebook.getCurrentPageId();
          var md = Notebook.getPageMd(pageId);
          // 构造下载
          try {
            var blob = new Blob([md], {type: 'text/markdown;charset=utf-8'});
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var nb = Notebook.getNotebook && Notebook.getNotebook();
            var fname = 'note-' + (nb && nb.name ? nb.name.replace(/[\\/:*?"<>|]/g,'_') : 'export') + '.md';
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function(){ try{ URL.revokeObjectURL(url); }catch(e){} }, 1000);
          } catch(e) {
            return '⚠ 浏览器不支持下载，但内容已获取。字数：' + md.length;
          }
          return '💾 当前笔记已导出为 Markdown（' + md.length + ' 字），浏览器应正在下载';
        }
      },

      // ======================================================================
      //  AI 笔记操作（AIEngine）：总结 / AI 改进等 — 真正"让 AI 干活"
      // ======================================================================
      {
        type: 'function',
        function: {
          name: 'ai_runCommand',
          description: '让 AI 在笔记上执行一条指令（如"改进这段"、"总结一下"、"翻译成英文"、"给我画个思维导图"、"插入相关知识点"）。基于当前选中的块；如果没选中块则对整页操作。',
          parameters: {
            type: 'object',
            properties: {
              instruction: { type: 'string', description: 'AI 指令文本，例如：总结一下当前页 / 把下面这段改成学术风格 / 生成一份思维导图 / 翻译成英文 / 补充相关考点' }
            },
            required: ['instruction']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof AIEngine === 'undefined' || !AIEngine.runCommand) throw new Error('AIEngine 不可用');
          return Promise.resolve(AIEngine.runCommand(args.instruction)).then(function(res) {
            if (res && res.message) return '⚠ ' + res.message;
            return '🤖 AI 已执行指令，结果已写入当前笔记页面（可在笔记面板查看）';
          }).catch(function(err) {
            return '⚠ AI 指令执行失败：' + (err && err.message ? err.message : err);
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'ai_readPdf',
          description: '让 AI 读取当前 PDF 页内容并返回原文文本（作为上下文参考）',
          parameters: {
            type: 'object',
            properties: {
              pages: { type: 'string', description: '读取范围：留空=当前页；"1,3,5"=指定多页；"1-10"=连续范围' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof AIEngine === 'undefined' || !AIEngine.readPdf) throw new Error('AIEngine 不可用');
          var spec = (args && args.pages) ? args.pages : undefined;
          return Promise.resolve(AIEngine.readPdf(spec)).then(function(result) {
            var text = result && result.text ? result.text : '';
            if (!text) return '⚠ 当前 PDF 页面没有可提取的文本（可能是扫描件）';
            return '📖 PDF 内容（' + (result.pageNum ? '第 '+result.pageNum+' 页' : '范围 '+spec) + '，' + text.length + ' 字）：\n\n' + text.substring(0, 2000) + (text.length > 2000 ? '\n...（已截断）' : '');
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'notebook_query',
          description: '查询当前笔记状态：列出当前页的所有块（标题、段落、表格、流程图等）并返回数量和结构摘要',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          var pageId = Notebook.getCurrentPageId();
          var blocks = Notebook.getPageBlocks ? Notebook.getPageBlocks(pageId) : [];
          var types = {};
          for (var i = 0; i < blocks.length; i++) {
            var t = (blocks[i] && blocks[i].type) || 'unknown';
            types[t] = (types[t]||0) + 1;
          }
          var md = Notebook.getPageMd ? Notebook.getPageMd(pageId) : '';
          return JSON.stringify({
            blocks: blocks.length,
            types: types,
            markdownChars: md.length,
            pageId: pageId
          });
        }
      },

      // notebook_createPage：在当前笔记本中新建一页笔记（活页），并切换到该页
      {
        type: 'function',
        function: {
          name: 'notebook_createPage',
          description: '在当前打开的笔记本中新建一个笔记页（可指定名称；可绑定 PDF 页码，用于"跳转到某 PDF 页"）。创建后自动打开该页，后续 notebook_appendMd / notebook_prependMd / notebook_replaceMd 都会写入新页。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '页面名称（可选，默认"新笔记页"）' },
              pdfPageNum: { type: 'number', description: '可选：绑定到的 PDF 页码（用于后续跳转定位）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          if (typeof Notebook.addPage !== 'function') throw new Error('Notebook.addPage 不可用');
          var name = (args && args.name) ? String(args.name) : '新笔记页';
          var pdfNum = (args && args.pdfPageNum) ? Number(args.pdfPageNum) : null;
          return Promise.resolve(Notebook.addPage(name, pdfNum)).then(function(page) {
            if (!page) return '⚠ 当前没有打开的笔记本，无法新建页面';
            return '✅ 已新建笔记页「' + page.name + '」并打开（pageId=' + page.id +
              (page.pdfRef && page.pdfRef.pageNum ? '，绑定 PDF 第 ' + page.pdfRef.pageNum + ' 页' : '') + '）';
          });
        }
      },

      // ======================================================================
      //  笔记直接编辑（Notebook.applyOperation / getPageBlocks / getPageMd）
      // ======================================================================
      // ==================== 系统状态查询工具集 ====================
      // AI 可主动查询整个阅读器任意子系统状态：PDF 任意页内容、任意笔记页内容、
      // 队列历史与执行状态、教材库、笔记空间、附件空间、当前正在执行的程序。
      // 所有查询工具只读不写，无需审批。

      // app_getFullState：一次性返回当前页面所有核心状态快照
      {
        type: 'function',
        function: {
          name: 'app_getFullState',
          description: '【全状态快照】一次性返回当前阅读器所有核心状态：当前视图、PDF（页码/总页数/缩放/标注工具/书名）、当前笔记页（ID/字数/编辑态）、当前打开的笔记本、队列任务统计、当前选中文本。适合 AI 在执行任何操作前快速了解全局上下文。',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          var s = {};
          // 视图模式
          try {
            var views = ['viewShelf', 'viewRead', 'viewNote', 'viewAttach'];
            for (var i = 0; i < views.length; i++) {
              var el = document.getElementById(views[i]);
              if (el && el.classList.contains('active')) { s.currentView = views[i].replace('view', '').toLowerCase(); break; }
            }
          } catch (e) {}
          // PDF 状态
          try {
            if (typeof PDFReader !== 'undefined') {
              s.pdf = {};
              if (PDFReader.getCurrentPage) s.pdf.currentPage = PDFReader.getCurrentPage();
              if (PDFReader.getPageCount) s.pdf.totalPages = PDFReader.getPageCount();
              if (PDFReader.getCurrentZoom) s.pdf.zoomPercent = Math.round(Number(PDFReader.getCurrentZoom() || 1) * 100);
              if (PDFReader.getPdfName) s.pdf.fileName = PDFReader.getPdfName();
              if (typeof PDFAnnotate !== 'undefined' && PDFAnnotate.getTool) s.pdf.annotationTool = PDFAnnotate.getTool() || 'none';
            }
          } catch (e) {}
          // 笔记状态
          try {
            if (typeof Notebook !== 'undefined') {
              s.notebook = {};
              var pid = Notebook.getCurrentPageId ? Notebook.getCurrentPageId() : null;
              s.notebook.currentPageId = pid;
              if (pid && Notebook.getPageMdDirect) {
                var md = Notebook.getPageMdDirect(pid);
                s.notebook.currentPageChars = (md || '').length;
              }
              var nb = Notebook.getNotebook ? Notebook.getNotebook() : null;
              if (nb) { s.notebook.notebookId = nb.id; s.notebook.notebookTitle = nb.title; s.notebook.pageCount = (nb.pages ? nb.pages.length : 0); }
            }
          } catch (e) {}
          // 选中文本
          try {
            var sel = window.getSelection && window.getSelection();
            if (sel && sel.toString) { var t = sel.toString().trim(); if (t) s.selectedText = t.slice(0, 200); }
          } catch (e) {}
          // 队列状态摘要
          try {
            if (typeof CommandQueue !== 'undefined' && CommandQueue.list) {
              return Promise.resolve(CommandQueue.list()).then(function(cmds) {
                s.queue = _summarizeQueue(cmds);
                return '📊 当前系统全状态：\n\n```json\n' + JSON.stringify(s, null, 2) + '\n```';
              });
            }
          } catch (e) {}
          return '📊 当前系统全状态：\n\n```json\n' + JSON.stringify(s, null, 2) + '\n```';
        }
      },

      // pdf_getPageText：读取任意一页 PDF 文本
      {
        type: 'function',
        function: {
          name: 'pdf_getPageText',
          description: '读取 PDF 指定页码的文本内容（OCR 原生文本层）。AI 可读取任意一页用于总结、翻译、引用。如不传 page 则读取当前页。',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'integer', description: '要读取的页码（1-based，不传则读当前页）' },
              maxChars: { type: 'integer', description: '最大返回字符数（默认 6000，超出截断并提示）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFReader === 'undefined' || !PDFReader.getPageText) throw new Error('PDFReader 不可用');
          var page = args.page;
          if (!page) page = PDFReader.getCurrentPage ? PDFReader.getCurrentPage() : 1;
          var total = PDFReader.getPageCount ? PDFReader.getPageCount() : 0;
          if (total > 0 && (page < 1 || page > total)) return '⚠ 页码 ' + page + ' 超出范围（1-' + total + '）';

          // ===== 硬性拦截：禁止读取目录所在页面（用户要跳章时，先 pdf_getTOC 拿到 pageNum 直接跳，不要先读目录页核对） =====
          // 读取 TOC 缓存或实时解析，找到正文起始页码
          var tocForBlock = null;
          try {
            if (window.__scg_toc_cache && (!window.__scg_toc_cache_ts || Date.now() - window.__scg_toc_cache_ts < 60 * 1000)) {
              tocForBlock = window.__scg_toc_cache;
            } else if (typeof PDFReader !== 'undefined' && PDFReader.getTOC) {
              tocForBlock = PDFReader.getTOC && typeof PDFReader.getTOC === 'function' ? null : null;
            }
          } catch (e) {}
          if (tocForBlock && Array.isArray(tocForBlock) && tocForBlock.length > 0) {
            // 找到 TOC 中最小的 pageNum（通常就是正文第 1 章的起始页）
            var _minChapterPage = Infinity;
            function _walkMin(items) {
              for (var k = 0; k < items.length; k++) {
                var it = items[k];
                var pn = Number(it.pageNum);
                if (pn > 0 && pn < _minChapterPage) _minChapterPage = pn;
                if (it.items && it.items.length) _walkMin(it.items);
              }
            }
            _walkMin(tocForBlock);
            if (_minChapterPage !== Infinity) {
              // 小于正文章节起始页 -1 的页码，强拦截（封面/版权/前言大概率不是正文章节）
              if (page < _minChapterPage - 1) {
                return '🚫 拦截：第 ' + page + ' 页是封面/版权/前言/目录所在页面，不允许用 pdf_getPageText 读取。\n'
                  + '【正确流程】\n'
                  + '  1. 用 pdf_getTOC 拿目录（内含每个章节 pageNum，这是权威的），然后直接 pdf_jumpToPage(pageNum)；\n'
                  + '  2. 需要总结章节时，读正文章节起始页（第 ' + _minChapterPage + ' 页以后），不要读目录页。\n'
                  + '如需目录请直接调用 pdf_getTOC。';
              }
            }
          }

          return PDFReader.getPageText(page).then(function(text) {
            text = text || '';
            // ===== 兜底二级拦截：即使 page 编号看起来像正文，如果文本内容实际上是目录/封面的格式（目录行特征词密集），仍然拦截并返回 "无需再校验" 的强信号，避免 LLM 反复尝试同页/邻页 =====
            var _catches = 0;
            var _t = (text || '').slice(0, 6000);
            var _lines = _t.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
            for (var li = 0; li < _lines.length; li++) {
              var ls = _lines[li];
              // 目录特征：连续的中文章节词 + 一堆点号（省略号/leaders）+ 末尾数字
              if (/^[序目第一篇第二篇第三篇第四篇第五篇第六篇章节节附录]|(目\s*录)|(绪\s*论)|(前\s*言)|(编\s*委)|(主\s*编)|(副\s*主\s*编)|(出\s*版\s*社)/.test(ls)) _catches += 2;
              if (/[一二三四五六七八九十百千0-9]+[章节节篇部分]/.test(ls)) _catches += 1;
              if (/\.\s*\.\s*\.\s*\d+\s*$|\u00B7+\s*\d+\s*$|\.{3,}\s*\d+\s*$|…+\s*\d+\s*$/.test(ls)) _catches += 2;
            }
            // 如果 20+ 行以内有 8 个以上命中点，判定为"目录类页面"（医学教材封面/版权/前言往往也会命中目录行特征，一并拦截）
            if (_lines.length <= 40 && _catches >= 8) {
              return '🚫 拦截：第 ' + page + ' 页的内容特征符合"目录/封面/前言页"（命中 ' + _catches + ' 个目录特征），不允许用 pdf_getPageText 读取用来做 TOC 校验。\n'
                + '✅ 权威做法：直接以 pdf_getTOC 返回的 pageNum 为准，调用 pdf_jumpToPage(pageNum) 完成跳转。\n'
                + '💾 记住：一旦 pdf_getTOC 返回过目录，本书的"目录页码偏移"就已经被记住，无需再次校验。';
            }

            var maxChars = args.maxChars || 6000;
            if (text.length > maxChars) {
              return '📄 第 ' + page + ' 页文本（共 ' + text.length + ' 字，已截断至 ' + maxChars + ' 字）：\n\n' + text.slice(0, maxChars) + '\n\n…[剩余 ' + (text.length - maxChars) + ' 字未显示，可指定更大的 maxChars 或分段读取]';
            }
            return '📄 第 ' + page + ' 页文本（' + text.length + ' 字）：\n\n' + (text || '（此页无文本层，可能是扫描件，建议用 OCR）');
          });
        }
      },

      // pdf_getTOC：获取 PDF 目录
      {
        type: 'function',
        function: {
          name: 'pdf_getTOC',
          description: '获取当前 PDF 的目录（章节结构），返回树形 JSON：[{title, pageNum, children:[...]}]。',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof PDFReader === 'undefined' || !PDFReader.getTOC) throw new Error('PDFReader 不可用');
          return Promise.resolve(PDFReader.getTOC()).then(function(toc) {
            // 缓存 TOC，供本地章节跳转拦截器 _tryLocalChapterJump 零 token 命中（1 分钟有效）
            try {
              window.__scg_toc_cache = toc ? JSON.parse(JSON.stringify(toc)) : null;
              window.__scg_toc_cache_ts = Date.now();
            } catch (e) {}
            // 只要 pdf_getTOC 成功返回了目录，就直接把本书记忆的 pageOffsetVerified=true 写入
            // （之前要等 jumpToPage 成功才写 → 导致 AI 在 TOC→jump 之间的思考期仍可能尝试读目录页做校验）
            if (toc && toc.length) {
              try {
                var curBid = _hmCurrentBookId();
                if (curBid && curBid !== '__current__') _hmMarkBookVerified(curBid, true, 0);
              } catch (e) {}
            }
            if (!toc || !toc.length) return '📑 当前 PDF 没有目录（可能未嵌入 outline）';
            function fmt(items, depth) {
              var lines = [];
              for (var i = 0; i < items.length; i++) {
                var it = items[i];
                var indent = '';
                for (var d = 0; d < depth; d++) indent += '  ';
                lines.push(indent + '- ' + (it.title || '(无标题)') + (it.pageNum ? ' [p.' + it.pageNum + ']' : ''));
                if (it.items && it.items.length) lines = lines.concat(fmt(it.items, depth + 1));
              }
              return lines;
            }
            var memoHint = '💾 已写入 harness 记忆：本书 pageOffsetVerified=true，以后跳章节不要再读目录页核对。';
            return '📑 PDF 目录：\n\n' + fmt(toc, 0).join('\n') + '\n\n' + memoHint;
          });
        }
      },

      // pdf_detectTOC：无内嵌书签时，用页眉/页脚本地检测自动生成目录（零 token，不调 LLM）
      {
        type: 'function',
        function: {
          name: 'pdf_detectTOC',
          description: '当 PDF 没有内嵌书签/目录时，用【页眉页脚检测】本地自动生成章节目录：逐页读取顶部页眉文本，页眉变化处即章节起始页（零 token，不调 LLM）。参数 force=true 时强制重新扫描（清除旧缓存）；不传则返回已缓存的自动目录。适用"这本书没有目录/跳章节失效"的场景。',
          parameters: {
            type: 'object',
            properties: {
              force: { type: 'boolean', description: '是否强制重新扫描全书（默认 false，优先返回缓存）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFReader === 'undefined') throw new Error('PDFReader 不可用');
          if (args && args.force && PDFReader.clearRunningHeadTOC) PDFReader.clearRunningHeadTOC();
          var cached = PDFReader.getRunningHeadTOC ? PDFReader.getRunningHeadTOC() : null;
          if (cached && cached.length && !(args && args.force)) {
            var lines = cached.map(function(it) { return '- ' + it.title + ' [p.' + it.pageNum + ']'; });
            return '📑 页眉检测目录（已缓存）：\n\n' + lines.join('\n') + '\n\n共 ' + cached.length + ' 个章节。';
          }
          if (!PDFReader.detectRunningHeadTOC) throw new Error('PDFReader.detectRunningHeadTOC 不可用');
          return Promise.resolve(PDFReader.detectRunningHeadTOC(function(p, total) {
            // 进度回调：扫描完成后直接返回结果（此处只做静默收集）
          })).then(function(toc) {
            if (!toc || !toc.length) return '⚠ 页眉检测未发现章节变化。可能原因：该书没有页眉文字（纯扫描件需先 OCR），或整本页眉都是书名。可以尝试用 AI 阅读文本生成目录。';
            var lines = toc.map(function(it) { return '- ' + it.title + ' [p.' + it.pageNum + ']'; });
            // 同步缓存供 getTOC / 本地跳章节使用
            try { PDFReader.getTOC().then(function(full) { window.__scg_toc_cache = full; window.__scg_toc_cache_ts = Date.now(); }).catch(function(){}); } catch (e) {}
            return '✅ 已用页眉检测自动生成目录（零 token，本地扫描）：\n\n' + lines.join('\n') + '\n\n共 ' + toc.length + ' 个章节。现在可以正常执行"跳到第 X 章"。';
           });
         }
       },

      // pdf_ocrPage：识别扫描件单页（Tesseract 本地离线），返回识别文本；识别结果可划选、AI 可读
      {
        type: 'function',
        function: {
          name: 'pdf_ocrPage',
          description: '对 PDF 指定页做 OCR 文字识别（本地 Tesseract 引擎，离线、零 token）。适用于扫描件（无文本层）页面：识别后该页出现可划选文字层，AI 也能读取该页文字。page 不传则识别当前页。返回识别出的全文。',
          parameters: {
            type: 'object',
            properties: {
              page: { type: 'number', description: '要识别的页码（可选，默认当前页）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof PDFReader === 'undefined') throw new Error('PDFReader 不可用');
          if (typeof window.OCREngine === 'undefined') throw new Error('OCR 引擎未加载');
          var page = (args && args.page) ? Number(args.page) : PDFReader.getCurrentPage();
          var bookId = PDFReader.getBookId ? PDFReader.getBookId() : null;
          return Promise.resolve(OCREngine.ocrPage(bookId, page)).then(function(res) {
            if (!res || !res.text) return '⚠ 第 ' + page + ' 页未识别到文字（可能整页为空白或图片无文字）。';
            return '📷 第 ' + page + ' 页 OCR 识别完成（' + (res.lines ? res.lines.length : 0) + ' 行）：\n\n' + res.text;
          });
        }
      },

      // pdf_ocrBook：从指定页开始顺序识别剩余页（后台），返回进度
      {
        type: 'function',
        function: {
          name: 'pdf_ocrBook',
          description: '从指定页开始整本顺序 OCR（本地离线）。扫描件专用：识别后所有页面都可划选、AI 可读全文。会持续较长时间（每页数秒），适合用户说"把这本书识别一遍/OCR 整本"时调用。',
          parameters: {
            type: 'object',
            properties: {
              from: { type: 'number', description: '起始页码（可选，默认当前页）' }
            },
            required: []
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将从第 ' + (args && args.from ? args.from : '当前页') + ' 页开始整本 OCR 识别（每页数秒，识别结果本地缓存）。是否继续？'; },
        handler: function(args) {
          if (typeof PDFReader === 'undefined') throw new Error('PDFReader 不可用');
          if (typeof window.OCREngine === 'undefined') throw new Error('OCR 引擎未加载');
          var from = (args && args.from) ? Number(args.from) : PDFReader.getCurrentPage();
          var total = PDFReader.getPageCount ? PDFReader.getPageCount() : from;
          if (PDFReader.ocrBookRange) {
            return Promise.resolve(PDFReader.ocrBookRange(from, total, function(cur) {})).then(function(results) {
              var ok = results.filter(function(r) { return !r.error; }).length;
              return '✅ 整本 OCR 完成：成功 ' + ok + ' / ' + results.length + ' 页，全部已缓存。现在全书可划选、AI 可读。';
            });
          }
          var bookId = PDFReader.getBookId ? PDFReader.getBookId() : null;
          return Promise.resolve(OCREngine.ocrBook(bookId, from, total, function(cur, end) {})).then(function(results) {
            var ok = results.filter(function(r) { return !r.error; }).length;
            return '✅ 整本 OCR 完成：成功 ' + ok + ' / ' + results.length + ' 页，全部已缓存。';
          });
        }
      },

      // ==============================
      // 书虫展板 board_* 工具集
      // ==============================
      {
        type: 'function',
        function: {
          name: 'board_renderHtml',
          description: '把一段完整 HTML 渲染到书虫助手右侧展板的"📐 HTML 演示"Tab。渲染后会自动打开展板 + 切换到 HTML Tab。\n适用场景：动态教程演示、可视化模拟、对本系统 UI 的交互模拟、操作步骤的按步骤播放。\n提示：HTML 里可以直接使用预置 class 获得高级视觉风格：.pa-demo-card / .pa-step / .pa-step-num(.active) / .pa-step-kbd / .pa-tags / .pa-tag(-purple/-pink/-amber) / .pa-progress+.pa-progress-bar / .pa-fake-btn(.ghost/.warn) / .pa-bubble。',
          parameters: {
            type: 'object',
            properties: {
              html: { type: 'string', description: '完整的 HTML 字符串（作为 .pa-demo 的子内容直接插入）。注意：不要包含 <html>/<body>/<script> 标签；禁止外链远程资源，style 用 <style> 内嵌，JS 直接写 onClick/setInterval 这类 DOM 内可执行事件。' },
              focus: { type: 'boolean', description: '是否先强制展开展板（默认 true）' }
            },
            required: ['html']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var B = window.PageAgent && window.PageAgent._Board;
          if (!B) throw new Error('展板未初始化（page-agent 尚未挂载）');
          if (args.focus !== false) { try { B.open(); } catch(e){} }
          return B.renderHtml(args.html || '');
        }
      },
      {
        type: 'function',
        function: {
          name: 'board_renderMd',
          description: '把 Markdown 文本渲染到书虫助手右侧展板的"📋 MD 结构化"Tab。渲染后会自动打开展板 + 切到 MD Tab。\n适用场景：结构化提纲、分步操作 checklist、知识点汇总、对比表格、FAQ 聚合。\n支持语法：#/##/###/#### 标题、有序/无序列表、> 引用、|..| 表格（含 :- / :-: / -: 对齐）、```lang 代码块、`行内 code`、**粗** / *斜*、[text](url) 链接、--- 分隔线。',
          parameters: {
            type: 'object',
            properties: {
              md:    { type: 'string', description: 'Markdown 原文' },
              focus: { type: 'boolean', description: '是否先强制展开展板（默认 true）' }
            },
            required: ['md']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var B = window.PageAgent && window.PageAgent._Board;
          if (!B) throw new Error('展板未初始化（page-agent 尚未挂载）');
          if (args.focus !== false) { try { B.open(); } catch(e){} }
          return B.renderMd(args.md || '');
        }
      },
      {
        type: 'function',
        function: {
          name: 'board_render',
          description: '组合调用展板：同时写 HTML + MD、或一次完成切 tab + 展开。比单独调 renderHtml / renderMd / switchTab 更省 token。',
          parameters: {
            type: 'object',
            properties: {
              html:  { type: 'string', description: '（可选）要写入 HTML Tab 的内容' },
              md:    { type: 'string', description: '（可选）要写入 MD Tab 的内容' },
              tab:   { type: 'string', enum: ['html', 'md'], description: '（可选）切到哪个 Tab' },
              focus: { type: 'boolean', description: '（可选）是否强制展开展板' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var B = window.PageAgent && window.PageAgent._Board;
          if (!B) throw new Error('展板未初始化（page-agent 尚未挂载）');
          return B.render(args || {});
        }
      },
      {
        type: 'function',
        function: {
          name: 'board_switchTab',
          description: '只切换展板的 Tab，不刷新内容。tab = "html" 或 "md"。',
          parameters: {
            type: 'object',
            properties: { tab: { type: 'string', enum: ['html','md'], description: '目标 Tab' } },
            required: ['tab']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var B = window.PageAgent && window.PageAgent._Board;
          if (!B) throw new Error('展板未初始化');
          return B.switchTab(args.tab);
        }
      },
      {
        type: 'function',
        function: {
          name: 'board_toggle',
          description: '展开/收起右侧展板。不传参数时在"展开/收起"之间切换；force=true 强制展开，force=false 强制收起。',
          parameters: {
            type: 'object',
            properties: { force: { type: 'boolean', description: 'true=展开；false=收起；不传=切换' } },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var B = window.PageAgent && window.PageAgent._Board;
          if (!B) throw new Error('展板未初始化');
          return B.toggle(typeof args.force === 'boolean' ? args.force : undefined);
        }
      },
      {
        type: 'function',
        function: {
          name: 'board_clear',
          description: '清空展板内容。tab = "html" / "md" 只清空一个，不传则两个都清空；同时会把空态占位提示写回去。',
          parameters: {
            type: 'object',
            properties: { tab: { type: 'string', enum: ['html','md'], description: '（可选）只清空哪个 Tab' } },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var B = window.PageAgent && window.PageAgent._Board;
          if (!B) throw new Error('展板未初始化');
          return B.clear(args.tab);
        }
      },

      
      {
        type: 'function',
        function: {
          name: 'board_showCode',
          description: '在展板 HTML 面板中展示一段代码（配合简单高亮）。用途：教学演示、让用户直观看到功能如何实现。',
          parameters: {
            type: 'object',
            properties: {
              code:    { type: 'string', description: '要展示的代码文本' },
              title:   { type: 'string', description: '代码块标题（函数名/文件名）' },
              lang:    { type: 'string', description: '语言（js/css/html/python）' },
              inline:  { type: 'boolean', description: 'true=嵌入；false=整块替换', default: false }
            },
            required: ['code']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var B = window.PageAgent && window.PageAgent._Board;
          if (!B) throw new Error('展板未初始化');
          if (!args || !args.code) return '⏭ 代码不能为空';
          var escaped = args.code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          var title = args.title || '代码参考';
          var lang = args.lang || 'javascript';
          var html = '<div class="pa-demo pa-code-block pa-code-show">' +
            '<div class="pa-code-header"><span class="pa-code-title">' + title + '</span><span class="pa-code-lang">' + lang + '</span></div>' +
            '<pre class="pa-code-pre"><code>' + escaped + '</code></pre>' +
            '</div>';
          if (args.inline) {
            B.renderHtml(html, true);
          } else {
            B.renderHtml(html);
          }
          return '✅ 已在展板展示代码：' + title;
        }
      },

// ==============================
      // PageAgent Lite（展板内的浏览器操作演示代理，只限于演示/教学使用）
      //   用 pageagent_screenshot 先看当前页面 UI → 再按需 click / type / scroll
      //   定位推荐：selector（CSS 选择器）优先；如果只知道"按钮写什么"，用 text 参数（模糊匹配 button/a/label/span）
      //   重要限制：只限于做演示，不要用 pageagent 翻书/读目录，继续用 pdf_* 工具。
      // ==============================
      {
        type: 'function',
        function: {
          name: 'pageagent_screenshot',
          description: '【展板专用 PageAgent Lite】返回当前页面可视区域的 DOM 结构快照（HTML outerHTML 前 N 字 + 当前页 / 总页数 / 展板启用状态）。\n做真实演示前先用它观察 UI，再决定用哪个 selector 或文案定位。',
          parameters: {
            type: 'object',
            properties: { maxChars: { type: 'integer', description: '快照 HTML 最多多少字符，默认 4000' } },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var PA = window.PageAgent && window.PageAgent._PageAgent;
          if (!PA) throw new Error('PageAgent Lite 不可用');
          return PA.screenshot(args || {});
        }
      },
      {
        type: 'function',
        function: {
          name: 'pageagent_click',
          description: '【展板专用 PageAgent Lite】模拟真实点击一个元素。推荐用 selector 精确定位；也可传 text 用按钮/链接/标签文案定位。\n只能用于用户"想看一遍真实操作流程"的演示场景；不要用它翻书/读目录，继续用 pdf_* 工具。',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS 选择器（推荐），如 #id / .class / button[data-xxx]' },
              text:     { type: 'string', description: '按钮/链接/标签可见文字（如果知道具体写什么可用），会按优先级模糊匹配 button>a>label>span>div...' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var PA = window.PageAgent && window.PageAgent._PageAgent;
          if (!PA) throw new Error('PageAgent Lite 不可用');
          var r = PA.click(args || {});
          return JSON.stringify(r);
        }
      },
      {
        type: 'function',
        function: {
          name: 'pageagent_type',
          description: '【展板专用 PageAgent Lite】向 input / textarea / contentEditable 控件输入文字。推荐 selector 定位；text 传 label 文字时会自动找 label.control 或 label.for 对应控件。',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS 选择器（推荐）' },
              text:     { type: 'string', description: 'label 文字（如果不想写 selector）' },
              value:    { type: 'string', description: '【必填】要输入的文字' }
            },
            required: ['value']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var PA = window.PageAgent && window.PageAgent._PageAgent;
          if (!PA) throw new Error('PageAgent Lite 不可用');
          var r = PA.type(args || {});
          return JSON.stringify(r);
        }
      },
      {
        type: 'function',
        function: {
          name: 'pageagent_scroll',
          description: '【展板专用 PageAgent Lite】滚动页面或某个滚动容器。两个方向参数二选一：top 滚到指定 Y，pxBy 相对滚多少像素；默认滚动 documentElement。',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: '（可选）要滚动的容器选择器，默认整页' },
              top:      { type: 'number', description: '绝对滚动到 scrollTop = N' },
              pxBy:     { type: 'number', description: '相对滚动 N 像素（正数向下，负数向上）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var PA = window.PageAgent && window.PageAgent._PageAgent;
          if (!PA) throw new Error('PageAgent Lite 不可用');
          var r = PA.scroll(args || {});
          return JSON.stringify(r);
        }
      },

      // queue_list：列出所有任务（历史+待办+执行中）
      {
        type: 'function',
        function: {
          name: 'queue_list',
          description: '列出指令队列的所有任务（包括 pending/strategizing/awaiting_approval/approved/applying/done/failed/rejected/rolled_back 全部状态）。可按状态过滤。返回任务 ID、原文、状态、创建时间、执行结果摘要。',
          parameters: {
            type: 'object',
            properties: {
              status: { type: 'string', description: '按状态过滤（不传则返回全部）。可选值：pending/strategizing/strategy_ready/awaiting_approval/approved/applying/done/failed/rejected/rolled_back' },
              limit: { type: 'integer', description: '最多返回条数（默认 50）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof CommandQueue === 'undefined' || !CommandQueue.list) throw new Error('CommandQueue 不可用');
          return Promise.resolve(CommandQueue.list()).then(function(cmds) {
            if (args.status) cmds = cmds.filter(function(c) { return c.status === args.status; });
            var limit = args.limit || 50;
            cmds = cmds.slice(-limit).reverse();
            if (!cmds.length) return '📭 队列为空（无' + (args.status ? '「' + args.status + '」状态' : '') + '任务）';
            var lines = cmds.map(function(c, i) {
              var t = c.createdAt ? new Date(c.createdAt).toLocaleString('zh-CN', { hour12: false }) : '?';
              var raw = (c.raw || '').slice(0, 60);
              var extra = '';
              if (c.failReason) extra += ' [失败: ' + String(c.failReason).slice(0, 50) + ']';
              if (c.rejectReason) extra += ' [拒绝: ' + String(c.rejectReason).slice(0, 50) + ']';
              if (c.diff && c.diff.type) extra += ' [diff: ' + c.diff.type + ']';
              return (i + 1) + '. `' + (c.id || '').slice(0, 10) + '` [' + (c.status || '?') + '] ' + t + '\n   ' + raw + extra;
            });
            return '📋 任务队列（' + cmds.length + ' 条' + (args.status ? '，状态=' + args.status : '') + '）：\n' + lines.join('\n\n');
          });
        }
      },

      // queue_getTask：查询单个任务详情
      {
        type: 'function',
        function: {
          name: 'queue_getTask',
          description: '查询单个任务的完整详情：原文、状态、策略 plan、审批前正文、应用后正文、diff、失败原因、书签 ID 等。',
          parameters: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: '任务 ID（可从 queue_list 获取）' }
            },
            required: ['taskId']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof CommandQueue === 'undefined' || !CommandQueue.getCommand) throw new Error('CommandQueue 不可用');
          return Promise.resolve(CommandQueue.getCommand(args.taskId)).then(function(c) {
            if (!c) return '⚠ 未找到任务 ' + args.taskId;
            var safe = JSON.parse(JSON.stringify(c));
            // 截断超长字段避免 token 爆炸
            ['preApprovalMd', 'postApplyMd', 'snapshot'].forEach(function(k) {
              if (safe[k] && typeof safe[k] === 'string' && safe[k].length > 800) safe[k] = safe[k].slice(0, 800) + '…[截断 ' + (safe[k].length - 800) + ' 字]';
              if (safe[k] && typeof safe[k] === 'object') {
                try { var s = JSON.stringify(safe[k]); if (s.length > 800) safe[k] = '[对象，已截断] ' + s.slice(0, 800) + '…'; } catch (e) {}
              }
            });
            return '🔎 任务详情：\n\n```json\n' + JSON.stringify(safe, null, 2) + '\n```';
          });
        }
      },

      // queue_stats：队列状态统计
      {
        type: 'function',
        function: {
          name: 'queue_stats',
          description: '返回队列任务的状态统计（各状态数量），快速了解整体执行进度。',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof CommandQueue === 'undefined' || !CommandQueue.list) throw new Error('CommandQueue 不可用');
          return Promise.resolve(CommandQueue.list()).then(function(cmds) {
            return '📊 ' + _summarizeQueue(cmds);
          });
        }
      },

      // shelf_listBooks：列出教材库所有书籍
      {
        type: 'function',
        function: {
          name: 'shelf_listBooks',
          description: '列出教材书架的所有 PDF 书籍：ID、书名、文件大小、分类、是否收藏、阅读进度、添加时间 + 该书关联的笔记空间数量和前几项笔记名称预览。如想查询某本书的完整笔记树，请调用 notespace_list。',
          parameters: {
            type: 'object',
            properties: {
              category: { type: 'string', description: '按分类过滤（不传则返回全部）' },
              favoriteOnly: { type: 'boolean', description: '仅返回收藏的书籍（默认 false）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof FileManager === 'undefined' || !FileManager.getAllBooks) throw new Error('FileManager 不可用');
          return Promise.resolve(FileManager.getAllBooks()).then(function(books) {
            // ---- 先把 NFM 笔记存储读出来，遍历每本书统计笔记数 + 预览 ----
            var nfm = null;
            try {
              var rawNfm = localStorage.getItem('shuchongu_nfm_v1');
              if (rawNfm) nfm = JSON.parse(rawNfm) || {};
            } catch (e) { nfm = {}; }
            function _noteStats(bookId) {
              var entry = nfm ? nfm['book:' + bookId] : null;
              var count = 0;
              var preview = [];
              function walk(arr) {
                if (!arr || !arr.length) return;
                for (var i = 0; i < arr.length; i++) {
                  var it = arr[i];
                  if (!it) continue;
                  if (it.type === 'file') {
                    count++;
                    if (preview.length < 5 && it.name) preview.push(it.name);
                  } else if (it.type === 'folder') {
                    if (it.name && preview.length < 5) preview.push('📁' + it.name);
                    if (it.children) walk(it.children);
                  }
                }
              }
              if (entry && entry.children) walk(entry.children);
              return { count: count, preview: preview };
            }

            if (!books) books = [];
            if (args.favoriteOnly) books = books.filter(function(b) { return b.favorite; });
            if (args.category) books = books.filter(function(b) { return b.category === args.category; });
            if (!books.length) return '📚 书架为空' + (args.category ? '（分类: ' + args.category + '）' : '');
            books.sort(function(a, b) { return (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0); });
            var lines = books.map(function(b, i) {
              var size = b.size ? (b.size / 1024 / 1024).toFixed(2) + ' MB' : '?';
              var prog = b.pageCount ? Math.round((b.pageProgress || 1) / b.pageCount * 100) + '%' : '未读';
              var fav = b.favorite ? '⭐ ' : '';
              var t = b.addedAt ? new Date(b.addedAt).toLocaleDateString('zh-CN') : '?';
              var stat = _noteStats(b.id);
              var noteLine = '';
              if (stat && stat.count > 0) {
                noteLine = '\n   📝 笔记 ' + stat.count + ' 本（预览：' + stat.preview.join('、') + '）；完整笔记树请用 notespace_list(bookId="' + (b.id || '') + '") 查询';
              } else {
                noteLine = '\n   📝 笔记 0 本（或用 notespace_list 确认是否有未登记笔记）';
              }
              return (i + 1) + '. ' + fav + '`' + (b.id || '').slice(0, 12) + '` **' + (b.name || '未命名') + '**\n   ' + size + ' | 进度 ' + prog + ' | 分类: ' + (b.category || '默认') + ' | 添加: ' + t + noteLine;
            });
            return '📚 书架共 ' + books.length + ' 本书：\n\n' + lines.join('\n\n');
          });
        }
      },

      // shelf_getBook：查询单本书籍详情
      {
        type: 'function',
        function: {
          name: 'shelf_getBook',
          description: '查询单本教材书籍的详情：元数据、阅读进度、页数、分类等。',
          parameters: {
            type: 'object',
            properties: {
              bookId: { type: 'string', description: '书籍 ID（可从 shelf_listBooks 获取）' }
            },
            required: ['bookId']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof FileManager === 'undefined' || !FileManager.getBook) throw new Error('FileManager 不可用');
          return Promise.resolve(FileManager.getBook(args.bookId)).then(function(b) {
            if (!b) return '⚠ 未找到书籍 ' + args.bookId;
            return '📖 书籍详情：\n\n```json\n' + JSON.stringify(b, null, 2) + '\n```';
          });
        }
      },

      // notespace_list：列出当前教材下所有笔记空间
      {
        type: 'function',
        function: {
          name: 'notespace_list',
          description: '列出当前教材下的所有笔记空间（笔记本）树形结构。包含笔记 ID、名称、子文件夹。如指定 bookId 则查询该书，否则用当前打开的教材。',
          parameters: {
            type: 'object',
            properties: {
              bookId: { type: 'string', description: 'PDF/教材 ID（不传则用当前教材）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof NoteFileManager === 'undefined') throw new Error('NoteFileManager 不可用');
          var pdfId = args.bookId;
          if (!pdfId) {
            // 从 NFM state 取
            try { pdfId = NoteFileManager.getCurrentOpenNotebookId ? null : null; } catch (e) {}
            // 从 FileManager 找当前书
            if (!pdfId && typeof FileManager !== 'undefined') {
              var cur = localStorage.getItem('shuchongu_current_book');
              if (cur) pdfId = cur;
            }
          }
          if (!pdfId) return '⚠ 未指定 bookId 且无法确定当前教材';
          // NoteFileManager 内部 getTree 是私有，但可通过遍历公开方法间接获取
          // 这里直接读 localStorage（NFM 数据存储位置）
          var tree = null;
          try {
            var raw = localStorage.getItem('shuchongu_nfm_v1');
            if (raw) {
              var all = JSON.parse(raw);
              tree = all['book:' + pdfId];
            }
          } catch (e) {}
          if (!tree || !tree.children || !tree.children.length) return '📂 当前教材下没有笔记空间';
          function walk(arr, depth) {
            var lines = [];
            for (var i = 0; i < arr.length; i++) {
              var it = arr[i];
              if (!it) continue;
              var indent = '';
              for (var d = 0; d < depth; d++) indent += '  ';
              var icon = it.type === 'folder' ? '📁' : '📝';
              lines.push(indent + '- ' + icon + ' ' + (it.name || '未命名') + ' (`' + (it.id || '').slice(0, 10) + '`' + (it.notebookId ? ', nb=' + it.notebookId.slice(0, 10) : '') + ')');
              if (it.children && it.children.length) lines = lines.concat(walk(it.children, depth + 1));
            }
            return lines;
          }
          return '📂 笔记空间树（book: ' + pdfId.slice(0, 12) + '…）：\n\n' + walk(tree.children, 0).join('\n');
        }
      },

      // notespace_listPages：列出笔记本的所有页面
      {
        type: 'function',
        function: {
          name: 'notespace_listPages',
          description: '列出指定笔记本的所有页面：页 ID、名称、对应 PDF 页码、字数、更新时间。不传 notebookId 则用当前打开的笔记本。',
          parameters: {
            type: 'object',
            properties: {
              notebookId: { type: 'string', description: '笔记本 ID（不传则用当前笔记本）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          var nb = Notebook.getNotebook ? Notebook.getNotebook() : null;
          if (args.notebookId && (!nb || nb.id !== args.notebookId)) {
            return '⚠ 指定的笔记本 ' + args.notebookId + ' 未在当前内存中加载（系统一次只加载一本）。当前笔记本: ' + (nb ? nb.id : '无');
          }
          if (!nb) return '⚠ 当前没有打开的笔记本';
          if (!nb.pages || !nb.pages.length) return '📭 笔记本「' + (nb.title || '未命名') + '」没有页面';
          var cur = Notebook.getCurrentPageId ? Notebook.getCurrentPageId() : null;
          var lines = nb.pages.map(function(p, i) {
            var isCur = (p.id === cur) ? ' ← 当前' : '';
            var chars = (p.mdContent || '').length;
            var pdfPage = p.pdfPageNum ? 'PDF p.' + p.pdfPageNum : '独立页';
            var name = p.name || ('第 ' + (i + 1) + ' 页');
            var t = p.updatedAt ? new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '?';
            return (i + 1) + '. `' + (p.id || '').slice(0, 10) + '` **' + name + '** (' + pdfPage + ', ' + chars + ' 字)' + isCur + '\n   更新: ' + t;
          });
          return '📓 笔记本「' + (nb.title || '未命名') + '」共 ' + nb.pages.length + ' 页：\n\n' + lines.join('\n\n');
        }
      },

      // notespace_getPageMd：读取任意笔记页内容
      {
        type: 'function',
        function: {
          name: 'notespace_getPageMd',
          description: '读取指定笔记页的完整 Markdown 原文（可读任意一页，不限于当前页）。AI 可用于跨页检索、对比、引用。不传 pageId 则读当前页。',
          parameters: {
            type: 'object',
            properties: {
              pageId: { type: 'string', description: '笔记页 ID（可从 notespace_listPages 获取，不传则读当前页）' },
              maxChars: { type: 'integer', description: '最大返回字符数（默认 6000）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          var pageId = args.pageId || (Notebook.getCurrentPageId ? Notebook.getCurrentPageId() : null);
          if (!pageId) return '⚠ 没有指定 pageId 且当前没有打开的笔记页';
          var md = '';
          if (Notebook.getPageMdDirect && pageId === (Notebook.getCurrentPageId ? Notebook.getCurrentPageId() : null)) {
            md = Notebook.getPageMdDirect(pageId);
          } else if (Notebook.getPageMd) {
            md = Notebook.getPageMd(pageId);
          }
          var maxChars = args.maxChars || 6000;
          if ((md || '').length > maxChars) {
            return '📄 笔记页 ' + pageId.slice(0, 10) + '…（共 ' + md.length + ' 字，已截断至 ' + maxChars + '）：\n\n' + md.slice(0, maxChars) + '\n\n…[剩余 ' + (md.length - maxChars) + ' 字]';
          }
          return '📄 笔记页 ' + pageId.slice(0, 10) + '…（' + (md || '').length + ' 字）：\n\n' + (md || '（空）');
        }
      },

      // attach_list：列出附件空间文件树
      {
        type: 'function',
        function: {
          name: 'attach_list',
          description: '列出附件空间的文件树（当前教材下的所有附件）。返回文件名、类型、大小、ID。如指定 bookId 则查询该书，否则用当前教材。',
          parameters: {
            type: 'object',
            properties: {
              bookId: { type: 'string', description: 'PDF/教材 ID（不传则用当前教材）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var pdfId = args.bookId;
          if (!pdfId) {
            try { pdfId = localStorage.getItem('shuchongu_current_book'); } catch (e) {}
          }
          if (!pdfId) return '⚠ 未指定 bookId 且无法确定当前教材';
          var tree = null;
          try {
            var raw = localStorage.getItem('shuchongu_attachfm_v1');
            if (raw) {
              var all = JSON.parse(raw);
              tree = all['book:' + pdfId];
            }
          } catch (e) {}
          if (!tree || !tree.children || !tree.children.length) return '📎 附件空间为空';
          function walk(arr, depth) {
            var lines = [];
            for (var i = 0; i < arr.length; i++) {
              var it = arr[i];
              if (!it) continue;
              var indent = '';
              for (var d = 0; d < depth; d++) indent += '  ';
              var icon = it.type === 'folder' ? '📁' : '📎';
              var size = it.size != null ? ' (' + (it.size / 1024).toFixed(1) + ' KB)' : '';
              var mime = it.mimeType ? ' [' + it.mimeType + ']' : '';
              lines.push(indent + '- ' + icon + ' ' + (it.name || '未命名') + ' `' + (it.id || '').slice(0, 10) + '`' + size + mime);
              if (it.children && it.children.length) lines = lines.concat(walk(it.children, depth + 1));
            }
            return lines;
          }
          var count = 0;
          function countFiles(arr) { for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i].type !== 'folder') count++; if (arr[i] && arr[i].children) countFiles(arr[i].children); } }
          countFiles(tree.children);
          return '📎 附件空间（book: ' + pdfId.slice(0, 12) + '…, ' + count + ' 个文件）：\n\n' + walk(tree.children, 0).join('\n');
        }
      },

      // refs_list：列出参考资料
      {
        type: 'function',
        function: {
          name: 'refs_list',
          description: '列出当前教材下的所有参考资料（论文、文档等）：ID、名称、类型、字数、页数、解析器。',
          parameters: {
            type: 'object',
            properties: {
              bookId: { type: 'string', 'description': 'PDF/教材 ID（不传则用当前教材）' }
            },
            required: []
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof ReferenceManager === 'undefined' || !ReferenceManager.listByBook) throw new Error('ReferenceManager 不可用');
          var pdfId = args.bookId;
          if (!pdfId) { try { pdfId = localStorage.getItem('shuchongu_current_book'); } catch (e) {} }
          if (!pdfId) return '⚠ 未指定 bookId 且无法确定当前教材';
          return Promise.resolve(ReferenceManager.listByBook(pdfId)).then(function(list) {
            if (!list || !list.length) return '📚 参考资料为空';
            var lines = list.map(function(r, i) {
              return (i + 1) + '. `' + (r.id || '').slice(0, 10) + '` **' + (r.name || '未命名') + '**\n   类型: ' + (r.type || '?') + ' | 字数: ' + (r.chars || 0) + ' | 页数: ' + (r.pages || 0) + ' | 解析器: ' + (r.parser || '?');
            });
            return '📚 参考资料 ' + list.length + ' 条：\n\n' + lines.join('\n\n');
          });
        }
      },

      // app_getRunningTasks：查询正在执行的程序信息
      {
        type: 'function',
        function: {
          name: 'app_getRunningTasks',
          description: '查询当前正在执行的任务/程序信息：正在执行的队列任务（strategizing/applying/awaiting_approval 状态）、当前 AI 工具调用循环状态、活跃的异步操作。帮助 AI 了解系统是否繁忙、是否有任务阻塞。',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof CommandQueue === 'undefined' || !CommandQueue.list) throw new Error('CommandQueue 不可用');
          return Promise.resolve(CommandQueue.list()).then(function(cmds) {
            var running = cmds.filter(function(c) {
              return c.status === 'strategizing' || c.status === 'applying' || c.status === 'approved' || c.status === 'awaiting_approval' || c.status === 'strategy_ready';
            });
            var info = {
              activeQueueTasks: running.length,
              tasks: running.map(function(c) {
                return { id: c.id, status: c.status, raw: (c.raw || '').slice(0, 80), createdAt: c.createdAt };
              }),
              aiLoopActive: !!(document.querySelector('.pa-harness:not(.pa-harness-done)')),
              timestamp: new Date().toISOString()
            };
            if (!running.length) return '✅ 当前没有正在执行的队列任务，系统空闲。\n\n```json\n' + JSON.stringify(info, null, 2) + '\n```';
            return '🔄 当前有 ' + running.length + ' 个任务正在执行/等待：\n\n```json\n' + JSON.stringify(info, null, 2) + '\n```';
          });
        }
      },

      // app_getSelection：获取当前选中文本（PDF或笔记）
      {
        type: 'function',
        function: {
          name: 'app_getSelection',
          description: '获取用户当前在页面（PDF 或笔记）中选中的文本。AI 可据此了解用户正关注的具体内容。',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          var selText = '';
          try {
            var sel = window.getSelection && window.getSelection();
            if (sel) selText = sel.toString();
          } catch (e) {}
          // PDF 选区
          if (!selText && typeof PDFReader !== 'undefined' && PDFReader.getSelection) {
            var s = PDFReader.getSelection();
            if (s && s.text) selText = s.text;
          }
          if (!selText) return '⚠ 当前没有选中文本';
          return '✏️ 当前选中文本（' + selText.length + ' 字）：\n\n' + selText.slice(0, 2000);
        }
      },

      // 笔记内容直接编辑（纯 Markdown，无 Block 概念）
      // 所有写入走 Notebook.setPageMd 统一入口：落盘 + 内存 + CodeMirror 双向同步 + 重渲染
      // 所有读取走 Notebook.getPageMdDirect：优先编辑器实时内容，兜底内存
      {
        type: 'function',
        function: {
          name: 'notebook_readMd',
          description: '读取当前笔记页的完整 Markdown 原文。返回的是纯文本（含 #、-、``` 等标记）。AI 编辑笔记前应先读取再修改，避免覆盖用户内容。',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          var pageId = Notebook.getCurrentPageId();
          if (!pageId) return '⚠ 当前没有打开的笔记页';
          var md = Notebook.getPageMdDirect ? Notebook.getPageMdDirect(pageId) : (Notebook.getPageMd ? Notebook.getPageMd(pageId) : '');
          var charCount = (md || '').length;
          var lineCount = md ? md.split('\n').length : 0;
          return '📄 当前笔记 Markdown 原文（' + charCount + ' 字，' + lineCount + ' 行）：\n\n---\n\n' + (md || '（空）');
        }
      },
      {
        type: 'function',
        function: {
          name: 'notebook_appendMd',
          description: '在当前笔记页末尾追加 Markdown 内容（会自动加空行分隔，避免与原文粘连）。',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要追加的 Markdown 文本（如 "## 总结\\n\\n本章主要讲了..."）' }
            },
            required: ['content']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          if (typeof Notebook.setPageMd !== 'function') throw new Error('Notebook.setPageMd 不可用');
          var pageId = Notebook.getCurrentPageId();
          if (!pageId) return '⚠ 当前没有打开的笔记页';
          var current = Notebook.getPageMdDirect ? Notebook.getPageMdDirect(pageId) : '';
          var sep = (current && !/[\n\r]\s*$/.test(current)) ? '\n\n' : '';
          var newMd = current + sep + String(args.content || '');
          return Promise.resolve(Notebook.setPageMd(pageId, newMd)).then(function() {
            return '➕ 已在笔记末尾追加内容（' + args.content.length + ' 字），当前总字数 ' + newMd.length;
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'notebook_prependMd',
          description: '在当前笔记页开头插入 Markdown 内容（置顶，自动加空行分隔）。适合加章节大标题、前置摘要等。',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要前置插入的 Markdown 文本' }
            },
            required: ['content']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          if (typeof Notebook.setPageMd !== 'function') throw new Error('Notebook.setPageMd 不可用');
          var pageId = Notebook.getCurrentPageId();
          if (!pageId) return '⚠ 当前没有打开的笔记页';
          var current = Notebook.getPageMdDirect ? Notebook.getPageMdDirect(pageId) : '';
          var sep = (current && !/^\s*[\n\r]/.test(current)) ? '\n\n' : '';
          var newMd = String(args.content || '') + sep + current;
          return Promise.resolve(Notebook.setPageMd(pageId, newMd)).then(function() {
            return '⬆ 已在笔记开头插入内容（' + args.content.length + ' 字），当前总字数 ' + newMd.length;
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'notebook_replaceMd',
          description: '搜索并替换当前笔记页中的部分 Markdown 文本。用 search 精确匹配原文后替换为 replace。找不到匹配时返回失败提示不做任何改动。',
          parameters: {
            type: 'object',
            properties: {
              search:  { type: 'string', description: '要搜索的原文（精确匹配，包含换行与空格）' },
              replace: { type: 'string', description: '替换后的新文本' }
            },
            required: ['search', 'replace']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          if (typeof Notebook.setPageMd !== 'function') throw new Error('Notebook.setPageMd 不可用');
          var pageId = Notebook.getCurrentPageId();
          if (!pageId) return '⚠ 当前没有打开的笔记页';
          var current = Notebook.getPageMdDirect ? Notebook.getPageMdDirect(pageId) : '';
          if (current.indexOf(args.search) < 0) {
            return '⚠ 未找到匹配的搜索文本（' + args.search.length + ' 字），请确认与原文完全一致。当前全文：' + current.length + ' 字。';
          }
          var newMd = current.split(args.search).join(args.replace);
          return Promise.resolve(Notebook.setPageMd(pageId, newMd)).then(function() {
            var n = (current.length - newMd.length + args.replace.length) / Math.max(1, args.search.length);
            var times = Math.round(n);
            return '🔄 已替换 ' + times + ' 处匹配（搜索 ' + args.search.length + ' 字 → 新 ' + args.replace.length + ' 字），总字数 ' + newMd.length;
          });
        }
      },
      {
        type: 'function',
        function: {
          name: 'notebook_replaceAllMd',
          description: '用新的 Markdown 全文覆盖替换当前笔记页（等同于重写整页）。属于关键操作，会弹出用户确认。',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '新的完整 Markdown 全文' }
            },
            required: ['content']
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将覆盖整页笔记（新内容 ' + (args.content||'').length + ' 字），原内容将丢失。是否确认？'; },
        handler: function(args) {
          if (typeof Notebook === 'undefined') throw new Error('Notebook 不可用');
          if (typeof Notebook.setPageMd !== 'function') throw new Error('Notebook.setPageMd 不可用');
          var pageId = Notebook.getCurrentPageId();
          if (!pageId) return '⚠ 当前没有打开的笔记页';
          var newMd = String(args.content == null ? '' : args.content);
          return Promise.resolve(Notebook.setPageMd(pageId, newMd)).then(function() {
            return '📄 已覆盖整页笔记（' + newMd.length + ' 字），CodeMirror/预览已同步刷新';
          });
        }
      },

      // ==================== AI 编程系统：动态工具管理 ====================
      // AI 可按需创建新工具（schema + handler 代码），注册后即可被后续 LLM 调用。
      // handler 通过 ctx 访问所有核心模块，相当于给 AI 一套"编程 API"。

      // system_createTool：创建并注册自定义工具
      {
        type: 'function',
        function: {
          name: 'system_createTool',
          description: '【AI 编程系统】创建一个自定义工具并注册到工具清单，创建后该工具可被后续对话直接调用。handler 代码可使用 ctx 对象访问所有核心模块：ctx.PDFReader、ctx.Notebook、ctx.DataLayer、ctx.PDFAnnotate、ctx.FileManager、ctx.ReferenceManager、ctx.AIEngine、ctx.AppShell、ctx.NoteFileManager、ctx.AttachmentManager、ctx.fetch、ctx.localStorage、ctx.JSON。handler 接收 args（参数对象），需返回字符串或 Promise。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工具名（字母开头，仅含字母数字下划线，3-40 字符，如 my_extract_keywords）' },
              description: { type: 'string', description: '工具功能描述（告诉 LLM 何时该用这个工具）' },
              parameters: { type: 'object', description: 'JSON Schema 参数定义，格式 {type:"object", properties:{...}, required:[...]}。无参数则省略' },
              code: { type: 'string', description: 'handler 函数体 JS 代码，可用 args 和 ctx。示例：return "当前页：" + ctx.PDFReader.getCurrentPage();' },
              requiresApproval: { type: 'boolean', description: '是否需要用户审批才能执行（默认 false）' }
            },
            required: ['name', 'description', 'code']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          if (!args.name || !args.code) throw new Error('name 和 code 必填');
          if (!/^[a-zA-Z][a-zA-Z0-9_]{2,39}$/.test(args.name)) throw new Error('工具名需以字母开头，仅含字母数字下划线，3-40 字符');
          if (args.name.indexOf('system_') === 0) throw new Error('不能以 system_ 前缀创建工具（保留）');
          _ensureCustomToolsLoaded();
          // 验证代码可编译
          try {
            /* eslint-disable no-new-func */
            new Function('args', 'ctx', args.code);
            /* eslint-enable no-new-func */
          } catch (e) {
            throw new Error('handler 代码语法错误: ' + (e && e.message ? e.message : e));
          }
          // 移除同名旧工具（覆盖更新）
          _customTools = _customTools.filter(function(t) { return t.name !== args.name; });
          var tool = {
            name: args.name,
            description: args.description || ('自定义工具 ' + args.name),
            parameters: args.parameters || { type: 'object', properties: {}, required: [] },
            code: args.code,
            requiresApproval: !!args.requiresApproval,
            createdAt: Date.now()
          };
          _customTools.push(tool);
          _saveCustomTools();
          return '✅ 已创建并注册自定义工具「' + args.name + '」。\n描述: ' + tool.description
            + '\n\n现在你可以直接调用它（LLM 会自动匹配工具名），或用 system_listCustomTools 查看全部自定义工具。';
        }
      },

      // system_listCustomTools：列出所有自定义工具
      {
        type: 'function',
        function: {
          name: 'system_listCustomTools',
          description: '【AI 编程系统】列出所有已创建的自定义工具（名称、描述、参数）',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        requiresApproval: false,
        handler: function() {
          _ensureCustomToolsLoaded();
          if (_customTools.length === 0) return '当前没有自定义工具。可用 system_createTool 创建新工具。';
          var lines = _customTools.map(function(t, i) {
            var props = (t.parameters && t.parameters.properties) ? Object.keys(t.parameters.properties).join(', ') : '（无）';
            return (i + 1) + '. **' + t.name + '** — ' + t.description + '（参数: ' + props + '）';
          });
          return '共 ' + _customTools.length + ' 个自定义工具：\n\n' + lines.join('\n');
        }
      },

      // system_deleteCustomTool：删除自定义工具
      {
        type: 'function',
        function: {
          name: 'system_deleteCustomTool',
          description: '【AI 编程系统】删除一个已注册的自定义工具',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要删除的工具名' }
            },
            required: ['name']
          }
        },
        requiresApproval: true,
        approvalPrompt: function(args) { return '即将删除自定义工具「' + args.name + '」，是否确认？'; },
        handler: function(args) {
          _ensureCustomToolsLoaded();
          var before = _customTools.length;
          _customTools = _customTools.filter(function(t) { return t.name !== args.name; });
          if (_customTools.length === before) return '未找到名为「' + args.name + '」的自定义工具';
          _saveCustomTools();
          return '🗑 已删除自定义工具「' + args.name + '」';
        }
      },

      // ====== Harness Memory（harness 长期记忆，本地存储） ======
      {
        type: 'function',
        function: {
          name: 'harness_memo_get',
          description: '从 harness 长期记忆读取一个 key 的值。namespace 不传=当前书；传"global"=跨书全局记忆。',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '记忆键名' },
              namespace: { type: 'string', description: '"global" 或 "book:<bookId>"；不传默认当前书。' }
            },
            required: ['key']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          var v = HarnessMemory.get(args.key, args.namespace);
          if (v === undefined) return '（记忆不存在 / namespace=' + (args.namespace || '当前书') + '，key=' + args.key + '）';
          return '记忆值（namespace=' + (args.namespace || '当前书') + ', key=' + args.key + '）：\n' + (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
        }
      },
      {
        type: 'function',
        function: {
          name: 'harness_memo_set',
          description: '向 harness 长期记忆写入一个 key=value。namespace 不传=写入当前书；传"global"=写入跨书全局记忆。写入后永久生效（刷新不丢），下次调用 harness_memo_get 即可取回。',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '记忆键名（建议语义化，如 "pageOffsetVerified" / "userPrefersBriefAnswer"）' },
              value: { description: '记忆值（任意 JSON 可序列化类型：string/number/boolean/object/array）' },
              namespace: { type: 'string', description: '"global" 或 "book:<bookId>"；不传默认当前书。' }
            },
            required: ['key', 'value']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          HarnessMemory.set(args.key, args.value, args.namespace);
          return '✅ 已写入 harness 记忆（namespace=' + (args.namespace || '当前书') + ', key=' + args.key + '）：\n'
            + (typeof args.value === 'string' ? args.value : JSON.stringify(args.value, null, 2));
        }
      },
      {
        type: 'function',
        function: {
          name: 'harness_memo_del',
          description: '删除 harness 长期记忆里的某个 key（namespace 不传=当前书；传"global"=全局）',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '记忆键名' },
              namespace: { type: 'string', description: '"global" 或 "book:<bookId>"；不传默认当前书。' }
            },
            required: ['key']
          }
        },
        requiresApproval: false,
        handler: function(args) {
          HarnessMemory.del(args.key, args.namespace);
          return '✅ 已删除 harness 记忆（namespace=' + (args.namespace || '当前书') + ', key=' + args.key + '）';
        }
      }

    ];

    // 合并 AI 动态创建的自定义工具（编程系统核心：注册即生效）
    _ensureCustomToolsLoaded();
    for (var _ci = 0; _ci < _customTools.length; _ci++) {
      try { builtIn.push(_customToolToDef(_customTools[_ci])); } catch (e) {}
    }
    return builtIn;
  }

  // 根据工具名找到定义
  function _findToolDef(name) {
    var all = _getToolDefinitions();
    for (var i = 0; i < all.length; i++) {
      if (all[i].function && all[i].function.name === name) return all[i];
    }
    return null;
  }

  // 审批弹窗：返回 Promise<boolean>
  function _requestApproval(promptText) {
    return new Promise(function(resolve) {
      var body = document.getElementById('paChatBody');
      var box = document.createElement('div');
      box.className = 'pa-msg pa-msg-bot';
      box.style.cssText = 'border:1px solid #ffb74d;background:#fff8e1;border-radius:8px;';
      box.innerHTML = '<div style="font-weight:bold;margin-bottom:6px;">⚠ 此操作需要确认</div>'
        + '<div style="margin-bottom:10px;">' + _escapeHtml(promptText) + '</div>'
        + '<button class="pa-approve-confirm" style="background:#e53935;color:#fff;border:0;padding:6px 14px;border-radius:6px;margin-right:8px;cursor:pointer;">确认执行</button>'
        + '<button class="pa-approve-cancel" style="background:#e0e0e0;color:#333;border:0;padding:6px 14px;border-radius:6px;cursor:pointer;">取消</button>';
      body.appendChild(box);
      body.scrollTop = body.scrollHeight;
      var resolveDone = false;
      var done = function(ok) { if (resolveDone) return; resolveDone = true; box.remove(); resolve(ok); };
      box.querySelector('.pa-approve-confirm').onclick = function() { done(true); };
      box.querySelector('.pa-approve-cancel').onclick = function() { done(false); };
    });
  }

  // ===================== Harness 步骤流渲染 =====================
  // follow 模式下，AI 执行工具时用卡片化步骤流展示进度（工具名+参数+结果+耗时）
  // silent 模式不创建 harness，只显示占位与最终结果

  // 创建一个 Harness 容器并插入聊天区，返回容器元素
  
  function _createHarness(intentLabel) {
    var body = document.getElementById('paChatBody');
    if (!body) return null;
    var el = document.createElement('div');
    el.className = 'pa-msg pa-msg-bot';
    el.innerHTML =
      '<div class="pa-harness">' +
        '<div class="pa-harness-header">' +
          '<span class="pa-harness-spinner"></span>' +
          '<span class="pa-harness-title">' + _escapeHtml(intentLabel || '执行任务中…') + '</span>' +
          '<span class="pa-harness-summary"></span>' +
          '<span class="pa-harness-toggle" title="折叠/展开">▼</span>' +
        '</div>' +
        '<div class="pa-harness-thinking"></div>' +
        '<div class="pa-harness-steps"></div>' +
      '</div>';
    // 点击 header 折叠/展开（完成态默认自动折叠）
    var header = el.querySelector('.pa-harness-header');
    header.addEventListener('click', function(){
      el.querySelector('.pa-harness').classList.toggle('collapsed');
      var t = el.querySelector('.pa-harness-toggle');
      if (t) t.textContent = el.querySelector('.pa-harness').classList.contains('collapsed') ? '▶' : '▼';
    });
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function _addHarnessThinking(harnessEl, thoughtText) {
    if (!harnessEl) return null;
    var t = harnessEl.querySelector('.pa-harness-thinking');
    if (!t) return null;
    var block = document.createElement('div');
    block.className = 'pa-harness-thought';
    block.innerHTML = '<span class="pa-harness-thinking-icon">💭</span><span class="pa-harness-thinking-text"></span>';
    block.querySelector('.pa-harness-thinking-text').textContent = thoughtText;
    t.appendChild(block);
    return block;
  }

  function _addHarnessStep(harnessEl, name, argsText, status) {
    if (!harnessEl) return null;
    var steps = harnessEl.querySelector('.pa-harness-steps');
    if (!steps) return null;
    var step = document.createElement('div');
    step.className = 'pa-harness-step';
    step.innerHTML =
      '<span class="pa-harness-step-icon ' + (status || 'pending') + '">' + _harnessIcon(status) + '</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="pa-harness-step-name">' + _escapeHtml(name) + '</div>' +
        (argsText ? '<div class="pa-harness-step-args">' + _escapeHtml(argsText) + '</div>' : '') +
        '<div class="pa-harness-step-result" style="display:none;"></div>' +
      '</div>' +
      '<span class="pa-harness-step-time"></span>';
    steps.appendChild(step);
    // 步骤点击可手动切换折叠详情（完成态自动折叠后，用户仍可展开查看）
    step.addEventListener('click', function(e){
      // 避免点到展开按钮等造成的冲突：只切换 collapsed class
      step.classList.toggle('pa-step-done-collapsed');
    });
    _scrollChatBottom();
    return step;
  }

  function _updateHarnessStep(stepEl, status, resultText, timeMs) {
    if (!stepEl) return;
    var icon = stepEl.querySelector('.pa-harness-step-icon');
    if (icon) {
      icon.className = 'pa-harness-step-icon ' + (status || 'pending');
      icon.textContent = _harnessIcon(status);
    }
    if (resultText !== undefined && resultText !== null) {
      var r = stepEl.querySelector('.pa-harness-step-result');
      if (r) { r.style.display = 'block'; r.textContent = resultText; }
    }
    if (timeMs !== undefined && timeMs !== null) {
      var t = stepEl.querySelector('.pa-harness-step-time');
      if (t) t.textContent = timeMs + 'ms';
    }
    // —— 关键：单个步骤完成/报错后，立即自动折叠详情（用户要求弱化指令调动信息） ——
    if (status === 'done' || status === 'error') {
      stepEl.classList.add('pa-step-done-collapsed');
    }
    _scrollChatBottom();
  }

  function _collapseOldHarnessSteps(harnessEl, keepCount) {
    if (!harnessEl) return;
    var steps = harnessEl.querySelectorAll('.pa-harness-step');
    var total = steps.length;
    for (var i = 0; i < total - keepCount; i++) {
      var step = steps[i];
      // 统一走 pa-step-done-collapsed（完成折叠样式 v2）
      step.classList.add('pa-step-done-collapsed');
    }
    // 加一个展开按钮（只显示一次）
    var hasExpand = harnessEl.querySelector('.pa-harness-step-expand-all');
    if (total > keepCount && !hasExpand) {
      var lastStep = steps[total - keepCount - 1] || null;
      if (!lastStep) return;
      var expandBtn = document.createElement('span');
      expandBtn.className = 'pa-harness-step-expand pa-harness-step-expand-all';
      expandBtn.textContent = '展开 ' + (total - keepCount) + ' 步详情';
      expandBtn.onclick = (function(hEl, n) {
        return function() {
          var allSteps = hEl.querySelectorAll('.pa-harness-step');
          for (var j = 0; j < allSteps.length - n; j++) {
            allSteps[j].classList.remove('pa-step-done-collapsed');
          }
          this.remove();
        };
      })(harnessEl, keepCount);
      lastStep.after(expandBtn);
    }
  }

  function _finalizeHarness(harnessEl, summaryText) {
    if (!harnessEl) return;
    var h = harnessEl.querySelector('.pa-harness');
    // v2: 使用 pa-harness-stage-done + collapsed 实现"阶段完成即自动折叠"
    if (h) {
      h.classList.add('pa-harness-done');
      h.classList.add('pa-harness-stage-done');
      h.classList.add('collapsed');
    }
    var title = harnessEl.querySelector('.pa-harness-title');
    if (title) title.textContent = summaryText || '任务完成';
    var summary = harnessEl.querySelector('.pa-harness-summary');
    if (summary) summary.textContent = '✓ 完成';
    var toggle = harnessEl.querySelector('.pa-harness-toggle');
    if (toggle) toggle.textContent = '▶';
    var thinking = harnessEl.querySelector('.pa-harness-thinking');
    if (thinking) thinking.style.display = 'none';
    // 阶段完成时只显示最近 0 步（全折叠），配合用户"完成后折叠分阶段的小目标"需求
    _collapseOldHarnessSteps(harnessEl, 0);
    _scrollChatBottom();
  }

  // 多轮（长任务）完成时追加一个醒目的最终总结卡片（凸显最后总结）
  function _addFinalSummary(totalTurns, totalToolCalls, finalText) {
    var body = document.getElementById('paChatBody');
    if (!body) return;
    var el = document.createElement('div');
    el.className = 'pa-msg pa-msg-bot';
    var card = document.createElement('div');
    card.className = 'pa-final-summary';
    card.innerHTML =
      '<div class="pa-final-title">🐛 书虫助手 · 任务完成</div>' +
      '<div>共执行 ' + (totalTurns|0) + ' 轮推理，调用工具 ' + (totalToolCalls|0) + ' 次。</div>';
    if (finalText && String(finalText).trim()) {
      var hr = document.createElement('hr'); card.appendChild(hr);
      var summaryContent = document.createElement('div');
      summaryContent.innerHTML = _renderMarkdown(finalText);
      card.appendChild(summaryContent);
    }
    el.appendChild(card);
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }
function _harnessIcon(status) {
    if (status === 'running') return '◐';
    if (status === 'done') return '✓';
    if (status === 'error') return '✗';
    return '○';
  }

  function _scrollChatBottom() {
    var body = document.getElementById('paChatBody');
    if (body) body.scrollTop = body.scrollHeight;
  }

  // 工具参数预览（key=value 简短展示）
  function _argsPreview(argsRaw) {
    try {
      var a = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
      if (!a || typeof a !== 'object') return '';
      var parts = [];
      for (var k in a) {
        if (a.hasOwnProperty(k)) {
          var v = a[k];
          var s = typeof v === 'string' ? v : JSON.stringify(v);
          parts.push(k + '=' + _truncate(s, 30));
        }
      }
      return parts.join(', ');
    } catch (e) { return ''; }
  }

  function _truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // 队列状态统计：返回多状态计数字符串
  function _summarizeQueue(cmds) {
    if (!cmds || !cmds.length) return '队列为空（0 条任务）';
    var counts = {};
    var order = ['pending', 'strategizing', 'strategy_ready', 'awaiting_approval', 'approved', 'applying', 'done', 'failed', 'rejected', 'rolled_back'];
    for (var i = 0; i < cmds.length; i++) {
      var st = cmds[i].status || 'unknown';
      counts[st] = (counts[st] || 0) + 1;
    }
    var parts = [];
    for (var k = 0; k < order.length; k++) {
      if (counts[order[k]]) parts.push(order[k] + '=' + counts[order[k]]);
    }
    if (counts.unknown) parts.push('unknown=' + counts.unknown);
    return '队列共 ' + cmds.length + ' 条任务：' + parts.join(', ');
  }

  // 执行单个 tool_call，返回 Promise<string> 结果文本
  function _runOneToolCall(tc) {
    var fn = tc.function || {};
    var name = fn.name;
    var argsRaw = fn.arguments || '{}';
    var args;
    try { args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw; }
    catch (e) { return Promise.reject(new Error('工具参数 JSON 解析失败: ' + argsRaw)); }

    var def = _findToolDef(name);
    if (!def) return Promise.resolve('❌ 未知工具: ' + name);

    var runHandler = function() {
      try {
        var r = def.handler(args || {});
        return Promise.resolve(r);
      } catch (e) {
        return Promise.reject(e);
      }
    };

    if (def.requiresApproval) {
      var promptText = (typeof def.approvalPrompt === 'function') ? def.approvalPrompt(args) : ('即将执行 ' + name + '，是否确认？');
      return _requestApproval(promptText).then(function(ok) {
        if (!ok) return '🔒 用户已取消：' + name;
        return runHandler();
      });
    }
    return runHandler();
  }

  // 构建带上下文的基础消息列表
  function _buildBaseMessages(userText) {
    // 预取当前书记忆（含 pageOffsetVerified / pageOffset 等），直接注入 system prompt，让 AI 不用额外调工具就知道有没有核对过。
    var curBookId = _hmCurrentBookId();
    var bm = {};
    try {
      var hmStore = _hmLoad();
      if (hmStore && hmStore.books && hmStore.books[curBookId]) bm = JSON.parse(JSON.stringify(hmStore.books[curBookId]));
    } catch (e) {}
    var bookMemoLine = '';
    if (bm && (bm.pageOffsetVerified || bm.pageOffset !== undefined || Object.keys(bm).length > 0)) {
      bookMemoLine = '\n【当前书记忆（Harness Memory）】\n'
        + JSON.stringify(bm)
        + '\n→ 若 pageOffsetVerified=true，说明该书"PDF 实际页码 vs 目录编号"已经校验过，本次无需再读任何目录页核对，直接用 pdf_getTOC 的 pageNum 跳转即可。\n\n';
    } else {
      bookMemoLine = '\n【当前书记忆（Harness Memory）】（暂无）。成功跳章后会自动写入 pageOffsetVerified=true，下次无需再读目录页核对。\n\n';
    }

    // —— 展板启用状态（HTML / MD 是否被用户打开）—— 注入 system prompt，让 AI 自动配合
    var bf = {html: false, md: false};
    try {
      if (window.PageAgent && window.PageAgent._Board && window.PageAgent._Board.formats) {
        bf = window.PageAgent._Board.formats;
      } else {
        // 兜底：如果 _Board 还没初始化，读 localStorage
        var saved = JSON.parse(localStorage.getItem('shuchongu_board_formats_v1') || 'null');
        if (saved && typeof saved === 'object') {
          bf.html = !!saved.html; bf.md = !!saved.md;
        } else {
          bf.html = true; bf.md = false;   // 默认只开 HTML
        }
      }
    } catch(e) {}
    var boardHint = '【书虫展板（右侧同步面板）】\n'
      + '  当前启用格式（由用户顶栏「📐 HTML / 📋 MD」开关决定，没启用的你禁止生成对应内容！）：html=' + (bf.html?'开':'关') + ', md=' + (bf.md?'开':'关') + '\n'
      + '  工作规则（无感自动更新！不需要用户说"用展板"）：\n'
      + '   (1) 只要相应格式是开的，你在完成用户主需求的同时，要把辅助理解信息自动同步到展板：\n'
      + '       - 教程/操作演示类请求：HTML Tab 做按步骤动态演示（步骤卡 + .active 呼吸光环 + pa-progress 进度条 + 必要时用 pageagent_* 驱动真实页面一步步操作给用户看）；MD Tab 放结构化步骤清单、知识点、注意事项、对比表格、FAQ。\n'
      + '       - 知识性请求：MD Tab 放结构化总结（标题/列表/表格/引用）；HTML Tab 可放可视化图谱或思维导图（如果 html 启用）。\n'
      + '       - 翻章/跳页/阅读请求：MD Tab 放当前章节定位（目录树上当前章节高亮、起止页码、预估阅读时长、重点提示）；HTML Tab 可做步骤演示。\n'
      + '   (2) 展板 6 个工具：board_renderHtml / board_renderMd / board_render（推荐，一次同时传 html+md 最省 token） / board_switchTab / board_toggle / board_clear。\n'
      + '   (3) 展板内可模拟真实操作：PageAgent Lite 工具（只用于演示，不要用它翻书/读目录，翻书继续用 pdf_* 工具）：\n'
      + '       · pageagent_screenshot() 先看一眼页面 UI / 控件布局 / 当前页号\n'
      + '       · pageagent_click(selector 或 text) 点一个按钮/链接\n'
      + '       · pageagent_type(selector 或 label 文字 + value) 给输入框输入内容\n'
      + '       · pageagent_scroll(top 或 pxBy) 滚动页面\n'
      + '       典型用法：做"真实操作演示"时，先用 board_renderHtml 渲染一个 5 步卡，第 i 步 .active 高亮 → 调用一次 pageagent_click 点真实按钮 → 再把进度条改到 i/5 → 循环。\n'
      + '   (4) 什么时候不生成？如果格式没启用（html=false 就不调 renderHtml，md=false 就不调 renderMd）—— 它们会直接 return 不生成，所以你也可以无脑传（render 会自动过滤没启用的）。\n'
      + '   (5) 输出风格要求：HTML 要高级感，用预置 class（.pa-demo-card / .pa-step / .pa-step-num(.active) / .pa-step-kbd / .pa-tags / .pa-progress+.pa-progress-bar / .pa-fake-btn(.ghost/.warn) / .pa-bubble）；MD 要凝练条理，避免和对话区重复。\n\n';

    var system = {
      role: 'system',
      content: '你是"书虫助手"，嵌入在一个学术文献阅读器里。你拥有所有阅读器功能的直接调用权限（通过 tools）。\n'
        + '工作方式：当用户说"翻到第5页"、"显示目录"、"切换高亮工具"、"删除选中"这类操作请求时，先调用对应工具，不要直接回答如何操作。\n'
        + '用户问知识性问题（概念解释、总结、翻译等）直接回答，不要调用工具。\n'
        + '关键操作（如删除标注）会需要用户审批，你直接调用即可，审批由系统负责。\n'
        + '回答要简洁，尽量一次完成用户请求，最小化工具调用轮次。\n\n'
        + boardHint
        + bookMemoLine
        + '【跳章节最佳实践（必读）】\n'
        + '用户要求跳到某个章节（如"翻到第6章"、"去腹部检查"）时，严格遵循以下步骤，禁止多余操作：\n'
        + '  步骤 0：先看上面"当前书记忆"，如果 pageOffsetVerified=true，说明"目录编号=PDF 实际页码"已经核对过，目录里的 pageNum 就是可以直接跳的 PDF 页码，不再需要读目录页做任何核对。\n'
        + '  步骤 1：调用 pdf_getTOC 获取目录（仅 1 次，不要重复）\n'
        + '  步骤 2：在目录中匹配到目标章节的 pageNum 后，**立即调用 pdf_jumpToPage(pageNum) 完成跳转**\n'
        + '  ❌ 禁止：不要再用 pdf_getPageText 去"阅读目录页"验证页码——pdf_getTOC 返回的 pageNum 就是目标页，直接跳。\n'
        + '  ❌ 禁止：跳转到目标页后，除非用户明确要求朗读/总结该页内容，否则不要再调用 pdf_getPageText 读取正文。\n\n'
        + '【读内容最佳实践】\n'
        + '如果用户明确要求"总结某章"，流程是：pdf_getTOC → 定位起止页码 → 按需要 pdf_getPageText 只读取正文的页面（不要读目录所在的页面）。\n'
        + '调用 pdf_getPageText 时，如用户未特别要求详细内容，请指定合理的 maxChars（例如 3000），避免 token 爆炸。\n\n'
        + '【Harness Memory（ harness 长期记忆）】\n'
        + '你有长期记忆：harness_memo_get / harness_memo_set（namespace 默认是当前书，传 "global" 则跨书记忆）。\n'
        + '用法示例：\n'
        + '  - harness_memo_get(key="pageOffsetVerified") → true/false；\n'
        + '  - harness_memo_set(key="userFavoriteLanguage", value="zh-CN", namespace="global")。\n'
        + '记忆原则：**做过一次的确定事实就记下来，下次同类任务不再重复执行同一个"验证/兜底"工具。**\n'
        + '典型记忆点：某本书已做过目录→页码核对、某本书目录结构、用户常用输出格式、某次解释用户说过"讲得太细以后简洁点"等。\n\n'
        + '【工具调用轮次限制】\n'
        + '每轮对话最多可进行 12 次 LLM 推理（即 tool_calls 循环），超过则中止。所以要在最少的轮次内完成目标，不要做冗余/重复的工具调用。\n'
        + '如果单次 LLM 返回了多个 tool_calls，可一次性并行执行（你只需把多个 tool_calls 一起返回即可，系统会按顺序执行）。\n\n'
        + '【AI 编程系统】当现有工具无法满足用户需求时，你可以用 system_createTool 创建新工具：定义工具名、描述、参数 schema 和 handler 代码（JS）。handler 可通过 ctx 访问所有核心模块（ctx.PDFReader/ctx.Notebook/ctx.DataLayer/ctx.PDFAnnotate/ctx.FileManager/ctx.ReferenceManager/ctx.AIEngine/ctx.AppShell/ctx.fetch 等）。创建后该工具立即可被调用。用 system_listCustomTools 查看已有自定义工具，system_deleteCustomTool 删除。\n'
        + '示例：用户要"统计当前笔记的字数"——你可以创建工具 wordcount，code 为：return "当前笔记字数：" + (ctx.Notebook.getPageMdDirect ? ctx.Notebook.getPageMdDirect().length : "未知"); 然后直接调用它。'
    };
    return [system, { role: 'user', content: userText }];
  }

  // 读取最近对话消息合并到 messages（保留最新 N 轮，含已完成 tool 调用）
  function _mergeRecentHistory(messages, thinking, maxCount) {
    var body = document.getElementById('paChatBody');
    if (!body) return;
    var allMsgs = body.querySelectorAll('.pa-msg');
    // __role 和 __content 由 _addMessage 存储，tool 消息用额外 data-*
    var pairs = [];
    // API 合法的角色集合（白名单）
    var LEGAL_ROLES = { system: 1, user: 1, assistant: 1, tool: 1 };
    for (var i = 0; i < allMsgs.length; i++) {
      var m = allMsgs[i];
      if (m === thinking) continue;
      var role = m.__role || (m.classList.contains('pa-msg-user') ? 'user' : 'assistant');
      // 第二道保险：规范化非法 role（bot / latest_reminder 等）
      if (!LEGAL_ROLES[role]) role = 'assistant';
      var content = m.__content;
      if (content === undefined || content === null) content = (m.textContent || '').trim();
      if (!content) continue;
      // tool call 消息用 m.__assistantWithTools 和 m.__toolResults 重建
      if (m.__assistantWithTools) {
        var at = JSON.parse(JSON.stringify(m.__assistantWithTools));
        if (!LEGAL_ROLES[at.role]) at.role = 'assistant';
        pairs.push(at);
        if (Array.isArray(m.__toolResults)) {
          for (var j = 0; j < m.__toolResults.length; j++) {
            var tr = JSON.parse(JSON.stringify(m.__toolResults[j]));
            if (!LEGAL_ROLES[tr.role]) tr.role = 'tool';
            pairs.push(tr);
          }
        }
      } else {
        pairs.push({ role: role, content: content });
      }
    }
    var last = pairs.slice(-(maxCount * 2));

    // ===== 关键：保证 messages 链的完整性 =====
    // API 强制要求：role=tool 的消息必须紧跟在一个带 tool_calls 的 assistant 消息之后（一一对应）。
    // 否则会 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
    // 所以这里做完整性校验 + 修复：
    //   a) 去掉序列开头就出现的孤立 tool 消息（它对应的 assistant 不在 last 里）
    //   b) 扫描消息链，若某个 tool 消息找不到（同一段内）匹配的 tool_call_id，则丢弃
    function _validateMessageChain(arr) {
      if (!arr || !arr.length) return [];
      var out = [];
      var pendingToolCallIds = null;
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          // 开始一段 tool_calls：记录允许的 tool_call_id 集合
          pendingToolCallIds = {};
          for (var tc = 0; tc < m.tool_calls.length; tc++) {
            pendingToolCallIds[m.tool_calls[tc].id] = true;
          }
          out.push(m);
        } else if (m.role === 'tool') {
          if (!pendingToolCallIds) {
            // 孤立 tool 消息（前面没有 assistant tool_calls 段），丢弃
            continue;
          }
          if (m.tool_call_id && !pendingToolCallIds[m.tool_call_id]) {
            // tool_call_id 不在当前段允许范围内，丢弃
            continue;
          }
          out.push(m);
          // 当前段的所有 tool_calls 都消耗完毕时，重置等待
          delete pendingToolCallIds[m.tool_call_id];
          var remain = 0;
          for (var kkk in pendingToolCallIds) if (pendingToolCallIds[kkk]) { remain++; break; }
          if (remain === 0) pendingToolCallIds = null;
        } else {
          // 普通 user / assistant（无 tool_calls）/ system：重置段
          pendingToolCallIds = null;
          out.push(m);
        }
      }
      return out;
    }

    last = _validateMessageChain(last);

    // 插入到 user message 之前
    for (var k = 0; k < last.length; k++) {
      messages.splice(messages.length - 1, 0, last[k]);
    }
  }

  // 追加页面当前状态（一次）
  function _appendPdfSnapshot(messages) {
    try {
      if (typeof PDFReader !== 'undefined' && PDFReader.getCurrentPage) {
        var p = PDFReader.getCurrentPage();
        var total = PDFReader.getPageCount ? PDFReader.getPageCount() : 0;
        var z = typeof PDFReader.getCurrentZoom === 'function' ? Math.round(Number(PDFReader.getCurrentZoom()||1)*100) : null;
        var tool = (typeof PDFAnnotate !== 'undefined' && PDFAnnotate.getTool) ? (PDFAnnotate.getTool() || 'none') : null;
        var snap = '[当前状态快照] 第 ' + p + (total>0?' / '+total:'') + ' 页' + (z!==null?', 缩放 '+z+'%':'') + (tool?', 标注工具: '+tool:'');
        messages[0].content += '\n' + snap;
      }
    } catch(e) {}
  }

  // ⭐ Tool Calling 主入口
  function _aiChatWithTools(userText) {
    var config = null;
    if (typeof AppShell !== 'undefined' && AppShell.getAIConfig) config = AppShell.getAIConfig();
    if (!config || !config.apiKey) {
      _addMessage('bot', '⚠ 尚未配置 AI API Key，请先点击 ⚡ → 「AI 设置」配置。\n\n或者输入以下快捷指令：\n书架 / 阅读 / 笔记 / 附件 / 划重点 / 帮助');
      return;
    }

    var body = document.getElementById('paChatBody');
    var thinking = document.createElement('div');
    thinking.className = 'pa-msg pa-msg-bot pa-msg-thinking';
    thinking.innerHTML = '<span class="pa-dot"></span><span class="pa-dot"></span><span class="pa-dot"></span>';
    body.appendChild(thinking);
    body.scrollTop = body.scrollHeight;

    var provider = config.provider || 'openai';
    var baseUrl = config.baseUrl || '';
    var apiKey = config.apiKey || '';
    var model = config.model || '';
    var opts = { model: model, temperature: 0.4 };

    // 准备工具定义（拆成发送给 LLM 的 schema + 名字→处理函数映射）
    var allTools = _getToolDefinitions();
    var toolsSchema = [];
    for (var t = 0; t < allTools.length; t++) toolsSchema.push({ type: allTools[t].type, function: { name: allTools[t].function.name, description: allTools[t].function.description, parameters: allTools[t].function.parameters } });
    opts.tools = toolsSchema;

    // 构造消息 + 上下文 + 当前状态
    var messages = _buildBaseMessages(userText);
    _appendPdfSnapshot(messages);
    _mergeRecentHistory(messages, thinking, 4);

    // —— 循环：call LLM → 如有 tool_calls → 依次执行 → 把结果 append 到 messages → 再 call LLM ——
    // 最多 12 轮（原 5 轮太低，翻章节 + 读 TOC + 跨页操作很容易超过），防止死循环
    var TOTAL_TURNS = 12;
    var statTotalToolCalls = 0;  // 累计工具调用次数
    var statTurnsWithTools = 0; // 累计"阶段"数（有工具调用的 LLM 返回轮次）
    function loop(remainingTurns) {
      var usedTurns = TOTAL_TURNS - remainingTurns;
      if (remainingTurns <= 0) {
        // 轮次用尽时也尝试给个总结卡片
        try { _addFinalSummary(usedTurns, statTotalToolCalls, '⚠ 任务在第 ' + usedTurns + ' 轮因推理上限提前中止。'); } catch(e){}
        finishError('工具调用轮次过多（已执行 ' + TOTAL_TURNS + ' 轮 LLM 推理），任务中止。建议简化指令或分步操作。');
        return;
      }
      if (usedTurns === 8 || usedTurns === 10) {
        _addMessage('bot', '⏱ 已执行 ' + usedTurns + '/' + TOTAL_TURNS + ' 轮工具推理，即将达到上限，请耐心等待…');
      }
      return Promise.resolve().then(function() {
        return AIAdapter.chatWithTools(provider, baseUrl, apiKey, messages, opts);
      }).then(function(msg) {
        // case 1：没有工具调用，直接展示文本 → 追加醒目最终总结卡片
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          thinking.remove();
          var finalContent = (msg.content && msg.content.trim()) ? msg.content : '（空回复）';
          _addMessage('bot', finalContent);
          // 只有真正调用过工具时才显示"最终总结"，否则简单问答会不必要地出现大卡片
          if (statTotalToolCalls > 0 || statTurnsWithTools > 0) {
            try { _addFinalSummary(usedTurns + 1, statTotalToolCalls, finalContent); } catch(e){}
          }
          return;
        }
        // case 2：有工具调用 → Harness 步骤流（follow）/ 静默占位（silent）
        thinking.remove();
        statTurnsWithTools += 1;
        statTotalToolCalls += (msg.tool_calls ? msg.tool_calls.length : 0);

        // 保留 assistant 消息 + 后续 tool 消息供对话历史重建使用
        var assistantRecord = {
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.tool_calls.map(function(tc) { return { id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }; })
        };
        messages.push(assistantRecord);

        var intentLabel = (msg.content || '').trim() || ('调用 ' + msg.tool_calls.length + ' 个工具');
        var harnessEl = null;
        var silentPlaceholder = null;

        if (_execMode === 'silent') {
          // 后台静默：只显示一行"处理中"占位
          silentPlaceholder = _addMessage('bot', '🔄 ' + intentLabel + '…（后台执行中）');
          silentPlaceholder.__role = 'assistant';
          silentPlaceholder.__assistantWithTools = assistantRecord;
        } else {
          // 跟随模式：创建 Harness 步骤流容器
          harnessEl = _createHarness(intentLabel);
          if (harnessEl) {
            harnessEl.__role = 'assistant';
            harnessEl.__assistantWithTools = assistantRecord;
          }
        }

        // 顺序执行所有 tool_calls（并行可能导致审批 UI 冲突）
        var toolResults = [];
        var seq = Promise.resolve();
        msg.tool_calls.forEach(function(tc) {
          seq = seq.then(function() {
            var toolName = (tc.function && tc.function.name) || 'unknown';
            var argsPreview = _argsPreview(tc.function && tc.function.arguments);
            var stepEl = harnessEl ? _addHarnessStep(harnessEl, toolName, argsPreview, 'running') : null;
            var t0 = Date.now();
            return _runOneToolCall(tc).then(function(resultText) {
              var dt = Date.now() - t0;
              var content = String(resultText == null ? '' : resultText);
              toolResults.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: content });
              if (stepEl) _updateHarnessStep(stepEl, 'done', _truncate(content, 140), dt);
            }).catch(function(err) {
              var dt = Date.now() - t0;
              var errMsg = err && err.message ? err.message : String(err);
              toolResults.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: 'ERROR: ' + errMsg });
              if (stepEl) _updateHarnessStep(stepEl, 'error', '错误: ' + _truncate(errMsg, 140), dt);
            });
          });
        });

        seq.then(function() {
          // 注入 tool 结果到 messages 供下一轮 LLM 使用
          var targetEl = harnessEl || silentPlaceholder;
          if (targetEl) targetEl.__toolResults = toolResults.slice();
          for (var i = 0; i < toolResults.length; i++) {
            messages.push({ role: 'tool', tool_call_id: toolResults[i].tool_call_id, content: toolResults[i].content });
          }

          var okCount = toolResults.filter(function(r) { return String(r.content).indexOf('ERROR:') !== 0; }).length;
          var total = toolResults.length;

          if (_execMode === 'silent') {
            // 静默模式：不要 remove 占位（否则 __assistantWithTools/__toolResults 丢失，下轮历史重建会变成孤立 tool 消息）
            // 改为原地替换成简洁完成消息，并保留 __assistantWithTools + __toolResults 供历史重建
            if (silentPlaceholder) {
              silentPlaceholder.classList.remove('pa-msg-thinking');
              silentPlaceholder.innerHTML = '';
              var silentTextNode = document.createElement('div');
              silentTextNode.className = 'pa-text';
              var silentSummary = '✅ 后台任务已完成（' + okCount + '/' + total + ' 步成功）';
              silentTextNode.textContent = silentSummary;
              silentPlaceholder.appendChild(silentTextNode);
              // 内容同步更新，避免重建时被当作 thinking 跳过
              silentPlaceholder.__content = silentSummary;
              silentPlaceholder.__role = 'assistant';
            }
          } else {
            // 跟随模式：标记 harness 完成（立即自动折叠阶段）
            _finalizeHarness(harnessEl, '完成 ' + okCount + '/' + total + ' 步');
          }

          body.scrollTop = body.scrollHeight;
          loop(remainingTurns - 1);
        }).catch(function(e) {
          finishError('工具执行异常：' + (e && e.message ? e.message : e));
        });
      }).catch(function(e) {
        finishError('AI 请求失败：' + (e && e.message ? e.message : String(e)) + '\n\n请检查 API 配置是否正确。');
      });
    }

    function finishError(msgText) {
      if (thinking && thinking.parentNode) thinking.remove();
      _addMessage('bot', '⚠ ' + msgText);
    }

    loop(TOTAL_TURNS);
  }

  // ---------- 快捷操作 ----------
  function _doAction(action) {
    switch (action) {
      case 'shelf':
        var bs = document.getElementById('btnViewShelf');
        if (bs) bs.click();
        break;
      case 'read':
        var br = document.getElementById('btnViewRead');
        if (br) br.click();
        break;
      case 'note':
        var bn = document.getElementById('btnViewNote');
        if (bn) bn.click();
        break;
      case 'attach':
        var ba = document.getElementById('btnViewAttach');
        if (ba) ba.click();
        break;
      case 'highlight':
        var bh = document.getElementById('btnHighlightTop') || document.getElementById('btnHighlight');
        if (bh) { bh.click(); } else {
          _addMessage('bot', '使用顶部工具栏的标注工具（🖍高亮/﹏下划线/⬜框/🖊钢笔/📝卡片/✎编辑），或让我通过 annot_* 工具显式帮你一步步划重点（支持批量多页 + 配色护栏）。');
        }
        break;
      case 'settings':
        if (typeof AppShell !== 'undefined' && AppShell.openSettings) AppShell.openSettings();
        break;
      case 'help':
        var bhelp = document.getElementById('btnHelp');
        if (bhelp) bhelp.click();
        break;
    }
  }

  // ---------- 初始化 ----------
  function init() {
    // 延迟创建，避免与主 DOM 初始化冲突
    requestAnimationFrame(function() {
      _createDOM();
    });
    // 尝试初始化阿里 PageAgent（真正的自主 GUI Agent，能自主点击/填写/操作网页）
    _initAlibabaPageAgent();
  }

  // 阿里 PageAgent 实例引用
  var _alibabaAgent = null;
  var _alibabaInitTried = false;

  function _initAlibabaPageAgent() {
    if (_alibabaInitTried) return;
    var AlibabaPA = window.AlibabaPageAgent;
    if (!AlibabaPA || typeof AlibabaPA !== 'function') {
      // CDN 可能还在加载或加载失败，2 秒后重试一次
      setTimeout(function() {
        if (!_alibabaInitTried) _initAlibabaPageAgent();
      }, 2000);
      return;
    }
    _alibabaInitTried = true;
    // 等待 AI 配置加载完成（AppShell._loadConfig 是异步的）
    _waitForAIConfig(function(cfg) {
      if (!cfg || !cfg.apiKey) {
        console.log('[PageAgent] AI 配置未设置，阿里 PageAgent 暂不初始化（配置后刷新即可生效）');
        return;
      }
      try {
        _alibabaAgent = new AlibabaPA({
          model: cfg.model || 'deepseek-v4-flash',
          baseURL: cfg.baseUrl || 'https://api.deepseek.com/v1',
          apiKey: cfg.apiKey,
          language: 'zh-CN',
          instructions: {
            system: '这是"书虫蛊"，一个学术文献/教材阅读器。页面包含：PDF阅读区（有翻页按钮、页码输入框、缩放控件、目录按钮）、标注工具栏（高亮、下划线、矩形框、钢笔、卡片）、笔记编辑区、书架视图。用户会用自然语言要求你执行操作（如"翻到第5页"、"显示目录"、"切换到高亮工具"、"放大"等），你需要通过分析页面DOM找到对应的按钮/输入框/控件并点击或填写来完成操作。'
          }
        });
        console.log('[PageAgent] 阿里 PageAgent 已初始化（模型: ' + (cfg.model || 'deepseek-v4-flash') + '），AI 可自主操作网页');
      } catch (e) {
        console.error('[PageAgent] 阿里 PageAgent 初始化失败:', e);
      }
    });
  }

  // 轮询等待 AI 配置就绪（最多 10 秒）
  function _waitForAIConfig(cb) {
    var tries = 0;
    function check() {
      tries++;
      if (typeof AppShell !== 'undefined' && AppShell.getAIConfig) {
        var cfg = AppShell.getAIConfig();
        if (cfg && cfg.apiKey) { cb(cfg); return; }
      }
      if (tries < 20) setTimeout(check, 500);
      else cb(null);
    }
    check();
  }

  return {
    init: init
  };
})();
