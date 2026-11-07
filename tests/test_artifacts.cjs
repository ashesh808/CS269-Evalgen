const test = require('node:test');
const assert = require('node:assert/strict');
const { extractArtifact, previewDocument } = require('../src/evalgen/web/artifacts.js');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';

test('raw and fenced SVGs are extracted without changing logo source', () => {
  for (const input of [svg, `Here is your logo:\n\n\`\`\`svg\n${svg}\n\`\`\`\n\nA circle.`, `\`\`\`xml\n${svg}\n\`\`\``]) {
    assert.deepEqual(extractArtifact(input), { format: 'svg', source: svg, filename: 'design.svg', mimeType: 'image/svg+xml' });
  }
});

test('SVG extraction retains XML declarations, nested SVGs and quoted greater-than signs', () => {
  const source = '<?xml version="1.0"?>\n<!-- logo -->\n<svg viewBox="0 0 10 10"><svg data-label="a>b"><path d="M0 0h1"/></svg></svg>';
  assert.equal(extractArtifact(`${source}\nThis is the final logo.`, 'svg').source, source);
  assert.equal(extractArtifact('<svg xmlns="http://www.w3.org/2000/svg"/>', 'svg').source, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(extractArtifact('<svg><path/>', 'svg'), null);
});

test('HTML docs and fragments are recognized but arbitrary prose and code remain text', () => {
  const source = '<!DOCTYPE html>\n<html><head><title>Mock</title></head><body><h1>Hello</h1></body></html>';
  assert.equal(extractArtifact(source).source, source);
  assert.equal(extractArtifact('<main><h1>Hello</h1></main>', 'html').format, 'html');
  for (const input of ['A product description.', 'A paragraph with <b>some markup</b>.', 'const value = 42;', '```javascript\nalert(1)\n```', '```css\nbody{color:red}\n```']) {
    assert.equal(extractArtifact(input), null);
  }
});

test('raw and unlabeled HTML permit comment preambles without interpreting prose', () => {
  const source = '<!-- landing page -->\n  <!-- self-contained mock -->\n<!doctype html>\n<html><body><h1>Hello</h1></body></html>';
  for (const input of [source, `\`\`\`\n${source}\n\`\`\``]) {
    assert.equal(extractArtifact(input).source, source);
    assert.equal(extractArtifact(input, 'html').format, 'html');
  }
  assert.equal(extractArtifact('<!-- note -->\nHere is a <b>bold</b> description.'), null);
  assert.equal(extractArtifact('<!-- note -->\nThis page uses <html> markup.'), null);
});

test('explicit formats do not silently accept another output type', () => {
  assert.equal(extractArtifact(svg, 'html'), null);
  assert.equal(extractArtifact('<html><body>Hello</body></html>', 'svg'), null);
  assert.equal(extractArtifact('', 'html'), null);
  assert.equal(extractArtifact(null), null);
});

test('separate HTML, CSS and JavaScript fences form a working downloadable document', () => {
  const response = 'Here is a site.\n```html\n<!doctype html><html><head></head><body><button id="go">Go</button></body></html>\n```\n```css\nbutton { color: red; }\n```\n```js\ndocument.querySelector("#go").onclick = () => alert("Hello");\n```';
  const result = extractArtifact(response, 'html');
  assert.equal(result.filename, 'website.html');
  assert.equal(result.mimeType, 'text/html');
  assert.match(result.source, /<style>\nbutton \{ color: red; \}\n<\/style>\n<\/head>/);
  assert.match(result.source, /<script>\ndocument.querySelector\("#go"\)/);
  assert.ok(result.source.indexOf('<script>') < result.source.indexOf('</body>'));
  assert.ok(!result.source.includes('Here is a site.'));
});

test('fences without a language and tilde fences support complete designs', () => {
  assert.equal(extractArtifact('~~~html\n<h1>Mock</h1>\n~~~').format, 'html');
  assert.equal(extractArtifact('```\n<div>Hello</div>\n```').format, 'html');
  assert.equal(extractArtifact(`\`\`\`\n${svg}\n\`\`\``).format, 'svg');
});

test('CSS and JS closing tags cannot escape their embedding context during assembly', () => {
  const response = '```html\n<div>Mock</div>\n```\n```css\na::after{content:"</style><iframe src=x>"}\n```\n```js\nconst end = "</script><iframe src=x>";\n```';
  const source = extractArtifact(response, 'html').source;
  assert.match(source, /<\\\/style><iframe/);
  assert.match(source, /<\\\/script><iframe/);
  assert.equal((source.match(/<\/style>/g) || []).length, 1);
  assert.equal((source.match(/<\/script>/g) || []).length, 1);
});

test('HTML preview policy blocks network and embedding while allowing inline mock interactions', () => {
  const source = '<html><head><meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com/"></head><body><button onclick="this.textContent=\'Done\'">Try</button><script>window.ready = true;</script></body></html>';
  const doc = previewDocument(extractArtifact(source, 'html'));
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<button'));
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "worker-src 'none'", "script-src 'unsafe-inline'", "img-src data: blob:"]) {
    assert.ok(doc.includes(directive), directive);
  }
  assert.ok(!doc.includes('http-equiv="refresh"'));
  assert.ok(!doc.includes('<base'));
  assert.ok(doc.includes('<script>window.ready = true;</script>'));
  assert.equal(extractArtifact(source, 'html').source, source, 'preview changes never alter the download');
});

test('SVG previews center the logo and disallow scripts', () => {
  const doc = previewDocument(extractArtifact(svg));
  assert.ok(doc.includes("script-src 'none'"));
  assert.ok(doc.includes('place-items:center'));
  assert.ok(doc.includes(svg));
  assert.throws(() => previewDocument(null), TypeError);
  assert.throws(() => previewDocument({ format: 'text', source: 'hello' }), TypeError);
});

