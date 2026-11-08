const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createSessionExport } = require('../src/evalgen/web/export.js');
const { parseSessionImport, MAX_FILE_BYTES, MAX_RESPONSES } = require('../src/evalgen/web/import.js');

const exportedAt = '2026-11-07T18:00:00.000Z';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUdoAAAAASUVORK5CYII=';

function fixture() {
  return {
    prompt: 'Write a helpful response.\nKeep the exact source: 研究 🧪.',
    outputFormat: 'text', evaluationMode: 'source',
    responses: [
      { text: 'Hello 🌧️', grade: true, feedback: 'Helpful.', explanation: 'I chose a friendly greeting.', explanationStatus: 'provided' },
      { text: 'Go away.', grade: false, feedback: 'Too rude.', explanation: null, explanationStatus: 'unavailable' },
      { text: 'Not reviewed yet.', grade: null, feedback: '', explanation: '0', explanationStatus: 'provided' },
    ],
    criteria: [
      { id: 7, title: 'Polite', description: 'Use a friendly tone.', kind: 'llm',
        on: true, keep: true, status: 'done', model: 'judge/used', evaluationMode: 'source',
        assertions: ['Return true for a polite greeting.', 'An alternative grading prompt.'],
        results: [[true, null, false], [true, false, true]],
        errors: [[null, 'Timed out', null], [null, null, null]], error: '' },
      { id: 'code-check', title: 'Short', description: 'At most 20 words.', kind: 'python',
        on: false, keep: true, status: 'done', model: null, modelKnown: false,
        assertions: ['def evaluate(response, prompt):\n    return len(response.split()) <= 20'],
        results: [[true, true, true]], errors: [[null, null, null]], error: '' },
      { id: 9, title: 'Excluded draft', description: '', kind: 'llm', on: true, keep: false,
        status: 'draft', assertions: [], results: null, errors: [], error: '' },
    ],
    threshold: 0.25, models: { prompt: 'query/current', evaluator: 'judge/current' },
    defaultModel: 'server/default', sampleModel: 'query/actually-used', sampleModelKnown: true,
    sampledAt: '2026-11-07T09:30:00-08:00',
    report: { criteria: [{ selected: 1, scores: [] }, { selected: null, scores: [] }],
      active_count: 1, selected_count: 1, selection_complete: true, set_fails: [false, true, false] },
    reported: [7, 9], sampling: { confidence: [0, 1, 0], next_index: 2, next_high: false }, nextHigh: false,
  };
}

function canonical(snapshot = fixture()) {
  return createSessionExport(snapshot, { exportedAt, sessionId: 'round-trip-session' });
}

const parse = (payload) => parseSessionImport(JSON.stringify(payload));

test('export → import → export preserves response source, grades, rationales and every criterion', () => {
  const original = canonical();
  const imported = parse(original);
  assert.equal(imported.type, 'session');
  assert.equal(imported.snapshot.prompt, fixture().prompt);
  assert.deepEqual(imported.snapshot.responses.map((item) => item.grade), [true, false, null]);
  assert.equal(imported.snapshot.responses[1].feedback, 'Too rude.');
  assert.equal(imported.snapshot.responses[0].explanation, 'I chose a friendly greeting.');
  assert.equal(imported.snapshot.responses[1].explanationStatus, 'unavailable');
  assert.equal(imported.snapshot.responses[2].explanation, '0');
  assert.deepEqual(imported.snapshot.criteria.map((item) => [item.on, item.keep]), [[true, true], [false, true], [true, false]]);
  assert.deepEqual(imported.snapshot.criteria[0].results, [[true, null, false], [true, false, true]]);
  assert.deepEqual(imported.snapshot.criteria[0].errors, [[null, 'Timed out', null], [null, null, null]]);
  assert.equal(imported.snapshot.criteria[1].assertions[0], fixture().criteria[1].assertions[0]);
  assert.equal(imported.snapshot.criteria[2].status, 'draft');
  assert.equal(imported.summary.responseCount, 3);
  assert.equal(imported.summary.gradedCount, 2);
  assert.equal(imported.summary.candidateCount, 3);
  const again = canonical(imported.snapshot);
  assert.deepEqual(again.responses.map((item) => [item.text, item.grade, item.feedback, item.explanation, item.explanation_status]),
    original.responses.map((item) => [item.text, item.grade, item.feedback, item.explanation, item.explanation_status]));
  assert.deepEqual(again.criteria.map((item) => item.candidates.map((candidate) => candidate.verdicts)),
    original.criteria.map((item) => item.candidates.map((candidate) => candidate.verdicts)));
});

