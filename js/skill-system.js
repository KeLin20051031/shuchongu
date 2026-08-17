/**
 * SkillSystem — 借鉴 deepseek-harness 的 skill 子系统设计
 * ============================================================
 * 设计参考：deepseek-ai/deepseek-harness 的 packages/skill/
 *
 * 核心概念（简化版）：
 * 1. Skill = 可复用的任务特定指令（YAML frontmatter + Markdown 正文）
 * 2. Catalog = name + description 摘要列表，注入 AI 上下文（模型只看摘要）
 * 3. Invoke = 按需加载完整 skill 正文，注入到 AI 的指令流中
 * 4. 三层发现源：内置(bundled) > 用户(localStorage) > 项目(fetch skills/)
 *
 * 与 deepseekharness 的差异：
 * - 前端 SPA 无文件系统，用 localStorage 替代 fs provider
 * - 内置 skill 直接嵌在代码中（无 .md 文件读取）
 * - catalog 注入点在 AIEngine._buildContext（非 agent/pre-step 事件）
 * - 调用策略简化为 modelInvocable + userInvocable 两种
 * ============================================================
 */
var SkillSystem = (function () {
  'use strict';

  // ============================================================
  // 内部状态
  // ============================================================
  var _skills = [];           // 已注册的 skill summary 列表
  var _skillBodies = {};      // name -> 完整正文（延迟加载缓存）
  var _userSkills = {};       // localStorage 中的用户自定义 skill
  var _enabledSkills = {};    // name -> true（未登记的 skill 按默认值决定是否启用，见 _defaultEnabled）
  var _initDone = false;

  var _STORAGE_KEY = 'shuchongu_skills_v1';
  var _ENABLED_KEY = 'shuchongu_skills_enabled_v1';

  // ============================================================
  // 内置 Skill 定义（bundled，rank=600）
  // 规范参考：deepseek-harness spec + agent-skills spec（2026-08）
  //   - frontmatter: name（kebab-case）+ description（做什么+何时触发，1024 字以内）
  //   - body: 密集可操作指示，结构 = Workflow / Decision Rules / Guardrails / Output Requirements / Verification
  //   - 不写 motivational filler；不写 version/tags/license；不超过 500 行
  // ============================================================
  var BUILTIN_SKILLS = [
    // --- 1. 文献精读（literature-critical-reading）：学术论文结构化提炼 ---
    {
      name: 'literature-critical-reading',
      whenToUse: '总结、概括、精读、提炼要点、摘重点、文献摘要、论文总结、提取核心内容、读懂、关键信息',
      source: 'bundled',
      description: 'Structures academic paper reading into PICO/I-SPARC 提取+局限性评估。Use when user asks to summarize paper, extract key points, "精读", extract findings, distill a literature PDF.',
      body: [
        '# Literature Critical Reading',
        '',
        '## Workflow',
        '1. 从 PDF 章节文本中识别论文的标准结构：标题、摘要、方法、结果、讨论、结论、参考文献、图表图例',
        '2. 按「PICO」维度提取：P(研究对象/人群)+I(干预/暴露)+C(对照/比较)+O(结局指标/效应量+统计学显著性)',
        '3. 若 PICO 不完整，补充 ISPARC 维度：Study design(实验/临床设计类型), Sample size(样本量, N), Primary endpoint(主要终点), Statistics(统计方法与核心 P 值/CI/HR)',
        '4. 提炼 Limitations：至少列出 3 条局限性（样本量、选择偏倚、混杂因素、测量方法、外推性、随访时间等）',
        '5. 提炼 Clinical Implication / Significance：该发现影响的临床或学科实践方向',
        '',
        '## Decision Rules',
        '- 若 PDF 只有方法学+表格，无明确摘要：以表格数据为核心输出 PICO+效应量',
        '- 若为综述/meta：额外提取 "纳入研究数/总样本量/异质性 I²/效应量合并结果"',
        '- 若为基础研究（分子/细胞/动物）：改用 Mechanism → Key Findings → Limitations 格式',
        '',
        '## Guardrails',
        '- 不得捏造未在原文中出现的实验数据或统计学值；缺失数据明确标记为「文中未报告」',
        '- P 值必须完整保留（p<0.05 / p=0.023 / 95%CI [1.1,2.4] 不得简化为 "有统计学意义"）',
        '- 不把相关性写成因果；"相关性显著"≠ "因果关系"',
        '',
        '## Output Requirements',
        '- 输出为 Markdown 中文笔记，使用 ## 二级标题分区：背景 / 研究设计 / PICO / 核心结果 / 局限性 / 临床意义',
        '- 关键数值使用粗体：**HR=1.34, 95%CI[1.12,1.61], p=0.001**',
        '- 每段控制在 120 字以内，多用短句，避免长句',
        '- 生成类任务：最终作为追加内容（add 操作，pos=全文末尾）写入笔记',
        '',
        '## Verification Checklist',
        '- [ ] PICO 四项均有对应内容或明确标注缺失',
        '- [ ] 至少 3 条局限性，每条均有原文依据',
        '- [ ] 所有效应量数值均与原文一致',
        '- [ ] 未出现原文未有的医学名词或结论性断言'
      ].join('\n')
    },

    // --- 2. 医学数据提取（medical-evidence-extraction）---
    {
      name: 'medical-evidence-extraction',
      whenToUse: '提取数据、提取表格、提取数值、提取结局、提取效应量、HR、OR、RR、MD、95%CI、统计分析、森林图',
      source: 'bundled',
      description: 'Extracts structured evidence data from medical literature: HR/OR/RR/MD + 95%CI + P values, with GRADE certainty assessment. Use when user asks to "extract data", "extract table", "pull endpoints", summarize statistics, HR, OR, forest plot.',
      body: [
        '# Medical Evidence Extraction',
        '',
        '## Workflow',
        '1. 扫描 PDF 章节文本和表格说明（table legends），定位所有带量化结局的陈述',
        '2. 建立提取记录：{outcome, measure(HR/OR/RR/MD), estimate, 95%CI_lower, 95%CI_upper, P, n, subgroup, model(adjusted/unadjusted)}',
        '3. 对每个结局评估 GRADE 证据质量：High / Moderate / Low / Very Low，给出降级理由（偏倚风险、不一致性、间接性、不精确性、发表偏倚）',
        '4. 标注统计显著性方向：有害(HR>1 且 CI 不跨 1) / 有益(HR<1 且 CI 不跨 1) / 无显著差异(CI 跨 1)',
        '',
        '## Decision Rules',
        '- 若原文报告了多变量调整 vs 未调整：优先保留调整后结果并标注 "adjusted for age, sex, ..."',
        '- 若原文给出 Forest plot 但无数据：只记录可读出的区间，并标注 "从图中读取，精度受限"',
        '- 若缺失 N：从纳入流程图或基线表反推并标注',
        '',
        '## Guardrails',
        '- 方向判断必须以 CI 是否跨 1（比率型指标）或是否跨 0（差值型指标）为唯一依据',
        '- 不得合并不同指标类型（HR vs OR）做综合结论',
        '- P<0.001 不要写成 "p=0"，保留三位有效数字以上',
        '',
        '## Output Requirements',
        '- 先输出 Markdown 表格：列 = 结局 | 指标 | 效应量(95%CI) | P | N | 方向 | GRADE',
        '- 表格后附一段 "数据解读"，总结总体模式和最大效应/最显著的结局',
        '- 作为 add 操作追加到笔记末尾',
        '',
        '## Verification Checklist',
        '- [ ] 每个效应量均含点估计+95%CI+P（或明确缺失原因）',
        '- [ ] 方向判断逻辑正确（跨 1/跨 0 判断）',
        '- [ ] GRADE 给出至少一条具体降级理由'
      ].join('\n')
    },

    // --- 3. 翻译（scholarly-translation）：医学专业中英互译 ---
    {
      name: 'scholarly-translation',
      whenToUse: '翻译、译、translate、中文翻译、英文翻译、英译中、中译英、英文摘要、英文写作',
      source: 'bundled',
      description: 'Performs precise medical/scientific Chinese↔English translation with MeSH term consistency and preserves all symbols, statistics, citations as-is. Use when user asks to translate, "译", bilingual abstract, turn paragraph into English/Chinese.',
      body: [
        '# Scholarly Translation',
        '',
        '## Workflow',
        '1. 识别源语句是否属于医学/科学文本：包含术语、公式、统计、基因符号、化学名、缩写、图表引用、参考文献',
        '2. 术语一致性：所有疾病、药物、解剖、化验项目使用 MeSH（医学主题词）或 IUPAC/IUBMB 标准译名',
        '3. 缩写处理：首次出现必须展开全称+括号缩写，此后可单独使用缩写；若上下文已出现过缩写，保持一致',
        '4. 符号保真：%、±、×、÷、≥、≤、α、β、γ、统计值(P/HR/OR/CI)、化学式、基因符号(HUGO斜体)全部按原文保留',
        '5. 句式适配：英文→中文避免翻译腔；中文→英文使用科学被动语态 + 第三人称客观表述',
        '',
        '## Decision Rules',
        '- 缩写若在原文已出现多次展开形式，按已有约定翻译，不擅自创造新缩写',
        '- 单位：保留 SI 单位符号（mg/kg、μL、mmol/L），不翻译单位词',
        '- 专有名词/药名：优先使用中国药典通用名；若不确定则写通用译名+括号原英文',
        '',
        '## Guardrails',
        '- 不得省略任何数字、百分比、P 值、CI 上下限',
        '- 不得翻译化学式、基因符号、IUPAC 名、数据库登录号',
        '- 不意译或润色超出原文语义，不添加原文没有的解释',
        '',
        '## Output Requirements',
        '- 译后内容直接作为 Markdown 段落追加到笔记末尾（add 操作）',
        '- 段落前加标题：## 翻译（中→英 / 英→中）',
        '- 如果存在原文引用编号 [1] [2]，原样保留',
        '- 不得将数字和统计量改写为中文汉字描述',
        '',
        '## Verification Checklist',
        '- [ ] 所有医学术语使用统一译名（前后一致）',
        '- [ ] 全部数字、统计符号、公式、缩写与原文完全一致',
        '- [ ] 没有添加原文未有的解释或总结性语句'
      ].join('\n')
    },

    // --- 4. HTML 设计（html-design）：升级版，严格遵循 harness 结构 ---
    {
      name: 'html-design',
      whenToUse: 'HTML、网页、交互组件、动画、可视化、画一个、设计一个、做一个、生存曲线、时间线、数据表格、卡片、仪表盘',
      source: 'bundled',
      description: 'Creates self-contained HTML widgets (SVG charts, interactive tables, timelines, custom dashboards) as ```html blocks rendered in sandboxed iframe. Use when user asks for HTML/web component, interactive element, animation, Kaplan-Meier plot, "draw a ..." visualized.',
      body: [
        '# HTML Design',
        '',
        '## Workflow',
        '1. 判断需求场景：数据可视化 / 交互表格 / 机制示意 / 时间线 / 仪表盘 / 思维导图 / 其它定制组件',
        '2. 【在笔记中部署 · 像人一样操作】先用 `notebook_readMd` 读取当前笔记原文；若提示"当前没有打开的笔记页"，先用 `notebook_createPage` 新建一页再读取。确认插入位置（末尾用 `notebook_appendMd`；开头用 `notebook_prependMd`；局部替换用 `notebook_replaceMd`）',
        '3. 生成一个 Markdown ```` ```html ```` 代码块，内部为完整自包含 HTML（`<style>`/`<body>`/`<script>` 齐全即可，**无需** `<!DOCTYPE html>`/`<html>` 外壳）',
        '4. 调用 `notebook_appendMd` / `notebook_prependMd` / `notebook_replaceMd` 把该代码块**真实写入**笔记（必须用工具落盘，而不是只输出文本）',
        '5. 【系统占位符机制】写入的 ```` ```html ```` 代码块会被系统自动提取：HTML 源码存入独立存储，代码块原位替换为 `@[html:ID]` 占位符；渲染时占位符还原为 `<iframe>` 实时效果。因此：',
        '   - **不要**把 HTML 直接内联在正文段落里（与 Markdown 语法冲突），必须用 ```` ```html ```` 代码块包起来',
        '   - 系统会自动注入 iframe 高度自适应脚本，**无需（也不要）手动添加 `__htmlBlock` 上报脚本**',
        '6. 完成后可调用 `notebook_readMd` 复核写入结果，确认占位符已生效',
        '',
        '## Decision Rules',
        '- 统计图：使用原生 SVG 绘制（<path>/<circle>/<line>），不引入任何第三方图表库',
        '- 思维导图：中心主题 + 分支辐射（可用 SVG 或 CSS 布局），支持 hover 高亮',
        '- 生存曲线(Kaplan-Meier)：横轴=时间，纵轴=生存率(0-1或0-100%)，阶梯线+截尾标记+hover 显示坐标',
        '- 交互表格：表头可点击排序，支持按列过滤（文本输入框或下拉），CSS nth-child(even) 斑马纹',
        '- 时间线：左轴竖线 + 节点圆点 + 左右交替卡片布局',
        '- 动画：CSS transition/keyframes，不使用 requestAnimationFrame 除非明确需要帧级控制',
        '',
        '## Guardrails',
        '- 容器宽度强制 width:100%，不得设固定像素宽度；高度控制在 min-height:80px 到 max-height:600px 之间，超过部分内部滚动（系统会自动适配 iframe 高度）',
        '- 不使用 alert/confirm/prompt；不引用任何外部资源（无 CDN、无图片、无远程字体），全部内联',
        '- 配色默认使用笔记主题色变量（可写死 #3a5a40 深绿 / #2f8f4e 亮绿 / #fef9e8 米色），但用户指定配色时优先用户',
        '- 字体：`"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,sans-serif`',
        '',
        '## Output Requirements',
        '- 通过 `notebook_*` 工具把 ```` ```html ```` 代码块写入笔记（content 参数）',
        '- 代码块前后留一个空行，避免 Markdown 解析错误',
        '- 所有 UI 文本使用中文（除非用户指令指定英文）；JS 注释使用中文',
        '',
        '## Verification Checklist',
        '- [ ] 已调用 notebook_* 工具真实写入笔记（而非仅输出文本）',
        '- [ ] 代码是单一 ```html 代码块，无额外包裹',
        '- [ ] 全部 CSS/JS 均内联，没有 src= 或 href= 指向外部',
        '- [ ] 宽度 100%，不设固定像素宽度',
        '- [ ] 未手动添加 __htmlBlock 脚本（系统自动注入）'
      ].join('\n')
    },

    // --- 5. Canvas 流程图制图（canvas-diagram）：升级版 ---
    {
      name: 'canvas-diagram',
      whenToUse: '流程图、制图、画图、示意图、循环图、通路图、关系图、信号通路、三羧酸、代谢、实验流程、机制图、概念图',
      source: 'bundled',
      description: 'Generates free-layout diagrams (nodes + edges JSON data) rendered as in-note Canvas editor with drag & full-editing tools. Use when user asks for flow chart, mechanism map, TCA cycle, pathway, "画图", process diagram, concept map.',
      body: [
        '# Canvas Diagram',
        '',
        '## Workflow',
        '1. 根据用户需求确定图类型：思维导图(mindmap) / 循环图(cycle) / 线性通路(linear) / 分支(branch) / 网状(network) / 流程(flow)',
        '2. 列出所有节点（实体、步骤、状态），分配 id=n1,n2,...；确定节点间连线关系 + 连线标签',
        '3. 生成图数据 JSON（格式见 Output Requirements），放在单独的 ```` ```json ```` 代码块中',
        '4. 【在笔记中部署 · 像人一样操作】先 `notebook_readMd` 读取当前笔记原文确定插入位置（若提示无笔记页，先 `notebook_createPage` 新建一页），再用 `notebook_appendMd` / `notebook_prependMd` / `notebook_replaceMd` 把 ```` ```json ```` 代码块**真实写入**笔记（必须用工具落盘）',
        '5. 【系统占位符机制】系统会自动提取该 JSON 块，保存为本地数据，并用 `@[diagram:ID]` 占位符替换插入到笔记；渲染时占位符还原为可编辑的 Canvas 流程图编辑器',
        '',
        '## Decision Rules — Layout Patterns',
        '- **思维导图**：中心主题节点放中央（Cx=400,Cy=200），一级分支 4~6 条向四周辐射（角度均分），二级分支沿一级分支末端继续延伸；连线带箭头',
        '- **循环图**（TCA、尿素循环等）：N 个节点沿圆排列，圆心(Cx=400,Cy=200)，半径 R=150；节点坐标：x=Cx+R*cos(2πk/N), y=Cy+R*sin(2πk/N)',
        '- **线性通路**（信号通路）：从左到右，x 坐标=100,240,380,520,...（步长 140px），y 统一=200',
        '- **实验流程**：步骤矩形从上到下（y 步长 80px），决策节点用菱形 shape="diamond"，True/False 分支向两侧展开',
        '- **药物机制**：药物(左)→靶点(中)→效应(右)，必要时加"上游/下游"蛋白层',
        '',
        '## Guardrails',
        '- 画布区域限定为 x∈[0,800], y∈[0,400]，节点不得超出',
        '- 节点最小尺寸 80×32，文本长度超过 12 字时 w 自动增大，或换行用 "\\n"',
        '- 连线不得穿过节点（必要时用 curve∈[-40,40] 做弯曲避让）',
        '- 激活/促进连线 color="#16a34a" label="→" 或 "激活"；抑制/阻断 color="#dc2626" label="⊣" 或 "抑制"；普通反应 color="#333" label="→"',
        '',
        '## Output Requirements',
        '输出 **一个** ```` ```json ```` 代码块，格式严格为：',
        '```json',
        '{',
        '  "nodes": [{ "id":"n1", "x":150, "y":80, "w":120, "h":40, "text":"柠檬酸", "shape":"rect", "color":"#e0f2fe" }],',
        '  "edges": [{ "id":"e1", "from":"n1", "to":"n2", "label":"→", "curve":0, "color":"#333" }]',
        '}',
        '```',
        '- shape ∈ {rect, circle, diamond}；color 推荐柔和色：#e0f2fe / #fef3c7 / #dcfce7 / #fce7f3 / #e0e7ff / #fed7aa',
        '- 节点 id 必须连续 n1,n2,...；连线 id 必须连续 e1,e2,...',
        '- JSON 代码块**单独占一段**，前后留空行；不要在 JSON 块前加额外描述文本',
        '- 通过 `notebook_*` 工具把 ```` ```json ```` 代码块写入笔记（content 参数）',
        '',
        '## Verification Checklist',
        '- [ ] 已调用 notebook_* 工具真实写入笔记（而非仅输出文本）',
        '- [ ] 每个 edge 的 from/to 都指向已存在的 node id',
        '- [ ] 所有节点坐标在 800×400 内，无重叠',
        '- [ ] shape 为允许值，color 为合法 hex 颜色',
        '- [ ] JSON 完全合法（可通过 JSON.parse）'
      ].join('\n')
    },

    // --- 6. 笔记结构化组织（note-structuring）---
    {
      name: 'note-structuring',
      whenToUse: '整理笔记、重构、组织、结构化、分章节、加标题、重新排版、做目录、分层、格式整理',
      source: 'bundled',
      description: 'Restructures messy/flat raw notes into hierarchical GFM Markdown with H2/H3 sections, nested bullets, table conversion, and TOC. Use when user asks to organize notes, restructure, reformat, add headings, split into sections, make TOC, clean up layout.',
      body: [
        '# Note Structuring',
        '',
        '## Workflow',
        '1. 扫描当前笔记全文（structure.lines），识别内容块：定义、公式、列表、表格、引用、图表描述、Q&A',
        '2. 建立二级大纲（## 标题）：通常为【背景 / 核心内容 / 数据表格 / 小结 / 关键问答】；用户有明确主题时按主题切分',
        '3. 将原文散落的句子按语义聚合到对应章节，保留原文一字不差（除了移除冗余空行、重复段落）',
        '4. 纯表格文本（列对齐用空格/竖线/逗号）识别并转换为 GFM Table（| 列 | 列 | + |---|---|）',
        '5. 在最开头插入【📑 目录】段落，列出所有 ## 标题 + 行号',
        '',
        '## Decision Rules',
        '- 若笔记已经有明确的 ## 标题：只做顺序调整和子标题补全，不重写现有标题',
        '- 若笔记存在 `@[diagram:ID]` / `@[html:ID]` 占位符或 ```` ```html ```` 块：整体移动到对应章节，不得拆分或删除',
        '- 若原文是 Q&A 形式（问：/ 答：）：转换为 `### Q: ...` + `A: ...` 的子标题结构',
        '- 原文中的编号列表（1. 2. 3.）和项目列表（-、*、•）保留其层级，不转换为非列表文本',
        '',
        '## Guardrails',
        '- 不得改写任何医学事实性内容、数字、结论；仅调整版式',
        '- 不得改变 `@[diagram:ID]`、`@[html:ID]` 占位符或代码块的原文内容，最多移动所在行',
        '- 所有标题（##、###）中文化，不使用英文标题（除非原文就是英文）',
        '',
        '## Output Requirements',
        '- 整个编辑用 modify 操作（或多个 modify），fromLine=0 toLine=N 直接替换全文',
        '- 目录放在第 1-5 行之间，格式为 `- 📌 XX章节` 每行一项',
        '- 章节之间留 2 行空白分隔（section buffer）',
        '- 修改前后，非空行的**纯文本内容**（不含换行/空格差异）必须完全一致，不得增删字',
        '',
        '## Verification Checklist',
        '- [ ] 目录列出所有 ## 标题，无遗漏无多余',
        '- [ ] 所有代码块、@[diagram:ID]、@[html:ID]、统计数值与原文逐字一致',
        '- [ ] 表格正确转换为 GFM |...| 格式，首行标题 + |---| 分隔',
        '- [ ] 大纲深度 ≤ 3 级（#, ##, ###），无更深层级'
      ].join('\n')
    },

    // --- 7. 研究问题生成（research-questioning）：批判性思考 ---
    {
      name: 'research-questioning',
      whenToUse: '批判、批判性阅读、质疑、提出问题、研究假设、设计实验、后续研究、局限性讨论、不足、为什么、缺陷',
      source: 'bundled',
      description: 'Generates critical research questions, falsifiable hypotheses, and follow-up experiment designs from a given paper. Use when user asks critical reading, "质疑", limitations discussion, propose next study, "提出问题", why, research gap.',
      body: [
        '# Research Questioning',
        '',
        '## Workflow',
        '1. 基于当前章节文本（尤其是结果与讨论部分），识别论文的核心结论断言',
        '2. 按 4 个维度提出质疑/后续研究方向：',
        '   (A) Internal Validity 内部效度：混杂因素控制？随机/盲法？样本量是否足以支撑效应量？',
        '   (B) Construct Validity 构念效度：测量指标与理论构念是否匹配？代理指标是否合理？',
        '   (C) External Validity 外部效度：人群/物种/实验条件外推到真实场景的边界？',
        '   (D) Statistical Conclusion Validity：模型假设是否满足？多重比较校正？效应量方向是否生物学合理？',
        '3. 针对每条局限性，提出 1-2 个可证伪的后续研究假设（H₀ / H₁ 形式），并给出最低可行的实验设计',
        '4. 若存在争议点或矛盾结果，列出正反两方证据并给出调和假设',
        '',
        '## Decision Rules',
        '- 如果是 RCT：重点问 randomization concealment / ITT / blinding 三个维度',
        '- 如果是观察性队列：重点问 confounding 控制（DAG 识别混杂）、失访、暴露定义时间窗',
        '- 如果是基础研究：重点问试剂批次/样本量估计/生物学重复 vs 技术重复',
        '',
        '## Guardrails',
        '- 不得使用「样本量小」这种泛泛之词；必须精确到「N=24 vs 报告 HR=1.35→power<60%」这种具体表述',
        '- 后续假设必须可证伪、可操作，不得写「进一步研究其机制」之类空洞建议',
        '- 批判时对事不对"论文"，不带主观评价',
        '',
        '## Output Requirements',
        '- 分成 ## 局限性分析 / ## 后续研究方向 / ## 关键开放问题 三部分',
        '- 每条局限性用「🔴」标记，每条后续假设用「🟢」标记，每条开放问题用「❓」标记',
        '- 后续研究方向包含：假设(H₀/H₁) + 设计 + 最小样本量估计 + 主要终点',
        '- 追加到笔记末尾（add 操作）',
        '',
        '## Verification Checklist',
        '- [ ] 每个局限性都有具体、可量化的支撑理由',
        '- [ ] 每个后续研究假设均为可证伪形式',
        '- [ ] 没有泛泛空洞的建议'
      ].join('\n')
    },

    // --- 8. 问答 / 解释（medical-explain）：面向患者或学习者的通俗解释 ---
    {
      name: 'medical-explain',
      whenToUse: '解释、给我讲一下、通俗、为什么会、什么是、类比、患者、给学生讲、科普、举例说明、易懂',
      source: 'bundled',
      description: 'Explains medical/scientific concepts in layperson Chinese with analogies, progressive layers (patient → student → expert), avoiding jargon or defining jargon inline. Use when user asks "explain", layperson reading, "通俗讲一下", patient education, analogize concept.',
      body: [
        '# Medical Explain',
        '',
        '## Workflow',
        '1. 判断目标读者层级：患者(primary)/学生(secondary)/专业人士(tertiary)。无明确指定时按患者层写，追加递进层',
        '2. 患者层（primary）：',
        '   - 一句话定义（≤25字）',
        '   - 生活类比（汽车/计算机/水管/花园等日常事物类比，不使用另一个医学术语）',
        '   - 三个要点：原因 / 症状表现 / 常用治疗方向',
        '   - 严禁任何缩写（不使用 MI、BP、NSAIDs，必须写全称）',
        '3. 学生层（secondary）：在患者层之后用分隔线 --- 分段，补充：病理生理机制简述 + 典型检查结果模式 + 1-2 个经典临床场景',
        '4. 专业层（tertiary）：在 --- 后再追加：指南分级推荐 + 争议点 + 最新关键进展（若上下文有文献信息则引用）',
        '',
        '## Decision Rules',
        '- 若用户已给出具体疾病/药物/机制名词但未说明层级：默认三级全开（患者+学生+专业）',
        '- 类比选择原则：必须是用户日常生活中会接触的事物；疾病机制类比必须保留因果方向，不得造成误导',
        '- 百分比/风险数字：用「100 个人里约 X 人」而非「3.2%」表达；绝对风险优先于相对风险',
        '',
        '## Guardrails',
        '- 患者层禁止出现缩写和未解释的医学术语；首次出现术语必须跟括号解释',
        '- 不得承诺治愈或给出具体用药剂量；治疗方向保持「XX 类药物/XX 类疗法」层面',
        '- 不对用户的症状做诊断；如果用户描述了个人症状并问是什么，最后必须加一句「这不能替代医生面诊，建议到正规医院就诊」',
        '',
        '## Output Requirements',
        '- Markdown 格式，使用 ## 患者版 / ## 学生版 / ## 专业版 分隔',
        '- 患者版中类比用 **【类比】** 粗体标签引导，单独成段',
        '- 数字全部使用中文用户友好的表达（100 人里约 3 人 / 约 1 万人中有 15 人）',
        '- 追加到笔记末尾（add 操作）',
        '',
        '## Verification Checklist',
        '- [ ] 患者层可被 12 岁中文母语者读懂',
        '- [ ] 类比保留因果方向，没有误导性混淆',
        '- [ ] 绝对风险优先于相对风险表述',
        '- [ ] 如涉及用户个人症状，末尾附面诊建议提示'
      ].join('\n')
    },

    // ========== 以下为「书虫蛊 · 医学教材阅读器」系统专属内置 Skills ==========

    // --- 9. 教材跳章 & 目录导航（textbook-navigate）---
    {
      name: 'textbook-navigate',
      whenToUse: '跳到、翻到、跳章、跳页、定位、找章节、第几章、第几节、目录、导航、我要看、打开XX章、去到',
      source: 'bundled',
      description: 'Drives the textbook reader\'s TOC → page jump pipeline: call pdf_getTOC only ONCE, find the target chapter by Chinese/ordinal number or keyword, then immediately pdf_jumpToPage(pageNum) WITHOUT re-reading TOC pages. Use when user asks "跳到第X章", "去XX节", "定位", "打开某个章节".',
      body: [
        '# Textbook Navigate',
        '',
        '## Workflow',
        '1. 若上下文未含 TOC：**只调用一次** pdf_getTOC 获取完整目录树（不要再调用第二次）',
        '2. 解析用户的目标章节，按优先级匹配：',
        '   (a) 章节编号：中文(第一章/第二节/第六篇) 或 阿拉伯(第3章) → 使用 cn2num 换算并匹配目录条目',
        '   (b) 关键词：如"腹部检查"、"光合作用暗反应" → 模糊匹配条目 title，得分 = 命中词数 + 标题长度惩罚（更短的精确标题优先）',
        '   (c) 页码数字：若用户明确写"第189页"直接跳（不经过 TOC）',
        '3. 匹配到目标条目后，**立即调用 pdf_jumpToPage(条目.pageNum)** —— 不要用 pdf_getPageText 再去读目录页核对',
        '4. 最后用自然语言向用户确认：「已跳转到 XXX 章（第 N 页）。是否需要我总结本章内容或做标注？」',
        '',
        '## Decision Rules',
        '- 若目录里目标匹配到多个相似条目（如"第6节"同时在多个章出现）：按 同级最近 / 顶级优先 选第一个，并把其它候选项列给用户选择',
        '- 若用户要求"跳到本章末尾 / 下一章 / 上一节"：先通过 TOC 找到当前章节对应的条目（比较当前页落在哪个条目区间），再定位相邻条目跳',
        '- 若 PDF 没有嵌入 outline（pdf_getTOC 返回空）：回退方案 = 用 pdf_getPageText 读前 3 页扫描"目 录 / CONTENTS / 第 X 章"模式，找到章标题 → 估算页码 → 跳页',
        '',
        '## Guardrails',
        '- ❌ 禁止：在匹配到 TOC pageNum 后再调用 pdf_getPageText 去读"目录所在的那一页"来核对（这是导致工具调用轮次爆炸的主要原因）',
        '- ❌ 禁止：跳到目标页后再自动调用 pdf_getPageText 读正文内容（除非用户明确要求"读完总结"）',
        '- ❌ 禁止：多次重复调用 pdf_getTOC',
        '',
        '## Output Requirements',
        '- 整个流程最少 1 轮、最多 2 轮工具调用（pdf_getTOC → pdf_jumpToPage）',
        '- 跳转结果用一句话描述：章节名 + 页码 + 提示是否继续操作',
        '',
        '## Verification Checklist',
        '- [ ] 最多 1 次 pdf_getTOC',
        '- [ ] 未用 pdf_getPageText 读取目录页码范围的页面',
        '- [ ] 成功 pdf_jumpToPage(正确页)'
      ].join('\n')
    },

    // --- 10. 医考考点提炼（exam-points）---
    {
      name: 'exam-points',
      whenToUse: '考点、重点、考研、执业医、期末考、考什么、必背、划考点、考点提炼、高频考点、考试重点、记忆点、出题、出题点',
      source: 'bundled',
      description: 'Extracts exam-ready high-yield points from medical textbook chapters, organized by Bloom taxonomy (memory → understand → application) with exam-style question hints. Use when user asks "考点", "考试重点", "执业医考研必背", "高频考点".',
      body: [
        '# Exam Points Extractor',
        '',
        '## Workflow',
        '1. 扫描当前章节 / 已划重点的文本，按「三级考点」分类提取：',
        '   🟢 **A 级 · 记忆型（定义 / 正常值 / 分期 / 分类）**：需背诵的名词解释、指标参考范围、肿瘤 TNM 分期、疾病分型等',
        '   🔵 **B 级 · 理解型（机制 / 病理生理）**：疾病的发生机制、代偿反应、通路异常、典型病理改变',
        '   🟠 **C 级 · 应用型（诊断 / 鉴别 / 首选检查 / 首选治疗）**：病例题会用到的"金标准 / 首选 / 次选 / 禁忌症"',
        '2. 每个考点附加 **【考法提示】**：出题形式（单选 / 多选 / 病例分析 / 简答）、混淆点（最易混的 B 选项）',
        '3. 末尾追加 **【易错点清单】**：3~8 条考生最常错的点，用 ❌ 错 / ✔ 对 对比形式',
        '',
        '## Decision Rules',
        '- 若章节是"解剖学"：优先 A 级（神经/血管/肌肉起止点/体表标志）+ C 级（临床入路危险区）',
        '- 若章节是"内科学/诊断学"：优先 C 级（诊断标准、首选检查、首选治疗）+ B 级（病理生理串联症状）',
        '- 若章节是"药理学"：优先 C 级（首选药 / 禁忌症 / 典型不良反应）+ A 级（药代特点）',
        '',
        '## Guardrails',
        '- 不编造临床数据：所有首选/金标准必须与教材原文一致，无原文依据不写',
        '- 正常值必须写全单位和条件（如"收缩压 90-139 mmHg（成人坐位，右上臂，汞柱式）"）',
        '',
        '## Output Requirements',
        '- 输出结构：## 🟢 A级必背 / ## 🔵 B级理解 / ## 🟠 C级应用 / ## ❌ 易错点清单',
        '- 每个考点 1 行，附 📌 页码引用',
        '- 【考法提示】用小字斜体或括号，不喧宾夺主',
        '- 追加写入笔记末尾（add 操作）',
        '',
        '## Verification Checklist',
        '- [ ] 三级分类齐全',
        '- [ ] 每个 C 级考点明确说明"首选/金标准/禁忌症"之一',
        '- [ ] 易错点清单 ≥ 3 条'
      ].join('\n')
    },

    // --- 11. 鉴别诊断（differential-diagnosis）---
    {
      name: 'differential-diagnosis',
      whenToUse: '鉴别、鉴别诊断、如何区分、和XX的区别、鉴别点、ddx、DDx、怎么判断是哪种、怎么区分、排除',
      source: 'bundled',
      description: 'Builds structured differential diagnosis tables for symptoms or diseases, including key distinguishing features (history, exam, labs, imaging). Use when user asks "鉴别诊断", "XX 和 YY 的区别", "如何区分", ddx.',
      body: [
        '# Differential Diagnosis Builder',
        '',
        '## Workflow',
        '1. 确定鉴别主轴：',
        '   - 症状型（如"胸痛"、"发热待查"）：按系统/病因分类',
        '   - 疾病型（如"心梗 vs 心绞痛"）：并列对比 2~4 个最常见疾病',
        '2. 每个鉴别维度至少包含：',
        '   - 病史：诱因/起病速度/病程/既往史/用药史',
        '   - 体格检查：生命体征 / 关键阳性体征 / 关键阴性体征',
        '   - 辅助检查：首选筛查 / 金标准 / 关键异常值',
        '   - 处理原则：首选治疗 / 紧急处理',
        '3. 最后列出「诊断路径的第一步」：临床上应先做什么检查/处理来初步区分',
        '',
        '## Decision Rules',
        '- 鉴别列表按"患病率由高到低"排序（常见→罕见），不要按字母序',
        '- 症状型鉴别不少于 5 个疾病（除非是极罕见症状）',
        '- 疾病型对比要突出"关键鉴别点"：1 个最决定性的区分指标，标 ⭐',
        '',
        '## Guardrails',
        '- 不使用"某某一般/通常"：给出具体可验证的阈值或体征',
        '- 所有用药建议都不得写具体剂量，只写药物类别+适应症',
        '',
        '## Output Requirements',
        '- 主体为 Markdown 对比表：行 = 疾病，列 = 病史 | 体征 | 辅助检查 | 处理',
        '- 表格下写「⭐ 关键鉴别点」一段，突出高权重区分信号',
        '- 追加写入笔记末尾（add 操作）',
        '',
        '## Verification Checklist',
        '- [ ] 至少 4 列维度',
        '- [ ] 排序是患病率从高到低（标注"常见病/罕见病"更优）',
        '- [ ] 关键鉴别点有 1 个并标注 ⭐'
      ].join('\n')
    },

    // --- 12. 诊断路径卡片（diagnostic-pathway）：配合 canvas-diagram 使用 ---
    {
      name: 'diagnostic-pathway',
      whenToUse: '诊断路径、诊断流程、临床路径、处理流程、处理步骤、第一步、先做什么、怎么一步步来、诊疗流程、算法',
      source: 'bundled',
      description: 'Generates a clinical diagnostic/management algorithm (flowchart-style node+edge JSON matching the canvas-diagram format). Use when user asks "诊断流程", "先做什么检查", "临床路径", "处理步骤".',
      body: [
        '# Diagnostic Pathway',
        '',
        '## Workflow',
        '1. 把诊断/处理路径抽象为 5~12 个节点的决策树，节点类型：',
        '   - 起点菱形（shape="diamond"）：主诉或症状触发',
        '   - 决策菱形（shape="diamond"）：Yes/No 问题（如"是否伴休克？""肌钙蛋白是否升高？"）',
        '   - 处理矩形（shape="rect" color="#dcfce7"）：操作 / 检查 / 治疗',
        '   - 终点矩形（shape="rect" color="#fef3c7"）：明确诊断 / 转诊 / 出院',
        '2. 按照 "首优 → 次优 → 再次优" 的临床优先级排列决策顺序（先排除急危重症）',
        '3. 生成 canvas-diagram 要求的 JSON：nodes + edges 列表，画布 800×400',
        '',
        '## Layout Rules',
        '- 起始节点在 (x=60,y=60)；主流程竖直向下（y 步长 ~80px）',
        '- Yes 分支向右偏移（x +160），No 分支继续直线向下',
        '- 决策分支最终汇合到一个"明确诊断 / 入院"等终点',
        '- 连线：急诊/红色（紧急转诊 color="#dc2626" label="紧急"）/ 阳性（color="#16a34a" label="是"）/ 阴性（color="#6b7280" label="否"）',
        '',
        '## Guardrails',
        '- 决策节点的问题必须是 Yes/No 闭合式问句，不要写开放式问题',
        '- 处理节点的文字 ≤ 14 字（或用\\n分行），操作名称符合临床术语规范',
        '',
        '## Output Requirements',
        '- 输出 ```json 代码块，格式严格遵循 canvas-diagram skill 中的 nodes/edges 约定',
        '- 代码块前后空行；代码块上方一句话描述本流程图适用的临床场景',
        '',
        '## Verification Checklist',
        '- [ ] 节点数在 5-12 之间',
        '- [ ] 坐标落在 800×400 画布内',
        '- [ ] 所有决策节点都是 Yes/No 问句'
      ].join('\n')
    },

    // --- 13. 划重点 & 批量标注（batch-highlight）---
    {
      name: 'batch-highlight',
      whenToUse: '划重点、标重点、批量标、自动划、关键句、标注这段话、高亮、把XX标出来、标记、做批注',
      source: 'bundled',
      description: 'Identifies exam-yield sentences in current page text and generates pdf-highlight annotations by start/end char indices, organized by color category (definition=yellow, mechanism=green, diagnosis=blue, danger=red). Use when user asks "划重点", "标记", "批量高亮", "自动划重点".',
      body: [
        '# Batch Highlight',
        '',
        '## Workflow',
        '1. 先用 pdf_getPageText 读当前页（或用户指定页）完整文本',
        '2. 在文本中定位下列类别句子并记录起止字符位置：',
        '   | 类别 | 颜色 | 触发信号 |',
        '   | 定义 | 黄色 | "...是指"/"定义为"/"...称为"/"...系指" |',
        '   | 机制/病理 | 绿色 | "由于"/"导致"/"机制是"/"病理表现为"/"通路由...激活" |',
        '   | 诊断/检查 | 蓝色 | "诊断标准"/"金标准"/"首选检查"/"阳性体征"/"...可诊断" |',
        '   | 治疗/危险 | 红色 | "首选治疗"/"禁用"/"禁忌症"/"致死"/"危及生命"/"紧急处理" |',
        '3. 对每个命中的短语：构造标注并调用阅读器的高亮 API 写入（startChar, endChar, colorCategory）',
        '4. 完成后给用户摘要：「本页已自动标注 N 处：定义 A、机制 B、诊断 C、危险 D；若需调整颜色请选中→右键」',
        '',
        '## Decision Rules',
        '- 句子长度：6 字 ≤ 标注范围 ≤ 140 字；过长的定义自动截断到第一个句号',
        '- 句子重叠：高优先级覆盖低优先级（危险红 > 诊断蓝 > 机制绿 > 定义黄）',
        '- 若文本是扫描件无字符层：降级为"列出重点句清单 + 页码 + 颜色类别"追加到笔记，用户手动标',
        '',
        '## Guardrails',
        '- 不把非定义的陈述句标为黄色（避免整页被标黄）',
        '- 红色类只标注明确的禁忌/紧急内容，不标一般副作用',
        '',
        '## Output Requirements',
        '- 优先使用系统内置的标注写入工具批量落盘；若工具不可用则退化为返回高亮 JSON 数组供用户复制',
        '',
        '## Verification Checklist',
        '- [ ] 至少覆盖 3 种颜色类别',
        '- [ ] 每个标注都落在原文真实字符范围内（startChar < endChar）',
        '- [ ] 无颜色冲突（重叠区按优先级取 1 色）'
      ].join('\n')
    },

    // --- 14. 标注导出 & 复习卡片（annotation-flashcards）---
    {
      name: 'annotation-flashcards',
      whenToUse: '复习卡、闪卡、导出标注、整理标注、生成问答卡、anki、背诵、默写、抽认卡、考自己、自我检测',
      source: 'bundled',
      description: 'Exports all user highlights/annotations into Q&A flashcard pairs (front=concept question, back=highlighted answer + page reference). Use when user asks "导出标注", "复习卡", "闪卡", "整理我画的重点", anki.',
      body: [
        '# Annotation Flashcards',
        '',
        '## Workflow',
        '1. 读取当前 PDF 的所有标注（高亮/下划线/笔记批注），按页号分组',
        '2. 将每条高亮文本转换为「问题 + 答案」对：',
        '   - 定义类 → 问题：「XXX 的定义是什么？」答案：高亮原文 + 页码',
        '   - 机制类 → 问题：「XXX 的发生机制？」答案：高亮原文',
        '   - 诊断类 → 问题：「XXX 的诊断金标准 / 首选检查？」答案：高亮原文',
        '   - 治疗类 → 问题：「XXX 的首选治疗 / 禁忌症？」答案：高亮原文',
        '3. 答案末尾追加 📌 第 X 页 + 颜色标签（便于回溯）',
        '4. 按章节分组输出，每组前附 ## 第X章 XXX 标题',
        '',
        '## Decision Rules',
        '- 若某高亮文本上下文不足以生成有意义的问题（独立短语）：跳过或合并邻近同类高亮',
        '- 若用户要求 Anki 格式：追加末尾 CSV 格式（问题,答案,标签）三列，UTF-8 BOM',
        '- 若用户要求 HTML 自测：参考 html-design skill，生成可点击翻面的交互卡片',
        '',
        '## Guardrails',
        '- 问题是独立的闭合问句，不要把答案的任何词泄露在问题里',
        '- 答案保留高亮原文一字不差（不 paraphrase，不做任何修改）',
        '',
        '## Output Requirements',
        '- 每组问答用 3 行：**问：**... / **答：**... / `---` 分隔',
        '- 追加写入笔记末尾（add 操作）',
        '',
        '## Verification Checklist',
        '- [ ] 问答对数量 ≥ 标注数量的 60%',
        '- [ ] 答案含页码引用',
        '- [ ] 问题中未泄露答案关键词'
      ].join('\n')
    },

    // --- 15. 教材笔记补全框架（textbook-note-framework）---
    {
      name: 'textbook-note-framework',
      whenToUse: '做笔记、写笔记、整理本章、笔记模板、笔记框架、本章笔记、学习笔记、课后笔记、生成笔记、结构化笔记',
      source: 'bundled',
      description: 'Generates a fillable textbook-study note framework (7-section skeleton) for the current chapter: Overview → Core Concepts → Key Data/Tables → Mechanisms → Clinical Applications → Common Pitfalls → Self-Test Questions. Use when user asks "做本章笔记", "笔记模板", "生成学习笔记框架".',
      body: [
        '# Textbook Note Framework',
        '',
        '## Workflow',
        '1. 先用 pdf_getTOC 确认当前章节标题和子结构，框架匹配章结构',
        '2. 再按章节实际需要读取正文（建议每页 maxChars=4000，不超过 5 页），填充框架占位内容或标注待填充位置',
        '3. 生成 7 段式骨架：',
        '   ## 📘 一、本章概览（Overview）',
        '   > 本章在整本书中的位置、与前后章的关系、2-3 句话说明本章解决什么问题',
        '',
        '   ## 🧠 二、核心概念（Core Concepts）',
        '   > 列出 3-8 个关键术语 + 定义原文摘录（或待填）',
        '',
        '   ## 📊 三、关键数据/表格（Key Data / Tables）',
        '   > 正常值、分期、评分标准、分型分级一览表（原文引用或待填）',
        '',
        '   ## ⚙️ 四、机制与通路（Mechanisms）',
        '   > 流程图位置 + 关键节点说明（若有 canvas-diagram 占位符可直接填入）',
        '',
        '   ## 🏥 五、临床应用（Clinical Applications）',
        '   > 常见病、首选检查、首选治疗、禁忌症清单',
        '',
        '   ## ⚠️ 六、常见陷阱（Common Pitfalls）',
        '   > 3-6 条易混淆点 / 经典错误选项 / 临床思维误区',
        '',
        '   ## ❓ 七、自测题（Self-Test Questions）',
        '   > 5-10 道简答/名词解释/A2 病例题，附答案折叠标记',
        '',
        '## Decision Rules',
        '- 若章节 < 8 页：优先全部读完再填，填充率 ≥ 70%',
        '- 若章节 > 30 页：以"写框架 + 标注应填入原文页码/段落"为主，不强行总结',
        '- 第七节自测题答案用 `> [!note]- 答案：XXX` 折叠格式（Obsidian callout 风格）',
        '',
        '## Guardrails',
        '- 不捏造数值和临床建议：没有原文依据的位置明确写"（待填）"并附引用提示',
        '',
        '## Output Requirements',
        '- 直接 modify 替换当前页 / 或 add 追加到整章笔记末尾（按用户当前上下文选择）',
        '- 标题用中文 emoji 前缀，视觉分层清晰',
        '',
        '## Verification Checklist',
        '- [ ] 7 个小节齐全',
        '- [ ] 每个小节要么有内容，要么有"待填+指引"',
        '- [ ] 自测题 ≥ 5 题，附答案'
      ].join('\n')
    },

    // --- 16. 书虫展板操作规范 v2（board-operation）重点：启用按开关 + 无感自动 + 可驱动真实 DOM 演示 ---
    {
      name: 'board-operation',
      whenToUse: '展板、board、教程、演示、教学、一步步、引导、教我怎么用、模拟流程、图文、可视化、HTML演示、MD结构化、展示给我看、示意图、同步到右侧、带我走一遍、真实操作',
      source: 'bundled',
      description: '书虫助手右侧兄弟展板（HTML 动态教学 + MD 结构化聚合）使用规范 v2。用户先点顶栏📐/📋 启用格式，未启用格式禁止生成；启用后 AI 必须在主需求完成的同时自动把辅助内容同步到展板（无感化，不用用户说用展板）；HTML 内可调用 PageAgent Lite（pageagent_*）驱动真实 DOM 做演示。',
      body: [
        '# 书虫展板 v2 · Board Operation',
        '',
        '## 0. 重要变化（v2 相对 v1）',
        '- 👁️ 展板位置：现在是 chatPanel 右侧**紧贴的兄弟元素**（不是屏幕最右的全局浮窗），随 chatPanel 一起移动/出现/消失。',
        '- 🎛 格式启用按用户开关：chatPanel 顶栏有两个按钮「📐 HTML」「📋 MD」，状态存在 localStorage，**只有被用户点亮的格式才能生成对应内容。没点亮的你禁止生成。**',
        '- 🤖 自动无感更新：只要相应格式是开的，你就必须在完成用户主需求的**同一轮内**把辅助内容同步到展板。**不要等用户说"用展板"三个字。**',
        '- 🎞 新增「真实操作演示」能力：HTML 展板除了画伪 UI，还能调用 `pageagent_*` 工具直接驱动当前页面的真实按钮/输入框/滚动，让用户看到真实控件被点亮、真的在跳页。',
        '',
        '## 1. 先读「展板启用状态」再动笔',
        'System Prompt 里已经注入当前 html/md 开关。每个请求开头你都会看到这样一段：',
        '```',
        '  【书虫展板】  当前启用格式：html=开, md=关',
        '```',
        '- html=开 → 你可以（且应该）生成 HTML 演示。',
        '- md=开 → 你可以（且应该）生成 MD 结构化。',
        '- html=关 → 禁止调用 board_renderHtml 也不要在 render 里传 html，调了会被 API 返回「⏭ HTML 格式未启用」。',
        '- md=关 → 禁止生成 MD；同理。',
        '- 如果两个都开：推荐一次 `board_render({html, md, focus:true})` 省 token，API 内部会分别执行。',
        '',
        '## 2. 双 Tab 分工（严格执行）',
        '',
        '| Tab | 定位 | 核心手段 |',
        '|---|---|---|',
        '| 📐 HTML 演示 | 动态 / 可视化 / 模拟 / 真实操作演示 | 步骤卡高亮、进度条、内嵌 onInterval 自动循环、setInterval/onclick 伪交互、**调用 pageagent_* 驱动真实 DOM 操作** |',
        '| 📋 MD 结构化 | 聚合 / 凝练 / 条理化 / 速查 / 索引 | 标题分级 + 表格 + checklist + FAQ + 对比 + 快捷键 |',
        '',
        '## 3. 无感自动更新：5 类场景必生成（不要等用户说用展板）',
        '',
        '### 3.1 操作类请求（翻章 / 跳页 / 开工具 / 删除等）',
        '- html=开 → 3~5 步骤卡：当前步骤 `.pa-step-num.active` 呼吸光环 + `.pa-progress-bar` 宽度同步 + `pageagent_click` / `pdf_jumpToPage` 真实执行。',
        '- md=开 → 结构清单：当前章节位置、下一章/上一章、预估时长、重点页码、常见坑表格。',
        '',
        '### 3.2 知识类请求（解释 / 总结 / 对比）',
        '- html=开 → 结构图/对比卡片/知识点热力图（内嵌 SVG 优先）。',
        '- md=开 → 提纲、表格、定义清单、对比表。',
        '',
        '### 3.3 教程类请求（怎么用 / 带我一步步 / 演示）',
        '- html=开 → 先展示流程卡，然后按时间线：`步骤卡高亮 → pageagent_screenshot 看当前页 → pageagent_click 点真实按钮 → 进度条推进`。',
        '- md=开 → 操作 checklist + 注意事项 + 常见坑。',
        '',
        '### 3.4 新手 / onboarding',
        '- html=开 + md=开：两边一起写，`board_render` 一次性搞定；html 用自动循环高亮 5 步；md 写功能总览+FAQ。',
        '',
        '### 3.5 纯是/否或 1 句话问答：不用展板，直接对话区回复。',
        '',
        '## 4. 「真实操作演示」PageAgent Lite 标准用法（4 个工具配合）',
        '### 4.1 工具总览',
        '- `pageagent_screenshot({maxChars})`：给你当前页面 DOM 快照 + 页码 + 展板开关。做演示前**先看一眼**，再决定 selector。',
        '- `pageagent_click({selector 或 text})`：真的点一个按钮/链接/标签。推荐 selector 精确，text 模糊匹配 button>a>label>span>div。',
        '- `pageagent_type({selector 或 label 文字, value})`：给 input/textarea/contentEditable 输入值。',
        '- `pageagent_scroll({selector?, top?, pxBy?})`：绝对/相对滚动页面或容器。',
        '',
        '### 4.2 典型执行节奏（演示"跳转到第 3 章"为例）',
        '```',
        '1. board_renderHtml：3 步卡 + 进度条 0% （第 1 步高亮）',
        '2. pageagent_screenshot() → 看一下当前 UI：书虫助手输入框 id=paChatInput，发送按钮 id=paBtnSend',
        '3. pageagent_type({selector:"#paChatInput", value:"帮我跳到第 3 章"})',
        '4. board_renderHtml：第 2 步高亮，进度 33%',
        '5. pdf_getTOC （真的获取目录，而不是伪演示）',
        '6. board_renderHtml：第 3 步高亮，进度 66%',
        '7. pdf_jumpToPage(匹配的 pageNum)（真的跳页）',
        '8. board_renderHtml：全部完成，进度 100%，顶部卡片加 ✓',
        '9. 对话区一句话：「✅ 完成！已帮你跳到第 3 章，右侧展板第 3 步高亮～」',
        '```',
        '注意：',
        '- ❌ **不要用 pageagent_* 去做"翻书 / 读目录 / 写笔记"主工作**。主工作继续用 pdf_* / note_* 工具。pageagent_* 只用来给用户"看一遍真实控件怎么动的"。',
        '- ✅ HTML 步骤卡的高亮 + 进度条 + 真实 pageagent/pdft 调用要同步推进，让用户「视觉看到步骤在走，同时页面真的在动」。',
        '',
        '### 4.3 本系统常用 selector（AI 可直接用，保证命中率高）',
        '- 书虫助手输入框：`#paChatInput`',
        '- 书虫助手发送按钮：`#paBtnSend`',
        '- 书虫助手悬浮球：`#paOrb`',
        '- 顶栏"划重点"按钮（如存在）：`.rm-header button[data-action="highlight"]` 或 `button:has-text("划重点")`——这里 CSS 选择器做不到 has-text，用 text 参数传"划重点"',
        '- 跳页码输入框：常见选择器 `#pageJumpInput` 或 text="页码"',
        '- 书架按钮：顶栏左侧第一个按钮 text="书架"',
        '',
        '## 5. HTML 风格规范（继续用预置高级 class，朴素原生风禁用）',
        '### 5.1 必须用的 class 清单',
        '`.pa-demo-card` / `.pa-step` / `.pa-step-num(.active)` / `.pa-step-title` / `.pa-step-desc` / `.pa-step-kbd` / `.pa-tags` / `.pa-tag(-purple/-pink/-amber)` / `.pa-progress + .pa-progress-bar` / `.pa-fake-btn(.ghost/.warn)` / `.pa-bubble`。',
        '',
        '### 5.2 最小模板（直接复制改）',
        '```html',
        '<div class="pa-demo-card">',
        '  <div style="font-weight:600;color:#fff;margin-bottom:10px;">🎯 目标：跳转到第 3 章</div>',
        '  <div class="pa-step"><div class="pa-step-num active">1</div>',
        '    <div class="pa-step-body"><div class="pa-step-title">在输入框输入指令</div>',
        '      <div class="pa-step-desc">"帮我跳到 <code>第 3 章</code>"</div>',
        '    </div>',
        '  </div>',
        '  <div class="pa-step" style="margin-top:8px;"><div class="pa-step-num">2</div>',
        '    <div class="pa-step-body"><div class="pa-step-title">AI 匹配目录并跳页</div>',
        '      <div class="pa-step-desc">工具调用：<span class="pa-tag">pdf_getTOC</span> <span class="pa-tag-purple">pdf_jumpToPage</span></div>',
        '    </div>',
        '  </div>',
        '  <div class="pa-progress" style="margin-top:12px;"><div class="pa-progress-bar" style="width:33%"></div></div>',
        '</div>',
        '<div class="pa-bubble">💡 正在执行第 1 步…你可以在「👁 跟随」模式下看到完整工具流。</div>',
        '```',
        '',
        '### 5.3 自动循环步骤高亮（onerror 技巧，不用 <script>）',
        '```html',
        '<img src="x" style="display:none" onerror="(function(){',
        "  var root = this.closest('.pa-demo') || document.querySelectorAll('.pa-demo')[document.querySelectorAll('.pa-demo').length-1];",
        "  var nums = root.querySelectorAll('.pa-step-num');",
        "  var bar  = root.querySelector('.pa-progress-bar');",
        "  var i = 0;",
        "  function tick(){",
        "    nums.forEach(function(n,k){ n.classList.toggle('active', k===i); });",
        "    if(bar) bar.style.width = Math.round(100*(i+1)/Math.max(1,nums.length)) + '%';",
        "    i = (i+1) % nums.length;",
        "  }",
        "  tick(); setInterval(tick, 2400);",
        '}).call(this);">',
        '```',
        '',
        '## 6. MD 展板规范（聚合凝练，禁止和对话区重复）',
        '结构模板：',
        '```md',
        '# XX · 结构化速查',
        '',
        '## 🎯 目标',
        '- 场景：…',
        '- 一句话做法：…',
        '',
        '## 🛠 步骤清单',
        '1. 步骤一（关键在 `xxx`）',
        '2. 步骤二（关键在 `yyy`）',
        '',
        '## ⚠️ 常见坑',
        '| 坑 | 现象 | 怎么避 |',
        '|---|---|---|',
        '|  |  |  |',
        '',
        '## 💡 同类功能对比表 / FAQ / 快捷键',
        '```',
        '',
        '## 7. 对话区 vs 展板 · 严格分工（严禁重复）',
        '- 对话区：一句话结论 + 引导下一步提问。展板里已写的步骤 / 表格不要在聊天窗口里再复述一遍。',
        '- 标准话术模板：`「✅ 已经帮你做啦！同时我在右侧展板同步更新了：📐 HTML Tab 是刚刚的真实操作流程（循环高亮），📋 MD Tab 是结构化速查（步骤+坑+快捷键），需要我带你重新走一遍的话就说「再演示一下」😉」`',
        '',
        '## 8. 验证清单',
        '- [ ] 生成前先确认对应格式已启用（没启用直接跳过）',
        '- [ ] HTML 用了预置 class + 有进度条/呼吸光环（不能朴素）',
        '- [ ] MD 是结构化标题/表格/清单，不跟对话区重',
        '- [ ] 涉及"操作演示"的，至少用了一次 pageagent_screenshot 看 UI，再用 pageagent_click/pageagent_type 真实点一下',
        '- [ ] 对话区话术 ≤ 2 行，没有把展板内容抄回来'
      ].join('\n')
    },

    // --- 17. 系统新手引导 v2（system-onboarding）+ 真实 pageagent 演示参考代码
    {
      name: 'system-onboarding',
      whenToUse: '新手、第一次用、不会用、引导、教我用、入门、上手、演示功能、一步步带我玩、功能介绍、功能总览、带我玩一遍、真的操作给我看',
      source: 'bundled',
      description: '新手引导 v2：AI 必须先同步写入展板 HTML+MD（按当前开关），然后真的调用 pageagent_* + pdf_* 一步步实际操作给用户看。含大量 selector/参数参考。',
      body: [
        '# 书虫蛊 新手引导 System Onboarding · v2',
        '',
        '## 1. 触发条件（任一命中即执行本 skill）',
        '- 用户说「我不会用 / 新手 / 引导我一下 / 真的演示给我看 / 教我 / 第一次用 / 一步步带我玩」',
        '- 对话历史为空时（用户第一次打开应用）',
        '- 用户连续 2 次以上问按钮/菜单在哪 → 说明需要总览不是零散问答',
        '',
        '## 2. 展板格式判断（第一步先做这个）',
        '先看 System Prompt 里的 `html=开/关, md=开/关`：',
        '- html=开：必须生成 HTML 展板（5 步卡 + 自动循环高亮 + 进度条）',
        '- md=开：必须生成 MD 展板（总览 + 6 场景指令 + FAQ + 快捷键）',
        '- 两个都开：一次 `board_render({html, md, focus:true})`',
        '- 某个关：就不要生成对应格式。',
        '',
        '## 3. 执行顺序（两轮）',
        '### 第一轮 · 总览（AI 自动完成，别等用户）',
        '1. `board_toggle(true)` 展开',
        '2. `board_render({html: "5 步上手卡", md: "功能速查手册", focus: true})`',
        '3. 对话区输出第 8 节标准开场白',
        '',
        '### 第二轮 · 选择深入（用户说第 N 步 / 或说"全部演示"）',
        '- **不要只做 HTML 假动画！！必须真的调用工具让用户看到真实页面动起来**。',
        '- 节奏公式（每一步）：展板高亮第 i 步 → `pageagent_screenshot()` 看 UI → 调用真实 pageagent_* / pdf_* → 展板推进进度条 → 对话区第 8 节标准话术。',
        '- 5 步做完给第 8 节收尾话术。',
        '',
        '## 4. HTML 5 步上手（AI 直接整块复制到 board_render 的 html 参数）',
        '```html',
        '<div class="pa-demo-card">',
        '  <div style="font-weight:600;color:#fff;margin-bottom:10px;font-size:15px;">🚀 快速上手 · 5 步成为书虫</div>',
        '  <div style="font-size:12.5px;color:#94a3b8;margin-bottom:14px;">下面 5 个动作覆盖 90% 日常阅读场景，我会一边高亮一边真实操作给你看～</div>',
        '',
        '  <div class="pa-step" style="margin-bottom:10px;">',
        '    <div class="pa-step-num active">1</div>',
        '    <div class="pa-step-body"><div class="pa-step-title">翻目录跳章节</div>',
        '      <div class="pa-step-desc">对着🐛说「帮我跳到第 X 章」。<span class="pa-tag">最常用 ⭐</span></div>',
        '    </div>',
        '  </div>',
        '  <div class="pa-step" style="margin-bottom:10px;">',
        '    <div class="pa-step-num">2</div>',
        '    <div class="pa-step-body"><div class="pa-step-title">生成结构化本章笔记</div>',
        '      <div class="pa-step-desc">「给我整理本章笔记」→ 7 段式：概览/概念/数据/机制/临床/陷阱/自测。</div>',
        '    </div>',
        '  </div>',
        '  <div class="pa-step" style="margin-bottom:10px;">',
        '    <div class="pa-step-num">3</div>',
        '    <div class="pa-step-body"><div class="pa-step-title">4 色划重点（语义化）</div>',
        '      <div class="pa-step-desc">长按 PDF 文字选中后弹颜色面板：蓝=定义 紫=机制 黄=结论 红=疑问。</div>',
        '    </div>',
        '  </div>',
        '  <div class="pa-step" style="margin-bottom:10px;">',
        '    <div class="pa-step-num">4</div>',
        '    <div class="pa-step-body"><div class="pa-step-title">任何不懂直接问 AI</div>',
        '      <div class="pa-step-desc">选中文字后右键→AI 解释；或在输入框直接提问。</div>',
        '    </div>',
        '  </div>',
        '  <div class="pa-step" style="margin-bottom:14px;">',
        '    <div class="pa-step-num">5</div>',
        '    <div class="pa-step-body"><div class="pa-step-title">📚 返回书架 & 多书管理</div>',
        '      <div class="pa-step-desc">助手快捷操作或顶栏书架按钮。每本书独立记忆，核对过的目录永久记住。</div>',
        '    </div>',
        '  </div>',
        '  <div class="pa-progress"><div class="pa-progress-bar" style="width:20%"></div></div>',
        '</div>',
        '',
        '<div class="pa-bubble">💡 对 AI 说「从第 1 步开始真实演示」，我就一步步实际点击给你看～</div>',
        '',
        '<img src="x" style="display:none" onerror="(function(){',
        "  var roots = document.querySelectorAll('.pa-demo'); var root = roots[roots.length-1];",
        "  var nums = root.querySelectorAll('.pa-step-num');",
        "  var bar  = root.querySelector('.pa-progress-bar');",
        "  var i=0;",
        "  function tick(){",
        "    nums.forEach(function(n,k){ n.classList.toggle('active', k===i); });",
        "    if(bar) bar.style.width = Math.round(100*(i+1)/Math.max(1,nums.length)) + '%';",
        "    i = (i+1) % nums.length;",
        "  }",
        "  tick(); setInterval(tick, 2500);",
        '}).call(this);">',
        '```',
        '',
        '## 5. MD 功能速查（AI 整块复制到 board_render 的 md 参数）',
        '```md',
        '# 📘 书虫蛊 · 新手速查',
        '',
        '## 🧭 界面总览',
        '- 中间大图：PDF 阅读器主画布',
        '- 左上角 🐛 悬浮球 → 点它展开 **书虫助手**（AI 对话+工具），本展板就是助手的右兄弟面板',
        '- 顶栏：书架 / 打开 / 目录 / 划重点 / 页码跳转 / 缩放',
        '- 右上角：设置 / AI / ?帮助 / 搜索',
        '',
        '## 💡 6 个常见场景 · 一句话搞定',
        '| 你想做 | 对 AI 说 | AI 调用的工具 |',
        '|---|---|---|',
        '| 跳到第 3 章 | `帮我跳到第 3 章·细胞信号转导` | pdf_getTOC → pdf_jumpToPage |',
        '| 总结本章 | `总结第 4 章要点` | pdf_getTOC → pdf_getPageText × N → note_add |',
        '| 生成笔记模板 | `给我本章的 7 段式笔记模板` | textbook-note-framework skill |',
        '| 论文精读 | `帮我精读这篇论文` | literature-critical-reading skill |',
        '| 导出闪卡 | `把我所有重点导出为复习卡` | annotation-flashcards skill |',
        '| 对比两个病 | `比较心梗 vs 心绞痛` | 自己组织表格 + 写 MD 展板 |',
        '',
        '## ⌨️ 快捷键',
        '- `Alt + A`：呼出 / 收起 书虫助手',
        '- `Alt + J`：跳页面板',
        '- `Ctrl + F`：搜索当前书',
        '- `Ctrl + S`：保存笔记（自动已开）',
        '',
        '## ❓ 新手 FAQ',
        '- **Q1. 点目录里的章节没反应？** → 直接对 AI 说「帮我跳 X 章」；或点 PDF 侧栏 outline 书签图标。',
        '- **Q2. 提示「工具调用轮次过多」？** → 新版本已用 harness memory 拦截"反复读目录页验证"，基本不会出现；遇到直接让 AI 少读页、用 TOC 直接跳。',
        '- **Q3. 笔记丢了怎么办？** → 自动保存在 localStorage，书架菜单 → 导出本书笔记为 .md 做备份。',
        '- **Q4. 怎么把重点导出？** → 对 AI 说「把我所有重点导出为复习卡 / CSV」。',
        '',
        '## 🧠 AI 工作原理（不要求理解，但给好奇宝宝）',
        '1. 你输入一句话',
        '2. AI 选 skill → 选工具（pdf_* / note_* / board_* / pageagent_*）',
        '3. 每一步工具执行结果都回到 AI 再思考',
        '4. 对话区给你一句话结论，**视觉流程同步到右侧展板**',
        '```',
        '',
        '## 6. 第二轮 · 真实演示 · 第 1 步「跳章节」完整执行参考（工具序列 + 对应参数）',
        '（复制下面整段当计划，依次执行）',
        '',
        '1. 调用 `pageagent_screenshot({maxChars: 3000})` → 拿到当前 DOM 快照 + 当前页号 + 展板开关',
        '2. 调用 `board_render({html: "只保留 3 步卡：第 1 步高亮", focus: true})`',
        '3. 调用 `pageagent_type({selector: "#paChatInput", value: "帮我跳到第 2 章"})` → 把指令真实输入到助手输入框（视觉上用户能看到字进去了）',
        '4. 调用 `board_renderHtml` → 第 2 步高亮，进度 33%',
        '5. 调用 `pdf_getTOC()` → 真的拿目录，匹配一个存在的章节（没有就挑 TOC 里实际存在的最后一级目录名）',
        '6. 调用 `board_renderHtml` → 第 3 步高亮，进度 66%',
        '7. 调用 `pdf_jumpToPage(匹配到的 pageNum)` → 真的翻页，用户能看到页面动',
        '8. 调用 `board_renderHtml` → 3 步都完成，进度条 100%',
        '9. 对话区第 8 节话术：「✅ 第 1 步搞定了！刚刚真的翻到了第 X 章 p.Y。继续下一步的话说『继续』，或者有不懂随时问😉」',
        '',
        '## 7. 第二轮 · 真实演示 · 第 2~5 步精简工具序列',
        '- 第 2 步（生成笔记）：`pageagent_screenshot → board_renderHtml 3 步卡 → pageagent_type({selector:"#paChatInput", value:"给我当前章节笔记"}) → 真的调 textbook-note-framework 或 note_add → 推进进度 → 话术`',
        '- 第 3 步（划重点）：`board_renderHtml 画 4 色面板 + 高亮说明卡片 → 对话区提示用户长按文字 → 真的如果当前有选中文本就调 PDF 高亮工具`',
        '- 第 4 步（问 AI）：`pageagent_type({selector:"#paChatInput", value:"解释一下 XX 概念"}) → 发送后你现场回答 + 在展板 HTML 画图解 + MD 写提纲`',
        '- 第 5 步（书架）：`pageagent_click({text:"书架"}) → 如果按钮存在且成功返回 ok→ 展板 5/5 打勾 + 进度 100%；没找到按钮就 fall back：board_renderHtml 画书架 UI + 说明「顶栏点『📚 书架』按钮」`',
        '',
        '## 8. 对话区话术（AI 严格照抄）',
        '### 8.1 标准开场白',
        '> 「你好呀！欢迎来到 **书虫蛊** 🐛 —— 我先把「快速上手 + 功能速查」同步到右侧展板了：',
        '> ',
        '> - 📐 HTML Tab：5 步核心动作，会自动循环高亮（呼吸光环 + 进度条）',
        '> - 📋 MD Tab：功能地图 + 6 个常见场景一句话指令 + FAQ',
        '> ',
        '> 你可以：',
        '> 1️⃣ 说「从第 1 步开始真实演示」，我一步步实际点给你看',
        '> 2️⃣ 或者直接跟我说你要干嘛：比如「我要看第 3 章」，我直接帮你干～」',
        '',
        '### 8.2 每一步开始前',
        '> 「好的，第 X 步：**XXX**。展板会高亮当前步骤，我同时真的点按钮/跳页给你看，全程你在「👁 跟随」模式下能看到每个工具调用～」',
        '',
        '### 8.3 每一步结束后',
        '> 「✅ 第 X 步完成！刚刚真的做了：XXX。继续下一条就回「继续」，有疑问随时打断我😉」',
        '',
        '### 8.4 全部完成收尾话术',
        '> 「🎉 五步全部演示完啦！你已经掌握核心操作啦👏',
        '> ',
        '> 以后遇到任何情况：左上角🐛一句话就能搞定。需要我干嘛直接说～还有什么想先试试的吗？」',
        '',
        '## 9. 验证清单',
        '- [ ] 第一轮展板 html/md 已按当前开关写入（关的不生成）',
        '- [ ] 第二轮每一步都有展板高亮 + 真实 pageagent/pdf 工具调用（不是只有假动画）',
        '- [ ] 每步对话区只用短话术 + 引导，不把展板内容抄回',
        '- [ ] 五步完成后给出第 8.4 节标准收尾话术'
      ].join('\n')
    },
    {
      name: 'pdf-highlight-workflow',
      whenToUse: '划重点 / 做标注 / highlight / 标记重点 / 划线 / 圈出 / 给重点 / 标注 / annotate / 划重点页 / 画高亮 / 做笔记卡片 / 标出 / 标考点 / 标难点 / 标定义',
      source: 'bundled',
      rank: 600,
      description: '书虫蛊专属 PDF 划重点流程。严禁调用 ai_autoHighlight 任何一键整页划重点黑盒。必须按 6 步原子链路：读原文 → 归纳三级提纲 → annot_locateQuotesBatch 查坐标 → annot_addBatchByRect 批量画 → annot_query 回读校验 → annot_modifyElement 局部调色美化。内置红一级/蓝二级/绿橙三级配色、美观护栏、5-8 页分批次、每页≤15处等硬约束。Use when user asks to annotate/highlight/underline 任何形式的划重点。',
      body: [
        '# PDF Highlight Workflow（书虫助手划重点规范）',
        '',
        '## 总准则 (Non-negotiable)',
        '- 严禁调用「ai_autoHighlight」或任何一键整页/整本书划重点的高层捷径；必须走下方 6 步原子链路。',
        '- 标注的意义 = 提纲挈领、帮助用户秒懂结构；≠ 满页涂鸦。宁可少而精，不可多而乱。',
        '- 所有新建标注必须 author=ai（annot_addByRect / annot_addBatchByRect 都显式写 author=ai），以便 annot_query(author=ai) 能回查。',
        '',
        '## Workflow (6 Steps)',
        '### Step 1. 读 —— ai_readPdf 获取原文',
        '- 用户给范围（1-10 页 / 第 3 页 / 全书）→ 直接用；用户没说范围 → 先 ai_readPdf 看当前页上下文，再问用户或默认「当前页 + 前后 2 页」。',
        '- 一次批量不要 > 8 页；> 8 页时分 5-8 页为一批，每批结束 annot_query 校验再进下一批，并给用户汇报进度。',
        '- 若 PDF 提取文本为空白（扫描件）→ 明确告知用户「当前为扫描件无法自动定位，建议改成 annot_addByRect 框选图片区域 + 附卡片解释」并询问是否继续。',
        '',
        '### Step 2. 归纳 —— 输出三级提纲（内部思考，不用发给用户）',
        '- 一级要点（核心结论/章节标题/最重要定义）≤ 3 处/页；',
        '- 二级要点（关键概念、术语、方法步骤）3-6 处/页；',
        '- 三级要点（考点/难点/易错点/记忆口诀/老师常提）2-6 处/页；',
        '- 并列项必须整组同色同类型；「例如/包括/分为/主要有」后的每个分项各给一个标注，绝对不要只给父项一个大色块。',
        '- 表格：表头给一级高亮；关键对比行给二级下划线；显著结论单元格给三级绿色高亮。',
        '',
        '### Step 3. 查坐标 —— annot_locateQuotesBatch(pages, queries)',
        '- queries 每项 = { keyword, kindHint }；keyword 必须从原文原样复制，避免空格/标点差异；',
        '- 查不到（reason=notFound）时：①缩短关键词为最短语义单元再查；②仍不行 → annot_addByRect 手动指定坐标；③仍不行 → 明确跳过这一项，不要瞎猜位置。',
        '',
        '### Step 4. 批量画 —— annot_addBatchByRect(annotations)',
        '- annotations 每项显式 author=ai；每页 ≤ 15 条；',
        '- kind=card 尽量不要叠正文，优先文段左右或上下空白区；title ≤ 10 字；note 写具体的「为什么重要 + 怎么记 + 易混提醒」，绝对禁止出现「这是重点/这很重要/考试会考」等套话。',
        '- 颜色严格按 Color Scheme 写 hex，不要留 undefined 走默认。',
        '',
        '### Step 5. 回读校验 —— annot_query(page, author=ai)',
        '- 每批 5-8 页结束后，逐页 annot_query 回查数量、类型、颜色是否匹配 Step 2；',
        '- 同一段落 3 种以上颜色叠涂 → annot_modifyElement 合并/删次要；',
        '- quote 为空 → annot_modifyElement 补 text/quote。',
        '',
        '### Step 6. 美化调整 —— annot_modifyElement 局部调色/加 note',
        '- 相邻同色下划线若属于同一连续行 → annot_modifyElement 合并宽度；',
        '- card note > 50 字 → 拆成短段落；某页 card > 3 张 → 相近主题合并为 1 张 title 要点汇总。',
        '',
        '## Color Scheme (三级配色 · 柔和半透明不挡字)',
        '- 一级（红）   highlight:#fee2e2 · rect:#dc2626(边)   用于标题/核心结论/章节主旨。',
        '- 二级（蓝）   underline:#2563eb · highlight:#dbeafe 用于术语/定义/关键步骤。',
        '- 三级（绿/橙）highlight:#dcfce7 / highlight:#ffedd5 用于考点/难点/口诀/易错。',
        '- 卡片底色默认 #fff4bf，正文 #111。',
        '',
        '## Aesthetics Guardrails (美观护栏 · 一票否决，违反必须改)',
        '1. 每页 ≤ 15 处；',
        '2. 同一视觉行/同一段落，颜色类型 ≤ 2；',
        '3. 并列 n 项必须颜色+kind 统一；',
        '4. 卡片绝对不压文字，左右/页眉页脚空白首选；',
        '5. 单个 highlight 不做双层叠色；',
        '6. rect 只描边不填充、不加粗；',
        '7. pen 仅用户明确要求时使用，默认流程一律不用。',
        '',
        '## Multi-page Tactics',
        '- 一批 ≤ 5-8 页；≥ 9 页分批（如 5/6/6），每批结束给用户汇报「✅ 已完成 X-Y 页：一级 7 处，二级 18 处，三级 13 处，卡片 3 张」；',
        '- 纯图/参考文献页 → 只给章节标题 1 个一级高亮，不要强行找词。',
        '',
        '## Verification Checklist (每批必做)',
        '- [ ] 所有标注 author=ai，annot_query(author=ai) 全部命中；',
        '- [ ] 每页 ≤ 15 处；每批 ≤ 8 页；',
        '- [ ] 没有 quote 匹配不到靠猜坐标糊上去的标注；',
        '- [ ] 并列项同色同 kind；卡片不压正文；',
        '- [ ] 卡片 note 不含「这是重点/考试会考」等套话；',
        '- [ ] 颜色严格按三级配色（红一级/蓝二级/绿橙三级）。'
      ].join('\n')
    }
  ];

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    if (_initDone) return;
    _initDone = true;
    _loadUserSkills();
    _loadEnabledSkills();
    _rebuildIndex();
  }

  function _loadUserSkills() {
    try {
      var raw = localStorage.getItem(_STORAGE_KEY);
      if (raw) {
        _userSkills = JSON.parse(raw) || {};
      }
    } catch (e) {
      _userSkills = {};
    }
  }

  function _saveUserSkills() {
    try {
      localStorage.setItem(_STORAGE_KEY, JSON.stringify(_userSkills));
    } catch (e) {}
  }

  // ===== 启用状态持久化（默认：新技能默认启用，用户可关闭）=====
  function _defaultEnabledFor(name) {
    // 所有 skill 默认启用；个别极少用到的可以按名字排除（目前全开）
    return true;
  }

  function _loadEnabledSkills() {
    try {
      var raw = localStorage.getItem(_ENABLED_KEY);
      if (raw) {
        _enabledSkills = JSON.parse(raw) || {};
      } else {
        _enabledSkills = {};
      }
    } catch (e) {
      _enabledSkills = {};
    }
  }

  function saveEnabledSkills(dict) {
    // 允许外部传入完整 {name:true/false} 字典（用于设置面板一键保存）
    if (dict && typeof dict === 'object') {
      _enabledSkills = {};
      for (var k in dict) if (Object.prototype.hasOwnProperty.call(dict, k)) _enabledSkills[k] = !!dict[k];
    }
    try {
      localStorage.setItem(_ENABLED_KEY, JSON.stringify(_enabledSkills));
    } catch (e) {}
    return true;
  }

  function getEnabledSkills() {
    init();
    var out = {};
    for (var i = 0; i < _skills.length; i++) {
      var n = _skills[i].name;
      out[n] = isEnabled(n);
    }
    return out;
  }

  function isEnabled(name) {
    if (!name) return false;
    if (!_initDone) init();
    // 用户自定义 skill 的 user version 覆盖 bundled version，但启用状态共用 name
    if (typeof _enabledSkills[name] === 'boolean') return _enabledSkills[name];
    return _defaultEnabledFor(name);
  }

  function toggleEnabled(name, enabled) {
    if (!name) return false;
    if (!_initDone) init();
    var val = (enabled === undefined) ? !isEnabled(name) : !!enabled;
    _enabledSkills[name] = val;
    saveEnabledSkills();
    return val;
  }

  function _rebuildIndex() {
    _skills = [];
    _skillBodies = {};

    // 内置 skill（rank=600，优先级最低，被用户自定义覆盖）
    BUILTIN_SKILLS.forEach(function (s) {
      _skills.push({
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse || '',
        source: 'bundled',
        rank: 600,
        invocation: { model: true, user: true }
      });
      _skillBodies[s.name] = s.body;
    });

    // 用户自定义 skill（rank=400，覆盖内置）
    Object.keys(_userSkills).forEach(function (name) {
      var s = _userSkills[name];
      // 检查是否已有同名内置 skill，用用户版本覆盖
      var existing = _skills.findIndex(function (x) { return x.name === name; });
      if (existing >= 0) {
        _skills[existing] = {
          name: name,
          description: s.description || '',
          whenToUse: s.whenToUse || '',
          source: 'user',
          rank: 400,
          invocation: { model: s.modelInvocable !== false, user: s.userInvocable !== false }
        };
      } else {
        _skills.push({
          name: name,
          description: s.description || '',
          whenToUse: s.whenToUse || '',
          source: 'user',
          rank: 400,
          invocation: { model: s.modelInvocable !== false, user: s.userInvocable !== false }
        });
      }
      _skillBodies[name] = s.body || '';
    });

    // 按 rank 排序（rank 小的优先）
    _skills.sort(function (a, b) { return a.rank - b.rank; });
  }

  // ============================================================
  // 公开 API
  // ============================================================

  /** 返回所有已启用 skill 的摘要列表（model-invocable only） */
  function list() {
    init();
    return _skills.filter(function (s) {
      return s.invocation.model && isEnabled(s.name);
    }).map(function (s) {
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        source: s.source
      };
    });
  }

  /** 返回所有 skill 的摘要列表（包含未启用项，调用方自行用 isEnabled 判断） */
  function listAll() {
    init();
    return _skills.map(function (s) {
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        source: s.source,
        modelInvocable: s.invocation.model,
        userInvocable: s.invocation.user,
        enabled: isEnabled(s.name)
      };
    });
  }

  /** 返回已启用 skill 的列表（list 的别名，语义更清晰） */
  function listEnabled() {
    return list();
  }

  /** 获取完整 skill 正文（每次调用，不缓存太久） */
  function get(name) {
    init();
    return _skillBodies[name] || null;
  }

  /** 获取 skill 的完整定义（含 summary + body） */
  function getDefinition(name) {
    init();
    var body = _skillBodies[name];
    if (!body) return null;
    var summary = _skills.find(function (s) { return s.name === name; });
    if (!summary) return null;
    return {
      name: summary.name,
      description: summary.description,
      whenToUse: summary.whenToUse,
      source: summary.source,
      content: body
    };
  }

  /** 生成 AI 上下文中的 catalog 文本（只含 name + description）
   *  格式参考 harness spec：name 不加反引号（纯 token 易匹配），
   *  description 首句即"做什么+何时触发"，截断 ≤ 500 字。
   */
  function getCatalogPrompt() {
    init();
    var modelSkills = list();
    if (!modelSkills.length) return '';
    var lines = modelSkills.map(function (s) {
      var desc = s.description || '';
      var when = s.whenToUse ? ' Triggers: ' + s.whenToUse.replace(/\s+/g, ' ') : '';
      var full = desc + when;
      if (full.length > 500) full = full.substring(0, 497) + '...';
      return '- ' + s.name + ': ' + full;
    });
    return [
      '<system-reminder>',
      'Skill 目录（catalog）：每条 = skill name + 触发说明。任务匹配时按名字精确加载，未读完整正文前不执行该 skill。',
      'Available skills（sessions skills catalog）:',
      lines.join('\n'),
      '',
      'Load rule：If user explicitly names a skill (e.g. "用 html-design") OR user instruction overlaps the "Triggers" keyword list OR the task clearly belongs to a description domain → call SkillSystem.get(name) to fetch the full skill content, then strictly follow its Workflow / Decision Rules / Guardrails / Output Requirements / Verification Checklist.',
      'This catalog is summary-only. Never follow a skill from catalog alone; only full loaded skill_content is authoritative.',
      '</system-reminder>'
    ].join('\n');
  }

  /** 为每个内置 skill 预扩展 whenToUse 同义词池（R3：提升匹配召回） */
  var _TRIGGER_SYNONYMS = {
    'literature-critical-reading': [
      '精读','总结','概括','提炼','摘要','文献笔记','论文笔记','要点','核心内容','读懂','关键信息',
      'summarize','summary','extract key','paper summary','精读一下','总结一下','摘重点','主要结论'
    ],
    'medical-evidence-extraction': [
      '提取数据','提取表格','提取效应量','提取结局','hr','or','rr','md','风险比','优势比','相对危险度','置信区间','ci',
      '95%','p 值','p值','统计','统计分析','森林图','forest plot','meta','荟萃','证据等级','grade','数据提取'
    ],
    'scholarly-translation': [
      '翻译','译','translate','英译中','中译英','英文翻译','中文翻译','translate to english','翻译一下',
      '双语','英文摘要','abstract','机翻'
    ],
    'html-design': [
      'html','网页','交互组件','动画','可视化','画一个','设计一个','做一个','生存曲线','kaplan','时间线',
      '数据表格','卡片','仪表盘','svg','widget','网页元素','互动','html代码','页面'
    ],
    'canvas-diagram': [
      '流程图','制图','画图','示意图','循环图','通路图','关系图','信号通路','三羧酸','tca','代谢','实验流程',
      '机制图','概念图','diagram','flowchart','绘制','画个图','流程图解','流程图设计',
      '思维导图','mindmap','思维图','脑图','导图'
    ],
    'note-structuring': [
      '整理笔记','重构','组织','结构化','分章节','加标题','重新排版','做目录','分层','格式整理',
      '排版','重组','结构调整','整理一下','笔记整理','目录','重新组织'
    ],
    'research-questioning': [
      '批判','批判性','质疑','提出问题','研究假设','设计实验','后续研究','局限性','不足','为什么','缺陷',
      '研究缺口','gap','开放问题','假设','h0','h1','可证伪'
    ],
    'medical-explain': [
      '解释','给我讲一下','通俗','为什么会','什么是','类比','患者','给学生讲','科普','举例说明','易懂',
      '患者教育','通俗解释','讲解一下','讲讲','说明一下','通俗版','大白话'
    ],
    // ===== 系统专属内置 Skills 的同义词池 =====
    'textbook-navigate': [
      '跳到','翻到','跳转','跳章','跳页','定位','查找','找章节','第几章','第几节','第X章','第X节',
      '章节','导航','目录','打开第','去到','转至','切到','切到第','我要看','翻到第','直接跳'
    ],
    'exam-points': [
      '考点','重点','考研','执业医','期末考','期中考','考试','考什么','必背','背',
      '划考点','考点提炼','高频考点','考试重点','记忆点','出题','出题点','重点知识','必考','知识点梳理'
    ],
    'differential-diagnosis': [
      '鉴别','鉴别诊断','区分','如何区分','区别','鉴别点','ddx','DDx','怎么判断','怎么区分',
      '排除诊断','怎样辨别','不一样','差异','如何辨别','判断是哪种'
    ],
    'diagnostic-pathway': [
      '诊断路径','诊断流程','临床路径','处理流程','处理步骤','第一步','先做什么','一步步来',
      '诊疗流程','算法','诊断步骤','救治流程','急救流程','临床决策','临床思路'
    ],
    'batch-highlight': [
      '划重点','标重点','批量标','自动划','关键句','标注这段话','高亮','把XX标出来','标记',
      '做批注','重点标注','自动标注','全文标注','批量标注','自动高亮','画重点','把这段话标一下'
    ],
    'annotation-flashcards': [
      '复习卡','闪卡','导出标注','整理标注','生成问答卡','anki','背诵','默写','抽认卡',
      '考自己','自我检测','问答卡','q&a卡','记忆卡','自测卡','反刍卡','背诵卡'
    ],
    'textbook-note-framework': [
      '做笔记','写笔记','整理本章','笔记模板','笔记框架','本章笔记','学习笔记','课后笔记',
      '生成笔记','结构化笔记','章节笔记','笔记大纲','学习框架','整章笔记','课堂笔记','章节总结'
    ]
  };

  /** 匹配 skill：根据用户指令文本，返回可能匹配的 skill name 数组
   *  匹配优先级：1 全名直接命中 → 2 whenToUse + 同义词池 → 3 description 关键词共现
   *  采用打分模式（≥1.5 分即入选），避免误匹配同义词。
   *  — 只在"已启用 + 模型可调用"的 skill 中匹配 —
   */
  function matchSkills(userText) {
    init();
    if (!userText) return [];
    var text = String(userText);
    var tLower = text.toLowerCase();
    var tNorm = text.replace(/\s+/g, '').toLowerCase();
    var scored = [];
    _skills.forEach(function (s) {
      if (!s.invocation.model) return;
      if (!isEnabled(s.name)) return;       // 被用户禁用的 skill 不参与匹配
      var score = 0;
      // 1. 全名命中（用户直接写 "用 html-design" / "调用 medical-explain"）
      if (tLower.indexOf(s.name.toLowerCase()) >= 0) score += 10;
      // 2. whenToUse 分词命中（含同义词扩展池）
      var kwSet = {};
      if (s.whenToUse) {
        var kws = s.whenToUse.split(/[，,；;、""''()（）\s\/\|]+/);
        for (var k = 0; k < kws.length; k++) {
          var w = kws[k].trim().toLowerCase();
          if (w.length >= 2) kwSet[w] = true;
        }
      }
      var syn = _TRIGGER_SYNONYMS[s.name] || [];
      for (var s2 = 0; s2 < syn.length; s2++) {
        kwSet[String(syn[s2]).toLowerCase()] = true;
      }
      var keys = Object.keys(kwSet);
      var hitCount = 0;
      for (var k2 = 0; k2 < keys.length; k2++) {
        var kw = keys[k2];
        if (kw.length >= 2 && (tLower.indexOf(kw) >= 0 || tNorm.indexOf(kw) >= 0)) {
          hitCount++;
        }
      }
      score += hitCount * 1.5;
      // 3. description 尾端的 "Use when user asks..." / "Triggers:" 显式指令匹配
      if (s.description) {
        var dLower = s.description.toLowerCase();
        var explicitHits = ['use when','triggers','when user','asks for','asks to'];
        for (var e = 0; e < explicitHits.length; e++) {
          if (dLower.indexOf(explicitHits[e]) >= 0) { score += 0.5; break; }
        }
      }
      if (score >= 1.5) scored.push({ name: s.name, score: score });
    });
    if (!scored.length) return [];
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.map(function (x) { return x.name; })
      .filter(function (v, i, arr) { return arr.indexOf(v) === i; });
  }

  /** 加载一个或多个 skill 的完整正文，返回拼接后的指令文本（已禁用的 skill 返回空，避免泄漏） */
  function loadSkills(names) {
    init();
    if (!names || !names.length) return '';
    var parts = [];
    names.forEach(function (name) {
      if (!isEnabled(name)) return;
      var body = _skillBodies[name];
      if (body) {
        parts.push('<skill_content name="' + name + '">');
        parts.push(body);
        parts.push('</skill_content>');
      }
    });
    return parts.join('\n\n');
  }

  /** 用户自定义 skill：注册/更新 */
  function registerUserSkill(name, description, body, options) {
    init();
    if (!name || !body) return false;
    _userSkills[name] = {
      description: description || '',
      body: body,
      whenToUse: (options && options.whenToUse) || '',
      modelInvocable: (options && options.modelInvocable !== false),
      userInvocable: (options && options.userInvocable !== false)
    };
    _saveUserSkills();
    _rebuildIndex();
    return true;
  }

  /** 用户自定义 skill：删除 */
  function removeUserSkill(name) {
    init();
    if (_userSkills[name]) {
      delete _userSkills[name];
      _saveUserSkills();
      _rebuildIndex();
      return true;
    }
    return false;
  }

  /** 获取用户自定义 skill 列表（含 body） */
  function listUserSkills() {
    init();
    var result = [];
    Object.keys(_userSkills).forEach(function (name) {
      var s = _userSkills[name];
      result.push({
        name: name,
        description: s.description,
        body: s.body,
        whenToUse: s.whenToUse
      });
    });
    return result;
  }

  /** 从 YAML frontmatter + Markdown 文件内容解析 skill
   *  frontmatter 支持：
   *    - 单行：key: value
   *    - YAML block scalar: description: | （保留换行）/ description: >（折叠换行）
   *    - 附带指示符：|-, |+, >-, >+（chomping）
   */
  function parseSkillFile(text) {
    if (!text || typeof text !== 'string') return null;
    var match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return null;
    var frontmatter = match[1];
    var body = match[2] || '';
    var skill = { body: body };
    var lines = frontmatter.split(/\r?\n/);
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      // 空行/注释
      if (!line || /^\s*#/.test(line)) { i++; continue; }
      // 行首必须是 key:（顶格）
      var km = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
      if (!km) { i++; continue; }
      var key = km[1];
      var inline = km[2];
      var scalarType = null; // '|' | '>' | null
      var strip = null;     // '-': strip, '+': keep, null: clip
      var scalarMatch = inline.match(/^([|>])([-+])?\s*$/);
      if (scalarMatch) {
        scalarType = scalarMatch[1];
        strip = scalarMatch[2] || null;
        // 找连续的缩进行作为 block scalar 内容
        var blockLines = [];
        var j = i + 1;
        var blockIndent = -1;
        while (j < lines.length) {
          var bl = lines[j];
          if (!bl) { blockLines.push(''); j++; continue; }
          var indentMatch = bl.match(/^(\s+)/);
          var ind = indentMatch ? indentMatch[1].length : 0;
          // 第一行非空内容决定最小缩进
          if (blockIndent === -1 && bl.trim() !== '') blockIndent = ind;
          if (blockIndent === -1) { blockLines.push(''); j++; continue; }
          if (ind < blockIndent) break; // 回退到上一层：块结束
          blockLines.push(bl.substring(blockIndent));
          j++;
        }
        var content;
        if (scalarType === '|') {
          content = blockLines.join('\n');
        } else {
          // > : 行尾为空格则保留换行，否则把相邻非空行用空格折叠，连续空行变一个换行
          var folded = [];
          for (var b = 0; b < blockLines.length; b++) {
            var bline = blockLines[b];
            if (bline === '') { folded.push('\n'); continue; }
            var prev = folded[folded.length - 1];
            if (prev && prev !== '\n' && !/[ \t]$/.test(prev)) {
              folded[folded.length - 1] = prev + ' ' + bline;
            } else {
              folded.push(bline);
            }
          }
          content = folded.join('');
        }
        // Chomping: clip (default), strip (-), keep (+)
        if (strip === '-') content = content.replace(/\n+$/, '');
        else if (strip === '+') { /* keep */ }
        else { content = content.replace(/\n+$/, '').replace(/\n+$/m, '\n'); }
        skill[key] = content;
        i = j;
      } else {
        // 单行：去外层引号
        var val = inline.trim().replace(/^["']|["']$/g, '');
        skill[key] = val;
        i++;
      }
    }
    if (!skill.name || !skill.description) return null;
    return skill;
  }

  /** 将 skill 序列化为 YAML frontmatter + Markdown 文件格式
   *  description / whenToUse 含换行时自动转为 block scalar（|）
   */
  function serializeSkillFile(skill) {
    var lines = ['---'];
    lines.push('name: ' + (skill.name || ''));
    function _appendField(key, val) {
      if (!val) return;
      var str = String(val);
      if (str.indexOf('\n') >= 0) {
        lines.push(key + ': |');
        var bl = str.split('\n');
        for (var b = 0; b < bl.length; b++) lines.push('  ' + bl[b]);
      } else {
        // 单行但包含特殊 YAML 字符时加引号
        var needsQuote = /[:#\[\]\{\}&*!>|\-'"\\%@`]/.test(str) || /^[0-9\s-]/.test(str);
        if (needsQuote) {
          lines.push(key + ': ' + JSON.stringify(str));
        } else {
          lines.push(key + ': ' + str);
        }
      }
    }
    _appendField('description', skill.description);
    _appendField('whenToUse', skill.whenToUse);
    lines.push('---');
    lines.push('');
    lines.push(skill.body || '');
    return lines.join('\n');
  }

  return {
    init: init,
    list: list,
    listAll: listAll,
    listEnabled: listEnabled,
    get: get,
    getDefinition: getDefinition,
    getCatalogPrompt: getCatalogPrompt,
    matchSkills: matchSkills,
    loadSkills: loadSkills,
    registerUserSkill: registerUserSkill,
    removeUserSkill: removeUserSkill,
    listUserSkills: listUserSkills,
    parseSkillFile: parseSkillFile,
    serializeSkillFile: serializeSkillFile,
    // ===== 启用状态 API =====
    isEnabled: isEnabled,
    toggleEnabled: toggleEnabled,
    getEnabledSkills: getEnabledSkills,
    saveEnabledSkills: saveEnabledSkills,
    BUILTIN_SKILLS: BUILTIN_SKILLS
  };
})();
