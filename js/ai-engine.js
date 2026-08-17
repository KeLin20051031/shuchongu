// AI Engine 模块 — 分类/执行/聚焦/代理/警觉
// 依赖: AIAdapter (流式AI调用), Notebook (Operation队列), PDFReader (文本提取), AppShell (AI配置)
const AIEngine = (function() {
  'use strict';

  // ---------- 模块状态 ----------
  let activeTaskCount = 0;           // 正在执行的AI任务数（允许并发）
  let taskCompleteCallbacks = [];    // 任务完成回调列表
  let _lastFocusResults = [];        // 暂存聚焦搜索结果

  // ---------- 获取AI配置 ----------
  function _getConfig() {
    if (typeof AppShell !== 'undefined' && AppShell.getAIConfig) {
      return AppShell.getAIConfig();
    }
    return { provider: 'openai', apiKey: '', baseUrl: '', model: '' };
  }

  // 是否已配置可用的 AI 密钥（供 UI 做无密钥降级提示）
  function isConfigured() {
    var c = _getConfig();
    return !!(c && c.apiKey && String(c.apiKey).trim());
  }

  // ---------- 视觉反馈：处理中提示 ----------
  function _showProcessingToast(show) {
    var toast = document.getElementById('aiProcessingToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'aiProcessingToast';
      toast.className = 'ai-processing-toast';
      toast.innerHTML = '<span class="ai-spinner"></span> AI 正在思考中...';
      document.body.appendChild(toast);
    }
    if (show) toast.classList.add('show');
    else toast.classList.remove('show');
  }

  // ============================================================
  // 指令分类器（设计规格 §5.1）
  // ============================================================

  /**
   * 分类用户输入
   * 优先级: 1. 符号指令(/xxx, @ai xxx) → command
   *         2. 定位关键词 → focus
   *         3. 其余 → 交AI后台判断（如配置了API Key）
   * @param {string} input - 用户输入文本
   * @returns {Promise<'note'|'command'|'focus'>}
   */
  async function classify(input) {
    // 第一优先级: 本地符号/关键词检测（零开销）
    var localResult = Notebook.detectInputType(input);
    if (localResult === 'command' || localResult === 'focus') {
      return localResult;
    }

    // 第二优先级: 交AI后台判断（需要API Key）
    var config = _getConfig();
    if (!config.apiKey) {
      return 'note'; // 无API Key时默认为笔记
    }

    try {
      var messages = [
        {
          role: 'system',
          content: '你是一个输入分类器。判断用户输入是以下哪种类型，只返回一个单词：\n' +
            'note - 普通笔记内容（记录、想法、知识点）\n' +
            'command - AI指令（要求AI执行操作，如总结、翻译、解释）\n' +
            'focus - 聚焦导航（要求查找、定位、跳转到某内容）\n' +
            '只返回 note、command 或 focus，不要其他内容。'
        },
        { role: 'user', content: input }
      ];

      var response = await AIAdapter.chat(
        config.provider, config.baseUrl, config.apiKey, messages,
        { model: config.model }
      );
      var result = (response || '').trim().toLowerCase();
      if (result === 'command' || result === 'focus') return result;
      return 'note';
    } catch (e) {
      // AI判断失败时降级为笔记
      return 'note';
    }
  }

  // ============================================================
  // 上下文构建（设计规格 §5.6）
  // ============================================================

  // 扁平化目录，按页码找当前页所在章节（蓝图 §6 Layer 1）
  function _findChapterIdByPage(toc, pageNum) {
    var flat = [];
    (function walk(items) {
      for (var i = 0; i < items.length; i++) {
        flat.push(items[i]);
        if (items[i].children && items[i].children.length) walk(items[i].children);
      }
    })(toc);
    flat.sort(function(a, b) { return (a.pageNum || 0) - (b.pageNum || 0); });
    var best = null;
    for (var i = 0; i < flat.length; i++) {
      if ((flat[i].pageNum || 0) <= pageNum) best = flat[i]; else break;
    }
    return best ? best.id : null;
  }

  /**
   * 构建动态系统提示词
   * 包含: PDF标题+当前页+当前页文本(OCR/文本层)、当前笔记页内容、可用操作列表
   * 注意: 此函数为 async，因为需要异步提取 PDF 页面文本
   * @param {object} options - { includePdfContext: bool }
   * @returns {Promise<string>} 系统提示词
   */
  async function _buildContext(options) {
    options = options || {};
    var parts = [];

    parts.push('你是一个教材阅读器的AI助手。你的回答会被直接写入用户的笔记本，因此必须像一份"可直接复习的学习笔记"。\n\n' +
      '你可以：\n' +
      '1. 总结指定内容（summarize）\n' +
      '2. 翻译指定内容（translate）\n' +
      '3. 回答用户问题（answer）\n' +
      '4. 根据PDF内容生成笔记（generate）\n' +
      '5. 重组笔记内容（restructure）\n\n' +
      '笔记风格要求（重要）：\n' +
      '- 采用结构化学习笔记格式：先给 1-2 句核心结论，再分点展开，不要上来就堆砌标题。\n' +
      '- 每个知识点尽量包含：关键词 / 定义 / 例子或场景 / 与前后知识的关联。\n' +
      '- 善用 Markdown：用 ### 做小标题、用表格做对比、用有序/无序列表分点、用 **加粗** 标出关键术语。\n' +
      '- 内容紧凑：段落之间最多保留一个空行；列表项之间不要插入空行；禁止连续三个以上空行。\n' +
      '- 不要输出"根据你的笔记/在你的笔记中/下面是我为你整理的"这类废话，直接给出笔记内容。\n' +
      '- 当内容适合对比时，优先使用表格而不是大段文字。\n' +
      '- 每页笔记末尾可加 2-3 个「自检问题」帮助复习，格式为：> 自检：问题？\n' +
      '重要：你无法直接看到PDF图像，但系统会自动提供当前PDF页面的文本内容供你参考。');

    // 当前笔记页内容（含指令位置语境：前后文完整传入，便于 AI 衔接输出）
    if (typeof Notebook !== 'undefined') {
      var notebook = Notebook.getNotebook();
      var currentPageId = Notebook.getCurrentPageId();
      if (notebook && currentPageId) {
        var blocks = Notebook.getPageBlocks(currentPageId);
        if (blocks && blocks.length > 0) {
          var anchorIdx = -1;
          if (options.anchorBlockId) {
            for (var i = 0; i < blocks.length; i++) {
              if (blocks[i].id === options.anchorBlockId) { anchorIdx = i; break; }
            }
          }
          var ctxLines = [];
          for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            var content = (b.content || '');
            var marker = '[' + (i + 1) + ']';
            if (i === anchorIdx) {
              ctxLines.push(marker + ' ← 你将被插入到此块之后（用户在这里输入指令）');
              ctxLines.push('     内容：' + content.substring(0, 500));
              continue;
            }
            // 指令位置前后 2 块完整传入，其余块摘要
            var near = anchorIdx >= 0 && i >= anchorIdx - 2 && i <= anchorIdx + 2;
            if (near) {
              ctxLines.push(marker + ' (' + b.type + ')');
              ctxLines.push('     内容：' + content.substring(0, 800));
            } else {
              var oneLine = content.replace(/\n/g, ' ').substring(0, 60);
              ctxLines.push(marker + ' (' + b.type + ') ' + oneLine + (content.length > 60 ? '…' : ''));
            }
          }
          parts.push('当前笔记页内容（[序号] 表示块的位置）：\n' + ctxLines.join('\n'));
          if (anchorIdx >= 0) {
            parts.push('你的新输出将被插入到【第 ' + (anchorIdx + 1) + ' 块之后】。请仔细参考前文与后文内容：\n' +
              '1. 新输出要在逻辑、术语、结构上与前后笔记衔接（承接前文、为后文铺垫）\n' +
              '2. 若需要微调已有笔记块使其适配（如合并段落、重排编号、修正标题），请使用工具 MODIFY_BLOCK（见工具协议）\n' +
              '3. 不要输出"根据你的笔记/在你的笔记中"这类废话，直接给出可插入的笔记内容');
          }
        }
        // Layer 2：当前笔记页 Markdown 原文全文（蓝图 §6，供 AI 把握页面完整正文）
        // 若传入 snapshot，优先使用入队时快照的 noteMd，而非执行时刻的实时正文
        try {
          var pageMd = (options.snapshot && typeof options.snapshot.noteMd === 'string')
            ? options.snapshot.noteMd
            : (Notebook.getPageMd ? Notebook.getPageMd(currentPageId) : '');
          if (pageMd && String(pageMd).trim()) {
            var mdFull = String(pageMd);
            var mdTruncated = mdFull.length > 12000
              ? mdFull.substring(0, 12000) + '\n...(内容过长，已截断)'
              : mdFull;
            parts.push('当前笔记页 Markdown 原文（Layer 2）：\n' + mdTruncated);
          }
        } catch (e) { /* 忽略 mdContent 读取失败 */ }
      }
    }

    // 当前PDF页信息 + 自动提取页面文本（AI 无法读图，需文本层降级）
    // 若传入 options.snapshot（异步队列入队时快照），优先使用快照中的页号/章节文本/页文本，
    // 而非执行时刻的实时状态，保证「基于入队时 PDF 状态执行」。
    if (options.includePdfContext) {
      var snap = options.snapshot || null;
      var pageNum = (snap && snap.pageNum > 0)
        ? snap.pageNum
        : (typeof PDFReader !== 'undefined' && PDFReader.getCurrentPage ? PDFReader.getCurrentPage() : 0);
      if (pageNum > 0) {
        parts.push('用户当前正在阅读PDF第' + pageNum + '页。');
        // Layer 1：当前页所在章节完整文本（蓝图 §6，优先提供章节全貌）
        var chapterText = (snap && typeof snap.chapterText === 'string') ? snap.chapterText : '';
        if (chapterText && chapterText.trim()) {
          var ct = String(chapterText);
          var ctTrunc = ct.length > 8000 ? ct.substring(0, 8000) + '\n...(章节内容过长，已截断)' : ct;
          parts.push('当前章节完整文本（Layer 1）：\n' + ctTrunc);
        } else if (typeof PDFReader !== 'undefined' && PDFReader.getTOC) {
          try {
            var toc = await PDFReader.getTOC();
            if (toc && toc.length) {
              var chapterId = _findChapterIdByPage(toc, pageNum);
              if (chapterId) {
                var rtChapterText = await PDFReader.getChapterText(chapterId);
                if (rtChapterText && rtChapterText.trim()) {
                  var rtCt = String(rtChapterText);
                  var rtCtTrunc = rtCt.length > 8000 ? rtCt.substring(0, 8000) + '\n...(章节内容过长，已截断)' : rtCt;
                  parts.push('当前章节完整文本（Layer 1）：\n' + rtCtTrunc);
                }
              }
            }
          } catch (e) { /* 章节提取失败不影响主流程 */ }
        }
        // 当前页文本：优先快照 pageText
        var pageText = (snap && typeof snap.pageText === 'string') ? snap.pageText : '';
        if (pageText && pageText.trim()) {
          // 截取前3000字符避免超出上下文
          var truncated = pageText.length > 3000
            ? pageText.substring(0, 3000) + '\n...(内容过长，已截断)'
            : pageText;
          parts.push('当前PDF页面文本内容（供你参考）：\n' + truncated);
        } else if (typeof PDFReader !== 'undefined' && PDFReader.getCurrentPage) {
          try {
            // 检测是否有文本层
            var hasText = await PDFReader.hasTextLayer(pageNum);
            if (hasText) {
              var rtPageText = await PDFReader.getPageText(pageNum);
              if (rtPageText && rtPageText.trim()) {
                // 截取前3000字符避免超出上下文
                var rtTruncated = rtPageText.length > 3000
                  ? rtPageText.substring(0, 3000) + '\n...(内容过长，已截断)'
                  : rtPageText;
                parts.push('当前PDF页面文本内容（供你参考）：\n' + rtTruncated);
              }
            } else {
              parts.push('注意：当前PDF页面没有可提取的文本层（可能是扫描件/图片），你无法获取该页文字内容。请告知用户该页可能需要OCR处理。');
            }
          } catch (e) {
            parts.push('注意：提取PDF页面文本时出错，无法提供页面内容。');
          }
        }
      }
    }

    // Layer 3：关联参考材料 MD（蓝图 §6 / §7，经 ReferenceManager 检索）
    if (typeof ReferenceManager !== 'undefined' && ReferenceManager.getByBook) {
      try {
        var refBookId = options.bookId || null;
        if (!refBookId && options.snapshot && (options.snapshot.bookId || options.snapshot.pdfId)) {
          refBookId = options.snapshot.bookId || options.snapshot.pdfId;
        }
        if (!refBookId && typeof Notebook !== 'undefined') {
          var _nb = Notebook.getNotebook();
          if (_nb && (_nb.pdfId || _nb.bookId)) refBookId = _nb.pdfId || _nb.bookId;
        }
        if (refBookId) {
          var refMd = await ReferenceManager.getByBook(refBookId);
          if (refMd && String(refMd).trim()) {
            var rFull = String(refMd);
            var rTrunc = rFull.length > 12000 ? rFull.substring(0, 12000) + '\n...(参考材料内容过长，已截断)' : rFull;
            parts.push('关联参考材料（Layer 3）：\n' + rTrunc);
          }
        }
      } catch (e) { /* 参考材料检索失败不影响主流程 */ }
    }

    // Skill 偏好（设计规格 §9）
    if (typeof SkillManager !== 'undefined' && SkillManager.getContextString) {
      var skillContext = SkillManager.getContextString();
      if (skillContext) {
        parts.push(skillContext);
      }
    }

    return parts.join('\n\n');
  }

  // ============================================================
  // 命令解析（设计规格 §5.2）
  // ============================================================

  /**
   * 解析指令文本，提取命令类型和参数
   * @param {string} text - 用户输入（如 "/总结..." "@ai 翻译这段..."）
   * @returns {{ type: string, raw: string, args: string }}
   */
  function _parseCommand(text) {
    var raw = (text || '').trim();
    // 去除前缀 /、@ai 或 、、
    var cmd = raw.replace(/^\/+/, '').replace(/^@ai\s+/i, '').replace(/^、、/, '').trim();
    // 去除结尾的 "..." 或 "。。。" 指令结束标志
    if (typeof Notebook !== 'undefined' && Notebook.stripCommandEndMarker) {
      cmd = Notebook.stripCommandEndMarker(cmd);
    } else {
      cmd = cmd.replace(/\.{3}$|。{3}$/, '').trim();
    }

    // 识别命令类型
    var typeMap = {
      '总结': 'summarize', 'summarize': 'summarize', '摘要': 'summarize',
      '翻译': 'translate', 'translate': 'translate',
      '回答': 'answer', 'answer': 'answer', '问': 'answer',
      '生成': 'generate', 'generate': 'generate', '做笔记': 'generate', '记笔记': 'generate',
      '重组': 'restructure', 'restructure': 'restructure', '整理': 'restructure',
      '读': 'read-pdf', 'read': 'read-pdf'
    };

    var type = 'answer'; // 默认类型
    var args = cmd;
    for (var keyword in typeMap) {
      if (cmd.startsWith(keyword)) {
        type = typeMap[keyword];
        args = cmd.slice(keyword.length).trim();
        break;
      }
    }

    return { type: type, raw: raw, args: args };
  }

  /**
   * 解析操作目标 — 确定AI要操作哪部分笔记/PDF
   * @param {string} args - 命令参数
   * @returns {{ blocks: array, pdfText: string|null, scope: string }}
   */
  function _resolveTarget(args) {
    var blocks = [];
    var pdfText = null;
    var scope = 'current-page';

    // 1. 显式引用: "选中的内容"
    // 跳过 command/focus 类型（指令块本身不应作为操作目标）
    var selection = Notebook.getSelection();
    if (selection && selection.type !== 'command' && selection.type !== 'focus') {
      blocks = [selection];
      scope = 'selection';
      return { blocks: blocks, pdfText: pdfText, scope: scope };
    }

    // 2. 显式引用: "第N页" — 读取PDF指定页文本
    var pageMatch = args.match(/第\s*(\d+)\s*页/);
    if (pageMatch) {
      scope = 'pdf-page';
      return { blocks: blocks, pdfText: null, scope: scope, pdfPageNum: parseInt(pageMatch[1], 10) };
    }

    // 3. 显式引用: 章节相关 — "这一章" / "当前章" / "第X章" / "本章" / "章节"
    var chapterMatch = args.match(/第\s*(\d+|[一二三四五六七八九十百]+)\s*章/);
    if (chapterMatch || args.includes('这一章') || args.includes('当前章') || args.includes('本章') || args.includes('章节') || args.includes('整个章')) {
      scope = 'pdf-chapter';
      return { blocks: blocks, pdfText: null, scope: scope, chapterNum: chapterMatch ? chapterMatch[1] : null };
    }

    // 4. 显式引用: "上面的笔记" / "上面的"
    if (args.includes('上面') || args.includes('以上') || args.includes('前面')) {
      var pageBlocks = Notebook.getPageBlocks(Notebook.getCurrentPageId());
      blocks = pageBlocks.slice(Math.max(0, pageBlocks.length - 5));
      scope = 'recent-blocks';
      return { blocks: blocks, pdfText: pdfText, scope: scope };
    }

    // 5. 隐式: 当前页所有块
    var currentPageId = Notebook.getCurrentPageId();
    if (currentPageId) {
      blocks = Notebook.getPageBlocks(currentPageId);
    }

    return { blocks: blocks, pdfText: pdfText, scope: scope };
  }

  // ---------- 中文数字解析 ----------
  function _parseChineseNumber(str) {
    if (!str) return 0;
    // 纯数字
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    // 中文数字
    var map = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'百':100 };
    var result = 0;
    var temp = 0;
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '十') {
        result += (temp === 0 ? 1 : temp) * 10;
        temp = 0;
      } else if (ch === '百') {
        result += (temp === 0 ? 1 : temp) * 100;
        temp = 0;
      } else if (map[ch]) {
        temp = map[ch];
      }
    }
    result += temp;
    return result;
  }

  // ============================================================
  // 笔记修改命令执行（AI 真正修改已有笔记，而非仅输出建议）
  // ============================================================

  /**
   * 检测是否为"修改类"命令
   * restructure 类型，或参数含修改/删除/调整等关键词
   * @param {object} parsed - _parseCommand 的返回
   * @returns {boolean}
   */
  function _isModifyCommand(parsed) {
    if (!parsed) return false;
    if (parsed.type === 'restructure') return true;
    var modifyKeywords = [
      '修改', '改写', '更新', '删除', '去掉', '移除', '调整', '合并', '拆分',
      '替换', '精简', '扩写', '润色', '整理成', '改成', '改为', '重写', '修订',
      '清除', '清空', '清理', '删掉', '删除所有', '清除所有', '清空所有', '全部删除',
      '移除所有', '删除本页', '清除本页'
    ];
    var args = parsed.args || '';
    for (var i = 0; i < modifyKeywords.length; i++) {
      if (args.indexOf(modifyKeywords[i]) >= 0) return true;
    }
    return false;
  }

  /**
   * 从 AI 输出中提取 JSON（支持 ```json 代码块、前后噪声、裸 JSON、未转义引号、尾随逗号、截断）
   * @param {string} text
   * @returns {object|null}
   */
  function _extractJson(text) {
    if (!text) return null;
    text = String(text).trim();

    // 去除 Markdown 代码块标记（可能带 json 语言标签）
    var cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    // 快速路径：整段就是合法 JSON（包括裸数组）
    try {
      var direct = JSON.parse(cleaned);
      if (direct && typeof direct === 'object') {
        if (Array.isArray(direct)) return { annotations: direct };
        return direct;
      }
    } catch (e) {}

    // 处理只返回数组的情况 [{...}, {...}]
    var arrStart = cleaned.indexOf('[');
    var arrEnd = cleaned.lastIndexOf(']');
    var objStart = cleaned.indexOf('{');
    if (arrStart >= 0 && (objStart < 0 || arrStart < objStart) && arrEnd > arrStart) {
      try {
        var arr = JSON.parse(cleaned.substring(arrStart, arrEnd + 1));
        if (Array.isArray(arr)) return { annotations: arr };
      } catch (e) {}
    }

    var start = cleaned.indexOf('{');
    if (start < 0) return null;

    var body = cleaned.substring(start);

    // 尝试找结构平衡的闭合点
    var balancedEnd = _findBalancedClose(body);
    if (balancedEnd > 0) {
      var result = _tryParseJson(body.substring(0, balancedEnd + 1));
      if (result) return result;
    }

    // 截断修复：从后往前找可解析的截断点
    var idx = body.lastIndexOf('}');
    var seen = 0;
    while (idx >= 0 && seen < 10) {
      var result = _tryParseJson(body.substring(0, idx + 1));
      if (result) return result;
      idx = body.lastIndexOf('}', idx - 1);
      seen++;
    }

    // 括号补全
    var completed = _completeBrackets(body);
    if (completed) return completed;

    // 最后兜底：逐条提取 annotation 对象
    var fallback = _extractAnnotationsFallback(body);
    if (fallback && fallback.annotations.length > 0) return fallback;

    return null;
  }

  // 找第一个结构平衡的 } 位置（括号深度归零）
  function _findBalancedClose(str) {
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth === 0 && i > 0) return i;
    }
    return -1;
  }

  // 尝试多种常见修复后解析 JSON
  function _tryParseJson(jsonStr) {
    jsonStr = jsonStr.trim();
    if (!jsonStr) return null;

    var attempts = [jsonStr];

    // 修复尾随逗号
    var fixed = jsonStr
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/,\s*$/g, '');
    if (fixed !== jsonStr) attempts.push(fixed);

    // 修复单引号键/值
    var singleQuoteFixed = fixed
      .replace(/([{,]\s*)'([^']*?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'/g, ':"$1"');
    if (singleQuoteFixed !== fixed) attempts.push(singleQuoteFixed);

    // 修复未转义的内部双引号
    var quoteRepaired = _repairUnescapedQuotes(fixed);
    if (quoteRepaired !== fixed) attempts.push(quoteRepaired);

    for (var i = 0; i < attempts.length; i++) {
      try {
        var parsed = JSON.parse(attempts[i]);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed)) return { annotations: parsed };
          return parsed;
        }
      } catch (e) {}
    }
    return null;
  }

  // 修复字符串中未转义的内部双引号
  function _repairUnescapedQuotes(str) {
    var result = '';
    var inString = false;
    var escaped = false;
    var stringStartIndex = -1;
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        if (!inString) {
          inString = true;
          stringStartIndex = result.length;
          result += ch;
        } else {
          // 空字符串直接允许闭合
          if (result.length === stringStartIndex + 1) {
            inString = false;
            result += ch;
            continue;
          }
          // 跳过空白，看下一个有效字符是否为 JSON 分隔符
          var j = i + 1;
          while (j < str.length && /\s/.test(str[j])) j++;
          var next = str[j];
          if (next === ',' || next === ':' || next === '}' || next === ']' || next === undefined) {
            inString = false;
            result += ch;
          } else {
            // 未转义的内部引号，补反斜杠
            result += '\\' + ch;
          }
        }
        continue;
      }
      result += ch;
    }
    return result;
  }

  // 补齐缺失的 ] }
  function _completeBrackets(body) {
    try {
      var openB = (body.match(/\{/g) || []).length;
      var closeB = (body.match(/\}/g) || []).length;
      var openA = (body.match(/\[/g) || []).length;
      var closeA = (body.match(/\]/g) || []).length;
      var repaired = body;
      if (closeA < openA) repaired += ']'.repeat(openA - closeA);
      if (closeB < openB) repaired += '}'.repeat(openB - closeB);
      var parsed = JSON.parse(repaired);
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed)) return { annotations: parsed };
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  // 兜底：从混乱文本中逐条提取 annotation 对象（字段顺序必须与 prompt 一致）
  function _extractAnnotationsFallback(body) {
    var annotations = [];
    // 字段顺序：page, quote, type, color, symbol, label, reason
    var regex = /\{\s*"page"\s*:\s*(\d+)\s*,\s*"quote"\s*:\s*"((?:\\.|[^"\\])*?)"\s*,\s*"type"\s*:\s*"((?:\\.|[^"\\])*?)"\s*,\s*"color"\s*:\s*"((?:\\.|[^"\\])*?)"\s*,\s*"symbol"\s*:\s*"((?:\\.|[^"\\])*?)"\s*,\s*"label"\s*:\s*"((?:\\.|[^"\\])*?)"\s*,\s*"reason"\s*:\s*"((?:\\.|[^"\\])*?)"\s*\}/g;
    var match;
    while ((match = regex.exec(body)) !== null) {
      annotations.push({
        page: parseInt(match[1], 10),
        quote: _unescapeJsonString(match[2]),
        type: _unescapeJsonString(match[3]),
        color: _unescapeJsonString(match[4]),
        symbol: _unescapeJsonString(match[5]),
        label: _unescapeJsonString(match[6]),
        reason: _unescapeJsonString(match[7])
      });
    }
    return annotations.length > 0 ? { annotations: annotations } : null;
  }

  function _unescapeJsonString(s) {
    if (!s) return '';
    try {
      return JSON.parse('"' + s + '"');
    } catch (e) {
      return s;
    }
  }

  /**
   * 执行单个笔记操作（对应 Notebook.applyOperation）
   * @param {object} op - { type: 'update'|'delete'|'insert'|'move', target, position, content }
   * @param {array} blocks - 当前页块列表（用于按序号定位）
   * @returns {Promise<boolean>}
   */
  async function _applyNoteOperation(op, blocks) {
    if (!op || !op.type) return false;
    switch (op.type) {
      case 'update': {
        var uBlock = blocks[op.target - 1];
        // 防御：目标不存在或被锁定（AI 处理中）时不操作，避免锁超时
        if (!uBlock || uBlock.lock) return false;
        var uResult = await Notebook.applyOperation({
          type: 'update', source: 'ai',
          targetBlockId: uBlock.id,
          content: op.content || ''
        });
        // 目标块不存在或执行失败时返回 false，避免"假成功"
        return !!uResult;
      }
      case 'delete': {
        var dBlock = blocks[op.target - 1];
        if (!dBlock || dBlock.lock) return false;
        var dResult = await Notebook.applyOperation({
          type: 'delete', source: 'ai', targetBlockId: dBlock.id
        });
        return !!dResult;
      }
      case 'insert': {
        var pos = (typeof op.position === 'number') ? op.position - 1 : blocks.length;
        if (pos < 0) pos = 0;
        var iResult = await Notebook.applyOperation({
          type: 'insert', source: 'ai', blockType: 'text',
          content: op.content || '', position: pos,
          options: { aiGenerated: true }
        });
        return !!iResult;
      }
      case 'move': {
        var mBlock = blocks[op.target - 1];
        var toPos = (typeof op.position === 'number') ? op.position - 1 : blocks.length - 1;
        if (!mBlock || mBlock.lock) return false;
        var mResult = await Notebook.applyOperation({
          type: 'move', source: 'ai',
          targetBlockId: mBlock.id, position: toPos
        });
        return !!mResult;
      }
      default:
        return false;
    }
  }

  /**
   * 执行修改类命令：AI 返回结构化操作 JSON，前端真正修改笔记块
   * @param {object} parsed - _parseCommand 的返回
   * @param {string} placeholderId - AI 占位块 ID（可选）
   * @returns {Promise<block|null>}
   */
  async function _executeModifyCommand(parsed, placeholderId) {
    var pageId = Notebook.getCurrentPageId();
    var allBlocks = Notebook.getPageBlocks(pageId);

    // 过滤掉不应被 AI 修改的块：
    // 1. 当前正在执行/锁定的块（status=pending 或 lock=true）——指令块在 markCommandPending
    //    时被锁定（lock=true），若 AI 操作指向它，操作队列会永久等待解锁 → 死锁/锁超时
    // 2. 聚焦块、占位块
    // 注意：指令块的 type 是 'text'（markCommandPending 不改 type），必须用 status/lock 判断；
    // 已完成的旧命令块（status='complete'）保留给 AI，满足"清理旧命令"的需求
    var blocks = [];
    for (var fi = 0; fi < allBlocks.length; fi++) {
      var fb = allBlocks[fi];
      if (fb.status === 'pending' || fb.lock) continue;
      if (fb.type === 'focus' || fb.type === 'ai-placeholder') continue;
      blocks.push(fb);
    }

    if (!blocks || blocks.length === 0) {
      var msgEmpty = '⚠ 当前笔记页没有可修改的内容。';
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, msgEmpty, 'done');
        return await Notebook.finalizeAiPlaceholder(placeholderId);
      }
      return await Notebook.applyOperation({
        type: 'insert', source: 'ai', blockType: 'text',
        content: msgEmpty, options: { aiGenerated: true }
      });
    }

    // 构建带序号的块列表
    var blockList = blocks.map(function(b, i) {
      return (i + 1) + '. [' + b.type + '] ' + (b.content || '').substring(0, 300);
    }).join('\n');

    // 自动获取 PDF 教材上下文（AI 判断页面完整性并增量补页），
    // 让 AI 整理/修改笔记时优先基于教材原文，而非凭知识生成
    var pdfContext = '';
    if (typeof PDFReader !== 'undefined' && PDFReader.getCurrentPage && PDFReader.getCurrentPage() > 0) {
      try {
        pdfContext = await _collectPdfContext(parsed.raw || parsed.args || '');
        // 截断防止上下文过长
        if (pdfContext && pdfContext.length > 12000) {
          pdfContext = pdfContext.substring(0, 12000) + '\n...(PDF 内容过长已截断)';
        }
      } catch (e) { /* ignore */ }
    }

    var config = _getConfig();
    // 系统提示词（含工具协议：AI 可自主调用 GET_PDF_PAGES 获取更多教材页面）
    var baseSystemContent =
      '你是笔记编辑器。用户要求修改其笔记内容。当前笔记块列表如下（每行前为块序号）：\n\n' +
      blockList + '\n\n' +
      (pdfContext
        ? '【PDF 教材参考内容（系统自动从教材获取的原文）】\n' + pdfContext + '\n\n'
        : '') +
      '请根据用户指令，返回一个 JSON 对象（只输出 JSON，不要任何解释文字）：\n' +
      '{\n' +
      '  "reason": "用一句话说明你做了哪些修改",\n' +
      '  "operations": [\n' +
      '    {"type": "update", "target": 块序号, "content": "修改后的完整内容（保留 Markdown 标记）"},\n' +
      '    {"type": "delete", "target": 块序号},\n' +
      '    {"type": "insert", "position": 插入位置序号, "content": "新块内容"},\n' +
      '    {"type": "move", "target": 块序号, "position": 目标位置序号}\n' +
      '  ]\n' +
      '}\n' +
      '规则：\n' +
      '1. update 的 content 必须是该块修改后的完整内容\n' +
      '2. 生成内容时优先依据【PDF 教材参考内容】中的原文；若 PDF 内容不足以覆盖用户请求，再基于医学知识补充，并在 reason 中说明"部分内容基于医学知识"\n' +
      '3. 多个操作按数组顺序执行；插入/删除会改变后续块序号，请从后往前安排操作顺序\n' +
      '4. 不做无意义的修改；若无需修改，operations 返回空数组\n' +
      '5. 只返回 JSON 对象本身\n' +
      '6. 若现有 PDF 教材参考内容不足以覆盖用户请求（如需要整章/多页内容），你【必须】先输出工具调用行获取更多页面：\n' +
      '   GET_PDF_PAGES 页码1,页码2,...（如 GET_PDF_PAGES 190,191,192）\n' +
      '   系统会立即把对应页面文本提供给你，你再基于完整内容返回 JSON 方案。工具调用行不会显示给用户。';

    // 工具轮询 + 格式重试：AI 可先获取更多 PDF 页面，解析失败时自动纠正重试一次
    var toolResultText = '';
    var plan = null;
    var response = '';
    var retriedFormat = false;
    var maxRounds = 4;
    for (var tRound = 0; tRound < maxRounds; tRound++) {
      var messages = [
        { role: 'system', content: baseSystemContent },
        { role: 'user', content: parsed.raw + (toolResultText ? '\n\n【工具调用结果（系统已自动获取的 PDF 页面）】\n' + toolResultText : '') }
      ];
      // 解析失败后的格式纠正提示
      if (retriedFormat) {
        messages.push({
          role: 'system',
          content: '注意：你上一次的输出无法解析为合法的 JSON。这次请只输出一个合法的 JSON 对象：' +
            '不要 ``` 代码块标记、不要任何解释文字、不要工具调用行、不要换行注释。'
        });
      }

      // 流式收集 AI 响应，期间实时显示进度提示，避免用户误以为卡死
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, '⏳ AI 正在分析笔记内容...', 'streaming');
      }
      try {
        var generator = AIAdapter.streamChat(
          config.provider, config.baseUrl, config.apiKey, messages,
          { model: config.model }
        );
        // 流式收集（带进度提示）
        var collectPromise = (async function() {
          var text = '';
          for await (const chunk of generator) {
            if (chunk.reasoningContent && !chunk.content && placeholderId) {
              Notebook.updateAiPlaceholder(placeholderId, '⏳ AI 正在思考修改方案...', 'streaming');
            }
            if (chunk.content) {
              text += chunk.content;
              // 节流更新进度提示（避免每 chunk 更新大文本）
              if (placeholderId && text.length % 300 < 30) {
                Notebook.updateAiPlaceholder(placeholderId, '✍️ AI 正在调整笔记内容...', 'streaming');
              }
            }
            if (chunk.done) break;
          }
          return text;
        })();
        // 整体超时保护（150 秒）：防止流式异常导致永久等待（修改方案可能较长）
        var overallTimeout = new Promise(function(_, reject) {
          setTimeout(function() { reject(new Error('AI 分析超时（150秒），已中止')); }, 150000);
        });
        overallTimeout.catch(function() { /* 防止未处理的 rejection */ });
        response = await Promise.race([collectPromise, overallTimeout]);
      } catch (e) {
        // 流式失败：若有部分内容则尝试解析，否则降级为普通回答
        if (!response) {
          if (placeholderId) {
            Notebook.updateAiPlaceholder(placeholderId, '⚠ AI 请求失败: ' + (e.message || '未知错误'), 'done');
            return await Notebook.finalizeAiPlaceholder(placeholderId);
          }
          return await Notebook.applyOperation({
            type: 'insert', source: 'ai', blockType: 'text',
            content: '⚠ AI 请求失败: ' + (e.message || '未知错误'),
            options: { aiGenerated: true }
          });
        }
      }

      // 检测工具调用：AI 需要更多 PDF 页面（最后一轮不再执行工具，直接尝试解析）
      var toolCalls = _extractToolCalls(response);
      if (toolCalls.length > 0 && tRound < maxRounds - 1) {
        // 执行工具：获取 AI 请求的页面
        toolResultText = await _executeToolCalls(toolCalls);
        if (!toolResultText) {
          // 工具没拿到内容（PDF 未加载/页码无效）：回传失败提示，让 AI 基于已有内容生成方案
          toolResultText = '（工具执行失败：无法提取这些页面的文本，请基于已有内容完成修改方案，不要再调用工具）';
        }
        continue;
      }

      // 解析前先清除可能的工具调用残留行
      plan = _extractJson(response.replace(/GET_PDF_PAGES[^\n]*/g, ''));
      if (plan && Array.isArray(plan.operations)) break;

      // 解析失败：仅自动纠正重试一次
      if (!retriedFormat) {
        retriedFormat = true;
        continue;
      }
      break;
    }

    if (!plan || !Array.isArray(plan.operations)) {
      var fallbackMsg = '⚠ AI 未能生成可执行的修改方案（返回格式异常）。\n请重试，或更具体地描述要修改/删除的内容（例如"删除第2段""把第1段改成..."）。';
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, fallbackMsg, 'done');
        return await Notebook.finalizeAiPlaceholder(placeholderId);
      }
      return await Notebook.applyOperation({
        type: 'insert', source: 'ai', blockType: 'text',
        content: fallbackMsg, options: { aiGenerated: true }
      });
    }

    // 检测：AI 声称已执行删除/修改，但未返回任何实际操作 → 明确警告，防止"说删了但没删"
    if (plan.operations.length === 0 &&
        /已删除|已清除|已移除|已清空|已清理|已修改|已更新|已删除所有|已整理/.test(plan.reason || '')) {
      var fakeMsg = '⚠ AI 声称"已清除/已删除"，但未返回任何实际删除/修改操作。\n请重试，或明确描述要删除/修改的具体内容。';
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, fakeMsg, 'done');
        return await Notebook.finalizeAiPlaceholder(placeholderId);
      }
      return await Notebook.applyOperation({
        type: 'insert', source: 'ai', blockType: 'text',
        content: fakeMsg, options: { aiGenerated: true }
      });
    }

    // 两阶段执行：先展示 Diff 预览（逐行红绿对比），用户确认后才真正修改笔记
    // 传入过滤后的 blocks（与给 AI 的序号列表一致），保证预览与实际执行的目标一致
    var confirmed = false;
    try {
      confirmed = await _showModifyDiff(plan, pageId, blocks);
    } catch (e) {
      console.warn('Diff 预览失败:', e);
      confirmed = false;
    }
    if (!confirmed) {
      var cancelMsg = '已取消修改（AI 的操作方案未经确认）';
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, cancelMsg, 'done');
        return await Notebook.finalizeAiPlaceholder(placeholderId);
      }
      return await Notebook.applyOperation({
        type: 'insert', source: 'ai', blockType: 'text',
        content: cancelMsg, options: { aiGenerated: true }
      });
    }

    // 串行执行操作
    var executed = 0;
    var errors = [];
    for (var i = 0; i < plan.operations.length; i++) {
      try {
        var done = await _applyNoteOperation(plan.operations[i], blocks);
        if (done) executed++;
      } catch (e) {
        errors.push(e.message || '操作失败');
      }
      // 操作后刷新块列表（序号可能变化），同样过滤锁定/占位块
      var refreshed = Notebook.getPageBlocks(pageId);
      blocks = [];
      for (var ri = 0; ri < refreshed.length; ri++) {
        var rb = refreshed[ri];
        if (rb.status === 'pending' || rb.lock) continue;
        if (rb.type === 'focus' || rb.type === 'ai-placeholder') continue;
        blocks.push(rb);
      }
    }

    var summary = (plan.reason || '已按你的要求修改笔记。') +
      (errors.length > 0 ? '\n⚠ 部分操作失败: ' + errors.join('; ') : '') +
      '\n✓ 已执行 ' + executed + ' 项修改。';
    if (placeholderId) {
      Notebook.updateAiPlaceholder(placeholderId, summary, 'done');
      return await Notebook.finalizeAiPlaceholder(placeholderId);
    }
    return await Notebook.applyOperation({
      type: 'insert', source: 'ai', blockType: 'text',
      content: summary, options: { aiGenerated: true }
    });
  }

  // ============================================================
  // AI 修改的 Diff 预览（逐行红绿对比 + 用户确认）
  // ============================================================

  /**
   * 构建逐行 diff 渲染（红删绿增）
   * @param {string} oldText - 旧内容
   * @param {string} newText - 新内容
   * @returns {HTMLElement}
   */
  function _buildDiffLines(oldText, newText) {
    var wrap = document.createElement('div');
    wrap.className = 'ai-diff-lines';
    var lines = (typeof DiffEngine !== 'undefined' && DiffEngine.diffLines)
      ? DiffEngine.diffLines(oldText, newText)
      : [{ type: 'del', text: oldText }, { type: 'add', text: newText }];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var row = document.createElement('div');
      row.className = 'ai-diff-line ' + ln.type;
      var num = document.createElement('span');
      num.className = 'ai-diff-num';
      num.textContent = (i + 1);
      row.appendChild(num);
      var txt = document.createElement('span');
      txt.className = 'ai-diff-text';
      txt.textContent = ln.text || ' ';
      row.appendChild(txt);
      wrap.appendChild(row);
    }
    return wrap;
  }

  /**
   * 展示 AI 修改的 Diff 预览面板，等待用户确认
   * @param {object} plan - { reason, operations }
   * @param {string} pageId - 当前笔记页 ID
   * @param {array} blocks - 过滤后的块列表（与 AI 序号一致，避免预览错位）
   * @returns {Promise<boolean>} true=采用，false=取消
   */
  function _showModifyDiff(plan, pageId, blocks) {
    return new Promise(function(resolve) {
      var blockList = blocks || Notebook.getPageBlocks(pageId);
      var ops = plan.operations || [];

      // 遮罩
      var overlay = document.createElement('div');
      overlay.className = 'ai-diff-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2000;';

      var panel = document.createElement('div');
      panel.style.cssText = "width:min(760px,94vw);max-height:86vh;background:#fdf6e3;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif;";

      // 头部
      var header = document.createElement('div');
      header.style.cssText = 'padding:12px 18px;background:linear-gradient(135deg,#8b6914,#a07a20);color:#fff;font-weight:700;font-size:14px;flex-shrink:0;';
      header.textContent = '🤖 AI 修改预览 — 共 ' + ops.length + ' 项操作' + (plan.reason ? '　|　' + plan.reason : '');
      panel.appendChild(header);

      // 正文（可滚动）
      var body = document.createElement('div');
      body.style.cssText = 'flex:1;overflow-y:auto;padding:10px 14px;';

      if (ops.length === 0) {
        var empty = document.createElement('div');
        empty.style.cssText = 'padding:24px;text-align:center;color:#8a7e6d;font-size:13px;';
        empty.textContent = 'AI 认为无需修改任何内容。';
        body.appendChild(empty);
      }

      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        var sec = document.createElement('div');
        sec.style.cssText = 'border:1px solid #d5cfc4;border-radius:8px;margin-bottom:10px;overflow:hidden;background:#fff;';

        var title = document.createElement('div');
        title.style.cssText = 'padding:6px 12px;font-size:12px;font-weight:600;color:#8b6914;background:rgba(139,105,20,.07);border-bottom:1px solid #e8dcc0;';

        var block = blockList[op.target - 1];
        var oldContent = block ? (block.content || '') : '';

        switch (op.type) {
          case 'update':
            title.textContent = '✏️ 修改块 ' + op.target;
            sec.appendChild(title);
            sec.appendChild(_buildDiffLines(oldContent, op.content || ''));
            break;
          case 'delete':
            title.textContent = '🗑️ 删除块 ' + op.target;
            sec.appendChild(title);
            var delWrap = document.createElement('div');
            delWrap.style.cssText = 'padding:8px 12px;background:rgba(248,113,113,.08);color:#b91c1c;white-space:pre-wrap;font-size:13px;line-height:1.7;';
            delWrap.textContent = oldContent || '(空内容)';
            sec.appendChild(delWrap);
            break;
          case 'insert':
            title.textContent = '➕ 新增块（位置 ' + (typeof op.position === 'number' ? op.position : '-') + '）';
            sec.appendChild(title);
            var addWrap = document.createElement('div');
            addWrap.style.cssText = 'padding:8px 12px;background:rgba(74,222,128,.08);color:#15803d;white-space:pre-wrap;font-size:13px;line-height:1.7;';
            addWrap.textContent = op.content || '';
            sec.appendChild(addWrap);
            break;
          case 'move':
            title.textContent = '↔️ 移动块 ' + op.target + ' → 位置 ' + (typeof op.position === 'number' ? op.position : '-');
            sec.appendChild(title);
            break;
          default:
            title.textContent = '操作：' + op.type + '（块 ' + (op.target || '-') + '）';
            sec.appendChild(title);
        }
        body.appendChild(sec);
      }
      panel.appendChild(body);

      // 底部按钮
      var footer = document.createElement('div');
      footer.style.cssText = 'padding:12px 16px;border-top:1px solid #d5cfc4;display:flex;gap:10px;justify-content:flex-end;background:#f5f2ed;flex-shrink:0;';

      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = '✗ 全部取消';
      cancelBtn.style.cssText = 'padding:8px 22px;border:1px solid #d5cfc4;border-radius:8px;background:#fff;color:#8a7e6d;cursor:pointer;font-size:13px;font-family:inherit;';
      cancelBtn.onmouseover = function() { cancelBtn.style.background = '#f5f2ed'; };
      cancelBtn.onmouseout = function() { cancelBtn.style.background = '#fff'; };

      var okBtn = document.createElement('button');
      okBtn.textContent = '✓ 全部采用';
      okBtn.style.cssText = 'padding:8px 26px;border:none;border-radius:8px;background:#8b6914;color:#fff;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;';
      okBtn.onmouseover = function() { okBtn.style.background = '#a07a20'; };
      okBtn.onmouseout = function() { okBtn.style.background = '#8b6914'; };

      footer.appendChild(cancelBtn);
      footer.appendChild(okBtn);
      panel.appendChild(footer);

      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      function close(result) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }
      okBtn.addEventListener('click', function() { close(true); });
      cancelBtn.addEventListener('click', function() { close(false); });
      // 点击遮罩空白处 = 取消
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) close(false);
      });
    });
  }

  // ============================================================
  // PDF 页面自动补全（AI 判断完整性 + 增量补页循环）
  // ============================================================

  const PDF_COLLECT = {
    maxBack: 50,        // 向前最多补 50 页
    maxForward: 50,     // 向后最多补 50 页
    maxRounds: 10,      // 完整性判断最多 10 轮
    sampleChars: 6000   // 判断用文本采样长度
  };

  // ============================================================
  // AI 工具调用：让 AI 自主获取 PDF 页面（而非依赖系统预判）
  // ============================================================

  // 工具协议（注入系统提示词）：AI 输出工具调用行，系统执行后回传结果
  const PDF_TOOL_PROTOCOL =
    '【可用工具】\n' +
    '当已有内容不足以完成用户请求时，你可以使用工具获取更多 PDF 页面。\n' +
    '工具：GET_PDF_PAGES 页码列表\n' +
    '用法：在回答中单独一行输出工具调用，例如：\n' +
    'GET_PDF_PAGES 190,191,192\n' +
    '规则：\n' +
    '1. 需要哪些页就列出哪些页（可跨页、可一次多页），系统会立即把对应页面的文本提供给你\n' +
    '2. 工具调用行不会显示给用户；收到工具结果后【必须】输出最终回答，最多只允许调用 1 次工具\n' +
    '3. 若工具返回内容仍不足或工具执行失败，也必须基于已有内容完成回答，不得再次调用工具，不得回复"请翻页""需要更多页面"\n' +
    '4. 若系统已提供较完整的章节内容（参考内容较长），优先基于已有内容完成，不要重复调用工具\n' +
    '5. 若目标内容在更靠前/靠后的位置，估算页码并调用，系统会返回该页实际内容\n\n' +
    '工具2：MODIFY_BLOCK 块序号 新的完整内容\n' +
    '用法：在回答中单独一行输出，例如：\n' +
    'MODIFY_BLOCK 3 修改后的完整段落内容\n' +
    '作用：当你认为已有的笔记块需要微调（如合并段落、重排编号、修正标题、衔接调整）时使用；系统会直接更新该块。\n' +
    '规则：块序号以【笔记页内容】中的 [序号] 为准；MODIFY_BLOCK 行不会显示给用户；每行一个修改。';

  // 从 AI 文本中提取工具调用（GET_PDF_PAGES 页码 或 MODIFY_BLOCK 序号 内容）
  function _extractToolCalls(text) {
    var calls = [];
    if (!text) return calls;
    var regex = /GET_PDF_PAGES\s+([\d,，\s]+)/g;
    var m;
    while ((m = regex.exec(text)) !== null) {
      var pages = m[1].split(/[,，\s]+/).map(function(n) { return parseInt(n, 10); })
        .filter(function(n) { return n > 0; })
        .slice(0, 50); // 单次最多 50 页
      if (pages.length) calls.push({ pages: pages });
    }
    // MODIFY_BLOCK：单独一行，匹配到下一个工具行或行尾
    var regex2 = /(?:^|\n)\s*MODIFY_BLOCK\s+(\d+)\s+([\s\S]*?)(?=\n\s*(?:MODIFY_BLOCK|GET_PDF_PAGES)\b|$)/g;
    var m2;
    while ((m2 = regex2.exec(text)) !== null) {
      var idx = parseInt(m2[1], 10);
      var content = m2[2].replace(/\s+$/, '');
      if (idx > 0 && content) calls.push({ modifyIndex: idx, content: content });
    }
    return calls;
  }

  // 执行工具调用：提取指定页文本 / 更新笔记块（带页码分隔，便于 AI 识别）
  async function _executeToolCalls(calls) {
    var result = '';
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i];
      // MODIFY_BLOCK：更新已有笔记块
      if (call.modifyIndex) {
        try {
          var pageId = Notebook.getCurrentPageId();
          var blocks = Notebook.getPageBlocks(pageId);
          var target = blocks[call.modifyIndex - 1];
          if (target) {
            await Notebook.applyOperation({
              type: 'update', source: 'user',
              targetBlockId: target.id, content: call.content
            });
            result += '\n[系统] 已更新第 ' + call.modifyIndex + ' 块。';
          } else {
            result += '\n[系统] 第 ' + call.modifyIndex + ' 块不存在，未执行修改。';
          }
        } catch (e) {
          result += '\n[系统] 修改第 ' + call.modifyIndex + ' 块失败: ' + (e.message || '');
        }
        continue;
      }
      // GET_PDF_PAGES：提取 PDF 页面
      var pages = call.pages || [];
      for (var j = 0; j < pages.length; j++) {
        var p = pages[j];
        try {
          if (typeof PDFReader !== 'undefined' && PDFReader.getPageText) {
            var text = await PDFReader.getPageText(p);
            if (text && text.trim()) {
              result += '\n===== PDF 第 ' + p + ' 页 =====\n' + text;
            } else {
              result += '\n===== PDF 第 ' + p + ' 页 =====\n(该页无可提取文本)';
            }
          }
        } catch (e) { /* ignore */ }
      }
    }
    return result;
  }

  /**
   * 用流式方式收集 AI 完整回复（兼容推理模型：跳过 reasoning，取正式 content）
   * @param {object} config
   * @param {array} messages
   * @returns {Promise<string>}
   */
  async function _collectChatResponse(config, messages) {
    var generator = AIAdapter.streamChat(
      config.provider, config.baseUrl, config.apiKey, messages,
      { model: config.model }
    );
    var text = '';
    for await (const chunk of generator) {
      if (chunk.content) text += chunk.content;
      if (chunk.done) break;
    }
    return text;
  }

  /**
   * AI 判断已收集的 PDF 文本是否足以完成用户请求。
   * 判断失败时降级为"保守补页"（向后补 1 页，受轮数/页数上限保护），
   * 避免因判断失败导致完全放弃自动补页。
   * @param {string} goal - 用户请求
   * @param {string} text - 已收集文本
   * @param {array} pages - 已收集页码
   * @returns {Promise<{complete:boolean, direction:string, pages:number, reason:string}|null>}
   */
  async function _judgePdfCompleteness(goal, text, pages) {
    var config = _getConfig();
    if (!config || !config.apiKey) return null;

    var sample = text.length > PDF_COLLECT.sampleChars
      ? text.substring(0, PDF_COLLECT.sampleChars) + '\n...(文本过长已截断)'
      : text;

    var messages = [
      {
        role: 'system',
        content: '你是文档完整性判断器。用户正在阅读 PDF 教材，请求 AI 基于教材内容完成任务。' +
          '系统已收集了部分页面文本，请判断这些文本是否足以完成用户的请求。\n' +
          '只返回一个 JSON 对象（不要输出其他内容，不要输出思考过程）：\n' +
          '{"complete": true 或 false, "direction": "front" 或 "back" 或 null, "pages": 数字, "reason": "一句话说明"}\n' +
          '规则：\n' +
          '1. 文本足以覆盖用户请求所需的完整知识点 → complete=true，direction=null\n' +
          '2. 内容明显未结束（章节中断、表格未列完、要点未说完）→ complete=false，并判断缺哪边：\n' +
          '   - 内容在末尾中断（还应有后续内容）→ direction="back"\n' +
          '   - 内容开头缺失（前面应有铺垫/开头）→ direction="front"\n' +
          '3. 如果文本中完全没有出现用户请求的核心概念/关键词 → complete=false，direction="back"（向后翻找），pages=3\n' +
          '4. pages 为建议补充的页数，1-5，默认 1\n' +
          '5. 只输出 JSON 本身'
      },
      { role: 'user', content: '用户请求：' + (goal || '整理当前内容') + '\n\n已收集页码：' + (pages.join('、') || '无') + '\n\n页面文本：\n' + sample }
    ];

    try {
      // 用流式收集（与主流程一致，兼容推理模型把内容放在 reasoning 的情况）
      var response = await _collectChatResponse(config, messages);
      var parsed = _extractJson(response);
      if (parsed && typeof parsed.complete === 'boolean') {
        if (!parsed.complete && parsed.direction !== 'front' && parsed.direction !== 'back') {
          parsed.direction = 'back';
        }
        parsed.pages = Math.max(1, Math.min(5, parseInt(parsed.pages, 10) || 1));
        return parsed;
      }
      // 返回了内容但格式异常：保守向后补 1 页
      if (response && response.trim()) {
        return { complete: false, direction: 'back', pages: 1, reason: '判断响应格式异常，保守补页' };
      }
    } catch (e) {
      console.warn('PDF 完整性判断失败:', e.message);
    }
    // 调用失败：保守向后补 1 页（受 maxRounds / maxForward 上限保护，不会无限补）
    return { complete: false, direction: 'back', pages: 1, reason: '完整性判断失败，保守补页' };
  }

  /**
   * 自动收集 PDF 上下文：从起始页开始，AI 判断完整性并增量补页。
   * 带整体超时保护（20 秒），超时降级返回已收集/当前页内容，避免阻塞主流程。
   * @param {string} goal - 用户请求（用于判断完整性）
   * @param {number} startPage - 起始页码（默认当前页）
   * @returns {Promise<string>} 收集到的完整文本（无 PDF 时返回空串）
   */
  async function _collectPdfContext(goal, startPage) {
    var timeoutPromise = new Promise(function(resolve) {
      setTimeout(function() { resolve('__TIMEOUT__'); }, 20000);
    });
    var result = await Promise.race([_doCollectPdfContext(goal, startPage), timeoutPromise]);
    if (result === '__TIMEOUT__') {
      console.warn('PDF 上下文自动收集超时，降级为当前页');
      // 超时：尽力返回当前页文本，避免完全无上下文
      try {
        if (typeof PDFReader === 'undefined' || !PDFReader.getPageText) return '';
        var cur = startPage || PDFReader.getCurrentPage();
        if (cur > 0) {
          var t = await PDFReader.getPageText(cur);
          if (t && t.trim()) return '【已自动收集 PDF 第 ' + cur + ' 页内容】\n\n' + t;
        }
      } catch (e) { /* ignore */ }
      return '';
    }
    return result;
  }

  // 实际收集逻辑（可被 _collectPdfContext 超时中断）
  async function _doCollectPdfContext(goal, startPage) {
    if (typeof PDFReader === 'undefined' || !PDFReader.getPageText) return '';

    var pageCount = PDFReader.getPageCount();
    var cur = startPage || PDFReader.getCurrentPage();
    if (!cur || cur < 1 || cur > pageCount) return '';

    // 初始文本 = 起始页
    var frontPages = [];   // 起始页之前的页
    var backPages = [];    // 起始页之后的页
    var text = await PDFReader.getPageText(cur);
    if (!text || !text.trim()) return '';
    var allPages = [cur];

    for (var round = 0; round < PDF_COLLECT.maxRounds; round++) {
      if (round === 0) {
        // 第一轮：主动向后补 2 页（兜底），
        // 即使完整性判断误判"已完整"，AI 也至少有后续几页内容，避免只见当前页
        for (var pb = 0; pb < 2; pb++) {
          var pFirst = cur + backPages.length + 1;
          if (pFirst > pageCount || backPages.length >= PDF_COLLECT.maxForward) break;
          var ptFirst = await PDFReader.getPageText(pFirst);
          if (!ptFirst) break;
          backPages.push(pFirst);
          allPages.push(pFirst);
          text = text + '\n\n' + ptFirst;
        }
      }

      var judge = await _judgePdfCompleteness(goal, text, allPages);
      if (!judge || judge.complete) break;

      var added = 0;
      if (judge.direction === 'front') {
        // 向前补页
        for (var fi = 0; fi < judge.pages; fi++) {
          var p = cur - frontPages.length - 1;
          if (p < 1 || frontPages.length >= PDF_COLLECT.maxBack) break;
          var pt = await PDFReader.getPageText(p);
          if (!pt) break;
          frontPages.push(p);
          allPages.push(p);
          text = pt + '\n\n' + text;
          added++;
        }
      } else {
        // 向后补页
        for (var bi = 0; bi < judge.pages; bi++) {
          var p2 = cur + backPages.length + 1;
          if (p2 > pageCount || backPages.length >= PDF_COLLECT.maxForward) break;
          var pt2 = await PDFReader.getPageText(p2);
          if (!pt2) break;
          backPages.push(p2);
          allPages.push(p2);
          text = text + '\n\n' + pt2;
          added++;
        }
      }
      if (added === 0) break; // 无法继续补页
    }

    // 按页码排序（展示顺序）
    allPages.sort(function(a, b) { return a - b; });
    return '【已自动收集 PDF 第 ' + allPages.join('、') + ' 页内容】\n\n' + text;
  }

  // ============================================================
  // 流式输出到笔记（设计规格 §5.5）
  // ============================================================

  /**
   * 流式AI输出 → 笔记占位块
   * 推理阶段显示"思考中..."，正式回答阶段逐字书写
   * 完成后占位块转为 AI 结果块并渲染 Markdown
   * @param {string} prompt - 用户提示词
   * @param {string} contextText - 上下文文本（笔记块/PDF文本）
   * @param {string} placeholderId - AI 占位块 ID
   * @returns {Promise<block>} 完成后的块
   */
  async function _streamToNotebook(prompt, contextText, placeholderId) {
    var config = _getConfig();
    if (!config.apiKey) {
      // 无API Key: 在占位块中显示提示，并转为纯文本块（与"文字既是笔记"语义一致，type='text'）
      var noKeyMsg = '⚠ 未配置 API Key，请在设置中配置 AI 密钥后使用。';
      if (!placeholderId) {
        // 命令未携带指令块（如程序化调用/测试），无占位块时直接插入文本块，保证返回非 null
        return await Notebook.applyOperation({
          type: 'insert', source: 'ai',
          blockType: 'text',
          content: noKeyMsg,
          options: { aiGenerated: true }
        });
      }
      Notebook.updateAiPlaceholder(placeholderId, noKeyMsg, 'done');
      return await Notebook.finalizeAiPlaceholderAsText(placeholderId);
    }

    if (!placeholderId) {
      // 兼容旧调用：无占位块时创建新块
      var fallbackBlock = await Notebook.applyOperation({
        type: 'insert', source: 'ai',
        blockType: 'text',
        content: '思考中...',
        options: { aiGenerated: true }
      });
      placeholderId = fallbackBlock ? fallbackBlock.id : null;
      if (!placeholderId) return null;
    }

    // 工具轮询：AI 可自主调用 GET_PDF_PAGES 获取更多页面，最多 3 轮（2 次调用 + 最终回答）
    var toolResultText = '';
    var finalContent = '';
    var maxToolRounds = 3;

    for (var round = 0; round < maxToolRounds; round++) {
      var isLastRound = (round === maxToolRounds - 1);
      var response;
      try {
        var systemContent = await _buildContext({ includePdfContext: true, anchorBlockId: placeholderId });
        systemContent += '\n\n' + PDF_TOOL_PROTOCOL;
        var userContent = contextText ? (prompt + '\n\n参考内容：\n' + contextText) : prompt;
        if (toolResultText) {
          userContent += '\n\n【工具调用结果（系统已自动获取的 PDF 页面）】\n' + toolResultText;
        }
        var messages = [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ];

        if (!isLastRound) {
          Notebook.updateAiPlaceholder(placeholderId, '⏳ AI 正在分析并获取所需 PDF 页面...', 'streaming');
        }

        var accumulated = '';
        var reasoningAccumulated = '';
        var hasStartedContent = false;
        var generator = AIAdapter.streamChat(
          config.provider, config.baseUrl, config.apiKey, messages,
          { model: config.model }
        );

        for await (const chunk of generator) {
          if (chunk.reasoningContent) {
            reasoningAccumulated += chunk.reasoningContent;
            if (!hasStartedContent) {
              Notebook.updateAiPlaceholder(placeholderId, '思考中...', 'streaming');
            }
          }
          if (chunk.content) {
            hasStartedContent = true;
            accumulated += chunk.content;
            // 最后一轮才实时显示内容；中间轮静默收集（可能有工具调用行）
            if (isLastRound) {
              Notebook.updateAiPlaceholder(placeholderId, accumulated, 'streaming');
            }
          }
          if (chunk.done) break;
        }
        if (!accumulated && reasoningAccumulated) accumulated = reasoningAccumulated;
        response = accumulated;
      } catch (e) {
        response = response || ('⚠ AI生成失败: ' + (e.message || '未知错误'));
      }

      // 检测工具调用
      var toolCalls = _extractToolCalls(response);
      if (toolCalls.length === 0 || isLastRound) {
        // 显示前统一过滤工具调用行，绝不让 GET_PDF_PAGES / MODIFY_BLOCK 泄漏给用户
        var cleaned = response
          .replace(/GET_PDF_PAGES[^\n]*/g, '')
          .replace(/\n?\s*MODIFY_BLOCK[^\n]*/g, '')
          .trim();
        finalContent = cleaned || '（AI 未生成有效内容）';
        break;
      }

      // 执行工具：获取 AI 请求的页面 / 调整笔记块
      toolResultText = await _executeToolCalls(toolCalls);
      if (!toolResultText) {
        // 工具没拿到内容（PDF 未加载/页码无效）：把失败信息回传 AI，让它基于已有内容回答，不再空转
        toolResultText = '（工具执行失败：无法提取这些页面的文本，请基于已有内容完成回答，不要再调用工具）';
        var cleaned2 = response.replace(/GET_PDF_PAGES[^\n]*/g, '').replace(/\n?\s*MODIFY_BLOCK[^\n]*/g, '').trim();
        // 继续下一轮，把失败提示发给 AI
        if (!cleaned2) { /* 本轮只有工具调用，无有效内容，继续下一轮 */ }
      }
    }

    if (!finalContent) {
      finalContent = '（未生成内容）';
    }

    // 完成：更新占位块内容并触发 Markdown 渲染
    Notebook.updateAiPlaceholder(placeholderId, finalContent, 'done');

    // 转为正式 AI 结果块
    await Notebook.finalizeAiPlaceholder(placeholderId);

    return { id: placeholderId, content: finalContent };
  }

  // v130 已移除「AI 自动划重点」AIEngine.highlightPdf 高层捷径。
  // 书虫助手的划重点改为显式 annot_* 原子工具链路（page-agent.js）。

  // ============================================================
  // 命令执行器（设计规格 §5.2）
  // ============================================================

  /**
   * 执行命令
   * @param {string} cmdText - 命令文本
   * @param {object} target - 预解析目标（可选，否则自动解析）
   * @param {string} cmdBlockId - 指令块 ID（用于状态管理，可选）
   * @returns {Promise<block|null>}
   */
  async function executeCommand(cmdText, target, cmdBlockId) {
    // 允许并发执行多个 AI 任务（用户可在 AI 生成期间继续记笔记或创建新指令）
    activeTaskCount++;

    // 视觉反馈：显示处理中提示
    _showProcessingToast(true);

    // 标记指令块为"执行中"状态，并创建 AI 输出占位块
    var placeholderId = null;
    if (cmdBlockId && typeof Notebook.markCommandPending === 'function') {
      await Notebook.markCommandPending(cmdBlockId);
      var placeholder = await Notebook.createAiPlaceholder(cmdBlockId, cmdBlockId);
      if (placeholder) placeholderId = placeholder.id;
    }

    try {
      var parsed = _parseCommand(cmdText);

      // PDF阅读代理命令
      if (parsed.type === 'read-pdf') {
        var readResult = await readPdf(parsed.args, placeholderId);
        if (cmdBlockId) await Notebook.markCommandComplete(cmdBlockId);
        return readResult;
      }

      // 解析目标
      var tgt = target || _resolveTarget(parsed.args);

      // 章节名匹配增强：用户提到章节名（如"腹部检查""腰背痛"）时，
      // 在 PDF 目录中模糊匹配并定位到该章节，直接提取整章内容（而非仅当前页）
      if (tgt.scope === 'current-page' && parsed.args && parsed.args.length >= 2) {
        try {
          var tocList = await PDFReader.getTOC();
          if (tocList && tocList.length > 0) {
            for (var ti2 = 0; ti2 < tocList.length; ti2++) {
              var tt = tocList[ti2].title || '';
              if (!tt) continue;
              // args 包含章节标题，或章节标题包含 args（且 args 足够长避免误匹配）
              var match = parsed.args.indexOf(tt) >= 0 ||
                (tt.indexOf(parsed.args) >= 0 && parsed.args.length >= 3);
              if (match) {
                tgt.scope = 'pdf-chapter';
                tgt.chapterId = tocList[ti2].id;
                tgt.chapterTitle = tt;
                break;
              }
            }
          }
        } catch (e) { /* ignore */ }
      }

      // 修改类命令（针对笔记内容）→ 真正执行笔记修改操作
      if (_isModifyCommand(parsed) &&
          (tgt.scope === 'current-page' || tgt.scope === 'recent-blocks' || tgt.scope === 'selection')) {
        var modifyResult = await _executeModifyCommand(parsed, placeholderId);
        if (cmdBlockId && typeof Notebook.markCommandComplete === 'function') {
          await Notebook.markCommandComplete(cmdBlockId);
        }
        _alertSystem({ type: parsed.type, block: modifyResult, success: !!modifyResult });
        if (typeof SkillManager !== 'undefined' && SkillManager.recordOperation) {
          SkillManager.recordOperation('modify', { command: parsed.raw }).catch(function(e) { /* ignore */ });
        }
        return modifyResult;
      }

      // 构建上下文文本
      var contextText = '';
      if (tgt.blocks && tgt.blocks.length > 0) {
        contextText = tgt.blocks.map(function(b) {
          return (b.content || '');
        }).join('\n\n');
      }

      // PDF页面文本（含自动补页：AI 判断完整性并增量补页）
      if (tgt.scope === 'pdf-page' && tgt.pdfPageNum) {
        try {
          contextText = await _collectPdfContext(parsed.args || parsed.raw || '', tgt.pdfPageNum);
        } catch (e) { /* ignore */ }
      }

      // PDF章节文本 — 获取整个章节所有页面的内容
      if (tgt.scope === 'pdf-chapter') {
        try {
          var toc = await PDFReader.getTOC();
          if (toc && toc.length > 0) {
            // 优先使用章节名匹配到的 chapterId（如"腹部检查"）
            var chapterId = tgt.chapterId || null;
            if (!chapterId && tgt.chapterNum) {
              // 用户指定了章节号（如 "第一章" / "第3章"）
              var chapterIdx = _parseChineseNumber(tgt.chapterNum);
              if (chapterIdx > 0 && chapterIdx <= toc.length) {
                chapterId = toc[chapterIdx - 1].id;
              }
            }
            if (!chapterId) {
              // 未指定章节号或章节号无效：查找当前页所在的章节
              var currentPage = PDFReader.getCurrentPage();
              for (var ci = 0; ci < toc.length; ci++) {
                if (toc[ci].pageNum <= currentPage) chapterId = toc[ci].id;
                else break;
              }
            }
            if (chapterId) {
              contextText = await PDFReader.getChapterText(chapterId);
              // 章节内容可能很长，截取前 15000 字符避免超出上下文
              if (contextText && contextText.length > 15000) {
                contextText = contextText.substring(0, 15000) + '\n\n...(章节内容过长，已截断，仅展示前15000字符)';
              }
            } else {
              // 无目录或未找到章节：回退到当前页
              var curP = PDFReader.getCurrentPage();
              if (curP > 0) {
                contextText = await PDFReader.getPageText(curP);
              }
            }
          } else {
            // 无目录：回退到当前页
            var curP2 = PDFReader.getCurrentPage();
            if (curP2 > 0) {
              contextText = await PDFReader.getPageText(curP2);
            }
          }
        } catch (e) {
          console.warn('章节文本提取失败:', e);
        }
      }

      // 当前页: 若笔记块为空，自动提取PDF上下文（含自动补页）
      if (tgt.scope === 'current-page' && (!tgt.blocks || tgt.blocks.length === 0)) {
        try {
          var curPage = PDFReader.getCurrentPage();
          if (curPage > 0) {
            if (placeholderId) Notebook.updateAiPlaceholder(placeholderId, '正在自动获取 PDF 教材页面...', 'streaming');
            contextText = await _collectPdfContext(parsed.args || parsed.raw || '');
          }
        } catch (e) { /* ignore */ }
      }

      // 自动补全增强：即使笔记块已有内容，若指令涉及教材内容（总结/翻译/生成/回答），
      // 也自动收集 PDF 原文作为依据（AI 判断页面完整性并增量补页），
      // 避免 AI 因只见当前页而要求用户手动翻页。
      // 若 contextText 已含自动补全标记（上一步已收集），跳过避免重复调用
      if (contextText && contextText.indexOf('已自动收集 PDF') < 0 &&
          PDFReader.getCurrentPage && PDFReader.getCurrentPage() > 0 &&
          (parsed.type === 'summarize' || parsed.type === 'translate' || parsed.type === 'generate' || parsed.type === 'answer')) {
        try {
          if (placeholderId) Notebook.updateAiPlaceholder(placeholderId, '正在自动获取 PDF 教材页面...', 'streaming');
          var pdfExtra = await _collectPdfContext(parsed.args || parsed.raw || '');
          if (pdfExtra) {
            contextText = contextText + '\n\n===== PDF 教材内容（自动补全） =====\n' + pdfExtra;
          }
        } catch (e) { /* ignore */ }
      }

      // 构建执行提示词
      var promptMap = {
        summarize: '请总结以下内容，提炼核心结论与关键要点。要求：先写1-2句核心结论，再用列表分点，每点包含关键词和简要解释；不要大段复述原文：',
        translate: '请将以下内容翻译为中文（如已是中文则翻译为英文）。要求：术语准确、语句通顺，保留原文结构，可用表格对照关键术语：',
        answer: '请回答以下问题。要求：先直接给出答案，再分点说明理由/依据，必要时用表格或例子帮助理解：',
        generate: '请根据以下内容生成一份结构化学习笔记。要求：先写核心结论，再用###小标题分块（关键概念/要点拆解/例子/易错提醒/关联知识），善用表格和加粗，最后给出2-3个自检问题；不要输出"根据内容"这类废话：',
        restructure: '请将以下内容重组为清晰的结构化笔记。要求：保留所有关键信息，用###小标题分块，用列表/表格组织，去掉冗余表达：'
      };
      var prompt = (promptMap[parsed.type] || promptMap.answer) + (parsed.args || '');

      // 章节级操作：使用更适合的提示词
      if (tgt.scope === 'pdf-chapter' && contextText) {
        if (parsed.type === 'restructure' || parsed.type === 'summarize' || parsed.type === 'generate') {
          prompt = '请根据以下章节内容整理成可直接复习的结构化学习笔记。要求：\n' +
            '1. 先给出 1-2 句本章核心结论；\n' +
            '2. 用 ### 小标题分块：「核心概念」「要点拆解」「对比/表格」「易错提醒」「关联与延伸」；\n' +
            '3. 善用表格做对比，用 **加粗** 标关键术语；\n' +
            '4. 每块内容要具体，不要空泛；\n' +
            '5. 最后给出 2-3 个自检问题；\n' +
            '6. 不要输出"根据章节内容"这类废话，直接写笔记。\n\n' +
            (parsed.args || '');
        }
      }

      // 流式输出到占位块
      var resultBlock = await _streamToNotebook(prompt, contextText, placeholderId);

      // 标记指令块为"已完成"
      if (cmdBlockId && typeof Notebook.markCommandComplete === 'function') {
        await Notebook.markCommandComplete(cmdBlockId);
      }

      // 警觉系统：检查任务是否完成
      _alertSystem({ type: parsed.type, block: resultBlock, success: !!resultBlock });

      // 记录操作到 Skill Manager
      if (typeof SkillManager !== 'undefined' && SkillManager.recordOperation) {
        SkillManager.recordOperation(parsed.type, { command: parsed.raw }).catch(function(e) { /* ignore */ });
      }

      return resultBlock;
    } catch (e) {
      console.error('AI Engine 执行失败:', e);
      // 在占位块中显示错误
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, '⚠ 执行失败: ' + (e.message || '未知错误'), 'done');
        await Notebook.finalizeAiPlaceholder(placeholderId);
      } else {
        return await Notebook.applyOperation({
          type: 'insert', source: 'ai',
          blockType: 'text',
          content: '⚠ 执行失败: ' + (e.message || '未知错误'),
          options: { aiGenerated: true }
        });
      }
      // 出错时也标记指令为完成
      if (cmdBlockId && typeof Notebook.markCommandComplete === 'function') {
        await Notebook.markCommandComplete(cmdBlockId);
      }
      return null;
    } finally {
      activeTaskCount--;
      if (activeTaskCount <= 0) {
        activeTaskCount = 0;
        _showProcessingToast(false);
      }
    }
  }

  // ============================================================
  // 聚焦导航器（设计规格 §5.3）
  // ============================================================

  /**
   * 聚焦导航
   * 1. 搜索笔记(searchBlocks) + PDF全文
   * 2. 命中多条 → 插入交互引导块(focus类型)
   * 3. 用户选择 → 聚焦目标
   * @param {string} query - 搜索查询
   * @returns {Promise<object>} 搜索结果
   */
  async function focus(query) {
    if (!query) return { results: [], scope: 'none' };

    // 去除聚焦关键词前缀，提取实际搜索词
    var focusPrefixes = ['找到', '定位', '跳到', '展示', '搜索', '查找', 'find', 'locate', 'show', 'search'];
    var searchQuery = query;
    var lowerQuery = query.toLowerCase();
    for (var k = 0; k < focusPrefixes.length; k++) {
      if (lowerQuery.startsWith(focusPrefixes[k].toLowerCase())) {
        searchQuery = query.slice(focusPrefixes[k].length).trim();
        break;
      }
    }
    if (!searchQuery) searchQuery = query;

    var results = [];

    // 1. 搜索笔记内容
    var noteResults = Notebook.searchBlocks(searchQuery);
    for (var i = 0; i < noteResults.length; i++) {
      results.push({
        source: 'note',
        blockId: noteResults[i].blockId,
        pageId: noteResults[i].pageId,
        pageNum: noteResults[i].pageNum,
        content: noteResults[i].content,
        preview: (noteResults[i].content || '').substring(0, 60)
      });
    }

    // 2. 搜索PDF当前页文本
    if (typeof PDFReader !== 'undefined') {
      var pdfPageNum = PDFReader.getCurrentPage();
      if (pdfPageNum > 0) {
        try {
          var pageText = await PDFReader.getPageText(pdfPageNum);
          if (pageText) {
            var lowerText = pageText.toLowerCase();
            var idx = lowerText.indexOf(searchQuery.toLowerCase());
            if (idx >= 0) {
              var start = Math.max(0, idx - 20);
              var end = Math.min(pageText.length, idx + searchQuery.length + 40);
              results.push({
                source: 'pdf',
                pageNum: pdfPageNum,
                content: pageText.substring(start, end),
                preview: '...' + pageText.substring(start, end) + '...'
              });
            }
          }
        } catch (e) { /* ignore */ }
      }
    }

    // 3. 根据结果数量决定行为
    if (results.length === 0) {
      // 无结果 → 插入提示块
      await Notebook.applyOperation({
        type: 'insert', source: 'ai',
        blockType: 'focus',
        content: '未找到与「' + searchQuery + '」相关的内容。尝试换个关键词？',
        options: { aiGenerated: true }
      });
      if (typeof SkillManager !== 'undefined' && SkillManager.recordOperation) {
        SkillManager.recordOperation('focus', { query: searchQuery, resultCount: 0 }).catch(function(e) { /* ignore */ });
      }
      return { results: [], scope: 'no-match' };
    }

    if (results.length === 1) {
      // 唯一匹配 → 直接聚焦
      var r = results[0];
      if (r.source === 'pdf' && r.pageNum && typeof PDFReader !== 'undefined') {
        await PDFReader.scrollToPage(r.pageNum);
        await PDFReader.highlightText(r.pageNum, searchQuery);
      }
      await Notebook.applyOperation({
        type: 'insert', source: 'ai',
        blockType: 'focus',
        content: '已定位到：' + r.preview,
        options: { aiGenerated: true }
      });
      if (typeof SkillManager !== 'undefined' && SkillManager.recordOperation) {
        SkillManager.recordOperation('focus', { query: searchQuery, resultCount: 1 }).catch(function(e) { /* ignore */ });
      }
      return { results: results, scope: 'direct-focus' };
    }

    // 多条匹配 → 插入交互引导块
    var lines = ['找到 ' + results.length + ' 处匹配「' + searchQuery + '」：'];
    for (var j = 0; j < results.length; j++) {
      var r2 = results[j];
      var loc = r2.source === 'pdf'
        ? 'PDF第' + r2.pageNum + '页'
        : '笔记' + (r2.pageNum ? 'P' + r2.pageNum : '');
      lines.push((j + 1) + '. [' + loc + '] ' + r2.preview);
    }
    lines.push('（在控制台执行 AIEngine._focusResult(index) 选择聚焦目标）');

    await Notebook.applyOperation({
      type: 'insert', source: 'ai',
      blockType: 'focus',
      content: lines.join('\n'),
      options: { aiGenerated: true }
    });

    // 暂存结果供用户选择
    _lastFocusResults = results;

    if (typeof SkillManager !== 'undefined' && SkillManager.recordOperation) {
      SkillManager.recordOperation('focus', { query: searchQuery, resultCount: results.length }).catch(function(e) { /* ignore */ });
    }

    return { results: results, scope: 'interactive' };
  }

  /**
   * 用户选择聚焦目标后执行
   * @param {number} index - 结果索引（0-based）
   */
  async function _focusResult(index) {
    if (!_lastFocusResults || index < 0 || index >= _lastFocusResults.length) return;
    var r = _lastFocusResults[index];
    if (r.source === 'pdf' && r.pageNum && typeof PDFReader !== 'undefined') {
      await PDFReader.scrollToPage(r.pageNum);
      await PDFReader.highlightText(r.pageNum, r.content);
    }
    return r;
  }

  // ============================================================
  // PDF阅读代理（设计规格 §5.4）
  // ============================================================

  /**
   * AI自主读取PDF内容完成任务
   * @param {string} range - 范围描述（如 "第3章" "第5页" "当前页"）
   * @param {string} placeholderId - AI 占位块 ID（可选）
   * @returns {Promise<block|null>}
   */
  async function readPdf(range, placeholderId) {
    var text = '';

    if (typeof PDFReader === 'undefined') {
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, '⚠ PDF Reader 模块未加载。', 'done');
        return await Notebook.finalizeAiPlaceholder(placeholderId);
      }
      return await Notebook.applyOperation({
        type: 'insert', source: 'ai',
        blockType: 'text',
        content: '⚠ PDF Reader 模块未加载。',
        options: { aiGenerated: true }
      });
    }

    // 解析范围
    var pageMatch = (range || '').match(/第\s*(\d+)\s*页/);
    var chapterMatch = (range || '').match(/第\s*(\d+|[一二三四五六七八九十百]+)\s*章/);

    if (pageMatch) {
      // 指定页
      var pageNum = parseInt(pageMatch[1], 10);
      text = await PDFReader.getPageText(pageNum);
    } else if (chapterMatch) {
      // 指定章节（支持中文数字）
      var chapterNumStr = chapterMatch[1];
      var chapterNum = /^\d+$/.test(chapterNumStr) ? parseInt(chapterNumStr, 10) : _parseChineseNumber(chapterNumStr);
      var toc = await PDFReader.getTOC();
      if (toc && chapterNum > 0 && chapterNum <= toc.length) {
        text = await PDFReader.getChapterText(toc[chapterNum - 1].id);
      }
    } else {
      // 当前页
      var currentPage = PDFReader.getCurrentPage();
      if (currentPage > 0) {
        text = await PDFReader.getPageText(currentPage);
      }
    }

    if (!text) {
      if (placeholderId) {
        Notebook.updateAiPlaceholder(placeholderId, '⚠ 无法读取PDF内容，请确认已加载PDF文件。', 'done');
        return await Notebook.finalizeAiPlaceholder(placeholderId);
      }
      return await Notebook.applyOperation({
        type: 'insert', source: 'ai',
        blockType: 'text',
        content: '⚠ 无法读取PDF内容，请确认已加载PDF文件。',
        options: { aiGenerated: true }
      });
    }

    // 流式生成笔记到占位块
    return await _streamToNotebook(
      '请根据以下PDF内容生成一份可直接复习的结构化学习笔记。要求：\n' +
      '1. 先写 1-2 句核心结论；\n' +
      '2. 用 ### 小标题分块，包含「关键概念」「要点拆解」「例子/场景」「易错提醒」「关联知识」；\n' +
      '3. 善用表格做对比，用 **加粗** 标出关键术语；\n' +
      '4. 最后给出 2-3 个自检问题；\n' +
      '5. 不要输出"根据PDF内容"这类废话，直接写笔记。\n\n' +
      '范围：' + (range || '当前页'),
      text,
      placeholderId
    );
  }

  // ============================================================
  // 警觉系统（设计规格 §5.7）
  // ============================================================

  /**
   * 任务完成通知
   * AI 操作完成后触发外部回调（如有监听方），用于通知"本次任务已完成"。
   * 说明：设计规格 §5.7 描述的"自动继续/警觉"机制，其实现依赖 AI 对任务完成度的判断，
   * 易引发不可控的自动续跑。当前版本采取保守策略——任务结束后仅做完成通知，
   * 不自动发起下一轮执行，避免意外循环改写用户笔记。如需启用自动续跑，
   * 应在此处加入受控的、带明确停止条件的 AI 判断逻辑。
   * @param {object} result - 本次操作结果
   */
  async function _alertSystem(result) {
    // 通知外部：本次 AI 任务已完成（如有监听方）
    _fireTaskComplete(result);
  }

  // ============================================================
  // 回调管理
  // ============================================================

  function onTaskComplete(callback) {
    if (typeof callback === 'function') taskCompleteCallbacks.push(callback);
  }

  function _fireTaskComplete(result) {
    for (var i = 0; i < taskCompleteCallbacks.length; i++) {
      try { taskCompleteCallbacks[i](result); }
      catch (e) { /* ignore */ }
    }
  }

  // ============================================================
  // P4 拟人编辑引擎（蓝图 §5.2）— 结构分析 → 方案设计 → edit 落地 → 书签
  // ============================================================

  // ---------- 通用工具：行切分 / 合并 / 分点文本提取 ----------
  function _splitLines(text) {
    if (!text) return [];
    return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  }
  function _joinLines(lines) {
    return (lines || []).join('\n');
  }
  function _stripBulletText(line) {
    if (!line) return '';
    return line
      .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
      .replace(/^（\d{1,2}）\s*/, '')
      .replace(/^\d{1,2}[.、)）]\s*/, '')
      .replace(/^[-*]\s*/, '')
      .trim();
  }

  // ---------- 模块 A：结构分析器 ----------

  function _isHeadingLine(line) { return /^#{1,6}\s/.test(line || ''); }

  function _isSummaryHeading(line) {
    if (!_isHeadingLine(line)) return false;
    var text = (line || '').replace(/^#{1,6}\s*/, '').trim();
    return /^(总结|小结|本章小结|核心要点|要点总结|要点|归纳)/.test(text);
  }

  function _isSelfTestLine(line) { return /^\s*>\s*自检/.test(line || ''); }

  function _isTermTableLine(line) {
    var t = (line || '').trim();
    if (t.indexOf('|') < 0) return false;
    return /术语|缩写|名词|概念/.test(t);
  }

  function _detectBulletStyle(line) {
    if (!line) return null;
    if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(line)) return '①';
    if (/^（\d{1,2}）/.test(line)) return '（1）';
    if (/^\d{1,2}[.、)）](?:\s|$)/.test(line)) return '1.';
    if (/^-\s/.test(line)) return '-';
    if (/^\*\s/.test(line)) return '*';
    return null;
  }

  function _analyzeStructureMd(mdContent, pageId) {
    var snapshot = {
      pageId: pageId || null,
      mdContent: mdContent || '',
      lines: [],
      bulletStyle: null,
      bulletLineIndexes: [],
      headingIndexes: [],
      summaryHeadingIndex: -1,
      summaryEndIndex: -1,
      termTableIndex: -1,
      hasSelfTest: false
    };
    if (!mdContent) return snapshot;
    var lines = _splitLines(mdContent);
    snapshot.lines = lines;

    var styleCount = {};
    var styleOfLine = {};
    for (var i = 0; i < lines.length; i++) {
      var st = _detectBulletStyle(lines[i]);
      if (st) { styleOfLine[i] = st; styleCount[st] = (styleCount[st] || 0) + 1; }
    }
    var maxStyle = null, maxCount = 0;
    for (var s in styleCount) {
      if (styleCount[s] > maxCount) { maxCount = styleCount[s]; maxStyle = s; }
    }
    snapshot.bulletStyle = maxStyle;
    for (var i2 = 0; i2 < lines.length; i2++) {
      if (styleOfLine[i2]) {
        if (!maxStyle || styleOfLine[i2] === maxStyle) snapshot.bulletLineIndexes.push(i2);
      }
    }

    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (_isHeadingLine(line)) {
        snapshot.headingIndexes.push(j);
        if (snapshot.summaryHeadingIndex < 0 && _isSummaryHeading(line)) {
          snapshot.summaryHeadingIndex = j;
        }
      }
      if (snapshot.termTableIndex < 0 && _isTermTableLine(line)) snapshot.termTableIndex = j;
      if (_isSelfTestLine(line)) snapshot.hasSelfTest = true;
    }

    if (snapshot.summaryHeadingIndex >= 0) {
      var end = lines.length;
      for (var k = snapshot.summaryHeadingIndex + 1; k < lines.length; k++) {
        if (_isHeadingLine(lines[k])) { end = k; break; }
      }
      snapshot.summaryEndIndex = end;
    }

    return snapshot;
  }

  // noteMd：可选。传入时（含空字符串）使用快照正文，替代实时 DataLayer.getPageMd；
  // 不传（undefined/null）时保持原有实时读取行为。异步队列执行基于快照时传入 cmd.snapshot.noteMd。
  async function analyzeStructure(pageId, noteMd) {
    var mdContent = '';
    if (noteMd !== undefined && noteMd !== null) {
      mdContent = noteMd || '';
    } else if (typeof DataLayer !== 'undefined' && DataLayer.getPageMd) {
      try { mdContent = await DataLayer.getPageMd(pageId); } catch (e) { mdContent = ''; }
    }
    return _analyzeStructureMd(mdContent, pageId);
  }

  // ============================================================
  // 模块 B：方案设计器（designEditPlan）
  // ============================================================

  // 本地规则意图识别：从指令文本提取动作类型与关键信息
  function _inferEditIntent(raw) {
    var text = String(raw || '').replace(/、、/g, '').replace(/。。/g, '').trim();
    var intent = {
      type: 'ask',          // add|delete|modify|cut|copy|paste|summarize|translate|generate|ask
      keyword: '',          // 提取的关键词（如"XXX"、"第N点"）
      content: '',          // 提取的新内容（add / modify 用）
      targetLine: -1,       // 目标行下标（第N点 → N-1；-1 表示未知）
      raw: text
    };

    if (!text) return intent;

    // 第N点/第N条/第N项 → 目标行下标
    var idxMatch = text.match(/第\s*(\d{1,2})\s*[点条项个]/);
    if (idxMatch) intent.targetLine = parseInt(idxMatch[1], 10) - 1;

    // 动作识别（cut > copy > paste > delete > modify > add > 其他）
    if (/剪切|剪下|剪到/.test(text)) intent.type = 'cut';
    else if (/复制|拷贝/.test(text)) intent.type = 'copy';
    else if (/粘贴|贴上/.test(text)) intent.type = 'paste';
    else if (/删除|去掉|移除|清除|删掉/.test(text)) intent.type = 'delete';
    else if (/修改|改成|更新|更正|改为|换成|重排|整理|排序|调整顺序|重新排序/.test(text)) intent.type = 'modify';
    else if (/补充|增加|添加|加入|新增|补上/.test(text)) intent.type = 'add';
    else if (/总结|概括|小结|归纳/.test(text)) intent.type = 'summarize';
    else if (/翻译|译成|翻译成/.test(text)) intent.type = 'translate';
    else if (/生成|写一篇|写一份|起草/.test(text)) intent.type = 'generate';

    // 提取关键词（"关于XXX"或"第N点"）
    var kw = text.match(/关于([^，。,。；;！!？?\s]+)/);
    if (kw && kw[1]) intent.keyword = kw[1];
    else if (idxMatch) intent.keyword = '第' + idxMatch[1] + '点';

    // 提取补充 / 修改的新内容
    if (intent.type === 'add' || intent.type === 'modify') {
      var content = _extractEditContent(text, intent.type);
      intent.content = content || intent.keyword || '';
    }

    return intent;
  }

  // 从指令文本提取要补充 / 修改的内容片段（本地规则，确定性）
  function _extractEditContent(text, intentType) {
    var t = String(text || '').trim();
    if (!t) return '';
    if (intentType === 'add') {
      t = t.replace(/^(请|帮我|麻烦)?\s*(补充|增加|添加|加入|新增|补上)(一点|一些|一个|点|些|个)?/, '');
      t = t.replace(/^关于/, '').trim();
      t = t.replace(/(的)?(内容|要点|说明|部分)$/, '').trim();
    } else if (intentType === 'modify') {
      // 把第N点改成XXX / 将第N点改为XXX
      var m = t.match(/(?:把|将)\s*第\s*\d{1,2}\s*[点条项个]\s*(?:改成|改为|换成|更新为)\s*(.+)$/);
      if (m && m[1]) return m[1].trim();
      // XXX改成YYY / XXX改为YYY
      var m2 = t.match(/(?:改成|改为|换成|更新为)\s*(.+)$/);
      if (m2 && m2[1]) return m2[1].trim();
      t = t.replace(/^(请|帮我|麻烦)?\s*(修改|改成|更新|更正|改为|换成|重排|整理|排序|调整顺序|重新排序)/, '');
      t = t.replace(/^关于/, '').trim();
    }
    t = t.replace(/[。.!！\s]+$/, '').trim();
    return t;
  }

  // 计算插入点：最后一个分点之后；无分点则总结段前；否则文末
  function _resolveInsertLine(structure) {
    var b = structure.bulletLineIndexes || [];
    if (b.length > 0) return b[b.length - 1];
    if (structure.summaryHeadingIndex >= 0) return Math.max(0, structure.summaryHeadingIndex - 1);
    var lines = structure.lines || [];
    return Math.max(0, lines.length - 1);
  }

  // 按已识别分点风格生成下一个分点前缀
  function _nextBulletPrefix(structure) {
    var style = structure.bulletStyle;
    var count = (structure.bulletLineIndexes || []).length;
    if (style === '①') {
      var circles = '①②③④⑤⑥⑦⑧⑨⑩';
      var i = Math.min(count, circles.length - 1);
      return circles.charAt(i) + ' ';
    }
    if (style === '（1）') return '（' + (count + 1) + '）';
    if (style === '1.') return (count + 1) + '. ';
    if (style === '-') return '- ';
    if (style === '*') return '* ';
    return '- ';
  }

  // 定位目标行：优先第N点，其次关键词匹配，最后 -1
  function _findTargetLine(structure, intent) {
    var lines = structure.lines || [];
    if (intent.targetLine >= 0) {
      var b = structure.bulletLineIndexes || [];
      if (b.length > 0 && intent.targetLine < b.length) return b[intent.targetLine];
      if (intent.targetLine < lines.length) return intent.targetLine;
    }
    if (intent.keyword) {
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(intent.keyword) >= 0) return i;
      }
    }
    return -1;
  }

  // 受影响总结段的重写草稿（无总结段返回 null）
  function _buildSummaryDraft(structure, opType, detail) {
    if (structure.summaryHeadingIndex < 0) return null;
    var title = (structure.lines[structure.summaryHeadingIndex] || '总结').replace(/^#{1,6}\s*/, '').trim();
    var opDesc = { add: '新增要点', delete: '删除要点', modify: '修改要点' }[opType] || '调整内容';
    var tail = detail ? '（' + detail + '）' : '';
    return '## ' + title + '\n> 本章已' + opDesc + tail + '，请结合正文最新内容回顾。';
  }

  function _designAdd(structure, intent) {
    var lineIndex = _resolveInsertLine(structure);
    var content = intent.content || intent.keyword || '新增要点';
    var newLine = _nextBulletPrefix(structure) + content;
    return {
      op: 'add',
      lineIndex: lineIndex,
      position: 'after',
      content: newLine,
      summaryDraft: _buildSummaryDraft(structure, 'add', content)
    };
  }

  function _designDelete(structure, intent) {
    var line = _findTargetLine(structure, intent);
    if (line < 0) line = _resolveInsertLine(structure);
    return {
      op: 'delete',
      fromLine: line,
      toLine: line,
      summaryDraft: _buildSummaryDraft(structure, 'delete', intent.keyword)
    };
  }

  function _designModify(structure, intent) {
    var line = _findTargetLine(structure, intent);
    if (line < 0) line = _resolveInsertLine(structure);
    var content = intent.content || intent.keyword || '更新后的内容';
    var newLine = content;
    var lines = structure.lines || [];
    if (line >= 0 && line < lines.length && structure.bulletStyle) {
      var m = (lines[line] || '').match(/^([①②③④⑤⑥⑦⑧⑨⑩]|（\d{1,2}）|\d{1,2}[.、)）][ \t]*|[-*][ \t]*)/);
      if (m) newLine = m[0] + content;
    }
    return {
      op: 'modify',
      fromLine: line,
      toLine: line,
      content: newLine,
      summaryDraft: _buildSummaryDraft(structure, 'modify', content)
    };
  }

  function _designCut(structure, intent) {
    var line = _findTargetLine(structure, intent);
    if (line < 0) line = 0;
    return { op: 'cut', fromLine: line, toLine: line, summaryDraft: null };
  }

  function _designCopy(structure, intent) {
    var line = _findTargetLine(structure, intent);
    if (line < 0) line = 0;
    return { op: 'copy', fromLine: line, toLine: line, summaryDraft: null };
  }

  function _designPaste(structure, intent) {
    var line = intent.targetLine >= 0 ? intent.targetLine : _resolveInsertLine(structure);
    return { op: 'paste', lineIndex: line, position: 'after', summaryDraft: null };
  }

  // LLM 增强入口：无 API Key 或不可用时返回 null（回退本地规则）
  async function _tryLlmDesignPlan(pageId, structure, cmd) {
    var config = _getConfig();
    if (!config || !config.apiKey) return null;
    if (typeof AIAdapter === 'undefined' || !AIAdapter.chat) return null;
    try {
      var messages = [
        {
          role: 'system',
          content: '你是医学文献笔记编辑方案设计器。根据指令和文档结构快照输出 JSON，格式：{"reason":"","operations":[{"op":"add|delete|modify|cut|copy|paste"}],"contentMd":null,"bookmarkTitle":""}。只输出 JSON。'
        },
        {
          role: 'user',
          content: JSON.stringify({
            instruction: cmd && (cmd.raw || cmd.text || ''),
            structure: {
              bulletStyle: structure.bulletStyle,
              bulletLineIndexes: structure.bulletLineIndexes,
              summaryHeadingIndex: structure.summaryHeadingIndex,
              lines: structure.lines
            }
          })
        }
      ];
      var text = await AIAdapter.chat(messages, config);
      var parsed = _extractJson(text);
      if (!parsed) return null;
      var ops = Array.isArray(parsed) ? parsed : (parsed.operations || parsed.annotations);
      if (!Array.isArray(ops) || ops.length === 0) return null;
      return {
        reason: parsed.reason || '',
        operations: ops,
        contentMd: parsed.contentMd || null,
        bookmarkTitle: parsed.bookmarkTitle || ''
      };
    } catch (e) {
      return null;
    }
  }

  function _buildReason(intent, operations) {
    var desc = { add: '新增', delete: '删除', modify: '修改', cut: '剪切', copy: '复制', paste: '粘贴' }[intent.type] || '调整';
    return '对笔记执行' + desc + '操作，共 ' + operations.length + ' 条';
  }

  function _buildBookmarkTitle(intent) {
    var verb = { add: '补充', delete: '删除', modify: '修改', cut: '剪切', copy: '复制', paste: '粘贴' }[intent.type] || 'AI 编辑';
    if (intent.keyword) return verb + '『' + intent.keyword + '』';
    return verb + '操作';
  }

  // 非 edit 类指令：产出 contentMd（进书签，不污染正文）
  function _buildNonEditContent(intent) {
    var label = { summarize: '总结', translate: '翻译', generate: '生成', ask: '问答' }[intent.type] || 'AI 成果';
    return '## ' + label + '\n\n> 原始指令：' + (intent.raw || '') + '\n\n（本地规则引擎尚未接入内容生成，接入 LLM 后将产出完整内容。）';
  }

  // 方案设计公开接口：指令文本 + 结构快照 → 可执行编辑方案
  async function designEditPlan(pageId, cmd) {
    var raw = '';
    var cmdType = '';
    var structure = null;
    if (cmd && typeof cmd === 'object') {
      raw = cmd.raw || cmd.text || '';
      cmdType = cmd.type || '';
      structure = cmd.structure || null;
    } else if (typeof cmd === 'string') {
      raw = cmd;
    }

    if (!structure) structure = await analyzeStructure(pageId);

    var intent = _inferEditIntent(raw);
    var editOps = ['add', 'delete', 'modify', 'cut', 'copy', 'paste'];
    var isEdit = (cmdType === 'edit' || editOps.indexOf(intent.type) >= 0);

    var plan = {
      reason: '',
      operations: [],
      contentMd: null,
      bookmarkTitle: '',
      summaryDraft: null
    };

    if (isEdit) {
      var op = null;
      switch (intent.type) {
        case 'add': op = _designAdd(structure, intent); break;
        case 'delete': op = _designDelete(structure, intent); break;
        case 'modify': op = _designModify(structure, intent); break;
        case 'cut': op = _designCut(structure, intent); break;
        case 'copy': op = _designCopy(structure, intent); break;
        case 'paste': op = _designPaste(structure, intent); break;
        default: op = _designAdd(structure, intent); break;
      }
      if (op) {
        plan.operations.push(op);
        if (op.summaryDraft) plan.summaryDraft = op.summaryDraft;
      }

      // LLM 增强（可选，无 Key 自动回退本地规则）
      var llm = await _tryLlmDesignPlan(pageId, structure, cmd);
      if (llm && Array.isArray(llm.operations) && llm.operations.length > 0) {
        plan.operations = llm.operations;
        if (llm.reason) plan.reason = llm.reason;
        if (llm.bookmarkTitle) plan.bookmarkTitle = llm.bookmarkTitle;
      }
    } else {
      plan.contentMd = _buildNonEditContent(intent);
    }

    if (!plan.reason) plan.reason = _buildReason(intent, plan.operations);
    if (!plan.bookmarkTitle) plan.bookmarkTitle = _buildBookmarkTitle(intent);

    return plan;
  }

  // ============================================================
  // 模块 C：edit 执行器（applyEdit）
  // ============================================================

  // 插入位置 clamp 到 [0, len]
  function _clampPos(pos, len) {
    if (typeof pos !== 'number' || isNaN(pos)) return len;
    pos = Math.floor(pos);
    if (pos < 0) return 0;
    if (pos > len) return len;
    return pos;
  }

  // 目标行号 clamp 到 [0, len-1]（空数组返回 0，splice 空操作）
  function _clampLine(idx, len) {
    if (typeof idx !== 'number' || isNaN(idx)) return 0;
    idx = Math.floor(idx);
    if (idx < 0) return 0;
    if (len === 0) return 0;
    if (idx >= len) return len - 1;
    return idx;
  }

  // 单操作执行器：对行数组施加一条 operation，返回新行数组与剪贴板
  function _executeOperation(lines, op, clipboard) {
    var ls = lines || [];
    var clip = clipboard || [];
    var len = ls.length;
    if (!op) return { lines: ls, clipboard: clip };

    switch (op.op) {
      case 'add': {
        var pos = _clampPos((op.lineIndex || 0) + 1, len);
        var addLines = _splitLines(op.content || '');
        ls.splice(pos, 0, ...addLines);
        break;
      }
      case 'delete': {
        var dFrom = _clampLine(op.fromLine, len);
        var dTo = _clampLine(op.toLine, len);
        if (dTo < dFrom) { var dT = dFrom; dFrom = dTo; dTo = dT; }
        if (len > 0) ls.splice(dFrom, dTo - dFrom + 1);
        break;
      }
      case 'modify': {
        var mFrom = _clampLine(op.fromLine, len);
        var mTo = _clampLine(op.toLine, len);
        if (mTo < mFrom) { var mT = mFrom; mFrom = mTo; mTo = mT; }
        var modLines = _splitLines(op.content || '');
        if (len > 0) ls.splice(mFrom, mTo - mFrom + 1, ...modLines);
        else ls.push(...modLines);
        break;
      }
      case 'cut': {
        var cFrom = _clampLine(op.fromLine, len);
        var cTo = _clampLine(op.toLine, len);
        if (cTo < cFrom) { var cT = cFrom; cFrom = cTo; cTo = cT; }
        if (len > 0) {
          clip = ls.slice(cFrom, cTo + 1);
          ls.splice(cFrom, cTo - cFrom + 1);
        }
        break;
      }
      case 'copy': {
        var cpFrom = _clampLine(op.fromLine, len);
        var cpTo = _clampLine(op.toLine, len);
        if (cpTo < cpFrom) { var cpT = cpFrom; cpFrom = cpTo; cpTo = cpT; }
        if (len > 0) clip = ls.slice(cpFrom, cpTo + 1);
        break;
      }
      case 'paste': {
        var pPos = _clampPos((op.lineIndex || 0) + 1, len);
        var pasteLines = clip.slice();
        ls.splice(pPos, 0, ...pasteLines);
        break;
      }
      default:
        break;
    }
    return { lines: ls, clipboard: clip };
  }

  // 纯函数：按 operations 顺序对 mdContent 施加行级操作
  function _applyEditOperations(mdContent, operations) {
    var lines = _splitLines(mdContent);
    var clipboard = [];
    for (var i = 0; i < (operations || []).length; i++) {
      var r = _executeOperation(lines, operations[i], clipboard);
      lines = r.lines;
      clipboard = r.clipboard;
    }
    return _joinLines(lines);
  }

  // 重写受影响总结段：保留原正文，追加变更提示
  function _rewriteSummary(mdContent, summaryDraft) {
    if (!summaryDraft) return mdContent;
    var struct = _analyzeStructureMd(mdContent, null);
    var lines = _splitLines(mdContent);
    var draftLines = _splitLines(summaryDraft);
    // 去掉草稿首行标题，仅保留提示行（标题沿用原文）
    var hintLines = draftLines.filter(function (l) { return !_isHeadingLine(l) && l.trim() !== ''; });

    if (struct.summaryHeadingIndex >= 0) {
      var end = struct.summaryEndIndex > struct.summaryHeadingIndex ? struct.summaryEndIndex : struct.summaryHeadingIndex + 1;
      lines.splice(end, 0, ...hintLines);
    } else if (hintLines.length > 0) {
      lines.push('');
      lines.push(...hintLines);
    }
    return _joinLines(lines);
  }

  // edit 执行器公开接口：方案 → 变更后的 mdContent + diff
  async function applyEdit(pageId, plan) {
    // 快照优先：异步队列执行时 plan.oldMd 来自入队快照 noteMd，避免与实时正文（可能已被用户后续编辑）错位
    var hasPlanMd = !!(plan && typeof plan.oldMd === 'string');
    var oldMd = hasPlanMd ? plan.oldMd : '';
    if (!hasPlanMd && typeof DataLayer !== 'undefined' && DataLayer.getPageMd) {
      try { oldMd = await DataLayer.getPageMd(pageId); } catch (e) { oldMd = ''; }
    }

    var operations = (plan && plan.operations) || [];
    var newMd = _applyEditOperations(oldMd, operations);
    if (plan && plan.summaryDraft) {
      newMd = _rewriteSummary(newMd, plan.summaryDraft);
    }

    var diff = [];
    if (typeof DiffEngine !== 'undefined' && DiffEngine.diffLines) {
      try { diff = DiffEngine.diffLines(oldMd, newMd); } catch (e) { diff = []; }
    }

    // 写回
    var written = false;
    if (typeof DataLayer !== 'undefined' && DataLayer.putPageMd) {
      await DataLayer.putPageMd(pageId, newMd);
      written = true;
    }

    // 重渲染（当前页或无法确定当前页时触发）
    var rendered = false;
    if (typeof Notebook !== 'undefined' && Notebook.renderPage) {
      var currentId = null;
      if (Notebook.getCurrentPageId) { try { currentId = Notebook.getCurrentPageId(); } catch (e) { currentId = null; } }
      if (currentId === null || currentId === pageId) {
        try { await Notebook.renderPage(pageId); rendered = true; } catch (e) { rendered = false; }
      }
    }

    return { oldMd: oldMd, newMd: newMd, diff: diff, written: written, rendered: rendered };
  }

  // 正则特殊字符转义（供指令句兜底匹配）
  function _escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 从 mdContent 中删除指令句（、、{raw}。。）：优先按入队时记录的完整原文 mark 精确删除，
  // 兜底用正则匹配（raw 转义）；删除后清理因移除产生的多余空行。
  function _stripCommandMark(md, cmd) {
    if (!md || !cmd || !cmd.raw) return md;
    var out = md;
    if (cmd.mark) {
      out = out.split(cmd.mark).join('');
    }
    if (out.indexOf('、、') >= 0) {
      var re = new RegExp('、、\\s*' + _escapeRegExp(cmd.raw) + '\\s*。。', 'g');
      out = out.replace(re, '');
    }
    out = out.replace(/\n{3,}/g, '\n\n');
    return out;
  }

  // ============================================================
  // 模块 D：书签落库（_emitBookmark）+ 调度（runCommand）
  // ============================================================

  // 将一次 AI 成果整理为书签对象并落库（书签仅落库，UI 留 P5，默认收起）
  async function _emitBookmark(pageId, result) {
    var bm = {
      type: (result && result.type) || 'edit',
      title: (result && (result.bookmarkTitle || result.title)) || (result && result.reason) || 'AI 编辑成果',
      diff: (result && result.diff) || null,
      contentMd: (result && result.contentMd) || null,
      summary: (result && result.reason) || '',
      operations: (result && result.operations) || null,
      createdAt: Date.now(),
      collapsed: true
    };
    if (typeof DataLayer !== 'undefined' && DataLayer.putBookmark) {
      await DataLayer.putBookmark(pageId, bm);
    }
    return bm;
  }

  // 串联全流程：analyzeStructure → designEditPlan → applyEdit → _emitBookmark
  async function runCommand(cmd) {
    if (!cmd) throw new Error('runCommand 缺少指令对象');

    var pageId = cmd.pageId;
    if (!pageId && typeof Notebook !== 'undefined' && Notebook.getCurrentPageId) {
      try { pageId = Notebook.getCurrentPageId(); } catch (e) { pageId = null; }
    }
    if (!pageId) throw new Error('runCommand 缺少 pageId');

    var cmdId = cmd.id || null;
    if (cmdId && typeof CommandQueue !== 'undefined' && CommandQueue.markProcessing) {
      try { await CommandQueue.markProcessing(cmdId); } catch (e) {}
    }

    try {
      var snapshot = cmd.snapshot || null;
      // 基于快照 noteMd 分析结构（未提供快照时沿用实时 getPageMd）
      var structure = await analyzeStructure(pageId, snapshot ? snapshot.noteMd : null);
      // 让 designEditPlan 复用基于快照的结构，避免其内部再次实时 analyzeStructure 覆盖快照语义
      cmd.structure = structure;
      var plan = await designEditPlan(pageId, cmd);

      var result = {};
      var bookmark = null;
      var isEdit = (cmd.type === 'edit') || (Array.isArray(plan.operations) && plan.operations.length > 0);

      if (isEdit) {
        // 基于快照 oldMd 应用编辑，保证 plan（基于快照结构）与写入基线一致
        if (snapshot) {
          plan.oldMd = (snapshot.noteMd !== undefined && snapshot.noteMd !== null) ? snapshot.noteMd : '';
        }
        result = await applyEdit(pageId, plan);
        bookmark = await _emitBookmark(pageId, {
          type: 'edit',
          diff: result.diff,
          reason: plan.reason,
          bookmarkTitle: plan.bookmarkTitle,
          operations: plan.operations
        });
      } else {
        bookmark = await _emitBookmark(pageId, {
          type: cmd.type || 'ask',
          reason: plan.reason,
          bookmarkTitle: plan.bookmarkTitle,
          contentMd: plan.contentMd
        });
      }

      // 指令句处理完自动从笔记删除（临时指令不污染正文，成果已存书签）
      if (cmd.raw) {
        try {
          var curMd = await DataLayer.getPageMd(pageId);
          var cleaned = _stripCommandMark(curMd, cmd);
          if (cleaned !== curMd) {
            await DataLayer.putPageMd(pageId, cleaned);
            if (typeof Notebook !== 'undefined' && Notebook.renderPage) {
              var currentId = null;
              if (Notebook.getCurrentPageId) { try { currentId = Notebook.getCurrentPageId(); } catch (e) { currentId = null; } }
              if (currentId === null || currentId === pageId) {
                try { await Notebook.renderPage(pageId); } catch (e) {}
              }
            }
          }
        } catch (e) { /* 指令句清理失败不影响主流程 */ }
      }

      if (cmdId && typeof CommandQueue !== 'undefined' && CommandQueue.markDone) {
        try { await CommandQueue.markDone(cmdId); } catch (e) {}
      }

      return {
        pageId: pageId,
        plan: plan,
        result: result,
        bookmark: bookmark
      };
    } catch (e) {
      if (cmdId && typeof CommandQueue !== 'undefined' && CommandQueue.markFailed) {
        try { await CommandQueue.markFailed(cmdId, e && e.message ? e.message : String(e)); } catch (e2) {}
      }
      throw e;
    }
  }

  // ============================================================
  // 公开接口（设计规格 §5.8）
  // ============================================================
  return {
    classify: classify,
    executeCommand: executeCommand,
    focus: focus,
    readPdf: readPdf,
    isConfigured: isConfigured,
    onTaskComplete: onTaskComplete,
    _buildContext: _buildContext,
    _getConfig: _getConfig,
    _parseCommand: _parseCommand,
    _resolveTarget: _resolveTarget,
    _streamToNotebook: _streamToNotebook,
    _focusResult: _focusResult,
    _isModifyCommand: _isModifyCommand,
    _extractJson: _extractJson,
    _executeModifyCommand: _executeModifyCommand,
    _showModifyDiff: _showModifyDiff,
    _collectPdfContext: _collectPdfContext,
    _judgePdfCompleteness: _judgePdfCompleteness,
    analyzeStructure: analyzeStructure,
    _analyzeStructureMd: _analyzeStructureMd,
    designEditPlan: designEditPlan,
    applyEdit: applyEdit,
    _emitBookmark: _emitBookmark,
    runCommand: runCommand
  };
})();
