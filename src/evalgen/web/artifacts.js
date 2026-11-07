// Render generated designs only inside an opaque-origin, network-restricted iframe.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EvalGenArtifacts = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const viewers = new Map();
  const asText = (value) => typeof value === 'string' ? value : '';
  const formatName = (format) => ['svg', 'html'].includes(format) ? format : 'text';
  const htmlStart = /^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<(?:main|div|section|header|nav|article|style|script|button|form|h[1-6]|p)\b)/i;
  const svgStart = /^(?:(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*<svg\b/i;

  function isScreenshot(value) {
    return Boolean(value && typeof value === 'object' && typeof value.data_url === 'string'
      && value.data_url.length <= 750000
      && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data_url)
      && Number.isInteger(value.width) && value.width > 0 && value.width <= 4096
      && Number.isInteger(value.height) && value.height > 0 && value.height <= 4096);
  }

  function updateScreenshot(key, screenshot) {
    const viewer = viewers.get(key);
    if (viewer?.updateScreenshot) viewer.updateScreenshot(screenshot);
  }

  function artifact(format, source) {
    return { format, source, filename: format === 'svg' ? 'design.svg' : 'website.html',
      mimeType: format === 'svg' ? 'image/svg+xml' : 'text/html' };
  }

  // SVG roots may contain nested SVGs; keep the entire root, including its closing tag.
  function svgSource(source) {
    const value = source.trim();
    if (!svgStart.test(value)) return null;
    const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    let depth = 0;
    let match;
    while ((match = tags.exec(value))) {
      const tag = match[0];
      if (!/^<\/?svg\b/i.test(tag)) continue;
      if (/^<\//.test(tag)) depth -= 1;
      else if (!/\/\s*>$/.test(tag)) depth += 1;
      if (depth === 0) return value.slice(0, tags.lastIndex);
    }
    return null;
  }

  function insertBefore(source, closingTag, content) {
    const closing = new RegExp(`</${closingTag}\\s*>`, 'i');
    return closing.test(source) ? source.replace(closing, () => `${content}\n</${closingTag}>`)
      : `${source}\n${content}`;
  }

  function assembleWebsite(html, css, javascript) {
    let source = html;
    if (css.length) {
      // A CSS/JS fence cannot close its embedding element and become HTML markup.
      const styles = css.join('\n\n').replace(/<\/style/gi, '<\\/style');
      source = insertBefore(source, 'head', `<style>\n${styles}\n</style>`);
    }
    if (javascript.length) {
      const scripts = javascript.join('\n\n').replace(/<\/script/gi, '<\\/script');
      source = insertBefore(source, 'body', `<script>\n${scripts}\n</script>`);
    }
    return source;
  }

  function extractArtifact(text, format = 'text') {
    const source = asText(text).trim();
    if (!source) return null;
    const requested = formatName(format);
    const blocks = [];
    const fences = /(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([^\r\n]*)\r?\n([\s\S]*?)(?:\r?\n)[ \t]*\1[ \t]*(?=\r?\n|$)/g;
    let match;
    while ((match = fences.exec(source))) {
      const info = match[2].trim().toLowerCase();
      const language = info.split(/[\s:{]/)[0];
      blocks.push({ language, source: match[3].trim() });
    }
    const html = blocks.filter((block) => ['html', 'htm', 'html5'].includes(block.language));
    const svg = blocks.filter((block) => block.language === 'svg');
    const anonymous = blocks.filter((block) => !block.language || block.language === 'xml');
    if (requested !== 'svg' && html.length) {
      const css = blocks.filter((block) => block.language === 'css').map((block) => block.source);
      const javascript = blocks.filter((block) => ['js', 'javascript'].includes(block.language)).map((block) => block.source);
      return artifact('html', assembleWebsite(html.map((block) => block.source).join('\n'), css, javascript));
    }
    if (requested !== 'html') {
      for (const block of [...svg, ...anonymous]) {
        const extracted = svgSource(block.source);
        if (extracted) return artifact('svg', extracted);
      }
    }
    if (requested !== 'svg') {
      for (const block of anonymous) {
        if (htmlStart.test(block.source)) return artifact('html', block.source);
      }
      if (htmlStart.test(source)) return artifact('html', source);
    }
    if (requested !== 'html') {
      const extracted = svgSource(source);
      if (extracted) return artifact('svg', extracted);
    }
    return null;
  }

  function previewDocument(design) {
    if (!design || !['svg', 'html'].includes(design.format) || typeof design.source !== 'string') {
      throw new TypeError('A valid SVG or HTML artifact is required.');
    }
    const scripts = design.format === 'html' ? "'unsafe-inline'" : "'none'";
    // The first policy cannot be loosened by any later policy in generated markup.
    const policy = `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; `
      + "img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; "
      + "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; "
      + "base-uri 'none'; form-action 'none'";
    const canvas = design.format === 'svg'
      ? '<style>html,body{margin:0;min-height:100%;background:#fff;color:#172431}body{min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}body>svg{display:block;max-width:100%;max-height:calc(100vh - 48px);width:auto;height:auto}</style>'
      : '<style>html{color-scheme:light}body{margin:0}</style>';
    // Refresh tags can navigate a frame without a script or a network resource fetch.
    // Remove all metadata from generated source; the host supplies viewport and CSP.
    const content = design.source.replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '')
      .replace(/<base\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '');
    return '<!doctype html><html><head><meta charset="utf-8">'
      + `<meta http-equiv="Content-Security-Policy" content="${policy}">`
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + canvas + '</head><body>' + content + '</body></html>';
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function download(design) {
    const url = URL.createObjectURL(new Blob([design.source], { type: `${design.mimeType};charset=utf-8` }));
    const link = node('a');
    link.href = url;
    link.download = design.filename;
    document.body.append(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function createViewer(text, options = {}) {
    const source = asText(text);
    const format = formatName(options.format);
    const compact = options.compact === true;
    const key = asText(options.key);
    const cached = key && viewers.get(key);
    if (cached && cached.source === source && cached.format === format && cached.compact === compact) {
      cached.onViewChange = options.onViewChange;
      if (cached.updateScreenshot) cached.updateScreenshot(options.screenshot);
      return cached.element;
    }
    const design = extractArtifact(source, format);
    if (!design && format === 'text') return node('div', 'response-text', source);
    const wrapper = node('div', `artifact-viewer${compact ? ' compact' : ''}`);
    const entry = { source, format, compact, element: wrapper, onViewChange: options.onViewChange };
    if (key) viewers.set(key, entry);
    const code = node('pre', 'artifact-source');
    code.append(node('code', '', source));
    if (!design) {
      wrapper.append(node('p', 'artifact-notice', `No ${format === 'svg' ? 'SVG' : 'HTML'} preview found. The response is shown below.`), code);
      return wrapper;
    }
    const toolbar = node('div', 'artifact-toolbar');
    const tabs = node('div', 'artifact-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Response view');
    const preview = node('button', 'artifact-tab active', 'Preview');
    const sourceButton = node('button', 'artifact-tab', 'Source');
    const screenshotButton = node('button', 'artifact-tab', 'Screenshot');
    screenshotButton.hidden = true;
    [preview, sourceButton, screenshotButton].forEach((button) => { button.type = 'button'; });
    const frame = node('iframe', 'artifact-preview');
    frame.title = design.format === 'svg' ? 'SVG design preview' : 'Website design preview';
    frame.setAttribute('sandbox', design.format === 'html' ? 'allow-scripts' : '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
    frame.srcdoc = previewDocument(design);
    code.hidden = true;
    const screenshotPanel = node('figure', 'artifact-screenshot');
    screenshotPanel.hidden = true;
    const screenshotImage = node('img');
    screenshotImage.alt = 'Screenshot used by the evaluator';
    const screenshotCaption = node('figcaption');
    screenshotPanel.append(screenshotImage, screenshotCaption);
    let view = 'preview';
    const show = (mode) => {
      view = mode;
      const rendered = mode === 'preview';
      frame.hidden = !rendered;
      code.hidden = mode !== 'source';
      screenshotPanel.hidden = mode !== 'screenshot';
      preview.classList.toggle('active', rendered);
      sourceButton.classList.toggle('active', mode === 'source');
      screenshotButton.classList.toggle('active', mode === 'screenshot');
      preview.setAttribute('aria-pressed', String(rendered));
      sourceButton.setAttribute('aria-pressed', String(mode === 'source'));
      screenshotButton.setAttribute('aria-pressed', String(mode === 'screenshot'));
      if (typeof entry.onViewChange === 'function') entry.onViewChange(mode);
    };
    preview.setAttribute('aria-pressed', 'true');
    sourceButton.setAttribute('aria-pressed', 'false');
    screenshotButton.setAttribute('aria-pressed', 'false');
    preview.addEventListener('click', () => show('preview'));
    sourceButton.addEventListener('click', () => show('source'));
    screenshotButton.addEventListener('click', () => show('screenshot'));
    entry.updateScreenshot = (screenshot) => {
      const valid = isScreenshot(screenshot);
      screenshotButton.hidden = !valid;
      if (valid) {
        if (screenshotImage.src !== screenshot.data_url) screenshotImage.src = screenshot.data_url;
        const width = screenshot.viewport?.width;
        const height = screenshot.viewport?.height;
        const viewport = Number.isInteger(width) && Number.isInteger(height) ? ` · viewport ${width} × ${height}` : '';
        screenshotCaption.textContent = `Initial render · ${screenshot.width} × ${screenshot.height}${viewport}. Live preview interactions are not included.`;
      } else if (view === 'screenshot') show('preview');
    };
    tabs.append(preview, sourceButton, screenshotButton);
    const save = node('button', 'artifact-download', 'Download');
    save.type = 'button';
    save.title = `Download ${design.filename}`;
    save.addEventListener('click', () => download(design));
    toolbar.append(tabs, node('span', 'artifact-format', design.format === 'svg' ? 'SVG' : 'HTML / CSS / JS'), save);
    wrapper.append(toolbar, frame, code, screenshotPanel);
    entry.updateScreenshot(options.screenshot);
    return wrapper;
  }

  function clearViewers() { viewers.clear(); }

  return Object.freeze({ extractArtifact, previewDocument, createViewer, clearViewers, isScreenshot, updateScreenshot });
}));
