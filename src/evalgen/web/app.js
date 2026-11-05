// EvalGen page, laid out after the prototype in Shankar et al. (UIST 2024):
// a Prompt node wired to a Multi-Evaluator node, a wizard (start, pick criteria,
// grade, report card), and a table view. All model text goes through textContent.

const GRADE_FIRST_MIN = 5;

const state = {
  prompt: '',          // prompt the current responses came from
  responses: [],       // { text, grade: true | false | null, feedback }
  criteria: [],        // { id, title, description, on, keep, status, assertions, results, error }
  suggesting: false,
  draft: '',           // unsent text in the add-criterion box
  report: null,
  reported: [],        // criterion ids in report order
  threshold: 0.4,
  models: { prompt: null, evaluator: null },  // null means the config.toml default
  progress: { total: 0, done: 0 },
  wizard: { open: false, screen: 'start', gradeFirst: false, index: 0, reached: new Set(['start']) },
};
let nextId = 1;

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

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return data;
}

// ---------- Pipeline ----------

async function runPrompt() {
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  if (implementing()) { toast('Wait for the evaluator to finish first'); return; }
  const evaluated = state.criteria.some((c) => c.status !== 'draft');
  if (evaluated && !confirm('Running the prompt replaces the responses and grades, and resets evaluator results. Continue?')) return;

  const button = $('btn-run');
  const status = $('prompt-status');
  const count = Math.min(10, Math.max(1, Number($('num-responses').value) || 1));
  button.disabled = true;
  button.classList.add('busy');
  status.classList.remove('error');
  status.textContent = `Sampling ${count} responses...`;
  try {
    const { outputs } = await api('/api/sample', { prompt, count, model: state.models.prompt });
    state.prompt = prompt;
    state.responses = outputs.map((text) => ({ text, grade: null, feedback: '' }));
    state.criteria.forEach((c) => Object.assign(c, { status: 'draft', assertions: [], results: null }));
    state.report = null;
    state.reported = [];
    state.wizard.index = 0;
    status.textContent = '';
  } catch (error) {
    status.textContent = 'Failed';
    status.classList.add('error');
    toast(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
    render();
  }
}

async function suggest() {
  state.suggesting = true;
  render();
  try {
    const { criteria } = await api('/api/criteria', {
      prompt: state.prompt,
      graded: state.responses
        .filter((r) => r.grade !== null)
        .map((r) => ({ output: r.text, good: r.grade, feedback: r.feedback })),
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
    id: nextId++, title, description, on: true, keep: true,
    status: 'draft', assertions: [], results: null, error: '',
  });
}

function tick(steps = 1) {
  state.progress.done += steps;
  render();
}

async function implement(criterion) {
  let remaining = 2;
  try {
    criterion.status = 'generating';
    criterion.built = label(criterion);
    criterion.model = state.models.evaluator;
    render();
    const { assertions } = await api('/api/assertions', {
      prompt: state.prompt, criteria: [label(criterion)], model: criterion.model,
    });
    criterion.assertions = assertions[0] || [];
    remaining -= 1;
    tick();
    if (!criterion.assertions.length) throw new Error(`No assertions could be parsed for "${criterion.title}"`);
    criterion.status = 'running';
    render();
    const { results } = await api('/api/evaluate', {
      prompt: state.prompt,
      assertions: [criterion.assertions],
      outputs: state.responses.map((r) => r.text),
      model: criterion.model,
    });
    criterion.results = results[0];
    criterion.status = 'done';
    remaining -= 1;
    tick();
  } catch (error) {
    criterion.status = 'error';
    criterion.error = error.message;
    toast(error.message);
    tick(remaining);
  }
  refreshReport();
}

function implementAll() {
  const targets = state.criteria.filter((c) => c.on && (c.status === 'draft' || c.status === 'error'));
  if (!implementing()) state.progress = { total: 0, done: 0 };
  state.progress.total += targets.length * 2;
  state.wizard.gradeFirst = false;
  const next = state.responses.findIndex((r) => r.grade === null);
  state.wizard.index = next === -1 ? 0 : next;
  go('grade');
  targets.forEach(implement);
}

let reportSeq = 0;
async function refreshReport() {
  const done = state.criteria.filter((c) => c.on && c.status === 'done');
  const seq = ++reportSeq;
  if (!done.length) {
    state.report = null;
    state.reported = [];
    render();
    return;
  }
  try {
    const report = await api('/api/report', {
      results: done.map((c) => c.results),
      grades: state.responses.map((r) => r.grade),
      ffr_threshold: state.threshold,
      active: done.map((c) => c.keep),
    });
    if (seq !== reportSeq) return;
    state.report = report;
    state.reported = done.map((c) => c.id);
    render();
  } catch (error) {
    toast(error.message);
  }
}

function reportFor(criterion) {
  const index = state.reported.indexOf(criterion.id);
  return index === -1 || !state.report ? null : state.report.criteria[index];
}

// ---------- Canvas ----------

function renderPromptNode() {
  $('prompt-ok').hidden = !state.responses.length;
  $('btn-run').disabled = implementing();
  // One evaluator model per run, so a criterion's assertions and verdicts come from the same model
  $('eval-model').disabled = implementing() || state.suggesting;
}

function renderEvalNode() {
  const body = $('eval-body');
  const built = state.criteria.filter((c) => c.on && c.status !== 'draft');
  if (!built.length) {
    body.replaceChildren(el('div', { class: 'eval-empty' },
      el('button', {
        class: 'btn', disabled: !state.responses.length,
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
    const alignment = report && report.selected !== null ? report.scores[report.selected].alignment : null;
    const busy = c.status === 'generating' || c.status === 'running';
    return el('div', { class: 'eval-row' },
      busy ? el('span', { class: 'spinner' }) : el('input', {
        type: 'checkbox', checked: c.keep, title: 'Use in the table view',
        onchange: (e) => { c.keep = e.target.checked; refreshReport(); },
      }),
      el('span', { class: 'name', title: label(c) }, c.title),
      el('span', { class: 'kind' }, c.status === 'error' ? 'error' : 'LLM'),
      el('span', { class: 'pct-pill', style: `background: ${toneFor(alignment)}` }, pct(alignment)),
    );
  });
  body.replaceChildren(
    el('div', { class: 'eval-list' }, rows),
    el('div', { class: 'eval-actions' },
      el('button', { class: 'btn', onclick: () => openWizard('criteria') }, icon('pencil'), 'Edit criteria'),
      el('button', { class: 'btn primary', onclick: () => openWizard(implementing() ? 'grade' : 'report') }, icon('sparkles'), 'Open EvalGen'),
    ),
  );
}

function verdictPill(verdict) {
  if (verdict === true) return el('span', { class: 'verdict pass' }, 'pass');
  if (verdict === false) return el('span', { class: 'verdict fail' }, 'fail');
  return el('span', { class: 'verdict none', title: 'The grader gave no readable verdict' }, '?');
}

function gradeMark(grade) {
  if (grade === true) return el('span', { class: 'grade-mark good', title: 'Graded good' }, icon('up', 15));
  if (grade === false) return el('span', { class: 'grade-mark bad', title: 'Graded bad' }, icon('down', 15));
  return el('span', { class: 'grade-mark none', title: 'Ungraded' }, '-');
}

function renderTable() {
  const body = $('table-body');
  const columns = state.criteria.filter((c) => c.on && c.keep && c.status !== 'draft');
  $('table-meta').textContent = state.responses.length ? `${state.responses.length} responses, ${graded()} graded` : '';
  if (!state.responses.length) {
    body.replaceChildren(el('p', { class: 'hint' }, 'Responses and evaluation results appear here.'));
    return;
  }
  const head = el('tr', {},
    el('th', {}, '#'), el('th', {}, 'Response'), el('th', { class: 'center' }, 'Grade'),
    columns.map((c) => {
      const report = reportFor(c);
      const fallback = c.status === 'done' && (!report || report.selected === null);
      return el('th', { class: 'crit center', title: fallback ? 'No aligned assertion yet, showing the first candidate' : label(c) },
        c.title, fallback ? ' *' : '');
    }),
  );
  const rows = state.responses.map((r, i) => el('tr', {},
    el('td', {}, String(i + 1)),
    el('td', { class: 'response' }, r.text),
    el('td', { class: 'center' }, gradeMark(r.grade)),
    columns.map((c) => {
      if (c.status !== 'done') return el('td', { class: 'center' }, c.status === 'error' ? '!' : el('span', { class: 'spinner' }));
      const report = reportFor(c);
      const chosen = report && report.selected !== null ? report.selected : 0;
      return el('td', { class: 'center' }, verdictPill(c.results[chosen][i]));
    }),
  ));
  body.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, rows))));
}

// ---------- Wizard ----------

const STEPS = [['start', 'Start'], ['criteria', 'Criteria'], ['grade', 'Grade'], ['report', 'Report card']];

function openWizard(screen) {
  state.wizard.open = true;
  $('wizard').hidden = false;
  document.body.style.overflow = 'hidden';
  go(screen);
}

function closeWizard() {
  state.wizard.open = false;
  $('wizard').hidden = true;
  document.body.style.overflow = '';
  render();
}

function go(screen) {
  state.wizard.screen = screen;
  state.wizard.reached.add(screen);
  if (screen === 'report' || screen === 'criteria') state.wizard.reached.add('grade');
  render();
  $('wizard').scrollTop = 0;
}

function screenStart() {
  const ready = state.responses.length > 0;
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
  const locked = c.status === 'generating' || c.status === 'running';
  // Text is stored on every keystroke so background re-renders keep it
  const type = (field) => (e) => { c[field] = e.target.value; };
  const commit = (field) => (e) => {
    c[field] = e.target.value.trim() || (field === 'title' ? 'Untitled' : '');
    if (c.status !== 'draft' && label(c) !== c.built) Object.assign(c, { status: 'draft', assertions: [], results: null });
    refreshReport();
  };
  const statusNote = {
    done: el('span', { class: 'hint' }, 'Implemented'),
    error: el('span', { class: 'hint', style: 'color: var(--red)' }, 'Failed, implement again'),
    generating: el('span', { class: 'hint' }, 'Implementing...'),
    running: el('span', { class: 'hint' }, 'Implementing...'),
  }[c.status];
  return el('div', { class: 'card' + (c.on ? '' : ' off') },
    el('div', { class: 'card-head' },
      el('input', { type: 'checkbox', checked: c.on, disabled: locked, onchange: (e) => { c.on = e.target.checked; refreshReport(); } }),
      el('input', { class: 'card-title', type: 'text', value: c.title, disabled: locked, 'data-key': `title-${c.id}`, oninput: type('title'), onchange: commit('title') }),
      el('button', {
        class: 'icon-btn', title: 'Delete', disabled: locked,
        onclick: () => { state.criteria = state.criteria.filter((x) => x !== c); refreshReport(); },
      }, icon('trash')),
    ),
    el('textarea', {
      class: 'card-desc', rows: 2, value: c.description, disabled: locked, placeholder: 'Describe the criterion',
      'data-key': `desc-${c.id}`, oninput: type('description'), onchange: commit('description'),
    }),
    el('div', { class: 'card-foot', style: 'justify-content: space-between; align-items: center' },
      statusNote || el('span'),
      el('div', { class: 'seg' },
        el('button', { class: 'seg-btn', disabled: true, title: 'Code assertions would run model-written Python, which needs a sandbox' }, icon('code', 13), 'Code'),
        el('button', { class: 'seg-btn active' }, icon('bot', 13), 'LLM'),
      ),
    ),
  );
}

function screenCriteria() {
  const input = el('input', {
    type: 'text', placeholder: 'the response is valid JSON', 'data-key': 'new-criterion', value: state.draft,
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
      el('button', { class: 'btn blue' + (state.suggesting ? ' busy' : ''), disabled: state.suggesting, onclick: suggest },
        state.suggesting ? null : icon('repeat'), state.suggesting ? null : icon('sparkles'), 'Suggest more'),
    ),
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'hint', style: 'text-align: center' }, 'No criteria yet. Type one above or ask for suggestions.'),
    el('div', { class: 'center-row' },
      el('button', {
        class: 'btn implement', disabled: !state.criteria.some((c) => c.on),
        onclick: () => (pending ? implementAll() : go(implementing() ? 'grade' : 'report')),
      }, icon('sparkles'), pending ? "I'm done. Implement it!" : 'Continue'),
    ),
  ];
}