test('actual and unknown model provenance stays separate from current selectors', () => {
  const snapshot = fixture();
  snapshot.sampleModel = null;
  snapshot.sampleModelKnown = false;
  const imported = parse(canonical(snapshot)).snapshot;
  assert.equal(imported.sampleModel, null);
  assert.equal(imported.sampleModelKnown, false);
  assert.equal(imported.defaultModel, 'server/default');
  assert.equal(imported.models.prompt, 'query/current');
  assert.equal(imported.criteria[0].model, 'judge/used');
  assert.equal(imported.criteria[0].modelKnown, true);
  assert.equal(imported.criteria[1].model, null);
  assert.equal(imported.criteria[1].modelKnown, false);
  assert.equal(canonical(imported).models.actual_sample_model, null);
  assert.equal(canonical(imported).criteria[1].model, null);
  assert.equal(imported.sampledAt, '2026-11-07T17:30:00.000Z');
});

test('saved reports, selections, summary counts and sampler predictions are never trusted', () => {
  const payload = canonical();
  payload.report = { overall: { alignment: 1 }, selection_complete: true, set_fails: [false, false, false] };
  payload.summary = { response_count: 9999, graded_count: 9999 };
  payload.sampling = { next_index: 0, confidence: [999], next_high: false };
  payload.criteria[0].selected_index = 0;
  payload.criteria[0].candidates[0].selected = true;
  payload.criteria[0].candidates[0].score = { alignment: 1, complete: true };
  const imported = parse(payload);
  assert.equal(imported.snapshot.report, null);
  assert.deepEqual(imported.snapshot.reported, []);
  assert.equal(imported.snapshot.sampling, null);
  assert.equal(imported.snapshot.nextHigh, false);
  assert.equal(imported.summary.responseCount, 3);
  assert.equal(imported.summary.gradedCount, 2);
  assert.equal(Object.hasOwn(imported.snapshot.criteria[0], 'selected_index'), false);
  assert.match(imported.warnings.join(' '), /recomputed/);
  const again = canonical(imported.snapshot);
  assert.equal(again.report, null);
  assert.equal(again.criteria[0].selected_index, null);
  assert.equal(again.criteria[0].candidates[0].score, null);
});

test('error-bearing verdicts become unknown and interrupted work cannot resume automatically', () => {
  const payload = canonical();
  payload.criteria[0].status = 'running';
  payload.criteria[0].candidates[0].verdicts[1] = false;
  const imported = parse(payload);
  const criterion = imported.snapshot.criteria[0];
  assert.equal(criterion.results[0][1], null);
  assert.equal(criterion.errors[0][1], 'Timed out');
  assert.equal(criterion.status, 'error');
  assert.equal(criterion.runId, 0);
  assert.equal(criterion.built, 'Polite: Use a friendly tone.');
  assert.equal(criterion.builtKind, 'llm');
  assert.match(criterion.error, /incomplete/);
  assert.match(imported.warnings.join(' '), /Error-bearing verdicts/);
  assert.match(imported.warnings.join(' '), /Interrupted evaluations/);
});

