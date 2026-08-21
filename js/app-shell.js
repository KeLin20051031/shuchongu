// App Shell 模块 — 布局/视图/快捷键/入口（Phase 1 临时实现设置面板）
const AppShell = (function() {
  let aiConfig = null;

  // 默认指令识别符号：开/闭两组 — 允许自由组合
  const DEFAULT_CMD_OPEN  = ['/', '@ai ', '↺', '、、'];
  const DEFAULT_CMD_CLOSE = ['。。', '...', '。。。'];

  function _defaultConfig() {
    return {
      id: 'aiConfig',
      provider: 'openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: '',
      cmdOpenMarkers: DEFAULT_CMD_OPEN.slice(),   // 开头符号数组
      cmdCloseMarkers: DEFAULT_CMD_CLOSE.slice(), // 结尾符号数组
      enabledSkills: {}                           // name -> true/false（留空表示全部用默认值=启用；会和 SkillSystem 双向同步）
    };
  }

  // ---- 系统内置 skill 的分组：用于 UI 显示 ----
  var SYSTEM_EXCLUSIVE_SKILLS = {
    'textbook-navigate': true,
    'exam-points': true,
    'differential-diagnosis': true,
    'diagnostic-pathway': true,
    'batch-highlight': true,
    'annotation-flashcards': true,
    'textbook-note-framework': true
  };

  // ---- 渲染 AI 配置里的技能启用列表（简表+开关）----
  function _renderAISkillsList() {
    var listEl = document.getElementById('aiSkillsList');
    if (!listEl || typeof SkillSystem === 'undefined' || !SkillSystem.listAll) return;
    if (typeof SkillSystem.init === 'function') SkillSystem.init();
    var all = SkillSystem.listAll();
    if (!all || !all.length) { listEl.innerHTML = '<div style="color:#888;padding:8px">暂无可用技能</div>'; return; }

    // 分组：系统专属在前，通用在后
    all.sort(function (a, b) {
      var ag = SYSTEM_EXCLUSIVE_SKILLS[a.name] ? 0 : 1;
      var bg = SYSTEM_EXCLUSIVE_SKILLS[b.name] ? 0 : 1;
      if (ag !== bg) return ag - bg;
      return (a.name || '').localeCompare(b.name || '');
    });

    listEl.innerHTML = '';
    var enabledCount = 0;
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      var isSys = SYSTEM_EXCLUSIVE_SKILLS[s.name];
      var enabled = !!SkillSystem.isEnabled(s.name);
      if (enabled) enabledCount++;
      var row = document.createElement('label');
      row.className = 'ai-skill-row ' + (isSys ? 'sys' : 'builtin');
      row.innerHTML =
        '<input type="checkbox" class="ai-skill-toggle" data-name="' + s.name + '" ' + (enabled ? 'checked' : '') + '>' +
        '<span class="ai-skill-name">' + s.name + '</span>' +
        '<span class="ai-skill-group ' + (isSys ? 'grp-sys' : 'grp-std') + '">' + (isSys ? '系统专属' : '内置通用') + '</span>' +
        '<span class="ai-skill-trigger" title="触发词：' + (s.whenToUse || '').replace(/"/g, '&quot;') + '">' + (s.whenToUse || '').slice(0, 24) + ((s.whenToUse || '').length > 24 ? '…' : '') + '</span>';
      listEl.appendChild(row);
    }
    var st = document.getElementById('aiSkillsStatus');
    if (st) st.textContent = '已启用 ' + enabledCount + ' / ' + all.length;
  }

  // ---- 从 AI 配置面板收集技能启用状态（返回 {name:true/false}）----
  function _collectEnabledSkillsFromForm() {
    var out = {};
    var toggles = document.querySelectorAll('.ai-skill-toggle');
    for (var i = 0; i < toggles.length; i++) {
      var name = toggles[i].getAttribute('data-name');
      if (name) out[name] = toggles[i].checked;
    }
    return out;
  }

  // ---- 批量修改表单里的技能启用状态（不立即持久化，等用户点保存）----
  function _setAISkillsFormAllEnabled(enabled, filterFn) {
    var toggles = document.querySelectorAll('.ai-skill-toggle');
    for (var i = 0; i < toggles.length; i++) {
      var name = toggles[i].getAttribute('data-name');
      if (filterFn && !filterFn(name)) continue;
      toggles[i].checked = !!enabled;
    }
    // 更新计数状态行
    var all = document.querySelectorAll('.ai-skill-toggle');
    var on = document.querySelectorAll('.ai-skill-toggle:checked');
    var st = document.getElementById('aiSkillsStatus');
    if (st) st.textContent = '已启用 ' + on.length + ' / ' + all.length;
  }

  async function _loadConfig() {
    await DataLayer.init();
    const config = await DataLayer.get('settings', 'aiConfig');
    aiConfig = config || _defaultConfig();
    if (!aiConfig.cmdOpenMarkers  || !aiConfig.cmdOpenMarkers.length)  aiConfig.cmdOpenMarkers  = DEFAULT_CMD_OPEN.slice();
    if (!aiConfig.cmdCloseMarkers || !aiConfig.cmdCloseMarkers.length) aiConfig.cmdCloseMarkers = DEFAULT_CMD_CLOSE.slice();
    if (!aiConfig.enabledSkills || typeof aiConfig.enabledSkills !== 'object') aiConfig.enabledSkills = {};
    // 2026-08-18 修复：加载配置后同步指令识别符号到 CommandQueue（多符号数组）
    try {
      if (typeof CommandQueue !== 'undefined' && CommandQueue.setDelimiters) {
        CommandQueue.setDelimiters(aiConfig.cmdOpenMarkers, aiConfig.cmdCloseMarkers);
      }
    } catch (e) {}
    // 将 settings 中保存的 enabledSkills 同步到 SkillSystem（双向同步的初始化端）
    if (typeof SkillSystem !== 'undefined' && SkillSystem.saveEnabledSkills) {
      SkillSystem.saveEnabledSkills(aiConfig.enabledSkills);
    }
    _fillForm();
  }

  function _fillForm() {
    document.getElementById('selectProvider').value = aiConfig.provider;
    document.getElementById('inputApiKey').value = aiConfig.apiKey;
    document.getElementById('inputBaseUrl').value = aiConfig.baseUrl;
    document.getElementById('inputModel').value = aiConfig.model || '';
    var openEl = document.getElementById('inputCmdOpen');
    var closeEl = document.getElementById('inputCmdClose');
    if (openEl)  openEl.value  = (aiConfig.cmdOpenMarkers  || []).join(', ');
    if (closeEl) closeEl.value = (aiConfig.cmdCloseMarkers || []).join(', ');
    // 填充技能启用面板（SkillSystem 状态优先；settings 中的 enabledSkills 仅兜底）
    try {
      if (typeof SkillSystem !== 'undefined' && SkillSystem.saveEnabledSkills && aiConfig.enabledSkills) {
        SkillSystem.saveEnabledSkills(aiConfig.enabledSkills);
      }
    } catch (e) {}
    _renderAISkillsList();
  }

  function _parseCsvMarkers(str) {
    if (!str) return [];
    return String(str)
      .split(/[,，]/)
      .map(function(s) { return s.replace(/^\s+|\s+$/g, ''); })
      .filter(function(s) { return s.length > 0; });
  }

  function _collectForm() {
    aiConfig.provider = document.getElementById('selectProvider').value;
    aiConfig.apiKey = document.getElementById('inputApiKey').value;
    aiConfig.baseUrl = document.getElementById('inputBaseUrl').value;
    aiConfig.model = document.getElementById('inputModel').value || '';
    var openEl  = document.getElementById('inputCmdOpen');
    var closeEl = document.getElementById('inputCmdClose');
    if (openEl)  aiConfig.cmdOpenMarkers  = _parseCsvMarkers(openEl.value);
    if (closeEl) aiConfig.cmdCloseMarkers = _parseCsvMarkers(closeEl.value);
    if (!aiConfig.cmdOpenMarkers.length)  aiConfig.cmdOpenMarkers  = DEFAULT_CMD_OPEN.slice();
    if (!aiConfig.cmdCloseMarkers.length) aiConfig.cmdCloseMarkers = DEFAULT_CMD_CLOSE.slice();
    // 技能启用状态：从表单读取 -> 同步到 SkillSystem -> 写入 aiConfig.enabledSkills （与 SkillSystem 双向持久化）
    var enabled = _collectEnabledSkillsFromForm();
    if (typeof SkillSystem !== 'undefined' && SkillSystem.saveEnabledSkills) {
      SkillSystem.saveEnabledSkills(enabled);
    }
    aiConfig.enabledSkills = enabled;
  }

  function _onProviderChange() {
    const provider = document.getElementById('selectProvider').value;
    const config = AIAdapter.getProviderConfig(provider);
    if (config.defaultBaseUrl) {
      document.getElementById('inputBaseUrl').value = config.defaultBaseUrl;
    }
    if (config.defaultModel) {
      document.getElementById('inputModel').placeholder = '留空使用默认（' + config.defaultModel + '）';
    }
  }

  // ---- 弹窗焦点管理（无障碍） ----
  var _lastFocusedEl = null;   // 打开弹窗前聚焦的元素，关闭后归还焦点
  var _openModalEl = null;     // 当前打开的模态元素

  function _getFocusable(container) {
    if (!container) return [];
    var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    var els = Array.prototype.slice.call(container.querySelectorAll(sel));
    return els.filter(function(el) { return el.offsetParent !== null; });
  }

  function _focusFirst(container) {
    var content = container.querySelector('.modal-content') || container;
    var f = _getFocusable(content);
    if (f.length) f[0].focus();
  }

  function _openModal(modalEl) {
    _lastFocusedEl = document.activeElement;
    _openModalEl = modalEl;
    _focusFirst(modalEl);
  }

  function _closeModal(modalEl) {
    if (_openModalEl === modalEl) _openModalEl = null;
    if (_lastFocusedEl && _lastFocusedEl.focus) {
      try { _lastFocusedEl.focus(); } catch (e) { /* ignore */ }
    }
  }

  function openSettings() {
    document.getElementById('settingsModal').style.display = 'flex';
    _fillForm();
    _openModal(document.getElementById('settingsModal'));
  }

  function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
    _closeModal(document.getElementById('settingsModal'));
  }

  async function saveSettings() {
    _collectForm();
    // 2026-08-18 修复：保存配置后立即同步指令识别符号到 CommandQueue（立即生效，无需刷新）
    try {
      if (typeof CommandQueue !== 'undefined' && CommandQueue.setDelimiters) {
        CommandQueue.setDelimiters(aiConfig.cmdOpenMarkers, aiConfig.cmdCloseMarkers);
      }
    } catch (e) {}
    await DataLayer.put('settings', aiConfig);
    closeSettings();
  }

  async function testConnection() {
    _collectForm();
    const status = document.getElementById('connectionStatus');
    status.textContent = '测试中...';
    status.className = 'status-text';
    var result = await AIAdapter.testConnection(aiConfig.provider, aiConfig.baseUrl, aiConfig.apiKey);
    if (result.success) {
      status.textContent = '✓ 连接成功';
      status.className = 'status-text success';
    } else {
      status.textContent = '✗ ' + (result.error || '连接失败');
      status.className = 'status-text fail';
    }
  }

  function getAIConfig() { return aiConfig; }

  /** 返回当前生效的指令识别符号数组（优先从 aiConfig 读取，兜底默认值） */
  function getCmdMarkers() {
    var openArr  = (aiConfig && aiConfig.cmdOpenMarkers  && aiConfig.cmdOpenMarkers.length)  ? aiConfig.cmdOpenMarkers  : DEFAULT_CMD_OPEN.slice();
    var closeArr = (aiConfig && aiConfig.cmdCloseMarkers && aiConfig.cmdCloseMarkers.length) ? aiConfig.cmdCloseMarkers : DEFAULT_CMD_CLOSE.slice();
    return { open: openArr, close: closeArr };
  }

  // ---- 本地存储不可用时的持久可见横幅（不依赖易被误关的 alert） ----
  function _showStorageBanner(detail) {
    var existing = document.getElementById('storageBanner');
    if (existing) { existing.style.display = 'flex'; return; }
    var bar = document.createElement('div');
    bar.id = 'storageBanner';
    bar.className = 'storage-banner';
    var online = (typeof location !== 'undefined') && location.protocol === 'https:';
    var desc = online
      ? '当前浏览器环境无法使用本地数据库（IndexedDB）。请使用最新版 Chrome / Edge / Firefox 访问本页面，并确认未开启「无痕模式」或禁止存储的隐私设置。'
      : '最常见原因：直接双击 HTML 文件打开（file:// 协议），浏览器会禁用本地数据库。' +
        '请改用「本地服务器」打开：在本目录运行 <code>python -m http.server 9842</code>，' +
        '再用浏览器访问 <code>http://127.0.0.1:9842/index.html</code>。' +
        '（项目里已附带「启动书虫蛊.bat」，双击即可自动完成。）';
    bar.innerHTML =
      '<div class="storage-banner-icon">⚠️</div>' +
      '<div class="storage-banner-body">' +
        '<div class="storage-banner-title">本地存储不可用，导入/保存功能已禁用</div>' +
        '<div class="storage-banner-desc">' + desc + '</div>' +
      '</div>' +
      '<button class="storage-banner-close" aria-label="关闭提示">✕</button>';
    bar.querySelector('.storage-banner-close').addEventListener('click', function() {
      bar.style.display = 'none';
    });
    document.body.appendChild(bar);
  }

  // ---- Skill 面板 ----
  function openSkillPanel() {
    document.getElementById('skillModal').style.display = 'flex';
    _renderSkillTags();
    _openModal(document.getElementById('skillModal'));
  }

  function closeSkillPanel() {
    document.getElementById('skillModal').style.display = 'none';
    _closeModal(document.getElementById('skillModal'));
  }

  function _renderSkillTags() {
    var profile = SkillManager.getProfile();
    var listEl = document.getElementById('skillTagList');
    var totalEl = document.getElementById('skillTotalOps');
    var countEl = document.getElementById('skillTagCount');
    if (!listEl) return;

    totalEl.textContent = '总操作: ' + profile.totalOperations;
    countEl.textContent = '标签: ' + profile.tags.length;

    listEl.innerHTML = '';
    for (var i = 0; i < profile.tags.length; i++) {
      var tag = profile.tags[i];
      var el = document.createElement('span');
      el.className = 'skill-tag ' + tag.category;

      var nameSpan = document.createElement('span');
      nameSpan.textContent = tag.name;
      el.appendChild(nameSpan);

      // 权重调节控件（点击 − / + 调整，并持久化）
      var weightWrap = document.createElement('span');
      weightWrap.className = 'tag-weight-ctrl';

      var minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'tag-weight-btn';
      minusBtn.textContent = '−';
      minusBtn.setAttribute('aria-label', '降低「' + tag.name + '」的权重');
      minusBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var w = Math.max(1, tag.weight - 1);
        SkillManager.updateTagWeight(tag.name, w).then(function() { _renderSkillTags(); });
      });

      var weightSpan = document.createElement('span');
      weightSpan.className = 'tag-weight';
      weightSpan.textContent = '×' + tag.weight;

      var plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'tag-weight-btn';
      plusBtn.textContent = '+';
      plusBtn.setAttribute('aria-label', '提高「' + tag.name + '」的权重');
      plusBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var w = Math.min(9, tag.weight + 1);
        SkillManager.updateTagWeight(tag.name, w).then(function() { _renderSkillTags(); });
      });

      weightWrap.appendChild(minusBtn);
      weightWrap.appendChild(weightSpan);
      weightWrap.appendChild(plusBtn);
      el.appendChild(weightWrap);

      if (tag.auto) {
        var autoSpan = document.createElement('span');
        autoSpan.className = 'tag-auto';
        autoSpan.textContent = '自动';
        el.appendChild(autoSpan);
      }

      var delSpan = document.createElement('span');
      delSpan.className = 'tag-delete';
      delSpan.textContent = '✕';
      delSpan.setAttribute('data-tag-name', tag.name);
      delSpan.addEventListener('click', function(e) {
        var name = e.target.getAttribute('data-tag-name');
        SkillManager.deleteTag(name).then(function() { _renderSkillTags(); });
      });
      el.appendChild(delSpan);

      listEl.appendChild(el);
    }
  }

  function _addSkillTag() {
    var input = document.getElementById('inputSkillTag');
    var select = document.getElementById('selectSkillCategory');
    var name = input.value.trim();
    if (!name) return;
    SkillManager.addTag(name, select.value).then(function(added) {
      if (added) { input.value = ''; _renderSkillTags(); }
    });
  }

  function _resetSkill() {
    SkillManager.resetProfile().then(function() { _renderSkillTags(); });
  }

  // ============================================================
  // ---- 技能库面板（SkillSystem）逻辑 ----
  // ============================================================
  var _libSelected = null;   // 当前选中的技能名
  var _libEditingNew = false; // 是否处于"新建草稿"状态（避免保存时 name 不可写校验）

  // Tab 切换
  function _switchSkillTab(tab) {
    var prefBtn = document.querySelector('.skill-tab-btn[data-tab="pref"]');
    var libBtn  = document.querySelector('.skill-tab-btn[data-tab="lib"]');
    var prefTab = document.getElementById('skillTabPref');
    var libTab  = document.getElementById('skillTabLib');
    if (!prefTab || !libTab) return;
    if (tab === 'lib') {
      prefTab.style.display = 'none';
      libTab.style.display = 'block';
      if (prefBtn) { prefBtn.classList.remove('skill-tab-active'); prefBtn.setAttribute('aria-selected','false'); }
      if (libBtn)  { libBtn.classList.add('skill-tab-active');    libBtn.setAttribute('aria-selected','true'); }
      _renderSkillLibList();
    } else {
      libTab.style.display = 'none';
      prefTab.style.display = 'block';
      if (libBtn)  { libBtn.classList.remove('skill-tab-active');  libBtn.setAttribute('aria-selected','false'); }
      if (prefBtn) { prefBtn.classList.add('skill-tab-active');    prefBtn.setAttribute('aria-selected','true'); }
    }
  }

  // 左栏：渲染技能列表
  function _renderSkillLibList() {
    var listEl = document.getElementById('skillLibList');
    if (!listEl) return;
    if (typeof SkillSystem === 'undefined') {
      listEl.innerHTML = '<div class="skill-lib-empty">⚠ SkillSystem 未加载</div>';
      return;
    }
    var skills = SkillSystem.listAll() || [];
    if (!skills.length) {
      listEl.innerHTML = '<div class="skill-lib-empty">暂无技能。点击「➕ 新建技能」或「📥 导入 MD」开始。</div>';
      return;
    }
    var html = '';
    skills.forEach(function (s) {
      var selected = (_libSelected === s.name) ? ' skill-card-selected' : '';
      var srcBadge = (s.source === 'bundled')
        ? '<span class="skill-src skill-src-bundled" title="内置技能：可覆盖编辑不可删除">内置</span>'
        : '<span class="skill-src skill-src-user" title="自定义技能：可完全删除">自定义</span>';
      var desc = s.description || '（无简介）';
      if (desc.length > 60) desc = desc.substring(0, 57) + '...';
      var checked = s.enabled ? 'checked' : '';
      var disabledCls = s.enabled ? '' : ' skill-card-disabled';
      html += '<div class="skill-card' + selected + disabledCls + '" data-skill-name="' + s.name + '">'
        + '<div class="skill-card-head">'
        +   '<span class="skill-card-name">' + _escHtml(s.name) + '</span>'
        +   '<label class="skill-card-toggle" title="启用/禁用该技能（禁用后 AI 不会匹配该技能）">'
        +     '<input type="checkbox" class="skill-lib-enable" data-skill-name="' + s.name + '" ' + checked + '>'
        +     '<span class="skill-toggle-track"><span class="skill-toggle-thumb"></span></span>'
        +   '</label>'
        +   srcBadge
        + '</div>'
        + '<div class="skill-card-desc">' + _escHtml(desc) + '</div>'
        + '</div>';
    });
    listEl.innerHTML = html;
    // ---- 事件委托 ----
    listEl.onclick = function (e) {
      // 1) 启用开关：只切换启用状态，不切换选中
      var checkbox = e.target.closest('.skill-lib-enable');
      if (checkbox) {
        e.stopPropagation();
        var name1 = checkbox.getAttribute('data-skill-name');
        if (name1 && typeof SkillSystem !== 'undefined' && SkillSystem.toggleEnabled) {
          SkillSystem.toggleEnabled(name1);
          // 同步回 aiConfig.enabledSkills（确保下次保存 settings 时不会丢失）
          if (aiConfig && typeof SkillSystem.getEnabledSkills === 'function') {
            aiConfig.enabledSkills = SkillSystem.getEnabledSkills();
          }
          _renderSkillLibList(); // 刷新样式
          // 同步刷新 AI 设置里的技能面板（如果它可见）
          try { _renderAISkillsList(); } catch (_) {}
        }
        return;
      }
      // 2) 点击卡片其他位置 → 选中编辑
      var card = e.target.closest('.skill-card');
      if (!card) return;
      var name = card.getAttribute('data-skill-name');
      if (name) _selectSkillForEdit(name);
    };
  }

  // 选中技能 → 填充编辑器
  function _selectSkillForEdit(name) {
    if (typeof SkillSystem === 'undefined') return;
    var def = SkillSystem.getDefinition(name);
    if (!def) return;
    _libSelected = name;
    _libEditingNew = false;
    _renderSkillLibList(); // 刷新选中高亮

    document.getElementById('skillEditorEmpty').style.display = 'none';
    var form = document.getElementById('skillEditorForm');
    form.style.display = 'block';
    // 渲染后重新获取引用（防止 DOM 重建后旧引用失效）
    var nameInput = document.getElementById('skillEditorName');
    var descInput = document.getElementById('skillEditorDesc');
    var whenInput = document.getElementById('skillEditorWhen');
    var bodyInput = document.getElementById('skillEditorBody');
    var sourceTag = document.getElementById('skillEditorSource');
    var resetBuiltinBtn = document.getElementById('btnSkillResetBuiltin');
    var delBtn = document.getElementById('btnSkillDelete');

    nameInput.value = name;
    descInput.value = def.description || '';
    whenInput.value = def.whenToUse || '';
    bodyInput.value = def.content || '';

    var isBuiltin = (def.source === 'bundled');
    // 检查用户是否已覆盖过这个内置技能
    var userSkills = SkillSystem.listUserSkills ? (SkillSystem.listUserSkills() || []) : [];
    var overridden = userSkills.some(function (us) { return us.name === name; });

    if (isBuiltin) {
      nameInput.setAttribute('readonly', 'readonly');
      nameInput.title = '内置技能的名称不可修改';
      sourceTag.textContent = '来源：内置 (bundled)' + (overridden ? ' · 已覆盖编辑' : '');
      sourceTag.className = 'skill-source-tag skill-source-bundled';
      resetBuiltinBtn.style.display = overridden ? 'inline-block' : 'none';
      delBtn.disabled = true;
      delBtn.classList.add('btn-disabled');
      delBtn.title = '内置技能不可删除，仅可覆盖编辑或恢复';
    } else {
      nameInput.removeAttribute('readonly');
      nameInput.title = '';
      sourceTag.textContent = '来源：自定义 (user)';
      sourceTag.className = 'skill-source-tag skill-source-user';
      resetBuiltinBtn.style.display = 'none';
      delBtn.disabled = false;
      delBtn.classList.remove('btn-disabled');
      delBtn.title = '删除此自定义技能';
    }
  }

  // 新建技能：清空表单为草稿态
  function _newSkill() {
    _libSelected = null;
    _libEditingNew = true;
    _renderSkillLibList();
    document.getElementById('skillEditorEmpty').style.display = 'none';
    var form = document.getElementById('skillEditorForm');
    form.style.display = 'block';
    var nameInput = document.getElementById('skillEditorName');
    nameInput.value = '';
    nameInput.removeAttribute('readonly');
    document.getElementById('skillEditorDesc').value = '';
    document.getElementById('skillEditorWhen').value = '';
    document.getElementById('skillEditorBody').value = [
      '# 新技能名称',
      '',
      '## 核心原则',
      '当用户的指令涉及 XXX 场景时，你必须遵循以下规范：',
      '',
      '### 输出格式',
      '- ...',
      ''
    ].join('\n');
    var sourceTag = document.getElementById('skillEditorSource');
    sourceTag.textContent = '来源：草稿（保存后成为自定义技能）';
    sourceTag.className = 'skill-source-tag skill-source-draft';
    document.getElementById('btnSkillResetBuiltin').style.display = 'none';
    var delBtn = document.getElementById('btnSkillDelete');
    delBtn.disabled = true;
    delBtn.classList.add('btn-disabled');
    delBtn.title = '草稿未保存，无需删除';
    nameInput.focus();
  }

  // 保存当前技能
  function _saveCurrentSkill() {
    if (typeof SkillSystem === 'undefined') return;
    var nameInput = document.getElementById('skillEditorName');
    var descInput = document.getElementById('skillEditorDesc');
    var whenInput = document.getElementById('skillEditorWhen');
    var bodyInput = document.getElementById('skillEditorBody');
    var name = nameInput.value.trim();
    if (!name) { alert('请填写技能名称（唯一标识，建议英文）'); nameInput.focus(); return; }
    if (!/^[A-Za-z0-9_\-]+$/.test(name)) {
      alert('技能名称只能包含英文字母、数字、下划线和短横线');
      nameInput.focus(); return;
    }
    var description = descInput.value.trim();
    if (!description) { alert('请填写一句话简介（AI 上下文中会展示给模型）'); descInput.focus(); return; }
    var whenToUse = whenInput.value.trim();
    var body = bodyInput.value;
    if (!body || !body.trim()) { alert('请填写技能正文内容（Markdown）'); bodyInput.focus(); return; }
    try {
      var ok = SkillSystem.registerUserSkill(name, description, body, { whenToUse: whenToUse });
      if (!ok) { alert('保存失败，请稍后重试'); return; }
    } catch (e) { alert('保存异常：' + e.message); return; }
    // 保存成功：切换到"选中刚保存的技能"状态
    _libEditingNew = false;
    _selectSkillForEdit(name);
    _flashSkillSaveOk();
  }

  // 删除当前技能（内置技能不可删）
  function _deleteCurrentSkill() {
    if (typeof SkillSystem === 'undefined' || !_libSelected) return;
    var list = SkillSystem.listAll() || [];
    var cur = list.find(function (s) { return s.name === _libSelected; });
    if (!cur) return;
    if (cur.source === 'bundled') { alert('内置技能不可删除。若想还原，请点「↩ 恢复内置版本」。'); return; }
    if (!confirm('确认删除自定义技能「' + _libSelected + '」？删除后不可撤销。')) return;
    SkillSystem.removeUserSkill(_libSelected);
    // 清空编辑器并刷新列表
    document.getElementById('skillEditorEmpty').style.display = 'block';
    document.getElementById('skillEditorForm').style.display = 'none';
    _libSelected = null;
    _renderSkillLibList();
  }

  // 恢复内置技能为原版（移除用户的覆盖版本）
  function _resetSkillToBuiltin() {
    if (typeof SkillSystem === 'undefined' || !_libSelected) return;
    if (!confirm('确认恢复「' + _libSelected + '」为内置版本？你对此技能的自定义修改会被撤销。')) return;
    SkillSystem.removeUserSkill(_libSelected); // 移除用户版本，内置版本自动生效
    _selectSkillForEdit(_libSelected);
    _renderSkillLibList();
  }

  // 导入 .md 文件（含 YAML frontmatter）
  function _importSkillFile() {
    var input = document.getElementById('inputSkillImportFile');
    if (!input) return;
    input.value = '';
    input.onchange = function () {
      var files = input.files;
      if (!files || !files.length) return;
      var file = files[0];
      var reader = new FileReader();
      reader.onload = function (ev) {
        var text = String(ev.target.result || '');
        var skill = null;
        if (typeof SkillSystem !== 'undefined' && SkillSystem.parseSkillFile) {
          skill = SkillSystem.parseSkillFile(text);
        }
        // 若不是合法 YAML+MD 格式，尝试按纯文本兜底：用文件名当 name
        if (!skill) {
          var fname = file.name || 'imported-skill.md';
          var stem = fname.replace(/\.(md|txt|yaml|yml)$/i, '');
          skill = {
            name: stem || ('imported-' + Date.now()),
            description: '从 ' + fname + ' 导入',
            whenToUse: '',
            body: text
          };
        }
        // 合法性兜底检查
        if (!skill.name || !/^[A-Za-z0-9_\-]+$/.test(skill.name)) {
          skill.name = 'imported_' + Date.now().toString(36);
        }
        if (!skill.body) skill.body = '# ' + skill.name;
        if (!skill.description) skill.description = '导入的技能';
        try {
          var ok = SkillSystem.registerUserSkill(skill.name, skill.description, skill.body, {
            whenToUse: skill.whenToUse || ''
          });
          if (ok) {
            _libEditingNew = false;
            _selectSkillForEdit(skill.name);
            _renderSkillLibList();
            _flashSkillSaveOk();
          } else {
            alert('导入失败：registerUserSkill 返回 false');
          }
        } catch (e) { alert('导入异常：' + e.message); }
      };
      reader.readAsText(file, 'utf-8');
    };
    input.click();
  }

  // 导出全部技能（每个技能一个 .md 文件，符合 deepseek-harness 的文件格式）
  function _exportAllSkills() {
    if (typeof SkillSystem === 'undefined') return;
    var all = SkillSystem.listAll() || [];
    if (!all.length) { alert('暂无技能可导出'); return; }
    var count = 0;
    all.forEach(function (s) {
      var body = SkillSystem.get(s.name) || '';
      var md = '';
      if (typeof SkillSystem.serializeSkillFile === 'function') {
        md = SkillSystem.serializeSkillFile({
          name: s.name,
          description: s.description,
          whenToUse: s.whenToUse,
          body: body
        });
      } else {
        md = body;
      }
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = s.name + '.md';
      document.body.appendChild(a);
      try { a.click(); count++; } catch (e) {}
      setTimeout(function () {
        try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {}
      }, 200);
    });
    if (count > 0) alert('已开始导出 ' + count + ' 个技能文件（.md）。若浏览器拦截了批量下载，请允许本站点的多次下载。');
  }

  // 保存成功闪烁提示（简单版）
  function _flashSkillSaveOk() {
    var saveBtn = document.getElementById('btnSkillSave');
    if (!saveBtn) return;
    var original = saveBtn.textContent;
    saveBtn.textContent = '✅ 已保存';
    saveBtn.disabled = true;
    saveBtn.classList.add('btn-disabled');
    setTimeout(function () {
      saveBtn.textContent = original;
      saveBtn.disabled = false;
      saveBtn.classList.remove('btn-disabled');
    }, 1200);
  }

  // 简易 HTML 转义（用于列表卡片渲染防 XSS）
  function _escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ---- AI 划重点面板（非模态浮动 · 实时过程） ----
  // var highlightPanelEl = null;
  // var _hlPanelInited = false;


  // 判断焦点是否在可编辑元素（输入框/文本域/下拉/富文本），此时键盘事件应交由编辑区
  function _isEditableTarget(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // ---- 快捷键处理 ----
  function _onGlobalKeydown(e) {
    // Tab 焦点陷阱：弹窗打开时，焦点在弹窗内循环
    if (e.key === 'Tab' && _openModalEl) {
      var content = _openModalEl.querySelector('.modal-content') || _openModalEl;
      var f = _getFocusable(content);
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      var active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !_openModalEl.contains(active)) { e.preventDefault(); last.focus(); }
      } else {
        if (active === last || !_openModalEl.contains(active)) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    // ESC: 关闭已打开的弹窗（设置 / Skill 面板 / 帮助）
    if (e.key === 'Escape') {
      var sm = document.getElementById('settingsModal');
      var skm = document.getElementById('skillModal');
      if (sm && sm.style.display !== 'none') { closeSettings(); return; }
      if (skm && skm.style.display !== 'none') { closeSkillPanel(); return; }
    }
    // 键盘翻页：左右箭头 / PageUp / PageDown
    // 条件：无弹窗打开、焦点不在可编辑元素、PDF 已加载
    if (!_openModalEl && !_isEditableTarget(e.target) &&
        typeof PDFReader.getCurrentPage === 'function' && PDFReader.getCurrentPage() > 0) {
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        PDFReader.prevPage().then(function() { _onPdfPageChange(PDFReader.getCurrentPage()); });
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        PDFReader.nextPage().then(function() { _onPdfPageChange(PDFReader.getCurrentPage()); });
      }
    }
    // Ctrl+F: 聚焦搜索框
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      var searchInput = document.getElementById('inputNotebookSearch');
      if (searchInput) searchInput.focus();
      return;
    }
    // Ctrl+S: 手动保存
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      _showSaveToast();
      return;
    }
    // Ctrl+Enter: 将选中文本作为 AI 指令发送
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      var selection = Notebook.getSelection();
      if (selection && selection.content) {
        var cmdText = Notebook.stripCommandEndMarker(selection.content);
        AIEngine.executeCommand(cmdText).catch(function(err) { console.error('AI执行失败:', err); });
      }
      return;
    }
  }

  // ---- 保存提示 ----
  function _showSaveToast() {
    var toast = document.getElementById('saveToast');
    if (!toast) return;
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, 1500);
  }

  // ---- 分隔条拖拽 ----
  function _onSplitterMouseDown(e) {
    e.preventDefault();
    var splitter = document.getElementById('splitter');
    var pdfReader = document.getElementById('pdfReader');
    var notebook = document.getElementById('notebook');
    if (!splitter || !pdfReader || !notebook) return;

    splitter.classList.add('dragging');
    var main = document.getElementById('main');
    var totalWidth = main.clientWidth;

    function onMove(ev) {
      var x = ev.clientX - main.getBoundingClientRect().left;
      var ratio = x / totalWidth;
      // 限制范围 20% ~ 80%
      ratio = Math.max(0.2, Math.min(0.8, ratio));
      pdfReader.style.flex = ratio + ' 1 0%';
      notebook.style.flex = (1 - ratio) + ' 1 0%';
    }

    function onUp() {
      splitter.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      _reRenderPdfIfNeeded();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function _switchView(view) {
    // 寄语门禁：未解锁时禁止进入书架/阅读/笔记/附件等页面
    if (view !== 'message' && !_gateUnlocked()) {
      _gateDeny(view);
      return;
    }
    const pdfReader = document.getElementById('pdfReader');
    const notebook = document.getElementById('notebook');
    const splitter = document.getElementById('splitter');
    const shelfView = document.getElementById('shelfView');
    const attachView = document.getElementById('attachView');
    const messageView = document.getElementById('messageView');
    const body = document.body;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    if (shelfView) shelfView.style.display = (view === 'shelf') ? '' : 'none';
    if (attachView) attachView.style.display = (view === 'attach') ? '' : 'none';
    if (messageView) messageView.style.display = (view === 'message') ? '' : 'none';
    // 同步 body 视图类，供标注层/边注栏按模式显示或隐藏
    if (body) {
      body.classList.remove('view-shelf', 'view-read', 'view-note', 'view-split', 'view-attach', 'view-message');
      body.classList.add('view-' + view);
    }
    const viewMap = { message: 'btnViewMessage', shelf: 'btnViewShelf', read: 'btnViewRead', note: 'btnViewNote', split: 'btnViewSplit', attach: 'btnViewAttach' };
    const tabBtn = viewMap[view] ? document.getElementById(viewMap[view]) : null;
    if (tabBtn) tabBtn.classList.add('active');
    // 寄语视图：全屏展示，隐藏阅读区
    if (view === 'message') {
      pdfReader.style.display = 'none';
      notebook.style.display = 'none';
      splitter.style.display = 'none';
      return;
    }
    // 书架视图：隐藏阅读区
    if (view === 'shelf') {
      pdfReader.style.display = 'none';
      notebook.style.display = 'none';
      splitter.style.display = 'none';
      return;
    }
    // 附件管理视图：独立全屏，隐藏阅读区
    if (view === 'attach') {
      pdfReader.style.display = 'none';
      notebook.style.display = 'none';
      splitter.style.display = 'none';
      if (typeof AttachmentManager !== 'undefined' && AttachmentManager.refresh) AttachmentManager.refresh();
      return;
    }
    switch (view) {
      case 'read':
        // 单视图：PDF 阅读器占满全屏
        pdfReader.style.display = '';
        pdfReader.style.flex = '1 1 100%';
        splitter.style.display = 'none';
        notebook.style.display = 'none';
        notebook.style.flex = '';
        // 从分栏切回时容器尺寸变化，需重渲染以同步标注层缩放
        _reRenderPdfIfNeeded();
        break;
      case 'note':
        // 笔记视图：左 PDF + 右笔记空间（不隐藏 PDF，符合用户"左边始终是pdf"的要求）
        // 笔记区域分两种子模式：未打开笔记时 = 文件管理视图(nfm 充满)；打开后 = 编辑视图(三栏布局)
        pdfReader.style.display = '';
        pdfReader.style.flex = '1';
        splitter.style.display = '';
        notebook.style.display = '';
        notebook.style.flex = '1.25';
        // 容器尺寸变化，需重渲染以同步标注层缩放
        _reRenderPdfIfNeeded();
        break;
      case 'split':
        // 分栏视图：PDF 44% / 笔记 56%（笔记栏稍宽，阅读舒适）
        pdfReader.style.display = '';
        pdfReader.style.flex = '1';
        splitter.style.display = '';
        notebook.style.display = '';
        notebook.style.flex = '1.25';
        // 容器尺寸变化，需重渲染以同步标注层缩放
        _reRenderPdfIfNeeded();
        break;
    }
  }

  // 寄语视图：冷色粒子网络背景动画（canvas 全屏，仅视图可见时绘制）
  function _initMessageParticles() {
    var cv = document.getElementById('messageParticles');
    if (!cv || cv.__msgBound) return;
    cv.__msgBound = true;
    var ctx = cv.getContext('2d');
    var W = 0, H = 0, DPR = window.devicePixelRatio || 1;
    var pts = [];
    function spawn() {
      var n = Math.max(24, Math.min(80, Math.round(W * H / 18000)));
      pts = [];
      for (var i = 0; i < n; i++) {
        pts.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3,
          r: Math.random() * 1.7 + .7,
          hue: Math.random() < .5 ? 199 : 226
        });
      }
    }
    function resize() {
      var r = cv.parentElement.getBoundingClientRect();
      W = Math.max(10, r.width); H = Math.max(10, r.height);
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      spawn();
    }
    function visible() {
      var el = document.getElementById('messageView');
      return !!el && el.offsetParent !== null;
    }
    function loop() {
      requestAnimationFrame(loop);
      if (!visible()) return;
      ctx.clearRect(0, 0, W, H);
      var i, j, p;
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
        if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'hsla(' + p.hue + ', 85%, 70%, .85)';
        ctx.fill();
      }
      for (i = 0; i < pts.length; i++) {
        for (j = i + 1; j < pts.length; j++) {
          var a = pts[i], b = pts[j];
          var dx = a.x - b.x, dy = a.y - b.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < 14400) {
            var alpha = (1 - Math.sqrt(d2) / 120) * .26;
            ctx.strokeStyle = 'hsla(' + Math.round((a.hue + b.hue) / 2) + ', 85%, 70%, ' + alpha + ')';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
    }
    window.addEventListener('resize', resize);
    resize();
    loop();
  }

  // ============================================================
  // 寄语 · 密码门禁：解锁后才能进入 书架/阅读/笔记/附件 等页面
  //   方案一：回答 lyn 的农历生日（7 月 7 日）
  //   方案二：管理员密码（初始 123456，可修改，SHA-256 存储）
  // ============================================================
  var GATE_KEY = 'shuchongu_gate_unlocked';
  var GATE_METHOD_KEY = 'shuchongu_gate_method'; // 'birth' 生日验证 / 'pwd' 管理员密码
  var GATE_PWD_KEY = 'shuchongu_admin_pwd';
  var GATE_DEFAULT_PWD_HASH = '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92'; // sha256("123456")
  var GATE_BIRTH_MONTH = 7, GATE_BIRTH_DAY = 7; // lyn 的农历生日 7 月 7 日

  function _gateUnlocked() {
    try { return localStorage.getItem(GATE_KEY) === '1'; } catch (e) { return false; }
  }
  function _gateMethod() {
    try { return localStorage.getItem(GATE_METHOD_KEY) || ''; } catch (e) { return ''; }
  }
  function _setUnlocked(method) {
    try {
      localStorage.setItem(GATE_KEY, '1');
      if (method) localStorage.setItem(GATE_METHOD_KEY, method);
    } catch (e) {}
    _gateRefresh();
  }
  function _gateLock() {
    try {
      localStorage.removeItem(GATE_KEY);
      localStorage.removeItem(GATE_METHOD_KEY);
    } catch (e) {}
    _gateRefresh();
    _switchView('message');
  }
  function _getPwdHash() {
    try { return localStorage.getItem(GATE_PWD_KEY) || GATE_DEFAULT_PWD_HASH; } catch (e) { return GATE_DEFAULT_PWD_HASH; }
  }
  function _sha256hex(s) {
    return new Promise(function(resolve) {
      try {
        if (window.crypto && crypto.subtle && typeof TextEncoder !== 'undefined') {
          crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s || ''))).then(function(buf) {
            var hex = Array.prototype.map.call(new Uint8Array(buf), function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
            resolve(hex);
          }).catch(function() { resolve(_fallbackHash(String(s || ''))); });
          return;
        }
      } catch (e) {}
      resolve(_fallbackHash(String(s || '')));
    });
  }
  function _fallbackHash(s) {
    var h = 5381, i, c;
    for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); h = ((h << 5) + h + c) | 0; }
    return 'djb2:' + Math.abs(h).toString(16);
  }
  function _verifyGatePwd(p) {
    return _sha256hex(p).then(function(h) { return h === _getPwdHash(); });
  }
  function _gateMsg(text, ok) {
    var el = document.getElementById('gateMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok ? '#4ade80' : '#f87171';
  }
  // 未解锁被拦截：切回寄语并提示
  function _gateDeny(view) {
    _switchView('message');
    var names = { shelf: '书架', read: '阅读', note: '笔记', split: '分栏', attach: '附件' };
    _gateMsg('⚠ 请先解锁再进入「' + (names[view] || view) + '」：回答下方生日问题或输入管理员密码。', false);
    var gate = document.getElementById('messageGate');
    if (gate) gate.style.display = '';
  }
  // 解锁状态 → UI 刷新
  function _gateRefresh() {
    var unlocked = _gateUnlocked();
    var method = _gateMethod();
    var gate = document.getElementById('messageGate');
    var gateBox = document.querySelector('.gate-box');
    var lockedRow = document.getElementById('gateLockedRow');
    var changePane = document.getElementById('gateChangePane');
    // 生日快乐寄语：仅在"生日方式"解锁后才显示；未解锁或管理员方式登录均隐藏，只保留项目介绍
    var titleEl = document.querySelector('.message-title');
    if (titleEl) titleEl.style.display = (unlocked && method === 'birth') ? '' : 'none';
    var badgeEl = document.querySelector('.message-badge');
    if (badgeEl) {
      badgeEl.textContent = (unlocked && method === 'birth') ? '📖 书虫蛊 · 寄语' : '📖 书虫蛊';
    }
    if (gateBox) {
      // 已解锁：隐藏验证表单，只显示状态行；未解锁：显示验证表单
      var panes = gateBox.querySelectorAll('.gate-pane');
      for (var i = 0; i < panes.length; i++) panes[i].style.display = unlocked ? 'none' : '';
      var tabs = gateBox.querySelectorAll('.gate-tab');
      for (var j = 0; j < tabs.length; j++) tabs[j].style.display = unlocked ? 'none' : '';
      var tip = gateBox.querySelector('.gate-tip');
      if (tip) tip.style.display = unlocked ? 'none' : '';
      var title = gateBox.querySelector('.gate-title');
      if (title) {
        if (!unlocked) title.textContent = '🔒 进入书虫蛊';
        else if (method === 'birth') title.textContent = '🔓 生日验证通过，已解锁';
        else title.textContent = '🔓 管理员已登录';
      }
    }
    if (lockedRow) lockedRow.style.display = unlocked ? '' : 'none';
    if (changePane) changePane.style.display = 'none';
    if (gate) gate.style.display = unlocked ? '' : '';
  }
  function _initGate() {
    var gate = document.getElementById('messageGate');
    if (!gate) return;
    // Tab 切换（生日 / 密码）
    gate.querySelectorAll('.gate-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        gate.querySelectorAll('.gate-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var k = tab.getAttribute('data-gate');
        gate.querySelectorAll('.gate-pane').forEach(function(p) {
          p.style.display = (p.getAttribute('data-pane') === k) ? '' : 'none';
        });
        _gateMsg('', false);
      });
    });
    // 方案一：生日验证
    var btnBirth = document.getElementById('btnGateBirth');
    if (btnBirth) btnBirth.addEventListener('click', function() {
      var m = parseInt(document.getElementById('gateBirthMonth').value, 10);
      var d = parseInt(document.getElementById('gateBirthDay').value, 10);
      if (m === GATE_BIRTH_MONTH && d === GATE_BIRTH_DAY) {
        _setUnlocked('birth');
        _gateMsg('✅ 生日验证通过，已解锁！', true);
        _gateRefresh();
      } else {
        _gateMsg('❌ 答案不正确，再想想～（提示：农历）', false);
      }
    });
    // 方案二：管理员密码
    var btnPwd = document.getElementById('btnGatePwd');
    var pwdInput = document.getElementById('gatePwd');
    function tryPwd() {
      var p = pwdInput ? pwdInput.value : '';
      if (!p) { _gateMsg('请输入管理员密码', false); return; }
      _verifyGatePwd(p).then(function(ok) {
        if (ok) {
          _setUnlocked('pwd');
          _gateMsg('✅ 密码正确，已解锁！', true);
          _gateRefresh();
          if (pwdInput) pwdInput.value = '';
        } else {
          _gateMsg('❌ 密码错误，请重试（默认 123456）', false);
        }
      });
    }
    if (btnPwd) btnPwd.addEventListener('click', tryPwd);
    if (pwdInput) pwdInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') tryPwd(); });
    // 重新锁定
    var btnLock = document.getElementById('btnGateLock');
    if (btnLock) btnLock.addEventListener('click', function() { _gateLock(); });
    // 修改管理员密码
    var btnChange = document.getElementById('btnGateChange');
    var changePane = document.getElementById('gateChangePane');
    if (btnChange) btnChange.addEventListener('click', function() {
      if (changePane) changePane.style.display = changePane.style.display === 'none' ? 'flex' : 'none';
    });
    var btnChangeCancel = document.getElementById('btnGateChangeCancel');
    if (btnChangeCancel) btnChangeCancel.addEventListener('click', function() {
      if (changePane) changePane.style.display = 'none';
      var o = document.getElementById('gateOldPwd'), n = document.getElementById('gateNewPwd');
      if (o) o.value = ''; if (n) n.value = '';
      _gateMsg('', false);
    });
    var btnChangeSave = document.getElementById('btnGateChangeSave');
    if (btnChangeSave) btnChangeSave.addEventListener('click', function() {
      var o = document.getElementById('gateOldPwd');
      var n = document.getElementById('gateNewPwd');
      var oldP = o ? o.value : '', newP = n ? n.value : '';
      if (!oldP || !newP) { _gateMsg('请填写旧密码与新密码', false); return; }
      if (newP.length < 4) { _gateMsg('新密码至少 4 位', false); return; }
      _verifyGatePwd(oldP).then(function(ok) {
        if (!ok) { _gateMsg('旧密码不正确', false); return; }
        return _sha256hex(newP).then(function(h) {
          try { localStorage.setItem(GATE_PWD_KEY, h); } catch (e) { _gateMsg('保存失败（存储不可用）', false); return; }
          if (o) o.value = ''; if (n) n.value = '';
          if (changePane) changePane.style.display = 'none';
          _gateMsg('✅ 管理员密码已更新', true);
        });
      });
    });
    _gateRefresh();
  }

  // 视图切换后等待浏览器 reflow，然后重渲染 PDF 页面以同步标注层尺寸
  function _reRenderPdfIfNeeded() {
    if (typeof PDFReader === 'undefined' || !PDFReader.renderPage || !PDFReader.getCurrentPage) return;
    requestAnimationFrame(function() {
      var cp = PDFReader.getCurrentPage();
      if (cp && cp > 0) {
        try { PDFReader.renderPage(cp); } catch (e) { /* ignore */ }
      }
    });
  }

  // PDF 翻页时同步笔记页（v140+ 改为活页管理：不再自动创建"每 PDF 页一笔记页"）
  function _onPdfPageChange(pageNum) {
    // 原逻辑 Notebook.ensurePageForPdfPage(pageNum) 已在 v140 移除：
    // 笔记页由用户在「📑 目录」中手动新建/管理（活页），翻页不再自动建页。
    // 如需按 PDF 页码定位已有笔记页，可调用 Notebook.findPageByPdfNum(pageNum)。
  }

  // ---- 书虫蛊 · 教材文件管理系统（书架） ----
  var currentBookId = null;
  function _initShelf() {
    var grid = document.getElementById('shelfGrid');
    var importBtn = document.getElementById('btnImportBook');
    var fileInput = document.getElementById('inputBookFile');
    var searchInput = document.getElementById('shelfSearch');
    if (!grid || !importBtn) return;

    // 打开书籍：加载 PDF + 关联笔记 + 恢复进度 + 切阅读视图
    function openBook(bookId) {
      FileManager.getBook(bookId).then(function(meta) {
        if (!meta) return;
        return FileManager.getBookBlob(bookId).then(function(blobRec) {
          if (!blobRec) throw new Error('教材数据丢失');
          currentBookId = bookId;
          if (typeof window !== 'undefined') window.__curBookId = bookId;
          // 同步附件管理器当前教材
          if (typeof AttachmentManager !== 'undefined' && AttachmentManager.setCurrentBook) {
            AttachmentManager.setCurrentBook(bookId, meta.name);
          }
          // 持久化当前书，使下次启动可恢复（修复：书架打开的书此前未写入 pdfs/current，导致重启恢复失效）
          DataLayer.put('pdfs', {
            id: 'current',
            bookId: bookId,
            name: meta.name,
            pageProgress: (meta.pageProgress && meta.pageProgress > 1) ? meta.pageProgress : 1,
            uploadedAt: Date.now()
          }).catch(function(e) { console.warn('持久化当前书失败:', e); });
          return PDFReader.loadPdfFromBuffer(blobRec.data, meta.name, bookId).then(function() {
            // 先同步 NFM 当前教材（让 NFM 决定用哪本笔记），再加载笔记本
            if (typeof NoteFileManager !== 'undefined' && typeof NoteFileManager.setCurrentBook === 'function') {
              NoteFileManager.setCurrentBook(bookId, meta.name);
            }
            return Notebook.loadOrCreateNotebook(bookId, meta.name);
          }).then(function() {
            if (meta.pageProgress && meta.pageProgress > 1) {
              PDFReader.jumpToPage(meta.pageProgress);
            }
            FileManager.touchOpened(bookId, PDFReader.getCurrentPage(), PDFReader.getPageCount());
            _switchView('read');
          });
        });
      }).catch(function(e) {
        console.error('打开教材失败:', e);
        alert('打开教材失败：' + (e && e.userMessage ? e.userMessage : (e && e.message ? e.message : '未知错误')));
      });
    }

    // 导入
    importBtn.addEventListener('click', function() { if (fileInput) fileInput.click(); });
    if (fileInput) {
      fileInput.addEventListener('change', function() {
        var files = Array.from(fileInput.files || []);
        var pending = files.map(function(f) { return FileManager.importBook(f); });
        Promise.all(pending).then(function() {
          fileInput.value = '';
          FileManager.render();
        }).catch(function(e) {
          var msg = e && e.message ? e.message : String(e);
          // 存储不可用时给出持久横幅，避免「静默无反应」
          if (/本地数据存储不可用|打开本地数据库|IndexedDB|file:\/\//.test(msg)) {
            _showStorageBanner(msg);
          }
          alert('导入失败: ' + msg);
        });
      });
    }

    // 搜索
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        FileManager.setSearchKeyword(searchInput.value);
      });
    }

    // 拖拽导入
    var shelfView = document.getElementById('shelfView');
    if (shelfView) {
      var dragCounter = 0;
      shelfView.addEventListener('dragenter', function(e) { e.preventDefault(); dragCounter++; _setShelfDrag(true); });
      shelfView.addEventListener('dragover', function(e) { e.preventDefault(); });
      shelfView.addEventListener('dragleave', function(e) { e.preventDefault(); dragCounter = Math.max(0, dragCounter - 1); if (!dragCounter) _setShelfDrag(false); });
      shelfView.addEventListener('drop', function(e) {
        e.preventDefault(); dragCounter = 0; _setShelfDrag(false);
        var files = Array.from(e.dataTransfer.files || []).filter(function(f) { return /\.pdf$/i.test(f.name); });
        var pending = files.map(function(f) { return FileManager.importBook(f); });
        Promise.all(pending).then(function() { FileManager.render(); }).catch(function(e) { alert('导入失败: ' + e.message); });
      });
    }

    // 等待数据层就绪后初始化书架（默认首页显示「寄语」视图）
    DataLayer.init().then(function() {
      FileManager.init(grid, { onOpenBook: openBook });
      _switchView('message');
    }).catch(function(e) {
      console.error('数据层初始化失败:', e);
      _showStorageBanner(e && e.message ? e.message : e);
      alert('书虫蛊无法初始化本地数据库：\n' + (e && e.message ? e.message : e) +
        '\n\n教材导入、笔记本保存等功能将不可用。请按上方提示处理（在线版请确认浏览器允许本地存储）。');
      _switchView('message');
    });

    // 返回书架按钮（PDF 工具栏）
    var backShelf = document.getElementById('btnBackShelf');
    if (backShelf) {
      backShelf.addEventListener('click', function() {
        _switchView('shelf');
        if (typeof FileManager !== 'undefined') FileManager.render();
      });
    }
  }

  function _setShelfDrag(active) {
    var hint = document.getElementById('shelfDropHint');
    if (hint) hint.classList.toggle('active', !!active);
  }

  // ---- 标注校准已移至独立脚本 js/calibration-boot.js（inline onclick 触发，最可靠） ----

  function init() {
    // 预热数据层：确保后续所有模块（Notebook/PDF/FileManager）初始化时 DB 已就绪
    DataLayer.init().catch(function(e) { console.warn('数据层初始化失败:', e); });

    document.getElementById('btnSettings').addEventListener('click', openSettings);
    document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
    document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);
    document.getElementById('btnTestConnection').addEventListener('click', testConnection);
    document.getElementById('selectProvider').addEventListener('change', _onProviderChange);
    var btnRst = document.getElementById('btnResetCmdMarkers');
    if (btnRst) btnRst.addEventListener('click', function() {
      document.getElementById('inputCmdOpen').value  = DEFAULT_CMD_OPEN.join(', ');
      document.getElementById('inputCmdClose').value = DEFAULT_CMD_CLOSE.join(', ');
    });
    // ---------- AI 配置对话框 技能启用批量操作按钮 ----------
    var btnAllOn = document.getElementById('btnSkillsEnableAll');
    var btnAllOff = document.getElementById('btnSkillsDisableAll');
    var btnSysOnly = document.getElementById('btnSkillsSystemOnly');
    if (btnAllOn) btnAllOn.addEventListener('click', function() {
      _toggleAllSkillsInSettings(true);
    });
    if (btnAllOff) btnAllOff.addEventListener('click', function() {
      _toggleAllSkillsInSettings(false);
    });
    if (btnSysOnly) btnSysOnly.addEventListener('click', function() {
      _setSkillsToSystemOnlyInSettings();
    });

    PDFReader.init();
    Notebook.init();

    // P3：笔记文件管理器（书级专属空间）初始化
    if (typeof NoteFileManager !== 'undefined' && typeof NoteFileManager.init === 'function') {
      NoteFileManager.init();
    }

    // P2 改造：「参考」按钮改为打开参考资料管理器（支持拖放上传/预览/导入笔记），旧的 file input 兜底保留
    var btnImportRef = document.getElementById('btnImportReference');
    var inputRef = document.getElementById('inputReferenceFile');
    if (btnImportRef) {
      btnImportRef.addEventListener('click', function() {
        if (typeof ReferenceManager !== 'undefined' && typeof ReferenceManager.openModal === 'function') {
          ReferenceManager.openModal();
        } else {
          if (inputRef) inputRef.click(); else alert('参考材料模块未加载');
        }
      });
    }
    if (inputRef) {
      inputRef.addEventListener('change', function() {
        var files = Array.from(inputRef.files || []);
        if (!files.length) return;
        inputRef.value = '';
        if (typeof ReferenceManager === 'undefined') { alert('参考材料模块未加载'); return; }
        var nb = (typeof Notebook !== 'undefined') ? Notebook.getNotebook() : null;
        var bookId = (nb && (nb.pdfId || nb.bookId)) || currentBookId || null;
        if (!bookId) { alert('请先打开一本教材再导入参考材料'); return; }
        Promise.all(files.map(function(f) { return ReferenceManager.import(f, bookId); }))
          .then(function(mats) { alert('已导入参考材料 ' + mats.length + ' 份：\n- ' + mats.map(function(m){return m.name;}).join('\n- ')); })
          .catch(function(e) { alert('导入失败：' + (e && e.message ? e.message : e)); });
      });
    }

    // P3：指令队列 UI 初始化（CommandQueue 在 data-layer 之后加载，DOM 已就绪）
    if (typeof CommandQueue !== 'undefined' && CommandQueue.initUI) {
      CommandQueue.initUI();
    }

    // P7：笔记导出 / 导入 / 打印（蓝图 §8）
    var btnExportZip = document.getElementById('btnExportZip');
    var btnImportZip = document.getElementById('btnImportZip');
    var inputZip = document.getElementById('inputZipFile');
    var btnPrintNote = document.getElementById('btnPrintNote');

    function _currentExportBookId() {
      if (currentBookId) return currentBookId;
      var nb = (typeof Notebook !== 'undefined' && Notebook.getNotebook) ? Notebook.getNotebook() : null;
      return (nb && (nb.pdfId || nb.bookId)) || null;
    }

    if (btnExportZip) {
      var exportPanel = document.getElementById('exportPanel');
      // 2026-08-19：导出选择面板（PDF / 图片 / ZIP）
      function _toggleExportPanel(forceShow) {
        if (!exportPanel) return;
        var show = (forceShow === undefined) ? (exportPanel.style.display === 'none') : !!forceShow;
        if (show) {
          var r = btnExportZip.getBoundingClientRect();
          var pw = exportPanel.offsetWidth || 236;
          exportPanel.style.left = Math.max(8, Math.min(r.left + r.width - pw, (window.innerWidth || 0) - pw - 8)) + 'px';
          exportPanel.style.top = (r.bottom + 6) + 'px';
          exportPanel.style.display = 'flex';
        } else {
          exportPanel.style.display = 'none';
        }
      }
      function _closeExportPanel() { _toggleExportPanel(false); }
      btnExportZip.addEventListener('click', function(e) {
        e.stopPropagation();
        _toggleExportPanel();
      });
      if (exportPanel) {
        exportPanel.addEventListener('click', function(e) { e.stopPropagation(); });
        var optList = exportPanel.querySelectorAll('.export-opt');
        Array.prototype.forEach.call(optList, function(opt) {
          opt.addEventListener('click', function() {
            var kind = opt.getAttribute('data-export');
            _closeExportPanel();
            if (kind === 'pdf' || kind === 'image') {
              if (typeof Notebook === 'undefined' || !Notebook.getCurrentPageId) { alert('笔记模块未加载'); return; }
              var pageId = Notebook.getCurrentPageId();
              if (!pageId) { alert('当前还没有打开的笔记页'); return; }
              if (kind === 'pdf') {
                if (typeof Notebook.exportPageAsPdf !== 'function') { alert('PDF 导出模块未加载'); return; }
                Notebook.exportPageAsPdf(pageId);
              } else {
                if (typeof Notebook.exportPageAsImage !== 'function') { alert('图片导出模块未加载'); return; }
                Notebook.exportPageAsImage(pageId, 'png');
              }
              return;
            }
            // ZIP：整书包备份（原逻辑）
            var bookId = _currentExportBookId();
            if (!bookId) { alert('请先打开一本教材再导出笔记备份'); return; }
            if (typeof FileManager === 'undefined' || !FileManager.exportBookZip) { alert('导出模块未加载'); return; }
            FileManager.exportBookZip(bookId).then(function(r) {
              alert('已导出笔记备份：' + (r && r.fileName ? r.fileName : 'backup.zip'));
            }).catch(function(e) {
              alert('导出失败：' + (e && e.message ? e.message : e));
            });
          });
        });
        document.addEventListener('click', function(e) {
          if (exportPanel.style.display !== 'none') {
            if (exportPanel.contains(e.target)) return;
            if (btnExportZip && btnExportZip.contains(e.target)) return;
            _closeExportPanel();
          }
        });
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') _closeExportPanel();
        });
      }
    }

    if (btnImportZip && inputZip) {
      btnImportZip.addEventListener('click', function() { inputZip.click(); });
      inputZip.addEventListener('change', function() {
        var f = inputZip.files && inputZip.files[0];
        inputZip.value = '';
        if (!f) return;
        if (typeof FileManager === 'undefined' || !FileManager.importBookZip) { alert('导入模块未加载'); return; }
        FileManager.importBookZip(f).then(function(stats) {
          var parts = [];
          if (stats.bookImported) parts.push('教材已恢复');
          parts.push(stats.pagesImported + ' 页笔记（另合并 ' + stats.pagesMerged + ' 页）');
          parts.push(stats.commandsImported + ' 条指令');
          parts.push(stats.referencesImported + ' 份参考材料');
          if (stats.annotationsImported) parts.push('标注已恢复');
          alert('导入完成：' + parts.join('，') + '。');
          if (typeof FileManager !== 'undefined' && FileManager.render) FileManager.render();
        }).catch(function(e) {
          alert('导入失败：' + (e && e.message ? e.message : e));
        });
      });
    }

    if (btnPrintNote) {
      btnPrintNote.addEventListener('click', function() {
        if (typeof Notebook === 'undefined' || !Notebook.printPdf) { alert('打印模块未加载'); return; }
        Notebook.printPdf();
      });
    }


    // 撤销 / 重做（工具栏按钮触发，避免与 contenteditable 原生 Ctrl+Z 冲突）
    var btnUndo = document.getElementById('btnUndo');
    var btnRedo = document.getElementById('btnRedo');
    if (btnUndo) btnUndo.addEventListener('click', function() { Notebook.undo(); });
    if (btnRedo) btnRedo.addEventListener('click', function() { Notebook.redo(); });
    Notebook.onUndoChange(function(undoLen, redoLen) {
      if (btnUndo) btnUndo.disabled = undoLen === 0;
      if (btnRedo) btnRedo.disabled = redoLen === 0;
    });

    // 监听 PDF 翻页，同步笔记页。
    // 注意：真正的翻页（prev/next/jump）由 pdf-reader.js 的 init 绑定负责，
    // 此处只做笔记页同步，切勿再次调用 prevPage/nextPage，否则会重复翻页。
    var prevBtn = document.getElementById('btnPrevPage');
    var nextBtn = document.getElementById('btnNextPage');
    var jumpBtn = document.getElementById('btnJumpPage');
    function _syncNotePage() { _onPdfPageChange(PDFReader.getCurrentPage()); }
    if (prevBtn) prevBtn.addEventListener('click', function() {
      setTimeout(_syncNotePage, 300);
    });
    if (nextBtn) nextBtn.addEventListener('click', function() {
      setTimeout(_syncNotePage, 300);
    });
    if (jumpBtn) jumpBtn.addEventListener('click', function() {
      setTimeout(_syncNotePage, 300);
    });

    document.getElementById('btnViewRead').addEventListener('click', () => _switchView('read'));
    document.getElementById('btnViewNote').addEventListener('click', () => _switchView('note'));
    var btnViewMessage = document.getElementById('btnViewMessage');
    if (btnViewMessage) btnViewMessage.addEventListener('click', () => _switchView('message'));
    var btnViewAttach = document.getElementById('btnViewAttach');
    if (btnViewAttach) btnViewAttach.addEventListener('click', () => _switchView('attach'));
    var btnViewSplit = document.getElementById('btnViewSplit');
    if (btnViewSplit) btnViewSplit.addEventListener('click', () => _switchView('split'));
    var btnViewShelf = document.getElementById('btnViewShelf');
    if (btnViewShelf) btnViewShelf.addEventListener('click', function() {
      _switchView('shelf');
      if (typeof FileManager !== 'undefined') FileManager.render();
    });

    // 安卓端触摸兜底：部分 WebView 不触发 click，用 touchstart 兜底
    var _tabBtns = [
      { id: 'btnViewRead', view: 'read' },
      { id: 'btnViewNote', view: 'note' },
      { id: 'btnViewMessage', view: 'message' },
      { id: 'btnViewAttach', view: 'attach' },
      { id: 'btnViewSplit', view: 'split' },
      { id: 'btnViewShelf', view: 'shelf' }
    ];
    _tabBtns.forEach(function(item) {
      var btn = document.getElementById(item.id);
      if (!btn) return;
      var _touchFired = false;
      btn.addEventListener('touchstart', function(e) {
        _touchFired = true;
        _switchView(item.view);
        if (item.view === 'shelf' && typeof FileManager !== 'undefined') FileManager.render();
        e.preventDefault();
      }, { passive: false });
      // 如果 touchstart 已触发，阻止后续的 click 重复执行
      btn.addEventListener('click', function(e) {
        if (_touchFired) { _touchFired = false; e.preventDefault(); return; }
        _switchView(item.view);
        if (item.view === 'shelf' && typeof FileManager !== 'undefined') FileManager.render();
      });
    });

    // 寄语视图：冷色粒子网络背景动画（仅视图可见时绘制，切走自动暂停）
    _initMessageParticles();

    // 寄语 · 密码门禁初始化
    _initGate();

    // P3-16：附件管理器初始化
    if (typeof AttachmentManager !== 'undefined' && typeof AttachmentManager.init === 'function') {
      AttachmentManager.init();
    }

    // 书虫蛊 · 教材文件管理系统（书架）
    _initShelf();

    // P3-17：书虫 PageAgent 悬浮窗初始化
    if (typeof PageAgent !== 'undefined' && typeof PageAgent.init === 'function') {
      PageAgent.init();
    }

    // 合并所选块（连续文档体验）
    var btnMerge = document.getElementById('btnMergeBlocks');
    if (btnMerge) {
      btnMerge.addEventListener('click', function() {
        var ids = Notebook.getSelectedBlockIds();
        if (ids.length < 2) { alert('请先用 Shift+点击 选中至少两个块再合并'); return; }
        Notebook.mergeSelectedBlocks().catch(function(e) { alert('合并失败: ' + e.message); });
      });
    }

    // PDF 加载完成回调。
    // 注意：笔记本的加载统一由各入口（openBook / 工具栏"打开" / 启动恢复）显式调用
    // Notebook.loadOrCreateNotebook(notebookId, title) 完成，并使用一致的笔记本 ID。
    // 此处不再自行加载笔记本，避免与入口重复加载导致同一 PDF 分裂到两个不同笔记本
    // （书架用 bookId、此处用 'pdf_'+文件名），进而造成笔记分散与互相覆盖。
    PDFReader.onPdfLoaded(function(pdfName, numPages) {
      // 预留：如需在 PDF 加载后做纯 UI 处理可在此扩展，笔记本加载不在此进行。
    });

    // 接线 PDF 划选推送 → Notebook.insertPdfRef
    // v140+：不再按 PDF 页码自动创建笔记页，划选内容直接写入当前打开的笔记页
    PDFReader.onSelection(function(pdfRef, text) {
      Notebook.insertPdfRef(pdfRef, text);
    });

    // ---- 启动时自动加载上次打开的 PDF 和对应笔记 ----
    // 寄语门禁：未解锁时不自动恢复上次阅读，停留在寄语页，需先解锁
    if (!_gateUnlocked()) {
      _switchView('message');
      return;
    }
    DataLayer.init().then(function() {
      // 检查是否有已保存的 PDF
      return DataLayer.get('pdfs', 'current');
    }).then(async function(savedPdf) {
      if (savedPdf && savedPdf.bookId) {
        try {
          // 优先按书架书籍恢复（避免重复存储大体积 Blob）
          var meta = await FileManager.getBook(savedPdf.bookId);
          if (meta) {
            var blobRec = await FileManager.getBookBlob(savedPdf.bookId);
            if (blobRec) {
              currentBookId = savedPdf.bookId;
              if (typeof window !== 'undefined') window.__curBookId = savedPdf.bookId;
              await PDFReader.loadPdfFromBuffer(blobRec.data, meta.name, savedPdf.bookId);
              if (savedPdf.pageProgress && savedPdf.pageProgress > 1) {
                PDFReader.jumpToPage(savedPdf.pageProgress);
              }
              // 先同步 NFM 当前教材，再加载笔记本（让 NFM 决定用哪本笔记）
              if (typeof NoteFileManager !== 'undefined' && typeof NoteFileManager.setCurrentBook === 'function') {
                NoteFileManager.setCurrentBook(savedPdf.bookId, meta.name);
              }
              await Notebook.loadOrCreateNotebook(savedPdf.bookId, meta.name);
              _switchView('read');
              return;
            }
          }
          // 书架书籍缺失时，若仍有持久化 Blob（工具栏"打开"路径），则直接恢复
          if (savedPdf.blob) {
            if (typeof window !== 'undefined') window.__curBookId = savedPdf.bookId || 'standalone';
            await PDFReader.loadPdfFromStorage('current');
            // 先同步 NFM 当前教材，再加载笔记本
            if (typeof NoteFileManager !== 'undefined' && typeof NoteFileManager.setCurrentBook === 'function') {
              NoteFileManager.setCurrentBook(savedPdf.bookId || 'standalone', savedPdf.name || '我的笔记本');
            }
            await Notebook.loadOrCreateNotebook(savedPdf.bookId || 'standalone', savedPdf.name || '我的笔记本');
            _switchView('read');
            return;
          }
        } catch (e) {
          console.warn('启动恢复失败:', e);
        }
      }
      // 无已保存记录或恢复失败：加载独立笔记本
      return Notebook.loadOrCreateNotebook('standalone', '我的笔记本');
    }).catch(function(e) {
      console.warn('启动加载失败:', e);
      return Notebook.loadOrCreateNotebook('standalone', '我的笔记本');
    });

    // 监听块变更 → AI Engine 智能分类与执行
    Notebook.onBlockChange(function(block, changeType) {
      if (changeType === 'command' || changeType === 'focus') {
        var full = Notebook.stripCommandEndMarker(block.content);
        // 提取指令文本：若块内容含多行（笔记 + 指令），取以 / 或 @ai 开头的行
        var cmdText = full;
        var lines = full.split('\n');
        for (var li = lines.length - 1; li >= 0; li--) {
          var line = lines[li].trim();
          if (line.startsWith('/') || line.toLowerCase().startsWith('@ai ')) {
            cmdText = line;
            break;
          }
        }
        if (changeType === 'command') {
          AIEngine.executeCommand(cmdText, null, block.id).catch(function(e) {
            console.error('AI执行失败:', e);
          });
        } else {
          AIEngine.focus(cmdText).catch(function(e) {
            console.error('聚焦失败:', e);
          });
        }
      }
    });

    // ---- Skill 面板 ----
    var btnSkill = document.getElementById('btnSkill');
    if (btnSkill) btnSkill.addEventListener('click', openSkillPanel);
    var btnCloseSkill = document.getElementById('btnCloseSkill');
    if (btnCloseSkill) btnCloseSkill.addEventListener('click', closeSkillPanel);
    // 点击遮罩（弹窗背景）关闭
    var skillModal = document.getElementById('skillModal');
    if (skillModal) skillModal.addEventListener('click', function(e) { if (e.target === skillModal) closeSkillPanel(); });
    var settingsModal = document.getElementById('settingsModal');
    if (settingsModal) settingsModal.addEventListener('click', function(e) { if (e.target === settingsModal) closeSettings(); });
    var btnAddSkillTag = document.getElementById('btnAddSkillTag');
    if (btnAddSkillTag) btnAddSkillTag.addEventListener('click', _addSkillTag);
    var btnResetSkill = document.getElementById('btnResetSkill');
    if (btnResetSkill) btnResetSkill.addEventListener('click', _resetSkill);
    // Tab 切换（技能中心：学习偏好 ↔ 技能库）
    var tabBtns = document.querySelectorAll('.skill-tab-btn');
    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        if (tab) _switchSkillTab(tab);
      });
    });
    // 技能库工具栏按钮
    var btnSkillNew = document.getElementById('btnSkillNew');
    if (btnSkillNew) btnSkillNew.addEventListener('click', _newSkill);
    var btnSkillImport = document.getElementById('btnSkillImport');
    if (btnSkillImport) btnSkillImport.addEventListener('click', _importSkillFile);
    var btnSkillExportAll = document.getElementById('btnSkillExportAll');
    if (btnSkillExportAll) btnSkillExportAll.addEventListener('click', _exportAllSkills);
    // 技能编辑器按钮
    var btnSkillSave = document.getElementById('btnSkillSave');
    if (btnSkillSave) btnSkillSave.addEventListener('click', _saveCurrentSkill);
    var btnSkillDelete = document.getElementById('btnSkillDelete');
    if (btnSkillDelete) btnSkillDelete.addEventListener('click', _deleteCurrentSkill);
    var btnSkillResetBuiltin = document.getElementById('btnSkillResetBuiltin');
    if (btnSkillResetBuiltin) btnSkillResetBuiltin.addEventListener('click', _resetSkillToBuiltin);


    // 初始化 SkillManager
    SkillManager.init().catch(function(e) { console.warn('Skill 初始化失败:', e); });

    // ---- 快捷键 ----
    document.addEventListener('keydown', _onGlobalKeydown);

    // ---- 搜索框 ----
    var searchInput = document.getElementById('inputNotebookSearch');
    if (searchInput) {
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var query = searchInput.value.trim();
          if (query) {
            AIEngine.focus(query).catch(function(err) { console.error('搜索失败:', err); });
          }
        }
      });
    }

    // ---- 分隔条拖拽 ----
    var splitter = document.getElementById('splitter');
    if (splitter) {
      splitter.addEventListener('mousedown', _onSplitterMouseDown);
    }

    // ---- 笔记本目录切换 (Issue 3) ----
    var btnToggleNotebookTOC = document.getElementById('btnToggleNotebookTOC');
    if (btnToggleNotebookTOC) {
      btnToggleNotebookTOC.addEventListener('click', function() {
        Notebook.toggleNotebookTOC();
      });
    }

    // ---- 字体大小和颜色编辑 (Issue 6) ----
    var selectFontSize = document.getElementById('selectFontSize');
    if (selectFontSize) {
      selectFontSize.addEventListener('change', function(e) {
        var fontSize = e.target.value;
        Notebook.applyFontStyle(null, fontSize, undefined).catch(function(err) {
          console.warn('字体大小设置失败:', err);
        });
      });
    }
    var inputFontColor = document.getElementById('inputFontColor');
    if (inputFontColor) {
      inputFontColor.addEventListener('change', function(e) {
        var fontColor = e.target.value;
        Notebook.applyFontStyle(null, undefined, fontColor).catch(function(err) {
          console.warn('字体颜色设置失败:', err);
        });
      });
    }
    var btnResetFont = document.getElementById('btnResetFont');
    if (btnResetFont) {
      btnResetFont.addEventListener('click', function() {
        Notebook.resetFontStyle(null).catch(function(err) {
          console.warn('重置字体样式失败:', err);
        });
        // 重置下拉框和颜色选择器
        if (selectFontSize) selectFontSize.value = '';
        if (inputFontColor) inputFontColor.value = '#5a4a2a';
      });
    }

    // ---- 保存提示 toast ----
    if (!document.getElementById('saveToast')) {
      var toast = document.createElement('div');
      toast.id = 'saveToast';
      toast.className = 'save-toast';
      toast.textContent = '已保存';
      document.body.appendChild(toast);
    }

    // ---- 帮助中心 ----
    if (typeof HelpCenter !== 'undefined') HelpCenter.init();

    // ---- 常驻异步指令队列调度器：setInterval 持续检查待办，按 createdAt 升序逐个消费 ----
    if (typeof CommandQueue !== 'undefined' && CommandQueue.startScheduler) {
      CommandQueue.startScheduler(1500);
    }

    _loadConfig();
  }

  return { init, openSettings, closeSettings, getAIConfig, getCmdMarkers: getCmdMarkers, openSkillPanel, closeSkillPanel };
})();

// 全局错误横幅：任何运行时错误都在页面顶部显示（便于定位问题）
(function() {
  try {
    var bar = document.createElement('div');
    bar.id = 'errBar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b03a2e;color:#fff;font-size:12px;padding:4px 12px;display:none;font-family:Microsoft YaHei,PingFang SC,Noto Sans SC,sans-serif;';
    document.body.appendChild(bar);
    var show = function(text) {
      bar.style.display = 'block';
      bar.textContent = '⚠ ' + text;
      setTimeout(function() { bar.style.display = 'none'; }, 10000);
    };
    window.addEventListener('error', function(e) {
      show('运行时错误: ' + (e.message || 'unknown'));
    });
    window.addEventListener('unhandledrejection', function(e) {
      var reason = e.reason;
      show('Promise 错误: ' + ((reason && reason.message) || String(reason) || 'unknown'));
    });
  } catch (e) { /* ignore */ }
})();

document.addEventListener('DOMContentLoaded', () => AppShell.init());
