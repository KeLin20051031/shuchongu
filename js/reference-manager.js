// Reference Manager 模块（P2 重写版）
// 功能：
//   1. IndexedDB 原始文件仓库（rm_blobs）：保存 File/Blob 原件，避免 base64 爆 localStorage
//   2. 多格式解析器分发（按优先级匹配库可用性）：
//       - TXT/MD/CSV → 直读
//       - DOCX     → mammoth.js（UMD，挂载 window.mammoth）；不存在 → 兜底 server.py anydoc
//       - XLSX/XLS  → SheetJS xlsx.full.min.js（window.XLSX）；不存在 → 兜底 anydoc
//       - PDF      → PDF.js（window.pdfjsLib，lib/pdfjs/）；不存在 → 兜底 anydoc
//       - 图片（png/jpg/webp/bmp/tiff）→ 嵌入 base64 + 建议用户让 AI OCR
//       - 其他      → server.py /api/convert（anydoc 兜底）
//   3. UI：index.html 中 referenceManagerModal 渲染（上传、列表、预览、导入笔记、批量删除）
//   4. 数据：
//       - 元数据（id/bookId/name/type/size/md/parsedAt/chars/pages/...）存 DataLayer.putReferenceMat / getReferenceByBook
//       - 原始文件 Blob 存 IndexedDB rm_blobs（按 matId 键）
const ReferenceManager = (function () {
  'use strict';

  var DB_NAME = 'SCG_ReferenceBlobs';
  var DB_VER = 1;
  var STORE = 'blobs';
  var dbPromise = null;

  // ===================== IndexedDB 原始文件仓库 =====================
  function _db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      try {
        var idb = (typeof indexedDB !== 'undefined') ? indexedDB : (window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB);
        if (!idb) return reject(new Error('IndexedDB 不可用'));
        var req = idb.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
      } catch (e) { reject(e); }
    });
    return dbPromise;
  }

  function _blobPut(id, blob, meta) {
    return _db().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          var st = tx.objectStore(STORE);
          st.put({ id: id, blob: blob, meta: meta || null, savedAt: Date.now() });
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error || new Error('blob put failed')); };
        } catch (e) { reject(e); }
      });
    });
  }
  function _blobGet(id) {
    return _db().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(STORE, 'readonly');
          var st = tx.objectStore(STORE);
          var r = st.get(id);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { reject(r.error || new Error('blob get failed')); };
        } catch (e) { reject(e); }
      });
    });
  }
  function _blobDelete(ids) {
    if (!ids || !ids.length) return Promise.resolve(true);
    return _db().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          var st = tx.objectStore(STORE);
          for (var i = 0; i < ids.length; i++) st.delete(ids[i]);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error || new Error('blob delete failed')); };
        } catch (e) { reject(e); }
      });
    });
  }

  // ===================== 工具函数 =====================
  function _genId() { return 'rm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }

  function _resolveBookId() {
    try {
      if (typeof Notebook !== 'undefined' && Notebook.getNotebook) {
        var nb = Notebook.getNotebook();
        if (nb && (nb.pdfId || nb.bookId)) return nb.pdfId || nb.bookId;
      }
    } catch (e) { /* ignore */ }
    // 兼容：app-shell 当前选中的 bookId
    try {
      if (typeof window !== 'undefined' && window.__curBookId) return window.__curBookId;
    } catch (e) { /* ignore */ }
    return null;
  }

  function _sourceType(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : 'bin';
  }
  function _typeCategory(ext) {
    ext = (ext || '').toLowerCase();
    if (ext === 'md' || ext === 'markdown') return 'md';
    if (ext === 'txt' || ext === 'text' || ext === 'log') return 'txt';
    if (ext === 'docx') return 'docx';
    if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') return 'xlsx';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (ext === 'pdf') return 'pdf';
    if (/^(png|jpe?g|webp|gif|bmp|tiff?|svg)$/.test(ext)) return 'image';
    if (ext === 'json' || ext === 'xml' || ext === 'yaml' || ext === 'yml' || ext === 'ini' || ext === 'cfg') return 'txt';
    return 'other';
  }
  function _fmtSize(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + 'B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'KB';
    return (b / (1024 * 1024)).toFixed(2) + 'MB';
  }
  function _ts(ms) {
    try { return new Date(ms).toLocaleString(); } catch (_) { return String(ms); }
  }
  function _escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _readFileAsText(file, enc) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      try { fr.readAsText(file, enc || 'utf-8'); }
      catch (e) { reject(e); }
    });
  }
  function _readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function _fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var dataUrl = String(fr.result || '');
        var idx = dataUrl.indexOf(',');
        resolve(idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl);
      };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  // ===================== 解析器 =====================
  function _parseMdOrTxt(file) { return _readFileAsText(file); }

  function _parseCsv(file) {
    return _readFileAsText(file).then(function (t) {
      // 简单 CSV → MD table（无引号嵌套场景 + 含引号容错）
      var lines = String(t || '').replace(/\r\n?/g, '\n').split('\n');
      var rows = [];
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!ln.trim()) continue;
        var cells = [], cur = '', inQ = false;
        for (var j = 0; j < ln.length; j++) {
          var c = ln[j];
          if (inQ) {
            if (c === '"') {
              if (ln[j + 1] === '"') { cur += '"'; j++; }
              else inQ = false;
            } else cur += c;
          } else {
            if (c === '"') inQ = true;
            else if (c === ',') { cells.push(cur); cur = ''; }
            else cur += c;
          }
        }
        cells.push(cur);
        rows.push(cells);
      }
      if (!rows.length) return '';
      var cols = 0;
      for (var k = 0; k < rows.length; k++) if (rows[k].length > cols) cols = rows[k].length;
      var pad = function (r) { while (r.length < cols) r.push(''); return r; };
      rows = rows.map(pad);
      var esc = function (x) { return String(x || '').replace(/\|/g, '\\|'); };
      var head = '| ' + rows[0].map(esc).join(' | ') + ' |';
      var sep  = '| ' + (new Array(cols)).fill('---').join(' | ') + ' |';
      var body = rows.slice(1).map(function (r) { return '| ' + r.map(esc).join(' | ') + ' |'; }).join('\n');
      return ['# CSV 转换（' + (file && file.name ? file.name : '') + '）', '', head, sep, body].join('\n');
    });
  }

  function _parseDocx(file) {
    if (typeof window !== 'undefined' && window.mammoth && typeof window.mammoth.convertToMarkdown === 'function') {
      return _readFileAsArrayBuffer(file).then(function (buf) {
        return window.mammoth.convertToMarkdown({ arrayBuffer: buf }).then(function (r) {
          var warnings = '';
          if (r && Array.isArray(r.messages) && r.messages.length) {
            warnings = '\n\n<!-- Mammoth warnings: ' + r.messages.map(function (m) { return (m && m.message) || ''; }).filter(Boolean).join('; ') + ' -->';
          }
          return '# ' + (file.name || 'DOCX 文档') + '\n\n' + (r && r.value ? String(r.value) : '') + warnings;
        });
      });
    }
    return Promise.reject(new Error('Mammoth 未加载'));
  }

  function _parseXlsx(file) {
    if (typeof window !== 'undefined' && window.XLSX && typeof window.XLSX.read === 'function' && typeof window.XLSX.utils.sheet_to_markdown === 'function') {
      return _readFileAsArrayBuffer(file).then(function (buf) {
        var wb = window.XLSX.read(buf, { type: 'array' });
        var sheets = wb && wb.SheetNames ? wb.SheetNames : [];
        if (!sheets.length) return '';
        var parts = ['# ' + (file.name || 'XLSX 工作簿') + ''];
        for (var i = 0; i < sheets.length; i++) {
          var sn = sheets[i];
          var sh = wb.Sheets[sn];
          parts.push('', '## 工作表：' + sn, '');
          try {
            var md = window.XLSX.utils.sheet_to_markdown(sh, { origin: 'A1' });
            parts.push(md || '_（空工作表）_');
          } catch (e) {
            parts.push('_解析失败：' + _escapeHtml(e && e.message ? e.message : e) + '_');
          }
        }
        return parts.join('\n');
      });
    }
    return Promise.reject(new Error('SheetJS 未加载'));
  }

  function _parsePdf(file) {
    if (typeof window !== 'undefined' && window.pdfjsLib && typeof window.pdfjsLib.getDocument === 'function') {
      return _readFileAsArrayBuffer(file).then(function (buf) {
        var task = window.pdfjsLib.getDocument({ data: buf });
        return (task.promise || task).then(function (doc) {
          var pages = [];
          var total = doc.numPages || 0;
          var chain = Promise.resolve();
          for (var p = 1; p <= total; p++) {
            (function (pn) {
              chain = chain.then(function () {
                return doc.getPage(pn).then(function (page) {
                  return page.getTextContent().then(function (tc) {
                    var lines = [];
                    var lastY = null;
                    var items = (tc && tc.items) ? tc.items : [];
                    for (var i = 0; i < items.length; i++) {
                      var it = items[i] || {};
                      var y = (it.transform && it.transform[5]) ? it.transform[5] : 0;
                      if (lastY != null && Math.abs(y - lastY) > 2) lines.push('');
                      lines.push(String(it.str || ''));
                      lastY = y;
                    }
                    pages.push('### 第 ' + pn + ' 页\n\n' + lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
                  });
                });
              });
            })(p);
          }
          return chain.then(function () {
            return '# ' + (file.name || 'PDF 文档') + '\n> 页数：' + total + '\n\n---\n\n' + pages.join('\n\n---\n\n');
          });
        });
      });
    }
    return Promise.reject(new Error('PDF.js 未加载'));
  }

  function _parseImage(file) {
    return _fileToBase64(file).then(function (b64) {
      var ext = _sourceType(file.name || 'image');
      var mime = (file && file.type) || ('image/' + ext);
      return '# ' + (file.name || '图片') + '\n\n> 图片型参考资料：AI 可在提问时识别图像内容（建议使用支持视觉的模型）。\n\n![参考图片：' + _escapeHtml(file.name || 'image') + '](data:' + mime + ';base64,' + b64 + ')\n\n### 元信息\n- 原始文件名：`' + _escapeHtml(file.name || '') + '`\n- MIME：`' + _escapeHtml(mime) + '`\n- 大小：' + _fmtSize(file && file.size) + '\n';
    });
  }

  // 在线版（部署到静态托管）无 server.py，/api/convert 不可用 → 直接给出友好提示
  function _isLocalHost() {
    try {
      var h = (typeof location !== 'undefined' && location.hostname) || '';
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /\.local$/.test(h);
    } catch (e) { return false; }
  }

  function _convertViaServer(file) {
    if (typeof fetch === 'undefined') return Promise.reject(new Error('fetch 不可用'));
    if (!_isLocalHost()) {
      return Promise.reject(new Error('在线版未提供服务器转换服务，请改用支持的格式（TXT/MD/CSV/DOCX/XLSX/PDF/图片）'));
    }
    return _fileToBase64(file).then(function (base64) {
      return fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data: base64 })
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().catch(function () { return ''; }).then(function (t) {
            throw new Error('转换服务返回 ' + resp.status + (t ? '：' + t : ''));
          });
        }
        return resp.json();
      }).then(function (r) {
        if (!r || r.ok !== true) throw new Error((r && r.error) || '转换失败');
        return r.md || '';
      });
    });
  }

  function _parseAny(file) {
    var cat = _typeCategory(_sourceType(file.name));
    if (cat === 'md' || cat === 'txt') return _parseMdOrTxt(file);
    if (cat === 'csv') return _parseCsv(file);
    if (cat === 'docx') return _parseDocx(file).catch(function () { return _convertViaServer(file); });
    if (cat === 'xlsx') return _parseXlsx(file).catch(function () { return _convertViaServer(file); });
    if (cat === 'pdf')  return _parsePdf(file).catch(function () { return _convertViaServer(file); });
    if (cat === 'image') return _parseImage(file).catch(function () { return _convertViaServer(file); });
    // 其他（pptx/epub/…）先走 anydoc，失败返回占位
    return _convertViaServer(file).catch(function (e) {
      var ext = _sourceType(file.name);
      var isLocal = false;
      try { isLocal = _isLocalHost(); } catch (e2) {}
      var hint = isLocal
        ? '\n>\n> **可选择以下任一方式继续：**\n> 1. 启动 `server.py`（提供 `/api/convert` 接口，anydoc 会把 PPTX/EPUB/扫描件 PDF 都转成 MD）；\n> 2. 预先用外部工具转成 MD/DOCX/PDF 再导入；\n> 3. 直接上传 TXT/MD 纯文本。'
        : '\n>\n> **在线版提示：** 该格式（.' + ext + '）当前不支持直接解析，请先用外部工具转成 MD/TXT/DOCX/PDF 再导入。';
      return '# ' + (file.name || '参考资料') + '\n\n> 该格式（.' + ext + '）当前未被前端解析器支持。' + hint + '\n\n### 解析器原始错误\n```\n' + _escapeHtml((e && e.message) ? e.message : String(e)) + '\n```\n';
    });
  }

  // ===================== CRUD（对外） =====================
  async function importFile(file, bookId) {
    if (!file) throw new Error('未提供文件');
    bookId = bookId || _resolveBookId();
    if (!bookId) throw new Error('无法识别当前教材，请先打开一本教材后再导入参考材料');
    var ext = _sourceType(file.name);
    var cat = _typeCategory(ext);

    var id = _genId();
    var md = '';
    var err = null;
    var parser = 'unknown';
    var pages = null;
    try {
      md = await _parseAny(file);
      parser = cat + ':' + (cat === 'md' || cat === 'txt' ? 'direct'
                         : cat === 'csv' ? 'csv'
                         : cat === 'docx' ? (window.mammoth ? 'mammoth' : 'anydoc')
                         : cat === 'xlsx' ? (window.XLSX ? 'sheetjs' : 'anydoc')
                         : cat === 'pdf'  ? (window.pdfjsLib ? 'pdfjs' : 'anydoc')
                         : cat === 'image' ? 'image'
                         : 'anydoc');
      if (cat === 'pdf' && window.pdfjsLib) {
        try {
          var doc = await (window.pdfjsLib.getDocument({ data: await _readFileAsArrayBuffer(file) }).promise);
          pages = doc.numPages || 0;
        } catch (_) { pages = null; }
      }
    } catch (e) {
      err = e && e.message ? e.message : String(e);
      md = '# ' + _escapeHtml(file.name || '参考资料') + '\n\n> **解析失败：** ' + _escapeHtml(err) + '\n';
    }

    var mat = {
      id: id,
      bookId: bookId,
      name: file.name || '参考材料',
      sourceType: ext,
      typeCategory: cat,
      size: Number(file.size) || 0,
      mime: (file.type || ''),
      md: String(md || ''),
      chars: String(md || '').length,
      pages: pages,
      parser: parser,
      parseError: err || null,
      createdAt: Date.now(),
      parsedAt: Date.now()
    };
    if (typeof DataLayer !== 'undefined' && DataLayer.putReferenceMat) {
      await DataLayer.putReferenceMat(mat);
    } else {
      // 退化：localStorage 兜底
      var k = 'scg:refs:' + bookId;
      var list = [];
      try { list = JSON.parse(localStorage.getItem(k) || '[]'); } catch (_) { list = []; }
      list.push(mat); localStorage.setItem(k, JSON.stringify(list));
    }
    try { await _blobPut(id, file.slice ? file.slice(0, file.size, file.type || 'application/octet-stream') : file, { name: file.name, type: file.type, size: file.size }); }
    catch (_) { /* ignore IndexedDB 存原件失败，至少 MD 已入库 */ }
    return mat;
  }

  function list(bookId) {
    if (!bookId) return Promise.resolve([]);
    if (typeof DataLayer !== 'undefined' && DataLayer.getReferenceByBook) {
      return Promise.resolve(DataLayer.getReferenceByBook(bookId)).catch(function () { return []; });
    }
    try {
      var k = 'scg:refs:' + bookId;
      var list = JSON.parse(localStorage.getItem(k) || '[]');
      return Promise.resolve(list);
    } catch (e) { return Promise.resolve([]); }
  }

  async function getMd(matId) {
    var mat = null;
    if (typeof DataLayer !== 'undefined' && DataLayer.get) {
      try { mat = await DataLayer.get('referenceMats', matId); } catch (_) { mat = null; }
    }
    return mat ? (mat.md || '') : '';
  }

  async function getByBook(bookId) {
    var mats = await list(bookId);
    if (!mats || !mats.length) return '';
    var parts = [];
    for (var i = 0; i < mats.length; i++) {
      var md = mats[i].md;
      if (md == null) try { md = await getMd(mats[i].id); } catch (_) { md = ''; }
      if (md && md.trim()) {
        parts.push('## 参考资料：' + (mats[i].name || mats[i].title || mats[i].id) + '\n\n' + String(md).trim());
      }
    }
    return parts.join('\n\n---\n\n');
  }

  async function remove(matIds) {
    matIds = Array.isArray(matIds) ? matIds : [matIds];
    if (!matIds.length) return true;
    var bookIds = {};
    for (var i = 0; i < matIds.length; i++) {
      var mid = matIds[i];
      if (typeof DataLayer !== 'undefined' && DataLayer.get) {
        try {
          var m = await DataLayer.get('referenceMats', mid);
          if (m && m.bookId) bookIds[m.bookId] = (bookIds[m.bookId] || []).concat([mid]);
          // 修复：使用正确的 API - DataLayer.delete 或 DataLayer.deleteReferenceMat
          if (typeof DataLayer.deleteReferenceMat === 'function') {
            await DataLayer.deleteReferenceMat(mid);
          } else if (typeof DataLayer.delete === 'function') {
            await DataLayer.delete('referenceMats', mid);
          }
        } catch (_) { /* ignore */ }
      } else {
        // 退化：localStorage 兜底
        try {
          var allKeys = Object.keys(localStorage || {}).filter(function (x) { return x.indexOf('scg:refs:') === 0; });
          for (var j = 0; j < allKeys.length; j++) {
            try {
              var arr = JSON.parse(localStorage.getItem(allKeys[j]) || '[]');
              var next = [];
              for (var ai = 0; ai < arr.length; ai++) if (matIds.indexOf(arr[ai].id) < 0) next.push(arr[ai]);
              localStorage.setItem(allKeys[j], JSON.stringify(next));
            } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore */ }
      }
    }
    try { await _blobDelete(matIds); } catch (_) { /* ignore */ }
    return true;
  }

  async function reparse(matId) {
    var blobObj = await _blobGet(matId);
    if (!blobObj) throw new Error('没有原始文件，无法重新解析');
    var meta = blobObj.meta || {};
    var fileLike = new File([blobObj.blob], meta.name || 'file', { type: meta.type || 'application/octet-stream' });
    var oldMat = null;
    if (typeof DataLayer !== 'undefined' && DataLayer.get) {
      try { oldMat = await DataLayer.get('referenceMats', matId); } catch (_) { oldMat = null; }
    }
    var ext = _sourceType(fileLike.name);
    var cat = _typeCategory(ext);
    var md = '', parser = '', err = null, pages = null;
    try {
      md = await _parseAny(fileLike);
      parser = cat + ':' + (cat === 'md' || cat === 'txt' ? 'direct'
                         : cat === 'csv' ? 'csv'
                         : cat === 'docx' ? (window.mammoth ? 'mammoth' : 'anydoc')
                         : cat === 'xlsx' ? (window.XLSX ? 'sheetjs' : 'anydoc')
                         : cat === 'pdf'  ? (window.pdfjsLib ? 'pdfjs' : 'anydoc')
                         : cat === 'image' ? 'image'
                         : 'anydoc');
    } catch (e) {
      err = e && e.message ? e.message : String(e);
      md = '# ' + _escapeHtml(fileLike.name || '参考资料') + '\n\n> **重新解析失败：** ' + _escapeHtml(err) + '\n';
    }
    var upd = Object.assign({}, oldMat || { id: matId, bookId: _resolveBookId() }, {
      name: fileLike.name || oldMat.name || '参考资料',
      sourceType: ext,
      typeCategory: cat,
      size: Number(fileLike.size) || Number(meta.size) || (oldMat && oldMat.size) || 0,
      mime: fileLike.type || meta.type || (oldMat && oldMat.mime) || '',
      md: String(md || ''),
      chars: String(md || '').length,
      pages: pages != null ? pages : (oldMat && oldMat.pages),
      parser: parser,
      parseError: err || null,
      parsedAt: Date.now()
    });
    if (typeof DataLayer !== 'undefined' && DataLayer.putReferenceMat) await DataLayer.putReferenceMat(upd);
    return upd;
  }

  function downloadMd(mat) {
    if (!mat) return;
    var md = String(mat.md || '');
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (mat.name || 'ref').replace(/\.[a-z0-9]+$/i, '') + '.md';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // ===================== UI 层 =====================
  var UI = {
    currentBookId: null,
    currentMat: null,
    checkedIds: {},
    searchKw: '',
    _loaded: false
  };

  function _status(msg, level) {
    var el = document.getElementById('rmStatusBar');
    if (!el) return;
    el.className = 'rm-status-bar' + (level ? ' rm-' + level : '');
    el.textContent = msg || '就绪';
  }
  function _renderMd(md) {
    var host = document.getElementById('rmPreviewMd');
    if (!host) return;
    try {
      var html = (typeof marked !== 'undefined' && marked.parse) ? marked.parse(String(md || ''))
               : '<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;">' + _escapeHtml(md || '') + '</pre>';
      host.innerHTML = html;
    } catch (e) {
      host.innerHTML = '<div style="color:#b03a2e;">渲染失败：' + _escapeHtml(e && e.message ? e.message : e) + '</div><pre>' + _escapeHtml(md || '') + '</pre>';
    }
  }
  function _renderMeta(mat) {
    var host = document.getElementById('rmPreviewMeta');
    if (!host) return;
    if (!mat) { host.innerHTML = ''; return; }
    var rows = [
      ['文件名', _escapeHtml(mat.name || '')],
      ['ID', '<code>' + _escapeHtml(mat.id || '') + '</code>'],
      ['所属教材 ID', '<code>' + _escapeHtml(mat.bookId || '') + '</code>'],
      ['格式', (mat.sourceType || '') + ' / ' + (mat.typeCategory || '')],
      ['大小', _fmtSize(mat.size)],
      ['MD 字数', (mat.chars != null ? mat.chars : String(mat.md || '').length) + ' 字'],
      ['解析器', '<code>' + _escapeHtml(mat.parser || '') + '</code>'],
      ['PDF 页数', mat.pages ? (mat.pages + ' 页') : '-'],
      ['创建时间', _ts(mat.createdAt)],
      ['最近解析', _ts(mat.parsedAt || mat.createdAt)],
      ['错误信息', mat.parseError ? ('<span style="color:#b03a2e;">' + _escapeHtml(mat.parseError) + '</span>') : '-']
    ];
    host.innerHTML = '<table>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</table>';
  }

  function _typeClass(cat) {
    switch (cat) {
      case 'md': return 'rm-type-md';
      case 'txt': return 'rm-type-txt';
      case 'docx': return 'rm-type-docx';
      case 'xlsx': case 'csv': return 'rm-type-xlsx';
      case 'pdf': return 'rm-type-pdf';
      case 'image': return 'rm-type-image';
      default: return 'rm-type-other';
    }
  }

  async function _renderList() {
    var host = document.getElementById('rmFileList');
    if (!host) return;
    var mats = (await list(UI.currentBookId)) || [];
    // 排序：最新在上
    mats.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    var kw = String(UI.searchKw || '').trim().toLowerCase();
    if (kw) mats = mats.filter(function (m) { return (m.name || '').toLowerCase().indexOf(kw) >= 0; });
    if (!mats.length) {
      host.innerHTML = '<div class="rm-empty">暂无参考资料<br><span style="font-size:11px;">把文件拖到上方上传区，或点击选择文件开始导入</span></div>';
      UI.currentMat = null;
      _renderPreview();
      return;
    }
    var curId = UI.currentMat && UI.currentMat.id;
    var html = mats.map(function (m) {
      var active = (m.id === curId) ? ' rm-active' : '';
      var checked = UI.checkedIds[m.id] ? ' checked' : '';
      var cat = m.typeCategory || _typeCategory(m.sourceType);
      return '<div class="rm-item' + active + '" data-id="' + _escapeHtml(m.id) + '" title="' + _escapeHtml(m.name || '') + '">'
        + '<input type="checkbox" class="rm-item-check" data-check="' + _escapeHtml(m.id) + '"' + checked + '>'
        + '<div>'
        + '<div class="rm-item-name">' + _escapeHtml(m.name || '') + '</div>'
        + '<div class="rm-item-meta">'
        + '<span class="rm-item-type ' + _typeClass(cat) + '">' + (m.sourceType || '?').toUpperCase() + '</span>'
        + '<span class="rm-item-size">' + _fmtSize(m.size) + '</span>'
        + (m.chars != null ? '<span>📝 ' + (m.chars >= 10000 ? (m.chars / 1000).toFixed(1) + 'k' : m.chars) + '字</span>' : '')
        + '</div></div>'
        + '<div style="font-size:10px;color:#8a7f6e;justify-self:end;">' + (new Date(m.createdAt || 0)).toLocaleDateString() + '</div>'
        + '</div>';
    }).join('');
    host.innerHTML = html;
    host.querySelectorAll('.rm-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('rm-item-check')) return;
        var id = el.getAttribute('data-id');
        var found = mats.filter(function (x) { return x.id === id; })[0] || null;
        UI.currentMat = found;
        _renderPreview();
        _renderList();
      });
    });
    host.querySelectorAll('.rm-item-check').forEach(function (cb) {
      cb.addEventListener('change', function (e) {
        e.stopPropagation();
        var id = cb.getAttribute('data-check');
        if (cb.checked) UI.checkedIds[id] = true; else delete UI.checkedIds[id];
      });
    });
    _renderPreview();
  }

  function _renderPreview() {
    var title = document.getElementById('rmPreviewTitle');
    var btns = ['btnRmRefreshMd','btnRmDownloadMd','btnRmInsertNote','btnRmDeleteOne'];
    btns.forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = UI.currentMat ? '' : 'none'; });
    if (!UI.currentMat) {
      if (title) title.textContent = '← 从左侧选择文件';
      _renderMd('');
      _renderMeta(null);
      return;
    }
    if (title) title.textContent = UI.currentMat.name || '-';
    var mdTab = document.querySelector('.rm-ptab[data-ptab="md"]');
    if (mdTab && mdTab.classList.contains('rm-ptab-active')) _renderMd(UI.currentMat.md || '');
    _renderMeta(UI.currentMat);
  }

  async function _handleFiles(files) {
    if (!UI.currentBookId) { alert('请先打开一本教材再导入参考材料'); return; }
    var arr = [];
    for (var i = 0; i < files.length; i++) arr.push(files[i]);
    if (!arr.length) return;
    var ok = 0, fail = 0;
    _status('正在解析 ' + arr.length + ' 个文件…', 'info');
    for (var j = 0; j < arr.length; j++) {
      var f = arr[j];
      try {
        await importFile(f, UI.currentBookId);
        ok++;
        _status('已导入 ' + ok + '/' + arr.length + '：' + f.name, 'info');
      } catch (e) {
        fail++;
        console.error('[ReferenceManager] import failed for', f && f.name, e);
      }
    }
    _status('完成：成功 ' + ok + ' 个，失败 ' + fail + ' 个', fail > 0 ? 'error' : 'info');
    UI.currentMat = null;
    await _renderList();
  }

  function openModal() {
    UI.currentBookId = _resolveBookId();
    var modal = document.getElementById('referenceManagerModal');
    if (!modal) { alert('参考资料管理器 DOM 未找到'); return; }
    var bookHint = document.getElementById('rmCurBookHint');
    if (bookHint) {
      if (UI.currentBookId) {
        var bookName = null;
        try { if (typeof Notebook !== 'undefined' && Notebook.getNotebook) { var nb = Notebook.getNotebook(); bookName = nb && nb.name; } } catch (_) {}
        bookHint.textContent = '当前教材：' + (bookName ? bookName + ' · ' : '') + UI.currentBookId;
      } else {
        bookHint.textContent = '当前教材：未选择（请先打开一本教材）';
      }
    }
    modal.style.display = 'block';
    if (!UI._loaded) _bindEvents();
    UI.currentMat = null;
    UI.checkedIds = {};
    UI.searchKw = '';
    var si = document.getElementById('rmSearchInput'); if (si) si.value = '';
    var tabs = document.querySelectorAll('.rm-ptab');
    tabs.forEach(function (t) { t.classList.toggle('rm-ptab-active', (t.getAttribute('data-ptab') === 'md')); });
    var mdPane = document.getElementById('rmPreviewMd'), metaPane = document.getElementById('rmPreviewMeta');
    if (mdPane) mdPane.style.display = '';
    if (metaPane) metaPane.style.display = 'none';
    _status('就绪');
    _renderList();
  }

  function closeModal() {
    var m = document.getElementById('referenceManagerModal'); if (m) m.style.display = 'none';
  }

  function _switchPreviewTab(key) {
    var tabs = document.querySelectorAll('.rm-ptab');
    tabs.forEach(function (t) { t.classList.toggle('rm-ptab-active', (t.getAttribute('data-ptab') === key)); });
    var mdPane = document.getElementById('rmPreviewMd'), metaPane = document.getElementById('rmPreviewMeta');
    if (mdPane) mdPane.style.display = (key === 'md') ? '' : 'none';
    if (metaPane) metaPane.style.display = (key === 'meta') ? '' : 'none';
    if (key === 'md' && UI.currentMat) _renderMd(UI.currentMat.md || '');
    if (key === 'meta') _renderMeta(UI.currentMat);
  }

  function _bindEvents() {
    UI._loaded = true;
    var uploader = document.getElementById('rmUploader');
    var fileInput = document.getElementById('rmFileInput');
    var closeBtn = document.getElementById('btnCloseRm');
    var searchInput = document.getElementById('rmSearchInput');
    var bulkDelete = document.getElementById('btnRmBulkDelete');
    var refreshMd = document.getElementById('btnRmRefreshMd');
    var downloadMd = document.getElementById('btnRmDownloadMd');
    var insertNote = document.getElementById('btnRmInsertNote');
    var deleteOne = document.getElementById('btnRmDeleteOne');
    var pTabs = document.querySelectorAll('.rm-ptab');

    if (uploader) {
      uploader.addEventListener('click', function () { if (fileInput) fileInput.click(); });
      uploader.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (fileInput) fileInput.click(); }
      });
      ['dragenter','dragover'].forEach(function (ev) {
        uploader.addEventListener(ev, function (e) { e.preventDefault(); uploader.classList.add('dragover'); });
      });
      ['dragleave','drop'].forEach(function (ev) {
        uploader.addEventListener(ev, function (e) { e.preventDefault(); uploader.classList.remove('dragover'); });
      });
      uploader.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) _handleFiles(e.dataTransfer.files);
      });
    }
    if (fileInput) fileInput.addEventListener('change', function () { if (fileInput.files && fileInput.files.length) _handleFiles(fileInput.files); fileInput.value = ''; });
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (searchInput) searchInput.addEventListener('input', function () { UI.searchKw = searchInput.value || ''; _renderList(); });
    if (bulkDelete) bulkDelete.addEventListener('click', async function () {
      var ids = Object.keys(UI.checkedIds || {});
      if (!ids.length) { alert('请先勾选要删除的文件'); return; }
      if (!confirm('确认删除所选的 ' + ids.length + ' 份参考资料？（MD 与原件都会删除）')) return;
      await remove(ids);
      UI.checkedIds = {};
      if (UI.currentMat && ids.indexOf(UI.currentMat.id) >= 0) UI.currentMat = null;
      _status('已删除 ' + ids.length + ' 份资料', 'info');
      await _renderList();
    });
    if (refreshMd) refreshMd.addEventListener('click', async function () {
      if (!UI.currentMat) return;
      _status('重新解析中…', 'info');
      try {
        var upd = await reparse(UI.currentMat.id);
        UI.currentMat = upd;
        _status('重新解析完成：字数 ' + (upd.chars || 0), 'info');
        await _renderList();
      } catch (e) {
        _status('重新解析失败：' + (e && e.message ? e.message : e), 'error');
      }
    });
    if (downloadMd) downloadMd.addEventListener('click', function () { if (UI.currentMat) downloadMd(UI.currentMat); });
    if (deleteOne) deleteOne.addEventListener('click', async function () {
      if (!UI.currentMat) return;
      if (!confirm('确认删除该参考资料？（MD 与原件都会删除）')) return;
      var id = UI.currentMat.id;
      await remove([id]);
      if (UI.checkedIds[id]) delete UI.checkedIds[id];
      UI.currentMat = null;
      _status('已删除', 'info');
      await _renderList();
    });
    if (insertNote) insertNote.addEventListener('click', function () {
      if (!UI.currentMat) { alert('请先选择一个参考资料'); return; }
      var mat = UI.currentMat;
      var mdText = String(mat.md || '');
      if (!mdText.trim()) { alert('该参考资料还没有可导入的 MD 内容'); return; }
      try {
        if (typeof Notebook !== 'undefined' && typeof Notebook.insertReferenceIntoCurrentPage === 'function') {
          Notebook.insertReferenceIntoCurrentPage(mat, mdText);
          _status('已导入到当前笔记', 'info');
          return;
        }
        // 兼容：直接在当前笔记页 md 末尾 append，走 applyEdit ops
        if (typeof AIEngine !== 'undefined' && typeof AIEngine.appendReferenceToCurrentPage === 'function') {
          AIEngine.appendReferenceToCurrentPage(mat, mdText).then(function (r) { _status('已导入到当前笔记', 'info'); }).catch(function (e) {
            _status('导入失败：' + (e && e.message ? e.message : e), 'error');
          });
          return;
        }
      } catch (e) { /* ignore */ }
      // 兜底：打开导入对话框让用户手动粘贴
      var w = window.open('', '_blank', 'width=760,height=600');
      if (w) {
        w.document.write('<title>' + _escapeHtml(mat.name || 'ref') + '</title>'
          + '<style>body{font-family:Microsoft YaHei,sans-serif;padding:18px;}textarea{width:100%;height:460px;}h3{margin:0 0 10px;}p{color:#555;}</style>'
          + '<h3>📥 请手动复制到笔记：' + _escapeHtml(mat.name || '') + '</h3>'
          + '<p>当前运行环境没有暴露写入笔记的 API（Notebook/AIEngine 未加载或不兼容）。<br>请复制下方 MD → 切回书虫蛊笔记页 → 粘贴到目标位置。</p>'
          + '<textarea readonly>' + _escapeHtml(mdText) + '</textarea>');
        w.document.close();
      } else {
        alert('浏览器阻止了新窗口；手动导入请在参考资料 MD 预览区全选复制。');
      }
    });
    pTabs.forEach(function (t) {
      t.addEventListener('click', function () { _switchPreviewTab(t.getAttribute('data-ptab') || 'md'); });
    });

    // 点击模态框空白处关闭
    var modal = document.getElementById('referenceManagerModal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeModal();
      });
    }
    // Esc 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && modal.style.display !== 'none') closeModal();
    });
  }

  return {
    import: importFile,
    list: list,
    getMd: getMd,
    getByBook: getByBook,
    remove: remove,
    reparse: reparse,
    downloadMd: downloadMd,
    // UI
    openModal: openModal,
    closeModal: closeModal
  };
})();
if (typeof window !== 'undefined') window.ReferenceManager = ReferenceManager;