function setGrade(value) {
  const r = state.responses[state.wizard.index];
  r.grade = r.grade === value ? null : value;
  if (r.grade !== null) {
    const n = state.responses.length;
    for (let step = 1; step < n; step += 1) {
      const j = (state.wizard.index + step) % n;
      if (state.responses[j].grade === null) { state.wizard.index = j; break; }
    }
  }
  refreshReport();
  render();
}

function screenGrade() {
  const n = state.responses.length;
  const w = state.wizard;
  const r = state.responses[w.index];
  const move = (delta) => { w.index = (w.index + delta + n) % n; render(); };
  const need = Math.min(GRADE_FIRST_MIN, n);
  const count = graded();

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
        el('span', {}, busy ? 'Generating and selecting implementations...' : 'Implementations ready. Keep grading, or finish when you like.'),
        el('div', { class: 'progress' }, el('div', { class: 'progress-fill', style: `width: ${total ? (100 * done) / total : 100}%` }))),
      el('button', { class: 'btn outline', onclick: () => go('report') }, "I'm tired"),
    ];
  }

  return [
    el('div', { class: 'screen-title' }, 'Is this response', icon('up', 20), 'or', icon('down', 20), '?'),
    el('div', { class: 'grade-row' },
      el('button', { class: 'nav-btn', title: 'Previous', disabled: n < 2, onclick: () => move(-1) }, icon('left', 22)),
      el('div', { class: 'response-box' + (r.grade === true ? ' good' : r.grade === false ? ' bad' : '') }, r.text),
      el('button', { class: 'nav-btn', title: 'Next', disabled: n < 2, onclick: () => move(1) }, icon('right', 22)),
    ),
    el('div', { class: 'response-count' }, `Response ${w.index + 1} of ${n} · ${count} graded`),
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
    el('div', { class: 'center-row' },
      el('button', { class: 'btn bad' + (r.grade === false ? ' active' : ''), onclick: () => setGrade(false) }, icon('down'), 'Bad!'),
      el('button', { class: 'btn good' + (r.grade === true ? ' active' : ''), onclick: () => setGrade(true) }, icon('up'), 'Good!'),
    ),
    el('div', { class: 'grade-foot' }, footer),
  ];
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
      type: 'checkbox', checked: c.keep, disabled: c.status !== 'done', title: 'Keep this criterion in the evaluator',
      onchange: (e) => { c.keep = e.target.checked; refreshReport(); },
    }),
    el('span', { class: 'card-title', style: 'border: 0' }, c.title),
  );
  if (c.status === 'generating' || c.status === 'running') {
    const what = c.status === 'generating'
      ? 'Writing candidate assertions...'
      : `Running ${c.assertions.length} assertions on ${state.responses.length} responses...`;
    return el('div', { class: 'card' }, head, el('div', { class: 'pending' }, el('span', { class: 'spinner' }), what));
  }
  if (c.status === 'error') {
    return el('div', { class: 'card off' }, head, el('div', { class: 'pending', style: 'color: var(--red)' }, c.error));
  }
  const report = reportFor(c);
  const chosen = report && report.selected !== null ? report.selected : null;
  const others = c.assertions.map((text, i) => ({ text, i })).filter(({ i }) => i !== chosen);
  return el('div', { class: 'card' + (c.keep ? '' : ' off') },
    head,
    el('div', { class: 'rcard-body' },
      el('div', { class: 'rcard-text' },
        c.description ? el('span', { class: 'rcard-desc' }, c.description) : null,
        el('span', { class: 'rcard-kind' }, `LLM · ${c.model || 'default'}`),
        chosen !== null
          ? el('div', { class: 'chosen' }, c.assertions[chosen])
          : el('span', { class: 'hint' }, graded() ? 'No candidate is under the false failure threshold.' : 'Grade responses to pick an implementation.'),
      ),
      donut(chosen !== null ? report.scores[chosen] : null),
    ),
    others.length ? el('details', { class: 'bad-impls' },
      el('summary', {}, chosen === null ? 'Show implementations' : 'Show bad implementations', icon('chevron')),
      el('ul', {}, others.map(({ text, i }) => {
        const score = report ? report.scores[i] : null;
        return el('li', {}, el('b', {}, score ? `align ${pct(score.alignment)} · FFR ${pct(score.ffr)}  ` : ''), text);
      })),
    ) : null,
  );
}

