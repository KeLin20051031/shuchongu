// ============================================================================
//  划重点图层引擎（v2 重写）
//  设计原则：
//   1. 划重点层 = PDF 之上的一张独立图层，全系统只有「一套坐标空间」：
//      base 空间 = PDF 基准视口（scale=1）的 CSS 像素。所有元素几何都存 base 空间。
//   2. 渲染是纯函数：屏幕坐标 = base 坐标 × 当前缩放 + 微调偏移，
//      渲染过程绝不改写任何存储状态（calib / rect / _meta 全部不碰）。
//   3. 图层上只有两类显式元素：marker（标记）与 card（解释卡片），
//      AI 与用户都是「作者」，权限对等，全部即时持久化。
//   4. 不保留旧版逐页「校准」换算；只保留一个可选的手动微调偏移（默认 0，不漂移）。
// v129: document 级 mousedown 兜底捕获 PDF 范围外卡片点击。
// v128: _onPointerDown 启动拖拽时动态在 window 添加 mousemove 监听，_onPointerUp 清理时移除，
//       彻底解决 SVG 绑定的 mousemove 在鼠标拖出 SVG 边界后停止触发、导致卡片无法拖出 PDF 边界的问题。
// v127: 卡片(.hl-card) resize 时解除 PDF 左右边界限制（nw/sw 方向 rect.x 不再受 Math.min 约束），
//       允许卡片左边缘溢出 PDF 边界自由拖动；其他标注类型保持现有约束不变。
//       卡片拖拽(drag)本身无边界约束（v126 已通过 _lastCanvas*/_lastOffset* 缓存使图层对齐解决）。
// ============================================================================
const PDFAnnotate = (function() {
  'use strict';

  // ---------- 模块状态 ----------
  var svg = null;                 // SVG 标注覆盖层（#pdfAnnotateLayer）
  var floatingNotesLayer = null;  // 浮动解释卡片层（#pdfFloatingNotesLayer）
  var container = null;           // 页面容器（canvas 的兄弟节点）
  var layerMap = {};              // pageNum -> [element]
  var currentPage = 0;
  var currentBookId = null;
  var itemCache = {};             // pageNum -> 文本项（供 locateQuote / 文本避让）
  var fineTune = { dx: 0, dy: 0 };// 手动微调偏移（屏幕像素，默认 0）
  var editTool = null;            // 当前工具：highlight|underline|rect|pen|card|null(查看)
  var textSelectMode = false;     // 文本选择模式：SVG 完全不拦截，PDF 文本层可自由划选
  var currentColor = '#ff6b6b';   // 手动标记默认色
  var drawingTools = { highlight: 1, underline: 1, rect: 1, pen: 1, card: 1 };
  var selectedIds = new Set();    // 多选集合（选中元素 id）
  var _clipboard = [];           // 复制/剪切剪贴板
  var _renderRs = 1;             // 本次渲染缩放（仅用于绘制换算）
  var _persistTimer = null;
  var _editHandlersBound = false;
  var _lastCanvasW = 0, _lastCanvasH = 0, _lastOffsetX = 0, _lastOffsetY = 0;  // 缓存最近一次 PDF 渲染的画布参数（内部 renderPage 调用时复用）
  // 快捷键工具映射：数字键 1-7 按住时临时切换工具，松开恢复
  var _heldToolKey = null;       // 当前按住的数字键对应的工具
  var _prevEditTool = null;      // 按数字键前的原工具（松开时恢复）
  var KEY_TOOL_MAP = { '1': 'highlight', '2': 'underline', '3': 'rect', '4': 'pen', '5': 'card', '6': 'select', '7': 'text-select' };
  // ALT+字母 → 颜色快捷改色
  var ALT_COLOR_MAP = { 'r': '#ff6b6b', 'b': '#2196f3', 'g': '#4caf50', 'y': '#f5a623', 'p': '#9c27b0', 'o': '#ff7043' };
  var _underlineConfig = { color: '#FFD700', style: 'solid', width: 3, applyAll: false };
  var _highlightConfig = { color: '#ff6b6b', opacity: 40, applyAll: false };
  var _rectConfig = { fillColor: '#ff6b6b', fillOpacity: 30, strokeColor: '#e74c3c', strokeWidth: 2, strokeStyle: 'solid', applyAll: false };
  var _cardConfig = { color: '#fffdf6', opacity: 85, applyAll: false };
  var _hlPanelCollapsed = false;

  // ---------- 配色（柔和学术风） ----------
  var COLOR_MEANING = {
    '#ff6b6b': { label: '重点',       bg: 'rgba(255,107,107,0.16)', line: '#ff6b6b', text: '#c62828' },
    '#f5a623': { label: '难点',       bg: 'rgba(245,166,35,0.16)',  line: '#f5a623', text: '#b36d00' },
    '#4caf50': { label: '易忽略考点', bg: 'rgba(76,175,80,0.16)',   line: '#4caf50', text: '#2e7d32' },
    '#2196f3': { label: '概念/定义',  bg: 'rgba(33,150,243,0.16)',  line: '#2196f3', text: '#1565c0' },
    '#9c27b0': { label: '记忆技巧',   bg: 'rgba(156,39,176,0.16)',  line: '#9c27b0', text: '#7b1fa2' },
    '#ff7043': { label: '易错点',     bg: 'rgba(255,112,67,0.16)',  line: '#ff7043', text: '#d84315' }
  };

  // ---------- 工具函数 ----------
  function genId() {
    return 'el_' + Date.now() + '_' + Math.floor(Math.random() * 1e6).toString(36);
  }
  function _isSelected(id) { return selectedIds.has(id); }
  function _toggleSelect(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  }
  function _clearSelection() { selectedIds.clear(); }
  function _selectAll(pageNum) {
    selectedIds.clear();
    var list = layerMap[pageNum] || [];
    for (var i = 0; i < list.length; i++) selectedIds.add(list[i].id);
    if (pageNum === currentPage) renderPage(pageNum);
  }
  function hexToRgba(hex, alpha) {
    hex = String(hex || '').replace('#','');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = parseInt(hex.substring(0,2), 16) || 0;
    var g = parseInt(hex.substring(2,4), 16) || 0;
    var b = parseInt(hex.substring(4,6), 16) || 0;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function lightenHex(hex) {
    hex = String(hex || '').replace('#','');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = Math.min(255, (parseInt(hex.substring(0,2), 16) || 0) + 10);
    var g = Math.min(255, (parseInt(hex.substring(2,4), 16) || 0) + 10);
    var b = Math.min(255, (parseInt(hex.substring(4,6), 16) || 0) + 10);
    return '#' + [r,g,b].map(function(v){ var s=v.toString(16); return s.length===1?'0'+s:s; }).join('');
  }
  function _normalizeColor(c) {
    if (!c) return '#ff6b6b';
    c = String(c).trim();
    if (COLOR_MEANING[c]) return c;
    var lower = c.toLowerCase();
    for (var k in COLOR_MEANING) { if (k.toLowerCase() === lower) return k; }
    return '#ff6b6b';
  }
  // base 空间 -> 屏幕（svg/floatingNotesLayer 局部）像素
  function toScreen(lx, ly) {
    return { x: lx * _renderRs + (fineTune.dx || 0), y: ly * _renderRs + (fineTune.dy || 0) };
  }
  // 屏幕（svg/floatingNotesLayer 局部）像素 -> base 空间
  function toLayer(sx, sy) {
    return { x: (sx - (fineTune.dx || 0)) / _renderRs, y: (sy - (fineTune.dy || 0)) / _renderRs };
  }
  // 命中测试：给定 base 空间点，返回最上层命中的元素 id
  function hitTest(lx, ly) {
    var list = layerMap[currentPage] || [];
    for (var i = list.length - 1; i >= 0; i--) {
      var el = list[i];
      var r = el.rect;
      if (!r) continue;
      if (lx >= r.x - 4 && lx <= r.x + r.w + 4 && ly >= r.y - 4 && ly <= r.y + r.h + 4) return el.id;
    }
    return null;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 极简 markdown：保留换行，支持 **粗体** 与 *斜体*
  function renderContent(s) {
    var esc = escapeHtml(s || '');
    esc = esc.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>');
    return '<div style="white-space:pre-wrap;word-break:break-word;">' + esc + '</div>';
  }

  // =========================================================================
  //  初始化 / DOM
  // =========================================================================
  function init(cont) {
    if (!cont) return;
    container = cont;
    // 若已存在则复用（pdf-reader 可能在多次渲染时重复调用）
    svg = document.getElementById('pdfAnnotateLayer');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'pdfAnnotateLayer';
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
      container.appendChild(svg);
    }
    floatingNotesLayer = document.getElementById('pdfFloatingNotesLayer');
    if (!floatingNotesLayer) {
      floatingNotesLayer = document.createElement('div');
      floatingNotesLayer.id = 'pdfFloatingNotesLayer';
      floatingNotesLayer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:6;';
      container.appendChild(floatingNotesLayer);
    }
    // 确保父容器是定位锚（svg 用 absolute 覆盖父容器尺寸；若父级无 position 则可能定位错位造成看起来"点不到"）
    try {
      var cs = window.getComputedStyle(container);
      if (!cs || (cs.position !== 'relative' && cs.position !== 'absolute' && cs.position !== 'fixed' && cs.position !== 'sticky')) {
        container.style.position = 'relative';
      }
    } catch (e) { /* ignore */ }
    _wireToolbar();
    // 每次 init 都确保当前这个 svg 有事件（pdf-reader 会清空 vp.innerHTML 重建 DOM，旧 SVG 被删、新 SVG 需要重绑）
    _attachEditHandlers();
    _applyPointerEvents();
    _loadAllConfigs();
    _initAllPanels();
    setTimeout(function(){ try{ _wireToolbar(true); }catch(e){} }, 2600);
    setTimeout(function(){ try{ _attachEditHandlers(); _applyPointerEvents(); }catch(e){} }, 3100);
  }

  // 绑定工具栏按钮：既支持旧的 #hlToolbar 包裹，也支持 P2-14 后「目录/划重点」
  // 一体导航栏里的 data-tool 按钮（与翻页/缩放同处一行）
  var _toolbarWired = false;
  function _wireToolbar(force) {
    // 找所有 data-tool 按钮（不限于 #hlToolbar），但跳过 display:none/visibility:hidden 的隐藏按钮
    var scope = document.getElementById('spacePdf') || document;
    var btns = scope.querySelectorAll('[data-tool]');
    var wiredAny = false;
    for (var idx = 0; idx < btns.length; idx++) {
      (function(btn) {
        if (btn._annotToolbarWired && !force) return;
        // 跳过已被 CSS 隐藏的旧按钮（#hlToolbar 内的占位按钮），避免把绑定浪费在永远不会被点击的元素上
        try {
          var st = window.getComputedStyle(btn);
          if (st && (st.display === 'none' || st.visibility === 'hidden')) { return; }
          var p = btn.parentElement;
          while (p && p !== scope) {
            var ps = window.getComputedStyle(p);
            if (ps && (ps.display === 'none' || ps.visibility === 'hidden')) { return; }
            p = p.parentElement;
          }
        } catch (e) { /* ignore */ }
        if (!btn._annotToolbarWired) {
          btn._annotToolbarWired = true;
          // 关键修复：移除 inline onclick，避免"先 inline 调 setTool → 再 listener 读已变更值 → 再 toggle 回来"的双重切换死循环
          // listener 里的 active 必须读 inline onclick 触发前的原始 editTool 值
          try { btn.removeAttribute('onclick'); btn.onclick = null; } catch (e) {}
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            var t = btn.getAttribute('data-tool');
            var active = (editTool === t);
            setTool(active ? null : t);
          });
          wiredAny = true;
        }
      })(btns[idx]);
    }
    _toolbarWired = true;
  }
  // 兜底：等 DOM 完全就绪后再补绑定一次，防止顶栏按钮在首次 _wireToolbar 调用时还没注入
  setTimeout(function() { try { _wireToolbar(false); } catch(e){} }, 400);
  setTimeout(function() { try { _wireToolbar(false); } catch(e){} }, 1500);

  // 根据当前工具切换图层的 pointer-events（查看模式不挡 PDF 划选）
  function _applyPointerEvents() {
    // 文本选择模式：SVG 完全不拦截，PDF 文本层可自由划选（此时不能点中标注，符合"只划文本"预期）
    if (textSelectMode) {
      if (svg) { svg.style.pointerEvents = 'none'; svg.setAttribute('pointer-events', 'none'); }
      if (floatingNotesLayer) floatingNotesLayer.style.pointerEvents = 'none';
      var scopeAll = document.getElementById('spacePdf') || document;
      var allBtns = scopeAll.querySelectorAll('[data-tool]');
      allBtns.forEach(function(b) { b.classList.remove('active'); });
      return;
    }
    // —— 关键修复：任何情况下（包括 editTool=null 默认态），SVG 本身都接受 pointer 事件
    //  只有这样 pointerdown 才会走 _onPointerDown，进而命中 hitTest → 选中/拖动/调整现有标注
    //  无工具时点击空白区域不创建新标注（_onPointerDown 内部已处理），不干扰 PDF 文本选择
    if (svg) svg.style.pointerEvents = 'auto';
    // 标注元素 [data-el-id]：只有绘制类工具（highlight/underline/rect/pen/card）时设为 none，
    //  保证拖拽创建时能穿透到 PDF 层选中文本；其他所有情况（select/null/eraser...）都允许点中标注
    var isDrawing = !!drawingTools[editTool];
    if (svg) {
      // SVG 自身的 SVG pointer-events 属性（区分于 style）
      svg.setAttribute('pointer-events', isDrawing ? 'none' : 'auto');
      var nodes = svg.querySelectorAll('[data-el-id]');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].setAttribute('pointer-events', isDrawing ? 'none' : 'auto');
      }
      // 操作按钮（删除、锚点、resize handle）：绘制工具时隐藏点击，其余始终可用
      var btns = svg.querySelectorAll('[data-btn], [data-resize], .hl-conn-anchor');
      for (var j = 0; j < btns.length; j++) {
        btns[j].setAttribute('pointer-events', isDrawing ? 'none' : 'auto');
      }
    }
    // 卡片层始终为纯视觉层（不拦截指针），所有交互由 svg 统一处理
    if (floatingNotesLayer) floatingNotesLayer.style.pointerEvents = 'none';
    // 高亮工具栏按钮激活态：所有带 data-tool 的按钮（一体导航栏 + 旧 hlToolbar）都一起刷新
    var scope = document.getElementById('spacePdf') || document;
    var all = scope.querySelectorAll('[data-tool]');
    all.forEach(function(b) {
      var t = b.getAttribute('data-tool');
      if (t === editTool) {
        b.classList.add('active');
        // 统一编辑按钮（select）：激活态加底色 + 白色字，与旧版保持一致
        if (t === 'select') {
          b.style.background = '#1a73e8';
          b.style.color = '#fff';
          b.style.borderColor = '#1a73e8';
        }
      } else {
        b.classList.remove('active');
        if (t === 'select') {
          b.style.background = '#e8f0fe';
          b.style.color = '#1a73e8';
          b.style.borderColor = '';
        }
      }
    });
  }

  // =========================================================================
  //  书籍身份 / 持久化 / 迁移
  // =========================================================================
  function setBookId(bookId) {
    currentBookId = bookId || null;
    layerMap = {};
    itemCache = {};
    fineTune = { dx: 0, dy: 0 };
    // 清除旧书的待持久化定时器，避免旧数据覆盖新书标注
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    if (currentBookId && typeof DataLayer !== 'undefined' && DataLayer.get) {
      try {
        return DataLayer.get('annotations', currentBookId).then(function(rec) {
          if (rec) {
            if (rec.pages) {
              for (var p in rec.pages) {
                if (rec.pages.hasOwnProperty(p)) {
                  layerMap[p] = (rec.pages[p] || []).map(_migrateElement).filter(Boolean);
                }
              }
            }
            if (rec.fineTune) fineTune = { dx: rec.fineTune.dx || 0, dy: rec.fineTune.dy || 0 };
          }
          renderPage(currentPage);
          return layerMap;
        }).catch(function() { renderPage(currentPage); return layerMap; });
      } catch (e) { /* ignore */ }
    }
    renderPage(currentPage);
    return Promise.resolve(layerMap);
  }

  // 旧版数据迁移：旧标注存的是「某缩放下的像素 + _meta.scale」；
  // 新模型统一存 base 空间（除以 _meta.scale）。旧卡片未持久化，无需迁移。
  function _migrateElement(el) {
    if (!el) return null;
    if (el.kind) return el; // 已是新格式
    var base = (el._meta && el._meta.scale && el._meta.scale > 0) ? el._meta.scale : _renderRs;
    var r = el.rect || (el.rects && el.rects[0]);
    if (!r || typeof r.x !== 'number') return null;
    var tool = 'rect';
    if (el.type === 'highlight') tool = 'highlight';
    else if (el.type === 'underline') tool = 'underline';
    else if (el.type === 'box') tool = 'rect';
    else tool = 'rect';
    return {
      id: el.id || genId(),
      kind: 'marker',
      tool: tool,
      rect: { x: r.x / base, y: r.y / base, w: r.w / base, h: r.h / base },
      color: _normalizeColor(el.color),
      quote: el.quote || '',
      label: el.label || '',
      author: 'ai',
      createdAt: Date.now()
    };
  }

  function _persist() {
    if (!currentBookId) return;
    if (typeof DataLayer === 'undefined' || !DataLayer.put) return;
    // 防抖：合并高频编辑
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(function() {
      _persistTimer = null;
      try {
        DataLayer.put('annotations', { id: currentBookId, pages: layerMap, fineTune: fineTune });
      } catch (e) { /* ignore */ }
    }, 250);
  }
  // 立即持久化（创建/删除等关键动作）
  function _persistNow() {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    if (!currentBookId || typeof DataLayer === 'undefined' || !DataLayer.put) return;
    try { DataLayer.put('annotations', { id: currentBookId, pages: layerMap, fineTune: fineTune }); } catch (e) {}
  }

  // =========================================================================
  //  元素 CRUD
  // =========================================================================
  function _pageList(pageNum) {
    if (!layerMap[pageNum]) layerMap[pageNum] = [];
    return layerMap[pageNum];
  }
  // 新增元素（marker / card 皆可）。返回创建的元素。
  function addElement(pageNum, el) {
    if (!el || !el.kind) return null;
    el.id = el.id || genId();
    el.createdAt = el.createdAt || Date.now();
    if (el.author !== 'ai' && el.author !== 'user') el.author = 'user';
    _pageList(pageNum).push(el);
    if (pageNum === currentPage) renderPage(pageNum);
    _persistNow();
    return el;
  }
  // 兼容旧调用名
  function addAnnotation(pageNum, el) { return addElement(pageNum, el); }

  function updateElement(pageNum, el) {
    if (!el || !el.id) return;
    var list = layerMap[pageNum] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === el.id) { list[i] = el; break; }
    }
    if (pageNum === currentPage) renderPage(pageNum);
    _persistNow();
  }

  function removeElement(pageNum, id) {
    var list = layerMap[pageNum];
    if (!list) return;
    layerMap[pageNum] = list.filter(function(e) { return e.id !== id; });
    if (selectedIds.has(id)) selectedIds.delete(id);
    if (pageNum === currentPage) renderPage(pageNum);
    _persistNow();
  }

  function getElements(pageNum) { return (layerMap[pageNum] || []).slice(); }
  function getAnnotations(pageNum) { return getElements(pageNum); }

  function setElements(pageNum, arr) {
    layerMap[pageNum] = (arr || []).map(_migrateElement).filter(Boolean);
    if (pageNum === currentPage) renderPage(pageNum);
    _persistNow();
  }
  function setAnnotations(pageNum, arr) { return setElements(pageNum, arr); }

  function clearPage(pageNum) {
    delete layerMap[pageNum];
    delete itemCache[pageNum];  // 清除文本定位缓存，避免与新标注冲突
    if (pageNum === currentPage) renderPage(pageNum);
    _persistNow();
  }
  function clearAll() {
    layerMap = {};
    itemCache = {};  // 同步清理缓存
    if (currentPage) renderPage(currentPage);
    _persistNow();
  }

  // =========================================================================
  //  渲染（纯函数，绝不改写存储）
  // =========================================================================
  function renderPage(pageNum, canvasW, canvasH, offsetX, offsetY, renderScale) {
    var pageChanged = (pageNum !== currentPage);
    currentPage = pageNum;
    if (!svg) return;
    // 仅在页面切换时强制中止拖拽/编辑状态，防止残留干扰；同页拖拽中需保留 _drag
    if (pageChanged) {
      if (_drag) { _clearPreview(); _drag = null; }
      _closeCardEditor();
    }
    _renderRs = (typeof renderScale === 'number' && renderScale > 0) ? renderScale : 1;

    // 清空
    svg.innerHTML = '';
    // 关键：innerHTML='' 会从 DOM 移除所有子元素，但 svg._previewGroup / _penPreview / _selPreview
    // 这些 JS 属性仍指向已脱离 DOM 的孤儿节点。若不清除引用，_updateCreatePreview 会误以为预览组
    // 已存在、只更新属性而不重新 appendChild → 预览画在了孤儿节点上，用户完全看不到实时效果。
    svg._previewGroup = null;
    svg._penPreview = null;
    svg._selPreview = null;
    if (floatingNotesLayer) floatingNotesLayer.innerHTML = '';

    // 缓存最近一次 PDF 渲染的画布参数：内部调用不传参时复用，避免 SVG/floatingNotesLayer 重置到 (0,0)
    if (typeof canvasW === 'number' && canvasW > 0) {
      _lastCanvasW = canvasW; _lastCanvasH = canvasH;
      _lastOffsetX = offsetX || 0; _lastOffsetY = offsetY || 0;
    }
    var top = (typeof offsetY === 'number') ? offsetY : _lastOffsetY;
    var left = (typeof offsetX === 'number') ? offsetX : _lastOffsetX;
    var useW = (typeof canvasW === 'number' && canvasW > 0) ? canvasW : _lastCanvasW;
    var useH = (typeof canvasH === 'number' && canvasH > 0) ? canvasH : _lastCanvasH;
    svg.style.top = top + 'px'; svg.style.left = left + 'px';
    if (useW > 0) {
      svg.style.width = useW + 'px';
      svg.style.height = useH + 'px';
    }
    if (floatingNotesLayer) {
      floatingNotesLayer.style.top = top + 'px';
      floatingNotesLayer.style.left = left + 'px';
      if (useW > 0) {
        floatingNotesLayer.style.width = useW + 'px';
        floatingNotesLayer.style.height = useH + 'px';
      }
    }

    var list = layerMap[pageNum] || [];
    var NS = 'http://www.w3.org/2000/svg';
    var leaderSpecs = [];
    var connSpecs = [];

    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.kind === 'marker') {
        _drawMarker(svg, NS, el);
      } else if (el.kind === 'card') {
        _drawCard(el, leaderSpecs, connSpecs);
      }
    }

    // 绘制旧引出线（卡片 -> 所解释标记）
    for (var j = 0; j < leaderSpecs.length; j++) _drawLeader(svg, NS, leaderSpecs[j]);

    // 绘制可调连接线（标记↔卡片）
    for (var k = 0; k < connSpecs.length; k++) _drawConnection(svg, NS, connSpecs[k]);

    // 选中态描边（编辑模式）：遍历所有选中元素
    if (editTool && selectedIds.size > 0) {
      selectedIds.forEach(function(sid) {
        var sel = _findEl(pageNum, sid);
        if (sel && sel.rect) {
          var s = toScreen(sel.rect.x, sel.rect.y);
          var selRect = document.createElementNS(NS, 'rect');
          selRect.setAttribute('x', s.x - 2); selRect.setAttribute('y', s.y - 2);
          selRect.setAttribute('width', sel.rect.w * _renderRs + 4);
          selRect.setAttribute('height', sel.rect.h * _renderRs + 4);
          selRect.setAttribute('fill', 'none');
          selRect.setAttribute('stroke', '#3b82f6');
          selRect.setAttribute('stroke-dasharray', '4 3');
          selRect.setAttribute('pointer-events', 'none');
          svg.appendChild(selRect);
          if (sel.kind === 'marker' || sel.kind === 'card') _drawResizeHandles(svg, NS, sel);
        }
      });
    }
    // 多选浮动菜单（选中 ≥2 个元素时显示）
    _renderMultiSelectMenu(pageNum, list);
  }

  // 多选操作菜单
  function _renderMultiSelectMenu(pageNum, list) {
    var existing = document.getElementById('hlMultiSelectMenu');
    if (existing) existing.remove();
    if (selectedIds.size < 2 || !editTool) return;

    // 计算选中区域包围盒的屏幕坐标
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var hasRect = false;
    selectedIds.forEach(function(sid) {
      var sel = _findEl(pageNum, sid);
      if (!sel || !sel.rect) return;
      hasRect = true;
      if (sel.rect.x < minX) minX = sel.rect.x;
      if (sel.rect.y < minY) minY = sel.rect.y;
      if (sel.rect.x + sel.rect.w > maxX) maxX = sel.rect.x + sel.rect.w;
      if (sel.rect.y + sel.rect.h > maxY) maxY = sel.rect.y + sel.rect.h;
    });
    if (!hasRect) return;

    var topLeft = toScreen(minX, minY);
    var menu = document.createElement('div');
    menu.id = 'hlMultiSelectMenu';
    menu.style.cssText = 'position:absolute;left:' + (topLeft.x - 2) + 'px;top:' + (topLeft.y - 34) + 'px;' +
      'background:#1e293b;color:#e2e8f0;border-radius:6px;padding:4px 8px;font-size:12px;' +
      'display:flex;gap:6px;align-items:center;pointer-events:auto;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    menu.textContent = selectedIds.size + ' 个已选中 ';

    var btnDel = document.createElement('button');
    btnDel.textContent = '批量删除';
    btnDel.style.cssText = 'background:#ef4444;color:#fff;border:none;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;';
    btnDel.addEventListener('mousedown', function(ev) {
      ev.preventDefault(); ev.stopPropagation();
      var ids = Array.from(selectedIds);
      ids.forEach(function(sid) { removeElement(currentPage, sid); });
      _clearSelection();
      renderPage(currentPage);
      _persistNow();
    });
    menu.appendChild(btnDel);

    var btnCancel = document.createElement('button');
    btnCancel.textContent = '取消选择';
    btnCancel.style.cssText = 'background:transparent;color:#94a3b8;border:1px solid #475569;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;';
    btnCancel.addEventListener('mousedown', function(ev) {
      ev.preventDefault(); ev.stopPropagation();
      _clearSelection();
      renderPage(currentPage);
    });
    menu.appendChild(btnCancel);

    if (floatingNotesLayer) floatingNotesLayer.appendChild(menu);
  }

  function _findEl(pageNum, id) {
    var list = layerMap[pageNum] || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function _drawMarker(svgRoot, NS, el) {
    if (!el.rect || isNaN(el.rect.x) || isNaN(el.rect.y) || isNaN(el.rect.w) || isNaN(el.rect.h)) return;
    var s = toScreen(el.rect.x, el.rect.y);
    var w = el.rect.w * _renderRs, h = el.rect.h * _renderRs;
    var cm = COLOR_MEANING[_normalizeColor(el.color)] || COLOR_MEANING['#ff6b6b'];
    var node;
    if (el.tool === 'pen' && el.points && el.points.length > 1) {
      var d = el.points.map(function(p, i) {
        var sp = toScreen(p.x, p.y);
        return (i === 0 ? 'M' : 'L') + sp.x.toFixed(1) + ',' + sp.y.toFixed(1);
      }).join(' ');
      node = document.createElementNS(NS, 'path');
      node.setAttribute('d', d);
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', cm.line);
      node.setAttribute('stroke-width', 3);
      node.setAttribute('stroke-linecap', 'round');
      node.setAttribute('stroke-linejoin', 'round');
      node.style.pointerEvents = drawingTools[editTool] ? 'none' : 'auto';
      node.dataset.id = el.id;
    } else if (el.tool === 'underline') {
      var ucColor = el.color || _underlineConfig.color || '#FFD700';
      var ucStyle = el.style || _underlineConfig.style || 'solid';
      var ucWidth = (el.width !== undefined ? el.width : _underlineConfig.width) || 3;
      var yBase = s.y + h - ucWidth / 2;
      if (ucStyle === 'wavy') {
        node = document.createElementNS(NS, 'path');
        var amp = 4, period = 12, halfP = period / 2;
        var d = 'M' + s.x.toFixed(1) + ',' + yBase.toFixed(1);
        d += ' Q' + (s.x + halfP/2).toFixed(1) + ',' + (yBase - amp).toFixed(1) + ' ' + (s.x + halfP).toFixed(1) + ',' + yBase.toFixed(1);
        for (var cx = s.x + period; cx <= s.x + w + halfP; cx += halfP) {
          d += ' T' + cx.toFixed(1) + ',' + yBase.toFixed(1);
        }
        node.setAttribute('d', d);
        node.setAttribute('fill', 'none');
        node.setAttribute('stroke', ucColor);
        node.setAttribute('stroke-width', ucWidth);
        node.setAttribute('stroke-linecap', 'round');
      } else if (ucStyle === 'double') {
        node = document.createElementNS(NS, 'g');
        var l1 = document.createElementNS(NS, 'line');
        l1.setAttribute('x1', s.x); l1.setAttribute('y1', yBase - ucWidth);
        l1.setAttribute('x2', s.x + w); l1.setAttribute('y2', yBase - ucWidth);
        l1.setAttribute('stroke', ucColor); l1.setAttribute('stroke-width', ucWidth);
        node.appendChild(l1);
        var l2 = document.createElementNS(NS, 'line');
        l2.setAttribute('x1', s.x); l2.setAttribute('y1', yBase + ucWidth);
        l2.setAttribute('x2', s.x + w); l2.setAttribute('y2', yBase + ucWidth);
        l2.setAttribute('stroke', ucColor); l2.setAttribute('stroke-width', ucWidth);
        node.appendChild(l2);
      } else if (ucStyle === 'dashed') {
        node = document.createElementNS(NS, 'line');
        node.setAttribute('x1', s.x); node.setAttribute('y1', yBase);
        node.setAttribute('x2', s.x + w); node.setAttribute('y2', yBase);
        node.setAttribute('stroke', ucColor); node.setAttribute('stroke-width', ucWidth);
        node.setAttribute('stroke-dasharray', '8,4');
        node.setAttribute('stroke-linecap', 'round');
      } else { // solid 默认
        node = document.createElementNS(NS, 'line');
        node.setAttribute('x1', s.x); node.setAttribute('y1', yBase);
        node.setAttribute('x2', s.x + w); node.setAttribute('y2', yBase);
        node.setAttribute('stroke', ucColor); node.setAttribute('stroke-width', ucWidth);
        node.setAttribute('stroke-linecap', 'round');
      }
      node.style.pointerEvents = drawingTools[editTool] ? 'none' : 'auto';
      node.dataset.id = el.id;
    } else if (el.tool === 'rect') {
      var rFillColor = el.fillColor || _rectConfig.fillColor || '#ff6b6b';
      var rFillOpacity = (el.fillOpacity !== undefined ? el.fillOpacity : _rectConfig.fillOpacity || 30) / 100;
      var rStrokeColor = el.strokeColor || _rectConfig.strokeColor || '#e74c3c';
      var rStrokeWidth = el.strokeWidth !== undefined ? el.strokeWidth : (_rectConfig.strokeWidth || 2);
      var rStrokeStyle = el.strokeStyle || _rectConfig.strokeStyle || 'solid';
      var dashMap = { dashed: '8,4', dotted: '2,4' };
      node = document.createElementNS(NS, 'rect');
      node.setAttribute('x', s.x); node.setAttribute('y', s.y);
      node.setAttribute('width', w); node.setAttribute('height', h);
      node.setAttribute('fill', hexToRgba(rFillColor, rFillOpacity));
      node.setAttribute('stroke', rStrokeColor);
      node.setAttribute('stroke-width', rStrokeWidth);
      node.setAttribute('rx', 4);
      if (rStrokeStyle !== 'solid' && dashMap[rStrokeStyle]) node.setAttribute('stroke-dasharray', dashMap[rStrokeStyle]);
      node.style.pointerEvents = drawingTools[editTool] ? 'none' : 'auto';
      node.dataset.id = el.id;
    } else { // highlight（默认）
      var hcColor = el.color || _highlightConfig.color || '#ff6b6b';
      var hcOpacity = ((el.opacity !== undefined ? el.opacity : _highlightConfig.opacity) || 40) / 100;
      node = document.createElementNS(NS, 'rect');
      node.setAttribute('x', s.x); node.setAttribute('y', s.y);
      node.setAttribute('width', w); node.setAttribute('height', h);
      node.setAttribute('fill', hcColor);
      node.setAttribute('opacity', hcOpacity);
      node.setAttribute('rx', 3);
      node.style.pointerEvents = drawingTools[editTool] ? 'none' : 'auto';
      node.dataset.id = el.id;
    }
    // 标记上若有 label，画一个小圆点方便定位
    if (el.label) {
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', s.x + 2); t.setAttribute('y', s.y - 4);
      t.setAttribute('font-size', Math.max(10, 11 * _renderRs));
      t.setAttribute('fill', cm.text);
      t.textContent = el.label;
      t.style.pointerEvents = 'none';
      svgRoot.appendChild(t);
    }
    svgRoot.appendChild(node);
  }

  function _drawCard(el, leaderSpecs, connSpecs) {
    if (!floatingNotesLayer || !el.rect || isNaN(el.rect.x) || isNaN(el.rect.y) || isNaN(el.rect.w) || isNaN(el.rect.h)) return;
    var s = toScreen(el.rect.x, el.rect.y);
    var w = el.rect.w * _renderRs, h = el.rect.h * _renderRs;
    var card = document.createElement('div');
    var cc = _cardConfig || { color: '#fffdf6', opacity: 85 };
    var cardBgColor = el.bgColor || cc.color || '#fffdf6';
    var cardOpacity = ((el.opacity !== undefined ? el.opacity : cc.opacity) || 85) / 100;
    // 确保元素有 rotation 持久值（首次创建时随机 -1~+1 度）
    if (el.rotation === undefined) el.rotation = (Math.random() * 2 - 1).toFixed(3);
    var rot = parseFloat(el.rotation) || 0;
    card.className = 'hl-card' + (el.author === 'ai' ? ' hl-card-ai' : ' hl-card-user');
    card.style.cssText = 'position:absolute;left:' + s.x + 'px;top:' + s.y + 'px;width:' + w + 'px;min-height:' + h + 'px;box-sizing:border-box;padding-left:36px;'
      + 'background:linear-gradient(135deg, ' + hexToRgba(cardBgColor, cardOpacity) + ' 0%, ' + hexToRgba(lightenHex(cardBgColor), cardOpacity) + ' 100%);'
      + 'transform:rotate(' + rot + 'deg);';
    card.dataset.id = el.id;

    // 左侧拖动手柄
    var handle = document.createElement('div');
    handle.className = 'hl-card-handle';
    handle.style.cssText = 'pointer-events:auto;';
    if (_drag && _drag.elId === el.id) handle.style.pointerEvents = 'none';
    handle.addEventListener('mousedown', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      _drag = { mode: 'move', elId: el.id, origRect: Object.assign({}, el.rect), startLayer: _localPoint(ev) };
      renderPage(currentPage);
    });
    card.appendChild(handle);

    // 内容区
    var body = document.createElement('div');
    body.className = 'hl-card-body';
    body.innerHTML = renderContent(el.content || '');
    card.appendChild(body);

    // 卡片交互统一走 SVG 层 hitTest 路由（方案A：纯 SVG 代理模式）
    floatingNotesLayer.appendChild(card);

    // 连接线系统优先：若卡片有 connections 则渲染可调连接线，否则走旧引出线
    if (el.connections && el.connections.length > 0 && connSpecs) {
      for (var ci = 0; ci < el.connections.length; ci++) {
        var conn = el.connections[ci];
        var markerEl = _findEl(currentPage, conn.targetElId);
        if (markerEl && markerEl.rect) {
          connSpecs.push({
            cardId: el.id, targetElId: conn.targetElId,
            cardRect: el.rect, markerRect: markerEl.rect,
            cardAnchor: conn.cardAnchor, cardOffset: conn.cardOffset,
            targetAnchor: conn.targetAnchor, targetOffset: conn.targetOffset,
            connIndex: ci
          });
        }
      }
    } else if (el.anchorId) {
      // 旧引出线（仅当没有 connections 时）
      var anchor = _findEl(currentPage, el.anchorId);
      if (anchor && anchor.rect) {
        leaderSpecs.push({
          from: { x: anchor.rect.x + anchor.rect.w / 2, y: anchor.rect.y + anchor.rect.h / 2 },
          to: { x: el.rect.x, y: el.rect.y + el.rect.h / 2 }
        });
      }
    }
  }

  function _drawLeader(svgRoot, NS, spec) {
    var a = toScreen(spec.from.x, spec.from.y);
    var b = toScreen(spec.to.x, spec.to.y);
    var line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#94a3b8');
    line.setAttribute('stroke-width', 1.5);
    line.setAttribute('stroke-dasharray', '3 3');
    line.setAttribute('pointer-events', 'none');
    svgRoot.appendChild(line);
  }

  // 连接线系统: 计算矩形某边上的点 (坐标均为 PDF 空间)
  function _getEdgePoint(rect, side, offset) {
    offset = Math.max(0, Math.min(1, offset));
    if (side === 'top')    return { x: rect.x + rect.w * offset, y: rect.y };
    if (side === 'bottom') return { x: rect.x + rect.w * offset, y: rect.y + rect.h };
    if (side === 'left')   return { x: rect.x, y: rect.y + rect.h * offset };
    /* right */            return { x: rect.x + rect.w, y: rect.y + rect.h * offset };
  }

  // 连接线系统: 找点最近的边 (坐标均为 PDF 空间)
  function _findNearestEdge(rect, pt) {
    var cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    var ax = rect.w ? Math.abs(pt.x - cx) / (rect.w / 2) : 1;
    var ay = rect.h ? Math.abs(pt.y - cy) / (rect.h / 2) : 1;
    if (ax >= ay) {
      return { side: pt.x >= cx ? 'right' : 'left', offset: rect.h ? Math.max(0, Math.min(1, (pt.y - rect.y) / rect.h)) : 0.5 };
    } else {
      return { side: pt.y >= cy ? 'bottom' : 'top', offset: rect.w ? Math.max(0, Math.min(1, (pt.x - rect.x) / rect.w)) : 0.5 };
    }
  }

  // 连接线系统: 绘制虚线 + 两端可拖动锚点
  function _drawConnection(svgRoot, NS, spec) {
    var cardPt  = _getEdgePoint(spec.cardRect,  spec.cardAnchor,  spec.cardOffset);
    var targetPt = _getEdgePoint(spec.markerRect, spec.targetAnchor, spec.targetOffset);
    var a = toScreen(cardPt.x, cardPt.y);
    var b = toScreen(targetPt.x, targetPt.y);

    var line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#3b82f6');
    line.setAttribute('stroke-width', 1.5);
    line.setAttribute('stroke-dasharray', '4 3');
    line.setAttribute('pointer-events', 'none');
    svgRoot.appendChild(line);

    var pe = editTool ? 'auto' : 'none';
    [{ end: 'card', x: a.x, y: a.y }, { end: 'target', x: b.x, y: b.y }].forEach(function(d) {
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', d.x); c.setAttribute('cy', d.y);
      c.setAttribute('r', 5);
      c.setAttribute('fill', '#3b82f6');
      c.setAttribute('stroke', '#ffffff');
      c.setAttribute('stroke-width', 1.5);
      c.setAttribute('data-conn-card-id', spec.cardId);
      c.setAttribute('data-conn-target-id', spec.targetElId);
      c.setAttribute('data-conn-end', d.end);
      c.setAttribute('data-conn-index', spec.connIndex);
      c.classList.add('hl-conn-anchor');
      c.setAttribute('pointer-events', pe);
      svgRoot.appendChild(c);
    });
  }

  function _drawResizeHandles(svgRoot, NS, el) {
    var s = toScreen(el.rect.x, el.rect.y);
    var w = el.rect.w * _renderRs, h = el.rect.h * _renderRs;
    var corners = [
      { dir: 'nw', x: s.x - 6, y: s.y - 6, cursor: 'nwse-resize' },
      { dir: 'ne', x: s.x + w - 6, y: s.y - 6, cursor: 'nesw-resize' },
      { dir: 'sw', x: s.x - 6, y: s.y + h - 6, cursor: 'nesw-resize' },
      { dir: 'se', x: s.x + w - 6, y: s.y + h - 6, cursor: 'nwse-resize' }
    ];
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      var hdl = document.createElementNS(NS, 'rect');
      hdl.setAttribute('x', c.x); hdl.setAttribute('y', c.y);
      hdl.setAttribute('width', 12); hdl.setAttribute('height', 12);
      hdl.setAttribute('fill', '#3b82f6');
      hdl.setAttribute('stroke', '#fff');
      hdl.setAttribute('stroke-width', 1.5);
      hdl.setAttribute('cursor', c.cursor);
      hdl.setAttribute('data-resize', el.id + '-' + c.dir);
      svgRoot.appendChild(hdl);
    }
  }

  // =========================================================================
  //  手动编辑：画标记 / 建卡片 / 拖动 / 缩放 / 编辑内容
  // =========================================================================
  var _drag = null; // {mode, startClientX, startClientY, startLayer, elId, origRect, previewNode, points}
  var _windowMoveHandler = null; // v128: window 级别 mousemove 监听器引用，解决拖出 SVG 后事件丢失
  // P2-12：流畅性优化 — move / resize 时 rAF 合并 renderPage，避免每次 mousemove 整页重绘卡顿
  var _rMoveRaf = 0;
  var _editingCardId = null; // 当前正在编辑的卡片 id

  function _localPoint(e) {
    if (!svg) return { x: 0, y: 0 };
    var rect = svg.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      // SVG 被隐藏或尺寸为 0 时，降级用 document.body 做粗略定位（避免直接报错导致整个流程中断）
      rect = document.body.getBoundingClientRect();
    }
    // touchend 时 e.touches 为空数组，必须降级到 e.changedTouches
    var touch = (e.touches && e.touches.length > 0) ? e.touches[0]
      : (e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0] : null;
    var cx = touch ? (touch.clientX - rect.left) : (e.clientX - rect.left);
    var cy = touch ? (touch.clientY - rect.top) : (e.clientY - rect.top);
    var p = toLayer(cx, cy);
    // 保护 _renderRs 未初始化时的除以 0 情况
    if (!isFinite(p.x)) p.x = 0;
    if (!isFinite(p.y)) p.y = 0;
    return p;
  }

  function _attachEditHandlers() {
    if (!svg) return;
    // 以 svg 自身为粒度标记，避免：旧 svg 被删除后 _editHandlersBound 全局仍 true 导致新 svg 再也不绑事件
    if (svg.__editHandlersBound) return;
    svg.__editHandlersBound = true;
    // 去重标志：同一事件对象一次手势只处理一次（Pointer→mouse/touch 的 compatibility 事件全部跳过），
    // 防止 _drag 被覆盖两次、以及 pointerdown preventDefault 后 mouseup 不再触发导致卡死在"拖动中"
    var mark = function(e) { if (e._annotHandled) return false; e._annotHandled = true; return true; };
    var down = function(e) { if (!mark(e)) return; try { _onPointerDown(e); } catch(err){ console.error('[annot down]', err); } };
    var move = function(e) { if (!mark(e)) return; try { _onPointerMove(e); } catch(err){ console.error('[annot move]', err); } };
    var up   = function(e) { if (!mark(e)) return; try { _onPointerUp(e);   } catch(err){ console.error('[annot up]',   err); } };
    // —— 主链：Pointer Events（现代浏览器统一鼠标/触屏/笔；pointercancel=手势被系统打断也要清空 _drag）——
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    // —— 降级链：mouse + touch（极少数不支持 Pointer 的老浏览器）——
    svg.addEventListener('mousedown', down);
    svg.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    svg.addEventListener('touchstart', down, { passive: false });
    svg.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up);

    svg.addEventListener('dblclick', function(e){ try { _onSvgDblClick(e); } catch(err){} });

    // v129: document 级 mousedown 兜底，捕获 PDF 范围外的卡片点击
    if (!document.__annotDocDownBound) {
      document.__annotDocDownBound = true;
      document.addEventListener('mousedown', _onDocumentDown);
    }

    // 全局快捷键
    document.addEventListener('keydown', function(ev) {
      var ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

      // ALT+字母：快捷改色（对选中的标注生效，不需要进入编辑模式）
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
        var colorKey = ALT_COLOR_MAP[(ev.key || '').toLowerCase()];
        if (colorKey && selectedIds.size > 0) {
          ev.preventDefault();
          selectedIds.forEach(function(sid) {
            var el = _findEl(currentPage, sid);
            if (!el) return;
            if (el.tool === 'rect') {
              el.strokeColor = colorKey; // 框默认改外框颜色
            } else {
              el.color = colorKey;
            }
          });
          renderPage(currentPage);
          _persistNow();
          return;
        }
      }

      // 数字键 1-7：按住临时切换工具（松开恢复）
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && KEY_TOOL_MAP[ev.key]) {
        if (!_heldToolKey) {
          var tool = KEY_TOOL_MAP[ev.key];
          if (tool === 'text-select') {
            // 文本选择模式：SVG 不拦截，PDF 文本层可自由划选
            textSelectMode = true;
            editTool = null;
            _applyPointerEvents();
            renderPage(currentPage);
            _heldToolKey = 'text-select';
          } else if (tool === 'select') {
            _prevEditTool = editTool;
            editTool = 'select';
            _heldToolKey = 'select';
            _applyPointerEvents();
            renderPage(currentPage);
          } else {
            _prevEditTool = editTool;
            editTool = tool;
            _heldToolKey = tool;
            if (textSelectMode) { textSelectMode = false; var sBtn = document.getElementById('btnHlSelect'); if (sBtn) sBtn.classList.remove('active'); }
            _clearSelection();
            _applyPointerEvents();
            renderPage(currentPage);
          }
        }
        ev.preventDefault();
        return;
      }

      // 以下快捷键仅在编辑模式下生效
      if (!editTool) return; // 查看态不拦截

      // Ctrl+A 全选
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'a') {
        ev.preventDefault();
        _selectAll(currentPage);
        return;
      }
      // Ctrl+C 复制
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'c') {
        ev.preventDefault();
        _clipboard = [];
        selectedIds.forEach(function(sid) {
          var el = _findEl(currentPage, sid);
          if (el) _clipboard.push(JSON.parse(JSON.stringify(el)));
        });
        return;
      }
      // Ctrl+X 剪切
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'x') {
        ev.preventDefault();
        _clipboard = [];
        var xIds = Array.from(selectedIds);
        xIds.forEach(function(sid) {
          var el = _findEl(currentPage, sid);
          if (el) _clipboard.push(JSON.parse(JSON.stringify(el)));
          removeElement(currentPage, sid);
        });
        _clearSelection();
        renderPage(currentPage);
        _persistNow();
        return;
      }
      // Ctrl+V 粘贴
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'v') {
        ev.preventDefault();
        if (_clipboard.length > 0) {
          _clearSelection();
          _clipboard.forEach(function(el) {
            var newEl = JSON.parse(JSON.stringify(el));
            newEl.id = genId();
            newEl.rect.x += 20; newEl.rect.y += 20;
            addElement(currentPage, newEl);
            selectedIds.add(newEl.id);
          });
          _persistNow();
        }
        return;
      }
      // Backspace / Delete 删除选中元素
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        if (selectedIds.size > 0) {
          var delIds = Array.from(selectedIds);
          delIds.forEach(function(sid) { removeElement(currentPage, sid); });
          _clearSelection();
          renderPage(currentPage);
          _persistNow();
        }
      }
    });

    // keyup：松开数字键时恢复原工具
    document.addEventListener('keyup', function(ev) {
      if (KEY_TOOL_MAP[ev.key] && _heldToolKey) {
        if (_heldToolKey === 'text-select') {
          textSelectMode = false;
          _applyPointerEvents();
          var sBtn2 = document.getElementById('btnHlSelect');
          if (sBtn2) sBtn2.classList.remove('active');
        } else {
          editTool = _prevEditTool || null;
          _applyPointerEvents();
          renderPage(currentPage);
        }
        _heldToolKey = null;
        _prevEditTool = null;
      }
    });
  }
  function _onDocumentDown(e) {
    if (!editTool) return;
    if (_drag) return; // SVG handler 已处理
    if (!floatingNotesLayer) return;

    // 遍历所有卡片，检查点击坐标是否落入卡片 bounding rect
    var cards = floatingNotesLayer.querySelectorAll('.hl-card');
    var hitCardId = null;
    for (var i = cards.length - 1; i >= 0; i--) {
      var cr = cards[i].getBoundingClientRect();
      if (e.clientX >= cr.left && e.clientX <= cr.right &&
          e.clientY >= cr.top && e.clientY <= cr.bottom) {
        hitCardId = cards[i].dataset.id;
        break;
      }
    }
    if (!hitCardId) return;

    // 坐标转换: client -> SVG 局部 -> base 空间
    var svgRect = svg.getBoundingClientRect();
    var sx = e.clientX - svgRect.left;
    var sy = e.clientY - svgRect.top;
    var lp = toLayer(sx, sy);
    var hitId = hitTest(lp.x, lp.y);
    if (!hitId) return;

    // 选中逻辑（与 _onPointerDown 一致）
    if (e.ctrlKey || e.metaKey) {
      _toggleSelect(hitId);
      renderPage(currentPage);
    } else if (!_isSelected(hitId)) {
      _clearSelection();
      selectedIds.add(hitId);
      renderPage(currentPage);
    }

    // 启动拖拽
    var origRects = {};
    selectedIds.forEach(function(sid) {
      var selEl = _findEl(currentPage, sid);
      if (selEl && selEl.rect) origRects[sid] = Object.assign({}, selEl.rect);
    });
    var hitEl = _findEl(currentPage, hitId);
    _drag = { mode: 'move', elId: hitId, origRect: hitEl ? Object.assign({}, hitEl.rect) : {}, origRects: origRects, startLayer: lp };
    e.preventDefault(); e.stopPropagation();
    if (!_windowMoveHandler) { _windowMoveHandler = function(ev) { _onPointerMove(ev); }; window.addEventListener('mousemove', _windowMoveHandler); }
  }

  // 双击：若命中卡片则打开内容编辑器（任何态都允许，不依赖 editTool）
  function _onSvgDblClick(e) {
    var lp = _localPoint(e);
    var id = hitTest(lp.x, lp.y);
    if (!id) return;
    var el = _findEl(currentPage, id);
    if (el && el.kind === 'card') _openCardEditor(id);
  }

  function _onPointerDown(e) {
    // 无工具激活时也允许选择/拖拽/编辑现有标注（相当于默认进入"查看+编辑选择"模式）
    // 只有创建新 marker/card/pen/underline/highlight 才需要特定 editTool
    var target = e.target;
    // 缩放手柄（支持四角 resize，data-resize="elId-方向"）
    if (target && target.getAttribute && target.getAttribute('data-resize')) {
      var raw = target.getAttribute('data-resize');
      var dashIdx = raw.lastIndexOf('-');
      var id = dashIdx > -1 ? raw.substring(0, dashIdx) : raw;
      var dir = dashIdx > -1 ? raw.substring(dashIdx + 1) : 'se';
      var el = _findEl(currentPage, id);
      if (el && el.rect) {
        _drag = { mode: 'resize', elId: id, origRect: Object.assign({}, el.rect), startLayer: _localPoint(e), direction: dir };
        e.preventDefault(); e.stopPropagation();
        if (!_windowMoveHandler) { _windowMoveHandler = function(ev) { _onPointerMove(ev); }; window.addEventListener('mousemove', _windowMoveHandler); }
        return;
      }
    }
    // 连接线锚点拖拽
    if (target && target.classList && target.classList.contains('hl-conn-anchor')) {
      var cardId = target.getAttribute('data-conn-card-id');
      var targetElId = target.getAttribute('data-conn-target-id');
      var end = target.getAttribute('data-conn-end');
      var connIdx = parseInt(target.getAttribute('data-conn-index'));
      _drag = { mode: 'move-anchor', cardId: cardId, targetElId: targetElId, end: end, connIndex: connIdx, startLayer: _localPoint(e) };
      e.preventDefault(); e.stopPropagation();
      if (!_windowMoveHandler) { _windowMoveHandler = function(ev) { _onPointerMove(ev); }; window.addEventListener('mousemove', _windowMoveHandler); }
      return;
    }
    var lp = _localPoint(e);
    // 确定当前生效的创建工具（数字键临时工具优先）
    var activeCreateTool = null;
    if (_heldToolKey && drawingTools[_heldToolKey]) activeCreateTool = _heldToolKey;
    else if (editTool && drawingTools[editTool]) activeCreateTool = editTool;

    // 创建工具模式下：跳过 hitTest，直接进入创建流程，避免误选已有标注
    if (activeCreateTool) {
      _clearSelection();
      if (activeCreateTool === 'card') {
        _createCardAt(lp.x, lp.y);
        e.preventDefault();
        return;
      }
      if (activeCreateTool === 'pen') {
        _drag = { mode: 'create-pen', elId: null, points: [lp], startLayer: lp };
      } else { // highlight / underline / rect
        _drag = { mode: 'create', elId: null, startLayer: lp, origStart: lp };
      }
      if (!_windowMoveHandler) { _windowMoveHandler = function(ev) { _onPointerMove(ev); }; window.addEventListener('mousemove', _windowMoveHandler); }
      e.preventDefault();
      return;
    }

    var hitId = hitTest(lp.x, lp.y);
    if (hitId) {
      // Ctrl/Cmd+点击：toggle 选择
      if (e.ctrlKey || e.metaKey) {
        _toggleSelect(hitId);
        renderPage(currentPage);
      } else if (!_isSelected(hitId)) {
        _clearSelection();
        selectedIds.add(hitId);
        renderPage(currentPage);
      }
      // 启动拖拽（移动所有选中的元素）
      var origRects = {};
      selectedIds.forEach(function(sid) {
        var selEl = _findEl(currentPage, sid);
        if (selEl && selEl.rect) origRects[sid] = Object.assign({}, selEl.rect);
      });
      var hitEl = _findEl(currentPage, hitId);
      _drag = { mode: 'move', elId: hitId, origRect: hitEl ? Object.assign({}, hitEl.rect) : {}, origRects: origRects, startLayer: lp };
      e.preventDefault(); e.stopPropagation();
      if (!_windowMoveHandler) { _windowMoveHandler = function(ev) { _onPointerMove(ev); }; window.addEventListener('mousemove', _windowMoveHandler); }
      return;
    }
    // 点击空白区域
    if (!e.ctrlKey && !e.metaKey) _clearSelection();
    if (editTool === 'select') {
      // select 工具：不创建新标注，启动框选
      _drag = { mode: 'selection-rect', startLayer: lp };
      renderPage(currentPage);
      e.preventDefault();
      if (!_windowMoveHandler) { _windowMoveHandler = function(ev) { _onPointerMove(ev); }; window.addEventListener('mousemove', _windowMoveHandler); }
      return;
    }
    if (!editTool) {
      // 无工具时：点击空白只清空选择，不创建任何新标注，让 PDF 原生文本选择可用
      renderPage(currentPage);
      return;
    }
    // 其他工具：创建新元素前清空选择
    _clearSelection();
    if (editTool === 'card') {
      _createCardAt(lp.x, lp.y);
      e.preventDefault();
      return;
    }
    if (editTool === 'pen') {
      _drag = { mode: 'create-pen', elId: null, points: [lp], startLayer: lp };
    } else { // highlight / underline / rect
      _drag = { mode: 'create', elId: null, startLayer: lp, origStart: lp };
    }
    if (!_windowMoveHandler) { _windowMoveHandler = function(ev) { _onPointerMove(ev); }; window.addEventListener('mousemove', _windowMoveHandler); }
    e.preventDefault();
  }

  function _onPointerMove(e) {
    if (!_drag) return;
    e.preventDefault();
    // 卡死保护：如果鼠标/触控已松开（buttons=0 且非 touch 多触点）但 _drag 还在，
    // 说明上次 pointerup/mouseup/touchend 因兼容事件链断裂没正常收尾，立即补一次 up 处理
    var isTouch = (e.pointerType === 'touch') || (e.touches && e.touches.length > 0);
    if (!isTouch && typeof e.buttons === 'number' && e.buttons === 0) {
      try { _onPointerUp(e); } catch (err) { console.error('[annot move-stuck-fix]', err); }
      if (!_drag) return;
    }
    var lp = _localPoint(e);
    if (_drag.mode === 'move') {
      var dx = lp.x - _drag.startLayer.x, dy = lp.y - _drag.startLayer.y;
      if (selectedIds.size > 1 && _drag.origRects && _isSelected(_drag.elId)) {
        // 批量同步拖动所有选中元素
        selectedIds.forEach(function(sid) {
          var selEl = _findEl(currentPage, sid);
          if (!selEl || !_drag.origRects[sid]) return;
          selEl.rect.x = _drag.origRects[sid].x + dx;
          selEl.rect.y = _drag.origRects[sid].y + dy;
        });
      } else {
        var el = _findEl(currentPage, _drag.elId);
        if (!el) return;
        el.rect.x = _drag.origRect.x + dx;
        el.rect.y = _drag.origRect.y + dy;
      }
      if (!_rMoveRaf) _rMoveRaf = requestAnimationFrame(function() { _rMoveRaf = 0; renderPage(currentPage); });
    } else if (_drag.mode === 'selection-rect') {
      _updateSelectionRectPreview(_drag.startLayer, lp);
    } else if (_drag.mode === 'resize') {
      var el2 = _findEl(currentPage, _drag.elId);
      if (!el2) return;
      var dx = lp.x - _drag.startLayer.x, dy = lp.y - _drag.startLayer.y;
      var dir = _drag.direction || 'se';
      var r = _drag.origRect;
      var MIN_W = 40, MIN_H = 30;

      var isCard = el2.kind === 'card';
      if (dir === 'se') {
        el2.rect.w = Math.max(MIN_W, r.w + dx);
        el2.rect.h = Math.max(MIN_H, r.h + dy);
      } else if (dir === 'nw') {
        // v127: 卡片 resize 解除左边界限制，允许溢出 PDF 左右边界
        el2.rect.x = isCard ? r.x + dx : Math.min(r.x + r.w - MIN_W, r.x + dx);
        el2.rect.y = Math.min(r.y + r.h - MIN_H, r.y + dy);
        el2.rect.w = Math.max(MIN_W, r.w - dx);
        el2.rect.h = Math.max(MIN_H, r.h - dy);
      } else if (dir === 'ne') {
        el2.rect.y = Math.min(r.y + r.h - MIN_H, r.y + dy);
        el2.rect.w = Math.max(MIN_W, r.w + dx);
        el2.rect.h = Math.max(MIN_H, r.h - dy);
      } else if (dir === 'sw') {
        // v127: 卡片 resize 解除左边界限制，允许溢出 PDF 左右边界
        el2.rect.x = isCard ? r.x + dx : Math.min(r.x + r.w - MIN_W, r.x + dx);
        el2.rect.w = Math.max(MIN_W, r.w - dx);
        el2.rect.h = Math.max(MIN_H, r.h + dy);
      }
      if (!_rMoveRaf) _rMoveRaf = requestAnimationFrame(function() { _rMoveRaf = 0; renderPage(currentPage); });
    } else if (_drag.mode === 'move-anchor') {
      var cardEl = _findEl(currentPage, _drag.cardId);
      var targetEl = _findEl(currentPage, _drag.targetElId);
      if (!cardEl || !cardEl.rect || !cardEl.connections || !targetEl || !targetEl.rect) return;
      var conn = cardEl.connections[_drag.connIndex];
      if (!conn) return;
      var elRect = _drag.end === 'card' ? cardEl.rect : targetEl.rect;
      var nearest = _findNearestEdge(elRect, lp);
      if (_drag.end === 'card') { conn.cardAnchor = nearest.side; conn.cardOffset = nearest.offset; }
      else                      { conn.targetAnchor = nearest.side; conn.targetOffset = nearest.offset; }
      if (!_rMoveRaf) _rMoveRaf = requestAnimationFrame(function() { _rMoveRaf = 0; renderPage(currentPage); });
    } else if (_drag.mode === 'create') {
      _updateCreatePreview(_drag.startLayer, lp);
    } else if (_drag.mode === 'create-pen') {
      _drag.points.push(lp);
      _updatePenPreview(_drag.points);
    }
    e.preventDefault();
  }

  function _onPointerUp(e) {
    e.preventDefault();
    if (!_drag) return;
    var d = _drag; _drag = null;
    // v128: 清理 window 级 mousemove 监听
    if (_windowMoveHandler) {
      window.removeEventListener('mousemove', _windowMoveHandler);
      _windowMoveHandler = null;
    }
    if (d.mode === 'selection-rect') {
      _clearSelectionRectPreview();
      var endLp = _localPoint(e);
      var x = Math.min(d.startLayer.x, endLp.x);
      var y = Math.min(d.startLayer.y, endLp.y);
      var w = Math.abs(endLp.x - d.startLayer.x);
      var h = Math.abs(endLp.y - d.startLayer.y);
      if (w >= 4 || h >= 4) {
        var list = layerMap[currentPage] || [];
        for (var i = 0; i < list.length; i++) {
          var elr = list[i].rect;
          if (!elr) continue;
          if (elr.x < x + w && elr.x + elr.w > x && elr.y < y + h && elr.y + elr.h > y) {
            selectedIds.add(list[i].id);
          }
        }
      }
      renderPage(currentPage);
      return;
    }
    if (d.mode === 'move' || d.mode === 'resize' || d.mode === 'move-anchor') {
      _persistNow();
      return;
    }
    if (d.mode === 'create') {
      _finalizeCreate(d.startLayer, _localPoint(e));
    } else if (d.mode === 'create-pen') {
      _finalizePen(d.points);
    }
  }

  function _updateCreatePreview(a, b) {
    // P2-12：把预览做得足够醒目（下划线/高亮/矩形都要让用户一眼看出"整个框选区域"）
    // 用分组 + 矩形（范围框）+ 样式（按工具）的多元素预览，不再只画 1 个 rect
    if (!svg._previewGroup) {
      svg._previewGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svg._previewGroup.setAttribute('pointer-events', 'none');
      // 顺序：外框 (frame) + 填充 (fill) + underline 底部线
      var frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      frame.setAttribute('data-p', 'frame');
      frame.setAttribute('fill', 'none');
      frame.setAttribute('stroke-dasharray', '4 3');
      var fill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      fill.setAttribute('data-p', 'fill');
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      line.setAttribute('data-p', 'uline');
      svg._previewGroup.appendChild(fill);
      svg._previewGroup.appendChild(frame);
      svg._previewGroup.appendChild(line);
      svg.appendChild(svg._previewGroup);
    }
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    var s = toScreen(x, y);
    var sw = w * _renderRs, sh = h * _renderRs;
    var cm = COLOR_MEANING[_normalizeColor(currentColor)] || COLOR_MEANING['#ff6b6b'];
    var frame = svg._previewGroup.querySelector('[data-p="frame"]');
    var fill = svg._previewGroup.querySelector('[data-p="fill"]');
    var uline = svg._previewGroup.querySelector('[data-p="uline"]');
    function setRect(el, x2, y2, w2, h2) {
      el.setAttribute('x', x2); el.setAttribute('y', y2);
      el.setAttribute('width', Math.max(0, w2)); el.setAttribute('height', Math.max(0, h2));
    }
    // ------ 外框：所有工具都画 1 圈虚线（蓝色）让用户知道框了多大范围 ------
    frame.setAttribute('stroke', '#3b82f6');
    frame.setAttribute('stroke-width', 1.5);
    setRect(frame, s.x, s.y, sw, sh);

    if (editTool === 'underline') {
      // underline：不填充整片，但画一条靠底部的粗彩线（预览像高亮那样"整条线都先铺出来"）
      fill.setAttribute('fill', cm.bg);
      fill.setAttribute('opacity', 0.25); // 淡淡的整片预览，提示"这几行的区域被选中"
      setRect(fill, s.x, s.y, sw, sh);
      var lineThicknessPx = Math.max(3, Math.min(8, sh * 0.08));
      var lineY = s.y + sh - lineThicknessPx;
      uline.setAttribute('fill', cm.line);
      uline.setAttribute('opacity', 0.9);
      setRect(uline, s.x, lineY, sw, lineThicknessPx);
    } else if (editTool === 'rect') {
      // rect：画一个较明显的边框预览 + 浅色填充（让用户看到 1 个矩形框）
      fill.setAttribute('fill', cm.bg);
      fill.setAttribute('opacity', 0.35);
      setRect(fill, s.x, s.y, sw, sh);
      // 再加一层实线工具色边框，叠在蓝色虚线上
      var solid = svg._previewGroup.querySelector('[data-p="solid"]');
      if (!solid) {
        solid = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        solid.setAttribute('data-p', 'solid');
        solid.setAttribute('fill', 'none');
        solid.setAttribute('pointer-events', 'none');
        svg._previewGroup.insertBefore(solid, svg._previewGroup.firstChild);
      }
      solid.setAttribute('stroke', cm.line);
      solid.setAttribute('stroke-width', 2);
      setRect(solid, s.x, s.y, sw, sh);
      // underline 只显示在 underline 工具下，这里隐藏
      uline.setAttribute('width', 0); uline.setAttribute('height', 0);
    } else {
      // highlight：实心背景 + 边界也画一圈蓝色虚线（让"框选了多少范围"清楚可见）
      fill.setAttribute('fill', cm.bg);
      fill.setAttribute('opacity', 0.85);
      setRect(fill, s.x, s.y, sw, sh);
      uline.setAttribute('width', 0); uline.setAttribute('height', 0);
      var solid2 = svg._previewGroup.querySelector('[data-p="solid"]');
      if (solid2) { solid2.setAttribute('width', 0); solid2.setAttribute('height', 0); }
    }
  }
  function _updatePenPreview(points) {
    if (!svg._penPreview) {
      svg._penPreview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg._penPreview.setAttribute('fill', 'none');
      svg._penPreview.setAttribute('pointer-events', 'none');
      svg.appendChild(svg._penPreview);
    }
    var cm = COLOR_MEANING[_normalizeColor(currentColor)] || COLOR_MEANING['#ff6b6b'];
    // P2-12：钢笔预览也加"包围矩形范围"提示，让用户知道自己画了多大一块
    var d = points.map(function(p, i) { var sp = toScreen(p.x, p.y); return (i ? 'L' : 'M') + sp.x.toFixed(1) + ',' + sp.y.toFixed(1); }).join(' ');
    svg._penPreview.setAttribute('d', d);
    svg._penPreview.setAttribute('stroke', cm.line);
    svg._penPreview.setAttribute('stroke-width', 3);
    svg._penPreview.setAttribute('stroke-linecap', 'round');
    svg._penPreview.setAttribute('stroke-linejoin', 'round');
  }

  function _clearPreview() {
    if (svg && svg._previewGroup) {
      var children = svg._previewGroup.children || [];
      for (var i = 0; i < children.length; i++) {
        children[i].setAttribute('width', 0);
        children[i].setAttribute('height', 0);
        children[i].setAttribute('d', '');
      }
    }
    if (svg && svg._preview) { svg._preview.removeAttribute('width'); svg._preview.setAttribute('width', 0); }
    if (svg && svg._penPreview) svg._penPreview.setAttribute('d', '');
  }

  // 框选虚线矩形预览
  function _updateSelectionRectPreview(a, b) {
    if (!svg._selPreview) {
      svg._selPreview = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      svg._selPreview.setAttribute('fill', 'rgba(59,130,246,0.1)');
      svg._selPreview.setAttribute('stroke', '#3b82f6');
      svg._selPreview.setAttribute('stroke-width', 1);
      svg._selPreview.setAttribute('stroke-dasharray', '5 3');
      svg._selPreview.setAttribute('pointer-events', 'none');
      svg.appendChild(svg._selPreview);
    }
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    var s = toScreen(x, y);
    svg._selPreview.setAttribute('x', s.x);
    svg._selPreview.setAttribute('y', s.y);
    svg._selPreview.setAttribute('width', w * _renderRs);
    svg._selPreview.setAttribute('height', h * _renderRs);
  }
  function _clearSelectionRectPreview() {
    if (svg && svg._selPreview) {
      svg._selPreview.setAttribute('width', 0);
      svg._selPreview.setAttribute('height', 0);
    }
  }

  function _finalizeCreate(a, b) {
    _clearPreview();
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (editTool === 'underline') { if (w < 6 || h < 2) return; }
    else { if (w < 6 || h < 6) return; }
    var el = {
      id: genId(), kind: 'marker', tool: editTool,
      rect: { x: x, y: y, w: w, h: h },
      color: currentColor, quote: '', label: '', author: 'user', createdAt: Date.now()
    };
    addElement(currentPage, el);
    _clearSelection();
    selectedIds.add(el.id);
  }

  function _finalizePen(points) {
    _clearPreview();
    if (!points || points.length < 2) return;
    // 计算包围盒
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(function(p) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    });
    var el = {
      id: genId(), kind: 'marker', tool: 'pen',
      rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      points: points.slice(), color: currentColor, quote: '', label: '', author: 'user', createdAt: Date.now()
    };
    addElement(currentPage, el);
    _clearSelection();
    selectedIds.add(el.id);
  }

  // 在指定 base 坐标处新建解释卡片并进入编辑
  function _createCardAt(lx, ly) {
    var w = 220, h = 90;
    var el = {
      id: genId(), kind: 'card',
      rect: { x: lx, y: ly, w: w, h: h },
      content: '双击编辑解释卡片内容…', author: 'user', createdAt: Date.now()
    };
    addElement(currentPage, el);
    _clearSelection();
    selectedIds.add(el.id);
    _openCardEditor(el.id);
  }

  // 卡片内容编辑器（内容区原地 contentEditable：无黄色边框、无弹窗、无额外样式，直接出光标）
  function _openCardEditor(id) {
    var el = _findEl(currentPage, id);
    if (!el || el.kind !== 'card') return;
    _closeCardEditor();

    var card = floatingNotesLayer.querySelector('[data-id="' + id + '"]');
    if (!card) return;
    var body = card.querySelector('.hl-card-body');
    if (!body) return;

    // 编辑态不显示选中把手（蓝色虚线框 + 四角蓝色方块）：从选中集合临时移除
    var wasSelected = selectedIds.has(id);
    if (wasSelected) {
      selectedIds.delete(id);
      // 去掉 SVG 层的 resize 把手（在 SVG 重绘前先清掉 DOM 上已有，避免瞬时闪烁）
      var hdlNodes = svg ? svg.querySelectorAll('[data-resize^="' + id + '-"]') : null;
      if (hdlNodes) for (var hx = 0; hx < hdlNodes.length; hx++) hdlNodes[hx].remove();
      var selRect = svg ? svg.querySelector('[data-sel-rect="' + id + '"]') : null;
      if (selRect) selRect.remove();
    }

    // 把内容区切换为可编辑：不插入新元素，保持原位置、原背景、原 padding
    body.setAttribute('contenteditable', 'true');
    body.style.outline = 'none';
    body.style.border = 'none';
    body.style.boxShadow = 'none';

    // 若当前内容是"空卡片"占位，进入编辑时自动清空，光标落开头
    var plainText = body.innerText || '';
    if (!plainText.replace(/\s/g, '') || plainText.trim() === '（空卡片）' || plainText.trim() === '双击编辑解释卡片内容…') {
      body.innerText = '';
    }

    // 已连接标记列表（仅显示，不点击）
    if (el.connections && el.connections.length > 0 && !card.querySelector('.hl-card-conn-info')) {
      var connDiv = document.createElement('div');
      connDiv.className = 'hl-card-conn-info';
      connDiv.style.cssText = 'font-size:11px;color:#64748b;padding:4px 0 0;margin-top:4px;border-top:1px solid #e2e8f0;pointer-events:none;';
      connDiv.textContent = '已连接标记: ';
      for (var ci = 0; ci < el.connections.length; ci++) {
        var connector = el.connections[ci];
        var markerEl = _findEl(currentPage, connector.targetElId);
        var label = markerEl ? (markerEl.content || markerEl.label || connector.targetElId.substring(0, 8)) : connector.targetElId.substring(0, 8);
        var span = document.createElement('span');
        span.className = 'hl-card-conn-item';
        span.style.cssText = 'display:inline-block;background:#dbeafe;color:#1e40af;padding:1px 6px;margin:2px;border-radius:3px;';
        span.textContent = label;
        span.title = connector.targetElId;
        connDiv.appendChild(span);
      }
      card.appendChild(connDiv);
    }

    _editingCardId = id;
    body._editingWasSelected = wasSelected;

    // 设为可编辑后，确保 pointer-events 不被上层拦截
    body.style.pointerEvents = 'auto';
    body.focus();
    // 把光标移到文本末尾
    try {
      var range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }

    var save = function() {
      if (!body.getAttribute('contenteditable')) return;
      var txt = (body.innerText || '').replace(/\u200B/g, '').trim();
      el.content = txt || '（空卡片）';
      _closeCardEditor();
      renderPage(currentPage);
      _persistNow();
    };

    // blur 时保存（点击别处自然结束）
    body._blurHandler = save;
    body.addEventListener('blur', body._blurHandler);
    // contentEditable 内的按键：Ctrl+Enter 提交、Esc 提交并退出
    body._keyHandler = function(ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        body.blur();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        body.blur();
      }
      // 编辑态内容区内部的点击 / 拖拽不要冒泡到 SVG 层
      ev.stopPropagation();
    };
    body.addEventListener('keydown', body._keyHandler);
    body.addEventListener('mousedown', function(ev) { ev.stopPropagation(); });
    body.addEventListener('click', function(ev) { ev.stopPropagation(); });
    body.addEventListener('dblclick', function(ev) { ev.stopPropagation(); });
  }

  function _closeCardEditor() {
    if (!_editingCardId) return;
    var card = floatingNotesLayer.querySelector('[data-id="' + _editingCardId + '"]');
    var id = _editingCardId;
    _editingCardId = null;

    if (!card) return;
    var body = card.querySelector('.hl-card-body');
    var el = _findEl(currentPage, id);
    var wasSelected = body && body._editingWasSelected;

    // 还原 contentEditable 为不可编辑并重建显示内容（还原 HTML 标记：bold/italic/highlight 等）
    if (body) {
      try {
        if (body._blurHandler) body.removeEventListener('blur', body._blurHandler);
        if (body._keyHandler) body.removeEventListener('keydown', body._keyHandler);
      } catch (e) {}
      body._blurHandler = null;
      body._keyHandler = null;
      body._editingWasSelected = false;
      body.removeAttribute('contenteditable');
      body.style.outline = '';
      body.style.border = '';
      body.style.boxShadow = '';
      body.style.pointerEvents = '';
      if (el) body.innerHTML = renderContent(el.content || '');
    }

    // 删除 conn info（编辑态插入的提示条）——原卡片重绘时会重新按 el.connections 创建，所以这里直接移除避免重复
    var connInfo = card.querySelector('.hl-card-conn-info');
    if (connInfo) connInfo.remove();

    // 若编辑前是选中态，编辑结束保持选中（用户可能想继续拖动/缩放）
    if (wasSelected && el) selectedIds.add(id);
  }

  // =========================================================================
  //  工具 / 微调 公共接口
  // =========================================================================
  function setTool(tool) {
    // 选择任意标注工具都会退出文本选择模式
    if (textSelectMode) {
      textSelectMode = false;
      var sBtn = document.getElementById('btnHlSelect');
      if (sBtn) sBtn.classList.remove('active');
    }
    editTool = tool || null;
    if (!currentColor) currentColor = '#ff6b6b';
    _clearSelection();
    _closeCardEditor();
    _applyPointerEvents();
    // 设置面板显隐：根据当前工具只显示对应面板
    var panels = {
      'underline': 'hlUnderlinePanel',
      'highlight': 'hlHighlightPanel',
      'rect': 'hlRectPanel',
      'card': 'hlCardPanel'
    };
    Object.keys(panels).forEach(function(k) {
      var p = document.getElementById(panels[k]);
      if (p) p.style.display = (editTool === k) ? 'block' : 'none';
    });
    renderPage(currentPage);
  }
  function getTool() { return editTool; }
  function setColor(c) { currentColor = _normalizeColor(c); }
  function getColor() { return currentColor; }
  function getSelected() {
    if (selectedIds.size === 0) return null;
    var first = selectedIds.values().next().value;
    return _findEl(currentPage, first);
  }
  function deleteSelected() {
    if (selectedIds.size === 0) return;
    var ids = Array.from(selectedIds);
    ids.forEach(function(sid) { removeElement(currentPage, sid); });
    _clearSelection();
  }

  // 手动微调偏移（屏幕像素）。方向键式 nudge。
  function nudgeFineTune(dx, dy) {
    fineTune.dx = (fineTune.dx || 0) + dx;
    fineTune.dy = (fineTune.dy || 0) + dy;
    renderPage(currentPage);
    _persistNow();
  }
  function setFineTune(dx, dy) {
    fineTune.dx = dx || 0; fineTune.dy = dy || 0;
    renderPage(currentPage); _persistNow();
  }
  function getFineTune() { return { dx: fineTune.dx || 0, dy: fineTune.dy || 0 }; }
  // 打开微调模式：进入查看态，用户用方向键微调整层位置（默认 0，不漂移）
  var _fineTuneKeyHandler = null;
  var _fineTuneBanner = null;
  function openFineTune() {
    setTool(null);
    // 防止重复进入微调模式：移除旧的监听器和横幅
    if (_fineTuneKeyHandler) {
      document.removeEventListener('keydown', _fineTuneKeyHandler);
      _fineTuneKeyHandler = null;
    }
    if (_fineTuneBanner && _fineTuneBanner.parentNode) {
      _fineTuneBanner.parentNode.removeChild(_fineTuneBanner);
      _fineTuneBanner = null;
    }
    var step = 2;
    var banner = document.createElement('div');
    banner.className = 'hl-finetune-banner';
    banner.textContent = '📐 微调划重点层：用 ← → ↑ ↓ 微调整体位置，Esc 退出（当前偏移 ' + Math.round(fineTune.dx) + ',' + Math.round(fineTune.dy) + '）';
    document.body.appendChild(banner);
    _fineTuneBanner = banner;
    var handler = function(ev) {
      var moved = false;
      if (ev.key === 'ArrowLeft') { nudgeFineTune(-step, 0); moved = true; }
      else if (ev.key === 'ArrowRight') { nudgeFineTune(step, 0); moved = true; }
      else if (ev.key === 'ArrowUp') { nudgeFineTune(0, -step); moved = true; }
      else if (ev.key === 'ArrowDown') { nudgeFineTune(0, step); moved = true; }
      else if (ev.key === 'Escape') {
        document.removeEventListener('keydown', handler);
        _fineTuneKeyHandler = null;
        if (banner.parentNode) banner.parentNode.removeChild(banner);
        _fineTuneBanner = null;
        return;
      }
      if (moved) {
        ev.preventDefault();
        banner.textContent = '📐 微调划重点层：用 ← → ↑ ↓ 微调整体位置，Esc 退出（当前偏移 ' + Math.round(fineTune.dx) + ',' + Math.round(fineTune.dy) + '）';
      }
    };
    _fineTuneKeyHandler = handler;
    document.addEventListener('keydown', handler);
  }

  // =========================================================================
  //  文本定位 / 文本矩形（供 AI 划重点与卡片避让）
  // =========================================================================
  async function locateQuote(pdfDoc, pageNum, quote, scale) {
    if (!pdfDoc || !quote) return null;
    try {
      var page = await pdfDoc.getPage(pageNum);
      var viewport = page.getViewport({ scale: scale || 1 });
      var items = itemCache[pageNum];
      if (!items) {
        var textContent = await page.getTextContent();
        items = textContent.items || [];
        itemCache[pageNum] = items;
      }
      if (!items.length) return null;
      var cleaned = [];
      for (var i = 0; i < items.length; i++) {
        var raw = String(items[i].str || '');
        cleaned.push({ raw: raw, clean: _cleanText(raw), index: i });
      }
      var targetClean = _cleanText(String(quote).trim());
      if (!targetClean) return null;
      var rects = _locateByCleanSubstring(cleaned, items, targetClean, viewport)
        || _locateByLCS(cleaned, items, targetClean, viewport)
        || _locateByKeywords(cleaned, items, targetClean, viewport);
      if (!rects || !rects.length) return null;
      // 转回 base 空间（除以传入 scale）
      var inv = (scale && scale > 0) ? scale : 1;
      return {
        rect: {
          x: rects[0].x / inv, y: rects[0].y / inv,
          w: rects[0].w / inv, h: rects[0].h / inv
        },
        quote: String(quote).trim()
      };
    } catch (e) { return null; }
  }

  // 获取整页文本矩形（base 空间），用于卡片避让正文
  async function getTextRects(pageNum) {
    var doc = (typeof PDFReader !== 'undefined' && PDFReader.getPdfDoc) ? PDFReader.getPdfDoc() : null;
    if (!doc) return [];
    try {
      var page = await doc.getPage(pageNum);
      var bv = page.getViewport({ scale: 1 });
      var items = itemCache[pageNum];
      if (!items) { var tc = await page.getTextContent(); items = tc.items || []; itemCache[pageNum] = items; }
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it.str || !it.str.trim()) continue;
        var tx = it.transform; if (!tx) continue;
        var x = tx[4], y = tx[5];
        var w = it.width || 0, h = (it.height || Math.abs(tx[3]) || 10);
        var topY = bv.height - (y + h);
        out.push({ x: x, y: topY, w: w || 10, h: h || 10 });
      }
      return out;
    } catch (e) { return []; }
  }

  // ---- 文本匹配辅助（沿用原算法，不变量） ----
  function _cleanText(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[​﻿]/g, '')
      .replace(/[，。？！、；：“”‘’（）【】《》"'()\[\],.?!;:]/g, '')
      .toLowerCase();
  }
  function _rectForItems(items, viewport) {
    if (!items || !items.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < items.length; i++) {
      var it = items[i]; if (!it.str || !it.str.trim()) continue;
      var tx = it.transform; if (!tx) continue;
      var x = tx[4], y = tx[5];
      var w = it.width || 0, h = it.height || Math.abs(tx[3]) || 10;
      var topY = viewport.height - (y + h);
      if (x < minX) minX = x; if (topY < minY) minY = topY;
      if (x + w > maxX) maxX = x + w; if (topY + h > maxY) maxY = topY + h;
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  function _rectForCleanRange(matched, cleanedSlice, pos, len, viewport) {
    var sub = cleanedSlice.filter(function(c) { return c.clean; });
    if (!sub.length) return null;
    // 估算覆盖的 items 数
    var coverCount = 0, acc = '';
    for (var i = 0; i < sub.length; i++) {
      var before = acc.length; acc += sub[i].clean;
      coverCount++;
      if (acc.length > pos + len) break;
    }
    if (coverCount === 0) return null;
    return _rectForItems(matched.slice(0, coverCount), viewport);
  }
  function _locateByCleanSubstring(cleaned, items, targetClean, viewport) {
    if (!targetClean || targetClean.length < 2) return null;
    for (var i = 0; i < cleaned.length; i++) {
      if (cleaned[i].clean && cleaned[i].clean.indexOf(targetClean) >= 0) {
        var r = _rectForItems([items[i]], viewport);
        if (r) return [r];
      }
    }
    var MAX_WIN = targetClean.length * 5 + 60;
    for (var s = 0; s < cleaned.length; s++) {
      var str = '', matched = [];
      for (var j = s; j < cleaned.length; j++) {
        if (!cleaned[j].clean) continue;
        str += cleaned[j].clean; matched.push(items[j]);
        var p = str.indexOf(targetClean);
        if (p >= 0) return [_rectForCleanRange(matched, cleaned.slice(s, j + 1), p, targetClean.length, viewport)];
        if (str.length >= MAX_WIN) break;
      }
    }
    return null;
  }
  function _locateByLCS(cleaned, items, targetClean, viewport) {
    if (!targetClean || targetClean.length < 3) return null;
    var best = null, bestScore = 0;
    var MIN = Math.max(4, Math.floor(targetClean.length * 0.6));
    var MAX_WIN = targetClean.length * 5 + 80;
    for (var s = 0; s < cleaned.length; s++) {
      var str = '', matched = [];
      for (var j = s; j < cleaned.length && str.length < MAX_WIN; j++) {
        if (!cleaned[j].clean) continue;
        str += cleaned[j].clean; matched.push(items[j]);
        var score = _lcsLen(str, targetClean);
        if (score > bestScore && score >= MIN) {
          bestScore = score;
          var r = _rectForItems(matched, viewport);
          if (r) best = [r];
        }
      }
      if (best) break;
    }
    return best;
  }
  function _lcsLen(a, b) {
    var m = a.length, n = b.length;
    if (m === 0 || n === 0) return 0;
    var dp = new Array(n + 1).fill(0);
    for (var i = 1; i <= m; i++) {
      var prev = 0;
      for (var j = 1; j <= n; j++) {
        var tmp = dp[j];
        dp[j] = (a[i - 1] === b[j - 1]) ? prev + 1 : Math.max(dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }
  function _locateByKeywords(cleaned, items, targetClean, viewport) {
    var words = targetClean.match(/[一-鿿]{2,}|[a-z]{3,}/g);
    if (!words || !words.length) return null;
    for (var w = 0; w < words.length; w++) {
      for (var i = 0; i < cleaned.length; i++) {
        if (cleaned[i].clean && cleaned[i].clean.indexOf(words[w]) >= 0) {
          var r = _rectForItems([items[i]], viewport);
          if (r) return [r];
        }
      }
    }
    return null;
  }

  // 卡片自动摆放：靠近 anchor，且不遮挡其他卡片与正文文本
  async function placeCard(pageNum, anchorRect, content, opts) {
    opts = opts || {};
    var defaultW = opts.w || 220, defaultH = opts.h || 90;
    var textRects = await getTextRects(pageNum);
    var cards = (layerMap[pageNum] || []).filter(function(e) { return e.kind === 'card'; });
    // 候选锚点：右、左、下、上
    var cx = anchorRect.x + anchorRect.w / 2;
    var cy = anchorRect.y + anchorRect.h / 2;
    var candidates = [
      { x: anchorRect.x + anchorRect.w + 12, y: anchorRect.y },                 // 右
      { x: anchorRect.x - defaultW - 12, y: anchorRect.y },                    // 左
      { x: anchorRect.x, y: anchorRect.y + anchorRect.h + 12 },                // 下
      { x: anchorRect.x, y: anchorRect.y - defaultH - 12 }                     // 上
    ];
    for (var i = 0; i < candidates.length; i++) {
      var p = candidates[i];
      if (p.x < 4 || p.y < 4) continue;
      var box = { x: p.x, y: p.y, w: defaultW, h: defaultH };
      if (_overlapsAny(box, cards)) continue;
      if (_overlapsText(box, textRects, anchorRect)) continue;
      return box;
    }
    // 全被占：放到右侧并允许轻微重叠文本（用户可后续手动微调）
    return { x: anchorRect.x + anchorRect.w + 12, y: anchorRect.y, w: defaultW, h: defaultH };
  }
  function _overlapsAny(box, cards) {
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i].rect; if (!c) continue;
      if (box.x < c.x + c.w && box.x + box.w > c.x && box.y < c.y + c.h && box.y + box.h > c.y) return true;
    }
    return false;
  }
  function _overlapsText(box, textRects, anchorRect) {
    // 允许与 anchor 自身所在文本行重叠，避免无处可放
    for (var i = 0; i < textRects.length; i++) {
      var t = textRects[i];
      var isAnchorLine = (t.x < anchorRect.x + anchorRect.w && t.x + t.w > anchorRect.x &&
                          t.y < anchorRect.y + anchorRect.h && t.y + t.h > anchorRect.y);
      if (isAnchorLine) continue;
      if (box.x < t.x + t.w && box.x + box.w > t.x && box.y < t.y + t.h && box.y + box.h > t.y) return true;
    }
    return false;
  }

  // =========================================================================
  //  统一设置面板系统（下划线 / 高亮 / 框 / 卡片）
  // =========================================================================

  // 面板配置表
  var _panelDefs = {
    hlUnderlinePanel: {
      config: '_underlineConfig', lsKey: 'hlUnderlineGlobalConfig',
      defaults: { color: '#FFD700', style: 'solid', width: 3, applyAll: false },
      hasEyedropper: true, hasColorHistory: true,
      fields: [
        { type: 'color',    id: 'hlUnderlineColor',     prop: 'color' },
        { type: 'style',    id: 'hlUnderlineStyle',     prop: 'style', options: { solid: '直线', dashed: '虚线', wavy: '波浪线', double: '双直线' } },
        { type: 'range',    id: 'hlUnderlineWidth',     prop: 'width',  valId: 'hlUnderlineWidthVal',  min: 1, max: 8,  unit: 'px' },
        { type: 'applyall', id: 'hlUnderlineApplyAll',  prop: 'applyAll' }
      ]
    },
    hlHighlightPanel: {
      config: '_highlightConfig', lsKey: 'hlHighlightGlobalConfig',
      defaults: { color: '#ff6b6b', opacity: 40, applyAll: false },
      fields: [
        { type: 'color',    cls: '.hl-up-color',    prop: 'color' },
        { type: 'range',    cls: '.hl-up-opacity',  prop: 'opacity', valCls: '.hl-up-opacity-val', min: 10, max: 100, unit: '%' },
        { type: 'applyall', cls: '.hl-up-applyall', prop: 'applyAll' }
      ]
    },
    hlRectPanel: {
      config: '_rectConfig', lsKey: 'hlRectGlobalConfig',
      defaults: { fillColor: '#ff6b6b', fillOpacity: 30, strokeColor: '#e74c3c', strokeWidth: 2, strokeStyle: 'solid', applyAll: false },
      fields: [
        { type: 'color',    cls: '.hlRectFillColor',    prop: 'fillColor' },
        { type: 'range',    cls: '.hlRectFillOpacity',  prop: 'fillOpacity', valCls: '.hlRectFillOpacityVal', min: 0, max: 100, unit: '%' },
        { type: 'color',    cls: '.hlRectStrokeColor',  prop: 'strokeColor' },
        { type: 'range',    cls: '.hlRectStrokeWidth',  prop: 'strokeWidth', valCls: '.hlRectStrokeWidthVal', min: 1, max: 6, unit: 'px' },
        { type: 'style',    cls: '.hlRectStrokeStyle',  prop: 'strokeStyle', options: { solid: '直线', dashed: '虚线', dotted: '点线' } },
        { type: 'applyall', cls: '.hl-up-applyall',     prop: 'applyAll' }
      ]
    },
    hlCardPanel: {
      config: '_cardConfig', lsKey: 'hlCardGlobalConfig',
      defaults: { color: '#fffdf6', opacity: 85, applyAll: false },
      fields: [
        { type: 'color',    cls: '.hl-up-color',    prop: 'color' },
        { type: 'range',    cls: '.hl-up-opacity',  prop: 'opacity', valCls: '.hl-up-opacity-val', min: 10, max: 100, unit: '%' },
        { type: 'applyall', cls: '.hl-up-applyall', prop: 'applyAll' }
      ]
    }
  };

  // 颜色历史工具
  function _getColorHistory() {
    try {
      var raw = localStorage.getItem('hlColorHistory');
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function _saveColorHistory(color) {
    try {
      var hist = _getColorHistory();
      hist = hist.filter(function(c) { return c !== color; });
      hist.unshift(color);
      if (hist.length > 10) hist = hist.slice(0, 10);
      localStorage.setItem('hlColorHistory', JSON.stringify(hist));
    } catch (e) {}
  }
  function _renderColorHistory(containerId, colorEl) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var hist = _getColorHistory();
    container.innerHTML = '';
    hist.forEach(function(c) {
      var swatch = document.createElement('span');
      swatch.style.cssText = 'display:inline-block;width:18px;height:18px;background:' + c + ';border:1px solid #ccc;border-radius:2px;cursor:pointer;';
      swatch.title = c;
      swatch.addEventListener('click', function() {
        if (colorEl) { colorEl.value = c; colorEl.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      container.appendChild(swatch);
    });
  }

  function _loadAllConfigs() {
    Object.keys(_panelDefs).forEach(function(pid) {
      var def = _panelDefs[pid];
      try {
        var saved = localStorage.getItem(def.lsKey);
        if (saved) {
          var parsed = JSON.parse(saved);
          if (parsed && typeof parsed === 'object') {
            var cfg = eval(def.config);
            Object.keys(def.defaults).forEach(function(k) { if (parsed.hasOwnProperty(k)) cfg[k] = parsed[k]; });
          }
        }
      } catch (e) {}
    });
  }

  function _initConfigPanel(panelId, def) {
    var panel = document.getElementById(panelId);
    if (!panel || panel._inited) return;
    panel._inited = true;

    var cfgObj = eval(def.config);

    // 解析控件
    var fields = [];
    def.fields.forEach(function(f) {
      var el = f.id ? document.getElementById(f.id) : panel.querySelector(f.cls);
      var valEl = f.valId ? document.getElementById(f.valId) : (f.valCls ? panel.querySelector(f.valCls) : null);
      fields.push({ el: el, valEl: valEl, field: f });
      // 回填
      if (el) {
        if (f.type === 'color') el.value = cfgObj[f.prop];
        else if (f.type === 'range') { el.value = cfgObj[f.prop]; if (valEl) valEl.textContent = cfgObj[f.prop] + (f.unit || ''); }
        else if (f.type === 'style') { var opts = Object.keys(f.options); if (opts.length) el.value = cfgObj[f.prop] || opts[0]; }
        else if (f.type === 'applyall') el.checked = !!cfgObj[f.prop];
      }
    });

    // 颜色历史（仅 underline 面板有）
    if (def.hasColorHistory) {
      var colorField = fields.filter(function(f) { return f.field.type === 'color'; })[0];
      if (colorField && colorField.el) {
        _renderColorHistory('hlUnderlineColorHistory', colorField.el);
        colorField.el.addEventListener('input', function() {
          _renderColorHistory('hlUnderlineColorHistory', colorField.el);
        });
      }
    }

    // EyeDropper
    if (def.hasEyedropper) {
      var eyedropperBtn = document.getElementById(panelId.replace('Panel','EyeDropper'));
      if (eyedropperBtn) {
        if (typeof EyeDropper === 'undefined') {
          eyedropperBtn.disabled = true;
          eyedropperBtn.style.opacity = '0.4';
          eyedropperBtn.title = '当前浏览器不支持取色（需要 Chrome 95+ / Edge 95+）';
        } else {
          eyedropperBtn.addEventListener('click', function() {
            var ed = new EyeDropper();
            ed.open().then(function(result) {
              var colorField = fields.filter(function(f) { return f.field.type === 'color'; })[0];
              if (colorField && colorField.el) colorField.el.value = result.sRGBHex;
            }).catch(function() {});
          });
        }
      }
    }

    // 滑块实时显示
    fields.forEach(function(f) {
      if (f.field.type === 'range' && f.el && f.valEl) {
        f.el.addEventListener('input', function() {
          f.valEl.textContent = f.el.value + (f.field.unit || '');
        });
      }
    });

    // 折叠
    var closeBtn = panel.querySelector('.hl-up-close') || panel.querySelector('#hlUnderlinePanelClose');
    var bodyEl = panel.querySelector('.hl-up-body');
    if (closeBtn && bodyEl) {
      closeBtn.addEventListener('click', function() {
        var collapsed = panel._collapsed;
        if (collapsed) {
          bodyEl.style.display = '';
          closeBtn.innerHTML = '&minus;';
          panel.style.width = '220px';
          closeBtn.title = '折叠面板';
        } else {
          bodyEl.style.display = 'none';
          closeBtn.innerHTML = '&#43;';
          panel.style.width = '40px';
          closeBtn.title = '展开面板';
        }
        panel._collapsed = !collapsed;
      });
    }

    // 应用按钮
    var applyBtn = panel.querySelector('.hl-up-apply') || document.getElementById(panelId.replace('Panel','Apply'));
    if (applyBtn) {
      applyBtn.addEventListener('click', function() {
        fields.forEach(function(f) {
          if (f.field.type === 'color') cfgObj[f.field.prop] = f.el ? f.el.value : def.defaults[f.field.prop];
          else if (f.field.type === 'range') cfgObj[f.field.prop] = f.el ? (parseInt(f.el.value, 10) || def.defaults[f.field.prop]) : def.defaults[f.field.prop];
          else if (f.field.type === 'style') cfgObj[f.field.prop] = f.el ? f.el.value : def.defaults[f.field.prop];
          else if (f.field.type === 'applyall') cfgObj[f.field.prop] = f.el ? f.el.checked : false;
        });
        if (cfgObj.applyAll) {
          try { localStorage.setItem(def.lsKey, JSON.stringify(cfgObj)); } catch (e) {}
        }
        // 写入颜色历史
        if (def.hasColorHistory) {
          _saveColorHistory(cfgObj.color);
          var colorField = fields.filter(function(f) { return f.field.type === 'color'; })[0];
          if (colorField && colorField.el) _renderColorHistory('hlUnderlineColorHistory', colorField.el);
        }
        renderPage(currentPage);
      });
    }

    // 重置按钮
    var resetBtn = panel.querySelector('.hl-up-reset') || document.getElementById(panelId.replace('Panel','Reset'));
    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        var d = def.defaults;
        Object.keys(d).forEach(function(k) { cfgObj[k] = d[k]; });
        try { localStorage.removeItem(def.lsKey); } catch (e) {}
        fields.forEach(function(f) {
          if (f.el) {
            if (f.field.type === 'color') f.el.value = d[f.field.prop];
            else if (f.field.type === 'range') { f.el.value = d[f.field.prop]; if (f.valEl) f.valEl.textContent = d[f.field.prop] + (f.field.unit || ''); }
            else if (f.field.type === 'style') f.el.value = d[f.field.prop];
            else if (f.field.type === 'applyall') f.el.checked = d[f.field.prop];
          }
        });
        renderPage(currentPage);
      });
    }

    // "应用于选中"按钮
    var applySelectedBtn = panel.querySelector('.hlApplySelected');
    if (applySelectedBtn) {
      applySelectedBtn.addEventListener('click', function() {
        // 读取面板当前所有配置值
        var vals = {};
        fields.forEach(function(f) {
          if (f.field.type === 'color') vals[f.field.prop] = f.el ? f.el.value : def.defaults[f.field.prop];
          else if (f.field.type === 'range') vals[f.field.prop] = f.el ? parseInt(f.el.value, 10) : def.defaults[f.field.prop];
          else if (f.field.type === 'style') vals[f.field.prop] = f.el ? f.el.value : def.defaults[f.field.prop];
        });
        // 面板→元素类型映射
        var kindMap = { hlUnderlinePanel: 'line', hlHighlightPanel: 'highlight', hlRectPanel: 'rect', hlCardPanel: 'card' };
        var targetKind = kindMap[panelId];
        if (!targetKind) return;
        // 属性名映射
        var propMap = {
          line: { color: 'color', style: 'style', width: 'width' },
          highlight: { color: 'color', opacity: 'opacity' },
          rect: { fillColor: 'fillColor', fillOpacity: 'fillOpacity', strokeColor: 'strokeColor', strokeWidth: 'strokeWidth', strokeStyle: 'strokeStyle' },
          card: { color: 'bgColor', opacity: 'opacity' }
        };
        var mapping = propMap[targetKind];
        var found = false;
        selectedIds.forEach(function(sid) {
          var el = _findEl(currentPage, sid);
          if (!el) return;
          var matches = (targetKind === 'line' ? (el.kind === 'marker' && el.tool === 'underline') :
                         targetKind === 'highlight' ? (el.kind === 'marker' && el.tool === 'highlight') :
                         targetKind === 'rect' ? (el.kind === 'marker' && el.tool === 'rect') :
                         targetKind === 'card' ? (el.kind === 'card') : false);
          if (!matches) return;
          found = true;
          Object.keys(mapping).forEach(function(k) { if (vals.hasOwnProperty(k)) el[mapping[k]] = vals[k]; });
        });
        if (found) { renderPage(currentPage); }
        // 未选中元素时不作操作（静默），避免调试日志残留
      });
    }

    // 拖动标题栏移动面板（记录到 localStorage，下次打开保持位置）
    var dragHandle = panel.querySelector('.hl-drag-handle');
    if (dragHandle) {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem('hlPanelPos_' + panelId) || 'null'); } catch (e) {}
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        panel.style.left = saved.left + 'px';
        panel.style.top = saved.top + 'px';
      }
      var _pdrag = null;
      dragHandle.addEventListener('mousedown', function(ev) {
        if (ev.target.classList && ev.target.classList.contains('hl-up-close')) return; // 不拦截折叠按钮
        ev.preventDefault();
        ev.stopPropagation();
        var pr = panel.getBoundingClientRect();
        _pdrag = { startX: ev.clientX, startY: ev.clientY, origL: pr.left, origT: pr.top };
        panel.classList.add('dragging');
        function onMove(e2) {
          if (!_pdrag) return;
          var dx = e2.clientX - _pdrag.startX;
          var dy = e2.clientY - _pdrag.startY;
          panel.style.left = (_pdrag.origL + dx) + 'px';
          panel.style.top = (_pdrag.origT + dy) + 'px';
        }
        function onUp() {
          _pdrag = null;
          panel.classList.remove('dragging');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          try {
            localStorage.setItem('hlPanelPos_' + panelId, JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop }));
          } catch (e) {}
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    }
  }

  function _initAllPanels() {
    Object.keys(_panelDefs).forEach(function(pid) {
      _initConfigPanel(pid, _panelDefs[pid]);
    });
  }

  // =========================================================================
  //  公共接口
  // =========================================================================
  return {
    init: init,
    setBookId: setBookId,
    renderPage: renderPage,
    addElement: addElement,
    addAnnotation: addAnnotation,
    updateElement: updateElement,
    removeElement: removeElement,
    getElements: getElements,
    getAnnotations: getAnnotations,
    setElements: setElements,
    setAnnotations: setAnnotations,
    clearPage: clearPage,
    clearAll: clearAll,
    // 查询接口（书虫助手可通过这些检索标注，author=ai 的也会一并返回）
    getCurrentPage: function() { return currentPage; },
    getAllPages: function() {
      var pages = [];
      for (var p in layerMap) { if (layerMap.hasOwnProperty(p)) pages.push(parseInt(p) || p); }
      pages.sort(function(a,b){ return (a|0)-(b|0); });
      return pages;
    },
    // 按文本匹配标注（text/quote/content/note 做小写 include 匹配；keyword 为空则返回全部）
    queryAnnotations: function(opts) {
      opts = opts || {};
      var page = opts.page;
      var kw = (opts.keyword || '').toString().trim().toLowerCase();
      var kind = opts.kind || null;
      var author = opts.author || null;
      var out = [];
      var pages = page ? [page] : this.getAllPages();
      for (var pi = 0; pi < pages.length; pi++) {
        var pn = pages[pi];
        var list = this.getElements(pn);
        for (var li = 0; li < list.length; li++) {
          var el = list[li];
          if (kind && el.kind !== kind) continue;
          if (author && el.author !== author) continue;
          if (kw) {
            var hay = (el.text || '') + '\n' + (el.quote || '') + '\n' + (el.content || '') + '\n' +
                      (el.note || '') + '\n' + (el.title || '');
            if (hay.toLowerCase().indexOf(kw) < 0) continue;
          }
          // 返回精简副本，避免直接修改内部对象
          out.push({
            page: pn,
            id: el.id,
            kind: el.kind,
            author: el.author || 'user',
            createdAt: el.createdAt || 0,
            rect: el.rect ? { x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h } : null,
            text: el.text || null,
            quote: el.quote || null,
            title: el.title || null,
            color: el.color || null,
            note: el.note || null
          });
        }
      }
      return out;
    },
    locateQuote: locateQuote,
    getTextRects: getTextRects,
    placeCard: placeCard,
    // 编辑接口
    setTool: setTool,
    getTool: getTool,
    setColor: setColor,
    getColor: getColor,
    getSelected: getSelected,
    deleteSelected: deleteSelected,
    // 文本选择模式：SVG 完全不拦截，允许自由划选 PDF 文本（与标注选中互斥）
    setTextSelectMode: function(on) {
      textSelectMode = !!on;
      if (textSelectMode) {
        setTool(null);   // 退出所有标注工具
        textSelectMode = true; // setTool 内会复位，这里重新置回
        // 让 PDF 文本层可被划选（SVG pointer-events=none 已由 _applyPointerEvents 处理）
        _applyPointerEvents();
      } else {
        _applyPointerEvents();
      }
      return textSelectMode;
    },
    getTextSelectMode: function() { return textSelectMode; },
    // 选中接口：按 ID 数组批量选中（供 AI 通过检索后直接选中目标标注以支持删除/高亮等操作）
    selectByIds: function(ids, additive) {
      if (!additive) _clearSelection();
      if (!ids) return;
      for (var i = 0; i < ids.length; i++) selectedIds.add(ids[i]);
      if (currentPage) renderPage(currentPage);
    },
    openCardEditor: function(id) { _openCardEditor(id); },
    // 微调
    nudgeFineTune: nudgeFineTune,
    setFineTune: setFineTune,
    getFineTune: getFineTune,
    openFineTune: openFineTune,
    COLOR_MEANING: COLOR_MEANING
  };
})();
if (typeof window !== 'undefined') {
  window.PDFAnnotate = PDFAnnotate;
}