test('valid inline PNG evidence retains matching dimensions and original grading mode', () => {
  const snapshot = fixture();
  snapshot.outputFormat = 'svg'; snapshot.evaluationMode = 'screenshot';
  snapshot.criteria[0].evaluationMode = 'screenshot';
  snapshot.responses[0].text = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
  snapshot.responses[0].screenshot = { data_url: png, width: 1, height: 1,
    viewport: { width: 960, height: 640 }, source_hash: 'a'.repeat(64), captured_at: exportedAt };
  const imported = parse(canonical(snapshot));
  assert.equal(imported.summary.screenshotCount, 1);
  assert.equal(imported.snapshot.outputFormat, 'svg');
  assert.equal(imported.snapshot.evaluationMode, 'screenshot');
  assert.equal(imported.snapshot.criteria[0].evaluationMode, 'screenshot');
  assert.equal(imported.snapshot.criteria[1].evaluationMode, 'source');
  assert.deepEqual(imported.snapshot.responses[0].screenshot, snapshot.responses[0].screenshot);
  assert.deepEqual(canonical(imported.snapshot).responses[0].screenshot, snapshot.responses[0].screenshot);
  for (const mutate of [
    (image) => { image.width = 2; },
    (image) => { image.height = 2; },
    (image) => { image.width = 961; },
    (image) => { image.source_hash = 'not-a-sha256'; },
    (image) => { image.viewport.width = 0; },
  ]) {
    const invalid = canonical(snapshot); mutate(invalid.responses[0].screenshot);
    assert.throws(() => parse(invalid), TypeError);
  }
});

test('remote, executable, truncated and wrong-type screenshot evidence is rejected', () => {
  for (const value of [
    'https://example.invalid/screenshot.png',
    'data:image/svg+xml,<svg onload="alert(1)"/>',
    'javascript:alert(1)',
    'data:image/png;base64,aGVsbG8=',
    'data:image/png;base64,!!!!',
  ]) {
    const payload = canonical(); payload.output_format = 'html';
    payload.responses[0].screenshot = { data_url: value, width: 1, height: 1 };
    assert.throws(() => parse(payload), TypeError);
  }
  const textSession = canonical();
  textSession.responses[0].screenshot = { data_url: png, width: 1, height: 1 };
  assert.throws(() => parse(textSession), /Text sessions cannot contain/);
  const pythonVisual = canonical();
  pythonVisual.criteria[1].evaluation_mode = 'screenshot';
  assert.throws(() => parse(pythonVisual), /Python checks must use source-only/);
});

test('legacy canonical sessions and empty exported sessions restore explicit unavailable metadata', () => {
  const payload = canonical();
  delete payload.output_format; delete payload.evaluation_mode;
  delete payload.models.actual_sample_model;
  payload.responses.forEach((item) => { delete item.explanation; delete item.explanation_status; });
  const imported = parseSessionImport(`\uFEFF${JSON.stringify(payload)}`);
  assert.equal(imported.snapshot.outputFormat, 'text');
  assert.equal(imported.snapshot.evaluationMode, 'source');
  assert.equal(imported.snapshot.sampleModel, 'server/default');
  assert(imported.snapshot.responses.every((item) => item.explanation === null && item.explanationStatus === 'unavailable'));
  const empty = parse(canonical({}));
  assert.equal(empty.type, 'session');
  assert.equal(empty.summary.responseCount, 0);
  assert.equal(empty.summary.criterionCount, 0);
  assert.equal(empty.snapshot.report, null);
});

test('raw output arrays become ungraded source-only sessions without fabricated provenance', () => {
  const outputs = ['研究 🧪\nLine two', '<script>globalThis.importExecuted = true</script>'];
  const imported = parse(outputs);
  assert.equal(imported.type, 'results');
  assert.deepEqual(imported.snapshot.responses.map((item) => item.text), outputs);
  assert(imported.snapshot.responses.every((item) => item.grade === null && item.explanation === null));
  assert.equal(imported.snapshot.sampleModel, null);
  assert.equal(imported.snapshot.sampleModelKnown, false);
  assert.equal(imported.snapshot.evaluationMode, 'source');
  assert.equal(imported.snapshot.report, null);
  assert.deepEqual(imported.snapshot.criteria, []);
  assert.match(imported.warnings.join(' '), /sampling model is unknown/);
  assert.throws(() => parse([]), /at least one output/);
  assert.throws(() => parse([{ text: 'Not a raw string' }]), /must be text/);
});

