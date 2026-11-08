// EvalGen page, laid out after the prototype in Shankar et al. (UIST 2024):
// a Prompt node wired to a Multi-Evaluator node, a wizard (start, pick criteria,
// grade, report card), and a table view. Model source is shown as text or inside
// an isolated preview; it is never inserted into the application's own DOM.

const GRADE_FIRST_MIN = 5;
const OUTPUT_FORMATS = {
  text: { label: 'Text' },
  svg: {
    label: 'SVG',
    hint: 'Generate a vector design, then preview it or inspect its SVG source.',
    example: 'Design a minimal vector logo for a coffee shop called Orbit Coffee. Combine a coffee cup and an orbital ring into a distinctive, balanced mark. Use warm terracotta and dark espresso colors on a cream background. Include the shop name and keep the design legible at small sizes.',
  },
  html: {
    label: 'HTML/CSS/JS',
    hint: 'Generate a self-contained website mockup with inline styles and interactions.',
    example: 'Design a polished, responsive landing page for Orbit Coffee, an independent neighborhood coffee shop. Use a warm cream and terracotta palette, an expressive headline, a featured drinks section, and a visit-us section. Include a working mobile menu and a light/dark theme toggle. Build the illustration with CSS or inline SVG.',
  },
};

const state = {
  prompt: '',          // prompt the current responses came from
  outputFormat: 'text', // format recorded when these responses were sampled
  evaluationMode: 'source',
  evaluationPreference: null, // an explicit choice is retained across artifact runs
  visionModels: [],
  catalogModels: [],
  screenshotRenderer: { available: false, reason: 'Checking screenshot capture support.' },
  capturing: false,
  responses: [],       // { text, grade: true | false | null, feedback }
  criteria: [],        // { id, title, description, kind, on, keep, assertions, results, errors }
  suggesting: false,
  querying: false,
  exporting: null,
  importing: false,
  importedModelChoices: null,
  datasetGeneration: 0,
  defaultModel: null,
  sampleModel: null,
  sampleModelKnown: true,
  sampledAt: null,
  draft: '',           // unsent text in the add-criterion box
  report: null,
  reported: [],        // criterion ids in report order
  threshold: 0.4,
  models: { prompt: null, evaluator: null },  // null means the config.toml default
  progress: { total: 0, done: 0 },
  pythonSandbox: { available: false, reason: 'Checking Python execution support.' },
  sampling: null,
  wizard: { open: false, screen: 'start', gradeFirst: false, index: 0, nextHigh: true, navigation: 0, reached: new Set(['start']) },
};
let nextId = 1;

function allocateCriterionId() {
  while (state.criteria.some((criterion) => String(criterion.id) === String(nextId))) nextId += 1;
  return nextId++;
}

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'style') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  });
  children.flat(Infinity).forEach((child) => {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  });
  return node;
}

