// JSON is data: this parser never executes candidates, mounts previews, or makes requests.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EvalGenImport = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_RESPONSES = 10;
  const MAX_CRITERIA = 50;
  const MAX_CANDIDATES = 10;
  const MAX_TEXT = 100000;
  const MAX_SCREENSHOT_CHARS = 700000;
  const MAX_SCREENSHOT_TOTAL = 3000000;
  const own = (object, name) => Object.prototype.hasOwnProperty.call(object, name);

  function invalid(message) { throw new TypeError(message); }
  function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object.`);
    return value;
  }
  function string(value, name, { optional = false, nullable = false, limit = MAX_TEXT } = {}) {
    if (value === undefined && optional) return '';
    if (value === null && nullable) return null;
    if (typeof value !== 'string') invalid(`${name} must be text${nullable ? ' or null' : ''}.`);
    if (value.length > limit) invalid(`${name} exceeds the ${limit.toLocaleString('en-US')}-character limit.`);
    return value;
  }
  function model(value, name) {
    if (value === undefined || value === null) return null;
    return string(value, name, { limit: 512 }).trim() || null;
  }
  function boolean(value, name, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'boolean') invalid(`${name} must be true or false.`);
    return value;
  }
  function verdict(value, name) {
    if (value !== null && typeof value !== 'boolean') invalid(`${name} must be true, false, or null.`);
    return value;
  }
  function choice(value, names, name, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!names.includes(value)) invalid(`${name} must be ${names.join(', ')}.`);
    return value;
  }
  function timestamp(value, name) {
    if (value === undefined || value === null) return null;
    string(value, name, { limit: 100 });
    const parsed = new Date(value);
    if (!value || !Number.isFinite(parsed.getTime())) invalid(`${name} must be a valid date or null.`);
    return parsed.toISOString();
  }
  function list(value, name, max) {
    if (!Array.isArray(value)) invalid(`${name} must be an array.`);
    if (value.length > max) invalid(`${name} may contain at most ${max} items.`);
    return value;
  }
  function dimensions(value, name, max) {
    if (!Number.isInteger(value) || value < 1 || value > max) invalid(`${name} must be between 1 and ${max}.`);
    return value;
  }

  function screenshot(value, name) {
    if (value === undefined || value === null) return null;
    object(value, name);
    const data = string(value.data_url, `${name}.data_url`, { limit: MAX_SCREENSHOT_CHARS });
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!match || match[1].length % 4 !== 0) invalid(`${name} must contain an inline PNG image.`);
    let bytes;
    try { bytes = atob(match[1]); }
    catch (_) { invalid(`${name} contains invalid PNG base64.`); }
    const byte = (index) => bytes.charCodeAt(index);
    const integer = (index) => byte(index) * 16777216 + byte(index + 1) * 65536 + byte(index + 2) * 256 + byte(index + 3);
    if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((part, index) => byte(index) === part)
      || integer(8) !== 13 || bytes.slice(12, 16) !== 'IHDR' || bytes.slice(-8, -4) !== 'IEND') {
      invalid(`${name} is not a complete PNG image.`);
    }
    const width = dimensions(value.width, `${name}.width`, 960);
    const height = dimensions(value.height, `${name}.height`, 2000);
    if (integer(16) !== width || integer(20) !== height) invalid(`${name} dimensions do not match the PNG.`);
    const viewport = value.viewport === undefined || value.viewport === null ? {} : object(value.viewport, `${name}.viewport`);
    const viewportPart = (part) => viewport[part] === undefined || viewport[part] === null ? null
      : dimensions(viewport[part], `${name}.viewport.${part}`, 4096);
    const sourceHash = value.source_hash === undefined || value.source_hash === null ? null
      : string(value.source_hash, `${name}.source_hash`, { limit: 64 });
    if (sourceHash !== null && !/^[a-f0-9]{64}$/.test(sourceHash)) invalid(`${name}.source_hash is invalid.`);
    return {
      data_url: data, width, height, viewport: { width: viewportPart('width'), height: viewportPart('height') },
      source_hash: sourceHash, captured_at: timestamp(value.captured_at, `${name}.captured_at`),
    };
  }

  function response(value, index) {
    const name = `Response ${index + 1}`;
    object(value, name);
    if (value.index !== undefined && value.index !== index) invalid(`${name} has an inconsistent index.`);
    const explanationStatus = choice(value.explanation_status, ['provided', 'unavailable'], `${name} explanation status`, 'unavailable');
    const explanation = value.explanation === undefined || value.explanation === null ? null
      : string(value.explanation, `${name} explanation`);
    if (explanationStatus === 'provided' && !explanation?.trim()) invalid(`${name} marks an empty explanation as provided.`);
    return {
      text: string(value.text, `${name} text`),
      grade: value.grade === undefined ? null : verdict(value.grade, `${name} grade`),
      feedback: string(value.feedback, `${name} feedback`, { optional: true }),
      explanation: explanationStatus === 'provided' ? explanation : null,
      explanationStatus,
      screenshot: screenshot(value.screenshot, `${name} screenshot`),
      screenshotError: string(value.screenshot_error, `${name} screenshot error`, { optional: true, nullable: true }) || '',
    };
  }

  function criterion(value, index, responseCount, defaultModel, globalMode, warnings) {
    const name = `Criterion ${index + 1}`;
    object(value, name);
    const id = value.id;
    if (!(Number.isSafeInteger(id) && id >= 0)
      && !(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))) invalid(`${name} has an invalid id.`);
    const title = string(value.title, `${name} title`, { limit: 2000 });
    if (!title.trim()) invalid(`${name} title cannot be empty.`);
    const description = string(value.description, `${name} description`, { optional: true });
    const kind = choice(value.kind, ['llm', 'python'], `${name} kind`);
    const mode = choice(value.evaluation_mode, ['source', 'screenshot'], `${name} grading input`, 'source');
    if (kind === 'python' && mode !== 'source') invalid(`${name} Python checks must use source-only grading.`);
    const enabled = boolean(value.enabled, `${name} enabled flag`, true);
    const kept = boolean(value.kept, `${name} kept flag`, true);
    const originalStatus = choice(value.status, ['draft', 'generating', 'running', 'done', 'error', 'unknown'], `${name} status`, 'draft');
    const candidates = list(value.candidates, `${name} candidates`, MAX_CANDIDATES);
    if (kind === 'llm' && candidates.length && mode !== globalMode) invalid(`${name} grading input does not match this session.`);
    const usedModel = model(value.model, `${name} model`);
    const results = [], errors = [], assertions = [];
    candidates.forEach((candidate, candidateIndex) => {
      const candidateName = `${name}, candidate ${candidateIndex + 1}`;
      object(candidate, candidateName);
      if (candidate.index !== undefined && candidate.index !== candidateIndex) invalid(`${candidateName} has an inconsistent index.`);
      if (candidate.kind !== undefined && candidate.kind !== kind) invalid(`${candidateName} type differs from its criterion.`);
      if (candidate.evaluation_mode !== undefined && candidate.evaluation_mode !== mode) invalid(`${candidateName} grading input differs from its criterion.`);
      const candidateModel = model(candidate.model, `${candidateName} model`);
      if (candidateModel !== usedModel) invalid(`${candidateName} model differs from its criterion.`);
      assertions.push(string(candidate.source, `${candidateName} source`));
      const row = list(candidate.verdicts, `${candidateName} verdicts`, responseCount);
      const errorRow = list(candidate.errors, `${candidateName} errors`, responseCount);
      if (row.length !== responseCount || errorRow.length !== responseCount) invalid(`${candidateName} needs one verdict and error entry per response.`);
      const restoredErrors = errorRow.map((error, output) => error === null ? null
        : string(error, `${candidateName}, response ${output + 1} error`) || null);
      results.push(row.map((item, output) => {
        const restored = verdict(item, `${candidateName}, response ${output + 1} verdict`);
        if (restoredErrors[output] && restored !== null) {
          warnings.add('Error-bearing verdicts were restored as unknown so they cannot be selected.');
          return null;
        }
        return restored;
      }));
      errors.push(restoredErrors);
    });
    const interrupted = originalStatus === 'generating' || originalStatus === 'running';
    const anyComplete = results.some((row, candidateIndex) => row.every((item) => item !== null) && !errors[candidateIndex].some(Boolean));
    const partial = candidates.length > 0 && (!anyComplete || interrupted);
    const restoredStatus = !candidates.length ? 'draft' : partial || originalStatus === 'error' ? 'error' : 'done';
    const originalError = string(value.error, `${name} error`, { optional: true, nullable: true }) || '';
    if (interrupted) warnings.add('Interrupted evaluations are restored as partial and can be implemented again.');
    const completed = results.reduce((sum, row, candidateIndex) => sum + row.filter((item, output) => item !== null || errors[candidateIndex][output]).length, 0);
    return {
      id, title, description, kind, on: enabled, keep: kept,
      status: restoredStatus, model: usedModel, modelKnown: usedModel !== null,
      assertions, results: candidates.length ? results : null, errors,
      error: originalError || (partial ? 'Imported evaluation is incomplete. Implement this criterion again to finish it.' : ''),
      built: description ? `${title}: ${description}` : title, builtKind: kind,
      evaluationMode: kind === 'python' ? 'source' : mode,
      builtEvaluationMode: kind === 'python' ? 'source' : mode,
      completed, totalChecks: candidates.length * responseCount, runId: 0,
    };
  }

  function review(snapshot, type, warnings) {
    const candidates = snapshot.criteria.reduce((total, item) => total + item.assertions.length, 0);
    return {
      type, snapshot,
      summary: {
        responseCount: snapshot.responses.length, criterionCount: snapshot.criteria.length,
        candidateCount: candidates,
        gradedCount: snapshot.responses.filter((item) => item.grade !== null).length,
        screenshotCount: snapshot.responses.filter((item) => item.screenshot).length,
        explanationCount: snapshot.responses.filter((item) => item.explanationStatus === 'provided').length,
        partialCriterionCount: snapshot.criteria.filter((item) => item.status === 'error').length,
        outputFormat: snapshot.outputFormat, actualSampleModel: snapshot.sampleModel,
      },
      warnings: [...warnings],
    };
  }

  function parseSessionImport(jsonText) {
    if (typeof jsonText !== 'string') invalid('Choose a JSON text file to import.');
    if (new TextEncoder().encode(jsonText).length > MAX_FILE_BYTES) invalid('Import files must be 20 MiB or smaller.');
    let payload;
    try { payload = JSON.parse(jsonText.replace(/^\uFEFF/, '')); }
    catch (_) { invalid('The selected file is not valid JSON.'); }
    const warnings = new Set();
    if (Array.isArray(payload) || (payload && typeof payload === 'object' && !own(payload, 'schema_version') && own(payload, 'outputs'))) {
      const source = Array.isArray(payload) ? {} : object(payload, 'Imported results');
      const outputs = list(Array.isArray(payload) ? payload : source.outputs, 'Outputs', MAX_RESPONSES);
      if (!outputs.length) invalid('Raw results must contain at least one output.');
      const sampleModel = model(source.model, 'Sample model');
      const details = source.output_details === undefined ? null : list(source.output_details, 'Output details', outputs.length);
      if (details && details.length !== outputs.length) invalid('Output details must contain one entry per output.');
      const snapshot = {
        prompt: string(source.prompt, 'Prompt', { optional: true }),
        outputFormat: choice(source.output_format, ['text', 'svg', 'html'], 'Output format', 'text'),
        evaluationMode: 'source',
        responses: outputs.map((output, index) => {
          const detail = details ? object(details[index], `Output ${index + 1} details`) : {};
          return response({ text: string(output, `Output ${index + 1}`),
            explanation: detail.explanation, explanation_status: detail.explanation_status }, index);
        }),
        criteria: [], threshold: 0.4, models: { prompt: sampleModel, evaluator: null },
        defaultModel: null, sampleModel, sampleModelKnown: sampleModel !== null,
        sampledAt: timestamp(source.sampled_at, 'Sample timestamp'),
        report: null, reported: [], sampling: null, nextHigh: true,
      };
      if (!sampleModel) warnings.add('The original sampling model is unknown. Current model selectors will be used only for new work.');
      return review(snapshot, 'results', warnings);
    }
    const source = object(payload, 'Imported session');
    if (source.schema_version !== 1) invalid(`Unsupported session schema version: ${String(source.schema_version ?? 'missing')}. Expected version 1.`);
    const responses = list(source.responses, 'Responses', MAX_RESPONSES).map(response);
    const screenshotCharacters = responses.reduce((total, item) => total + (item.screenshot?.data_url.length || 0), 0);
    if (screenshotCharacters > MAX_SCREENSHOT_TOTAL) invalid('Imported screenshots exceed the combined 3,000,000-character image budget.');
    const models = source.models === undefined ? {} : object(source.models, 'Model provenance');
    const defaultModel = model(models.default_model, 'Default model');
    const sampleModel = own(models, 'actual_sample_model') ? model(models.actual_sample_model, 'Actual sample model') : defaultModel;
    const outputFormat = choice(source.output_format, ['text', 'svg', 'html'], 'Output format', 'text');
    const mode = choice(source.evaluation_mode, ['source', 'screenshot'], 'Grading input', 'source');
    if (outputFormat === 'text' && mode === 'screenshot') invalid('Screenshot grading requires SVG or HTML output.');
    if (outputFormat === 'text' && responses.some((item) => item.screenshot)) invalid('Text sessions cannot contain artifact screenshots.');
    const criteria = list(source.criteria, 'Criteria', MAX_CRITERIA)
      .map((item, index) => criterion(item, index, responses.length, defaultModel, mode, warnings));
    if (new Set(criteria.map((item) => String(item.id))).size !== criteria.length) invalid('Criterion IDs must be unique.');
    const settings = source.settings === undefined ? {} : object(source.settings, 'Settings');
    const threshold = settings.ffr_threshold === undefined || settings.ffr_threshold === null ? 0.4 : settings.ffr_threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) invalid('False failure rate threshold must be a number between 0 and 1.');
    const metadata = source.session === undefined ? {} : object(source.session, 'Session metadata');
    const savedNextHigh = source.sampling && typeof source.sampling === 'object' && !Array.isArray(source.sampling)
      ? source.sampling.next_high : undefined;
    const snapshot = {
      prompt: string(source.prompt, 'Prompt', { optional: true }), outputFormat, evaluationMode: mode,
      responses, criteria, threshold,
      models: { prompt: model(models.current_query_model, 'Query model'), evaluator: model(models.current_evaluator_model, 'Evaluator model') },
      defaultModel, sampleModel, sampleModelKnown: sampleModel !== null,
      sampledAt: timestamp(metadata.sampled_at, 'Sample timestamp'),
      report: null, reported: [], sampling: null,
      nextHigh: boolean(savedNextHigh === null ? undefined : savedNextHigh, 'Grading sampler alternation flag', true),
    };
    if (!sampleModel && responses.length) warnings.add('The original sampling model is unknown. Current model selectors will be used only for new work.');
    if (source.report || source.sampling) warnings.add('Saved alignment and sampler calculations will be recomputed from the imported grades and verdicts.');
    return review(snapshot, 'session', warnings);
  }

  return Object.freeze({ parseSessionImport, MAX_FILE_BYTES, MAX_RESPONSES });
}));