test('raw results objects keep explicit explanations and ignore provider reasoning or API metadata', () => {
  const imported = parse({
    prompt: 'Produce a small webpage.', model: 'query/used', output_format: 'html', sampled_at: exportedAt,
    outputs: ['<h1>One</h1>', '<h1>Two</h1>', '<h1>Three</h1>'],
    output_details: [
      { explanation: 'An explicit model rationale.', explanation_status: 'provided', reasoning: 'Do not import raw reasoning.' },
      { explanation_status: 'unavailable', reasoning_content: 'Do not treat this as a rationale.' },
      { explanation: '0', explanation_status: 'provided', usage: { total_tokens: 999 } },
    ],
    api_key: 'ignored-not-a-key', raw_response: { secret: 'provider-raw-secret' },
    report: { overall: { alignment: 1 } }, criteria: [{ title: 'Ignore raw criteria' }],
  });
  assert.equal(imported.type, 'results');
  assert.equal(imported.snapshot.outputFormat, 'html');
  assert.equal(imported.snapshot.sampleModel, 'query/used');
  assert.equal(imported.snapshot.sampleModelKnown, true);
  assert.equal(imported.snapshot.responses[0].explanation, 'An explicit model rationale.');
  assert.equal(imported.snapshot.responses[1].explanation, null);
  assert.equal(imported.snapshot.responses[2].explanation, '0');
  assert.equal(imported.summary.explanationCount, 2);
  assert.deepEqual(imported.snapshot.criteria, []);
  const serialized = JSON.stringify(imported);
  assert.doesNotMatch(serialized, /Do not import|Do not treat|provider-raw-secret|ignored-not-a-key|total_tokens/);
  assert.throws(() => parse({ outputs: ['One'], output_details: [] }), /one entry per output/);
  assert.throws(() => parse({ outputs: ['One'], output_details: [{ explanation: '', explanation_status: 'provided' }] }), /empty explanation/);
  assert.throws(() => parse({ outputs: ['One'], output_details: [{ explanation: 0, explanation_status: 'provided' }] }), /must be text/);
});

test('invalid versions, response metadata, Boolean flags and matrix dimensions fail before restoration', () => {
  const cases = [
    (payload) => { payload.schema_version = 2; },
    (payload) => { delete payload.schema_version; },
    (payload) => { payload.responses[0].grade = 'false'; },
    (payload) => { payload.responses[0].index = 2; },
    (payload) => { payload.criteria[0].enabled = 0; },
    (payload) => { payload.criteria[0].kept = 'true'; },
    (payload) => { payload.criteria[0].candidates[0].verdicts.pop(); },
    (payload) => { payload.criteria[0].candidates[0].errors.pop(); },
    (payload) => { payload.criteria[0].candidates[0].verdicts[0] = 1; },
    (payload) => { payload.criteria[0].candidates[0].errors[0] = 0; },
    (payload) => { payload.criteria[0].candidates[0].index = 1; },
    (payload) => { payload.criteria[0].candidates[0].kind = 'python'; },
    (payload) => { payload.criteria[0].candidates[0].model = 'different/model'; },
    (payload) => { payload.criteria[1].id = payload.criteria[0].id; },
    (payload) => { payload.criteria[1].id = String(payload.criteria[0].id); },
    (payload) => { payload.settings.ffr_threshold = '0.4'; },
    (payload) => { payload.settings.ffr_threshold = 1.1; },
    (payload) => { payload.sampling.next_high = 'false'; },
  ];
  for (const mutate of cases) {
    const payload = canonical(); mutate(payload);
    assert.throws(() => parse(payload), TypeError);
  }
  assert.throws(() => parseSessionImport('{"outputs":["One",]}'), /not valid JSON/);
  assert.throws(() => parseSessionImport(null), /JSON text file/);
});

test('parsing is atomic and imported arrays never alias the source or another review', () => {
  const payload = canonical();
  const before = JSON.stringify(payload);
  const first = parseSessionImport(before);
  first.snapshot.responses[0].text = 'Changed only in returned review';
  first.snapshot.criteria[0].results[0][0] = false;
  assert.equal(JSON.stringify(payload), before);
  const broken = JSON.parse(before);
  broken.criteria[0].candidates[1].errors = [];
  assert.throws(() => parse(broken), /one verdict and error entry/);
  const next = parseSessionImport(before);
  assert.equal(next.snapshot.responses[0].text, 'Hello 🌧️');
  assert.equal(next.snapshot.criteria[0].results[0][0], true);
  assert.equal(next.summary.candidateCount, 3);
});

