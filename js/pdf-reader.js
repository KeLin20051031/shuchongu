// PDF Reader 模块 — PDF.js 封装
// 依赖: pdfjsLib (PDF.js 3.11.174 UMD 全局对象)、DataLayer (IndexedDB 持久化)
const PDFReader = (function() {
  'use strict';

  const PDFJS_CDN_BASE = 'lib/';

  let pdfDoc = null;          // PDFDocumentProxy
  let currentPageNum = 1;     // 当前页码 (1-based)
  let scale = 1.0;            // 缩放比例，可为数字或 'auto'(适合宽度)
  let lastScale = 1.0;        // 最近一次实际渲染缩放（供标注定位）
  // P2-13：滚轮无级缩放用的防抖 + 当前缩放历史最小/最大限制
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 5.0;
  let _zoomRafId = 0;
  let _pendingScale = null;
  let _zoomWheelDebounceTimer = null;

  let canvas = null;          // 渲染画布
  let ctx = null;             // 画布 2D 上下文
  let textLayerDiv = null;    // 文本层容器
  let pushBtn = null;         // 划选推送按钮
  let renderTask = null;      // 当前画布渲染任务(用于取消重叠渲染)
  let textLayerTask = null;   // 当前文本层渲染任务
  let selectionCallbacks = [];// 划选事件回调列表
  let pdfLoadedCallbacks = []; // PDF 加载完成回调列表
  let currentPdfName = null;   // 当前 PDF 文件名
  let _currentBookId = null;   // 当前书籍身份（与笔记/标注绑定）
  let _resizeDebounceTimer = null;  // ResizeObserver 防抖定时器
  let _lastRenderWidth = 0;         // ResizeObserver 上次容器宽度（防循环）

  // ---------- PDF.js Worker 配置 ----------
  function _setupWorker() {
    if (window.pdfjsLib) {
      // PDF.js 3.x 推荐使用 GlobalWorkerOptions
      if (pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN_BASE + 'pdf.worker.min.js';
      } else {
        // 兼容旧版 API
        pdfjsLib.workerSrc = PDFJS_CDN_BASE + 'pdf.worker.min.js';
      }
      pdfjsLib.disableWorker = false;
    }
  }

  function _hasPdfjs() {
    return !!(window.pdfjsLib && pdfjsLib.getDocument);
  }

  // 将 PDF.js 异常分类为用户可读的中文提示（加密 / 损坏 / 组件加载 / 其他）
  function _classifyPdfError(e) {
    if (!e) return 'PDF 解析失败：未知错误';
    var msg = (e && (e.message || String(e))) || '未知错误';
    var name = (e && e.name) || '';
    if (name === 'PasswordException' || /password|encrypted|cannot open/i.test(msg)) {
      return '该 PDF 已加密保护。请先在 PDF 阅读器 / WPS 中打开并输入密码，另存为「无密码」版本后，再导入书虫蛊。';
    }
    if (name === 'InvalidPDFException' || /invalid pdf|pdf structure|format/i.test(msg)) {
      return 'PDF 文件已损坏或格式不受支持。请重新下载 / 导出该文件后再试。';
    }
    if (/worker|network|fetch|load script|getDocument/i.test(msg)) {
      return 'PDF 解析组件加载失败（' + msg + '）。请确认页面资源完整（lib/pdf.worker.min.js 存在），并稍后重试。';
    }
    return 'PDF 解析失败：' + msg;
  }

  // 绑定当前书籍身份：通知标注引擎按书隔离并载入已保存标注（避免跨书串页、刷新丢失）
  function setBookId(bookId) {
    _currentBookId = bookId || null;
    if (typeof PDFAnnotate !== 'undefined' && PDFAnnotate.setBookId) {
      try { return PDFAnnotate.setBookId(_currentBookId); } catch (e) { /* ignore */ }
    }
    return Promise.resolve();
  }

  // ---------- 视口/画布初始化 ----------
  function _initViewport() {
    const vp = document.getElementById('pdfViewport');
    if (!vp) return;
    // 保留标注校准覆盖层（calibLayer），否则 PDF 重新加载/视图刷新时会把它清掉，
    // 导致点击「校准」按钮报「未找到校准层元素」。
    const calibLayer = document.getElementById('calibLayer');
    vp.innerHTML = '';
    if (calibLayer) vp.appendChild(calibLayer);

    canvas = document.createElement('canvas');
    canvas.id = 'pdfCanvas';
    ctx = canvas.getContext('2d');
    vp.appendChild(canvas);

    textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'pdf-text-layer';
    textLayerDiv.id = 'pdfTextLayer';
    // 如果精准模式已开启，为新文本层也添加 precise-mode 类
    if (preciseMode) textLayerDiv.classList.add('precise-mode');
    vp.appendChild(textLayerDiv);

    // 推送按钮
    pushBtn = document.createElement('button');
    pushBtn.className = 'pdf-push-btn';
    pushBtn.textContent = '推送到笔记';
    pushBtn.id = 'pdfPushBtn';
    pushBtn.addEventListener('click', _onPushToNote);
    vp.appendChild(pushBtn);

    // 标注层（AI 划重点）
    if (typeof PDFAnnotate !== 'undefined' && PDFAnnotate.init) {
      try { PDFAnnotate.init(vp); } catch (e) { /* ignore */ }
    }

    // 文本层划选监听
    textLayerDiv.addEventListener('mouseup', _onTextSelection);
    textLayerDiv.addEventListener('touchend', _onTextSelection);

    // 移除空提示
    const empty = document.getElementById('pdfEmpty');
    if (empty) empty.remove();
  }

  // ---------- 页码信息 / 按钮状态 ----------
  function _updatePageInfo() {
    const info = document.getElementById('pdfPageInfo');
    if (info) {
      if (pdfDoc) info.textContent = currentPageNum + ' / ' + pdfDoc.numPages;
      else info.textContent = '未加载';
    }
    const prev = document.getElementById('btnPrevPage');
    const next = document.getElementById('btnNextPage');
    if (prev) prev.disabled = !pdfDoc || currentPageNum <= 1;
    if (next) next.disabled = !pdfDoc || currentPageNum >= (pdfDoc ? pdfDoc.numPages : 1);
  }

  // ---------- 加载中 / 错误 状态覆盖层（提供明确反馈） ----------
  function _showLoading(msg) {
    const body = document.querySelector('.pdf-reader-body');
    if (!body) return;
    let el = document.getElementById('pdfLoading');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pdfLoading';
      el.className = 'pdf-loading';
      el.innerHTML = '<div class="pdf-loading-spinner"></div><div class="pdf-loading-text"></div>';
      body.appendChild(el);
    }
    el.querySelector('.pdf-loading-text').textContent = msg || '正在加载 PDF…';
    el.style.display = 'flex';
  }
  function _hideLoading() {
    const el = document.getElementById('pdfLoading');
    if (el) el.style.display = 'none';
  }
  function _showError(msg) {
    _hideLoading();
    const body = document.querySelector('.pdf-reader-body');
    if (!body) return;
    let el = document.getElementById('pdfError');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pdfError';
      el.className = 'pdf-error';
      el.innerHTML = '<div class="pdf-error-box"><div class="pdf-error-icon">⚠</div><div class="pdf-error-msg"></div><div class="pdf-error-hint">可尝试重新打开，或检查文件是否为有效 PDF。</div></div>';
      body.appendChild(el);
    }
    el.querySelector('.pdf-error-msg').textContent = msg || 'PDF 加载失败';
    el.style.display = 'flex';
  }
  function _hideError() {
    const el = document.getElementById('pdfError');
    if (el) el.style.display = 'none';
  }

  // ---------- 从 ArrayBuffer 加载（书虫蛊 · 文件管理系统打开书籍） ----------
  async function loadPdfFromBuffer(arrayBuffer, name, bookId) {
    if (!_hasPdfjs()) throw new Error('PDF.js 未加载，无法解析 PDF');
    _setupWorker();
    _hideError();
    _showLoading('正在解析 PDF…');
    try {
      const data = arrayBuffer instanceof ArrayBuffer ? arrayBuffer.slice(0) : arrayBuffer;
      const loadingTask = pdfjsLib.getDocument({ data: data });
      pdfDoc = await loadingTask.promise;
      currentPageNum = 1;
      currentPdfName = name || '教材';
      // 绑定书籍身份（标注按书隔离 + 载入已保存标注）
      await setBookId(bookId || ('pdf_' + currentPdfName));
      _initViewport();
      _updatePageInfo();
      await renderPage(currentPageNum);
      _hideLoading();
      // 触发 PDF 加载完成回调（书虫蛊不持久化到 pdfs store，由 FileManager 管理）
      _firePdfLoaded(name || '教材', pdfDoc.numPages);
      // 无内嵌书签时后台静默生成页眉目录
      _kickOffAutoTocIfNeeded();
      return pdfDoc.numPages;
    } catch (e) {
      var _friendly = _classifyPdfError(e);
      e.userMessage = _friendly;
      _showError(_friendly);
      console.error('PDF 加载失败:', e);
      throw e;
    }
  }

  // ---------- 加载 PDF 文件(File) ----------
  async function loadPdf(file) {
    if (!_hasPdfjs()) throw new Error('PDF.js 未加载，无法解析 PDF');
    _setupWorker();
    _hideError();
    _showLoading('正在解析 PDF…');

    const arrayBuffer = await file.arrayBuffer();
    // 注意: 传入的 ArrayBuffer 可能被 PDF.js transfer 而失效，这里拷贝一份用于持久化
    const persistCopy = arrayBuffer.slice(0);

    try {
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      pdfDoc = await loadingTask.promise;
      currentPageNum = 1;
      currentPdfName = file.name;

      // 绑定书籍身份（工具栏"打开"路径：pdf_+文件名，与笔记本身份一致）
      await setBookId('pdf_' + file.name);

      _initViewport();
      _updatePageInfo();
      await renderPage(currentPageNum);
      _hideLoading();

      // 持久化到 IndexedDB 的 pdfs store
      try {
        await DataLayer.put('pdfs', {
          id: 'current',
          bookId: 'pdf_' + file.name,
          name: file.name,
          blob: new Blob([persistCopy], { type: 'application/pdf' }),
          size: file.size,
          uploadedAt: Date.now()
        });
      } catch (e) {
        console.warn('PDF 持久化失败(不影响阅读):', e);
      }

      // 触发 PDF 加载完成回调
      _firePdfLoaded(file.name, pdfDoc.numPages);
      // 无内嵌书签时后台静默生成页眉目录
      _kickOffAutoTocIfNeeded();

      return pdfDoc.numPages;
    } catch (e) {
      var _friendly = _classifyPdfError(e);
      e.userMessage = _friendly;
      _showError(_friendly);
      console.error('PDF 加载失败:', e);
      throw e;
    }
  }

  // ---------- 从 IndexedDB 加载已存储的 PDF ----------
  async function loadPdfFromStorage(id) {
    if (!_hasPdfjs()) throw new Error('PDF.js 未加载，无法解析 PDF');
    _setupWorker();
    _hideError();
    _showLoading('正在解析 PDF…');

    const record = await DataLayer.get('pdfs', id);
    if (!record || !record.blob) {
      _showError('未找到已保存的 PDF（可能已被清除）');
      throw new Error('PDF 不存在: ' + id);
    }

    try {
      const arrayBuffer = await record.blob.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      pdfDoc = await loadingTask.promise;
      currentPageNum = 1;
      currentPdfName = record.name || '已保存的PDF';

      // 绑定书籍身份（恢复路径优先使用记录中的 bookId，避免与书架身份不一致）
      await setBookId(record.bookId || ('pdf_' + currentPdfName));

      _initViewport();
      _updatePageInfo();
      await renderPage(currentPageNum);
      _hideLoading();

      // 触发 PDF 加载完成回调
      _firePdfLoaded(currentPdfName, pdfDoc.numPages);
      // 无内嵌书签时后台静默生成页眉目录
      _kickOffAutoTocIfNeeded();

      return pdfDoc.numPages;
    } catch (e) {
      _showError('PDF 解析失败：' + (e && e.message ? e.message : e));
      console.error('PDF 加载失败:', e);
      throw e;
    }
  }

  // ---------- 渲染指定页 ----------
  async function renderPage(pageNum) {
    if (!pdfDoc) return;
    if (pageNum < 1 || pageNum > pdfDoc.numPages) return;
    currentPageNum = pageNum;

    const page = await pdfDoc.getPage(pageNum);

    // 计算实际缩放: 'auto' 适合容器宽度
    const container = document.getElementById('pdfViewport');
    const containerWidth = container ? container.clientWidth - 24 : 800;
    const baseViewport = page.getViewport({ scale: 1 });
    let actualScale = scale;
    if (scale === 'auto') {
      actualScale = containerWidth > 0 ? containerWidth / baseViewport.width : 1;
    }
    const vp = page.getViewport({ scale: actualScale });
    lastScale = actualScale; // 记录当前实际缩放（供标注定位）

    // 取消上一次未完成的画布渲染，避免重叠
    if (renderTask) {
      try { renderTask.cancel(); } catch (e) { /* 忽略取消错误 */ }
    }
    if (textLayerTask) {
      try { textLayerTask.cancel(); } catch (e) { /* 忽略 */ }
    }

    // 高清渲染: 使用 devicePixelRatio 提升清晰度
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';

    // 画布渲染 — 使用设备分辨率视口
    var renderVp = page.getViewport({ scale: actualScale * dpr });
    renderTask = page.render({ canvasContext: ctx, viewport: renderVp });

    renderTask.promise.then(function() {
      renderTask = null;
      _updatePageInfo();

      // 重绘标注层：renderTask 完成时 canvas 已就位，getBoundingClientRect 精确
      // 关键修复：仅当当前页码仍等于本次渲染页码时才对齐，避免翻页/缩放竞态下旧任务覆盖新页标注
      if (currentPageNum === pageNum && typeof PDFAnnotate !== 'undefined' && PDFAnnotate.renderPage) {
        try {
          var canvasRect = canvas.getBoundingClientRect();
          var viewportRect = container.getBoundingClientRect();
          var offsetX = canvasRect.left - viewportRect.left;
          var offsetY = canvasRect.top - viewportRect.top;
          PDFAnnotate.renderPage(pageNum, canvasRect.width, canvasRect.height, offsetX, offsetY, lastScale);
        } catch (e) { console.error('[pdf-reader] PDFAnnotate.renderPage 异常:', e); }
      }

      // 文本层延迟渲染
      _renderTextLayer(page, vp).catch(function(err) { console.warn('文本层渲染失败:', err); });
    }).catch(function(err) {
      // 渲染被取消时静默；非取消错误也尝试对齐标注层
      renderTask = null;
      if (err && err.name === 'RenderingCancelledException') return;

      if (currentPageNum === pageNum && typeof PDFAnnotate !== 'undefined' && PDFAnnotate.renderPage) {
        try {
          var cr = canvas.getBoundingClientRect();
          var vr = container.getBoundingClientRect();
          PDFAnnotate.renderPage(pageNum, cr.width, cr.height, cr.left - vr.left, cr.top - vr.top, lastScale);
        } catch (e2) { console.error('[pdf-reader] PDFAnnotate.renderPage 异常(catch):', e2); }
      }
    });
  }

  // ---------- 提供给标注引擎的辅助 ----------
  function getPdfDoc() { return pdfDoc; }
  function getCurrentScale() { var s = lastScale || scale || 1; return typeof s === 'number' ? s : 1; }

  // ---------- 渲染文本层(覆盖在 canvas 之上，供划选) ----------
  async function _renderTextLayer(page, vp) {
    if (!textLayerDiv) return;
    textLayerDiv.innerHTML = '';
    // 文本层尺寸与画布 CSS 显示尺寸完全一致
    textLayerDiv.style.width = vp.width + 'px';
    textLayerDiv.style.height = vp.height + 'px';
    textLayerDiv.style.top = canvas.offsetTop + 'px';
    textLayerDiv.style.left = canvas.offsetLeft + 'px';
    // 重置可能残留的 transform
    textLayerDiv.style.transform = '';
    // PDF.js 3.x 要求设置 --scale-factor CSS 变量，值 = viewport.scale
    // 否则文本层 span 定位会出错，导致划选不准
    textLayerDiv.style.setProperty('--scale-factor', vp.scale);

    const textContent = await page.getTextContent();

    // 扫描件兜底：原生文本为空时，尝试用 OCR 缓存行渲染可划选文字层（v145+）
    var hasNative = textContent.items && textContent.items.some(function (it) {
      return it.str && it.str.trim();
    });
    if (!hasNative && typeof window.OCREngine !== 'undefined') {
      try {
        var ocrLines = await OCREngine.getPageOcrLines(_currentBookId, currentPageNum);
        if (ocrLines && ocrLines.length) {
          _renderOcrTextLayer(ocrLines, vp);
          return;
        }
      } catch (e) { /* OCR 层渲染失败不影响阅读 */ }
    }

    // PDF.js 3.x 提供 renderTextLayer，返回带 promise 的任务对象
    // 使用 CSS 显示视口 vp（非设备分辨率视口），确保 span 定位与画布显示对齐
    // 使用 textContentSource 替代已废弃的 textContent 参数
    const task = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: vp,
      textDivs: []
    });
    textLayerTask = task;
    if (task && typeof task.promise !== 'undefined') {
      await task.promise;
    }
    textLayerTask = null;

    // 修正文本层 span 的缩放：确保与画布 CSS 尺寸精确匹配
    var spans = textLayerDiv.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      spans[i].style.transformOrigin = '0 0';
    }

    // 文本层渲染完成后，重新对齐标注层（文本层 DOM 插入可能导致画布位置微调）
    // 关键修复：翻页竞态下旧文本层完成时不覆盖当前页标注
    if (currentPageNum === pageNum && typeof PDFAnnotate !== 'undefined' && PDFAnnotate.renderPage) {
      try {
        var cr2 = canvas.getBoundingClientRect();
        var vr2 = container.getBoundingClientRect();
        PDFAnnotate.renderPage(pageNum, cr2.width, cr2.height, cr2.left - vr2.left, cr2.top - vr2.top, lastScale);
      } catch (e3) { /* 标注层对齐失败不影响阅读 */ }
    }
  }

  // ---------- OCR 文字层：扫描件用透明文本 span 覆盖在图上，实现"可划选" ----------
  // lines: [{text,x,y,w,h}]（PDF 坐标，左上角原点，单位 pt）；vp: 显示视口
  function _renderOcrTextLayer(lines, vp) {
    if (!textLayerDiv || !lines || !lines.length) return;
    textLayerDiv.innerHTML = '';
    var scale = vp.scale;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var span = document.createElement('span');
      span.textContent = ln.text;
      span.style.cssText =
        'position:absolute;left:' + (ln.x * scale) + 'px;top:' + (ln.y * scale) + 'px;' +
        'width:' + (ln.w * scale) + 'px;font-size:' + Math.max(4, ln.h * scale) + 'px;' +
        'line-height:' + (ln.h * scale) + 'px;color:transparent;background:transparent;' +
        'white-space:nowrap;cursor:text;user-select:text;-webkit-user-select:text;' +
        'pointer-events:auto;';
      textLayerDiv.appendChild(span);
    }
    // 标记该层为 OCR 文字层（供 debug / 样式区分）
    textLayerDiv.setAttribute('data-ocr', '1');
  }

  // ---------- 划选事件 ----------
  function _onTextSelection() {
    if (!pushBtn) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      pushBtn.style.display = 'none';
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      pushBtn.style.display = 'none';
      return;
    }
    // 定位推送按钮到选区上方
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const vpRect = document.getElementById('pdfViewport').getBoundingClientRect();
    pushBtn.style.display = 'block';
    pushBtn.style.left = (rect.left - vpRect.left + rect.width / 2 - 60) + 'px';
    pushBtn.style.top = (rect.top - vpRect.top - 35) + 'px';
  }

  // ---------- 推送划选文本到笔记 ----------
  function _onPushToNote() {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : '';
    if (!text) return;
    const pdfRef = { pageNum: currentPageNum, text: text };
    selectionCallbacks.forEach(cb => {
      try { cb(pdfRef, text); } catch (e) { console.error('划选回调异常:', e); }
    });
    if (pushBtn) pushBtn.style.display = 'none';
    if (selection) selection.removeAllRanges();
  }

  // ---------- 获取当前划选 ----------
  function getSelection() {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : '';
    if (!text) return null;
    return { text: text, pageNum: currentPageNum };
  }

  // ---------- 注册划选事件回调 ----------
  function onSelection(callback) {
    if (typeof callback === 'function') selectionCallbacks.push(callback);
  }

  // ---------- 注册 PDF 加载完成回调 ----------
  function onPdfLoaded(callback) {
    if (typeof callback === 'function') pdfLoadedCallbacks.push(callback);
  }

  function _firePdfLoaded(name, numPages) {
    pdfLoadedCallbacks.forEach(function(cb) {
      try { cb(name, numPages); } catch (e) { console.error('PDF加载回调异常:', e); }
    });
  }

  // ---------- 获取当前 PDF 文件名 ----------
  function getPdfName() { return currentPdfName; }

  // ---------- 提取指定页文本(供 AI 阅读代理调用) ----------
  // 改进: 基于 Y 坐标变化插入换行，还原原始排版结构
  async function getPageText(pageNum) {
    if (!pdfDoc) return '';
    if (pageNum < 1 || pageNum > pdfDoc.numPages) return '';
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    if (!textContent.items || textContent.items.length === 0) {
      // 扫描件：原生文本为空 → 尝试 OCR 缓存文本（v145+）
      if (typeof window.OCREngine !== 'undefined' && OCREngine.getPageOcrText) {
        try {
          var ot = await OCREngine.getPageOcrText(_currentBookId, pageNum);
          if (ot) return ot;
        } catch (e) {}
      }
      return '';
    }

    let text = '';
    let lastY = null;
    let lastX = null;
    let linePrefix = '';
    for (let i = 0; i < textContent.items.length; i++) {
      const item = textContent.items[i];
      if (!item.str) continue;
      const y = item.transform ? item.transform[5] : null;
      const x = item.transform ? item.transform[4] : null;
      // Y 坐标变化超过阈值 → 换行
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
        text += '\n';
        linePrefix = '';
      } else if (text && !text.endsWith('\n') && !text.endsWith(' ')) {
        // 同一行: 根据 x 间距判断是否补空格（代码块中字符间距小时不加空格）
        const gap = (lastX !== null && x !== null && item.width !== undefined)
          ? (x - lastX - item.width) : 0;
        if (gap > 1.5 || (item.str && !item.str.startsWith(' ') && gap >= 0)) {
          text += ' ';
        }
      }
      text += item.str;
      linePrefix += item.str;
      if (y !== null) lastY = y;
      if (x !== null && item.width !== undefined) lastX = x + item.width;
    }
    return text.trim();
  }

  // ---------- 检测指定页是否有文本层(区分原生PDF与扫描件) ----------
  async function hasTextLayer(pageNum) {
    if (!pdfDoc) return false;
    if (pageNum < 1 || pageNum > pdfDoc.numPages) return false;
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    return !!(textContent.items && textContent.items.length > 0 && 
              textContent.items.some(function(item) { return item.str && item.str.trim().length > 0; }));
  }

  // ---------- 获取当前页文本(便捷方法) ----------
  async function getCurrentPageText() {
    return await getPageText(currentPageNum);
  }

  // ---------- 获取目录结构 ----------
  async function getTOC() {
    if (!pdfDoc) return [];
    const outline = await pdfDoc.getOutline();
    if (outline && outline.length > 0) {
      return await _parseOutline(outline, 0);
    }
    // 无内嵌书签 → 使用页眉检测目录（本地缓存；未生成则后台异步扫描，本次返回空）
    var cached = _loadAutoToc(_autoTocId());
    if (cached && cached.length) return _autoTocToOutline(cached);
    detectRunningHeadTOC().catch(function(e) { console.warn('页眉目录生成失败:', e); });
    return [];
  }

  // PDF.js getPageIndex 返回 Promise，需异步解析
  async function _parseOutline(outline, level) {
    const result = [];
    for (let i = 0; i < outline.length; i++) {
      const item = outline[i];
      let pageNum = 1;
      let dest = item.dest;

      // 命名目标(string): 异步解析为显式目标
      if (typeof dest === 'string') {
        try {
          const explicit = await pdfDoc.getDestination(dest);
          dest = explicit;
        } catch (e) { dest = null; }
      }

      // 显式目标: [ref, {name}, x, y, zoom]
      if (Array.isArray(dest) && dest.length > 0) {
        const ref = dest[0];
        try {
          const pageIndex = await pdfDoc.getPageIndex(ref);
          pageNum = pageIndex + 1;
        } catch (e) { pageNum = 1; }
      }

      const children = (item.items && item.items.length > 0)
        ? await _parseOutline(item.items, level + 1)
        : [];

      result.push({
        id: 'ch_' + level + '_' + i,
        title: item.title || ('第 ' + (i + 1) + ' 项'),
        pageNum: pageNum,
        level: level,
        children: children
      });
    }
    return result;
  }

  // ============================================================
  // 页眉/页脚检测 → 自动生成目录（v143+，本地实现，不耗 LLM token）
  // 原理：书籍排版通常页眉带当前章节名，页眉内容变化处即章节起始页。
  // 结果按 bookId 缓存到 localStorage；getTOC 无内嵌书签时自动合并使用。
  // ============================================================
  var _autoTocKey = 'shuchongu_running_head_toc_v1';
  var _autoTocScanning = {};   // bookId -> true 防重入

  function _autoTocId() {
    return _currentBookId || ('pdf_' + (currentPdfName || 'unknown'));
  }

  function _loadAutoToc(bookId) {
    try {
      var raw = localStorage.getItem(_autoTocKey);
      if (!raw) return null;
      var all = JSON.parse(raw);
      return (all && all[bookId] && all[bookId].length) ? all[bookId] : null;
    } catch (e) { return null; }
  }

  function _saveAutoToc(bookId, toc) {
    try {
      var all = {};
      var raw = localStorage.getItem(_autoTocKey);
      if (raw) { try { all = JSON.parse(raw) || {}; } catch (e) { all = {}; } }
      all[bookId] = toc;
      localStorage.setItem(_autoTocKey, JSON.stringify(all));
    } catch (e) { /* 容量/隐私模式失败忽略 */ }
  }

  // 清洗页眉：去尾部/头部页码、去纯数字标点、压缩空白
  function _cleanRunningHead(s) {
    if (!s) return '';
    var t = String(s).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    // 去掉尾部页码（如 "第三章 传染病的防治 87" / "· 34"）
    t = t.replace(/[\s|｜·•—\-–_/\\:：,，;；]*\d{1,4}\s*$/, '').trim();
    // 去掉头部页码（如 "87 第三章 传染病的防治"）
    t = t.replace(/^\d{1,4}[\s|｜·•—\-–_/\\:：,，;；]*/, '').trim();
    // 纯数字/纯标点 → 无意义
    if (/^[\d\s|｜·•—\-–_/\\:：.。、,，;；()（）\[\]【】]*$/.test(t)) return '';
    if (t.length < 2) return '';
    return t;
  }

  // 文本项按行分组（y 差 <3 视为同行，按 x 排序拼接），返回各行文本（上→下）
  function _groupTextByLine(items, filter) {
    var rows = {}, yOrder = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.str || !filter(it)) continue;
      var y = it.transform ? it.transform[5] : 0;
      var x = it.transform ? it.transform[4] : 0;
      var key = null;
      for (var k = 0; k < yOrder.length; k++) {
        if (Math.abs(yOrder[k] - y) < 3) { key = yOrder[k]; break; }
      }
      if (key === null) { key = y; yOrder.push(y); rows[key] = []; }
      rows[key].push({ x: x, str: it.str, w: it.width || (it.str.length * 4) });
    }
    yOrder.sort(function(a, b) { return b - a; }); // PDF y 向上：大 y 在上
    var lines = [];
    for (var j = 0; j < yOrder.length; j++) {
      var arr = rows[yOrder[j]].slice().sort(function(a, b) { return a.x - b.x; });
      var line = '', lastEnd = null;
      for (var m = 0; m < arr.length; m++) {
        if (lastEnd !== null && (arr[m].x - lastEnd) > 1.5) line += ' ';
        line += arr[m].str;
        lastEnd = arr[m].x + arr[m].w;
      }
      lines.push(line);
    }
    return lines;
  }

  // 提取指定页页眉（顶部带）与页脚（底部带）首行文本
  async function _extractRunningHead(pageNum) {
    if (!pdfDoc) return { header: '', footer: '' };
    try {
      var page = await pdfDoc.getPage(pageNum);
      var vp = page.getViewport({ scale: 1 });
      var H = vp.height;
      var band = Math.max(36, H * 0.08);   // 顶部/底部 8%（至少 36pt）
      var textContent = await page.getTextContent();
      if (!textContent.items || !textContent.items.length) return { header: '', footer: '' };
      var headerLines = _groupTextByLine(textContent.items, function(it) {
        var y = it.transform ? it.transform[5] : -1;
        return y > H - band;   // PDF y 向上：顶部 = y 大
      });
      var footerLines = _groupTextByLine(textContent.items, function(it) {
        var y = it.transform ? it.transform[5] : -1;
        return y < band;
      });
      return {
        header: headerLines.length ? headerLines[0].trim() : '',
        footer: footerLines.length ? footerLines[0].trim() : ''
      };
    } catch (e) { return { header: '', footer: '' }; }
  }

  // 扫描全书：页眉变化处 = 章节起始页（本地逐页检测，不调 LLM）
  async function detectRunningHeadTOC(onProgress) {
    if (!pdfDoc) return [];
    var bookId = _autoTocId();
    if (_autoTocScanning[bookId]) return _loadAutoToc(bookId) || [];
    _autoTocScanning[bookId] = true;
    var numPages = pdfDoc.numPages;
    var toc = [], seen = {}, prevHeader = null;
    try {
      for (var p = 1; p <= numPages; p++) {
        var hd = '';
        try {
          var rh = await _extractRunningHead(p);
          hd = _cleanRunningHead(rh.header);
        } catch (e) { hd = ''; }
        if (onProgress) { try { onProgress(p, numPages); } catch (e) {} }
        if (hd) {
          if (hd !== prevHeader && !seen[hd]) {
            seen[hd] = p;
            toc.push({ title: hd, pageNum: p, level: 0, source: 'running-head' });
          }
          prevHeader = hd;
        } else {
          prevHeader = null;  // 页眉空页（章节首页常无页眉）→ 重置，下一页变化重新计
        }
        // 每 2 页让出主线程，避免卡 UI
        if (p % 2 === 0) await new Promise(function(r) { setTimeout(r, 0); });
      }
    } finally {
      _autoTocScanning[bookId] = false;
    }
    _saveAutoToc(bookId, toc);
    return toc;
  }

  // 读取已缓存的页眉目录（未生成返回 null）
  function getRunningHeadTOC() {
    return _loadAutoToc(_autoTocId());
  }

  // ---------- OCR 操作（v145+） ----------
  // 识别当前页并重渲染（让扫描页出现可划选文字层）
  async function ocrCurrentPage() {
    if (typeof window.OCREngine === 'undefined') throw new Error('OCR 引擎未加载');
    var pn = currentPageNum;
    if (!pn) return null;
    var res = await OCREngine.ocrPage(_currentBookId, pn);
    try { await renderPage(pn); } catch (e) {}
    return res;
  }

  // 顺序 OCR 一段页码（start..end），逐页回调 onPageDone(pageNum, total, result)
  function ocrBookRange(start, end, onPageDone) {
    if (typeof window.OCREngine === 'undefined') return Promise.reject(new Error('OCR 引擎未加载'));
    if (!start || start < 1) start = 1;
    if (!end) end = pdfDoc ? pdfDoc.numPages : start;
    return OCREngine.ocrBook(_currentBookId, start, end, onPageDone);
  }

  // 删除页眉目录缓存（用于强制重新生成）
  function clearRunningHeadTOC() {
    try {
      var raw = localStorage.getItem(_autoTocKey);
      if (raw) {
        var all = JSON.parse(raw);
        delete all[_autoTocId()];
        localStorage.setItem(_autoTocKey, JSON.stringify(all));
      }
    } catch (e) {}
  }

  // 自动目录转标准 outline 结构（带 id/children，供 getTOC 合并与 AI 跳章节）
  function _autoTocToOutline(toc) {
    return (toc || []).map(function(item, i) {
      return {
        id: 'ch_0_' + i,
        title: item.title,
        pageNum: item.pageNum,
        level: 0,
        children: [],
        source: 'running-head'
      };
    });
  }

  // PDF 加载完成后：若无内嵌书签，后台静默扫描页眉生成目录
  function _kickOffAutoTocIfNeeded() {
    if (!pdfDoc) return;
    pdfDoc.getOutline().then(function(outline) {
      if (outline && outline.length) return; // 有书签，不需要
      var cached = _loadAutoToc(_autoTocId());
      if (cached && cached.length) return;   // 已生成过
      detectRunningHeadTOC().catch(function(e) { console.warn('页眉目录生成失败:', e); });
    }).catch(function() {
      var cached = _loadAutoToc(_autoTocId());
      if (cached && cached.length) return;
      detectRunningHeadTOC().catch(function(e) { console.warn('页眉目录生成失败:', e); });
    });
  }

  // ---------- 提取指定章节文本 ----------
  async function getChapterText(chapterId) {
    if (!pdfDoc) return '';
    const toc = await getTOC();
    const chapter = _findChapterById(toc, chapterId);
    if (!chapter) return '';
    const next = _findNextChapterPage(toc, chapterId);
    const endPage = next ? next.pageNum - 1 : pdfDoc.numPages;
    let fullText = '';
    for (let p = chapter.pageNum; p <= endPage; p++) {
      fullText += await getPageText(p) + '\n';
    }
    return fullText;
  }

  function _findChapterById(toc, id) {
    for (const item of toc) {
      if (item.id === id) return item;
      if (item.children && item.children.length) {
        const found = _findChapterById(item.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function _flattenTOC(toc) {
    let result = [];
    for (const item of toc) {
      result.push(item);
      if (item.children && item.children.length) {
        result = result.concat(_flattenTOC(item.children));
      }
    }
    return result;
  }

  function _findNextChapterPage(toc, currentId) {
    const flat = _flattenTOC(toc);
    const idx = flat.findIndex(item => item.id === currentId);
    if (idx >= 0 && idx < flat.length - 1) return flat[idx + 1];
    return null;
  }

  // ---------- 滚动到指定页(聚焦功能调用) ----------
  async function scrollToPage(pageNum) {
    await renderPage(pageNum);
    const vp = document.getElementById('pdfViewport');
    if (vp) vp.scrollTop = 0;
  }

  // ---------- 高亮指定文本(聚焦结果) ----------
  async function highlightText(pageNum, text) {
    if (!text) return;
    await renderPage(pageNum);
    // 等待文本层渲染完成
    if (!textLayerDiv) return;
    // 文本层为异步，轮询等待 span 出现
    let waited = 0;
    while (textLayerDiv.querySelectorAll('span').length === 0 && waited < 1500) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }
    const spans = textLayerDiv.querySelectorAll('span');
    const textLower = text.toLowerCase();
    let combined = '';
    const spanTexts = [];
    spans.forEach(span => {
      spanTexts.push(span.textContent || '');
      combined += spanTexts[spanTexts.length - 1];
    });
    const idx = combined.toLowerCase().indexOf(textLower);
    if (idx < 0) return;
    let pos = 0;
    spans.forEach((span, i) => {
      const spanLen = spanTexts[i].length;
      if (pos + spanLen > idx && pos < idx + text.length) {
        span.style.background = 'rgba(255,140,0,.4)';
      }
      pos += spanLen;
    });
  }

  // ---------- 翻页 / 跳转 / 缩放 ----------
  async function prevPage() {
    if (currentPageNum > 1) await renderPage(currentPageNum - 1);
  }

  async function nextPage() {
    if (pdfDoc && currentPageNum < pdfDoc.numPages) await renderPage(currentPageNum + 1);
  }

  async function jumpToPage(pageNum) {
    if (!pdfDoc) return;
    pageNum = parseInt(pageNum, 10);
    if (isNaN(pageNum)) return;
    if (pageNum < 1 || pageNum > pdfDoc.numPages) return;
    await renderPage(pageNum);
  }

  async function setZoom(newScale, opts) {
    if (newScale === 'auto') {
      scale = 'auto';
    } else {
      var ns = Number(newScale);
      if (isNaN(ns) || !isFinite(ns)) return;
      ns = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, ns));
      // 保留 3 位小数，避免 1.000000001 这种浮点垃圾
      ns = Math.round(ns * 1000) / 1000;
      scale = ns;
    }
    // P2-13：同步刷新「无级缩放选择框」里的当前比例（如果页面里有一个自定义的比例标签/select）
    try {
      var zoomSel = document.getElementById('selectZoom');
      if (zoomSel) {
        var valStr = (scale === 'auto') ? 'auto' : String(scale);
        // 先看是否等于预设选项，否则插入一个 custom 选项
        var found = false;
        for (var i = 0; i < zoomSel.options.length; i++) {
          if (zoomSel.options[i].value === valStr) {
            zoomSel.selectedIndex = i; found = true; break;
          }
        }
        if (!found && scale !== 'auto') {
          var opt = document.createElement('option');
          opt.value = String(scale);
          opt.textContent = Math.round(scale * 100) + '%（自定义）';
          zoomSel.add(opt, zoomSel.options.length);
          zoomSel.value = String(scale);
        }
      }
      var zoomLabel = document.getElementById('labelCurrentZoom');
      if (zoomLabel) {
        zoomLabel.textContent = (scale === 'auto') ? '自适应宽度' : (Math.round(scale * 100) + '%');
      }
    } catch (e) {}
    if (pdfDoc) {
      // 新划重点层使用 base 坐标空间，缩放只改变渲染换算，无需重定位
      await renderPage(currentPageNum);
    }
  }

  // ---------- P2-13：滚轮缩放（Ctrl+滚轮 或 普通滚轮，可切换为按住 Ctrl 才生效）----------
  // opts.ctrlOnly = true 表示只在按下 Ctrl 时才用滚轮缩放（默认 false：PDF 区域内任意滚轮都触发缩放）
  // 但是"滚轮只缩放不滚页"很反直觉 → 默认策略是：按住 Ctrl 滚轮才缩放，否则还是滚页
  let _zoomCtrlOnly = true;
  function _bindWheelZoom() {
    var container = document.getElementById('pdfCanvasContainer') || document.getElementById('pdfReaderContainer') || document.getElementById('spacePdf');
    if (!container) return;
    function onWheel(ev) {
      if (!pdfDoc) return;
      var ctrl = ev.ctrlKey || ev.metaKey;
      if (_zoomCtrlOnly && !ctrl) return; // 默认 Ctrl+滚轮 才缩放，否则让浏览器自然滚页
      if (ev.deltaY === 0) return;
      ev.preventDefault();
      var base = (typeof scale === 'number') ? scale : (lastScale || 1);
      var factor = (ev.deltaY < 0) ? 1.12 : (1 / 1.12);
      var target = base * factor;
      // 用 rAF 合并连续滚轮事件，并 debounce 真正 renderPage（避免 PDF.js 重绘过多卡顿）
      _pendingScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, target));
      if (!_zoomRafId) {
        _zoomRafId = requestAnimationFrame(function() {
          _zoomRafId = 0;
          if (_pendingScale != null) {
            // 先直接把 scale 改了，但只在 debounce 后 renderPage
            var want = _pendingScale;
            _pendingScale = null;
            // 先临时应用到 canvas 的 CSS transform（肉眼先感觉到缩放），防抖结束后再真 PDF 重绘
            var can = document.getElementById('pdfCanvas');
            var cc = document.getElementById('pdfCanvasContainer');
            if (can && cc && typeof want === 'number') {
              var ratio = want / ((typeof scale === 'number') ? scale : 1);
              var tOrigin = 'center top';
              can.style.transformOrigin = tOrigin;
              can.style.transition = 'transform .08s linear';
              can.style.transform = 'scale(' + ratio + ')';
              // 关键修复：同步缩放标注层与文本层，避免缩放防抖期间划重点层与 PDF 层错位
              ['pdfAnnotateLayer','pdfFloatingNotesLayer','pdfTextLayer'].forEach(function(aid) {
                var ael = document.getElementById(aid);
                if (!ael) return;
                ael.style.transformOrigin = tOrigin;
                ael.style.transition = 'transform .08s linear';
                ael.style.transform = 'scale(' + ratio + ')';
              });
            }
            if (_zoomWheelDebounceTimer) clearTimeout(_zoomWheelDebounceTimer);
            _zoomWheelDebounceTimer = setTimeout(function() {
              _zoomWheelDebounceTimer = null;
              if (can) { can.style.transition = ''; can.style.transform = ''; }
              ['pdfAnnotateLayer','pdfFloatingNotesLayer','pdfTextLayer'].forEach(function(aid) {
                var ael = document.getElementById(aid);
                if (ael) { ael.style.transition = ''; ael.style.transform = ''; }
              });
              setZoom(want).catch(function(e){ console.warn('滚轮缩放重绘失败:', e); });
            }, 140);
          }
        });
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false });
  }

  // ---------- 状态查询 ----------
  function getCurrentPage() { return currentPageNum; }
  function getPageCount() { return pdfDoc ? pdfDoc.numPages : 0; }
  function getCurrentZoom() { return scale; }

  // ---------- 目录渲染 / 切换 ----------
  async function renderTOC() {
    const list = document.getElementById('pdfTOCList');
    if (!list) return;
    const toc = await getTOC();
    if (toc.length === 0) {
      list.innerHTML = '<div class="pdf-toc-empty">此 PDF 无目录</div>';
      return;
    }
    list.innerHTML = '';
    _renderTOCItems(list, toc, 0);
  }

  function _renderTOCItems(container, items, level) {
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'pdf-toc-item toc-level-' + level;
      div.textContent = item.title;
      div.dataset.pageNum = item.pageNum;
      div.dataset.chapterId = item.id;
      div.addEventListener('click', () => {
        jumpToPage(item.pageNum);
        container.querySelectorAll('.pdf-toc-item').forEach(el => el.classList.remove('toc-active'));
        div.classList.add('toc-active');
      });
      container.appendChild(div);
      if (item.children && item.children.length > 0) {
        _renderTOCItems(container, item.children, level + 1);
      }
    });
  }

  function toggleTOC() {
    const toc = document.getElementById('pdfTOC');
    if (!toc) return;
    if (toc.style.display === 'none' || toc.style.display === '') {
      toc.style.display = 'flex';
      renderTOC().catch(err => console.warn('目录渲染失败:', err));
    } else {
      toc.style.display = 'none';
    }
  }

  // ---------- 精准划词模式 ----------
  let preciseMode = false;

  function togglePreciseMode() {
    preciseMode = !preciseMode;
    if (textLayerDiv) {
      if (preciseMode) {
        textLayerDiv.classList.add('precise-mode');
      } else {
        textLayerDiv.classList.remove('precise-mode');
      }
    }
    var btn = document.getElementById('btnTogglePrecise');
    if (btn) {
      if (preciseMode) btn.classList.add('active');
      else btn.classList.remove('active');
    }
    return preciseMode;
  }

  function isPreciseMode() { return preciseMode; }

  // ---------- 容器尺寸变化监听（分栏拖动时同步标注层） ----------

  function _setupResizeObserver() {
    var target = document.getElementById('pdfReader');
    if (!target || typeof ResizeObserver === 'undefined') return;

    var observer = new ResizeObserver(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var newWidth = Math.round(entry.contentRect.width);
        // 忽略高度变化（翻页/渲染导致的高度变化不重渲染），
        // 且宽度未实际改变时跳过，防止 renderPage → canvas 重设尺寸 → 循环触发
        if (newWidth === _lastRenderWidth) continue;
        _lastRenderWidth = newWidth;

        clearTimeout(_resizeDebounceTimer);
        _resizeDebounceTimer = setTimeout(function() {
          requestAnimationFrame(function() {
            var cp = getCurrentPage();
            if (cp && cp > 0) {
              try { renderPage(cp); } catch (e) { /* ignore */ }
            }
          });
        }, 100);
      }
    });
    observer.observe(target);
  }

  // ---------- 初始化事件绑定 ----------
  function init() {
    _setupResizeObserver();
    // P2-13：注册滚轮缩放（默认 Ctrl+滚轮，避免干扰正常滚页）
    try { _bindWheelZoom(); } catch (e) { /* 容器还没生成时跳过，等容器 ready 会在后面再尝试一次 */ }

    // 「📂 打开」按钮已移除（统一走书架导入）；保留 fileInput 兜底监听以便程序化触发
    const fileInput = document.getElementById('inputPdfFile');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          // 加载 PDF 后，使用与文件名一致的笔记本 ID 加载/创建笔记，
          // 与书架打开（bookId）路径共享"单一笔记本身份"约定，避免笔记分裂。
          loadPdf(file).then(function() {
            return Notebook.loadOrCreateNotebook('pdf_' + file.name, file.name);
          }).catch(function(err) {
            console.error('PDF 加载失败:', err);
            _hideLoading();
            const tip = _classifyPdfError(err);
            _showError(tip);
            // 关键修复：此前此处仅 console.error —— 用户“导入毫无反应”。
            // 现在给出明确、可操作的提示。
            alert('PDF 导入失败：' + tip);
          });
        }
        // 清空 value 以便重复选择同一文件
        e.target.value = '';
      });
    }
    const prev = document.getElementById('btnPrevPage');
    if (prev) prev.addEventListener('click', () => prevPage().catch(e => console.error(e)));
    const next = document.getElementById('btnNextPage');
    if (next) next.addEventListener('click', () => nextPage().catch(e => console.error(e)));

    const jumpBtn = document.getElementById('btnJumpPage');
    const jumpInput = document.getElementById('inputJumpPage');
    if (jumpBtn && jumpInput) {
      jumpBtn.addEventListener('click', () => {
        const pageNum = parseInt(jumpInput.value, 10);
        if (pageNum) jumpToPage(pageNum).catch(e => console.error(e));
      });
      jumpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const pageNum = parseInt(e.target.value, 10);
          if (pageNum) jumpToPage(pageNum).catch(err => console.error(err));
        }
      });
    }
    const zoom = document.getElementById('selectZoom');
    if (zoom) {
      zoom.addEventListener('change', (e) => {
        const val = e.target.value;
        setZoom(val === 'auto' ? 'auto' : parseFloat(val)).catch(err => console.error(err));
      });
    }
    const tocBtn = document.getElementById('btnToggleTOC');
    if (tocBtn) tocBtn.addEventListener('click', toggleTOC);
    const closeToc = document.getElementById('btnCloseTOC');
    if (closeToc) closeToc.addEventListener('click', toggleTOC);

    // 精准划词模式切换
    const preciseBtn = document.getElementById('btnTogglePrecise');
    if (preciseBtn) preciseBtn.addEventListener('click', togglePreciseMode);

    // ---------- v145+：扫描件 OCR 按钮 ----------
    function _ocrToast(msg) {
      try {
        if (window.__showToast) window.__showToast(msg);
        else alert(msg);
      } catch (e) {}
    }
    function _setOcrStatus(text) {
      var el = document.getElementById('ocrStatusLabel');
      if (el) {
        if (text) { el.style.display = 'inline'; el.textContent = text; }
        else { el.style.display = 'none'; el.textContent = ''; }
      }
    }
    const ocrPageBtn = document.getElementById('btnOcrPage');
    if (ocrPageBtn) {
      ocrPageBtn.addEventListener('click', function() {
        var pn = currentPageNum;
        if (!pn || !pdfDoc) return;
        ocrPageBtn.disabled = true;
        ocrPageBtn.textContent = '⏳ 识别中…';
        ocrCurrentPage().then(function(res) {
          var n = res && res.lines ? res.lines.length : 0;
          _ocrToast('✅ 第 ' + pn + ' 页识别完成，共 ' + n + ' 行文字，已可划选。');
          _setOcrStatus('');
        }).catch(function(e) {
          _ocrToast('❌ 第 ' + pn + ' 页识别失败：' + ((e && e.message) || e));
          _setOcrStatus('');
        }).finally(function() {
          ocrPageBtn.disabled = false;
          ocrPageBtn.textContent = '📷 OCR 此页';
        });
      });
    }
    const ocrBookBtn = document.getElementById('btnOcrBook');
    if (ocrBookBtn) {
      ocrBookBtn.addEventListener('click', function() {
        var pn = currentPageNum;
        var total = pdfDoc ? pdfDoc.numPages : pn;
        if (!pn) return;
        if (!window.confirm('从第 ' + pn + ' 页开始识别到第 ' + total + ' 页（共 ' + (total - pn + 1) + ' 页）？识别过程在后台进行，可翻页继续阅读。')) return;
        ocrBookBtn.disabled = true;
        ocrBookRange(pn, total, function(cur, end, res) {
          _setOcrStatus('⏳ OCR 中 ' + cur + '/' + end + '（' + (res && res.lines ? res.lines.length : 0) + ' 行）');
        }).then(function(results) {
          var ok = results.filter(function(r) { return !r.error; }).length;
          _ocrToast('✅ 整本 OCR 完成：成功 ' + ok + ' / ' + results.length + ' 页，识别结果已缓存，划选与 AI 阅读立即可用。');
          _setOcrStatus('');
          // 若识别了当前页，重渲染出文字层
          try { renderPage(currentPageNum); } catch (e) {}
        }).catch(function(e) {
          _ocrToast('❌ 整本 OCR 中断：' + ((e && e.message) || e));
          _setOcrStatus('');
        }).finally(function() {
          ocrBookBtn.disabled = false;
        });
      });
    }
  }

  return {
    init, loadPdf, loadPdfFromBuffer, loadPdfFromStorage, renderPage, setBookId, getTOC,
    getPageText, getCurrentPageText, hasTextLayer, getChapterText,
    getSelection, scrollToPage, highlightText, onSelection,
    onPdfLoaded, getPdfName,
    prevPage, nextPage, jumpToPage, setZoom, getCurrentPage,
    getPageCount, renderTOC, toggleTOC, getCurrentZoom,
    togglePreciseMode, isPreciseMode,
    getPdfDoc, getCurrentScale,
    getBookId: function() { return _currentBookId; },
    // v143+：页眉/页脚自动生成目录
    detectRunningHeadTOC: detectRunningHeadTOC,
    getRunningHeadTOC: getRunningHeadTOC,
    clearRunningHeadTOC: clearRunningHeadTOC,
    // v145+：扫描件 OCR
    ocrCurrentPage: ocrCurrentPage,
    ocrBookRange: ocrBookRange
  };
})();
if (typeof window !== 'undefined' && typeof window.PDFReader === 'undefined') {
  try {
    // pdf-reader.js 顶部自执行函数捕获的变量名就叫 PDFReader
    window.PDFReader = PDFReader;
  } catch (e) {}
}
