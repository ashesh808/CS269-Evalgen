// Explicit session serialization and a script-free, self-contained print report.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EvalGenExport = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const array = (value) => Array.isArray(value) ? value : [];
  const text = (value) => typeof value === 'string' ? value : '';
  const bool = (value) => value === true || value === false ? value : null;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const count = (value) => Number.isInteger(value) && value >= 0 ? value : null;
  const rate = (value) => finite(value) !== null && value >= 0 && value <= 1 ? value : null;
  const model = (value) => text(value).trim() || null;
  const identifier = (value, fallback) => typeof value === 'string' || finite(value) !== null ? value : fallback;
  const key = (value) => JSON.stringify(value);
  const status = (value) => ['draft', 'generating', 'running', 'done', 'error'].includes(value) ? value : 'unknown';
  const outputFormat = (value) => ['text', 'svg', 'html'].includes(value) ? value : 'text';
  const formatName = (value) => ({ text: 'Text', svg: 'SVG logo / vector', html: 'HTML / CSS / JavaScript' })[outputFormat(value)];

  function utc(value, required = false) {
    const date = value instanceof Date ? value : new Date(value);
    if (!value || !Number.isFinite(date.getTime())) {
      if (required) throw new TypeError('A valid export timestamp is required.');
      return null;
    }
    return date.toISOString();
  }

  function diagnostic(value) {
    const message = text(value);
    if (!message) return null;
    return message
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\b(?:vck_|sk-|sk_)[A-Za-z0-9_-]{6,}/g, '[redacted credential]')
      .replace(/((?:api[_ -]?key|access[_ -]?token|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"'\],;]+/gi, '$1[redacted]')
      .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[redacted URL]');
  }

  function score(value) {
    if (!value || typeof value !== 'object') return null;
    const confusion = value.confusion && typeof value.confusion === 'object'
      ? Object.fromEntries(['bad_failed', 'bad_passed', 'good_failed', 'good_passed', 'bad_unknown', 'good_unknown']
        .map((name) => [name, count(value.confusion[name])])) : null;
    return {
      coverage: rate(value.coverage), ffr: rate(value.ffr), alignment: rate(value.alignment),
      complete: bool(value.complete), known_count: count(value.known_count),
      unknown_count: count(value.unknown_count), confusion,
    };
  }

  function createSessionExport(snapshot, options = {}) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const exportedAt = utc(options.exportedAt || new Date().toISOString(), true);
    const defaultModel = model(source.defaultModel);
    const responses = array(source.responses).map((response, index) => ({
      id: `response-${index + 1}`, index,
      text: text(response?.text), grade: bool(response?.grade), feedback: text(response?.feedback),
    }));
    const rawReport = source.report && typeof source.report === 'object' ? source.report : null;
    const reports = new Map();
    array(source.reported).forEach((id, index) => {
      const item = array(rawReport?.criteria)[index];
      if (item && typeof item === 'object') reports.set(key(id), item);
    });

    const criteria = array(source.criteria).map((criterion, index) => {
      const c = criterion && typeof criterion === 'object' ? criterion : {};
      const id = identifier(c.id, `criterion-${index + 1}`);
      const enabled = c.on !== false;
      const kept = c.keep !== false;
      const kind = c.kind === 'python' ? 'python' : 'llm';
      const criterionStatus = status(c.status);
      const sources = array(c.assertions);
      // A draft retains no claim about the model used in a previous, invalidated run.
      const usedModel = sources.length ? model(c.model) || defaultModel : null;
      const report = enabled ? reports.get(key(id)) : null;
      const candidates = sources.map((candidate, candidateIndex) => {
        const rawVerdicts = array(array(c.results)[candidateIndex]);
        const rawErrors = array(array(c.errors)[candidateIndex]);
        const verdicts = responses.map((_, output) => bool(rawVerdicts[output]));
        const errors = responses.map((_, output) => diagnostic(rawErrors[output]));
        const complete = rawVerdicts.length === responses.length
          && responses.length > 0 && verdicts.every((value) => value !== null) && !errors.some(Boolean);
        return {
          index: candidateIndex, kind, model: usedModel, generation_model: usedModel,
          evaluation_model: kind === 'llm' ? usedModel : null,
          source: text(candidate), verdicts, errors, complete,
          unknown_count: verdicts.filter((value) => value === null).length,
          score: score(array(report?.scores)[candidateIndex]), selected: false,
        };
      });
      const proposed = report?.selected;
      const selected = Number.isInteger(proposed) && proposed >= 0 && proposed < candidates.length
        && candidates[proposed].complete && candidates[proposed].score?.complete !== false
        ? proposed : null;
      if (selected !== null) candidates[selected].selected = true;
      return {
        id, index, title: text(c.title), description: text(c.description), kind,
        enabled, kept, active: enabled && kept, status: criterionStatus, model: usedModel,
        error: diagnostic(c.error), selected_index: selected, candidates,
      };
    });

    const active = criteria.filter((criterion) => criterion.active);
    const selectedCount = active.filter((criterion) => criterion.selected_index !== null).length;
    const inProgress = active.filter((criterion) => ['generating', 'running'].includes(criterion.status)).length;
    const selectionComplete = !!rawReport && rawReport.selection_complete === true && active.length > 0
      && selectedCount === active.length && inProgress === 0;
    const selectionConsistent = !!rawReport && array(rawReport.set_fails).length === responses.length
      && (!rawReport.selection_complete || selectionComplete);
    const report = rawReport ? {
      selection_complete: selectionComplete,
      active_count: active.length, selected_count: selectedCount,
      overall: selectionComplete && selectionConsistent ? score(rawReport.overall) : null,
      set_fails: responses.map((_, index) => selectionConsistent ? bool(rawReport.set_fails[index]) : null),
    } : null;
    responses.forEach((response) => {
      response.overall_failure = report ? report.set_fails[response.index] : null;
      response.selected_verdicts = criteria.map((criterion) => {
        const candidate = criterion.selected_index === null ? null : criterion.candidates[criterion.selected_index];
        return {
          criterion_id: criterion.id, candidate_index: criterion.selected_index,
          enabled: criterion.enabled, kept: criterion.kept,
          verdict: candidate ? candidate.verdicts[response.index] : null,
          error: candidate ? candidate.errors[response.index] : null,
        };
      });
    });
    const candidates = criteria.flatMap((criterion) => criterion.candidates);
    const goodCount = responses.filter((response) => response.grade === true).length;
    const badCount = responses.filter((response) => response.grade === false).length;
    const sessionStatus = !responses.length ? 'empty' : inProgress ? 'in_progress'
      : selectionComplete ? 'complete' : !active.length ? 'no_active_criteria' : 'partial';
    const sampling = source.sampling && typeof source.sampling === 'object' ? source.sampling : {};
    return {
      schema_version: 1,
      exported_at: exportedAt,
      session: {
        id: model(options.sessionId), status: sessionStatus, sampled_at: utc(source.sampledAt),
      },
      prompt: text(source.prompt),
      output_format: outputFormat(source.outputFormat),
      models: {
        actual_sample_model: model(source.sampleModel) || defaultModel,
        current_query_model: model(source.models?.prompt) || defaultModel,
        current_evaluator_model: model(source.models?.evaluator) || defaultModel,
        default_model: defaultModel,
      },
      settings: { ffr_threshold: rate(source.threshold) },
      sampling: {
        policy: 'alternating', next_high: bool(source.nextHigh) ?? bool(sampling.next_high),
        next_response_index: count(sampling.next_index),
        confidence: array(sampling.confidence).map(finite),
        known_counts: array(sampling.known_counts).map(count),
        selectivities: array(sampling.selectivities).map((group) => array(group).map(rate)),
      },
      summary: {
        response_count: responses.length, graded_count: goodCount + badCount,
        good_count: goodCount, bad_count: badCount, ungraded_count: responses.length - goodCount - badCount,
        criterion_count: criteria.length, active_criterion_count: active.length,
        selected_criterion_count: selectedCount, candidate_count: candidates.length,
        unknown_verdict_count: candidates.reduce((total, candidate) => total + candidate.unknown_count, 0),
        candidate_error_count: candidates.reduce((total, candidate) => total + candidate.errors.filter(Boolean).length, 0),
        active_in_progress_count: inProgress,
      },
      responses, criteria, report,
    };
  }

  function buildSessionExport(snapshot, exportedAt = new Date().toISOString()) {
    return createSessionExport(snapshot, { exportedAt });
  }

  function escape(value) {
    return text(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const shown = (value) => value === null || value === undefined || value === '' ? 'n/a' : escape(String(value));
  const percent = (value) => rate(value) === null ? 'n/a' : `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
  const outcome = (value) => value === true ? 'Pass' : value === false ? 'Fail' : 'Unknown';
  const humanGrade = (value) => value === true ? 'Good' : value === false ? 'Bad' : 'Ungraded';
  const kindName = (value) => value === 'python' ? 'Python code' : 'LLM grader';

  function metrics(value) {
    return `<dl class="metrics"><div><dt>Coverage</dt><dd>${percent(value?.coverage)}</dd></div>`
      + `<div><dt>False failure rate</dt><dd>${percent(value?.ffr)}</dd></div>`
      + `<div><dt>Alignment</dt><dd>${percent(value?.alignment)}</dd></div></dl>`;
  }

  function confusion(value) {
    const matrix = value?.confusion;
    if (!matrix) return '';
    return `<table class="compact"><caption>Agreement with human grades</caption>`
      + '<thead><tr><th>Human grade</th><th>Evaluator pass</th><th>Evaluator fail</th><th>Unknown</th></tr></thead>'
      + `<tbody><tr><th>Good</th><td>${shown(matrix.good_passed)}</td><td>${shown(matrix.good_failed)}</td><td>${shown(matrix.good_unknown)}</td></tr>`
      + `<tr><th>Bad</th><td>${shown(matrix.bad_passed)}</td><td>${shown(matrix.bad_failed)}</td><td>${shown(matrix.bad_unknown)}</td></tr></tbody></table>`;
  }

  function renderCandidate(candidate, criterion, responses) {
    const availableScore = candidate.complete && candidate.score?.complete !== false ? candidate.score : null;
    const rows = responses.map((response, index) => `<tr><th>Response ${index + 1}</th>`
      + `<td>${outcome(candidate.verdicts[index])}</td><td>${candidate.errors[index] ? escape(candidate.errors[index]) : '—'}</td></tr>`).join('');
    return `<section class="candidate"><h4>Candidate ${candidate.index + 1}`
      + `${candidate.selected ? ' <span class="badge selected">Selected</span>' : ''}</h4>`
      + `<p class="meta">${kindName(candidate.kind)} · ${candidate.complete ? 'All checks completed' : 'Checks unavailable or incomplete'} · Generation model: ${shown(candidate.generation_model)}</p>`
      + `<pre class="source"><code>${escape(candidate.source)}</code></pre>`
      + metrics(availableScore) + confusion(availableScore)
      + `<table><caption>Candidate verdicts</caption><thead><tr><th>Output</th><th>Verdict</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }

  function renderCriterion(criterion, responses) {
    const state = !criterion.enabled ? 'Disabled' : !criterion.kept ? 'Excluded from active set' : 'Active';
    const selection = criterion.selected_index === null ? 'No eligible candidate selected'
      : `Candidate ${criterion.selected_index + 1} selected`;
    return `<article class="criterion"><h3>${escape(criterion.title || `Criterion ${criterion.index + 1}`)}</h3>`
      + `<p>${escape(criterion.description)}</p><p class="meta">${kindName(criterion.kind)} · ${state} · Status: ${escape(criterion.status)} · ${selection}</p>`
      + (criterion.error ? `<p class="error">${escape(criterion.error)}</p>` : '')
      + (criterion.candidates.length ? criterion.candidates.map((candidate) => renderCandidate(candidate, criterion, responses)).join('')
        : '<p class="muted">No candidate implementations have been generated.</p>') + '</article>';
  }

  function renderResponse(response, criteria, format) {
    const rows = response.selected_verdicts.map((selection, index) => {
      const criterion = criteria[index];
      const included = selection.enabled && selection.kept;
      return `<tr><th>${escape(criterion?.title || `Criterion ${index + 1}`)}</th>`
        + `<td>${included ? 'Active' : 'Excluded'}</td><td>${selection.candidate_index === null ? 'n/a' : selection.candidate_index + 1}</td>`
        + `<td>${outcome(selection.verdict)}</td></tr>`;
    }).join('');
    return `<article class="response"><h3>Response ${response.index + 1} <span class="badge">${humanGrade(response.grade)}</span></h3>`
      + (outputFormat(format) === 'text' ? '' : `<p class="meta">Source · ${formatName(format)}</p>`)
      + `<pre>${escape(response.text)}</pre>`
      + (response.feedback ? `<p><strong>Human feedback</strong></p><pre class="feedback">${escape(response.feedback)}</pre>` : '')
      + (rows ? `<table><caption>Selected evaluator verdicts</caption><thead><tr><th>Criterion</th><th>Included</th><th>Candidate</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>` : '')
      + '</article>';
  }

  function renderSessionHtml(session) {
    if (!session || session.schema_version !== 1) throw new TypeError('Unsupported EvalGen export schema.');
    const summary = session.summary;
    const complete = session.report?.selection_complete === true;
    const labels = { empty: 'No responses sampled', complete: 'Selected evaluation complete',
      partial: 'Evaluation incomplete or selection unavailable', in_progress: 'Evaluation in progress',
      no_active_criteria: 'No active evaluation criteria' };
    const notices = [];
    if (!complete) notices.push('This snapshot does not contain a complete selected evaluator set. Overall alignment metrics are unavailable.');
    if (summary.unknown_verdict_count) notices.push(`${summary.unknown_verdict_count} candidate verdicts are unknown. Unknown evaluator outcomes are not passes or failures.`);
    if (summary.candidate_error_count) notices.push(`${summary.candidate_error_count} candidate checks have recorded errors. See candidate details below.`);
    if (complete && summary.unknown_verdict_count) notices.push('Incomplete or failed alternatives do not invalidate the fully selected evaluator set.');
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src \'none\'; font-src \'none\'; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">'
      + '<title>EvalGen session report</title><style>'
      + ':root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172431;background:#edf1f4;line-height:1.55}'
      + '*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:32px auto;background:#fff;padding:44px 52px;border-radius:12px;border:1px solid #d8e0e7}'
      + 'header{border-bottom:3px solid #197278;padding-bottom:24px;margin-bottom:30px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.15em;color:#197278;font-weight:700}'
      + 'h1{font-size:34px;line-height:1.2;margin:10px 0}h2{font-size:23px;margin:36px 0 16px}h3{font-size:18px;margin:0 0 10px}h4{font-size:16px;margin:0 0 8px}p{margin:10px 0}'
      + '.meta,.muted{color:#526575;font-size:13px}.badge{display:inline-block;border:1px solid #c7d3dd;background:#f4f7fa;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600;vertical-align:middle}.selected{background:#e9f6f0;border-color:#abd9c5;color:#13583d}'
      + '.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}.stat{padding:14px;background:#f3f7fa;border:1px solid #dce5ec;border-radius:6px}.stat strong{display:block;font-size:25px}.stat span{font-size:12px;color:#526575}'
      + '.notice{padding:12px 16px;background:#fff7e5;border-left:4px solid #b67b16;margin:10px 0}.notice p{margin:4px 0}.error{color:#8b2530;background:#fff1f1;border-left:3px solid #bf5561;padding:10px 14px;white-space:pre-wrap}'
      + '.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.metrics div{border-top:2px solid #b9d4d5;padding:8px 4px}.metrics dt{font-size:12px;color:#526575}.metrics dd{font-size:23px;font-weight:650;margin:2px 0}'
      + 'table{border-collapse:collapse;width:100%;font-size:13px;margin:16px 0;table-layout:fixed}caption{text-align:left;font-weight:650;margin-bottom:7px}th,td{text-align:left;vertical-align:top;padding:9px 11px;border:1px solid #dbe2e8;overflow-wrap:anywhere}thead th{background:#f1f5f8}tbody th{font-weight:500}.compact{max-width:680px}'
      + 'pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;tab-size:4;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#f7f9fb;border:1px solid #e0e6eb;padding:16px;border-radius:5px;margin:12px 0}.source{background:#f3f6f8}.feedback{border-left:3px solid #b7c8d8}'
      + '.response,.criterion{padding:22px 0;border-bottom:1px solid #dce4eb}.candidate{margin:22px 0 12px;padding:20px;border:1px solid #d6e1e8;border-radius:7px}footer{font-size:12px;color:#526575;margin-top:34px;border-top:1px solid #dce4eb;padding-top:16px}'
      + '@media(max-width:700px){main{margin:0;padding:24px 18px;border-radius:0}.stats,.metrics{grid-template-columns:1fr}.candidate{padding:14px}h1{font-size:28px}}'
      + '@page{size:auto;margin:16mm}@media print{:root{background:#fff}main{margin:0;max-width:none;border:0;padding:0;border-radius:0}h2,h3,h4,caption{break-after:avoid}.metrics,.stats,thead{break-inside:avoid}.candidate{border-radius:0}pre{font-size:10px}table{font-size:10px}thead{display:table-header-group}a{color:inherit;text-decoration:none}footer{break-inside:avoid}}'
      + '</style></head><body><main><header><div class="eyebrow">EvalGen · Session report</div><h1>Evaluation session</h1>'
      + `<p><span class="badge">${escape(labels[session.session.status] || session.session.status)}</span></p>`
      + `<p class="meta">Exported ${shown(session.exported_at)} · Schema ${shown(session.schema_version)}${session.session.id ? ` · Session ${escape(session.session.id)}` : ''}</p></header>`
      + `<div class="stats"><div class="stat"><strong>${shown(summary.response_count)}</strong><span>Responses</span></div><div class="stat"><strong>${shown(summary.graded_count)}</strong><span>Human-graded responses</span></div><div class="stat"><strong>${shown(summary.selected_criterion_count)} / ${shown(summary.active_criterion_count)}</strong><span>Active criteria with selected candidates</span></div></div>`
      + `<p>Alignment based on ${shown(summary.graded_count)} human-graded responses; ${shown(summary.ungraded_count)} ungraded. Human grades are optional for the remaining outputs and are distinct from unknown evaluator verdicts.</p>`
      + (notices.length ? `<aside class="notice">${notices.map((notice) => `<p>${escape(notice)}</p>`).join('')}</aside>` : '')
      + '<section><h2>Prompt and model provenance</h2>'
      + `<pre>${escape(session.prompt)}</pre><table><tbody><tr><th>Model that produced these responses</th><td>${shown(session.models.actual_sample_model)}</td></tr>`
      + `<tr><th>Output format</th><td>${formatName(session.output_format)}</td></tr>`
      + `<tr><th>Responses sampled at</th><td>${shown(session.session.sampled_at)}</td></tr><tr><th>Current query selection</th><td>${shown(session.models.current_query_model)}</td></tr>`
      + `<tr><th>Current evaluator selection</th><td>${shown(session.models.current_evaluator_model)}</td></tr><tr><th>False failure rate threshold</th><td>${percent(session.settings.ffr_threshold)}</td></tr>`
      + `<tr><th>Grading sampler</th><td>${escape(session.sampling.policy)}</td></tr></tbody></table></section>`
      + `<section><h2>Selected evaluator set</h2>${metrics(complete ? session.report.overall : null)}${complete ? confusion(session.report.overall) : ''}`
      + '<p class="meta">Coverage is the fraction of human-bad outputs flagged. False failure rate is the fraction of human-good outputs flagged. Alignment is their harmonic combination with 1 − false failure rate. n/a means the rate cannot be determined from this snapshot.</p></section>'
      + `<section><h2>Responses and human feedback</h2>${session.responses.length ? session.responses.map((response) => renderResponse(response, session.criteria, session.output_format)).join('') : '<p class="muted">No responses are present in this session.</p>'}</section>`
      + `<section><h2>Criteria and every candidate implementation</h2>${session.criteria.length ? session.criteria.map((criterion) => renderCriterion(criterion, session.responses)).join('') : '<p class="muted">No criteria are present in this session.</p>'}</section>`
      + '<footer>This report is a snapshot of the captured session. It includes current disabled and excluded criteria and all retained candidates; it does not include deleted session history. Diagnostic credentials and backend URLs are redacted. No external assets or scripts are required. Use your browser’s Print command to save a PDF.</footer>'
      + '</main></body></html>';
  }

  return Object.freeze({ buildSessionExport, createSessionExport, renderSessionHtml });
}));