test('raw and canonical response limits are enforced at ten outputs', () => {
  const outputs = Array.from({ length: MAX_RESPONSES }, (_, index) => `Response ${index + 1}`);
  assert.equal(parse(outputs).summary.responseCount, 10);
  assert.throws(() => parse([...outputs, 'Eleven']), /at most 10/);
  const payload = canonical();
  payload.responses = Array.from({ length: 11 }, (_, index) => ({ text: `Response ${index}`, index }));
  assert.throws(() => parse(payload), /at most 10/);
});

test('criteria, candidate and individual source limits bound imported evaluation work', () => {
  const tooManyCriteria = canonical();
  tooManyCriteria.criteria = Array.from({ length: 51 }, (_, index) => ({
    ...structuredClone(tooManyCriteria.criteria[2]), id: `criterion-${index}`,
  }));
  assert.throws(() => parse(tooManyCriteria), /at most 50/);
  const tooManyCandidates = canonical();
  tooManyCandidates.criteria[0].candidates = Array.from({ length: 11 }, (_, index) => ({
    ...structuredClone(tooManyCandidates.criteria[0].candidates[1]), index,
  }));
  assert.throws(() => parse(tooManyCandidates), /at most 10/);
  assert.throws(() => parse(['x'.repeat(100001)]), /100,000-character limit/);
});

test('file size is bounded in UTF-8 bytes before JSON parsing', () => {
  const valid = '["one"]';
  const boundary = valid + ' '.repeat(MAX_FILE_BYTES - Buffer.byteLength(valid));
  assert.equal(parseSessionImport(boundary).summary.responseCount, 1);
  assert.throws(() => parseSessionImport(`${boundary} `), /20 MiB/);
  assert.throws(() => parseSessionImport('é'.repeat(MAX_FILE_BYTES / 2 + 1)), /20 MiB/);
});

test('hostile nesting and executable-looking data do not execute, fetch, mount or pollute prototypes', () => {
  const calls = [];
  const context = vm.createContext({ TextEncoder, atob,
    fetch: () => { calls.push('fetch'); throw new Error('Network is forbidden'); },
    document: { createElement: () => { calls.push('DOM'); throw new Error('DOM is forbidden'); } },
    alert: () => calls.push('alert'),
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/evalgen/web/import.js'), 'utf8'), context);
  const payload = canonical();
  payload.responses[0].text = '<script>fetch("https://example.invalid");alert(1)</script>';
  payload.criteria[1].candidates[0].source = 'globalThis.importExecuted = true; require("node:child_process").execSync("echo forbidden")';
  Object.defineProperty(payload, '__proto__', { enumerable: true, value: { importPolluted: true } });
  const parsed = context.EvalGenImport.parseSessionImport(JSON.stringify(payload));
  assert.equal(parsed.snapshot.responses[0].text, payload.responses[0].text);
  assert.equal(parsed.snapshot.criteria[1].assertions[0], payload.criteria[1].candidates[0].source);
  assert.equal(Object.hasOwn(parsed.snapshot, '__proto__'), false);
  assert.equal(context.importExecuted, undefined);
  assert.equal(Object.prototype.importPolluted, undefined);
  assert.deepEqual(calls, []);
  const depth = 12000;
  const nested = '{"schema_version":1,"responses":[],"criteria":[],"ignored":'
    + '['.repeat(depth) + '0' + ']'.repeat(depth) + '}';
  assert.equal(parseSessionImport(nested).summary.responseCount, 0);
  const invalidText = '{"outputs":[' + '['.repeat(depth) + '0' + ']'.repeat(depth) + ']}';
  assert.throws(() => parseSessionImport(invalidText), { name: 'TypeError', message: /must be text/ });
});
