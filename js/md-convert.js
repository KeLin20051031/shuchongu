// MD 转换模块 — HTML → Markdown（所见即所得编辑保存）
// 用于 AI 块 WYSIWYG 编辑：用户直接在渲染的表格/内容里修改，失焦后转回 Markdown 保存
const MDConverter = (function() {
  'use strict';

  /**
   * 将 HTML 转换为 Markdown 文本
   * @param {string} html - 编辑后的富文本 HTML
   * @returns {string}
   */
  function htmlToMarkdown(html) {
    if (!html) return '';
    var div = document.createElement('div');
    div.innerHTML = html;
    return blockToMarkdown(div).trim();
  }

  // 块级元素转 Markdown
  function blockToMarkdown(node) {
    var md = '';
    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) { // 文本节点
        var t = child.textContent || '';
        md += t;
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName.toLowerCase();
      switch (tag) {
        case 'p':
          md += inlineToMarkdown(child).trim() + '\n\n';
          break;
        case 'div':
          md += blockToMarkdown(child);
          break;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          md += new Array(parseInt(tag[1], 10) + 1).join('#') + ' ' + inlineToMarkdown(child).trim() + '\n\n';
          break;
        case 'table':
          md += tableToMarkdown(child) + '\n\n';
          break;
        case 'ul':
          md += listToMarkdown(child, 'ul') + '\n\n';
          break;
        case 'ol':
          md += listToMarkdown(child, 'ol') + '\n\n';
          break;
        case 'blockquote':
          md += '> ' + blockToMarkdown(child).trim().replace(/\n/g, '\n> ') + '\n\n';
          break;
        case 'pre':
          md += '```\n' + (child.textContent || '') + '\n```\n\n';
          break;
        case 'hr':
          md += '---\n\n';
          break;
        case 'br':
          md += '\n';
          break;
        default:
          md += inlineToMarkdown(child);
      }
    }
    return md;
  }

  // 行内元素转 Markdown
  function inlineToMarkdown(node) {
    var md = '';
    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) {
        md += child.textContent || '';
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName.toLowerCase();
      switch (tag) {
        case 'strong': case 'b':
          md += '**' + inlineToMarkdown(child) + '**';
          break;
        case 'em': case 'i':
          md += '*' + inlineToMarkdown(child) + '*';
          break;
        case 'code':
          md += '`' + (child.textContent || '') + '`';
          break;
        case 'a':
          md += '[' + inlineToMarkdown(child) + '](' + (child.getAttribute('href') || '') + ')';
          break;
        case 'img':
          md += '![' + (child.getAttribute('alt') || '') + '](' + (child.getAttribute('src') || '') + ')';
          break;
        case 'br':
          md += '\n';
          break;
        case 'span':
          md += inlineToMarkdown(child);
          break;
        default:
          md += inlineToMarkdown(child);
      }
    }
    return md;
  }

  // 表格转 GFM Markdown
  function tableToMarkdown(table) {
    var rows = table.querySelectorAll('tr');
    if (!rows.length) return '';
    var lines = [];
    var isFirst = true;
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('th, td');
      var texts = [];
      for (var j = 0; j < cells.length; j++) {
        var t = inlineToMarkdown(cells[j]).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|');
        texts.push(t);
      }
      lines.push('| ' + texts.join(' | ') + ' |');
      if (isFirst) {
        lines.push('| ' + texts.map(function() { return '---'; }).join(' | ') + ' |');
        isFirst = false;
      }
    }
    return lines.join('\n');
  }

  // 列表转 Markdown（含嵌套）
  function listToMarkdown(list, type) {
    var md = '';
    var items = list.children;
    var index = 1;
    for (var i = 0; i < items.length; i++) {
      var li = items[i];
      if (!li || li.nodeType !== 1) continue;
      if (li.tagName.toLowerCase() !== 'li') continue;
      var prefix = type === 'ol' ? (index + '.') : '-';
      var content = blockToMarkdown(li).trim();
      md += prefix + ' ' + content + '\n';
      // 嵌套列表
      for (var j = 0; j < li.children.length; j++) {
        var sub = li.children[j];
        if (!sub || sub.nodeType !== 1) continue;
        var subTag = sub.tagName.toLowerCase();
        if (subTag === 'ul' || subTag === 'ol') {
          var subMd = listToMarkdown(sub, subTag === 'ol' ? 'ol' : 'ul');
          if (subMd) {
            md += subMd.split('\n').map(function(line) { return '  ' + line; }).join('\n') + '\n';
          }
        }
      }
      index++;
    }
    return md.trim();
  }

  return { htmlToMarkdown: htmlToMarkdown };
})();
