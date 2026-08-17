// 书虫蛊 · 教材文件管理系统
// 功能：教材书架（导入/删除/重命名/收藏/分类）、搜索、最近阅读、进度追踪
// 数据：IndexedDB — books(元数据) + bookblobs(PDF二进制)
const FileManager = (function() {
  'use strict';

  var shelfEl = null;
  var onOpenBookCallback = null;
  var currentFilter = 'all';   // all | recent | favorite | category:xxx
  var searchKeyword = '';

  // 生成确定性封面色（根据书名哈希，形成书架视觉多样性）
  function _coverColor(name) {
    var palette = [
      ['#5d4037', '#8d6e63'], ['#2e4a35', '#4f7a5f'], ['#1f3a5f', '#3d6b9e'],
      ['#6b2d3c', '#a05062'], ['#3c2f63', '#6a57a3'], ['#5c3a1e', '#8a5f35'],
      ['#274a4a', '#3f7a78'], ['#4a2e5c', '#7a55a3']
    ];
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  // ---------- 数据操作 ----------

  function importBook(file) {
    return new Promise(function(resolve, reject) {
      if (!file) { reject(new Error('未选择文件')); return; }
      if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        reject(new Error('仅支持 PDF 文件'));
        return;
      }
      if (file.size === 0) {
        reject(new Error('文件为空，无法导入'));
        return;
      }
      var id = 'book_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      var name = file.name.replace(/\.pdf$/i, '');
      file.arrayBuffer().then(function(buf) {
        // 轻量预校验：PDF 文件头魔数应为 %PDF（避免明显无效的文件进书架误导用户）
        try {
          var head = new Uint8Array(buf.slice(0, 5));
          var sig = '';
          for (var i = 0; i < head.length; i++) sig += String.fromCharCode(head[i]);
          if (sig.indexOf('%PDF') !== 0) {
            reject(new Error('文件不是有效的 PDF（缺少 %PDF 文件头），请确认文件未损坏或重新导出后再导入。'));
            return;
          }
        } catch (e) { /* 校验异常不阻塞，交给后续解析流程 */ }
        var meta = {
          id: id, name: name, fileName: file.name, size: file.size,
          addedAt: Date.now(), lastOpenedAt: 0, favorite: false,
          category: '默认', pageProgress: 1, pageCount: 0
        };
        return Promise.all([
          DataLayer.put('books', meta),
          DataLayer.put('bookblobs', { id: id, data: buf })
        ]).then(function() {
          resolve(meta);
        }).catch(function(e) {
          // 存储失败：通常是 IndexedDB 不可用（file:// 双击打开 / 浏览器禁用本地存储）
          var msg = (e && e.message) ? e.message : String(e);
          reject(new Error('保存教材失败：' + msg));
        });
      }).catch(function(e) {
        if (e && e.message && /不是有效的 PDF|保存教材失败/.test(e.message)) { reject(e); return; }
        reject(new Error('读取文件失败：' + (e && e.message ? e.message : e)));
      });
    });
  }

  function getAllBooks() {
    return DataLayer.getAll('books');
  }

  function getBook(id) {
    return DataLayer.get('books', id);
  }

  function getBookBlob(id) {
    return DataLayer.get('bookblobs', id);
  }

  function deleteBook(id) {
    return Promise.all([
      DataLayer.delete('books', id),
      DataLayer.delete('bookblobs', id)
    ]);
  }

  function renameBook(id, newName) {
    return DataLayer.get('books', id).then(function(meta) {
      if (!meta) return null;
      meta.name = newName;
      return DataLayer.put('books', meta).then(function() { return meta; });
    });
  }

  function toggleFavorite(id) {
    return DataLayer.get('books', id).then(function(meta) {
      if (!meta) return null;
      meta.favorite = !meta.favorite;
      return DataLayer.put('books', meta).then(function() { return meta; });
    });
  }

  function setCategory(id, category) {
    return DataLayer.get('books', id).then(function(meta) {
      if (!meta) return null;
      meta.category = category || '默认';
      return DataLayer.put('books', meta).then(function() { return meta; });
    });
  }

  // 记录打开并更新阅读进度
  function touchOpened(id, pageNum, pageCount) {
    return DataLayer.get('books', id).then(function(meta) {
      if (!meta) return null;
      meta.lastOpenedAt = Date.now();
      if (pageNum) meta.pageProgress = pageNum;
      if (pageCount) meta.pageCount = pageCount;
      return DataLayer.put('books', meta).then(function() { return meta; });
    });
  }

  // ---------- 查询 ----------

  function searchBooks(keyword) {
    var kw = (keyword || '').trim().toLowerCase();
    return getAllBooks().then(function(books) {
      if (!kw) return books;
      return books.filter(function(b) {
        return b.name.toLowerCase().indexOf(kw) >= 0 ||
               (b.category || '').toLowerCase().indexOf(kw) >= 0;
      });
    });
  }

  function getRecentBooks(limit) {
    return getAllBooks().then(function(books) {
      return books
        .filter(function(b) { return b.lastOpenedAt > 0; })
        .sort(function(a, b) { return b.lastOpenedAt - a.lastOpenedAt; })
        .slice(0, limit || 8);
    });
  }

  function getAllCategories() {
    return getAllBooks().then(function(books) {
      var set = {};
      books.forEach(function(b) { if (b.category) set[b.category] = true; });
      return Object.keys(set).sort();
    });
  }

  // ---------- 书架渲染 ----------

  function init(container, opts) {
    shelfEl = container;
    if (opts && typeof opts.onOpenBook === 'function') onOpenBookCallback = opts.onOpenBook;
    render();
  }

  function render() {
    if (!shelfEl) return;
    searchBooks(searchKeyword).then(function(books) {
      var filtered = _applyFilter(books, currentFilter);
      _drawShelf(filtered);
      _drawCategories();
    });
  }

  function _applyFilter(books, filter) {
    if (filter === 'all') return books;
    if (filter === 'recent') {
      return books.filter(function(b) { return b.lastOpenedAt > 0; })
        .sort(function(a, b) { return b.lastOpenedAt - a.lastOpenedAt; });
    }
    if (filter === 'favorite') return books.filter(function(b) { return b.favorite; });
    if (filter.indexOf('category:') === 0) {
      var c = filter.slice(9);
      return books.filter(function(b) { return b.category === c; });
    }
    return books;
  }

  function _drawShelf(books) {
    if (!shelfEl) return;
    if (!books || books.length === 0) {
      shelfEl.innerHTML =
        '<div class="shelf-empty">' +
        '<div class="shelf-empty-icon">📚</div>' +
        '<p>书架上还没有教材</p>' +
        '<p class="shelf-empty-hint">点击「导入教材」或把 PDF 拖到这里</p>' +
        '</div>';
      return;
    }
    var html = books.map(function(b) {
      var colors = _coverColor(b.name);
      var dateStr = b.lastOpenedAt ? _fmtDate(b.lastOpenedAt) : '未阅读';
      var progress = b.pageCount > 0
        ? Math.min(100, Math.round((b.pageProgress || 0) / b.pageCount * 100))
        : 0;
      var favBadge = b.favorite ? '<span class="book-fav-badge">★</span>' : '';
      return '' +
        '<div class="book-card" data-book-id="' + b.id + '">' +
          '<div class="book-cover" style="background:linear-gradient(145deg,' + colors[0] + ',' + colors[1] + ');">' +
            '<div class="book-cover-title">' + _esc(b.name) + '</div>' +
            '<div class="book-cover-deco"></div>' +
            favBadge +
          '</div>' +
          '<div class="book-meta">' +
            '<div class="book-name" title="' + _esc(b.name) + '">' + _esc(b.name) + '</div>' +
            '<div class="book-sub">' + _esc(b.category || '默认') + ' · ' + dateStr + '</div>' +
            (b.pageCount > 0
              ? '<div class="book-progress"><div class="book-progress-bar" style="width:' + progress + '%"></div></div>'
              : '') +
          '</div>' +
          '<div class="book-actions">' +
            '<button class="book-action" data-act="open" title="打开阅读">📖</button>' +
            '<button class="book-action" data-act="fav" title="收藏">' + (b.favorite ? '💛' : '🤍') + '</button>' +
            '<button class="book-action" data-act="rename" title="重命名">✏️</button>' +
            '<button class="book-action" data-act="del" title="删除">🗑</button>' +
          '</div>' +
        '</div>';
    }).join('');
    shelfEl.innerHTML =
      '<div class="shelf-grid">' + html + '</div>' +
      '<div class="shelf-count">共 ' + books.length + ' 本教材</div>';
    _bindShelfEvents();
  }

  function _drawCategories() {
    var bar = document.getElementById('shelfCategories');
    if (!bar) return;
    getAllCategories().then(function(cats) {
      var html =
        '<button class="cat-chip' + (currentFilter === 'all' ? ' active' : '') + '" data-filter="all">全部</button>' +
        '<button class="cat-chip' + (currentFilter === 'recent' ? ' active' : '') + '" data-filter="recent">最近阅读</button>' +
        '<button class="cat-chip' + (currentFilter === 'favorite' ? ' active' : '') + '" data-filter="favorite">收藏</button>';
      cats.forEach(function(c) {
        html += '<button class="cat-chip' + (currentFilter === 'category:' + c ? ' active' : '') + '" data-filter="category:' + _esc(c) + '">' + _esc(c) + '</button>';
      });
      bar.innerHTML = html;
      bar.querySelectorAll('.cat-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          currentFilter = chip.getAttribute('data-filter');
          bar.querySelectorAll('.cat-chip').forEach(function(x) { x.classList.remove('active'); });
          chip.classList.add('active');
          render();
        });
      });
    });
  }

  function _bindShelfEvents() {
    if (!shelfEl) return;
    shelfEl.querySelectorAll('.book-card').forEach(function(card) {
      card.addEventListener('click', function(e) {
        var actBtn = e.target.closest('.book-action');
        var bookId = card.getAttribute('data-book-id');
        if (actBtn) {
          e.stopPropagation();
          _handleAction(actBtn.getAttribute('data-act'), bookId, card);
          return;
        }
        if (onOpenBookCallback) onOpenBookCallback(bookId);
      });
      card.addEventListener('mouseenter', function() { card.classList.add('hover'); });
      card.addEventListener('mouseleave', function() { card.classList.remove('hover'); });
    });
  }

  function _handleAction(act, bookId, card) {
    if (act === 'open') {
      if (onOpenBookCallback) onOpenBookCallback(bookId);
    } else if (act === 'fav') {
      toggleFavorite(bookId).then(function() { render(); });
    } else if (act === 'rename') {
      getBook(bookId).then(function(meta) {
        if (!meta) return;
        var newName = prompt('重命名教材：', meta.name);
        if (newName && newName.trim()) {
          renameBook(bookId, newName.trim()).then(function() { render(); });
        }
      });
    } else if (act === 'del') {
      getBook(bookId).then(function(meta) {
        if (!meta) return;
        if (confirm('确定删除教材《' + meta.name + '》吗？相关笔记会保留。')) {
          deleteBook(bookId).then(function() { render(); });
        }
      });
    }
  }

  function setSearchKeyword(kw) {
    searchKeyword = kw || '';
    render();
  }

  function setFilter(filter) {
    currentFilter = filter || 'all';
    render();
  }

  // ---------- 工具 ----------

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _fmtDate(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // ============================================================
  // P7 导入导出：整书包 ZIP 导出 / 导入（蓝图 §8.1，接口契约 §10）
  // 依赖 ZipUtils（js/zip-utils.js，须在本文件之前加载）
  // ============================================================

  // Uint8Array → UTF-8 字符串（导入时解析 JSON 用）
  function _u8ToStr(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(s));
  }

  // 字符串 → Uint8Array（UTF-8）
  function _strToU8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var raw = unescape(encodeURIComponent(s));
    var u = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i) & 0xFF;
    return u;
  }

  // 数字补零（避免 String.prototype.padStart 兼容问题）
  function _pad4(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  // 获取某页用于导出的 Markdown：优先 mdContent，为空则从 blocks 惰性序列化（不写库）
  async function _pageMdForExport(page) {
    if (page.mdContent && String(page.mdContent).trim()) return page.mdContent;
    try {
      var blocks = await DataLayer.query('blocks', 'by_pageId', page.id);
      blocks.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
      return DataLayer.blocksToMarkdown(blocks) || '';
    } catch (e) {
      return page.mdContent || '';
    }
  }

  // 构建整书包 ZIP（返回 { fileName, bytes, manifest }，不触发下载，便于测试与复用）
  async function buildBookZip(bookId, opts) {
    opts = opts || {};
    if (!bookId) throw new Error('缺少教材 ID，无法导出');
    if (typeof ZipUtils === 'undefined') throw new Error('ZIP 工具模块未加载，无法导出');

    var meta = await DataLayer.get('books', bookId);
    if (!meta) throw new Error('未找到该教材，请先在书架导入后再导出');

    var nbs = await DataLayer.query('notebooks', 'by_pdfId', bookId);
    var nb = (nbs && nbs.length) ? nbs[0] : null;

    var pages = nb ? (await DataLayer.query('pages', 'by_notebookId', nb.id)) : [];
    pages.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

    // 指令：只导出属于本书页面的指令（commands 无 bookId，按 pageId 归属过滤）
    var allCmds = [];
    try { allCmds = await DataLayer.listCommands(); } catch (e) { allCmds = []; }
    var pageIdSet = {};
    pages.forEach(function(p) { pageIdSet[p.id] = true; });
    var cmds = allCmds.filter(function(c) { return c && pageIdSet[c.pageId]; });

    // 标注（AI 划重点，按 bookId 单条记录）
    var ann = null;
    try { ann = await DataLayer.get('annotations', bookId); } catch (e) { ann = null; }

    // 参考材料元数据 + MD 正文
    var refs = [];
    try { refs = await DataLayer.getReferenceByBook(bookId); } catch (e) { refs = []; }

    // PDF 原始文件（可选，默认携带）
    var includePdf = opts.includePdf !== false;
    var pdfRec = null;
    if (includePdf) {
      try { pdfRec = await DataLayer.get('bookblobs', bookId); } catch (e) { pdfRec = null; }
    }

    var manifest = {
      app: 'bookworm',
      format: 1,
      exportedAt: Date.now(),
      book: meta,
      notebook: nb ? { id: nb.id, pdfId: nb.pdfId, title: nb.title } : null,
      includePdf: !!pdfRec
    };

    var files = [{ name: 'manifest.json', data: JSON.stringify(manifest) }];
    if (pdfRec && pdfRec.data) files.push({ name: 'book.pdf', data: pdfRec.data });

    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      var md = await _pageMdForExport(p);
      var note = {
        id: p.id,
        name: p.name || ('第 ' + (i + 1) + ' 页'),
        pdfRef: p.pdfRef || null,
        mdContent: md || '',
        aiBookmarks: Array.isArray(p.aiBookmarks) ? p.aiBookmarks : [],
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || null
      };
      files.push({ name: 'notes/page-' + _pad4(i + 1) + '.json', data: JSON.stringify(note) });
    }
    if (cmds.length) files.push({ name: 'commands.json', data: JSON.stringify(cmds) });
    if (ann) files.push({ name: 'annotations.json', data: JSON.stringify(ann) });
    if (refs.length) files.push({ name: 'reference/mats.json', data: JSON.stringify(refs) });

    var bytes = ZipUtils.createZip(files);
    var safeName = String(meta.name || 'book').replace(/[\\/:*?"<>|]/g, '_');
    return { fileName: safeName + '_笔记备份.zip', bytes: bytes, manifest: manifest };
  }

  // 导出并触发下载（蓝图 §8.1 / §10：FileManager.exportBookZip）
  async function exportBookZip(bookId, opts) {
    var built = await buildBookZip(bookId, opts);
    var blob = new Blob([built.bytes.buffer], { type: 'application/zip' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = built.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 2000);
    return built;
  }

  // 导入 ZIP 备份包（解包恢复 IndexedDB，幂等/去重）
  async function importBookZip(file) {
    if (!file) throw new Error('未选择备份文件');
    if (typeof ZipUtils === 'undefined') throw new Error('ZIP 工具模块未加载，无法导入');

    var buf = await file.arrayBuffer();
    var entries;
    try {
      entries = ZipUtils.parseZip(new Uint8Array(buf));
    } catch (e) {
      throw new Error('解析 ZIP 失败：' + (e && e.message ? e.message : e));
    }
    var byName = {};
    entries.forEach(function(en) { byName[en.name] = en; });

    var manifestEntry = byName['manifest.json'];
    if (!manifestEntry) throw new Error('备份包缺少 manifest.json，无法导入');
    var manifest;
    try {
      manifest = JSON.parse(_u8ToStr(manifestEntry.data));
    } catch (e) {
      throw new Error('manifest.json 解析失败，备份包可能已损坏');
    }
    if (!manifest || manifest.app !== 'bookworm') throw new Error('不是书虫蛊备份包，无法导入');
    if (typeof manifest.format !== 'number' || manifest.format > 1) {
      throw new Error('备份包版本（format=' + manifest.format + '）高于当前支持的版本，请升级书虫蛊后重试');
    }
    var bookMeta = manifest.book || {};
    var bookId = bookMeta.id || (manifest.notebook && manifest.notebook.pdfId) || ('book_import_' + Date.now());

    var stats = {
      bookImported: false, notebookId: null,
      pagesImported: 0, pagesMerged: 0,
      commandsImported: 0, annotationsImported: 0, referencesImported: 0
    };

    // ---- 1. 恢复教材（books + bookblobs，幂等：已有同 id 则跳过） ----
    if (manifest.includePdf && byName['book.pdf']) {
      var pdfU8 = byName['book.pdf'].data;
      var head = '';
      for (var hi = 0; hi < Math.min(5, pdfU8.length); hi++) head += String.fromCharCode(pdfU8[hi]);
      if (head.indexOf('%PDF') === 0) {
        var existingBook = await DataLayer.get('books', bookId);
        if (!existingBook) {
          var pdfBuf = pdfU8.buffer.slice(pdfU8.byteOffset, pdfU8.byteOffset + pdfU8.byteLength);
          await DataLayer.put('books', Object.assign({}, bookMeta, { id: bookId }));
          await DataLayer.put('bookblobs', { id: bookId, data: pdfBuf });
          stats.bookImported = true;
        }
      } else {
        throw new Error('备份包中的 book.pdf 不是有效 PDF（缺少 %PDF 文件头）');
      }
    }

    // ---- 2. 恢复笔记本（按 pdfId 幂等：已有则复用，无则创建） ----
    var existingNbs = await DataLayer.query('notebooks', 'by_pdfId', bookId);
    var nb;
    if (existingNbs && existingNbs.length) {
      nb = existingNbs[0];
      if (manifest.notebook && manifest.notebook.title && nb.title !== manifest.notebook.title) {
        nb.title = manifest.notebook.title;
        await DataLayer.put('notebooks', nb);
      }
    } else {
      nb = {
        id: (manifest.notebook && manifest.notebook.id) || ('nb_import_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
        pdfId: bookId,
        title: (manifest.notebook && manifest.notebook.title) || bookMeta.name || '导入的笔记',
        pages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await DataLayer.put('notebooks', nb);
    }
    stats.notebookId = nb.id;

    // ---- 3. 恢复页面（幂等：按原 id 或 pdfRef.pageNum 匹配合并） ----
    var existingPages = await DataLayer.query('pages', 'by_notebookId', nb.id);
    var pageById = {};
    var pageByPdfNum = {};
    existingPages.forEach(function(p) {
      pageById[p.id] = p;
      var num = p.pdfPageNum || (p.pdfRef && p.pdfRef.pageNum);
      if (num != null && !pageByPdfNum[num]) pageByPdfNum[num] = p;
    });

    var pageIdMap = {}; // 旧 pageId → 实际落库 pageId
    var noteEntries = entries.filter(function(en) {
      return /^notes\/.+\.json$/.test(en.name);
    });
    noteEntries.sort(function(a, b) { return a.name < b.name ? -1 : 1; });

    for (var ni = 0; ni < noteEntries.length; ni++) {
      var note;
      try { note = JSON.parse(_u8ToStr(noteEntries[ni].data)); } catch (e) { continue; }
      if (!note || !note.id) continue;

      var target = pageById[note.id];
      var merged = false;
      if (!target) {
        var pnum = (note.pdfRef && note.pdfRef.pageNum) || null;
        if (pnum != null && pageByPdfNum[pnum]) {
          target = pageByPdfNum[pnum];
          merged = true;
        }
      }

      if (target) {
        // 更新已有页：覆盖 mdContent，合并书签（按 id 去重）
        var mergedBms = Array.isArray(target.aiBookmarks) ? target.aiBookmarks.slice() : [];
        var bmIds = {};
        mergedBms.forEach(function(b) { if (b && b.id) bmIds[b.id] = true; });
        (Array.isArray(note.aiBookmarks) ? note.aiBookmarks : []).forEach(function(b) {
          if (b && b.id && !bmIds[b.id]) { mergedBms.push(b); bmIds[b.id] = true; }
        });
        target.mdContent = note.mdContent || '';
        target.aiBookmarks = mergedBms;
        if (note.name && !target.name) target.name = note.name;
        if (note.pdfRef && !target.pdfRef) target.pdfRef = note.pdfRef;
        target.pdfPageNum = (target.pdfRef && target.pdfRef.pageNum) || null;
        target.updatedAt = Date.now();
        await DataLayer.put('pages', target);
        pageIdMap[note.id] = target.id;
        if (merged) stats.pagesMerged++; else stats.pagesImported++;
      } else {
        // 新建页（复用原 id，保证重复导入时按 id 幂等命中）
        var newPage = {
          id: note.id,
          notebookId: nb.id,
          pdfRef: note.pdfRef || null,
          pdfPageNum: (note.pdfRef && note.pdfRef.pageNum) || null,
          name: note.name || '导入页',
          blocks: [],
          mdContent: note.mdContent || '',
          aiBookmarks: Array.isArray(note.aiBookmarks) ? note.aiBookmarks : [],
          createdAt: note.createdAt || Date.now(),
          updatedAt: Date.now()
        };
        await DataLayer.put('pages', newPage);
        pageById[newPage.id] = newPage;
        if (newPage.pdfPageNum != null && !pageByPdfNum[newPage.pdfPageNum]) pageByPdfNum[newPage.pdfPageNum] = newPage;
        pageIdMap[note.id] = newPage.id;
        stats.pagesImported++;
      }
    }

    // ---- 4. 恢复指令（按 pageId+raw 去重，pageId 经映射纠偏） ----
    if (byName['commands.json']) {
      var cmds;
      try { cmds = JSON.parse(_u8ToStr(byName['commands.json'].data)); } catch (e) { cmds = []; }
      var existingCmds = [];
      try { existingCmds = await DataLayer.listCommands(); } catch (e) { existingCmds = []; }
      var cmdSig = {};
      existingCmds.forEach(function(c) {
        if (c) cmdSig[(c.pageId || '') + '::' + (c.raw || '')] = true;
      });
      for (var ci = 0; ci < cmds.length; ci++) {
        var c = cmds[ci];
        if (!c || !c.raw) continue;
        var realPageId = pageIdMap[c.pageId] || c.pageId;
        var sig = (realPageId || '') + '::' + c.raw;
        if (cmdSig[sig]) continue;
        await DataLayer.putCommand(Object.assign({}, c, { pageId: realPageId, notebookId: nb.id }));
        cmdSig[sig] = true;
        stats.commandsImported++;
      }
    }

    // ---- 5. 恢复标注（按 bookId 单条覆盖，幂等） ----
    if (byName['annotations.json']) {
      var annData;
      try { annData = JSON.parse(_u8ToStr(byName['annotations.json'].data)); } catch (e) { annData = null; }
      if (annData) {
        annData.id = bookId;
        await DataLayer.put('annotations', annData);
        stats.annotationsImported++;
      }
    }

    // ---- 6. 恢复参考材料（按 bookId+name 去重） ----
    if (byName['reference/mats.json']) {
      var mats;
      try { mats = JSON.parse(_u8ToStr(byName['reference/mats.json'].data)); } catch (e) { mats = []; }
      var existingMats = [];
      try { existingMats = await DataLayer.getReferenceByBook(bookId); } catch (e) { existingMats = []; }
      var matNames = {};
      var matIds = {};
      existingMats.forEach(function(m) { if (m) { matNames[m.name] = true; matIds[m.id] = true; } });
      for (var mi = 0; mi < mats.length; mi++) {
        var mat = mats[mi];
        if (!mat || !mat.name) continue;
        if (matNames[mat.name]) continue;
        var matId = mat.id;
        if (!matId || matIds[matId]) matId = 'rm_import_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await DataLayer.putReferenceMat(Object.assign({}, mat, { id: matId, bookId: bookId }));
        matNames[mat.name] = true;
        matIds[matId] = true;
        stats.referencesImported++;
      }
    }

    return stats;
  }

  return {
    init: init, render: render,
    importBook: importBook, getAllBooks: getAllBooks, getBook: getBook,
    getBookBlob: getBookBlob, deleteBook: deleteBook, renameBook: renameBook,
    toggleFavorite: toggleFavorite, setCategory: setCategory, touchOpened: touchOpened,
    searchBooks: searchBooks, getRecentBooks: getRecentBooks, getAllCategories: getAllCategories,
    setSearchKeyword: setSearchKeyword, setFilter: setFilter,
    // P7 导入导出
    buildBookZip: buildBookZip, exportBookZip: exportBookZip, importBookZip: importBookZip
  };
})();
if (typeof window !== 'undefined') window.FileManager = FileManager;
