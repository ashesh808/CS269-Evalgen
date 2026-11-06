const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionExport, createSessionExport, renderSessionHtml } = require('../src/evalgen/web/export.js');

const exportedAt = '2026-11-05T23:00:00.000Z';
const perfect = () => ({
  coverage: 1, ffr: 0, alignment: 1, complete: true, known_count: 3, unknown_count: 0,
  confusion: { good_passed: 1, good_failed: 0, bad_passed: 0, bad_failed: 1, good_unknown: 0, bad_unknown: 0 },
});

function fixture() {
  return {
    prompt: 'Write a friendly greeting.\nDo not invent facts.',
    responses: [
      { text: 'Hello!', grade: true, feedback: 'Friendly.' },
      { text: 'Go away.', grade: false, feedback: 'Rude.' },
      { text: 'Good morning.', grade: null, feedback: '' },
    ],
    criteria: [{ id: 7, title: 'Polite', description: 'The greeting should be polite.',
      kind: 'llm', on: true, keep: true, status: 'done', model: 'judge/used',
      assertions: ['Return true if the greeting is polite.'],
      results: [[true, false, true]], errors: [[null, null, null]], error: '' }],
    threshold: 0.4,
    models: { prompt: 'query/current', evaluator: 'judge/current' },
    defaultModel: 'server/default', sampleModel: 'query/actually-used',
    sampledAt: '2026-11-05T14:59:00-08:00',
    report: { criteria: [{ selected: 0, scores: [perfect()] }], overall: perfect(),
      active_count: 1, selected_count: 1, selection_complete: true, set_fails: [false, true, false] },
    reported: [7],
    sampling: { selectivities: [[2 / 3]], confidence: [0, 2 / 3, 0], known_counts: [1, 1, 1], next_index: 2, next_high: true },
    nextHigh: true,
  };
}

test('JSON round trip retains grades, all candidate checks and unknown outcomes', () => {
  const snapshot = fixture();
  snapshot.criteria[0].assertions.push('Alternative prompt');
  snapshot.criteria[0].results.push([null, true]);
  snapshot.criteria[0].errors.push(['Unreadable verdict']);
  snapshot.report.criteria[0].scores.push({ ...perfect(), complete: false, unknown_count: 2 });
  const session = JSON.parse(JSON.stringify(buildSessionExport(snapshot, exportedAt)));
  assert.equal(session.schema_version, 1);
  assert.deepEqual(session.responses.map((response) => response.grade), [true, false, null]);
  assert.equal(session.responses[1].feedback, 'Rude.');
  assert.deepEqual(session.criteria[0].candidates[1].verdicts, [null, true, null]);
  assert.deepEqual(session.criteria[0].candidates[1].errors, ['Unreadable verdict', null, null]);
  assert.equal(session.criteria[0].selected_index, 0);
  assert.equal(session.criteria[0].candidates[1].score.complete, false);
});

test('serialization is deterministic for a timestamp and never mutates or aliases state', () => {
  const snapshot = fixture();
  const before = JSON.stringify(snapshot);
  const session = buildSessionExport(snapshot, exportedAt);
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(session, buildSessionExport(snapshot, exportedAt));
  session.criteria[0].candidates[0].verdicts[0] = false;
  assert.equal(snapshot.criteria[0].results[0][0], true);
});

test('recorded model provenance takes priority over selectors changed after sampling', () => {
  const session = buildSessionExport(fixture(), exportedAt);
  assert.equal(session.models.actual_sample_model, 'query/actually-used');
  assert.equal(session.models.current_query_model, 'query/current');
  assert.equal(session.models.current_evaluator_model, 'judge/current');
  assert.equal(session.criteria[0].candidates[0].generation_model, 'judge/used');
  assert.equal(session.criteria[0].candidates[0].evaluation_model, 'judge/used');
  const snapshot = fixture();
  snapshot.sampleModel = null;
  snapshot.criteria[0].model = null;
  assert.equal(buildSessionExport(snapshot, exportedAt).models.actual_sample_model, 'server/default');
  assert.equal(buildSessionExport(snapshot, exportedAt).criteria[0].candidates[0].model, 'server/default');
});

test('drafts do not inherit stale model provenance and Python is not labeled an LLM execution', () => {
  const snapshot = fixture();
  snapshot.criteria.push({ id: 8, title: 'Draft', status: 'draft', on: false,
    model: 'stale/previous', assertions: [], results: null });
  snapshot.criteria[0].kind = 'python';
  const session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.criteria[1].model, null);
  assert.equal(session.criteria[0].candidates[0].kind, 'python');
  assert.equal(session.criteria[0].candidates[0].evaluation_model, null);
  assert.equal(session.criteria[0].candidates[0].generation_model, 'judge/used');
});

