// Diff 模块 — 行级文本差异比较（LCS 算法）
// 用于 AI 编辑笔记时的逐行红绿对比预览
const DiffEngine = (function() {
  'use strict';

  // 单次比较的最大行数（防止大文本 O(n*m) 内存/时间爆炸）
  const MAX_LINES = 300;

  /**
   * 逐行比较两个文本，返回带类型的行序列
   * @param {string} oldText - 旧文本
   * @param {string} newText - 新文本
   * @returns {Array<{type:'same'|'del'|'add', text:string}>}
   */
  function diffLines(oldText, newText) {
    var oldLines = splitLines(oldText);
    var newLines = splitLines(newText);

    var n = Math.min(oldLines.length, MAX_LINES);
    var m = Math.min(newLines.length, MAX_LINES);
    var ol = oldLines.slice(0, n);
    var nl = newLines.slice(0, m);

    var result = [];

    // 空文本快速路径
    if (n === 0 && m === 0) return result;
    if (n === 0) {
      for (var a = 0; a < m; a++) result.push({ type: 'add', text: nl[a] });
      return result;
    }
    if (m === 0) {
      for (var d = 0; d < n; d++) result.push({ type: 'del', text: ol[d] });
      return result;
    }

    // LCS 动态规划表（稀疏行：若行数过大仍可控）
    var dp = [];
    for (var i = 0; i <= n; i++) {
      dp.push(new Array(m + 1).fill(0));
    }
    for (var i2 = n - 1; i2 >= 0; i2--) {
      for (var j2 = m - 1; j2 >= 0; j2--) {
        if (ol[i2] === nl[j2]) dp[i2][j2] = dp[i2 + 1][j2 + 1] + 1;
        else dp[i2][j2] = Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
      }
    }

    // 回溯生成操作序列
    var i3 = 0, j3 = 0;
    while (i3 < n && j3 < m) {
      if (ol[i3] === nl[j3]) {
        result.push({ type: 'same', text: ol[i3] });
        i3++; j3++;
      } else if (dp[i3 + 1][j3] >= dp[i3][j3 + 1]) {
        result.push({ type: 'del', text: ol[i3] });
        i3++;
      } else {
        result.push({ type: 'add', text: nl[j3] });
        j3++;
      }
    }
    while (i3 < n) { result.push({ type: 'del', text: ol[i3] }); i3++; }
    while (j3 < m) { result.push({ type: 'add', text: nl[j3] }); j3++; }

    // 超出上限的行附加提示
    if (oldLines.length > MAX_LINES) {
      result.push({ type: 'del', text: '...(旧文本还有 ' + (oldLines.length - MAX_LINES) + ' 行未显示)' });
    }
    if (newLines.length > MAX_LINES) {
      result.push({ type: 'add', text: '...(新文本还有 ' + (newLines.length - MAX_LINES) + ' 行未显示)' });
    }

    return result;
  }

  /**
   * 分行（兼容 \r\n 与 \n；保留空行）
   */
  function splitLines(text) {
    if (!text) return [];
    return text.replace(/\r\n/g, '\n').split('\n');
  }

  return { diffLines: diffLines };
})();
