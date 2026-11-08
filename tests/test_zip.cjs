const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createZip } = require('../src/evalgen/web/zip.js');

test('session ZIPs round trip through Python’s standard ZIP reader', () => {
  const entries = [
    { name: 'session.json', content: '{"grade":null,"explanation":"café 🌧️"}\n' },
    { name: 'report.html', content: '<!doctype html><p>Research &amp; design</p>' },
    { name: 'artifacts/研究.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    { name: 'screenshots/response-1.png', content: new Uint8Array([0, 255, 1, 2]) },
  ];
  const bytes = createZip(entries);
  const result = spawnSync('python3', ['-c',
    'import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:list(z.read(n)) for n in z.namelist()}))'],
  { input: bytes, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  for (const entry of entries) {
    assert.deepEqual(actual[entry.name], Array.from(typeof entry.content === 'string'
      ? new TextEncoder().encode(entry.content) : entry.content));
  }
});

test('ZIP entries are deterministic and use the standard CRC32 checksum', () => {
  const input = [{ name: 'vector.txt', content: '123456789' }, { name: 'empty.txt', content: '' }];
  const result = createZip(input);
  assert.deepEqual(result, createZip(input));
  assert.equal(new DataView(result.buffer).getUint32(14, true), 0xcbf43926);
});

test('ZIP writer rejects ambiguous paths, duplicate names and unsupported content', () => {
  for (const name of ['../secret', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a/./b', 'C:/file', 'bad\u0000name']) {
    assert.throws(() => createZip([{ name, content: '' }]), /relative paths/);
  }
  assert.throws(() => createZip([{ name: 'a', content: '' }, { name: 'a', content: 'b' }]), /relative paths/);
  assert.throws(() => createZip([{ name: 'a', content: {} }]), /text or bytes/);
  assert.throws(() => createZip([]), /between 1 and 256/);
});