test('reports map by recorded criterion IDs rather than array positions', () => {
  const snapshot = fixture();
  snapshot.criteria.unshift({ id: 5, title: 'Disabled', kind: 'python', on: false, keep: true,
    status: 'done', model: 'other/model', assertions: ['def evaluate(response, prompt): return False'],
    results: [[false, false, false]], errors: [] });
  snapshot.criteria.push({ id: 9, title: 'Excluded draft', on: true, keep: false,
    status: 'draft', assertions: [] });
  snapshot.reported = [7, 9];
  snapshot.report.criteria.push({ selected: null, scores: [] });
  const session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.criteria.length, 3);
  assert.equal(session.criteria[0].enabled, false);
  assert.equal(session.criteria[0].candidates[0].score, null);
  assert.equal(session.criteria[0].selected_index, null);
  assert.equal(session.criteria[1].selected_index, 0);
  assert.equal(session.criteria[1].candidates[0].score.alignment, 1);
  assert.equal(session.criteria[2].kept, false);
  assert.equal(session.session.status, 'complete');
});

test('ungraded humans do not make a valid selected evaluator set incomplete', () => {
  const session = buildSessionExport(fixture(), exportedAt);
  assert.equal(session.session.status, 'complete');
  assert.equal(session.summary.graded_count, 2);
  assert.equal(session.summary.ungraded_count, 1);
  assert.equal(session.report.overall.alignment, 1);
  const html = renderSessionHtml(session);
  assert.match(html, /Alignment based on 2 human-graded responses; 1 ungraded/);
  assert.match(html, /Selected evaluation complete/);
});

test('unknown only on an ungraded output cannot produce an HTML 100% candidate claim', () => {
  const snapshot = fixture();
  snapshot.criteria[0].results[0][2] = null;
  snapshot.report.criteria[0].scores[0] = { ...perfect(), complete: false, known_count: 2, unknown_count: 1 };
  const session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.criteria[0].candidates[0].score.alignment, 1);
  assert.equal(session.criteria[0].candidates[0].complete, false);
  assert.equal(session.criteria[0].selected_index, null);
  assert.equal(session.report.overall, null);
  assert.deepEqual(session.report.set_fails, [null, null, null]);
  const html = renderSessionHtml(session);
  assert.doesNotMatch(html, /<dd>100%<\/dd>/);
  assert.match(html, /Unknown evaluator outcomes are not passes or failures/);
  assert.match(html, /<dd>n\/a<\/dd>/);
});

test('error-bearing candidates are never exported as selected even when verdicts are bools', () => {
  const snapshot = fixture();
  snapshot.criteria[0].errors[0][0] = 'Execution error';
  const session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.criteria[0].selected_index, null);
  assert.equal(session.report.selection_complete, false);
  assert.equal(session.report.overall, null);
});

test('unknown rejected alternatives do not invalidate a complete selected candidate', () => {
  const snapshot = fixture();
  snapshot.criteria[0].assertions.push('Unavailable alternative');
  snapshot.criteria[0].results.push([null, null, null]);
  snapshot.report.criteria[0].scores.push({ ...perfect(), complete: false, unknown_count: 3 });
  const session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.session.status, 'complete');
  assert.equal(session.report.overall.alignment, 1);
  assert.equal(session.summary.unknown_verdict_count, 3);
  assert.match(renderSessionHtml(session), /alternatives do not invalidate the fully selected evaluator set/);
});

test('in-flight and absent report snapshots never claim aggregate alignment', () => {
  const snapshot = fixture();
  snapshot.criteria[0].status = 'running';
  let session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.session.status, 'in_progress');
  assert.equal(session.report.overall, null);
  snapshot.criteria[0].status = 'done';
  snapshot.report = null;
  session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.report, null);
  assert.equal(session.criteria[0].candidates[0].score, null);
  assert.doesNotMatch(renderSessionHtml(session), /<dd>100%<\/dd>/);
});

