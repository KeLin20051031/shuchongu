// AI Adapter 模块 — 多厂商适配 + 流式
const AIAdapter = (function() {
  // 厂商配置模板（配置驱动，新增厂商只需加配置）
  const AI_PROVIDERS = {
    openai: {
      name: 'OpenAI',
      endpoint: '/chat/completions',
      authType: 'bearer',
      requestFormat: 'messages',
      streamFormat: 'sse',
      responseContentPath: 'choices[0].delta.content',
      defaultModel: 'gpt-4o-mini',
      defaultBaseUrl: 'https://api.openai.com/v1'
    },
    deepseek: {
      name: 'DeepSeek',
      endpoint: '/chat/completions',
      authType: 'bearer',
      requestFormat: 'messages',
      streamFormat: 'sse',
      responseContentPath: 'choices[0].delta.content',
      defaultModel: 'deepseek-chat',
      defaultBaseUrl: 'https://api.deepseek.com/v1'
    },
    doubao: {
      name: '豆包',
      endpoint: '/chat/completions',
      authType: 'bearer',
      requestFormat: 'messages',
      streamFormat: 'sse',
      responseContentPath: 'choices[0].delta.content',
      defaultModel: 'doubao-pro-32k',
      defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      supportsDSML: true
    },
    siliconflow: {
      name: '硅基流动',
      endpoint: '/chat/completions',
      authType: 'bearer',
      requestFormat: 'messages',
      streamFormat: 'sse',
      responseContentPath: 'choices[0].delta.content',
      defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
      defaultBaseUrl: 'https://api.siliconflow.cn/v1'
    }
  };

  function getProviderConfig(provider) {
    return AI_PROVIDERS[provider] || AI_PROVIDERS.openai;
  }

  function buildRequestBody(provider, messages, options = {}) {
    const config = getProviderConfig(provider);
    // 规范化 messages.role：API 只接受 system/user/assistant/tool，非法角色统一归类
    // 避免 400: unknown variant 'bot' / 'latest_reminder' 之类错误
    const LEGAL = { system: 1, user: 1, assistant: 1, tool: 1 };
    function normRole(r) {
      if (LEGAL[r]) return r;
      if (r === 'bot' || r === 'ai' || r === 'model' || r === 'latest_reminder' || r === 'reminder') return 'assistant';
      if (r === 'tool_result' || r === 'tool_call' || r === 'function') return 'tool';
      return 'assistant';
    }
    function normMessage(m) {
      if (!m) return m;
      var n = { role: normRole(m.role) };
      if (typeof m.content !== 'undefined') n.content = m.content;
      // 多模态内容数组需保留
      if (Array.isArray(m.content)) n.content = m.content;
      if (m.tool_calls) n.tool_calls = m.tool_calls;
      if (m.tool_call_id) n.tool_call_id = m.tool_call_id;
      if (m.name !== undefined) n.name = m.name;
      return n;
    }
    var normed = (messages || []).map(normMessage);
    const body = {
      messages: normed,
      stream: options.stream !== undefined ? options.stream : false
    };
    if (options.model) body.model = options.model;
    else if (config.defaultModel) body.model = config.defaultModel;
    if (options.temperature) body.temperature = options.temperature;
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
    return body;
  }

  function buildHeaders(provider, apiKey) {
    const config = getProviderConfig(provider);
    const headers = { 'Content-Type': 'application/json' };
    if (config.authType === 'bearer') {
      headers['Authorization'] = 'Bearer ' + apiKey;
    }
    return headers;
  }

  function buildUrl(provider, baseUrl) {
    const config = getProviderConfig(provider);
    return baseUrl.replace(/\/$/, '') + config.endpoint;
  }

  // 解析单行流式数据，返回 { content, done, toolCalls?, reasoningContent? }
  function parseStreamChunk(provider, line) {
    const config = getProviderConfig(provider);
    line = line.trim();
    if (!line.startsWith('data:')) return { content: '', done: false };
    const data = line.slice(5).trim();
    if (data === '[DONE]') return { content: '', done: true };
    try {
      const json = JSON.parse(data);
      // OpenAI/DeepSeek/豆包兼容格式
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) return { content: '', done: false };
      return {
        content: delta.content || '',
        reasoningContent: delta.reasoning_content || '',
        done: false,
        toolCalls: delta.tool_calls || null
      };
    } catch (e) {
      return { content: '', done: false };
    }
  }

  // 创建带超时的 fetch 请求
  function _fetchWithTimeout(url, options, timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    options = options || {};
    options.signal = controller.signal;
    return fetch(url, options).finally(function() { clearTimeout(timer); });
  }

  // 流式调用 AI，async generator 逐块 yield
  async function* streamChat(provider, baseUrl, apiKey, messages, options = {}) {
    const url = buildUrl(provider, baseUrl);
    const headers = buildHeaders(provider, apiKey);
    const body = JSON.stringify(buildRequestBody(provider, messages, { ...options, stream: true }));

    let response;
    try {
      response = await _fetchWithTimeout(url, { method: 'POST', headers, body });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时（30秒），请检查网络或更换 API 地址');
      throw new Error('网络连接失败: ' + (e.message || '无法连接到 AI 服务器，可能是 CORS 限制或网络问题'));
    }
    if (!response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch(_) {}
      throw new Error('AI API 错误 (' + response.status + '): ' + _extractErrorMsg(errText, response.status));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 读超时保护：AI 连接后若长时间无数据（断流/挂起），中止等待避免界面永久卡住
    const READ_TIMEOUT = 60000;
    let readTimer = null;

    while (true) {
      let readResult;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise(function(_, reject) {
            readTimer = setTimeout(function() { reject(new Error('AI 响应超时（60秒无数据），请重试')); }, READ_TIMEOUT);
          })
        ]);
      } finally {
        if (readTimer) { clearTimeout(readTimer); readTimer = null; }
      }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留最后不完整的行
      for (const line of lines) {
        const chunk = parseStreamChunk(provider, line);
        if (chunk.content || chunk.done || chunk.toolCalls || chunk.reasoningContent) yield chunk;
      }
    }
    // 处理 buffer 剩余
    if (buffer.trim()) {
      const chunk = parseStreamChunk(provider, buffer);
      if (chunk.content || chunk.done || chunk.reasoningContent) yield chunk;
    }
  }

  // 非流式调用
  async function chat(provider, baseUrl, apiKey, messages, options = {}) {
    const url = buildUrl(provider, baseUrl);
    const headers = buildHeaders(provider, apiKey);
    const body = JSON.stringify(buildRequestBody(provider, messages, { ...options, stream: false }));
    let response;
    try {
      response = await _fetchWithTimeout(url, { method: 'POST', headers, body });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时（30秒）');
      throw new Error('网络连接失败: ' + (e.message || '无法连接到 AI 服务器'));
    }
    if (!response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch(_) {}
      throw new Error('AI API 错误 (' + response.status + '): ' + _extractErrorMsg(errText, response.status));
    }
    const json = await response.json();
    return json.choices[0].message.content;
  }

  // 支持 Tool Calling 的完整聊天接口，返回完整 message 对象
  // 结果格式: { role: string, content: string|null, tool_calls?: Array }
  async function chatWithTools(provider, baseUrl, apiKey, messages, options = {}) {
    const url = buildUrl(provider, baseUrl);
    const headers = buildHeaders(provider, apiKey);
    const body = JSON.stringify(buildRequestBody(provider, messages, { ...options, stream: false }));
    let response;
    try {
      response = await _fetchWithTimeout(url, { method: 'POST', headers, body });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时（30秒）');
      throw new Error('网络连接失败: ' + (e.message || '无法连接到 AI 服务器'));
    }
    if (!response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch(_) {}
      throw new Error('AI API 错误 (' + response.status + '): ' + _extractErrorMsg(errText, response.status));
    }
    const json = await response.json();
    const msg = json.choices[0] && json.choices[0].message;
    if (!msg) throw new Error('AI 响应缺少 message');
    return {
      role: msg.role || 'assistant',
      content: msg.content || null,
      tool_calls: msg.tool_calls || null
    };
  }

  // 从错误响应中提取可读信息
  function _extractErrorMsg(errText, status) {
    if (!errText) {
      if (status === 401) return 'API Key 无效或已过期';
      if (status === 403) return '访问被拒绝，请检查 API Key 权限';
      if (status === 404) return 'API 地址不正确或模型不存在';
      if (status === 429) return '请求过于频繁，请稍后再试';
      if (status >= 500) return 'AI 服务器内部错误，请稍后重试';
      return 'HTTP ' + status;
    }
    try {
      var json = JSON.parse(errText);
      if (json.error && json.error.message) return json.error.message;
      if (json.message) return json.message;
    } catch(_) {}
    return errText.substring(0, 200);
  }

  // 连接测试（返回详细错误信息）
  async function testConnection(provider, baseUrl, apiKey) {
    var result = { success: false, error: '' };
    try {
      // 基本参数检查
      if (!apiKey || apiKey.trim().length < 5) {
        result.error = 'API Key 未填写或过短';
        return result;
      }
      if (!baseUrl || !baseUrl.startsWith('http')) {
        result.error = 'Base URL 格式不正确，应以 http:// 或 https:// 开头';
        return result;
      }

      const url = buildUrl(provider, baseUrl);
      const headers = buildHeaders(provider, apiKey);
      const config = getProviderConfig(provider);
      const body = JSON.stringify(buildRequestBody(provider, [{ role: 'user', content: 'hi' }], {
        stream: false,
        model: undefined  // 使用默认模型
      }));

      var response = await _fetchWithTimeout(url, { method: 'POST', headers, body }, 15000);

      if (response.ok) {
        result.success = true;
        return result;
      }

      // 读取错误响应
      var errText = '';
      try { errText = await response.text(); } catch(_) {}
      result.error = _extractErrorMsg(errText, response.status);
      return result;
    } catch (e) {
      if (e.name === 'AbortError') {
        result.error = '连接超时（15秒），请检查网络或 Base URL 是否正确';
      } else if (e.message && e.message.includes('Failed to fetch')) {
        result.error = '无法连接到服务器。可能原因：1) Base URL 错误  2) 网络问题  3) 浏览器 CORS 限制';
      } else {
        result.error = e.message || '未知连接错误';
      }
      return result;
    }
  }

  return {
    getProviderConfig, buildRequestBody, buildHeaders, buildUrl,
    parseStreamChunk, streamChat, chat, chatWithTools, testConnection, AI_PROVIDERS
  };
})();
