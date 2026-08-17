/* =================================================================
 * 书虫蛊 · 教材专属 笔记文件管理器（P3-1 ~ P3-4）
 * 说明：
 *   - 每本书（pdfId）有一个独立的笔记管理空间（文件树）
 *   - 树节点类型：folder / note（对应 notebookId）
 *   - 数据持久化：localStorage + DataLayer（如果可用）
 *   - 支持：新建笔记 / 新建文件夹 / 删除 / 重命名 / 复制 / 剪切 / 粘贴
 *          导入（系统用 ZIP）/ 导出（系统用 ZIP + 人看 PDF）
 *          快捷键：Ctrl+N 新建 / F2 重命名 / Delete 删除
 *                   Ctrl+C 复制 / Ctrl+X 剪切 / Ctrl+V 粘贴
 *   - 页面目录（笔记内部页面，notebook.pages）管理：拖拽排序、复制剪切重命名
 *                   默认命名：第 X 页
 * ================================================================= */
(function() {
  'use strict';

  // ---------- 存储 ----------
  var STORE_KEY = 'shuchongu_notefm_v1';
  function _loadAll() {
    try {
      var s = localStorage.getItem(STORE_KEY);
      if (!s) return {};
      var d = JSON.parse(s);
      return d && typeof d === 'object' ? d : {};
    } catch (e) { return {}; }
  }
  function _saveAll(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data || {})); return true; }
    catch (e) { return false; }
  }
  function _bookKey(pdfId) { return 'book:' + String(pdfId || 'nopdf'); }
  function _uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  // 剪贴板：{type: 'copy'|'cut', node: treeNode, srcBookKey}
  var _clipboard = null;

  // 当前打开的教材（pdfId） & 选中/打开的 note
  var state = {
    pdfId: null,
    bookName: '未选择教材',
    selectedId: null,
    openNotebookId: null,
    collapsed: {} // folderId -> bool
  };

  // ---------- 树操作 ----------
  function getTree(pdfId) {
    var all = _loadAll();
    var key = _bookKey(pdfId);
    if (!all[key] || !Array.isArray(all[key].children)) {
      all[key] = {
        bookId: pdfId,
        createdAt: Date.now(),
        children: []
      };
      _saveAll(all);
    }
    return all[key];
  }
  function saveTree(pdfId, tree) {
    var all = _loadAll();
    all[_bookKey(pdfId)] = tree;
    _saveAll(all);
  }

  // 在树中查找节点（by id），返回 {node, parentArr, index}
  function findNode(children, id, parentArr, parentNode) {
    if (!Array.isArray(children)) return null;
    for (var i = 0; i < children.length; i++) {
      var n = children[i];
      if (n.id === id) return { node: n, parentArr: children, index: i, parent: parentNode || null };
      if (n.type === 'folder' && n.children) {
        var r = findNode(n.children, id, n.children, n);
        if (r) return r;
      }
    }
    return null;
  }

  function collectNoteIds(node) {
    var ids = [];
    var walk = function(arr) {
      for (var i = 0; i < arr.length; i++) {
        var n = arr[i];
        if (n.type === 'note') ids.push(n.notebookId);
        if (n.children) walk(n.children);
      }
    };
    if (node && node.children) walk(node.children);
    return ids;
  }

  // ---------- 渲染 NFM 树 ----------
  function render() {
    var treeEl = document.getElementById('nfmTree');
    if (!treeEl) return;
    var bookLabel = document.getElementById('nfmBookName');
    if (bookLabel) bookLabel.textContent = state.bookName || '未选择教材';

    // 同步笔记容器的显示模式（manager / editor）
    _syncNotebookMode();

    var tree = getTree(state.pdfId);
    treeEl.innerHTML = '';
    if (!tree.children.length) {
      var empty = document.createElement('div');
      empty.className = 'nfm-empty';
      empty.innerHTML = '📁 当前教材还没有笔记<br>点击上方「📝 新建」即可创建';
      treeEl.appendChild(empty);
      return;
    }
    _renderList(tree.children, treeEl, 0);
  }

  // ---------- 切换「笔记空间」容器的显示模式 ----------
  // 管理模式：没有打开任何笔记 → NFM 充满右侧，隐藏 Notebook 工具栏/内容区
  // 编辑模式：已有打开的笔记   → 三栏布局（窄NFM + 目录 + 纸张）
  function _syncNotebookMode() {
    var nb = document.getElementById('notebook');
    if (!nb) return;
    var inEditor = !!state.openNotebookId;
    nb.classList.toggle('nfm-mode-editor', inEditor);
    nb.classList.toggle('nfm-mode-manager', !inEditor);

    // 全屏笔记按钮联动：仅在编辑器模式显示
    var btnFp = document.getElementById('btnFullPageNote');
    if (btnFp) btnFp.style.display = inEditor ? '' : 'none';
    // 如果返回管理模式，确保退出了全屏
    if (!inEditor && document.body && document.body.classList.contains('note-fullpage')) {
      document.body.classList.remove('note-fullpage');
      if (btnFp) btnFp.textContent = '⛶ 全屏笔记';
    }
  }

  // ---------- 关闭当前笔记，返回文件管理空间 ----------
  function _closeCurrentNote() {
    if (!state.openNotebookId) return;
    state.openNotebookId = null;
    // 尝试通知 Notebook 清空视图（可选，不强制）
    try {
      if (window.Notebook && typeof Notebook.clearActiveNotebook === 'function') {
        Notebook.clearActiveNotebook();
      } else if (window.Notebook && typeof Notebook.renderPage === 'function') {
        // 至少刷新一次纸张，显示"请选择笔记"的空态文案
        try { Notebook.renderPage(); } catch(e) {}
      }
    } catch(e) { /* ignore */ }
    render();
  }

  function _renderList(list, parentEl, depth) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      parentEl.appendChild(_renderItem(n, depth));
      if (n.type === 'folder' && n.children && !state.collapsed[n.id]) {
        var sub = document.createElement('div');
        sub.className = 'nfm-children';
        _renderList(n.children, sub, depth + 1);
        parentEl.appendChild(sub);
      }
    }
  }

  function _renderItem(n, depth) {
    var row = document.createElement('div');
    row.className = 'nfm-item';
    row.dataset.id = n.id;
    row.dataset.type = n.type;
    if (n.id === state.selectedId) row.classList.add('selected');
    if (n.type === 'note' && n.notebookId === state.openNotebookId) row.classList.add('current-open');
    row.draggable = true;

    // 折叠按钮（folder only）
    var tog = document.createElement('button');
    tog.className = 'nfm-folder-toggle';
    tog.type = 'button';
    if (n.type === 'folder') {
      tog.textContent = state.collapsed[n.id] ? '▶' : '▼';
      tog.title = state.collapsed[n.id] ? '展开' : '折叠';
      tog.addEventListener('click', function(e) {
        e.stopPropagation();
        state.collapsed[n.id] = !state.collapsed[n.id];
        render();
      });
    } else {
      tog.textContent = '';
      tog.style.visibility = 'hidden';
    }
    row.appendChild(tog);

    // 图标
    var icon = document.createElement('span');
    icon.className = 'nfm-item-icon';
    icon.textContent = n.type === 'folder' ? (state.collapsed[n.id] ? '📁' : '📂') : '📝';
    row.appendChild(icon);

    // 名称（可重命名）
    var nameBox = document.createElement('span');
    nameBox.className = 'nfm-item-name';
    nameBox.textContent = n.name || (n.type === 'folder' ? '新文件夹' : '未命名笔记');
    nameBox.title = nameBox.textContent;
    row.appendChild(nameBox);

    // 操作
    var acts = document.createElement('span');
    acts.className = 'nfm-item-actions';
    var actEdit = _actBtn('✎', '重命名 (F2)', function(ev) { ev.stopPropagation(); _startRename(n.id, nameBox); });
    var actCopy = _actBtn('📋', '复制 (Ctrl+C)', function(ev) { ev.stopPropagation(); _copy(n.id); });
    var actCut = _actBtn('✂', '剪切 (Ctrl+X)', function(ev) { ev.stopPropagation(); _cut(n.id); });
    var actDel = _actBtn('🗑', '删除 (Delete)', function(ev) { ev.stopPropagation(); _delete(n.id); }, true);
    acts.appendChild(actEdit);
    acts.appendChild(actCopy);
    acts.appendChild(actCut);
    acts.appendChild(actDel);
    // 额外：note 增加 PDF 导出
    if (n.type === 'note') {
      var actPdf = _actBtn('📄', '导出为 PDF（人看）', function(ev) {
        ev.stopPropagation();
        NoteFileManager.exportNoteAsPdf(n.notebookId);
      });
      acts.appendChild(actPdf);
    }
    // 额外：note/file 增加 ZIP 导出
    var actZip = _actBtn('📦', '导出 ZIP（系统用）', function(ev) {
      ev.stopPropagation();
      NoteFileManager.exportZip(n.id);
    });
    acts.appendChild(actZip);
    row.appendChild(acts);

    // 点击：选中（不重建 DOM，只更新 CSS）；双击：打开（note）/ 切换（folder）
    row.addEventListener('click', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      // 只更新选中状态，不触发 render() 重建 DOM（避免 dblclick 丢失）
      document.querySelectorAll('.nfm-item.selected').forEach(function(el) { el.classList.remove('selected'); });
      row.classList.add('selected');
      state.selectedId = n.id;
      if (n.type === 'folder') {
        state.collapsed[n.id] = !state.collapsed[n.id];
        render(); // folder 折叠/展开需要重建子树
      }
    });
    row.addEventListener('dblclick', function(e) {
      if (e.target.tagName === 'INPUT') return;
      if (n.type === 'note') _openNote(n);
      else if (n.type === 'folder') {
        state.collapsed[n.id] = !state.collapsed[n.id];
        render();
      }
    });

    // 右键菜单
    row.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      state.selectedId = n.id;
      render();
      _showContextMenu(e, n);
    });

    // Drag & Drop
    row.addEventListener('dragstart', function(e) {
      e.stopPropagation();
      row.classList.add('dragging-source');
      try {
        e.dataTransfer.setData('text/x-nfm-id', n.id);
        e.dataTransfer.effectAllowed = 'move';
      } catch(err) {}
    });
    row.addEventListener('dragend', function() {
      row.classList.remove('dragging-source');
      document.querySelectorAll('.nfm-item.drop-target').forEach(function(el) {
        el.classList.remove('drop-target');
      });
    });
    row.addEventListener('dragover', function(e) {
      if (n.type !== 'folder') return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', function() {
      row.classList.remove('drop-target');
    });
    row.addEventListener('drop', function(e) {
      if (n.type !== 'folder') return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drop-target');
      var srcId = null;
      try { srcId = e.dataTransfer.getData('text/x-nfm-id'); } catch(err) { srcId = null; }
      if (srcId && srcId !== n.id) _moveNodeInto(srcId, n.id);
    });

    return row;
  }

  function _actBtn(txt, title, handler, danger) {
    var b = document.createElement('button');
    b.className = 'nfm-act-btn' + (danger ? ' del' : '');
    b.type = 'button';
    b.innerHTML = txt;
    b.title = title;
    b.addEventListener('click', handler);
    return b;
  }

  // ---------- 重命名 ----------
  function _startRename(id, nameBox) {
    var tree = getTree(state.pdfId);
    var r = findNode(tree.children, id, tree.children, null);
    if (!r) return;
    var cur = r.node.name || '';
    nameBox.innerHTML = '';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = cur;
    nameBox.appendChild(inp);
    setTimeout(function() { inp.focus(); inp.select(); }, 0);
    function done(cancel) {
      inp.removeEventListener('blur', onBlur);
      inp.removeEventListener('keydown', onKey);
      var v = String(inp.value || '').trim();
      if (!cancel && v) { r.node.name = v; saveTree(state.pdfId, tree); }
      render();
    }
    function onBlur() { done(false); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); done(false); }
      else if (e.key === 'Escape') { e.preventDefault(); done(true); }
    }
    inp.addEventListener('blur', onBlur);
    inp.addEventListener('keydown', onKey);
  }

  // ---------- 新建 ----------
  function _newNote(folderId) {
    if (!state.pdfId) {
      try { window.__showToast && __showToast('请先打开一本教材，再创建笔记'); }
      catch(e) { alert('请先打开一本教材，再创建笔记'); }
      return null;
    }
    var tree = getTree(state.pdfId);
    var notebook = null;
    var p1 = null;
    if (window.Notebook && typeof Notebook.createNotebook === 'function') {
      notebook = Notebook.createNotebook(state.pdfId, '新笔记');
      if (typeof Notebook.createPage === 'function') {
        p1 = Notebook.createPage(notebook.id, null);
        p1.name = '第 1 页';
        notebook.pages = [p1.id];
      }
    } else {
      notebook = { id: _uid('nb'), pdfId: state.pdfId, title: '新笔记', pages: [], createdAt: Date.now(), updatedAt: Date.now() };
    }
    var node = {
      id: _uid('n'),
      type: 'note',
      name: notebook.title || '新笔记',
      notebookId: notebook.id,
      createdAt: Date.now()
    };
    if (folderId) {
      var r = findNode(tree.children, folderId, tree.children, null);
      if (r && r.node.type === 'folder') {
        if (!r.node.children) r.node.children = [];
        r.node.children.push(node);
      } else { tree.children.push(node); }
    } else {
      tree.children.push(node);
    }
    saveTree(state.pdfId, tree);
    state.selectedId = node.id;

    // 先立即做一次 NFM 渲染（让新条目出现在列表中）
    render();

    // 把笔记本和页面写入 DB，完成后再打开该笔记
    var putNb = (window.DataLayer && DataLayer.put && notebook) ? DataLayer.put('notebooks', notebook) : Promise.resolve();
    var putPg = (p1 && window.DataLayer && DataLayer.put) ? DataLayer.put('pages', p1) : Promise.resolve();
    Promise.all([putNb, putPg]).then(function() {
      // 打开新笔记
      _openNote(node);
      // 延时高亮：等待 NFM DOM 渲染后
      setTimeout(function() {
        var row = document.querySelector('.nfm-item[data-id="' + node.id + '"]');
        if (row) {
          var nb = row.querySelector('.nfm-item-name');
          if (nb) _startRename(node.id, nb);
        }
      }, 120);
    }).catch(function(e) {
      console.warn('新笔记持久化失败，但尝试直接打开:', e);
      _openNote(node);
    });
    return node;
  }
  function _newFolder(folderId) {
    var tree = getTree(state.pdfId);
    var node = {
      id: _uid('f'),
      type: 'folder',
      name: '新文件夹',
      children: [],
      createdAt: Date.now()
    };
    if (folderId) {
      var r = findNode(tree.children, folderId, tree.children, null);
      if (r && r.node.type === 'folder') { r.node.children.push(node); }
      else tree.children.push(node);
    } else {
      tree.children.push(node);
    }
    saveTree(state.pdfId, tree);
    state.selectedId = node.id;
    render();
    // 自动进入重命名
    setTimeout(function() {
      var row = document.querySelector('.nfm-item[data-id="' + node.id + '"]');
      if (row) {
        var nb = row.querySelector('.nfm-item-name');
        if (nb) _startRename(node.id, nb);
      }
    }, 50);
  }

  // ---------- 删除 ----------
  function _delete(id) {
    var tree = getTree(state.pdfId);
    var r = findNode(tree.children, id, tree.children, null);
    if (!r) return;
    var n = r.node;
    var warn = '确认删除「' + (n.name || '该项') + '」？';
    if (n.type === 'folder') {
      var noteCount = collectNoteIds(n).length;
      warn += '\n（包含 ' + noteCount + ' 本笔记，删除无法撤销）';
    } else {
      warn += '\n删除后无法撤销';
    }
    if (!confirm(warn)) return;
    r.parentArr.splice(r.index, 1);
    saveTree(state.pdfId, tree);
    if (state.selectedId === id) state.selectedId = null;
    if (n.type === 'note' && state.openNotebookId === n.notebookId) {
      state.openNotebookId = null;
      var btnFp = document.getElementById('btnFullPageNote');
      if (btnFp) btnFp.style.display = 'none';
    }
    render();
  }

  // ---------- 复制/剪切/粘贴 ----------
  function _toast(msg) {
    try { if (window.__showToast) { window.__showToast(msg); return; } } catch (e) {}
    try { alert(msg); } catch (e) {}
  }
  function _copy(id) {
    var tree = getTree(state.pdfId);
    var r = findNode(tree.children, id, tree.children, null);
    if (!r) return;
    _clipboard = { type: 'copy', node: JSON.parse(JSON.stringify(r.node)), srcBookKey: _bookKey(state.pdfId) };
    render();
    _toast('✅ 已复制「' + (r.node.name || '') + '」，可按 Ctrl+V 粘贴');
  }
  function _cut(id) {
    var tree = getTree(state.pdfId);
    var r = findNode(tree.children, id, tree.children, null);
    if (!r) return;
    _clipboard = { type: 'cut', node: JSON.parse(JSON.stringify(r.node)), srcBookKey: _bookKey(state.pdfId), srcId: id };
    render();
    _toast('✂ 已剪切「' + (r.node.name || '') + '」，可按 Ctrl+V 粘贴到目标位置');
  }
  function _paste(targetId) {
    if (!_clipboard) { _toast('📋 剪贴板为空，请先复制或剪切'); return; }
    var tree = getTree(state.pdfId);
    // 确定目标父容器
    var targetArr = tree.children;
    if (targetId) {
      var r = findNode(tree.children, targetId, tree.children, null);
      if (r && r.node.type === 'folder') {
        if (!r.node.children) r.node.children = [];
        targetArr = r.node.children;
      }
    }
    var clone = JSON.parse(JSON.stringify(_clipboard.node));
    // 重新分配所有 id（避免冲突），并注册新的 notebook 实体
    var remap = {};
    var walk = function(n) {
      var oldId = n.id;
      n.id = _uid(n.type === 'folder' ? 'f' : 'n');
      remap[oldId] = n.id;
      if (n.type === 'note') {
        var oldNbId = n.notebookId;
        n.notebookId = _uid('nb');
        if (window.DataLayer) {
          try {
            // 复制原 notebook 及其 pages
            DataLayer.get('notebooks', oldNbId).then(function(oldNb) {
              if (oldNb) {
                var newNb = JSON.parse(JSON.stringify(oldNb));
                newNb.id = n.notebookId;
                newNb.title = n.name || newNb.title || '复制笔记';
                newNb.createdAt = Date.now();
                newNb.updatedAt = Date.now();
                newNb.pages = [];
                DataLayer.put('notebooks', newNb);
                // 复制 pages
                if (oldNb.pages && Array.isArray(oldNb.pages)) {
                  oldNb.pages.forEach(function(pid) {
                    DataLayer.get('pages', pid).then(function(oldP) {
                      if (!oldP) return;
                      var np = JSON.parse(JSON.stringify(oldP));
                      np.id = _uid('pg');
                      np.notebookId = newNb.id;
                      DataLayer.put('pages', np);
                      newNb.pages.push(np.id);
                      DataLayer.put('notebooks', newNb);
                      // 复制关联 blocks
                      if (oldP.id) {
                        DataLayer.listByIndex('blocks', 'by_pageId', oldP.id).then(function(bList) {
                          (bList || []).forEach(function(b) {
                            var nb = JSON.parse(JSON.stringify(b));
                            nb.id = _uid('blk');
                            nb.pageId = np.id;
                            DataLayer.put('blocks', nb);
                          });
                        });
                      }
                    });
                  });
                }
              }
            });
          } catch(e) {}
        }
      }
      if (n.children && Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(clone);

    // 如果是剪切，删除原节点
    if (_clipboard.type === 'cut' && _clipboard.srcBookKey === _bookKey(state.pdfId) && _clipboard.srcId) {
      var srcTree = getTree(state.pdfId);
      var sres = findNode(srcTree.children, _clipboard.srcId, srcTree.children, null);
      if (sres) sres.parentArr.splice(sres.index, 1);
      saveTree(state.pdfId, srcTree);
      _clipboard = null;
    } else if (_clipboard.type === 'copy') {
      // 粘贴后不清空，保持可多次粘贴
    }
    targetArr.push(clone);
    saveTree(state.pdfId, tree);
    render();
  }

  function _moveNodeInto(srcId, destFolderId) {
    if (srcId === destFolderId) return;
    var tree = getTree(state.pdfId);
    var src = findNode(tree.children, srcId, tree.children, null);
    var dest = findNode(tree.children, destFolderId, tree.children, null);
    if (!src || !dest || dest.node.type !== 'folder') return;
    // 不能移动到自身的子树
    var walkCheck = function(arr) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === destFolderId) continue;
        if (arr[i].id === srcId) return false;
        if (arr[i].children && walkCheck(arr[i].children) === false) return false;
      }
      return true;
    };
    if (!dest.node.children) dest.node.children = [];
    if (!walkCheck(dest.node.children)) { alert('⚠ 不能将文件夹移动到它自己的子文件夹中'); return; }
    src.parentArr.splice(src.index, 1);
    dest.node.children.push(src.node);
    saveTree(state.pdfId, tree);
    if (!state.collapsed[destFolderId]) state.collapsed[destFolderId] = false;
    render();
  }

  // ---------- 打开笔记 ----------
  function _openNote(n) {
    // 参数校验
    if (!n || n.type !== 'note' || !n.notebookId) {
      alert('该笔记记录损坏，无法打开');
      return;
    }

    var btnFp = document.getElementById('btnFullPageNote');
    if (btnFp) btnFp.style.display = '';

    // 先做一次 NFM 树渲染（高亮选中项），保持 manager 模式显示直到内容准备好
    render();

    // 给 manager 容器加个瞬时 loading 样式提示（避免用户以为点了没反应）
    var nbContainer = document.getElementById('notebook');
    if (nbContainer) {
      nbContainer.classList.add('nfm-opening');
      setTimeout(function() {
        if (nbContainer) nbContainer.classList.remove('nfm-opening');
      }, 8000); // 8 秒兜底：即便失败也去除 loading
    }

    // 一致性校验 + 自动分裂（修复历史 bug：所有 NFM 条目共用同一 notebookId）
    // 检查该笔记条目的 notebookId 是否：
    //   (a) 已被同一本书下的其他 NFM 笔记条目占用（重复指向同一个笔记本）
    //   (b) DB 中不存在该 notebook 实体
    //   (c) 该 notebook 实体其实属于别的书（pdfId 不匹配）
    // 命中任意一项 → 立刻创建独立 notebook + 首个空页并写入 NFM 记录，再去打开
    var openNotebookId = n.notebookId;
    var tree = getTree(state.pdfId);

    function isNotebookIdOccupiedByOther(noteObj, nbId) {
      // 用 id 比较排除自身（不能 用引用比较，因为 getTree 每次返回新的反序列化对象）
      var selfId = noteObj && noteObj.id;
      var notesArr = [];
      function walk(arr) {
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
          var item = arr[i];
          if (!item) continue;
          if (item.type === 'note' && item.id !== selfId) notesArr.push(item);
          if (item.children) walk(item.children);
        }
      }
      walk(tree && tree.children);
      for (var j = 0; j < notesArr.length; j++) {
        if (notesArr[j].notebookId === nbId) return true;
      }
      return false;
    }

    function finishLoad(okFlag) {
      // 无论成功/失败都切 editor 模式（成功看内容，失败看"空页占位"+按钮返回）
      state.openNotebookId = openNotebookId;
      if (nbContainer) nbContainer.classList.remove('nfm-opening');
      render();
      // 重新渲染（确保 NFM render() 不覆盖 Notebook 的状态，只在必要时重绘）
      setTimeout(function() {
        try {
          if (Notebook && Notebook.getCurrentPageId && Notebook.getCurrentPageId()) {
            // 只在 loadNotebookById 渲染完成后同步一次 TOC / 书签，不再二次 renderPage 避免焦点丢失
            if (Notebook.renderNotebookTOC) Notebook.renderNotebookTOC();
          }
        } catch (e) { console.warn('finishLoad 渲染失败:', e); }
      }, 40);
    }

    // 分裂：创建新的独立 Notebook + 空 Page，更新 NFM 记录的 notebookId
    function createAndAssignSeparateNotebook(thenCallback) {
      if (!(window.Notebook && typeof Notebook.createNotebook === 'function' &&
            typeof Notebook.createPage === 'function' &&
            window.DataLayer && DataLayer.put)) {
        thenCallback();
        return;
      }
      try {
        var freshNb = Notebook.createNotebook(state.pdfId, (n && n.name) ? n.name : '未命名笔记');
        var freshPg = Notebook.createPage(freshNb.id, null);
        freshPg.name = '第 1 页';
        freshNb.pages = [freshPg.id];
        DataLayer.put('notebooks', freshNb).then(function() {
          return DataLayer.put('pages', freshPg);
        }).then(function() {
          // 在 tree 中找到对应节点并更新 notebookId（不能修改旧对象 n，因为 getTree 每次返回新引用）
          var r = findNode(tree.children, n.id, tree.children, null);
          if (r && r.node) {
            r.node.notebookId = freshNb.id;
          } else {
            // 兜底：直接修改 n（虽然可能不在 tree 中，但 n.notebookId 后续仍可使用）
            n.notebookId = freshNb.id;
          }
          openNotebookId = freshNb.id;
          saveTree(state.pdfId, tree);
          thenCallback();
        }).catch(function(err) {
          console.warn('分配独立 notebook 失败，沿用原 ID 尝试打开:', err);
          thenCallback();
        });
      } catch (syncErr) {
        console.warn('分配独立 notebook 异常:', syncErr);
        thenCallback();
      }
    }

    // 先做占用/一致性探测，再决定是否分裂
    var needSplit = isNotebookIdOccupiedByOther(n, openNotebookId);

    if (needSplit) {
      console.warn('[openNote] 检测到 notebookId 已被其他笔记条目占用，当场分配独立 notebook，原 ID=', openNotebookId);
      createAndAssignSeparateNotebook(function() {
        // 分裂完成 → 直接 loadNotebookById(openNotebookId)
        if (window.Notebook && typeof Notebook.loadNotebookById === 'function') {
          Notebook.loadNotebookById(openNotebookId).then(function(nb) {
            finishLoad(!!nb);
          }).catch(function(e) {
            console.warn('打开分裂后的独立笔记失败:', e);
            finishLoad(false);
          });
        } else {
          finishLoad(false);
        }
      });
      return;
    }

    // 无占用 → 标准打开流程，但仍需在"DB 不存在/非本教材 pdfId"时做兜底
    if (window.Notebook && typeof Notebook.loadNotebookById === 'function') {
      Notebook.loadNotebookById(openNotebookId).then(function(nb) {
        if (!nb || (state.pdfId && nb.pdfId !== state.pdfId)) {
          // 兜底：DB 无记录 或 该 notebook 其实是别的书的
          if (!nb) console.warn('[openNote] 该笔记无 DB 实体，当场重建:', openNotebookId);
          else console.warn('[openNote] 该 notebook 归属别的书（pdfId=' + nb.pdfId + '≠' + state.pdfId + '），重建独立 notebook');
          createAndAssignSeparateNotebook(function() {
            if (window.Notebook && typeof Notebook.loadNotebookById === 'function') {
              Notebook.loadNotebookById(openNotebookId).then(function(nb2) {
                finishLoad(!!nb2);
              }).catch(function() { finishLoad(false); });
            } else { finishLoad(false); }
          });
          return;
        }
        finishLoad(true);
      }).catch(function(e) {
        console.warn('打开笔记失败:', e);
        finishLoad(false);
      });
    } else if (window.Notebook && typeof Notebook.loadOrCreateNotebook === 'function' && state.pdfId) {
      // 兜底：旧版加载逻辑
      Notebook.loadOrCreateNotebook(state.pdfId).then(function() {
        try { Notebook.renderPage(); } catch(e) {}
        finishLoad(true);
      }).catch(function() { finishLoad(false); });
    } else {
      finishLoad(false);
    }
  }

  // ---------- 右键菜单 ----------
  var _ctxMenu = null;
  function _showContextMenu(e, n) {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
    var m = document.createElement('div');
    _ctxMenu = m;
    m.style.position = 'fixed';
    m.style.left = e.clientX + 'px';
    m.style.top = e.clientY + 'px';
    m.style.zIndex = 99999;
    m.style.background = '#fff';
    m.style.border = '1px solid #bcd4bc';
    m.style.borderRadius = '8px';
    m.style.boxShadow = '0 10px 30px rgba(43,69,48,.22)';
    m.style.padding = '4px 0';
    m.style.minWidth = '180px';
    m.style.fontSize = '12.5px';
    var items = [
      { t: n.type === 'folder' ? '📂 展开/折叠' : '📝 打开', fn: function() {
          if (n.type === 'folder') { state.collapsed[n.id] = !state.collapsed[n.id]; render(); }
          else _openNote(n);
      } },
      { t: '✎ 重命名 (F2)', fn: function() {
        var row = document.querySelector('.nfm-item[data-id="' + n.id + '"]');
        if (row) _startRename(n.id, row.querySelector('.nfm-item-name'));
      } },
      { t: '📋 复制 (Ctrl+C)', fn: function() { _copy(n.id); } },
      { t: '✂ 剪切 (Ctrl+X)', fn: function() { _cut(n.id); } },
      { t: '📦 导出 ZIP（系统用）', fn: function() { NoteFileManager.exportZip(n.id); } },
      { t: n.type === 'note' ? '📄 导出 PDF（人看）' : null, fn: function() { if (n.type==='note') NoteFileManager.exportNoteAsPdf(n.notebookId); } },
      { t: null },
      { t: '🗑 删除 (Delete)', fn: function() { _delete(n.id); }, danger: true }
    ];
    items.forEach(function(it) {
      if (!it || !it.t) {
        var hr = document.createElement('div');
        hr.style.height = '1px'; hr.style.background = '#eee'; hr.style.margin = '4px 0';
        m.appendChild(hr);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.t;
      b.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 14px;border:none;background:transparent;cursor:pointer;color:' + (it.danger ? '#c0392b' : '#2b4530') + ';';
      b.addEventListener('mouseenter', function() { b.style.background = it.danger ? '#fdecea' : 'rgba(43,69,48,.08)'; });
      b.addEventListener('mouseleave', function() { b.style.background = 'transparent'; });
      b.addEventListener('click', function() { try { it.fn && it.fn(); } catch(e) {} m.remove(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    setTimeout(function() {
      document.addEventListener('mousedown', function cb(ev) {
        if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', cb); }
      });
    }, 0);
  }

  // ---------- 导入/导出 ZIP（系统用） ----------
  function _doExportZip(nodeId) {
    var tree = getTree(state.pdfId);
    var pkg = {
      version: 1,
      app: 'shuchongu',
      exportAt: Date.now(),
      bookName: state.bookName,
      pdfId: state.pdfId,
      tree: tree,
      selectedNodeId: nodeId || null,
      // 附带关联 notebooks / pages / blocks 的数据
      notebooks: [],
      pages: [],
      blocks: [],
      diagrams: {},
      blockUis: {}
    };
    // 如果指定 nodeId，只导出该子树
    var walk = function(arr, list) {
      for (var i = 0; i < arr.length; i++) {
        var n = arr[i];
        list.push(n);
        if (n.children) walk(n.children, list);
      }
    };
    var flatNodes = [];
    if (nodeId) {
      var r = findNode(tree.children, nodeId, tree.children, null);
      if (!r) { alert('找不到要导出的项'); return; }
      walk([r.node], flatNodes);
      pkg.tree = { bookId: state.pdfId, children: flatNodes.filter(function(n) { return true; /* noop */ }) };
      // 使用子树结构：重新包
      pkg.tree.children = [JSON.parse(JSON.stringify(r.node))];
    } else {
      walk(tree.children, flatNodes);
    }
    // 收集所有笔记实体
    var noteIds = {};
    flatNodes.forEach(function(n) { if (n.type === 'note' && n.notebookId) noteIds[n.notebookId] = true; });
    var dl = window.DataLayer;
    var nbPromises = Object.keys(noteIds).map(function(nid) {
      if (!dl || typeof dl.get !== 'function') return Promise.resolve(null);
      return dl.get('notebooks', nid).then(function(nb) {
        if (nb) { pkg.notebooks.push(nb); return nb; }
        return null;
      });
    });
    Promise.all(nbPromises).then(function() {
      var pagePromises = [];
      pkg.notebooks.forEach(function(nb) {
        if (!nb || !nb.pages) return;
        nb.pages.forEach(function(pid) {
          if (!dl || typeof dl.get !== 'function') return;
          pagePromises.push(dl.get('pages', pid).then(function(p) {
            if (p) pkg.pages.push(p);
            if (dl && dl.listByIndex) {
              return dl.listByIndex('blocks', 'by_pageId', pid).then(function(blist) {
                (blist || []).forEach(function(b) { pkg.blocks.push(b); });
              });
            }
          }));
        });
      });
      Promise.all(pagePromises).then(function() {
        // 加入 diagrams / blockUis
        try {
          for (var k in localStorage) {
            if (k.indexOf('shuchongu_diagram_') === 0) pkg.diagrams[k] = localStorage.getItem(k);
            if (k.indexOf('shuchongu_blockui_') === 0) pkg.blockUis[k] = localStorage.getItem(k);
          }
        } catch(e) {}
        var blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
        var name = (state.bookName || '笔记空间').replace(/[\\\/:*?"<>|]/g, '_') + '_' + new Date().toISOString().slice(0,10) + '.shuchongu.zip.json';
        _downloadBlob(blob, name);
        alert('✅ 已导出：' + name + '\n（系统用 JSON 包，可直接用于导入）');
      });
    });
  }

  function _doImportZip(file) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function() {
      try {
        var pkg = JSON.parse(String(fr.result || ''));
        if (!pkg || pkg.app !== 'shuchongu') throw new Error('不是有效的 书虫蛊 笔记包');
        // 合并树：导入到当前教材
        var tree = getTree(state.pdfId);
        var srcChildren = pkg.tree && pkg.tree.children ? pkg.tree.children : [];
        // 去重（按 name+type 简单去重），并且重新分配 notebookId 避免冲突
        var importNotes = [];
        var walk = function(arr) {
          for (var i = 0; i < arr.length; i++) {
            var n = arr[i];
            n.id = _uid(n.type === 'folder' ? 'f' : 'n');
            if (n.type === 'note') {
              var oldNbId = n.notebookId;
              n.notebookId = _uid('nb');
              importNotes.push({ oldId: oldNbId, newId: n.notebookId, node: n });
            }
            if (n.children) walk(n.children);
          }
        };
        walk(srcChildren);
        // 合并 notebook/page/block 数据，重新映射 id
        var pageMap = {}, nbMap = {};
        var dl = window.DataLayer;
        if (dl && pkg.notebooks) {
          pkg.notebooks.forEach(function(nb) {
            var match = importNotes.find(function(x) { return x.oldId === nb.id; });
            if (match) nbMap[nb.id] = match.newId;
          });
          pkg.notebooks.forEach(function(nb) {
            var newId = nbMap[nb.id];
            if (!newId) return;
            var nnb = JSON.parse(JSON.stringify(nb));
            nnb.id = newId;
            nnb.pdfId = state.pdfId;
            nnb.pages = [];
            if (typeof dl.put === 'function') dl.put('notebooks', nnb);
          });
        }
        if (dl && pkg.pages) {
          pkg.pages.forEach(function(p) {
            var np = JSON.parse(JSON.stringify(p));
            var newNbId = nbMap[p.notebookId];
            if (newNbId) {
              np.id = _uid('pg');
              pageMap[p.id] = np.id;
              np.notebookId = newNbId;
              if (typeof dl.put === 'function') dl.put('pages', np);
              // 把 page id 加到 notebook.pages
              dl.get('notebooks', newNbId).then(function(nb) {
                if (nb) { if (!nb.pages) nb.pages = []; nb.pages.push(np.id); dl.put('notebooks', nb); }
              });
            }
          });
        }
        if (dl && pkg.blocks) {
          pkg.blocks.forEach(function(b) {
            if (!pageMap[b.pageId]) return;
            var nb = JSON.parse(JSON.stringify(b));
            nb.id = _uid('blk');
            nb.pageId = pageMap[b.pageId];
            if (typeof dl.put === 'function') dl.put('blocks', nb);
          });
        }
        // 恢复 diagrams / blockUis
        if (pkg.diagrams) { for (var k in pkg.diagrams) { try { localStorage.setItem(k, pkg.diagrams[k]); } catch(e){} } }
        if (pkg.blockUis)   { for (var kk in pkg.blockUis) { try { localStorage.setItem(kk, pkg.blockUis[kk]); } catch(e){} } }
        // 合并树
        srcChildren.forEach(function(c) { tree.children.push(c); });
        saveTree(state.pdfId, tree);
        render();
        alert('✅ 导入完成！共导入 ' + srcChildren.length + ' 项。');
      } catch (e) {
        alert('导入失败：' + e.message);
      }
    };
    fr.readAsText(file);
  }

  function _downloadBlob(blob, name) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  // ---------- 导出 PDF（人看） ----------
  function _exportNoteAsPdf(notebookId) {
    // 实现：调用浏览器打印（带横线样式的纸张视图）
    if (!notebookId) { alert('没有选择笔记'); return; }
    // 尝试切换并打开全屏笔记打印
    try {
      if (window.Notebook && typeof Notebook.printPdf === 'function') {
        Notebook.printPdf(notebookId);
        return;
      }
    } catch (e) {}
    // 兜底：print
    alert('📄 正在调用浏览器打印……\n提示：在打印对话框中选择「另存为 PDF」即可');
    setTimeout(function() { window.print(); }, 200);
  }

  // ---------- 快捷键 ----------
  function bindShortcuts() {
    document.addEventListener('keydown', function(e) {
      // 仅当 focus 在 nfm / 笔记区域时生效。
      // 关键修复：_copy/_cut 用 toast 替代 alert 后焦点不再丢失；但为了兼容
      // alert 或点击按钮后焦点落在 body 的场景，只要面板可见且不在输入框内即生效。
      var ae = document.activeElement;
      var inNFM = ae && (ae.closest && ae.closest('#noteFileManager'));
      var inNote = ae && (ae.closest && ae.closest('#notebook'));
      if (!inNFM && !inNote) {
        var nfm = document.getElementById('noteFileManager');
        var nb = document.getElementById('notebook');
        var nfmVisible = nfm && nfm.offsetParent !== null;
        var nbVisible = nb && nb.offsetParent !== null;
        if (!nfmVisible && !nbVisible) return;
      }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
        // F2 / Delete 在输入框内允许自然输入（Delete 输入框中不触发删除项）
        if (e.key === 'F2' && state.selectedId && inNFM) {
          e.preventDefault();
          var row = document.querySelector('.nfm-item.selected');
          if (row) {
            var nb = row.querySelector('.nfm-item-name');
            if (nb) _startRename(state.selectedId, nb);
          }
        }
        return;
      }
      var ctrl = e.ctrlKey || e.metaKey;
      var k = String(e.key || '').toLowerCase();
      if (ctrl && !e.shiftKey && !e.altKey) {
        if (k === 'n') { e.preventDefault(); _newNote(state.selectedId); return; }
        if (k === 'c') { e.preventDefault(); if (state.selectedId) _copy(state.selectedId); return; }
        if (k === 'x') { e.preventDefault(); if (state.selectedId) _cut(state.selectedId); return; }
        if (k === 'v') { e.preventDefault(); _paste(state.selectedId); return; }
      }
      if (!ctrl && !e.shiftKey && !e.altKey) {
        if (k === 'delete') { e.preventDefault(); if (state.selectedId) _delete(state.selectedId); return; }
        if (e.key === 'F2' && state.selectedId) {
          e.preventDefault();
          var row2 = document.querySelector('.nfm-item.selected');
          if (row2) {
            var nb2 = row2.querySelector('.nfm-item-name');
            if (nb2) _startRename(state.selectedId, nb2);
          }
          return;
        }
      }
    });
  }

  // ---------- 页面目录管理（笔记内部 pages） ----------
  // 在笔记目录（notebookTOC）中启用：
  //   - 拖拽排序
  //   - 右键/操作：复制/剪切/粘贴/重命名（默认名"第 X 页"）
  //   - 快捷键：F2 重命名 / Del 删除
  function enhanceNotebookTOC() {
    var listEl = document.getElementById('notebookTOCList');
    if (!listEl) return;
    // 页面操作按钮注入：每次重渲染后都要重新绑定
    var observer = new MutationObserver(function() { _bindTOCItems(); });
    observer.observe(listEl, { childList: true, subtree: true, characterData: true });
    setTimeout(_bindTOCItems, 100);
  }
  function _bindTOCItems() {
    var listEl = document.getElementById('notebookTOCList');
    if (!listEl) return;
    var items = listEl.querySelectorAll('.toc-page-item, .notebook-toc-item, [data-page-id]');
    items.forEach(function(it) {
      if (it._nfmBound) return;
      it._nfmBound = true;
      it.draggable = true;
      // 为每一项添加"操作按钮容器"（若还没有）
      var nameSpan = it.querySelector('.toc-page-name, .page-name');
      if (nameSpan && !it.querySelector('.toc-item-actions')) {
        var acts = document.createElement('span');
        acts.className = 'toc-item-actions';
        acts.style.cssText = 'margin-left:auto;display:flex;gap:2px;opacity:.6;';
        var edit = document.createElement('button');
        edit.type='button'; edit.title='重命名 (F2)'; edit.textContent='✎';
        edit.style.cssText='width:20px;height:20px;border:none;background:transparent;cursor:pointer;';
        var del = document.createElement('button');
        del.type='button'; del.title='删除 (Delete)'; del.textContent='🗑';
        del.style.cssText='width:20px;height:20px;border:none;background:transparent;cursor:pointer;color:#c0392b;';
        var pageId = it.getAttribute('data-page-id') || (it.dataset && it.dataset.pageId);
        edit.addEventListener('click', function(ev) { ev.stopPropagation(); if (pageId) _renamePage(pageId, nameSpan); });
        del.addEventListener('click', function(ev) { ev.stopPropagation(); if (pageId) _deletePage(pageId); });
        acts.appendChild(edit);
        acts.appendChild(del);
        if (it.style && it.style.display === 'flex' || getComputedStyle(it).display === 'flex') {
          it.appendChild(acts);
        } else {
          it.style.display = 'flex';
          it.style.alignItems = 'center';
          it.appendChild(acts);
        }
        it.addEventListener('mouseenter', function() { acts.style.opacity = '1'; });
        it.addEventListener('mouseleave', function() { acts.style.opacity = '.6'; });
      }
      // DnD
      it.addEventListener('dragstart', function(e) {
        it.classList.add('dragging-source');
        var pid = it.getAttribute && it.getAttribute('data-page-id');
        try { e.dataTransfer.setData('text/x-page-id', pid || ''); e.dataTransfer.effectAllowed='move'; } catch(err){}
      });
      it.addEventListener('dragend', function() {
        it.classList.remove('dragging-source');
        listEl.querySelectorAll('.drop-target').forEach(function(el) { el.classList.remove('drop-target'); });
      });
      it.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); it.classList.add('drop-target'); });
      it.addEventListener('dragleave', function() { it.classList.remove('drop-target'); });
      it.addEventListener('drop', function(e) {
        e.preventDefault(); e.stopPropagation(); it.classList.remove('drop-target');
        var srcId = null;
        try { srcId = e.dataTransfer.getData('text/x-page-id'); } catch(err) {}
        var dstId = it.getAttribute && it.getAttribute('data-page-id');
        if (srcId && dstId && srcId !== dstId) _reorderPageBefore(srcId, dstId);
      });
    });
  }
  function _renamePage(pageId, nameSpanEl) {
    if (!window.Notebook) return;
    var page = null;
    if (typeof DataLayer !== 'undefined' && DataLayer.get) {
      DataLayer.get('pages', pageId).then(function(p) {
        if (!p) return;
        page = p;
        var cur = p.name || '';
        var inp = document.createElement('input');
        inp.type = 'text'; inp.value = cur; inp.style.cssText='font-size:inherit;padding:0 4px;width:180px;';
        if (nameSpanEl.childNodes.length) {
          while (nameSpanEl.firstChild) nameSpanEl.removeChild(nameSpanEl.firstChild);
        }
        nameSpanEl.appendChild(inp);
        setTimeout(function() { inp.focus(); inp.select(); }, 0);
        function finish(cancel) {
          inp.removeEventListener('blur', onBlur);
          inp.removeEventListener('keydown', onKey);
          var v = String(inp.value || '').trim();
          inp.remove();
          if (!cancel && v) {
            if (typeof Notebook.setPageName === 'function') Notebook.setPageName(pageId, v);
            else { p.name = v; if (DataLayer.put) DataLayer.put('pages', p); }
          }
          // 重新渲染目录
          try { if (typeof Notebook.renderNotebookTOC === 'function') Notebook.renderNotebookTOC(); } catch(e) {}
        }
        function onBlur() { finish(false); }
        function onKey(e) { if (e.key === 'Enter') { e.preventDefault(); finish(false); } else if (e.key === 'Escape') { e.preventDefault(); finish(true); } }
        inp.addEventListener('blur', onBlur);
        inp.addEventListener('keydown', onKey);
      });
    }
  }
  function _deletePage(pageId) {
    if (!confirm('确认删除此笔记页面？（页面内所有内容将丢失）')) return;
    // 交给 Notebook 处理
    if (window.Notebook && typeof Notebook.deletePage === 'function') { try { Notebook.deletePage(pageId); } catch(e) {} }
    else if (window.DataLayer) {
      try { DataLayer.delete('pages', pageId); } catch(e) {}
    }
    try { if (typeof Notebook.renderNotebookTOC === 'function') Notebook.renderNotebookTOC(); } catch(e) {}
    try { if (typeof Notebook.renderPage === 'function') Notebook.renderPage(); } catch(e) {}
  }
  function _reorderPageBefore(srcId, dstId) {
    if (!window.Notebook) return;
    if (typeof Notebook.movePageBefore === 'function') {
      try { Notebook.movePageBefore(srcId, dstId); return; } catch(e) {}
    }
    // 兜底：从 DataLayer 中取出 notebook，调整 pages 数组顺序
    if (!window.DataLayer) return;
    var nbId = state.openNotebookId;
    if (!nbId) return;
    DataLayer.get('notebooks', nbId).then(function(nb) {
      if (!nb || !nb.pages) return;
      var pages = nb.pages.slice();
      var sIdx = pages.indexOf(srcId); if (sIdx < 0) return;
      pages.splice(sIdx, 1);
      var dIdx = pages.indexOf(dstId); if (dIdx < 0) pages.push(srcId); else pages.splice(dIdx, 0, srcId);
      nb.pages = pages; nb.updatedAt = Date.now();
      DataLayer.put('notebooks', nb);
      try { if (typeof Notebook.renderNotebookTOC === 'function') Notebook.renderNotebookTOC(); } catch(e) {}
    });
  }

  // ---------- 全屏笔记 ----------
  function bindFullPageButton() {
    var btn = document.getElementById('btnFullPageNote');
    if (!btn) return;
    btn.addEventListener('click', function() {
      var on = document.body.classList.toggle('note-fullpage');
      btn.textContent = on ? '退出全屏' : '⛶ 全屏笔记';
      btn.title = on ? '退出全屏笔记模式（Esc 也可）' : '全页面观看笔记（全屏）';
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && document.body.classList.contains('note-fullpage')) {
        document.body.classList.remove('note-fullpage');
        btn.textContent = '⛶ 全屏笔记';
      }
    });
  }

  // ---------- 工具栏按钮绑定 ----------
  function bindNfmToolbar() {
    var b1 = document.getElementById('nfmNewNote');
    if (b1) b1.addEventListener('click', function() { _newNote(state.selectedId); });
    var b2 = document.getElementById('nfmNewFolder');
    if (b2) b2.addEventListener('click', function() { _newFolder(state.selectedId); });
    var bImp = document.getElementById('nfmImport');
    var fImp = document.getElementById('nfmImportFile');
    if (bImp && fImp) {
      bImp.addEventListener('click', function() { fImp.value = ''; fImp.click(); });
      fImp.addEventListener('change', function() { var f = this.files && this.files[0]; if (f) _doImportZip(f); });
    }
    var bExp = document.getElementById('nfmExportPkg');
    if (bExp) bExp.addEventListener('click', function() { _doExportZip(state.selectedId || null); });
  }

  // ---------- 公开 ----------
  window.NoteFileManager = {
    init: function() {
      render();
      bindNfmToolbar();
      bindShortcuts();
      bindFullPageButton();
      enhanceNotebookTOC();
      // 绑定空态「立即新建笔记」按钮的处理函数 —— 直接调用 NFM 的 _newNote 创建独立笔记
      if (window.Notebook && typeof Notebook.setEmptyCreateHandler === 'function') {
        Notebook.setEmptyCreateHandler(function() {
          _newNote(null);
        });
      }
      // 绑定「⬅ 返回文件管理」按钮
    var btnBack = document.getElementById('btnReturnToFileManager');
    if (btnBack) btnBack.addEventListener('click', function() { _closeCurrentNote(); });
    // 绑定「◀ 折叠笔记空间」按钮
    var btnCollapse = document.getElementById('nfmToggleCollapse');
    var nfmEl = document.getElementById('noteFileManager');
    if (btnCollapse && nfmEl) {
      btnCollapse.addEventListener('click', function() {
        var isCollapsed = nfmEl.classList.toggle('nfm-collapsed');
        btnCollapse.classList.toggle('collapsed', isCollapsed);
        btnCollapse.textContent = isCollapsed ? '▶' : '◀';
        btnCollapse.title = isCollapsed ? '展开笔记空间' : '收起笔记空间';
        try {
          localStorage.setItem('shuchongu_nfm_collapsed', isCollapsed ? '1' : '0');
        } catch (e) {}
        // 让父容器重新布局
        setTimeout(function() {
          try { Notebook.renderPage(); } catch(e) {}
        }, 50);
      });
      // 恢复上次的折叠状态
      try {
        var saved = localStorage.getItem('shuchongu_nfm_collapsed');
        if (saved === '1') {
          nfmEl.classList.add('nfm-collapsed');
          btnCollapse.classList.add('collapsed');
          btnCollapse.textContent = '▶';
          btnCollapse.title = '展开笔记空间';
        }
      } catch (e) {}
    }
    },
    setCurrentBook: function(pdfId, bookName) {
      // 如果切到同一本书，不强制清空 openNotebookId（保留"上次打开的笔记"记忆）
      if (state.pdfId === pdfId) {
        state.bookName = bookName || state.bookName || '未选择教材';
        render();
        return;
      }
      state.pdfId = pdfId || null;
      state.bookName = bookName || '未选择教材';
      state.selectedId = null;
      state.openNotebookId = null;
      render();
    },
    getCurrentOpenNotebookId: function() {
      return state.openNotebookId || null;
    },
    // 外部（Notebook 模块打开第一本笔记时）同步设置已打开笔记状态
    setOpenNotebook: function(noteNodeId, notebookId) {
      if (notebookId) state.openNotebookId = notebookId;
      if (noteNodeId) state.selectedId = noteNodeId;
      render();
    },
    hasAnyNotesForBook: function(pdfId) {
      var t = getTree(pdfId);
      if (!t || !t.children || t.children.length === 0) return false;
      function walk(arr) {
        if (!arr) return false;
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!it) continue;
          if (it.type === 'note') return true;
          if (it.children && walk(it.children)) return true;
        }
        return false;
      }
      return walk(t.children);
    },
    // 返回该书的第一条笔记条目（用于 NFM 只有一本笔记时自动打开，避免用户看到空态）
    getFirstNoteForBook: function(pdfId) {
      var t = getTree(pdfId);
      if (!t || !t.children) return null;
      function walk(arr) {
        if (!arr) return null;
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!it) continue;
          if (it.type === 'note') return it;
          if (it.children) {
            var r = walk(it.children);
            if (r) return r;
          }
        }
        return null;
      }
      return walk(t.children);
    },
    // 统计该书的笔记条目数量
    countNotesForBook: function(pdfId) {
      var t = getTree(pdfId);
      if (!t || !t.children) return 0;
      var c = 0;
      function walk(arr) {
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!it) continue;
          if (it.type === 'note') c++;
          if (it.children) walk(it.children);
        }
      }
      walk(t.children);
      return c;
    },
    newNote: _newNote,
    newFolder: _newFolder,
    delete: _delete,
    copy: _copy,
    cut: _cut,
    paste: _paste,
    exportZip: _doExportZip,
    importZip: _doImportZip,
    exportNoteAsPdf: _exportNoteAsPdf,
    closeCurrentNote: _closeCurrentNote
  };
})();