function screenReport() {
  const overall = state.report ? state.report.overall : null;
  const built = state.criteria.filter((c) => c.on && c.status !== 'draft');
  return [
    el('div', { class: 'screen-title' }, 'Chosen Functions and Alignment'),
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'Coverage of Bad Responses'), el('div', { class: 'tile-value blue' }, pct(overall && overall.coverage))),
      el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'False Failure Rate'), el('div', { class: 'tile-value red' }, pct(overall && overall.ffr))),
    ),
    el('div', { class: 'threshold' },
      el('label', { for: 'ffr' }, 'Max false failure rate per assertion'),
      el('input', {
        type: 'range', id: 'ffr', min: 0, max: 1, step: 0.05, value: state.threshold, 'data-key': 'ffr',
        oninput: (e) => { state.threshold = Number(e.target.value); e.target.nextSibling.textContent = pct(state.threshold); },
        onchange: refreshReport,
      }),
      el('span', { class: 'threshold-value' }, pct(state.threshold)),
    ),
    built.length
      ? el('div', { class: 'cards' }, built.map(reportCard))
      : el('p', { class: 'hint', style: 'text-align: center' }, 'No criteria implemented yet.'),
    el('div', { class: 'center-row' },
      el('button', { class: 'btn', onclick: () => go('grade') }, 'Back to grading'),
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
  $('wizard-body').replaceChildren(...screens[state.wizard.screen]());
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
  renderEvalNode();
  renderTable();
  if (state.wizard.open) renderWizard();
}