// Exercise the viewer's trust boundary without requiring a browser dependency.
function fakeDocument() {
  const make = (tag) => {
    const element = { tagName: tag, className: '', textContent: '', hidden: false, children: [], attributes: {}, listeners: {},
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
    };
    element.classList = { toggle(name, on) {
      const classes = new Set(element.className.split(' ').filter(Boolean));
      if (on) classes.add(name); else classes.delete(name);
      element.className = [...classes].join(' ');
    } };
    return element;
  };
  return { createElement: make };
}

test('viewer confines HTML to a sandbox and shows the complete original response as inert source', () => {
  const previous = global.document;
  global.document = fakeDocument();
  try {
    const { createViewer, clearViewers } = require('../src/evalgen/web/artifacts.js');
    clearViewers();
    const input = 'A working mock:\n```html\n<button onclick="this.textContent=\'Done\'">Try</button>\n```';
    const viewer = createViewer(input, { format: 'html', key: 'response-1', compact: true });
    const [toolbar, frame, code] = viewer.children;
    assert.equal(viewer.className, 'artifact-viewer compact');
    assert.equal(frame.attributes.sandbox, 'allow-scripts');
    assert.ok(!frame.attributes.sandbox.includes('allow-same-origin'));
    assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
    assert.ok(frame.srcdoc.includes('<button onclick='));
    assert.equal(code.children[0].textContent, input);
    const [preview, source] = toolbar.children[0].children;
    source.listeners.click();
    assert.equal(code.hidden, false);
    assert.equal(frame.hidden, true);
    assert.equal(source.attributes['aria-pressed'], 'true');
    assert.equal(createViewer(input, { format: 'html', key: 'response-1', compact: true }), viewer);
    preview.listeners.click();
    assert.equal(code.hidden, true);
    assert.equal(frame.hidden, false);
    clearViewers();
    assert.notEqual(createViewer(input, { format: 'html', key: 'response-1', compact: true }), viewer);
  } finally { global.document = previous; }
});

test('viewer keeps failed artifact responses readable and disables scripting for SVG', () => {
  const previous = global.document;
  global.document = fakeDocument();
  try {
    const { createViewer } = require('../src/evalgen/web/artifacts.js');
    const plain = createViewer('A friendly product description.');
    assert.equal(plain.textContent, 'A friendly product description.');
    assert.equal(plain.children.length, 0);
    const failed = createViewer('No SVG was produced.', { format: 'svg' });
    assert.match(failed.children[0].textContent, /No SVG preview found/);
    assert.equal(failed.children[1].children[0].textContent, 'No SVG was produced.');
    const vector = createViewer(svg, { format: 'svg' });
    assert.equal(vector.children[1].attributes.sandbox, '');
  } finally { global.document = previous; }
});

const screenshot = { data_url: 'data:image/png;base64,iVBORw0KGgo=', width: 960, height: 640,
  viewport: { width: 960, height: 640 }, source_hash: 'a'.repeat(64) };

test('screenshots accept bounded PNG data URLs and reject active or remote content', () => {
  const { isScreenshot } = require('../src/evalgen/web/artifacts.js');
  assert.equal(isScreenshot(screenshot), true);
  for (const value of [null, {}, { ...screenshot, data_url: 'javascript:alert(1)' },
    { ...screenshot, data_url: 'https://example.com/screenshot.png' },
    { ...screenshot, data_url: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { ...screenshot, data_url: 'data:image/png;base64,not valid' },
    { ...screenshot, data_url: 'data:image/png;base64,' + 'a'.repeat(750000) },
    { ...screenshot, width: 0 }, { ...screenshot, height: 1.5 }, { ...screenshot, height: 5000 }]) {
    assert.equal(isScreenshot(value), false);
  }
});

test('captured screenshot updates a mounted viewer without replacing its interactive frame', () => {
  const previous = global.document;
  global.document = fakeDocument();
  try {
    const { createViewer, clearViewers, updateScreenshot } = require('../src/evalgen/web/artifacts.js');
    clearViewers();
    const input = '<main><button>Interactive preview</button></main>';
    const viewer = createViewer(input, { format: 'html', key: 'captured-output' });
    const [toolbar, frame, code, panel] = viewer.children;
    const [preview, source, captured] = toolbar.children[0].children;
    assert.equal(captured.hidden, true);
    updateScreenshot('captured-output', screenshot);
    assert.equal(captured.hidden, false);
    assert.equal(panel.children[0].src, screenshot.data_url);
    assert.match(panel.children[1].textContent, /Initial render.*viewport 960 × 640/);
    captured.listeners.click();
    assert.equal(panel.hidden, false);
    assert.equal(frame.hidden, true);
    assert.equal(code.hidden, true);
    assert.equal(captured.attributes['aria-pressed'], 'true');
    assert.equal(createViewer(input, { format: 'html', key: 'captured-output', screenshot }), viewer);
    assert.equal(viewer.children[1], frame, 'the live preview is never replaced by screenshot capture');
    assert.equal(panel.hidden, false, 'background updates retain the chosen screenshot tab');
    source.listeners.click();
    assert.equal(code.hidden, false);
    assert.equal(panel.hidden, true);
    preview.listeners.click();
    assert.equal(frame.hidden, false);
    updateScreenshot('captured-output', { data_url: 'javascript:alert(1)' });
    assert.equal(captured.hidden, true);
    assert.equal(frame.hidden, false);
    clearViewers();
  } finally { global.document = previous; }
});