const pct = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`);
const label = (c) => (c.description ? `${c.title}: ${c.description}` : c.title);
const graded = () => state.responses.filter((r) => r.grade !== null).length;
const implementing = () => state.criteria.some((c) => c.status === 'generating' || c.status === 'running');
const kindLabel = (c) => c.kind === 'python' ? 'Code' : 'LLM';
const canImport = () => !state.querying && !state.suggesting && !state.capturing && !implementing() && !state.exporting && !state.importing;
const canExport = () => state.responses.length > 0 && canImport();

function invalidateCriterion(c) {
  c.runId = (c.runId || 0) + 1;
  Object.assign(c, { status: 'draft', assertions: [], results: null, errors: [], error: '', completed: 0, totalChecks: 0,
    evaluationMode: null, builtEvaluationMode: null });
  invalidateReport();
}

function invalidateReport() {
  reportSeq += 1;
  state.report = null;
  state.reported = [];
}

function toneFor(value) {
  if (value === null || value === undefined) return 'var(--overlay0)';
  if (value >= 0.75) return 'var(--green)';
  if (value >= 0.5) return 'var(--yellow)';
  return 'var(--red)';
}

// ---------- API ----------

let toastTimer = null;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 6000);
}

function requestJson(body) {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).length > 4_200_000) {
    throw new Error('This request is too large. Generate fewer responses or use shorter sources, then retry.');
  }
  return encoded;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : requestJson(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function evaluateStream(body, onEvent) {
  const response = await fetch('/api/evaluate/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestJson(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `Evaluation failed (${response.status}).`);
  }
  if (!response.body) throw new Error('Evaluation returned no result stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let finished = false;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.done) finished = true;
    else if (event.error && event.assertion === undefined) throw new Error(event.error);
    else onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) break;
    }
    consume(pending);
    if (!finished) throw new Error('Evaluation ended before every result was received.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

let samplingSeq = 0;
let pendingAdvance = null;
async function refreshSampling(advance = null) {
  if (state.querying) return;
  if (advance) pendingAdvance = advance;
  const requestedAdvance = pendingAdvance;
  const seq = ++samplingSeq;
  const generation = state.datasetGeneration;
  const nextHigh = state.wizard.nextHigh;
  try {
    const sampling = await api('/api/sampling', {
      results: state.criteria.filter((c) => c.on && c.keep && c.results)
        .map((c) => c.results.filter((_, candidate) => !c.errors?.[candidate]?.some(Boolean))),
      grades: state.responses.map((r) => r.grade), next_high: nextHigh,
    });
    if (seq !== samplingSeq || generation !== state.datasetGeneration) return;
    state.sampling = sampling;
    // New results refine the next recommendation without replacing an output being read.
    if (requestedAdvance && state.wizard.navigation === requestedAdvance.navigation && state.wizard.index === requestedAdvance.index
      && state.responses[requestedAdvance.index] === requestedAdvance.response && requestedAdvance.response.grade !== null) {
      const next = sampling.next_index;
      if (Number.isInteger(next) && state.responses[next]?.grade === null) {
        state.wizard.index = next;
        state.wizard.nextHigh = !nextHigh;
        state.wizard.navigation += 1;
      }
    }
    if (pendingAdvance === requestedAdvance) pendingAdvance = null;
    state.wizard.advancing = false;
    render();
  } catch (error) {
    if (seq !== samplingSeq || generation !== state.datasetGeneration) return;
    state.sampling = null;
    if (requestedAdvance && state.wizard.navigation === requestedAdvance.navigation && state.wizard.index === requestedAdvance.index) {
      const next = state.responses.findIndex((r) => r.grade === null);
      if (next !== -1) { state.wizard.index = next; state.wizard.navigation += 1; }
    }
    if (pendingAdvance === requestedAdvance) pendingAdvance = null;
    state.wizard.advancing = false;
    toast(`Could not update grading order: ${error.message}`);
    render();
  }
}

let resultRefreshTimer = null;
function queueResultRefresh() {
  if (resultRefreshTimer !== null) return;
  resultRefreshTimer = setTimeout(() => {
    resultRefreshTimer = null;
    refreshReport();
    refreshSampling();
  }, 80);
}

// ---------- Pipeline ----------

let screenshotJob = null;

function screenshotUnavailableReason() {
  if (!state.screenshotRenderer.available) return state.screenshotRenderer.reason || 'Screenshot capture is unavailable on this server.';
  if (!state.visionModels.length) return 'No image-capable evaluator was found in the model catalog. Source-only grading is available.';
  return '';
}

function saveModels() {
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(state.models)); } catch (e) { /* storage blocked */ }
}

function refreshEvaluatorModels() {
  const select = $('eval-model');
  const names = state.evaluationMode === 'screenshot' ? state.visionModels : state.catalogModels;
  if (!names.length) return;
  const current = state.models.evaluator;
  const chosen = names.includes(current) ? current
    : names.includes(state.models.prompt) ? state.models.prompt : names[0];
  select.replaceChildren(...names.map((id) => el('option', { value: id }, id)));
  select.value = chosen;
  state.models.evaluator = chosen;
  if (chosen !== current) saveModels();
}

function applyEvaluationDefault() {
  const previous = state.evaluationMode;
  state.evaluationMode = state.outputFormat === 'text' ? 'source'
    : state.evaluationPreference || (screenshotUnavailableReason() ? 'source' : 'screenshot');
  if (previous !== state.evaluationMode) state.criteria.forEach(invalidateCriterion);
  refreshEvaluatorModels();
}

function setEvaluationMode(mode) {
  if (!['source', 'screenshot'].includes(mode) || mode === state.evaluationMode) return;
  if (state.querying || state.suggesting || state.capturing || implementing()) return;
  if (mode === 'screenshot' && screenshotUnavailableReason()) {
    toast(screenshotUnavailableReason());
    render();
    return;
  }
  state.evaluationMode = mode;
  state.evaluationPreference = mode;
  state.criteria.forEach(invalidateCriterion);
  refreshEvaluatorModels();
  queueResultRefresh();
  render();
}

async function ensureScreenshots() {
  if (state.outputFormat === 'text') throw new Error('Screenshot grading is available for SVG and HTML responses.');
  if (screenshotUnavailableReason()) throw new Error(screenshotUnavailableReason());
  const responses = state.responses;
  const generation = state.datasetGeneration;
  if (!responses.length) throw new Error('Generate responses before capturing screenshots.');
  if (screenshotJob?.responses === responses && screenshotJob.generation === generation) return screenshotJob.promise;
  const failed = responses.filter((response) => response.screenshotError);
  if (failed.length) throw new Error('Some screenshots could not be captured. Use Retry screenshots before screenshot grading.');
  const pending = responses.map((response, index) => ({ response, index })).filter(({ response }) => !response.screenshot?.data_url);
  if (!pending.length) return;
  const current = () => generation === state.datasetGeneration && responses === state.responses;
  const job = { generation, responses, promise: null };
  screenshotJob = job;
  state.capturing = true;
  render();
  job.promise = (async () => {
    try {
      const result = await api('/api/screenshots', {
        outputs: pending.map(({ response }) => response.text), output_format: state.outputFormat,
      });
      if (!current()) throw new Error('The responses changed while screenshots were being captured.');
      if (!Array.isArray(result.screenshots) || result.screenshots.length !== pending.length) {
        throw new Error('The screenshot renderer returned an incomplete result.');
      }
      result.screenshots.forEach((screenshot, index) => {
        const response = pending[index].response;
        if (window.EvalGenArtifacts.isScreenshot(screenshot)) {
          response.screenshot = screenshot;
          response.screenshotError = '';
        } else {
          response.screenshot = null;
          response.screenshotError = typeof screenshot?.error === 'string' ? screenshot.error : 'The renderer returned no usable screenshot.';
        }
      });
      if (responses.some((response) => response.screenshotError)) {
        throw new Error('Some screenshots could not be captured. Review the capture status and retry.');
      }
    } catch (error) {
      if (current()) pending.forEach(({ response }) => {
        if (!response.screenshot && !response.screenshotError) response.screenshotError = error.message;
      });
      throw error;
    } finally {
      if (screenshotJob === job) {
        screenshotJob = null;
        state.capturing = false;
        render();
      }
    }
  })();
  return job.promise;
}

async function captureScreenshots() {
  if (state.querying || state.capturing || state.suggesting || implementing()) return;
  state.responses.forEach((response) => { response.screenshotError = ''; });
  try { await ensureScreenshots(); }
  catch (error) { toast(error.message); }
}

async function runPrompt() {
  if (state.querying) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  if (implementing()) { toast('Wait for the evaluator to finish first'); return; }
  if (state.suggesting) { toast('Wait for the criteria suggestions to finish first'); return; }
  const evaluated = state.criteria.some((c) => c.status !== 'draft');
  if (evaluated && !confirm('Running the prompt replaces the responses and grades, and resets evaluator results. Continue?')) return;

  const button = $('btn-run');
  const status = $('prompt-status');
  const count = Math.min(10, Math.max(1, Number($('num-responses').value) || 1));
  const outputFormat = $('output-format').value;
  const sampleModel = state.models.prompt || state.defaultModel;
  const generation = ++state.datasetGeneration;
  screenshotJob = null;
  state.capturing = false;
  state.querying = true;
  reportSeq += 1;
  samplingSeq += 1;
  pendingAdvance = null;
  state.report = null;
  state.reported = [];
  state.sampling = null;
  state.wizard.navigation += 1;
  state.wizard.advancing = false;
  button.disabled = true;
  button.classList.add('busy');
  status.classList.remove('error');
  status.textContent = `Sampling ${count} responses...`;
  render();
  try {
    const { outputs, output_details: outputDetails } = await api('/api/sample', { prompt, count, model: sampleModel, output_format: outputFormat });
    if (generation !== state.datasetGeneration) return;
    state.prompt = prompt;
    state.outputFormat = outputFormat;
    window.EvalGenArtifacts.clearViewers();
    state.sampleModel = sampleModel;
    state.sampleModelKnown = true;
    state.sampledAt = new Date().toISOString();
    state.responses = outputs.map((text, index) => {
      const detail = Array.isArray(outputDetails) ? outputDetails[index] : null;
      const explanation = typeof detail?.explanation === 'string' ? detail.explanation.trim() : '';
      const provided = detail?.explanation_status === 'provided' && explanation.length > 0;
      return { text, grade: null, feedback: '', explanation: provided ? explanation : null,
        explanationStatus: provided ? 'provided' : 'unavailable' };
    });
    applyEvaluationDefault();
    state.criteria.forEach(invalidateCriterion);
    state.report = null;
    state.reported = [];
    reportSeq += 1;
    state.wizard.index = 0;
    state.wizard.nextHigh = true;
    state.wizard.navigation += 1;
    state.wizard.advancing = false;
    state.sampling = null;
    pendingAdvance = null;
    samplingSeq += 1;
    status.textContent = '';
  } catch (error) {
    if (generation !== state.datasetGeneration) return;
    status.textContent = 'Failed';
    status.classList.add('error');
    toast(error.message);
  } finally {
    if (generation === state.datasetGeneration) {
      state.querying = false;
      button.classList.remove('busy');
      render();
      refreshReport();
    }
  }
}

async function suggest() {
  if (state.querying || state.suggesting) return;
  state.suggesting = true;
  render();
  try {
    if (state.evaluationMode === 'screenshot') await ensureScreenshots();
    const { criteria } = await api('/api/criteria', {
      prompt: state.prompt,
      output_format: state.outputFormat,
      evaluation_mode: state.evaluationMode,
      graded: state.responses
        .filter((r) => r.grade !== null)
        .map((r) => ({ output: r.text, good: r.grade, feedback: r.feedback,
          ...(state.evaluationMode === 'screenshot' ? { screenshot: r.screenshot.data_url } : {}) })),
      existing: state.criteria.map((c) => c.title),
      model: state.models.evaluator,
    });
    if (!criteria.length) toast('The model returned no criteria, try again or add your own');
    criteria.forEach((c) => addCriterion(c.title, c.description));
  } catch (error) {
    toast(error.message);
  } finally {
    state.suggesting = false;
    render();
  }
}

function addCriterion(title, description = '') {
  state.criteria.push({
    id: allocateCriterionId(), title, description, kind: 'llm', on: true, keep: true,
    status: 'draft', assertions: [], results: null, errors: [], error: '', completed: 0, totalChecks: 0, runId: 0,
  });
  invalidateReport();
  queueResultRefresh();
}

function tick(steps = 1) {
  state.progress.done += steps;
  render();
}

async function implement(criterion) {
  if (state.querying) { toast('Wait for the prompt responses to finish first'); return; }
  let remaining = 2;
  const runId = ++criterion.runId;
  const current = () => criterion.runId === runId && state.criteria.includes(criterion);
  try {
    if (criterion.kind === 'python' && !state.pythonSandbox.available) {
      throw new Error(state.pythonSandbox.reason || 'Python evaluation is unavailable.');
    }
    criterion.status = 'generating';
    criterion.built = label(criterion);
    criterion.builtKind = criterion.kind;
    criterion.evaluationMode = criterion.kind === 'python' ? 'source' : state.evaluationMode;
    criterion.builtEvaluationMode = criterion.evaluationMode;
    criterion.model = state.models.evaluator;
    criterion.modelKnown = true;
    criterion.error = '';
    criterion.errors = [];
    criterion.results = null;
    criterion.completed = 0;
    criterion.totalChecks = 0;
    render();
    if (criterion.evaluationMode === 'screenshot') await ensureScreenshots();
    if (!current()) return;
    const { assertions } = await api('/api/assertions', {
      prompt: state.prompt, output_format: state.outputFormat,
      evaluation_mode: criterion.evaluationMode,
      criteria: [label(criterion)], kinds: [criterion.kind], model: criterion.model,
    });
    if (!current()) return;
    criterion.assertions = assertions[0] || [];
    remaining -= 1;
    tick();
    if (!criterion.assertions.length) throw new Error(`No assertions could be parsed for "${criterion.title}"`);
    criterion.status = 'running';
    criterion.results = criterion.assertions.map(() => state.responses.map(() => null));
    criterion.errors = criterion.assertions.map(() => state.responses.map(() => null));
    criterion.totalChecks = criterion.assertions.length * state.responses.length;
    const received = new Set();
    render();
    await evaluateStream({
      prompt: state.prompt,
      output_format: state.outputFormat,
      evaluation_mode: criterion.evaluationMode,
      ...(criterion.evaluationMode === 'screenshot' ? { screenshots: state.responses.map((r) => r.screenshot.data_url) } : {}),
      assertions: [criterion.assertions],
      kinds: [criterion.kind],
      outputs: state.responses.map((r) => r.text),
      model: criterion.model,
    }, (event) => {
      if (!current() || event.criterion !== 0) return;
      const { assertion, output, verdict } = event;
      if (!Number.isInteger(assertion) || !Number.isInteger(output)
        || !criterion.results[assertion] || output < 0 || output >= state.responses.length) return;
      criterion.results[assertion][output] = verdict === true || verdict === false ? verdict : null;
      criterion.errors[assertion][output] = event.error || (verdict == null ? 'No readable verdict was returned.' : null);
      received.add(`${assertion}:${output}`);
      criterion.completed = received.size;
      queueResultRefresh();
    });
    if (!current()) return;
    if (received.size !== criterion.totalChecks) throw new Error('Some evaluation results were not received. Implement again to retry.');
    criterion.status = 'done';
    remaining -= 1;
    tick();
  } catch (error) {
    if (!current()) return;
    criterion.status = 'error';
    criterion.error = error.message;
    toast(error.message);
    tick(remaining);
  }
  refreshReport();
  refreshSampling();
}

function implementAll() {
  if (state.querying) { toast('Wait for the prompt responses to finish first'); return; }
  const targets = state.criteria.filter((c) => c.on && (c.status === 'draft' || c.status === 'error'));
  if (!implementing()) state.progress = { total: 0, done: 0 };
  state.progress.total += targets.length * 2;
  state.wizard.gradeFirst = false;
  const next = state.responses.findIndex((r) => r.grade === null);
  state.wizard.index = next === -1 ? 0 : next;
  state.wizard.navigation += 1;
  go('grade');
  targets.forEach(implement);
}

let reportSeq = 0;
let reportInputSignature = null;
async function refreshReport() {
  const done = state.criteria.filter((c) => c.on);
  const body = {
    results: done.map((c) => c.results || []),
    grades: state.responses.map((r) => r.grade),
    ffr_threshold: state.threshold,
    active: done.map((c) => c.keep),
  };
  const signature = JSON.stringify({ generation: state.datasetGeneration, ids: done.map((c) => c.id), ...body });
  if (signature !== reportInputSignature) {
    reportInputSignature = signature;
    state.report = null;
    state.reported = [];
    render();
  }
  const seq = ++reportSeq;
  const generation = state.datasetGeneration;
  if (!done.length || state.querying) {
    state.report = null;
    state.reported = [];
    render();
    return;
  }
  try {
    const report = await api('/api/report', body);
    if (seq !== reportSeq || generation !== state.datasetGeneration || state.querying) return;
    state.report = report;
    state.reported = done.map((c) => c.id);
    render();
  } catch (error) {
    if (seq !== reportSeq || generation !== state.datasetGeneration || state.querying) return;
    toast(error.message);
  }
}

function reportFor(criterion) {
  const index = state.reported.indexOf(criterion.id);
  return index === -1 || !state.report ? null : state.report.criteria[index];
}

function selectedCandidate(criterion, report = reportFor(criterion)) {
  const selected = report?.selected;
  if (!Number.isInteger(selected) || !criterion.results?.[selected]) return null;
  if (report.scores[selected]?.complete === false
    || criterion.results[selected].some((verdict) => verdict !== true && verdict !== false)
    || criterion.errors?.[selected]?.some(Boolean)) return null;
  return selected;
}

function selectionMessage(criterion, report = reportFor(criterion)) {
  if (criterion.status === 'draft') return 'Implement this criterion to select an evaluator.';
  if (!graded()) return 'Grade responses to select an implementation.';
  if (!report || !report.scores.length) return 'Waiting for completed evaluation results.';
  if (report.scores.every((score) => score.complete === false)) {
    return criterion.status === 'running'
      ? 'Waiting for a complete candidate. Results appear as each check finishes.'
      : 'No complete candidate is available. Review the errors below and implement again.';
  }
  if (!state.responses.some((r) => r.grade === true) || !state.responses.some((r) => r.grade === false)) {
    return 'Grade both good and bad responses to measure alignment.';
  }
  return 'No complete candidate meets the false failure threshold.';
}

// ---------- Local session export ----------

function captureSessionSnapshot() {
  const criteria = state.criteria.map((c) => {
    const changed = c.status !== 'draft' && ((c.built != null && c.built !== label(c))
      || (c.builtKind != null && c.builtKind !== c.kind)
      || (c.builtEvaluationMode != null && c.builtEvaluationMode !== (c.kind === 'python' ? 'source' : state.evaluationMode)));
    return {
      id: c.id, title: c.title, description: c.description, kind: c.kind,
      on: c.on, keep: c.keep, status: changed ? 'draft' : c.status,
      assertions: changed ? [] : c.assertions, results: changed ? null : c.results,
      errors: changed ? [] : c.errors, error: changed ? '' : c.error,
      model: c.model, modelKnown: c.modelKnown, built: c.built, builtKind: c.builtKind,
      evaluationMode: changed ? null : c.evaluationMode, builtEvaluationMode: changed ? null : c.builtEvaluationMode,
      completed: changed ? 0 : c.completed, totalChecks: changed ? 0 : c.totalChecks,
    };
  });
  return JSON.parse(JSON.stringify({
    prompt: state.prompt,
    outputFormat: state.outputFormat,
    evaluationMode: state.evaluationMode,
    responses: state.responses.map((r) => ({ text: r.text, grade: r.grade, feedback: r.feedback,
      explanation: r.explanation || null, explanationStatus: r.explanationStatus || 'unavailable',
      screenshot: r.screenshot || null, screenshotError: r.screenshotError || '' })),
    criteria, threshold: state.threshold, models: { ...state.models },
    defaultModel: state.defaultModel, sampleModel: state.sampleModel, sampleModelKnown: state.sampleModelKnown, sampledAt: state.sampledAt,
    sampling: null, nextHigh: state.wizard.nextHigh,
    report: null, reported: criteria.filter((c) => c.on).map((c) => c.id),
  }));
}

function downloadSessionFile(content, filename, mimeType) {
  const type = mimeType === 'application/zip' ? mimeType : `${mimeType};charset=utf-8`;
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function exportSession(kind) {
  if (!canExport() || !['json', 'html', 'zip'].includes(kind)) return;
  const snapshot = captureSessionSnapshot();
  const exportedAt = new Date().toISOString();
  state.exporting = kind;
  render();
  try {
    if (!window.EvalGenExport) throw new Error('Session export is unavailable. Reload the page and try again.');
    const enabled = snapshot.criteria.filter((c) => c.on);
    if (enabled.length) {
      const grades = snapshot.responses.map((r) => r.grade);
      [snapshot.report, snapshot.sampling] = await Promise.all([
        api('/api/report', {
          results: enabled.map((c) => c.results || []),
          grades, ffr_threshold: snapshot.threshold, active: enabled.map((c) => c.keep),
        }),
        api('/api/sampling', {
          results: enabled.filter((c) => c.keep && c.results)
            .map((c) => c.results.filter((_, candidate) => !c.errors?.[candidate]?.some(Boolean))),
          grades, next_high: snapshot.nextHigh,
        }),
      ]);
    }
    const session = window.EvalGenExport.buildSessionExport(snapshot, exportedAt);
    const json = `${JSON.stringify(session, null, 2)}\n`;
    const html = kind === 'json' ? null : window.EvalGenExport.renderSessionHtml(session);
    const content = kind === 'json' ? json : kind === 'html' ? html : createSessionZip(session, json, html);
    const stamp = exportedAt.slice(0, 19).replace(/[T:]/g, '-');
    downloadSessionFile(content, `evalgen-session-${stamp}.${kind}`, kind === 'json' ? 'application/json' : kind === 'zip' ? 'application/zip' : 'text/html');
    toast(kind === 'json' ? 'Session JSON downloaded.' : kind === 'zip' ? 'Session ZIP downloaded with the report and response artifacts.' : 'Report downloaded. Open the HTML file to read or print it.');
  } catch (error) {
    toast(`Could not export this session: ${error.message}`);
  } finally {
    state.exporting = null;
    render();
  }
}

function createSessionZip(session, json, html) {
  if (!window.EvalGenZip) throw new Error('ZIP export is unavailable. Reload the page and try again.');
  const entries = [
    { name: 'session.json', content: json },
    { name: 'report.html', content: html },
    { name: 'README.txt', content: 'EvalGen session archive\n\nOpen report.html to read or print the report. Import session.json in EvalGen to continue this session.\nResponse artifacts are in artifacts/; saved screenshots are in screenshots/.\nResponse artifacts contain the original generated source.\nAlignment and evaluator selection are recalculated when a session is imported.\n' },
  ];
  session.responses.forEach((response, index) => {
    const artifact = window.EvalGenArtifacts.extractArtifact(response.text, session.output_format);
    entries.push({ name: `artifacts/response-${index + 1}.${artifact ? artifact.format === 'svg' ? 'svg' : 'html' : 'txt'}`,
      content: artifact ? artifact.source : response.text });
    if (response.screenshot?.data_url) {
      const encoded = response.screenshot.data_url.split(',')[1];
      entries.push({ name: `screenshots/response-${index + 1}.png`, content: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)) });
    }
  });
  return window.EvalGenZip.createZip(entries);
}

function restoreImportedModelChoices() {
  if (!state.importedModelChoices || !state.catalogModels.length) return;
  for (const [role, id] of [['prompt', 'prompt-model'], ['evaluator', 'eval-model']]) {
    const select = $(id);
    const requested = state.importedModelChoices[role];
    if (Array.from(select.options).some((option) => option.value === requested)) select.value = requested;
    state.models[role] = select.value || null;
  }
  state.importedModelChoices = null;
  saveModels();
}

function applyImportedSession(snapshot) {
  state.criteria.forEach((criterion) => { criterion.runId = (criterion.runId || 0) + 1; });
  state.datasetGeneration += 1;
  reportSeq += 1;
  samplingSeq += 1;
  pendingAdvance = null;
  screenshotJob = null;
  clearTimeout(resultRefreshTimer);
  resultRefreshTimer = null;
  closeWizard();
  Object.assign(state, {
    prompt: snapshot.prompt, outputFormat: snapshot.outputFormat,
    evaluationMode: snapshot.evaluationMode, evaluationPreference: snapshot.evaluationMode,
    responses: snapshot.responses, criteria: snapshot.criteria, threshold: snapshot.threshold,
    sampleModel: snapshot.sampleModel, sampleModelKnown: snapshot.sampleModelKnown, sampledAt: snapshot.sampledAt,
    draft: '', report: null, reported: [], sampling: null, progress: { total: 0, done: 0 },
    importedModelChoices: { ...snapshot.models },
  });
  Object.assign(state.wizard, { index: 0, nextHigh: snapshot.nextHigh, gradeFirst: false,
    advancing: false, reached: new Set(['start']) });
  nextId = 1;
  while (state.criteria.some((criterion) => String(criterion.id) === String(nextId))) nextId += 1;
  $('prompt-status').textContent = '';
  $('prompt-status').classList.remove('error');
  $('prompt').value = snapshot.prompt;
  $('output-format').value = snapshot.outputFormat;
  $('num-responses').value = Math.max(1, snapshot.responses.length);
  const format = OUTPUT_FORMATS[snapshot.outputFormat];
  $('output-format-hint').textContent = format.hint || '';
  $('output-format-hint').hidden = !format.hint;
  $('format-example').hidden = !format.example;
  refreshEvaluatorModels();
  restoreImportedModelChoices();
  window.EvalGenArtifacts.clearViewers();
  render();
  refreshReport();
  refreshSampling();
}

async function importSessionFile(file) {
  if (!file || !canImport()) return;
  state.importing = true;
  render();
  try {
    if (!window.EvalGenImport) throw new Error('Session import is unavailable. Reload the page and try again.');
    if (file.size > window.EvalGenImport.MAX_FILE_BYTES) throw new Error('Import files must be 20 MiB or smaller.');
    const imported = window.EvalGenImport.parseSessionImport(await file.text());
    if (state.querying || state.suggesting || state.capturing || implementing() || state.exporting) throw new Error('Wait for the current operation to finish, then import again.');
    const { summary, warnings } = imported;
    const message = [
      `Replace the current session with ${summary.responseCount} responses, ${summary.criterionCount} criteria, and ${summary.candidateCount} candidate evaluators?`,
      `${summary.gradedCount} human-graded responses; ${summary.screenshotCount} saved screenshots; ${summary.explanationCount} provided explanations.`,
      'Existing session data will be replaced. Imported evaluator code is stored without running it. Alignment and sampling will be recalculated.',
      ...warnings,
    ].join('\n\n');
    if (!window.confirm(message)) return;
    applyImportedSession(imported.snapshot);
    toast('Session imported. Saved grades and evaluator checks are ready to review.');
  } catch (error) {
    toast(`Could not import this file: ${error.message}`);
  } finally {
    state.importing = false;
    $('import-session-file').value = '';
    render();
  }
}

function exportActions() {
  return el('div', { class: 'export-actions', 'aria-label': 'Export session' },
    el('button', {
      class: 'btn export-btn' + (state.exporting === 'json' ? ' busy' : ''), disabled: !canExport(),
      title: 'Download the complete session as JSON', onclick: () => exportSession('json'),
    }, 'Export JSON'),
    el('button', {
      class: 'btn export-btn' + (state.exporting === 'html' ? ' busy' : ''), disabled: !canExport(),
      title: 'Download a readable HTML report that you can open or print', onclick: () => exportSession('html'),
    }, 'Export report'),
    el('button', {
      class: 'btn export-btn' + (state.exporting === 'zip' ? ' busy' : ''), disabled: !canExport(),
      title: 'Download JSON, the report, and response artifacts together', onclick: () => exportSession('zip'),
    }, 'Export ZIP'),
  );
}

function renderExportControls() {
  [['export-json', 'json'], ['export-report', 'html'], ['export-zip', 'zip']].forEach(([id, kind]) => {
    const button = $(id);
    button.disabled = !canExport();
    button.classList.toggle('busy', state.exporting === kind);
    button.setAttribute('aria-busy', String(state.exporting === kind));
  });
  $('import-json').disabled = !canImport();
  $('import-json').classList.toggle('busy', state.importing);
  $('import-json').setAttribute('aria-busy', String(state.importing));
  $('import-session-file').disabled = !canImport();
}

// ---------- Canvas ----------

function renderPromptNode() {
  $('prompt-ok').hidden = !state.responses.length;
  $('btn-run').disabled = state.querying || state.suggesting || implementing();
  $('prompt-model').disabled = state.querying;
  $('output-format').disabled = state.querying;
  $('format-example').disabled = state.querying;
  // One evaluator model per run, so a criterion's assertions and verdicts come from the same model
  $('eval-model').disabled = state.querying || implementing() || state.suggesting;
}

function renderEvaluationControls() {
  $('evaluation-controls').hidden = state.outputFormat === 'text' || !state.responses.length;
  const select = $('evaluation-mode');
  const unavailable = screenshotUnavailableReason();
  const locked = state.querying || state.suggesting || state.capturing || implementing();
  select.value = state.evaluationMode;
  select.disabled = locked;
  select.querySelector('option[value="screenshot"]').disabled = Boolean(unavailable);
  const captured = state.responses.filter((r) => r.screenshot?.data_url).length;
  const errors = state.responses.filter((r) => r.screenshotError);
  const button = $('capture-screenshots');
  button.hidden = state.evaluationMode !== 'screenshot' || (!errors.length && captured === state.responses.length);
  button.disabled = locked || Boolean(unavailable);
  button.textContent = errors.length ? 'Retry screenshots' : state.capturing ? 'Capturing…' : 'Capture screenshots';
  button.classList.toggle('busy', state.capturing);
  const status = $('screenshot-status');
  status.classList.toggle('error', errors.length > 0 || (state.evaluationMode === 'screenshot' && Boolean(unavailable)));
  status.textContent = state.evaluationMode === 'source'
    ? unavailable || 'LLM and Code graders inspect source only. Choose Source + screenshot for visual grading.'
    : unavailable || (state.capturing ? `Capturing ${state.responses.length - captured} rendered preview${state.responses.length - captured === 1 ? '' : 's'}…`
      : errors.length ? `${errors.length} screenshot${errors.length === 1 ? '' : 's'} failed: ${errors[0].screenshotError}`
        : captured ? `${captured} screenshot${captured === 1 ? '' : 's'} ready. LLM graders use source + the captured image; Code graders use source.`
          : 'Screenshots are captured before visual grading. Capture now to inspect them. Code graders use source.');
}

function renderEvalNode() {
  const body = $('eval-body');
  const built = state.criteria.filter((c) => c.on && c.status !== 'draft');
  if (!built.length) {
    body.replaceChildren(el('div', { class: 'eval-empty' },
      el('button', {
        class: 'btn', disabled: state.querying || !state.responses.length,
        title: state.responses.length ? '' : 'Run the prompt node first',
        onclick: () => openWizard(state.criteria.length ? 'criteria' : 'start'),
      }, icon('sparkles'), 'Generate criteria'),
      el('p', { class: 'hint' }, state.responses.length
        ? 'Let an AI help you generate criteria and implement evaluation functions.'
        : 'Run the prompt node to get responses to evaluate.'),
    ));
    return;
  }
  const rows = built.map((c) => {
    const report = reportFor(c);
    const chosen = selectedCandidate(c, report);
    const alignment = chosen !== null ? report.scores[chosen].alignment : null;
    const busy = c.status === 'generating' || c.status === 'running';
    return el('div', { class: 'eval-row' },
      busy ? el('span', { class: 'spinner' }) : el('input', {
        type: 'checkbox', checked: c.keep, disabled: state.querying, title: 'Use in the table view',
        onchange: (e) => { c.keep = e.target.checked; refreshReport(); refreshSampling(); },
      }),
      el('span', { class: 'name', title: label(c) }, c.title),
      el('span', { class: 'kind' }, c.status === 'error' ? `${kindLabel(c)} error` : kindLabel(c)),
      el('span', { class: 'pct-pill', style: `background: ${toneFor(alignment)}` }, pct(alignment)),
    );
  });
  body.replaceChildren(
    el('div', { class: 'eval-list' }, rows),
    el('div', { class: 'eval-actions' },
      el('button', { class: 'btn', disabled: state.querying, onclick: () => openWizard('criteria') }, icon('pencil'), 'Edit criteria'),
      el('button', { class: 'btn primary', disabled: state.querying, onclick: () => openWizard(implementing() ? 'grade' : 'report') }, icon('sparkles'), 'Open EvalGen'),
    ),
  );
}

function verdictPill(verdict, reason = 'The grader gave no readable verdict') {
  if (verdict === true) return el('span', { class: 'verdict pass' }, 'pass');
  if (verdict === false) return el('span', { class: 'verdict fail' }, 'fail');
  return el('span', { class: 'verdict none', title: reason }, '?');
}

function gradeMark(grade) {
  if (grade === true) return el('span', { class: 'grade-mark good', title: 'Graded good' }, icon('up', 15));
  if (grade === false) return el('span', { class: 'grade-mark bad', title: 'Graded bad' }, icon('down', 15));
  return el('span', { class: 'grade-mark none', title: 'Ungraded' }, '-');
}

function responseContent(response, index, compact = false) {
  const viewer = window.EvalGenArtifacts.createViewer(response.text, {
    format: state.outputFormat, compact,
    screenshot: response.screenshot,
    key: `${state.datasetGeneration}-${compact ? 'table' : 'grade'}-${index}`,
  });
  const provided = response.explanationStatus === 'provided' && typeof response.explanation === 'string'
    && response.explanation.trim().length > 0;
  return el('div', { class: 'response-content' }, viewer,
    el('details', { class: 'model-explanation' + (provided ? '' : ' unavailable') },
      el('summary', {}, 'Model rationale'),
      el('p', {}, provided ? response.explanation : 'No rationale was included for this output.'),
    ));
}

let tableSignature = null;
let tableResponses = null;
function renderTable() {
  const body = $('table-body');
  state.responses.forEach((response, index) => window.EvalGenArtifacts.updateScreenshot(
    `${state.datasetGeneration}-table-${index}`, response.screenshot));
  const columns = state.criteria.filter((c) => c.on && c.keep && c.status !== 'draft');
  // Leave previews mounted while unrelated progress updates arrive. Removing an
  // iframe resets its document, including any interaction the user is reviewing.
  const signature = JSON.stringify({
    generation: state.datasetGeneration, format: state.outputFormat,
    responses: state.responses.map((r) => [r.text, r.grade]),
    columns: columns.map((c) => [c.id, c.title, c.description, c.status, c.error, c.results, c.errors, reportFor(c)]),
  });
  if (signature === tableSignature && tableResponses === state.responses) return;
  tableSignature = signature;
  const formatLabel = state.outputFormat === 'text' ? '' : ` · ${OUTPUT_FORMATS[state.outputFormat].label}`;
  $('table-meta').textContent = state.responses.length ? `${state.responses.length} responses, ${graded()} graded${formatLabel}` : '';
  if (!state.responses.length) {
    body.replaceChildren(el('p', { class: 'hint' }, 'Responses and evaluation results appear here.'));
    return;
  }
  const head = el('tr', {},
    el('th', {}, '#'), el('th', {}, 'Response'), el('th', { class: 'center' }, 'Grade'),
    columns.map((c) => {
      const report = reportFor(c);
      const chosen = selectedCandidate(c, report);
      return el('th', { class: 'crit center', title: chosen === null ? selectionMessage(c, report) : label(c) }, c.title);
    }),
  );
  const resultCells = (r, i) => [
    el('td', { class: 'center' }, gradeMark(r.grade)),
    columns.map((c) => {
      if (c.status === 'generating') return el('td', { class: 'center' }, el('span', { class: 'spinner' }));
      const report = reportFor(c);
      const chosen = selectedCandidate(c, report);
      return el('td', { class: 'center' }, chosen === null
        ? verdictPill(null, c.error || selectionMessage(c, report))
        : verdictPill(c.results[chosen][i], c.errors?.[chosen]?.[i]));
    }),
  ];
  const mountedRows = body.querySelectorAll('tbody > tr');
  if (tableResponses === state.responses && mountedRows.length === state.responses.length) {
    body.querySelector('thead').replaceChildren(head);
    mountedRows.forEach((row, i) => {
      while (row.children.length > 2) row.lastElementChild.remove();
      row.append(...resultCells(state.responses[i], i).flat());
    });
    return;
  }
  const rows = state.responses.map((r, i) => el('tr', {},
    el('td', {}, String(i + 1)),
    el('td', { class: 'response' + (window.EvalGenArtifacts.extractArtifact(r.text, state.outputFormat) ? ' has-artifact' : '') }, responseContent(r, i, true)),
    resultCells(r, i),
  ));
  body.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, rows))));
  tableResponses = state.responses;
}

// ---------- Wizard ----------

const STEPS = [['start', 'Start'], ['criteria', 'Criteria'], ['grade', 'Grade'], ['report', 'Report card']];
let wizardSession = null;

function openWizard(screen) {
  const modal = $('wizard');
  const dialog = modal.querySelector('.dialog');
  if (!state.wizard.open) {
    const trigger = document.activeElement;
    const scroll = { x: window.scrollX, y: window.scrollY };
    const bodyStyle = {};
    ['overflow', 'position', 'top', 'left', 'width'].forEach((name) => { bodyStyle[name] = document.body.style[name]; });
    const htmlOverflow = document.documentElement.style.overflow;
    const background = Array.from(document.body.children)
      .filter((node) => node !== modal && !node.contains(modal) && node.id !== 'toast')
      .map((node) => ({ node, inert: node.inert }));
    background.forEach(({ node }) => { node.inert = true; });
    Object.assign(document.body.style, {
      overflow: 'hidden', position: 'fixed', top: `${-scroll.y}px`, left: '0', width: '100%',
    });
    document.documentElement.style.overflow = 'hidden';
    dialog.tabIndex = -1;
    const focusable = () => Array.from(dialog.querySelectorAll(
      'a[href], button, input, textarea, select, summary, iframe, [tabindex], [contenteditable="true"]',
    )).filter((node) => node.tabIndex >= 0 && !node.matches(':disabled')
      && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] || dialog).focus({ preventScroll: true });
    const keydown = (event) => {
      if (!state.wizard.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeWizard();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0];
      const last = controls[controls.length - 1];
      const outside = !dialog.contains(document.activeElement) || document.activeElement === dialog;
      if (!controls.length || (event.shiftKey && (document.activeElement === first || outside))) {
        event.preventDefault();
        (last || dialog).focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || outside)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const focusin = (event) => {
      if (state.wizard.open && !dialog.contains(event.target)) focusFirst();
    };
    let backdropDown = false;
    let backdropUp = false;
    const pointerdown = (event) => { backdropDown = event.target === modal && event.button === 0; backdropUp = false; };
    const pointerup = (event) => { backdropUp = backdropDown && event.target === modal; };
    const pointercancel = () => { backdropDown = false; backdropUp = false; };
    const click = (event) => {
      if (event.target !== modal) return;
      // Ignore a selection/drag that started in the dialog and ended outside it.
      event.stopImmediatePropagation();
      const dismiss = backdropDown && backdropUp;
      pointercancel();
      if (dismiss) closeWizard();
    };
    wizardSession = {
      trigger, triggerId: trigger?.id, triggerText: trigger?.textContent?.trim(),
      triggerRegion: trigger?.closest?.('#eval-node') ? '#eval-node' : '#prompt-node',
      scroll, bodyStyle, htmlOverflow, background, keydown, focusin, pointerdown, pointerup, pointercancel, click,
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin, true);
    modal.addEventListener('pointerdown', pointerdown);
    modal.addEventListener('pointerup', pointerup);
    modal.addEventListener('pointercancel', pointercancel);
    modal.addEventListener('click', click, true);
  }
  state.wizard.open = true;
  modal.hidden = false;
  go(screen);
}

function closeWizard() {
  state.wizard.navigation += 1;
  state.wizard.advancing = false;
  pendingAdvance = null;
  state.wizard.open = false;
  const modal = $('wizard');
  modal.hidden = true;
  const session = wizardSession;
  wizardSession = null;
  if (session) {
    document.removeEventListener('keydown', session.keydown, true);
    document.removeEventListener('focusin', session.focusin, true);
    ['pointerdown', 'pointerup', 'pointercancel'].forEach((type) => modal.removeEventListener(type, session[type]));
    modal.removeEventListener('click', session.click, true);
    session.background.forEach(({ node, inert }) => { node.inert = inert; });
    Object.assign(document.body.style, session.bodyStyle);
    document.documentElement.style.overflow = session.htmlOverflow;
    window.scrollTo(session.scroll.x, session.scroll.y);
  }
  render();
  if (session) {
    const controls = Array.from(document.querySelectorAll(`${session.triggerRegion} button:not(:disabled)`));
    const original = session.trigger?.isConnected && !session.trigger.disabled ? session.trigger : null;
    const target = original || (session.triggerId && $(session.triggerId))
      || controls.find((node) => node.textContent.trim() === session.triggerText) || controls[0]
      || (!$('btn-run').disabled && $('btn-run')) || document.querySelector('.brand');
    target?.focus({ preventScroll: true });
  }
}

function go(screen) {
  state.wizard.navigation += 1;
  state.wizard.advancing = false;
  pendingAdvance = null;
  state.wizard.screen = screen;
  state.wizard.reached.add(screen);
  if (screen === 'report' || screen === 'criteria') state.wizard.reached.add('grade');
  render();
  const body = $('wizard-body');
  body.scrollTop = 0;
  if (state.wizard.open) {
    const first = body.querySelector('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
    (first || $('wizard-close')).focus({ preventScroll: true });
  }
}

function screenStart() {
  const ready = state.responses.length > 0 && !state.querying;
  const option = (cls, iconName, text, onclick, tip) => el('button', { class: `option ${cls}`, disabled: !ready, onclick },
    icon(iconName, 22), el('span', {}, text), tip ? el('span', { class: 'tip' }, tip) : null);
  return [
    el('p', { class: 'intro' },
      'EvalGen suggests evaluation criteria for your prompt, writes candidate assertions that implement each one, ',
      'and keeps the assertions that agree with how you grade a few responses.'),
    el('div', { class: 'options' },
      option('infer', 'sparkles', 'Infer criteria from my context', () => { go('criteria'); suggest(); }),
      option('manual', 'pencil', 'Let me specify criteria manually', () => go('criteria')),
      option('first', 'up', 'Grade some responses first', () => {
        state.wizard.gradeFirst = true;
        state.wizard.index = 0;
        go('grade');
      }, 'Grade some responses first, to help yourself identify criteria. The AI will incorporate your grades in its criteria suggestions.'),
    ),
  ];
}

function criterionCard(c) {
  const locked = state.querying || c.status === 'generating' || c.status === 'running';
  // Text is stored on every keystroke so background re-renders keep it
  const type = (field) => (e) => { c[field] = e.target.value; };
  const commit = (field) => (e) => {
    c[field] = e.target.value.trim() || (field === 'title' ? 'Untitled' : '');
    if (c.status !== 'draft' && label(c) !== c.built) invalidateCriterion(c);
    refreshReport();
    refreshSampling();
  };
  const setKind = (kind) => {
    if (c.kind === kind) return;
    c.kind = kind;
    invalidateCriterion(c);
    refreshReport();
    refreshSampling();
    render();
  };
  const statusNote = {
    done: el('span', { class: 'hint' }, 'Implemented'),
    error: el('span', { class: 'hint', style: 'color: var(--red)' }, 'Failed, implement again'),
    generating: el('span', { class: 'hint' }, 'Implementing...'),
    running: el('span', { class: 'hint' }, 'Implementing...'),
  }[c.status];
  return el('div', { class: 'card' + (c.on ? '' : ' off') },
    el('div', { class: 'card-head' },
      el('input', { type: 'checkbox', checked: c.on, disabled: locked, onchange: (e) => { c.on = e.target.checked; refreshReport(); refreshSampling(); } }),
      el('input', { class: 'card-title', type: 'text', value: c.title, disabled: locked, 'data-key': `title-${c.id}`, oninput: type('title'), onchange: commit('title') }),
      el('button', {
        class: 'icon-btn', title: 'Delete', disabled: locked,
        onclick: () => { state.criteria = state.criteria.filter((x) => x !== c); refreshReport(); refreshSampling(); },
      }, icon('trash')),
    ),
    el('textarea', {
      class: 'card-desc', rows: 2, value: c.description, disabled: locked, placeholder: 'Describe the criterion',
      'data-key': `desc-${c.id}`, oninput: type('description'), onchange: commit('description'),
    }),
    el('div', { class: 'card-foot', style: 'justify-content: space-between; align-items: center' },
      statusNote || el('span'),
      el('div', { class: 'seg' },
        el('button', {
          class: 'seg-btn' + (c.kind === 'python' ? ' active' : ''), disabled: locked || !state.pythonSandbox.available,
          title: state.pythonSandbox.available ? 'Evaluate this criterion with Python code' : state.pythonSandbox.reason || 'Python evaluation is unavailable.',
          'aria-pressed': String(c.kind === 'python'), onclick: () => setKind('python'),
        }, icon('code', 13), 'Code'),
        el('button', {
          class: 'seg-btn' + (c.kind === 'llm' ? ' active' : ''), disabled: locked,
          'aria-pressed': String(c.kind === 'llm'), onclick: () => setKind('llm'),
        }, icon('bot', 13), 'LLM'),
      ),
    ),
  );
}

function screenCriteria() {
  const input = el('input', {
    type: 'text', placeholder: state.outputFormat === 'svg' ? 'the logo is legible at small sizes'
      : state.outputFormat === 'html' ? 'the page includes a working mobile menu' : 'the response is valid JSON',
    'data-key': 'new-criterion', value: state.draft,
    disabled: state.querying,
    oninput: (e) => { state.draft = e.target.value; },
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !state.draft.trim()) return;
      addCriterion(state.draft.trim());
      state.draft = '';
      render();
    },
  });
  const cards = state.criteria.map(criterionCard);
  if (state.suggesting) cards.push(el('div', { class: 'card skeleton' }), el('div', { class: 'card skeleton' }));
  const pending = state.criteria.some((c) => c.on && (c.status === 'draft' || c.status === 'error'));
  return [
    el('div', { class: 'add-bar' },
      el('label', {}, 'Type a new criteria to add, then press Enter:', input),
      el('button', { class: 'btn blue' + (state.suggesting ? ' busy' : ''), disabled: state.querying || state.suggesting, onclick: suggest },
        state.suggesting ? null : icon('repeat'), state.suggesting ? null : icon('sparkles'), 'Suggest more'),
    ),
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'hint', style: 'text-align: center' }, 'No criteria yet. Type one above or ask for suggestions.'),
    el('div', { class: 'center-row' },
      el('button', {
        class: 'btn implement', disabled: state.querying || !state.criteria.some((c) => c.on),
        onclick: () => (pending ? implementAll() : go(implementing() ? 'grade' : 'report')),
      }, icon('sparkles'), pending ? "I'm done. Implement it!" : 'Continue'),
    ),
  ];
}

function setGrade(value) {
  if (state.querying) return;
  const w = state.wizard;
  const index = w.index;
  const r = state.responses[index];
  const wasUngraded = r.grade === null;
  r.grade = r.grade === value ? null : value;
  w.navigation += 1;
  pendingAdvance = null;
  w.advancing = wasUngraded && r.grade !== null;
  refreshReport();
  refreshSampling(w.advancing ? { index, response: r, navigation: w.navigation } : null);
  render();
}

function screenGrade(preservePreview = false) {
  const n = state.responses.length;
  const w = state.wizard;
  const r = state.responses[w.index];
  const move = (delta) => { w.navigation += 1; w.advancing = false; pendingAdvance = null; w.index = (w.index + delta + n) % n; render(); };
  const need = Math.min(GRADE_FIRST_MIN, n);
  const count = graded();
  const finishedChecks = state.criteria.reduce((sum, c) => sum + c.completed, 0);
  const totalChecks = state.criteria.reduce((sum, c) => sum + c.totalChecks, 0);
  const artifact = window.EvalGenArtifacts.extractArtifact(r.text, state.outputFormat);

  let footer;
  if (w.gradeFirst) {
    footer = [
      el('div', { class: 'progress-wrap' },
        el('span', {}, `Grade at least ${need} responses (${Math.min(count, need)} of ${need})`),
        el('div', { class: 'progress' }, el('div', { class: 'progress-fill', style: `width: ${(100 * Math.min(count, need)) / need}%` }))),
      el('button', {
        class: 'btn primary', disabled: count < need,
        onclick: () => { w.gradeFirst = false; go('criteria'); if (!state.criteria.length) suggest(); },
      }, 'Continue'),
    ];
  } else {
    const { total, done } = state.progress;
    const busy = implementing();
    footer = [
      el('div', { class: 'progress-wrap' },
        el('span', {}, busy
          ? totalChecks ? `Evaluating candidates: ${finishedChecks} of ${totalChecks} checks finished.` : 'Generating candidate implementations...'
          : 'Implementations ready. Keep grading, or finish when you like.'),
        el('div', { class: 'progress' }, el('div', { class: 'progress-fill', style: `width: ${total ? (100 * done) / total : 100}%` }))),
      el('button', { class: 'btn outline', onclick: () => go('report') }, "I'm tired"),
    ];
  }

  return [
    el('div', { class: 'screen-title' }, 'Is this response', icon('up', 20), 'or', icon('down', 20), '?'),
    el('div', { class: 'grade-row', 'data-response-key': `${state.datasetGeneration}-${state.sampledAt}-${w.index}` },
      el('button', { class: 'nav-btn', title: 'Previous', disabled: n < 2, onclick: () => move(-1) }, icon('left', 22)),
      el('div', { class: 'response-box' + (artifact ? ' has-artifact' : '')
        + (r.grade === true ? ' good' : r.grade === false ? ' bad' : '') }, preservePreview ? null : responseContent(r, w.index)),
      el('button', { class: 'nav-btn', title: 'Next', disabled: n < 2, onclick: () => move(1) }, icon('right', 22)),
    ),
    el('div', { class: 'response-count' }, `Response ${w.index + 1} of ${n} · ${count} graded`),
    artifact ? el('p', { class: 'sampling-note' }, state.evaluationMode === 'screenshot'
      ? 'LLM graders inspect the source and a screenshot of the initial render. Use the Screenshot tab to see the exact image; live preview interactions are not captured.'
      : 'Grade the preview and source. Automated graders inspect the source; choose Source + screenshot for visual grading.') : null,
    el('p', { class: 'sampling-note' }, 'As checks finish, the next responses alternate between likely problems and likely passes. Use the arrows to review any response.'),
    el('div', { class: 'context' },
      el('div', { class: 'panel' },
        el('div', { class: 'panel-title' }, 'Feedback'),
        el('textarea', {
          value: r.feedback, 'data-key': `feedback-${w.index}`,
          placeholder: 'Optional: what is wrong with this response? Used when suggesting criteria.',
          oninput: (e) => { r.feedback = e.target.value; },
        }),
      ),
      el('div', { class: 'panel flat' },
        el('div', { class: 'panel-title' }, 'Prompt'),
        el('pre', {}, state.prompt),
      ),
    ),
    el('div', { class: 'grade-footer' },
      el('div', { class: 'center-row' },
        el('button', { class: 'btn bad' + (r.grade === false ? ' active' : ''), disabled: state.querying || w.advancing, onclick: () => setGrade(false) }, icon('down'), 'Bad!'),
        el('button', { class: 'btn good' + (r.grade === true ? ' active' : ''), disabled: state.querying || w.advancing, onclick: () => setGrade(true) }, icon('up'), 'Good!'),
      ),
      el('div', { class: 'grade-foot' }, footer),
    ),
  ].filter((child) => child !== null && child !== undefined && child !== false);
}

function donut(score) {
  const value = score ? score.alignment : null;
  const tone = toneFor(value);
  const arc = value === null ? 0 : Math.max(value * 100, 0.01);
  const svg = `<svg viewBox="0 0 36 36" width="100%" height="100%"><circle cx="18" cy="18" r="15.9155" fill="none" stroke="var(--surface1)" stroke-width="3.6"/><circle cx="18" cy="18" r="15.9155" fill="none" stroke="${tone}" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="${arc} 100"/></svg>`;
  const ring = el('div', { class: 'donut' }, el('span', { class: 'donut-label', style: `color: ${tone}` }, pct(value)));
  ring.insertAdjacentHTML('afterbegin', svg);

  const children = [ring, el('div', { class: 'donut-caption' }, 'Alignment with your grades')];
  if (score) {
    const m = score.confusion;
    const most = Math.max(1, m.bad_failed, m.bad_passed, m.good_failed, m.good_passed);
    const cell = (count, right) => el('div', {
      class: 'cell',
      style: `background: color-mix(in srgb, var(${right ? '--blue' : '--red'}) ${20 + Math.round((60 * count) / most)}%, var(--surface0))`,
    }, String(count));
    children.push(el('div', { class: 'confusion' },
      el('span', { class: 'axis' }, 'Human fail'), cell(m.bad_failed, true), cell(m.bad_passed, false),
      el('span', { class: 'axis' }, 'Human pass'), cell(m.good_failed, false), cell(m.good_passed, true),
      el('span'), el('span', { class: 'axis col' }, 'Pred. fail'), el('span', { class: 'axis col' }, 'Pred. pass'),
    ));
  }
  return el('div', { class: 'donut-wrap' }, children);
}

function reportCard(c) {
  const head = el('div', { class: 'card-head' },
    el('input', {
      type: 'checkbox', checked: c.keep, disabled: state.querying, title: 'Keep this criterion in the evaluator',
      onchange: (e) => { c.keep = e.target.checked; refreshReport(); refreshSampling(); },
    }),
    el('span', { class: 'card-title', style: 'border: 0' }, c.title),
  );
  if (c.status === 'draft') {
    return el('div', { class: 'card' }, head,
      el('p', { class: 'hint' }, 'This criterion needs implementation. Return to Criteria to implement it.'));
  }
  if (c.status === 'generating') {
    return el('div', { class: 'card' }, head, el('div', { class: 'pending' }, el('span', { class: 'spinner' }), 'Writing candidate assertions...'));
  }
  if (c.status === 'error' && !c.assertions.length) {
    return el('div', { class: 'card' }, head, el('div', { class: 'evaluation-error', role: 'status' }, c.error));
  }
  const report = reportFor(c);
  const chosen = selectedCandidate(c, report);
  const others = c.assertions.map((text, i) => ({ text, i })).filter(({ i }) => i !== chosen);
  const failedCandidates = c.errors.filter((row) => row.some(Boolean)).length;
  return el('div', { class: 'card' + (c.keep ? '' : ' off') },
    head,
    c.status === 'running' ? el('p', { class: 'candidate-status', role: 'status' },
      el('span', { class: 'spinner' }), `${c.completed} of ${c.totalChecks} checks finished`) : null,
    c.error ? el('p', { class: 'evaluation-error', role: 'status' }, c.error) : null,
    failedCandidates ? el('p', { class: 'evaluation-error' },
      `${failedCandidates} candidate${failedCandidates === 1 ? ' is' : 's are'} unavailable because a check failed to run. Details below.`) : null,
    el('div', { class: 'rcard-body' },
      el('div', { class: 'rcard-text' },
        c.description ? el('span', { class: 'rcard-desc' }, c.description) : null,
        el('span', { class: 'rcard-kind' }, `${kindLabel(c)} · ${c.evaluationMode === 'screenshot' ? 'source + screenshot · ' : ''}${c.modelKnown === false ? 'Unknown generation model' : c.model || 'default'}`),
        chosen !== null
          ? el('pre', { class: 'chosen' }, c.assertions[chosen])
          : el('span', { class: 'hint' }, selectionMessage(c, report)),
      ),
      donut(chosen !== null ? report.scores[chosen] : null),
    ),
    others.length ? el('details', { class: 'bad-impls', open: chosen === null && failedCandidates > 0 },
      el('summary', {}, chosen === null ? 'Show candidate implementations' : 'Show other implementations', icon('chevron')),
      el('ul', {}, others.map(({ text, i }) => {
        const score = report ? report.scores[i] : null;
        const issues = new Map();
        (c.errors[i] || []).forEach((error, output) => {
          if (!error) return;
          if (!issues.has(error)) issues.set(error, []);
          issues.get(error).push(output + 1);
        });
        const unknown = score?.unknown_count ?? (c.results?.[i] || []).filter((value) => value === null).length;
        const complete = score?.complete !== false && unknown === 0;
        const status = complete ? 'Complete' : unknown ? `${unknown} unresolved` : 'Unavailable';
        return el('li', {},
          el('b', {}, `Candidate ${i + 1} · ${status} · alignment ${pct(complete ? score?.alignment : null)} · FFR ${pct(complete ? score?.ffr : null)}`),
          el('pre', { class: 'candidate-source' }, text),
          Array.from(issues, ([error, outputs]) => el('p', { class: 'evaluation-error' },
            `Response${outputs.length === 1 ? '' : 's'} ${outputs.join(', ')}: ${error}`)),
        );
      })),
    ) : null,
  );
}

function screenReport() {
  const report = state.report;
  const complete = report?.selection_complete && report.active_count > 0 && report.selected_count > 0;
  const overall = complete ? report.overall : null;
  const built = state.criteria.filter((c) => c.on);
  return [
    el('div', { class: 'screen-title' }, 'Chosen Functions and Alignment'),
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'Coverage of Bad Responses'), el('div', { class: 'tile-value blue' }, pct(overall && overall.coverage))),
      el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'False Failure Rate'), el('div', { class: 'tile-value red' }, pct(overall && overall.ffr))),
    ),
    el('p', { class: 'selection-status', role: 'status' }, !report || !report.active_count
      ? 'No active assertion set is available. Implement and keep at least one criterion to see overall metrics.'
      : `${report.selected_count} of ${report.active_count} active criteria selected.${complete ? '' : ' Overall metrics are unavailable until every active criterion has a complete, eligible implementation.'}`),
    el('div', { class: 'threshold' },
      el('label', { for: 'ffr' }, 'Max false failure rate per assertion'),
      el('input', {
        type: 'range', id: 'ffr', min: 0, max: 1, step: 0.05, value: state.threshold, 'data-key': 'ffr',
        oninput: (e) => {
          state.threshold = Number(e.target.value);
          e.target.nextSibling.textContent = pct(state.threshold);
          invalidateReport();
          queueResultRefresh();
        },
        onchange: refreshReport,
      }),
      el('span', { class: 'threshold-value' }, pct(state.threshold)),
    ),
    built.length
      ? el('div', { class: 'cards' }, built.map(reportCard))
      : el('p', { class: 'hint', style: 'text-align: center' }, 'No criteria implemented yet.'),
    el('div', { class: 'center-row' },
      el('button', { class: 'btn', onclick: () => go('grade') }, 'Back to grading'),
      exportActions(),
      el('button', { class: 'btn primary', onclick: closeWizard }, 'Done'),
    ),
  ];
}

function renderWizard() {
  const steps = $('wizard-steps');
  steps.replaceChildren(...STEPS.map(([key, text]) => el('button', {
    class: 'step' + (state.wizard.screen === key ? ' active' : ''),
    disabled: !state.wizard.reached.has(key) || (key === 'grade' && !state.responses.length),
    onclick: () => go(key),
  }, text)));
  const screens = { start: screenStart, criteria: screenCriteria, grade: screenGrade, report: screenReport };

  // Background progress re-renders the screen, so keep focus and caret where the user was typing
  const active = document.activeElement;
  const key = active && active.dataset ? active.dataset.key : null;
  const caret = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const body = $('wizard-body');
  const mountedRow = body.querySelector('.grade-row');
  // Keep the active preview in place across grading/progress updates. Building a
  // second viewer would move it out of the mounted row and reset its iframe.
  const sameResponse = state.wizard.screen === 'grade' && mountedRow
    && mountedRow.dataset.responseKey === `${state.datasetGeneration}-${state.sampledAt}-${state.wizard.index}`;
  if (sameResponse) {
    const r = state.responses[state.wizard.index];
    window.EvalGenArtifacts.updateScreenshot(`${state.datasetGeneration}-grade-${state.wizard.index}`, r.screenshot);
    const box = mountedRow.querySelector('.response-box');
    box.classList.toggle('good', r.grade === true);
    box.classList.toggle('bad', r.grade === false);
    const children = screenGrade(true);
    const nextRow = children.find((node) => node?.classList?.contains('grade-row'));
    const rowIndex = children.indexOf(nextRow);
    while (mountedRow.previousSibling) mountedRow.previousSibling.remove();
    while (mountedRow.nextSibling) mountedRow.nextSibling.remove();
    mountedRow.before(...children.slice(0, rowIndex));
    mountedRow.after(...children.slice(rowIndex + 1));
  } else {
    body.replaceChildren(...screens[state.wizard.screen]());
  }
  if (key) {
    const again = $('wizard-body').querySelector(`[data-key="${key}"]`);
    if (again) {
      again.focus();
      if (caret && again.setSelectionRange) {
        try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* range inputs have no caret */ }
      }
    }
  }
}

function render() {
  renderPromptNode();
  renderEvaluationControls();
  renderEvalNode();
  renderTable();
  renderExportControls();
  if (state.wizard.open) renderWizard();
}

// ---------- Events ----------

$('btn-run').addEventListener('click', runPrompt);
$('evaluation-mode').addEventListener('change', (event) => setEvaluationMode(event.target.value));
$('capture-screenshots').addEventListener('click', captureScreenshots);
$('output-format').addEventListener('change', () => {
  const format = OUTPUT_FORMATS[$('output-format').value];
  $('output-format-hint').textContent = format.hint || '';
  $('output-format-hint').hidden = !format.hint;
  $('format-example').hidden = !format.example;
});
$('format-example').addEventListener('click', () => {
  $('prompt').value = OUTPUT_FORMATS[$('output-format').value].example;
  $('prompt').focus();
});
$('export-json').addEventListener('click', () => exportSession('json'));
$('export-report').addEventListener('click', () => exportSession('html'));
$('export-zip').addEventListener('click', () => exportSession('zip'));
$('import-json').addEventListener('click', () => { if (canImport()) $('import-session-file').click(); });
$('import-session-file').addEventListener('change', (event) => importSessionFile(event.target.files[0]));
$('wizard-close').addEventListener('click', closeWizard);
$('wizard').addEventListener('click', (e) => { if (e.target === $('wizard')) closeWizard(); });
document.addEventListener('keydown', (e) => {
  if (!state.wizard.open) return;
  if (e.key === 'Escape') { closeWizard(); return; }
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (state.wizard.screen !== 'grade' || typing || !state.responses.length) return;
  const n = state.responses.length;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    state.wizard.navigation += 1;
    state.wizard.advancing = false;
    pendingAdvance = null;
    state.wizard.index = (state.wizard.index + (e.key === 'ArrowLeft' ? -1 : 1) + n) % n;
    render();
  }
});

// ---------- Appearance menu ----------

function syncAppearance() {
  const current = window.appearance.load();
  document.querySelectorAll('#palette-row .swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === current.theme));
  document.querySelectorAll('.settings-menu .seg').forEach((seg) => {
    seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === current[seg.dataset.group]));
  });
}

Object.keys(THEMES).forEach((name) => {
  $('palette-row').append(el('button', {
    class: 'swatch', title: name, 'data-theme': name,
    style: `background: linear-gradient(135deg, ${THEMES[name].light.primary} 50%, ${THEMES[name].dark.primary} 50%)`,
    onclick: () => { window.appearance.update('theme', name); syncAppearance(); },
  }));
});
document.querySelectorAll('.settings-menu .seg').forEach((seg) => {
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    window.appearance.update(seg.dataset.group, b.dataset.value);
    syncAppearance();
  }));
});
document.addEventListener('click', (e) => {
  const menu = $('settings-menu');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});

// ---------- Boot ----------

const MODELS_KEY = 'evalgen-models';

// Query shortlist reviewed against the gateway catalog on 2026-11-05.
const QUERY_MODELS = [
  { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra · Balanced' },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon · Reasoning' },
  { id: 'mistral/mistral-large-4', label: 'Mistral Large 4 · Open weights' },
  { id: 'inception/mercury-3', label: 'Mercury 3 · Fast, low cost' },
];

function fillModels(models, fallback, visionModels = []) {
  state.catalogModels = models.includes(fallback) ? models : [fallback, ...models];
  state.visionModels = visionModels.filter((id) => state.catalogModels.includes(id));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MODELS_KEY)) || {}; } catch (e) { /* storage blocked */ }
  const queryOptions = QUERY_MODELS.filter(({ id }) => models.includes(id));
  const serverOptions = (models.includes(fallback) ? models : [fallback, ...models])
    .map((id) => ({ id, label: id }));
  [['prompt', 'prompt-model'], ['evaluator', 'eval-model']].forEach(([role, id]) => {
    const select = $(id);
    const options = role === 'prompt' && queryOptions.length ? queryOptions : serverOptions;
    const names = options.map((option) => option.id);
    const defaultModel = role === 'prompt' ? names[0] : fallback;
    select.replaceChildren(...options.map((option) => el('option', { value: option.id }, option.label)));
    select.value = names.includes(saved[role]) ? saved[role] : defaultModel;
    state.models[role] = select.value;
    select.addEventListener('change', () => {
      state.models[role] = select.value;
      saveModels();
    });
  });
  // A late catalog response must not change the input mode of work already built.
  if (!state.importedModelChoices && !state.suggesting && state.criteria.every((c) => c.status === 'draft')) applyEvaluationDefault();
  refreshEvaluatorModels();
  restoreImportedModelChoices();
  render();
}

(async function boot() {
  const bootGeneration = state.datasetGeneration;
  syncAppearance();
  render();
  try {
    const info = await api('/api/info');
    state.defaultModel = info.model;
    if (state.datasetGeneration === bootGeneration) state.threshold = info.ffr_threshold;
    state.pythonSandbox = info.python_sandbox || { available: false, reason: 'This server does not provide Python evaluation.' };
    state.screenshotRenderer = info.screenshot_renderer || { available: false, reason: 'This server does not provide screenshot capture.' };
    render();
    try {
      const { models, default: fallback, vision_models: visionModels } = await api('/api/models');
      fillModels(models, fallback, visionModels || []);
    } catch (error) {
      fillModels([], info.model);
      toast(`Could not list models, using ${info.model}: ${error.message}`);
    }
  } catch (error) {
    toast(error.message);
  }
})();
