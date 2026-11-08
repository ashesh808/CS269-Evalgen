// Small, dependency-free ZIP writer. Entries are stored verbatim for broad compatibility.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EvalGenZip = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const encoder = new TextEncoder();
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  function createZip(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 256) {
      throw new TypeError('A ZIP bundle needs between 1 and 256 files.');
    }
    const seen = new Set();
    const files = entries.map((entry) => {
      const name = entry?.name;
      if (typeof name !== 'string' || !name || /[\\\u0000-\u001f]/.test(name)
        || name.startsWith('/') || /^[a-z]:/i.test(name)
        || name.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(name)) {
        throw new TypeError('ZIP filenames must be unique relative paths.');
      }
      seen.add(name);
      const encoded = encoder.encode(name);
      if (encoded.length > 65535) throw new TypeError('A ZIP filename is too long.');
      const bytes = typeof entry.content === 'string' ? encoder.encode(entry.content)
        : entry.content instanceof Uint8Array ? entry.content : null;
      if (!bytes) throw new TypeError('ZIP contents must be text or bytes.');
      return { name: encoded, bytes, checksum: crc32(bytes), offset: 0 };
    });
    const localSize = files.reduce((size, file) => size + 30 + file.name.length + file.bytes.length, 0);
    const centralSize = files.reduce((size, file) => size + 46 + file.name.length, 0);
    const size = localSize + centralSize + 22;
    if (size > 64 * 1024 * 1024) throw new RangeError('This ZIP bundle exceeds the 64 MiB limit.');
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    const word = (at, value) => view.setUint16(at, value, true);
    const long = (at, value) => view.setUint32(at, value, true);
    for (const file of files) {
      file.offset = offset;
      long(offset, 0x04034b50); word(offset + 4, 20); word(offset + 6, 0x0800);
      // DOS timestamp: 1980-01-01. Export time belongs to the session, not the ZIP container.
      word(offset + 12, 0x0021); long(offset + 14, file.checksum);
      long(offset + 18, file.bytes.length); long(offset + 22, file.bytes.length);
      word(offset + 26, file.name.length);
      bytes.set(file.name, offset + 30);
      bytes.set(file.bytes, offset + 30 + file.name.length);
      offset += 30 + file.name.length + file.bytes.length;
    }
    for (const file of files) {
      long(offset, 0x02014b50); word(offset + 4, 20); word(offset + 6, 20);
      word(offset + 8, 0x0800); word(offset + 14, 0x0021); long(offset + 16, file.checksum);
      long(offset + 20, file.bytes.length); long(offset + 24, file.bytes.length);
      word(offset + 28, file.name.length); long(offset + 42, file.offset);
      bytes.set(file.name, offset + 46);
      offset += 46 + file.name.length;
    }
    long(offset, 0x06054b50); word(offset + 8, files.length); word(offset + 10, files.length);
    long(offset + 12, centralSize); long(offset + 16, localSize);
    return bytes;
  }
  return Object.freeze({ createZip });
}));