test('allowlist excludes unexpected secrets, internal metadata and server URLs', () => {
  const snapshot = fixture();
  const secret = 'UNEXPECTED_PRIVATE_VALUE';
  snapshot.apiKey = secret;
  snapshot.credentials = { token: secret };
  snapshot.base_url = 'https://private-backend.example/v1';
  snapshot.request = { headers: { Authorization: secret } };
  snapshot.responses[0].debug = secret;
  snapshot.criteria[0].secret = secret;
  snapshot.criteria[0].runId = secret;
  snapshot.report.credentials = secret;
  snapshot.report.overall.apiKey = secret;
  const json = JSON.stringify(buildSessionExport(snapshot, exportedAt));
  assert.ok(!json.includes(secret));
  assert.ok(!json.includes('private-backend.example'));
  assert.ok(!json.includes('runId'));
});

test('diagnostics redact credentials and backend URLs without modifying task text', () => {
  const snapshot = fixture();
  snapshot.prompt = 'Keep this literal task URL: https://example.com/研究';
  snapshot.criteria[0].error = 'LLM server at https://backend.example/v1 failed; Bearer abc.def_ghi';
  snapshot.criteria[0].errors[0][1] = 'api_key="vck_1234567890secret" sk-1234567890secret';
  const session = buildSessionExport(snapshot, exportedAt);
  const json = JSON.stringify(session);
  assert.equal(session.prompt, snapshot.prompt);
  assert.ok(!json.includes('backend.example'));
  assert.ok(!json.includes('abc.def_ghi'));
  assert.ok(!json.includes('1234567890secret'));
  assert.match(json, /redacted/);
});

test('all model and user text is escaped in standalone script-free HTML', () => {
  const snapshot = fixture();
  const attack = '</script><img src=x onerror="alert(1)"><style>body{display:none}</style>&\'"';
  snapshot.prompt = attack;
  snapshot.responses[0].text = attack;
  snapshot.responses[0].feedback = attack;
  snapshot.criteria[0].title = attack;
  snapshot.criteria[0].description = attack;
  snapshot.criteria[0].model = attack;
  snapshot.criteria[0].assertions[0] = attack;
  snapshot.criteria[0].error = attack;
  snapshot.criteria[0].errors[0][1] = attack;
  snapshot.sampleModel = attack;
  const session = buildSessionExport(snapshot, exportedAt);
  assert.equal(session.prompt, attack);
  const html = renderSessionHtml(session);
  assert.doesNotMatch(html, /<script\b|<img\b|<form\b|<iframe\b|<link\b/i);
  assert.ok(!html.includes('</script>'));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&amp;&#39;&quot;/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /@media print/);
});

test('Unicode, multiline source and UTC timestamps survive export', () => {
  const snapshot = fixture();
  snapshot.prompt = '研究 🧪\nПривет\n日本語\u2028line';
  snapshot.criteria[0].kind = 'python';
  snapshot.criteria[0].assertions[0] = 'def evaluate(response, prompt):\n    return "研究" in response';
  const session = createSessionExport(snapshot, { exportedAt: '2026-11-05T15:00:00-08:00', sessionId: '研究-session' });
  assert.equal(session.exported_at, exportedAt);
  assert.equal(session.session.sampled_at, '2026-11-05T22:59:00.000Z');
  assert.equal(session.session.id, '研究-session');
  assert.equal(JSON.parse(JSON.stringify(session)).prompt, snapshot.prompt);
  const html = renderSessionHtml(session);
  assert.match(html, /charset="utf-8"/);
  assert.ok(html.includes('Привет'));
  assert.ok(html.includes('研究 🧪'));
  assert.ok(html.includes('def evaluate(response, prompt):\n'));
});

test('unavailable rates render n/a rather than misleading zero', () => {
  const snapshot = fixture();
  snapshot.report.overall = { ...perfect(), coverage: null, alignment: null };
  snapshot.report.criteria[0].scores[0] = { ...perfect(), coverage: null, alignment: null };
  const html = renderSessionHtml(buildSessionExport(snapshot, exportedAt));
  assert.match(html, /<dt>Coverage<\/dt><dd>n\/a<\/dd>/);
  assert.match(html, /<dt>Alignment<\/dt><dd>n\/a<\/dd>/);
  assert.match(html, /<dt>False failure rate<\/dt><dd>0%<\/dd>/);
});

test('empty snapshots and invalid timestamps have explicit behavior', () => {
  const empty = buildSessionExport({}, exportedAt);
  assert.equal(empty.session.status, 'empty');
  assert.equal(empty.models.actual_sample_model, null);
  assert.deepEqual(empty.responses, []);
  assert.equal(empty.report, null);
  assert.match(renderSessionHtml(empty), /No responses are present/);
  assert.throws(() => buildSessionExport({}, 'not-a-date'), /valid export timestamp/);
  assert.throws(() => renderSessionHtml({ schema_version: 9 }), /Unsupported/);
});
