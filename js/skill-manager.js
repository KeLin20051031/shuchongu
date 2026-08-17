// Skill Manager 模块 — 学习用户操作偏好，注入 AI 上下文
// 依赖: DataLayer (IndexedDB 持久化)
const SkillManager = (function() {
  'use strict';

  let profile = null;  // 当前 Skill 档案

  // ---------- 默认档案 ----------
  function _defaultProfile() {
    return {
      id: 'skillProfile',
      tags: [],             // [{ name, weight, category, auto }]
      operationHistory: [], // [{ type, metadata, timestamp }]
      totalOperations: 0,
      updatedAt: Date.now()
    };
  }

  // ---------- 初始化（从 DataLayer 加载或创建） ----------
  async function init() {
    await DataLayer.init();
    var stored = await DataLayer.get('settings', 'skillProfile');
    profile = stored || _defaultProfile();
    if (!stored) {
      await DataLayer.put('settings', profile);
    }
  }

  // ---------- 获取档案 ----------
  function getProfile() {
    return profile || _defaultProfile();
  }

  // ---------- 记录操作 ----------
  async function recordOperation(type, metadata) {
    if (!profile) await init();
    profile.operationHistory.push({
      type: type,
      metadata: metadata || {},
      timestamp: Date.now()
    });
    profile.totalOperations++;
    profile.updatedAt = Date.now();
    // 保留最近 200 条
    if (profile.operationHistory.length > 200) {
      profile.operationHistory = profile.operationHistory.slice(-200);
    }
    // 自动分析
    _analyze();
    await DataLayer.put('settings', profile);
  }

  // ---------- 自动分析：从历史提取高频标签 ----------
  function _analyze() {
    var typeCounts = {};
    var topicCounts = {};

    for (var i = 0; i < profile.operationHistory.length; i++) {
      var op = profile.operationHistory[i];
      typeCounts[op.type] = (typeCounts[op.type] || 0) + 1;
      // 从 focus 查询中提取主题词
      if (op.metadata && op.metadata.query) {
        var words = op.metadata.query.split(/[\s,，。、]+/);
        for (var j = 0; j < words.length; j++) {
          if (words[j].length > 1) {
            topicCounts[words[j]] = (topicCounts[words[j]] || 0) + 1;
          }
        }
      }
    }

    // 保留手动标签，清除旧的自动标签
    profile.tags = profile.tags.filter(function(t) { return !t.auto; });

    // 指令类型标签（出现 >= 2 次）
    for (var type in typeCounts) {
      if (typeCounts[type] >= 2) {
        profile.tags.push({
          name: type,
          weight: typeCounts[type],
          category: 'command',
          auto: true
        });
      }
    }

    // 主题标签（取频次前 5，出现 >= 2 次）
    var topics = Object.keys(topicCounts).sort(function(a, b) {
      return topicCounts[b] - topicCounts[a];
    }).slice(0, 5);
    for (var k = 0; k < topics.length; k++) {
      if (topicCounts[topics[k]] >= 2) {
        profile.tags.push({
          name: topics[k],
          weight: topicCounts[topics[k]],
          category: 'topic',
          auto: true
        });
      }
    }
  }

  // ---------- 生成上下文字符串（供 AIEngine._buildContext 调用） ----------
  function getContextString() {
    if (!profile || profile.tags.length === 0) return '';
    var parts = ['用户学习偏好（基于历史操作自动分析）：'];
    for (var i = 0; i < profile.tags.length; i++) {
      var tag = profile.tags[i];
      parts.push('- ' + tag.name + ' (权重:' + tag.weight + ', ' + tag.category + ')');
    }
    return parts.join('\n');
  }

  // ---------- 手动添加标签 ----------
  async function addTag(name, category) {
    if (!profile) await init();
    for (var i = 0; i < profile.tags.length; i++) {
      if (profile.tags[i].name === name) return false;
    }
    profile.tags.push({
      name: name,
      weight: 1,
      category: category || 'custom',
      auto: false
    });
    profile.updatedAt = Date.now();
    await DataLayer.put('settings', profile);
    return true;
  }

  // ---------- 调整标签权重 ----------
  async function updateTagWeight(name, weight) {
    if (!profile) await init();
    for (var i = 0; i < profile.tags.length; i++) {
      if (profile.tags[i].name === name) {
        profile.tags[i].weight = weight;
        profile.updatedAt = Date.now();
        await DataLayer.put('settings', profile);
        return true;
      }
    }
    return false;
  }

  // ---------- 删除标签 ----------
  async function deleteTag(name) {
    if (!profile) await init();
    var before = profile.tags.length;
    profile.tags = profile.tags.filter(function(t) { return t.name !== name; });
    if (profile.tags.length !== before) {
      profile.updatedAt = Date.now();
      await DataLayer.put('settings', profile);
      return true;
    }
    return false;
  }

  // ---------- 重置档案 ----------
  async function resetProfile() {
    profile = _defaultProfile();
    await DataLayer.put('settings', profile);
  }

  // ============================================================
  // 公开接口
  // ============================================================
  return {
    init: init,
    getProfile: getProfile,
    recordOperation: recordOperation,
    getContextString: getContextString,
    addTag: addTag,
    updateTagWeight: updateTagWeight,
    deleteTag: deleteTag,
    resetProfile: resetProfile
  };
})();