// ---------- Events ----------

$('btn-run').addEventListener('click', runPrompt);
$('wizard-close').addEventListener('click', closeWizard);
$('wizard').addEventListener('click', (e) => { if (e.target === $('wizard')) closeWizard(); });
document.addEventListener('keydown', (e) => {
  if (!state.wizard.open) return;
  if (e.key === 'Escape') { closeWizard(); return; }
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (state.wizard.screen !== 'grade' || typing || !state.responses.length) return;
  const n = state.responses.length;
  if (e.key === 'ArrowLeft') { state.wizard.index = (state.wizard.index - 1 + n) % n; render(); }
  if (e.key === 'ArrowRight') { state.wizard.index = (state.wizard.index + 1) % n; render(); }
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

function fillModels(models, fallback) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MODELS_KEY)) || {}; } catch (e) { /* storage blocked */ }
  [['prompt', 'prompt-model'], ['evaluator', 'eval-model']].forEach(([role, id]) => {
    const select = $(id);
    const names = models.includes(fallback) ? models : [fallback, ...models];
    select.replaceChildren(...names.map((name) => el('option', { value: name }, name)));
    select.value = names.includes(saved[role]) ? saved[role] : fallback;
    state.models[role] = select.value;
    select.addEventListener('change', () => {
      state.models[role] = select.value;
      try { localStorage.setItem(MODELS_KEY, JSON.stringify(state.models)); } catch (e) { /* storage blocked */ }
    });
  });
}

(async function boot() {
  syncAppearance();
  render();
  const chip = $('server-chip');
  try {
    const info = await api('/api/info');
    state.threshold = info.ffr_threshold;
    chip.textContent = new URL(info.base_url).host;
    chip.title = `LLM server ${info.base_url}`;
    try {
      const { models, default: fallback } = await api('/api/models');
      fillModels(models, fallback);
    } catch (error) {
      fillModels([], info.model);
      toast(`Could not list models, using ${info.model}: ${error.message}`);
    }
  } catch (error) {
    chip.textContent = 'offline';
    chip.classList.add('offline');
    toast(error.message);
  }
})();
