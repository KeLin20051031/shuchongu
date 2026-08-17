// Help Center 模块 — 交互式教学引导系统
// 依赖: AppShell (视图切换/设置面板), PDFReader (打开PDF), Notebook (笔记操作)
const HelpCenter = (function() {
  'use strict';

  let currentLesson = 0;
  let isOpen = false;

  // ============================================================
  // 课程数据
  // ============================================================
  const lessons = [
    {
      id: 'intro',
      icon: '🎓',
      title: '认识你的阅读器',
      subtitle: '30秒快速了解界面布局',
      steps: [
        { type: 'text', content: '欢迎来到<strong>书虫蛊</strong>！这是一个集教材文件管理、PDF 阅读、笔记记录、AI 辅助学习于一体的智能阅读器。让我们花几分钟学会它的全部功能。' },
        { type: 'highlight', label: '顶部栏', content: '最上方是<strong>顶部栏</strong>，包含：logo、四个视图切换标签（书架/阅读/笔记/附件）、使用教程按钮（❓）、学习偏好按钮（🎯）、AI配置按钮（⚙）。' },
        { type: 'highlight', label: '三视图', content: '<strong>阅读视图</strong>：全屏显示 PDF，适合沉浸阅读。<strong>笔记视图</strong>：全屏显示笔记本，适合整理笔记。<strong>分栏视图</strong>：左边 PDF、右边笔记，边读边记。' },
        { type: 'highlight', label: '可拖拽', content: '在分栏视图下，<strong>中间的分隔条可以拖拽</strong>，自由调整 PDF 和笔记的宽度比例。' },
        { type: 'tip', content: '提示：最常用的模式是<strong>分栏视图</strong>，可以一边看教材一边做笔记。' }
      ],
      action: { label: '切换到分栏视图体验', command: 'switchSplit' }
    },
    {
      id: 'open-pdf',
      icon: '📂',
      title: '导入并打开第一本教材',
      subtitle: '从书架导入并阅读 PDF 教材',
      steps: [
        { type: 'text', content: '教材从<strong>书架</strong>统一管理：导入、搜索、分类、打开都在书架完成。' },
        { type: 'step', num: 1, content: '点击顶部导航的 <strong>「📚 书架」</strong> 标签，进入书架视图。' },
        { type: 'step', num: 2, content: '点击 <strong>「📥 导入书籍」</strong> 按钮，选择你的 PDF 教材文件（可多选）。' },
        { type: 'step', num: 3, content: '导入成功后，在书架网格中<strong>点击书籍封面</strong>即可打开阅读。' },
        { type: 'tip', content: '提示：PDF 文件会<strong>自动保存到浏览器本地存储</strong>，下次打开阅读器时依然可用；也可直接拖拽 PDF 文件到书架区域导入。' }
      ],
      action: { label: '切换到书架视图', command: 'switchShelf' }
    },
    {
      id: 'navigate',
      icon: '📑',
      title: '高效阅读导航',
      subtitle: '翻页、跳转、缩放、目录',
      steps: [
        { type: 'text', content: '阅读时你需要频繁翻页和定位，以下是所有导航方式：' },
        { type: 'highlight', label: '翻页', content: '点击工具栏的 <strong>◀ ▶</strong> 按钮可以上一页/下一页；在阅读视图下也可直接按键盘 <strong>← / →</strong> 或 <strong>PageUp / PageDown</strong> 翻页，双手无需离开键盘。' },
        { type: 'highlight', label: '跳转', content: '在页码输入框中输入数字，点击<strong>「跳转」</strong>按钮可直接跳到指定页。' },
        { type: 'highlight', label: '缩放', content: '通过缩放下拉菜单选择<strong>适合宽度</strong>或 50%~200% 的固定缩放比例。' },
        { type: 'highlight', label: '目录', content: '点击<strong>「📑 目录」</strong>按钮，左侧会弹出 PDF 章节目录。点击任意章节标题即可<strong>快速跳转</strong>到该章节。' },
        { type: 'tip', content: '提示：「适合宽度」是最常用的缩放模式，PDF 会自动填满阅读区宽度。' }
      ]
    },
    {
      id: 'note-edit',
      icon: '✏',
      title: '笔记编辑基础',
      subtitle: '创建、编辑、删除笔记块',
      steps: [
        { type: 'text', content: '笔记采用<strong>块级编辑</strong>模式，每个笔记块是独立的编辑单元，类似 Notion。' },
        { type: 'step', num: 1, content: '点击笔记工具栏的 <strong>「＋ 新建」</strong> 按钮创建一个空白笔记块。' },
        { type: 'step', num: 2, content: '在块中<strong>直接输入文字</strong>即可记录笔记。' },
        { type: 'step', num: 3, content: '按 <strong>Enter</strong> 键创建新块，光标自动移到新块。' },
        { type: 'step', num: 4, content: '在空块中按 <strong>Backspace</strong> 键删除该块，光标回到上一个块。' },
        { type: 'highlight', label: '按页管理', content: '笔记按<strong>页</strong>组织，与 PDF 页码对应。翻页 PDF 时，笔记页会自动同步。' },
        { type: 'tip', content: '提示：笔记内容会<strong>实时自动保存</strong>，无需手动操作。也可以按 Ctrl+S 手动触发保存提示。' }
      ],
      action: { label: '创建第一个笔记块', command: 'newBlock' }
    },
    {
      id: 'pdf-excerpt',
      icon: '📎',
      title: '从 PDF 摘录内容',
      subtitle: '划选文本推送到笔记',
      steps: [
        { type: 'text', content: '阅读时遇到重要内容，可以直接从 PDF 摘录到笔记中。' },
        { type: 'step', num: 1, content: '首先切换到 <strong>分栏视图</strong>（点击顶部的「分栏」标签）。' },
        { type: 'step', num: 2, content: '在左侧 PDF 页面上，用鼠标<strong>划选文本</strong>（按住左键拖动选择）。' },
        { type: 'step', num: 3, content: '选中文本后，选区上方会弹出 <strong>「推送到笔记」</strong> 按钮。' },
        { type: 'step', num: 4, content: '点击该按钮，选中的文本会<strong>自动出现在右侧笔记区</strong>，并带有 PDF 页码标记。' },
        { type: 'tip', content: '提示：推送的笔记块左侧有<strong>蓝色边条</strong>和页码角标，方便追溯来源。' }
      ],
      action: { label: '切换到分栏视图', command: 'switchSplit' }
    },
    {
      id: 'ai-config',
      icon: '⚙',
      title: '配置 AI 助手',
      subtitle: '连接你的 AI API',
      steps: [
        { type: 'text', content: 'AI 助手是这个阅读器的核心功能之一。使用前需要配置 AI API 密钥。' },
        { type: 'step', num: 1, content: '点击顶部栏右侧的 <strong>⚙ 按钮</strong>打开 AI 配置面板。' },
        { type: 'step', num: 2, content: '选择 AI 厂商：<strong>OpenAI</strong>、<strong>DeepSeek</strong>、<strong>豆包</strong> 或 <strong>硅基流动</strong>。' },
        { type: 'step', num: 3, content: '填入你的 <strong>API Key</strong>（如 sk-xxx 格式）。' },
        { type: 'step', num: 4, content: 'Base URL 会自动填充默认值，也可自定义。' },
        { type: 'step', num: 5, content: '点击 <strong>「测试连接」</strong> 验证配置是否正确。如果连接失败，会显示具体原因（如 Key 无效、地址错误、超时等）。' },
        { type: 'step', num: 6, content: '点击 <strong>「保存」</strong> 完成配置。' },
        { type: 'tip', content: '推荐使用<strong>硅基流动</strong>（注册即送免费额度，支持 Qwen/DeepSeek 等模型）或<strong>DeepSeek</strong>（性价比高，中文能力强）。配置后所有 AI 功能即可使用。' }
      ],
      action: { label: '打开 AI 配置', command: 'openSettings' }
    },
    {
      id: 'ai-commands',
      icon: '🤖',
      title: 'AI 指令大全',
      subtitle: '总结、翻译、生成笔记、读PDF',
      steps: [
        { type: 'text', content: '配置好 AI 后，在笔记区输入<strong>特定格式</strong>的文字即可触发 AI 操作。系统会自动识别你的输入意图。' },
        { type: 'command-table' },
        { type: 'highlight', label: '操作目标', content: 'AI 会自动确定操作目标：<strong>选中的笔记块</strong> > <strong>当前页所有笔记</strong>。也可以在指令中指定「第N页」「这一章」等。' },
        { type: 'highlight', label: '流式输出', content: 'AI 回答会<strong>实时流式显示</strong>在笔记区，像打字机一样逐字出现。生成的内容带有蓝色 AI 标记。' },
        { type: 'tip', content: '示例：输入 <code>/总结</code> 后等待2秒，AI 会自动总结当前笔记页的内容。也可以输入 <code>@ai 解释一下光合作用</code> 来提问。' }
      ]
    },
    {
      id: 'hl-layer',
      icon: '✏️',
      title: '划重点层：手动标注',
      subtitle: '高亮 / 下划线 / 框选 / 便签',
      steps: [
        { type: 'text', content: '在 PDF 工具栏的<strong>标注区</strong>（标签为「标注」），你可以用 6 种工具在教材上直接做笔记：高亮、下划线、矩形框、钢笔手绘、解释卡片、文本选择。' },
        { type: 'highlight', label: '高亮 🖍', content: '点击 <strong>🖍</strong> 后在页面上拖动，即可划出半透明高亮；旁边的 <strong>高亮配置</strong> 面板可调颜色、透明度（点「应用」生效）。' },
        { type: 'highlight', label: '下划线 ﹏ / 矩形框 ⬜', content: '分别用 <strong>﹏</strong> 和 <strong>⬜</strong> 在文本上拖动创建，配置面板支持线型、粗细、边框样式等。' },
        { type: 'highlight', label: '钢笔手绘 🖊', content: '点击 <strong>🖊</strong> 后自由手绘，适合圈画、连线。' },
        { type: 'highlight', label: '解释卡片 📝', content: '点击 <strong>📝</strong> 后在页面上拖出卡片区域，<strong>双击卡片文本区</strong>即可直接输入笔记内容（原地出现光标，无弹窗），Esc / Ctrl+Enter / 点击别处保存。' },
        { type: 'highlight', label: '文本选择 📋', content: '点击 <strong>📋</strong> 进入文本选择模式：此时标注层完全放行，你可以<strong>自由划选 PDF 文本</strong>，选区上方出现「推送到笔记」按钮。' },
        { type: 'highlight', label: '统一编辑 ✎', content: '点击 <strong>✎</strong> 进入统一编辑模式：可点击/框选已有标注，选中后拖拽移动、四角缩放，<strong>Delete</strong> 删除，Ctrl+点击多选。' },
        { type: 'tip', content: '提示：配置面板的标题栏可以<strong>拖拽移动位置</strong>，位置会被记住。所有标注自动按页码保存。' }
      ]
    },
    {
      id: 'focus-search',
      icon: '🔍',
      title: '聚焦搜索',
      subtitle: '快速定位笔记和 PDF 内容',
      steps: [
        { type: 'text', content: '当笔记越来越多时，聚焦搜索帮你快速找到需要的内容。' },
        { type: 'highlight', label: '搜索框', content: '笔记工具栏右侧有一个<strong>搜索框</strong>。输入关键词后按 <strong>Enter</strong> 即可搜索。' },
        { type: 'highlight', label: '快捷键', content: '按 <strong>Ctrl+F</strong> 可快速聚焦到搜索框。' },
        { type: 'highlight', label: '双模识别', content: '在笔记块中输入包含<strong>「找到」「定位」「查找」「搜索」</strong>等关键词的文字，系统会自动识别为聚焦搜索指令。' },
        { type: 'highlight', label: '搜索范围', content: '搜索会同时查找<strong>所有笔记内容</strong>和<strong>当前 PDF 页文本</strong>。' },
        { type: 'highlight', label: '多结果', content: '找到多个匹配时，会列出所有结果供你选择。唯一匹配会自动聚焦定位。' }
      ]
    },
    {
      id: 'skill',
      icon: '🎯',
      title: '学习偏好系统',
      subtitle: '让 AI 越用越懂你',
      steps: [
        { type: 'text', content: '学习偏好（Skill）系统会<strong>自动记录你的使用习惯</strong>，让 AI 的回答越来越贴合你的需求。' },
        { type: 'highlight', label: '自动记录', content: '每次你使用 AI 指令、聚焦搜索等操作，系统都会<strong>自动记录</strong>到操作历史中。' },
        { type: 'highlight', label: '自动分析', content: '系统会分析你的高频操作和常用主题，<strong>自动生成偏好标签</strong>。例如你经常搜索「数学公式」，就会自动生成对应标签。' },
        { type: 'highlight', label: '上下文注入', content: '偏好标签会<strong>自动注入到 AI 的上下文</strong>中。例如系统知道你常用「总结」功能，AI 回答时会更倾向于结构化总结。' },
        { type: 'highlight', label: '手动管理', content: '点击 🎯 按钮打开偏好面板，可以<strong>查看、添加、删除标签</strong>，也可以重置全部数据。每个标签右侧还有 <strong>− / ＋ 权重按钮</strong>，点击可调整该偏好的权重（权重越高，AI 在生成内容时越优先考虑它）。' },
        { type: 'tip', content: '提示：你用得越多，AI 越懂你。所有偏好数据<strong>仅存储在本地浏览器</strong>，不会上传任何服务器。' }
      ],
      action: { label: '查看学习偏好', command: 'openSkill' }
    },
    {
      id: 'note-advanced',
      icon: '🗂',
      title: '笔记进阶：排序与整理',
      subtitle: '拖拽排序、删除任意块、撤销重做',
      steps: [
        { type: 'text', content: '随着笔记越写越多，你需要重新组织它们的顺序、删除无用块，并在误操作时能挽回。' },
        { type: 'highlight', label: '拖拽排序', content: '鼠标悬停任意笔记块，左上角会出现 <strong>⠿ 拖拽手柄</strong>。按住它上下拖动，松手处会出现<strong>蓝色放置指示线</strong>，落点即新位置。被拖动的块会半透明显示。' },
        { type: 'highlight', label: '上下移动', content: '不想拖拽？用块左侧的 <strong>↑ / ↓ 按钮</strong> 也能逐格移动；处于第一行时 ↑ 自动禁用，处于最后一行时 ↓ 自动禁用，不会越界。' },
        { type: 'highlight', label: '删除任意块', content: '块左侧的 <strong>✕ 按钮</strong> 可删除任意块（含已填写内容的块）；删除非空块时会<strong>弹出确认框</strong>，避免误删。此前只能「在空块按 Backspace」删除。' },
        { type: 'highlight', label: '撤销 / 重做', content: '笔记工具栏的 <strong>↶ 撤销 / ↷ 重做</strong> 按钮可逐步回退或恢复所有块操作（新建、编辑、删除、移动）。无操作历史时按钮自动置灰。' },
        { type: 'tip', content: '提示：撤销/重做针对的是<strong>块的结构操作</strong>，与浏览器原生的 Ctrl+Z（文本输入内的逐字撤销）互不干扰，可放心使用。' }
      ]
    },
    {
      id: 'shortcuts',
      icon: '⌨',
      title: '快捷键速查',
      subtitle: '提升效率的键盘操作',
      steps: [
        { type: 'text', content: '熟练使用快捷键可以大幅提升阅读和笔记效率。' },
        { type: 'shortcut-table' },
        { type: 'tip', content: '提示：标记为「全局」的快捷键在<strong>任何视图下都生效</strong>。笔记编辑快捷键在笔记块内使用，鼠标拖拽在分栏视图下使用。' }
      ]
    }
  ];

  // ============================================================
  // AI 指令表格数据
  // ============================================================
  const aiCommands = [
    { cmd: '/总结', desc: '总结当前笔记页或选中内容', example: '/总结' },
    { cmd: '/翻译', desc: '翻译选中文本（中→英 或 英→中）', example: '/翻译' },
    { cmd: '/回答 你的问题', desc: '让 AI 回答你的问题', example: '/回答 什么是熵增定律？' },
    { cmd: '/生成', desc: '根据当前内容生成学习笔记', example: '/生成' },
    { cmd: '/做笔记', desc: '同上，生成学习笔记', example: '/做笔记' },
    { cmd: '/重组', desc: '将笔记内容重组为要点列表', example: '/重组' },
    { cmd: '/整理', desc: '同上，整理为要点列表', example: '/整理' },
    { cmd: '/读 第N页', desc: 'AI 读取 PDF 指定页并生成笔记', example: '/读 第5页' },
    { cmd: '/读 第N章', desc: 'AI 读取 PDF 指定章节并生成笔记', example: '/读 第3章' },
    { cmd: '@ai 你的问题', desc: '另一种 AI 指令格式', example: '@ai 解释一下牛顿第二定律' }
  ];

  // ============================================================
  // 快捷键数据
  // ============================================================
  const shortcuts = [
    { keys: 'Ctrl + F', desc: '聚焦到笔记搜索框', scope: '全局' },
    { keys: 'Ctrl + S', desc: '手动保存（显示保存提示）', scope: '全局' },
    { keys: 'Ctrl + Enter', desc: '将当前选中的笔记内容发送给 AI', scope: '全局' },
    { keys: '← / → / PageUp / PageDown', desc: '阅读视图下翻页（上一页 / 下一页）', scope: '全局' },
    { keys: 'Esc', desc: '关闭弹窗、面板或帮助中心', scope: '全局' },
    { keys: 'Enter', desc: '在笔记块中创建新块', scope: '笔记编辑' },
    { keys: 'Backspace', desc: '在空笔记块中删除该块', scope: '笔记编辑' },
    { keys: '鼠标拖拽', desc: '拖拽分隔条调整面板比例 / 拖拽笔记块排序', scope: '分栏视图' }
  ];

  // ============================================================
  // DOM 创建辅助
  // ============================================================
  function _el(tag, className, html) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // ============================================================
  // 渲染课程内容
  // ============================================================
  function _renderLesson(index) {
    var lesson = lessons[index];
    var body = document.getElementById('helpLessonBody');
    if (!body) return;

    body.innerHTML = '';

    // 课程标题区
    var header = _el('div', 'help-lesson-header');
    header.appendChild(_el('span', 'help-lesson-icon', lesson.icon));
    var titleWrap = _el('div', 'help-lesson-title-wrap');
    titleWrap.appendChild(_el('h2', 'help-lesson-title', lesson.title));
    titleWrap.appendChild(_el('p', 'help-lesson-subtitle', lesson.subtitle));
    header.appendChild(titleWrap);
    body.appendChild(header);

    // 进度条
    var progress = _el('div', 'help-progress-bar');
    var fill = _el('div', 'help-progress-fill');
    fill.style.width = ((index + 1) / lessons.length * 100) + '%';
    progress.appendChild(fill);
    body.appendChild(progress);

    var progressText = _el('div', 'help-progress-text', '第 ' + (index + 1) + ' / ' + lessons.length + ' 课');
    body.appendChild(progressText);

    // 步骤内容
    var stepsContainer = _el('div', 'help-steps');
    for (var i = 0; i < lesson.steps.length; i++) {
      stepsContainer.appendChild(_renderStep(lesson.steps[i], i));
    }
    body.appendChild(stepsContainer);

    // 操作按钮
    if (lesson.action) {
      var actionWrap = _el('div', 'help-action-wrap');
      var btn = _el('button', 'help-action-btn', '▶ ' + lesson.action.label);
      btn.setAttribute('data-command', lesson.action.command);
      btn.addEventListener('click', function() {
        _executeAction(this.getAttribute('data-command'));
      });
      actionWrap.appendChild(btn);
      body.appendChild(actionWrap);
    }

    // 底部导航
    var nav = _el('div', 'help-nav');
    var prevBtn = _el('button', 'help-nav-btn' + (index === 0 ? ' disabled' : ''), index === 0 ? '已是第一课' : '◀ 上一课');
    if (index > 0) {
      prevBtn.addEventListener('click', function() { _goToLesson(index - 1); });
    }
    var nextBtn = _el('button', 'help-nav-btn' + (index === lessons.length - 1 ? ' disabled' : ''), index === lessons.length - 1 ? '已完成全部' : '下一课 ▶');
    if (index < lessons.length - 1) {
      nextBtn.addEventListener('click', function() { _goToLesson(index + 1); });
    }
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    body.appendChild(nav);

    // 更新左侧目录高亮
    _updateSidebarActive(index);
  }

  // ============================================================
  // 渲染单个步骤
  // ============================================================
  function _renderStep(step, index) {
    switch (step.type) {
      case 'text':
        return _el('p', 'help-step-text', step.content);

      case 'step':
        var wrap = _el('div', 'help-step-item');
        var num = _el('span', 'help-step-num', step.num.toString());
        var text = _el('div', 'help-step-content', step.content);
        wrap.appendChild(num);
        wrap.appendChild(text);
        return wrap;

      case 'highlight':
        var hl = _el('div', 'help-highlight-item');
        var label = _el('span', 'help-highlight-label', step.label);
        var desc = _el('div', 'help-highlight-content', step.content);
        hl.appendChild(label);
        hl.appendChild(desc);
        return hl;

      case 'tip':
        var tip = _el('div', 'help-tip-item');
        tip.appendChild(_el('span', 'help-tip-icon', '💡'));
        tip.appendChild(_el('div', 'help-tip-content', step.content));
        return tip;

      case 'command-table':
        return _renderCommandTable();

      case 'shortcut-table':
        return _renderShortcutTable();

      default:
        return _el('p', '', step.content || '');
    }
  }

  // ============================================================
  // 渲染 AI 指令表格
  // ============================================================
  function _renderCommandTable() {
    var wrap = _el('div', 'help-cmd-table-wrap');
    var table = _el('table', 'help-cmd-table');
    var thead = _el('thead');
    thead.innerHTML = '<tr><th>指令格式</th><th>功能说明</th><th>示例</th></tr>';
    table.appendChild(thead);

    var tbody = _el('tbody');
    for (var i = 0; i < aiCommands.length; i++) {
      var cmd = aiCommands[i];
      var tr = _el('tr');
      tr.appendChild(_el('td', 'help-cmd-cell', '<code>' + cmd.cmd + '</code>'));
      tr.appendChild(_el('td', '', cmd.desc));
      tr.appendChild(_el('td', 'help-cmd-example', '<code>' + cmd.example + '</code>'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // ============================================================
  // 渲染快捷键表格
  // ============================================================
  function _renderShortcutTable() {
    var wrap = _el('div', 'help-cmd-table-wrap');
    var table = _el('table', 'help-cmd-table');
    var thead = _el('thead');
    thead.innerHTML = '<tr><th>快捷键</th><th>功能</th><th>适用范围</th></tr>';
    table.appendChild(thead);

    var tbody = _el('tbody');
    for (var i = 0; i < shortcuts.length; i++) {
      var sc = shortcuts[i];
      var tr = _el('tr');
      tr.appendChild(_el('td', 'help-key-cell', '<kbd>' + sc.keys + '</kbd>'));
      tr.appendChild(_el('td', '', sc.desc));
      tr.appendChild(_el('td', 'help-scope-cell', sc.scope));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // ============================================================
  // 渲染左侧课程目录
  // ============================================================
  function _renderSidebar() {
    var sidebar = document.getElementById('helpSidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';

    var title = _el('div', 'help-sidebar-title', '📖 使用教程');
    sidebar.appendChild(title);

    for (var i = 0; i < lessons.length; i++) {
      var item = _el('div', 'help-sidebar-item');
      item.setAttribute('data-index', i);
      item.appendChild(_el('span', 'help-sidebar-icon', lessons[i].icon));
      item.appendChild(_el('span', 'help-sidebar-label', lessons[i].title));
      if (i === currentLesson) item.classList.add('active');
      (function(idx) {
        item.addEventListener('click', function() { _goToLesson(idx); });
      })(i);
      sidebar.appendChild(item);
    }
  }

  // ============================================================
  // 更新目录高亮
  // ============================================================
  function _updateSidebarActive(index) {
    var items = document.querySelectorAll('.help-sidebar-item');
    for (var i = 0; i < items.length; i++) {
      if (i === index) items[i].classList.add('active');
      else items[i].classList.remove('active');
    }
  }

  // ============================================================
  // 跳转到指定课程
  // ============================================================
  function _goToLesson(index) {
    if (index < 0 || index >= lessons.length) return;
    currentLesson = index;
    _renderLesson(index);
    // 滚动到顶部
    var body = document.getElementById('helpLessonBody');
    if (body) body.scrollTop = 0;
  }

  // ============================================================
  // 执行操作按钮指令
  // ============================================================
  function _executeAction(command) {
    switch (command) {
      case 'switchSplit':
        closeHelp();
        if (typeof AppShell !== 'undefined') {
          document.getElementById('btnViewSplit').click();
        }
        break;
      case 'openPdf':
        closeHelp();
        var shelfBtn = document.getElementById('btnViewShelf');
        if (shelfBtn) shelfBtn.click();
        break;
      case 'switchShelf':
        closeHelp();
        var swBtn = document.getElementById('btnViewShelf');
        if (swBtn) swBtn.click();
        break;
      case 'newBlock':
        closeHelp();
        var newBtn = document.getElementById('btnNewBlock');
        if (newBtn) newBtn.click();
        break;
      case 'openSettings':
        closeHelp();
        if (typeof AppShell !== 'undefined') AppShell.openSettings();
        break;
      case 'openSkill':
        closeHelp();
        if (typeof AppShell !== 'undefined') AppShell.openSkillPanel();
        break;
      case 'openHighlight':
        closeHelp();
        var hlBtn = document.getElementById('btnHighlight');
        if (hlBtn) hlBtn.click();
        break;
    }
  }

  // ============================================================
  // 打开帮助中心
  // ============================================================
  function openHelp() {
    var overlay = document.getElementById('helpOverlay');
    if (!overlay) return;
    overlay.classList.add('show');
    isOpen = true;
    _renderSidebar();
    _renderLesson(currentLesson);
  }

  // ============================================================
  // 关闭帮助中心
  // ============================================================
  function closeHelp() {
    var overlay = document.getElementById('helpOverlay');
    if (!overlay) return;
    overlay.classList.remove('show');
    isOpen = false;
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    var btnHelp = document.getElementById('btnHelp');
    if (btnHelp) btnHelp.addEventListener('click', openHelp);

    var btnCloseHelp = document.getElementById('btnCloseHelp');
    if (btnCloseHelp) btnCloseHelp.addEventListener('click', closeHelp);

    // 点击遮罩关闭
    var overlay = document.getElementById('helpOverlay');
    if (overlay) {
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeHelp();
      });
    }

    // ESC 关闭
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && isOpen) closeHelp();
    });
  }

  return {
    init: init,
    openHelp: openHelp,
    closeHelp: closeHelp
  };
})();
