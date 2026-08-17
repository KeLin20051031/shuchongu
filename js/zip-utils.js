// 书虫蛊 · 轻量 ZIP 工具（纯前端离线，无第三方依赖）
// 用于 P7 导入导出：导出生成标准 ZIP（store 无压缩 + CRC32），导入解析自产 ZIP。
// 仅支持 store 方法（method 0）；遇到 Deflate（method 8）会明确报错，避免静默损坏。
const ZipUtils = (function() {
  'use strict';

  // ---------- CRC32（ZIP 条目校验） ----------
  var _crcTable = null;
  function _crc32Table() {
    if (_crcTable) return _crcTable;
    _crcTable = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      _crcTable[n] = c >>> 0;
    }
    return _crcTable;
  }
  function crc32(u8) {
    var table = _crc32Table();
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) {
      c = table[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- 二进制拼接辅助 ----------
  function _concat(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], off);
      off += parts[j].length;
    }
    return out;
  }
  function _u16(v) { return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]); }
  function _u32(v) {
    return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  }

  var _enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  var _dec = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;

  function _strBytes(s) {
    if (_enc) return _enc.encode(String(s));
    var raw = unescape(encodeURIComponent(String(s))); // eslint-disable-line
    var u = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i) & 0xFF;
    return u;
  }
  function _bytesStr(u8) {
    if (_dec) return _dec.decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(s)); // eslint-disable-line
  }

  // 统一转为 Uint8Array（支持 string / Uint8Array / ArrayBuffer / TypedArray）
  function _toU8(data) {
    if (typeof data === 'string') return _strBytes(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return _strBytes(String(data));
  }

  // ---------- 创建 ZIP（store 无压缩） ----------
  // files: [{ name: string, data: string | Uint8Array | ArrayBuffer }]
  // 返回 Uint8Array（完整 ZIP 二进制）
  function createZip(files) {
    files = files || [];
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    for (var i = 0; i < files.length; i++) {
      var name = String(files[i].name || 'file_' + i);
      var data = _toU8(files[i].data);
      var nameBytes = _strBytes(name);
      var crc = crc32(data);
      var size = data.length;

      // Local file header（30 字节固定 + 文件名）
      var localHeader = _concat([
        _u32(0x04034b50), _u16(20), _u16(0x0800), _u16(0),   // signature / version / flag(UTF-8) / method
        _u16(0), _u16(0), _u32(crc), _u32(size), _u32(size), // time / date / crc / comp / uncomp
        _u16(nameBytes.length), _u16(0), nameBytes            // name len / extra len / name
      ]);
      localParts.push(localHeader, data);

      // Central directory entry（46 字节固定 + 文件名）
      var centralEntry = _concat([
        _u32(0x02014b50), _u16(20), _u16(20), _u16(0x0800), _u16(0), // sig / madeby / needed / flag / method
        _u16(0), _u16(0), _u32(crc), _u32(size), _u32(size),         // time / date / crc / comp / uncomp
        _u16(nameBytes.length), _u16(0), _u16(0),                     // name len / extra len / comment len
        _u16(0), _u16(0), _u32(0), _u32(offset),                      // disk / int attrs / ext attrs / local offset
        nameBytes
      ]);
      centralParts.push(centralEntry);

      offset += localHeader.length + data.length;
    }

    var centralDir = _concat(centralParts);
    var eocd = _concat([
      _u32(0x06054b50), _u16(0), _u16(0),                 // sig / disk / cd disk
      _u16(files.length), _u16(files.length),             // entries on disk / total
      _u32(centralDir.length), _u32(offset), _u16(0)      // cd size / cd offset / comment len
    ]);

    return _concat([_concat(localParts), centralDir, eocd]);
  }

  // ---------- 解析 ZIP ----------
  // 返回 [{ name, data: Uint8Array, size }]，data 为独立副本（不与大 buffer 共享）
  function parseZip(u8) {
    var buf = _toU8(u8);
    if (buf.length < 22) throw new Error('不是有效的 ZIP 文件（内容过短）');
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // 从尾部回扫定位 EOCD（兼容无注释 / 带少量注释的自产包）
    var eocdPos = -1;
    var minPos = Math.max(0, buf.length - 65557);
    for (var p = buf.length - 22; p >= minPos; p--) {
      if (dv.getUint32(p, true) === 0x06054b50) { eocdPos = p; break; }
    }
    if (eocdPos < 0) throw new Error('不是有效的 ZIP 文件（未找到结束标记）');

    var entryCount = dv.getUint16(eocdPos + 10, true);
    var cdSize = dv.getUint32(eocdPos + 12, true);
    var cdOffset = dv.getUint32(eocdPos + 16, true);
    if (entryCount === 0) return [];

    var files = [];
    var pos = cdOffset;
    var end = cdOffset + cdSize;
    for (var i = 0; i < entryCount && pos + 46 <= end; i++) {
      if (dv.getUint32(pos, true) !== 0x02014b50) break;
      var method = dv.getUint16(pos + 10, true);
      var crc = dv.getUint32(pos + 16, true);
      var compSize = dv.getUint32(pos + 20, true);
      var uncompSize = dv.getUint32(pos + 24, true);
      var nameLen = dv.getUint16(pos + 28, true);
      var extraLen = dv.getUint16(pos + 30, true);
      var commentLen = dv.getUint16(pos + 32, true);
      var localOffset = dv.getUint32(pos + 42, true);
      var name = _bytesStr(buf.subarray(pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;

      if (dv.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error('ZIP 结构损坏（' + name + '）：无法定位文件数据');
      }
      var lNameLen = dv.getUint16(localOffset + 26, true);
      var lExtraLen = dv.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + lNameLen + lExtraLen;
      var data = buf.subarray(dataStart, dataStart + compSize).slice();

      if (method !== 0) {
        throw new Error('暂不支持该 ZIP 压缩方法（' + method + '）。请使用书虫蛊自身导出的备份包。');
      }
      if (crc && crc32(data) !== crc) {
        // CRC 不符：内容可能损坏，仍返回但保留告警标记
        files.push({ name: name, data: data, size: uncompSize || compSize, crcMismatch: true });
      } else {
        files.push({ name: name, data: data, size: uncompSize || compSize });
      }
    }
    return files;
  }

  return { createZip: createZip, parseZip: parseZip, crc32: crc32 };
})();
