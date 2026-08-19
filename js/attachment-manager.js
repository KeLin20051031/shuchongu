/* =================================================================
 * 书虫蛊 · 附件管理系统（P3-16）
 * 功能：文件树 / 拖拽移动 / 预览 / 导出
 * 数据：IndexedDB attachments store（文件 Blob） + localStorage（树结构）
 * ================================================================= */
var AttachmentManager = (function() {
  'use strict';

  // ---------- 树结构存储（localStorage，同 NFM 模式） ----------
  var STORE_KEY = 'shuchongu_attachfm_v1';
  function _loadTrees() {
    try {
      var s = localStorage.getItem(STORE_KEY);
      if (!s) return {};
      var d = JSON.parse(s);
      return d && typeof d === 'object' ? d : {};
    } catch (e) { return {}; }
  }
  function _saveTrees(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data || {})); } catch (e) {}
  }
  function _bookKey(bookId) { return 'book:' + String(bookId || 'nopdf'); }
  function _uid(prefix) {
    return (prefix || 'att') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  // 获取/初始化某本书的附件树
  function getTree(bookId) {
    var all = _loadTrees();
    var key = _bookKey(bookId);
    if (!all[key]) {
      all[key] = { bookId: bookId, children: [] };
      _saveTrees(all);
    }
    return all[key];
  }
  function saveTree(bookId, tree) {
    var all = _loadTrees();
    all[_bookKey(bookId)] = tree;
    _saveTrees(all);
  }

  // 在树中查找节点
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

  // ---------- 状态 ----------
  var state = {
    bookId: null,
    bookName: '未选择教材',
    selectedId: null,
    collapsed: {}
  };

  // ---------- 文件图标 ----------
  function _fileIcon(name, mimeType) {
    var ext = (name || '').split('.').pop().toLowerCase();
    if (mimeType && mimeType.indexOf('image') === 0) return '🖼';
    if (mimeType && mimeType.indexOf('pdf') === 0) return '📄';
    if (mimeType && mimeType.indexOf('audio') === 0) return '🎵';
    if (mimeType && mimeType.indexOf('video') === 0) return '🎬';
    if (['txt', 'md'].indexOf(ext) >= 0) return '📝';
    if (['doc', 'docx'].indexOf(ext) >= 0) return '📃';
    if (['xls', 'xlsx', 'csv'].indexOf(ext) >= 0) return '📊';
    if (['ppt', 'pptx'].indexOf(ext) >= 0) return '📽';
    if (['zip', 'rar', '7z', 'gz'].indexOf(ext) >= 0) return '🗜';
    if (['js', 'json', 'html', 'css', 'py', 'java', 'c', 'cpp'].indexOf(ext) >= 0) {
      // 2026-08-18：流程图/思维导图 JSON 附件用专属图标
      if (/^流程图_/i.test(name || '')) return '🧠';
      return '🔧';
    }
    return '📎';
  }

  // ---------- 格式化文件大小 ----------
  function _fmtSize(bytes) {
    if (!bytes || bytes < 1) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---------- 渲染文件树 ----------
  function renderTree() {
    var treeEl = document.getElementById('attachTree');
    if (!treeEl) return;
    var tree = getTree(state.bookId);
    treeEl.innerHTML = '';

    if (!tree.children || tree.children.length === 0) {
      treeEl.innerHTML = '<div class="attach-tree-empty">暂无附件<br>点击「上传」按钮或拖拽文件到此区域</div>';
      return;
    }

    function _renderNode(node, depth) {
      var row = document.createElement('div');
      row.className = 'attach-tree-row';
      row.style.paddingLeft = (depth * 20 + 8) + 'px';
      row.dataset.id = node.id;
      row.dataset.type = node.type;
      row.draggable = true;

      var icon, label;
      if (node.type === 'folder') {
        var collapsed = state.collapsed[node.id];
        icon = document.createElement('span');
        icon.className = 'attach-tree-icon';
        icon.textContent = collapsed ? '📁' : '📂';
        icon.style.cursor = 'pointer';
        icon.addEventListener('click', function(e) {
          e.stopPropagation();
          state.collapsed[node.id] = !state.collapsed[node.id];
          renderTree();
        });
        label = document.createElement('span');
        label.className = 'attach-tree-label';
        label.textContent = node.name;
      } else {
        icon = document.createElement('span');
        icon.className = 'attach-tree-icon';
        icon.textContent = _fileIcon(node.name, node.mimeType);
        label = document.createElement('span');
        label.className = 'attach-tree-label';
        label.textContent = node.name;
        var sizeSpan = document.createElement('span');
        sizeSpan.className = 'attach-tree-size';
        sizeSpan.textContent = _fmtSize(node.size);
        row.appendChild(icon);
        row.appendChild(label);
        row.appendChild(sizeSpan);
        if (state.selectedId === node.id) row.classList.add('selected');
        _attachRowEvents(row, node);
        return row;
      }

      row.appendChild(icon);
      row.appendChild(label);
      if (state.selectedId === node.id) row.classList.add('selected');
      _attachRowEvents(row, node);

      var wrapper = document.createElement('div');
      wrapper.appendChild(row);

      if (node.type === 'folder' && !state.collapsed[node.id] && node.children) {
        for (var i = 0; i < node.children.length; i++) {
          wrapper.appendChild(_renderNode(node.children[i], depth + 1));
        }
      }
      return wrapper;
    }

    for (var i = 0; i < tree.children.length; i++) {
      treeEl.appendChild(_renderNode(tree.children[i], 0));
    }
  }

  // ---------- 行事件绑定 ----------
  function _attachRowEvents(row, node) {
    row.addEventListener('click', function(e) {
      e.stopPropagation();
      state.selectedId = node.id;
      renderTree();
      if (node.type === 'file') _previewFile(node);
      else _clearPreview();
    });

    // 双击文件夹折叠/展开
    row.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      if (node.type === 'folder') {
        state.collapsed[node.id] = !state.collapsed[node.id];
        renderTree();
      }
    });

    // 拖拽：开始
    row.addEventListener('dragstart', function(e) {
      e.stopPropagation();
      e.dataTransfer.setData('text/attach-id', node.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', function(e) {
      row.classList.remove('dragging');
    });

    // 拖拽：作为放置目标（仅文件夹）
    if (node.type === 'folder') {
      row.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', function(e) {
        row.classList.remove('drag-over');
      });
      row.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drag-over');
        var dragId = e.dataTransfer.getData('text/attach-id');
        if (dragId && dragId !== node.id) {
          _moveNode(dragId, node.id);
        }
      });
    }
  }

  // ---------- 移动节点 ----------
  function _moveNode(nodeId, targetFolderId) {
    var tree = getTree(state.bookId);
    var found = findNode(tree.children, nodeId, tree.children, null);
    if (!found) return;

    // 防止将文件夹移入自己的子文件夹
    if (found.node.type === 'folder') {
      function _isDescendant(parent, target) {
        if (!parent.children) return false;
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].id === target) return true;
          if (_isDescendant(parent.children[i], target)) return true;
        }
        return false;
      }
      if (found.node.id === targetFolderId || _isDescendant(found.node, targetFolderId)) {
        alert('不能将文件夹移入自身或其子文件夹');
        return;
      }
    }

    // 从原位置移除
    found.parentArr.splice(found.index, 1);

    // 插入到目标文件夹
    var target;
    if (targetFolderId === 'root') {
      target = tree;
    } else {
      var tf = findNode(tree.children, targetFolderId, tree.children, null);
      target = tf ? tf.node : tree;
    }
    if (!target.children) target.children = [];
    target.children.push(found.node);

    saveTree(state.bookId, tree);
    renderTree();
  }

  // ---------- 文件上传 ----------
  function _uploadFiles(files) {
    if (!state.bookId) { alert('请先选择一本教材'); return; }
    if (!files || files.length === 0) return;

    var tree = getTree(state.bookId);
    // 确定目标文件夹：选中的文件夹或根
    var targetFolder = null;
    if (state.selectedId) {
      var found = findNode(tree.children, state.selectedId, tree.children, null);
      if (found && found.node.type === 'folder') targetFolder = found.node;
    }

    var promises = Array.from(files).map(function(file) {
      return new Promise(function(resolve, reject) {
        file.arrayBuffer().then(function(buf) {
          var id = _uid('att');
          var node = {
            id: id,
            type: 'file',
            name: file.name,
            mimeType: file.type || '',
            size: file.size,
            addedAt: Date.now(),
            parentId: targetFolder ? targetFolder.id : 'root',
            bookId: state.bookId
          };
          // 存储 Blob 到 IndexedDB
          DataLayer.put('attachments', { id: id, bookId: state.bookId, parentId: node.parentId, data: buf, name: file.name, mimeType: node.mimeType, size: file.size }).then(function() {
            resolve(node);
          }).catch(function(e) { reject(e); });
        }).catch(function(e) { reject(e); });
      });
    });

    Promise.all(promises).then(function(nodes) {
      var arr = targetFolder ? targetFolder.children : tree.children;
      if (!arr) { if (targetFolder) targetFolder.children = []; arr = targetFolder ? targetFolder.children : tree.children; }
      for (var i = 0; i < nodes.length; i++) arr.push(nodes[i]);
      saveTree(state.bookId, tree);
      renderTree();
    }).catch(function(e) {
      alert('上传失败：' + (e && e.message ? e.message : e));
    });
  }

  // ---------- 新建文件夹 ----------
  function _newFolder() {
    if (!state.bookId) { alert('请先选择一本教材'); return; }
    var name = prompt('文件夹名称：', '新建文件夹');
    if (!name) return;
    var tree = getTree(state.bookId);
    var folder = { id: _uid('dir'), type: 'folder', name: name, children: [], addedAt: Date.now() };

    // 确定目标位置
    if (state.selectedId) {
      var found = findNode(tree.children, state.selectedId, tree.children, null);
      if (found && found.node.type === 'folder') {
        if (!found.node.children) found.node.children = [];
        found.node.children.push(folder);
        saveTree(state.bookId, tree);
        renderTree();
        return;
      }
    }
    tree.children.push(folder);
    saveTree(state.bookId, tree);
    renderTree();
  }

  // ---------- 删除选中 ----------
  function _deleteSelected() {
    if (!state.selectedId) { alert('请先选择一个文件或文件夹'); return; }
    var tree = getTree(state.bookId);
    var found = findNode(tree.children, state.selectedId, tree.children, null);
    if (!found) return;

    // 递归收集所有文件 ID
    var fileIds = [];
    function _collect(node) {
      if (node.type === 'file') fileIds.push(node.id);
      if (node.children) node.children.forEach(_collect);
    }
    _collect(found.node);

    var msg = found.node.type === 'folder'
      ? '确认删除文件夹「' + found.node.name + '」及其所有内容？'
      : '确认删除文件「' + found.node.name + '」？';
    if (!confirm(msg)) return;

    // 从树中删除
    found.parentArr.splice(found.index, 1);
    saveTree(state.bookId, tree);

    // 从 IndexedDB 删除文件 Blob
    fileIds.forEach(function(fid) {
      DataLayer.delete('attachments', fid).catch(function() {});
    });

    state.selectedId = null;
    _clearPreview();
    renderTree();
  }

  // ---------- 导出选中 ----------
  function _exportSelected() {
    if (!state.selectedId) { alert('请先选择一个文件或文件夹'); return; }
    var tree = getTree(state.bookId);
    var found = findNode(tree.children, state.selectedId, tree.children, null);
    if (!found) return;

    if (found.node.type === 'file') {
      _downloadFile(found.node);
    } else {
      // 文件夹：逐个下载（简易方案）
      var fileNodes = [];
      function _collect(node) {
        if (node.type === 'file') fileNodes.push(node);
        if (node.children) node.children.forEach(_collect);
      }
      _collect(found.node);
      if (fileNodes.length === 0) { alert('文件夹为空'); return; }
      var idx = 0;
      function _next() {
        if (idx >= fileNodes.length) return;
        _downloadFile(fileNodes[idx]);
        idx++;
        setTimeout(_next, 300);
      }
      _next();
    }
  }

  function _downloadFile(node) {
    DataLayer.get('attachments', node.id).then(function(rec) {
      if (!rec || !rec.data) { alert('文件数据丢失：' + node.name); return; }
      var blob = new Blob([rec.data], { type: node.mimeType || 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = node.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    }).catch(function(e) {
      alert('导出失败：' + (e && e.message ? e.message : e));
    });
  }

  // ---------- 文件预览 ----------
  function _previewFile(node) {
    var previewEl = document.getElementById('attachPreview');
    if (!previewEl) return;
    previewEl.innerHTML = '<div class="attach-preview-loading">加载中...</div>';

    DataLayer.get('attachments', node.id).then(function(rec) {
      if (!rec || !rec.data) {
        previewEl.innerHTML = '<div class="attach-preview-empty">文件数据丢失</div>';
        return;
      }
      var mime = node.mimeType || '';
      var buf = rec.data;
      var blob = new Blob([buf], { type: mime || 'application/octet-stream' });
      var url = URL.createObjectURL(blob);

      // 顶部信息栏
      var info = document.createElement('div');
      info.className = 'attach-preview-info';
      info.innerHTML = '<span class="api-name">' + _fileIcon(node.name, mime) + ' ' + node.name + '</span>' +
        '<span class="api-meta">' + _fmtSize(node.size) + ' · ' + (mime || '未知类型') + '</span>' +
        '<button class="api-download" title="下载">📥 下载</button>';
      info.querySelector('.api-download').addEventListener('click', function() { _downloadFile(node); });

      var content = document.createElement('div');
      content.className = 'attach-preview-content';
      var ext = (node.name.split('.').pop() || '').toLowerCase();

      if (mime.indexOf('image') === 0) {
        var img = document.createElement('img');
        img.src = url;
        img.className = 'attach-preview-img';
        content.appendChild(img);
      } else if (mime.indexOf('pdf') === 0) {
        var iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.className = 'attach-preview-iframe';
        content.appendChild(iframe);
      } else if (mime.indexOf('audio') === 0) {
        var audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        content.appendChild(audio);
      } else if (mime.indexOf('video') === 0) {
        var video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.style.maxWidth = '100%';
        content.appendChild(video);
      } else if (mime.indexOf('html') >= 0 || ext === 'html' || ext === 'htm') {
        // HTML 文件：直接渲染真实效果（iframe 加载 blob URL）
        var hframe = document.createElement('iframe');
        hframe.src = url;
        hframe.className = 'attach-preview-iframe';
        hframe.style.width = '100%';
        hframe.style.flex = '1 1 auto';
        hframe.style.minHeight = '320px';
        hframe.style.border = 'none';
        hframe.style.background = '#fff';
        content.appendChild(hframe);
      } else if (mime.indexOf('text') === 0 || mime === 'application/json' ||
                 ['txt', 'md', 'json', 'js', 'css', 'py', 'java', 'c', 'cpp', 'csv', 'xml'].indexOf(ext) >= 0) {
        // 文本/JSON 文件：读取内容后判断是否为「思维导图/流程图」（canvas-diagram JSON）
        var textBlob = new Blob([buf], { type: 'text/plain' });
        var reader = new FileReader();
        reader.onload = function() {
          var text = reader.result || '';
          // 2026-08-18：canvas-diagram JSON（含 nodes+edges 数组）→ 附件空间内嵌可编辑画布，
          // 与笔记双向同步：附件中修改 → localStorage + 附件源文件 → 笔记同 id 流程图同步更新（反之亦然）
          var parsed = null;
          if (mime === 'application/json' || ext === 'json') {
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
          }
          if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
            _renderDiagramEditor(node, content, parsed);
            return;
          }
          var pre = document.createElement('pre');
          pre.className = 'attach-preview-text';
          if (text.length > 50000) text = text.substring(0, 50000) + '\n\n... (仅显示前 50KB)';
          pre.textContent = text;
          content.appendChild(pre);
        };
        reader.readAsText(textBlob);
      } else {
        content.innerHTML = '<div class="attach-preview-unsupported">不支持预览此文件类型<br>请点击「下载」按钮查看</div>';
      }

      previewEl.innerHTML = '';
      previewEl.appendChild(info);
      previewEl.appendChild(content);

      // 清理旧的 URL（延迟，避免预览内容被释放）
      if (previewEl._prevUrl) URL.revokeObjectURL(previewEl._prevUrl);
      previewEl._prevUrl = url;
    }).catch(function(e) {
      previewEl.innerHTML = '<div class="attach-preview-empty">加载失败：' + (e && e.message ? e.message : e) + '</div>';
    });
  }

  // ---------- 思维导图/流程图 内嵌编辑器（与笔记双向同步）----------
  // 2026-08-18：附件中的 canvas-diagram JSON 附件可在附件空间直接编辑。
  // 保存 → 更新 localStorage（笔记同 id 流程图同步）+ 更新本附件源文件 Blob + 刷新笔记预览。
  function _renderDiagramEditor(node, content, data) {
    // 从附件节点还原 diagramId：来自笔记镜像的附件 nodeId 前缀为 diagram_
    var diagramId = null;
    var nid = String(node.id || '');
    if (nid.indexOf('diagram_') === 0) diagramId = nid.slice('diagram_'.length);

    var editorWrap = document.createElement('div');
    editorWrap.className = 'attach-diagram-editor';
    var bar = document.createElement('div');
    bar.className = 'attach-diagram-bar';
    bar.innerHTML =
      '<span class="attach-diagram-hint">🔄 与笔记双向同步：附件中修改保存后，笔记里同一流程图同步更新（反之亦然）</span>'
      + '<button class="attach-diagram-btn attach-diagram-refresh" type="button">🔄 刷新</button>'
      + '<button class="attach-diagram-btn attach-diagram-save" type="button">💾 保存</button>'
      + '<button class="attach-diagram-btn attach-diagram-export-png" type="button">🖼 导出图片</button>'
      + '<button class="attach-diagram-btn attach-diagram-export-pdf" type="button">📄 导出PDF</button>';
    var holder = document.createElement('div');
    holder.className = 'attach-diagram-holder';
    editorWrap.appendChild(bar);
    editorWrap.appendChild(holder);
    content.appendChild(editorWrap);

    var editor = null;
    try {
      if (typeof Notebook !== 'undefined' && Notebook.createAttachmentDiagramEditor) {
        editor = Notebook.createAttachmentDiagramEditor(holder, data, {
          diagramId: diagramId || undefined,
          onSave: function(did, d) {
            // 1) 更新本附件源文件 Blob（保持原节点 id，附件树不新增重复文件）
            try {
              var text2 = JSON.stringify(d || { nodes: [], edges: [] }, null, 2);
              DataLayer.put('attachments', {
                id: node.id, bookId: node.bookId, parentId: node.parentId,
                data: new Blob([text2], { type: 'application/json' }),
                name: node.name, mimeType: 'application/json', size: text2.length
              }).catch(function() {});
              // 2) 树节点 size 更新
              var tree2 = getTree(state.bookId);
              var f = findNode(tree2.children, node.id, tree2.children, null);
              if (f) { f.node.size = text2.length; saveTree(state.bookId, tree2); }
            } catch (e) {}
          }
        });
      }
    } catch (e) { editor = null; }

    if (!editor) {
      content.innerHTML = '<div class="attach-preview-empty">无法初始化思维导图编辑器</div>';
      return;
    }

    // 刷新按钮：强制重新测量容器并渲染，解决画布卡住不显示的问题
    var refreshBtn = bar.querySelector('.attach-diagram-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function() {
      try { if (editor && editor.forceRefresh) editor.forceRefresh(); } catch (e) {}
    });
    // 保存按钮：触发编辑器持久化（走包装后的 _persist：localStorage + 附件 Blob + 笔记刷新）
    var saveBtn = bar.querySelector('.attach-diagram-save');
    if (saveBtn) saveBtn.addEventListener('click', function() {
      try { editor._persist(); } catch (e) { alert('保存失败：' + (e && e.message ? e.message : e)); }
    });
    // 导出图片 / PDF：直接抓取编辑器 canvas（所见即所得）
    var expPng = bar.querySelector('.attach-diagram-export-png');
    if (expPng) expPng.addEventListener('click', function() { _exportDiagramCanvas(editor, false); });
    var expPdf = bar.querySelector('.attach-diagram-export-pdf');
    if (expPdf) expPdf.addEventListener('click', function() { _exportDiagramCanvas(editor, true); });
  }

  // 把流程图编辑器画布导出为 PNG / PDF（与笔记预览一致）
  function _exportDiagramCanvas(editor, asPdf) {
    try {
      if (!editor || !editor.canvas) { alert('编辑器未就绪'); return; }
      try { editor.render && editor.render(); } catch (e) {}
      var c = editor.canvas;
      var dataUrl = c.toDataURL('image/png');
      var name = '流程图_' + (editor.attachDiagramId || '') + (asPdf ? '.pdf' : '.png');
      if (!asPdf) {
        var a = document.createElement('a');
        a.href = dataUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() { a.remove(); }, 200);
        return;
      }
      if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) { alert('jsPDF 未加载'); return; }
      var pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      var pw = pdf.internal.pageSize.getWidth();
      var ph = pdf.internal.pageSize.getHeight();
      var imgW = pw, imgH = c.height * pw / c.width;
      if (imgH > ph) { imgH = ph; imgW = c.width * ph / c.height; }
      pdf.addImage(dataUrl, 'PNG', (pw - imgW) / 2, (ph - imgH) / 2, imgW, imgH);
      pdf.save(name);
    } catch (e) { alert('导出失败：' + (e && e.message ? e.message : e)); }
  }

  function _clearPreview() {
    var previewEl = document.getElementById('attachPreview');
    if (previewEl) {
      if (previewEl._prevUrl) { URL.revokeObjectURL(previewEl._prevUrl); previewEl._prevUrl = null; }
      previewEl.innerHTML = '<div class="attach-preview-empty">选择一个文件预览，或拖拽文件到此区域上传</div>';
    }
  }

  // ---------- 书籍选择下拉 ----------
  function _refreshBookSelect() {
    var sel = document.getElementById('attachBookSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— 选择教材 —</option>';
    if (typeof FileManager === 'undefined' || !FileManager.getAllBooks) return;
    FileManager.getAllBooks().then(function(books) {
      if (!books || books.length === 0) {
        sel.innerHTML = '<option value="">请先在书架导入教材</option>';
        return;
      }
      books.sort(function(a, b) { return (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0); });
      for (var i = 0; i < books.length; i++) {
        var opt = document.createElement('option');
        opt.value = books[i].id;
        opt.textContent = books[i].name || '未命名';
        if (books[i].id === state.bookId) opt.selected = true;
        sel.appendChild(opt);
      }
    }).catch(function() {});
  }

  // ---------- 拖拽上传到整个视图 ----------
  function _bindDragUpload() {
    var view = document.getElementById('attachView');
    var hint = document.getElementById('attachDropHint');
    if (!view) return;

    view.addEventListener('dragover', function(e) {
      e.preventDefault();
      if (e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) {
        if (hint) hint.style.display = 'flex';
      }
    });
    view.addEventListener('dragleave', function(e) {
      // 仅当离开整个视图时隐藏
      if (e.relatedTarget === null || !view.contains(e.relatedTarget)) {
        if (hint) hint.style.display = 'none';
      }
    });
    view.addEventListener('drop', function(e) {
      e.preventDefault();
      if (hint) hint.style.display = 'none';
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        _uploadFiles(e.dataTransfer.files);
      }
    });
  }

  // ---------- 右键菜单（重命名） ----------
  function _bindContextMenu() {
    var treeEl = document.getElementById('attachTree');
    if (!treeEl) return;
    treeEl.addEventListener('contextmenu', function(e) {
      var row = e.target.closest('.attach-tree-row');
      if (!row) return;
      e.preventDefault();
      var id = row.dataset.id;
      var tree = getTree(state.bookId);
      var found = findNode(tree.children, id, tree.children, null);
      if (!found) return;
      var newName = prompt('重命名：', found.node.name);
      if (newName && newName !== found.node.name) {
        found.node.name = newName;
        saveTree(state.bookId, tree);
        renderTree();
        if (state.selectedId === id && found.node.type === 'file') _previewFile(found.node);
      }
    });
  }

  // ---------- 初始化 ----------
  function init() {
    var sel = document.getElementById('attachBookSelect');
    if (sel) sel.addEventListener('change', function() {
      state.bookId = this.value || null;
      state.selectedId = null;
      var opt = this.options[this.selectedIndex];
      state.bookName = opt ? opt.textContent : '未选择教材';
      _clearPreview();
      renderTree();
    });

    var btnFolder = document.getElementById('btnAttachNewFolder');
    if (btnFolder) btnFolder.addEventListener('click', _newFolder);

    var btnUpload = document.getElementById('btnAttachUpload');
    var inputUpload = document.getElementById('inputAttachFile');
    if (btnUpload && inputUpload) {
      btnUpload.addEventListener('click', function() {
        if (!state.bookId) { alert('请先选择一本教材'); return; }
        inputUpload.click();
      });
      inputUpload.addEventListener('change', function() {
        if (this.files && this.files.length > 0) _uploadFiles(this.files);
        this.value = '';
      });
    }

    var btnExport = document.getElementById('btnAttachExport');
    if (btnExport) btnExport.addEventListener('click', _exportSelected);

    var btnDelete = document.getElementById('btnAttachDelete');
    if (btnDelete) btnDelete.addEventListener('click', _deleteSelected);

    // 键盘删除
    var treeEl = document.getElementById('attachTree');
    if (treeEl) {
      treeEl.addEventListener('keydown', function(e) {
        if (e.key === 'Delete' && state.selectedId) {
          e.preventDefault();
          _deleteSelected();
        }
      });
    }

    _bindDragUpload();
    _bindContextMenu();

    // 尝试自动选择当前打开的教材
    if (typeof FileManager !== 'undefined' && FileManager.getAllBooks) {
      _refreshBookSelect();
    }
  }

  // ---------- 刷新（切到附件 Tab 时调用） ----------
  function refresh() {
    _refreshBookSelect();
    // 自动选中当前打开的教材
    if (!state.bookId && typeof AppShell !== 'undefined') {
      try {
        // 从 localStorage 恢复最近打开的 bookId
        var saved = localStorage.getItem('shuchongu_current_book');
        if (saved) {
          state.bookId = saved;
          var sel = document.getElementById('attachBookSelect');
          if (sel) sel.value = saved;
        }
      } catch (e) {}
    }
    renderTree();
  }

  // ---------- 外部接口 ----------
  return {
    init: init,
    refresh: refresh,
    renderTree: renderTree,
    setCurrentBook: function(bookId, bookName) {
      state.bookId = bookId;
      state.bookName = bookName || '未选择教材';
      try { localStorage.setItem('shuchongu_current_book', bookId); } catch (e) {}
    },
    // 以文本内容创建一个源文件附件（笔记 HTML 组件源码等）。
    // nodeId 相同则幂等覆盖（同名文件不重复堆积）；返回 Promise<node|null>
    addSourceFile: function(bookId, name, text, mimeType, nodeId) {
      try {
        if (!bookId) return Promise.resolve(null);
        var content = text == null ? '' : String(text);
        var mime = mimeType || 'text/plain';
        var id = nodeId || _uid('att');
        var tree = getTree(bookId);
        var existing = findNode(tree.children, id, tree.children, null);
        return DataLayer.put('attachments', {
          id: id,
          bookId: bookId,
          parentId: 'root',
          data: new Blob([content], { type: mime }),
          name: name,
          mimeType: mime,
          size: content.length
        }).then(function() {
          var node = {
            id: id, type: 'file', name: name,
            mimeType: mime, size: content.length,
            addedAt: Date.now(), parentId: 'root', bookId: bookId
          };
          if (existing) {
            existing.parentArr[existing.index] = node;
          } else {
            if (!tree.children) tree.children = [];
            tree.children.push(node);
          }
          saveTree(bookId, tree);
          return node;
        }).catch(function(e) { console.warn('写入附件失败:', e); return null; });
      } catch (e) { return Promise.resolve(null); }
    },
    // 以 Blob 内容创建/覆盖一个附件（图片等二进制文件镜像；nodeId 相同则幂等覆盖）
    addSourceBlob: function(bookId, name, blob, mimeType, nodeId) {
      try {
        if (!bookId) return Promise.resolve(null);
        if (typeof Blob === 'undefined' || !(blob instanceof Blob)) return Promise.resolve(null);
        var mime = mimeType || blob.type || 'application/octet-stream';
        var id = nodeId || _uid('att');
        var tree = getTree(bookId);
        var existing = findNode(tree.children, id, tree.children, null);
        return DataLayer.put('attachments', {
          id: id,
          bookId: bookId,
          parentId: 'root',
          data: blob,
          name: name,
          mimeType: mime,
          size: blob.size || 0
        }).then(function() {
          var node = {
            id: id, type: 'file', name: name,
            mimeType: mime, size: blob.size || 0,
            addedAt: Date.now(), parentId: 'root', bookId: bookId
          };
          if (existing) {
            existing.parentArr[existing.index] = node;
          } else {
            if (!tree.children) tree.children = [];
            tree.children.push(node);
          }
          saveTree(bookId, tree);
          return node;
        }).catch(function(e) { console.warn('写入附件失败:', e); return null; });
      } catch (e) { return Promise.resolve(null); }
    },
    // 删除一个源文件附件（与 addSourceFile 的 nodeId 对应）
    removeSourceFile: function(bookId, nodeId) {
      try {
        if (!bookId || !nodeId) return Promise.resolve(false);
        var tree = getTree(bookId);
        var found = findNode(tree.children, nodeId, tree.children, null);
        if (found) {
          found.parentArr.splice(found.index, 1);
          saveTree(bookId, tree);
        }
        return DataLayer.delete('attachments', nodeId).then(function() { return true; }).catch(function() { return false; });
      } catch (e) { return Promise.resolve(false); }
    }
  };
})();
