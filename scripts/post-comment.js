// Sticky PR comment + label management for libabigail-action.
//
// Two entry points share this module:
//
//   - action.yml (in-job): one verdict, posted from the pull_request job
//     itself. Works for pull requests from the same repository only: on
//     pull_request events from a fork GitHub hands the job a read-only token,
//     so every write fails with 403 (reported as a warning, never a failure).
//
//   - publish/action.yml (workflow_run): any number of verdicts read from the
//     report artifacts of a finished check run, posted from a trusted
//     workflow_run job in the base repository. Fork pull requests get their
//     comment and labels this way.
//
// Everything read from artifacts is untrusted data produced in the PR
// context: verdicts are validated against the known set, report files are
// looked up by basename next to their verdict.json, all other fields are
// displayed as text.

const fs = require('fs');
const path = require('path');

const VERDICTS = ['compatible', 'additions-only', 'incompatible', 'error'];
const SEVERITY = { 'compatible': 0, 'additions-only': 1, 'incompatible': 2, 'error': 3 };
const ICON = { 'compatible': '✅', 'additions-only': '✅', 'incompatible': '❌', 'error': '⚠️' };
const TITLE = {
  'compatible': 'compatible',
  'additions-only': 'compatible (additions only)',
  'incompatible': 'incompatible',
  'error': 'error',
};

// GitHub comment hard limit is 65536 chars; leave headroom for the wrapper.
const MAX_COMMENT_CHARS = 60000;
const WRAPPER_RESERVE = 4000;
const MIN_REPORT_BUDGET = 1500;

const FORK_HINT =
  'This pull request comes from a fork: on pull_request events GitHub gives the job a ' +
  'read-only GITHUB_TOKEN regardless of the workflow\'s permissions block, so the sticky ' +
  'comment and labels cannot be written from this job. Publish them from a workflow_run ' +
  'workflow with fujitatomoya/libabigail-action/publish instead (see README, "Fork pull requests").';
const PERMISSION_HINT =
  'The token lacks write access. Grant `pull-requests: write` and `issues: write` to the ' +
  'calling workflow (or pass a token that has them via github-token).';

function normalizeVerdict(v) {
  return VERDICTS.includes(v) ? v : 'error';
}

// Worst verdict across entries; null when there are none.
function overallVerdict(entries) {
  let worst = null;
  for (const e of entries) {
    if (worst === null || SEVERITY[e.verdict] > SEVERITY[worst]) worst = e.verdict;
  }
  return worst;
}

function sanitizeMarkerSuffix(s) {
  const clean = String(s || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
  return clean || 'abi-check';
}

function shortSha(sha) {
  return /^[0-9a-f]{7,40}$/i.test(sha || '') ? sha.substring(0, 7) : '';
}

// Inline-code safe: a backtick would close the span.
function code(s) {
  return String(s || '').replace(/`/g, '\'');
}

// Table-cell safe: pipes and newlines would break the row.
function cell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function isForkPullRequest(context) {
  const pr = context.payload && context.payload.pull_request;
  if (!pr || !pr.head || !pr.head.repo || !pr.head.repo.full_name) return false;
  return pr.head.repo.full_name !== `${context.repo.owner}/${context.repo.repo}`;
}

// One verdict from the in-job environment (action.yml).
function entryFromEnv(env) {
  const reportPath = env.REPORT_PATH || '';
  let report = '';
  if (reportPath && fs.existsSync(reportPath)) report = fs.readFileSync(reportPath, 'utf8');
  const headLib = env.HEAD_LIB || '';
  return {
    library: env.LIBRARY || path.basename(headLib),
    verdict: normalizeVerdict(env.VERDICT || 'error'),
    summary: env.SUMMARY || '',
    baseLib: env.BASE_LIB || '',
    headLib,
    suppressions: env.SUPPRESSIONS || '',
    headSha: env.HEAD_SHA || '',
    report,
    source: reportPath,
  };
}

// One verdict from a verdict.json written by scripts/write-verdict.sh.
function readEntry(file, core) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    core.warning(`${file}: not valid JSON (${e.message}); recorded as an error verdict.`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) data = {};
  const str = (v) => (typeof v === 'string' ? v : '');

  const entry = {
    library: str(data.library) || path.basename(path.dirname(file)),
    verdict: normalizeVerdict(str(data.verdict)),
    summary: str(data.summary),
    baseLib: str(data.base_lib),
    headLib: str(data.head_lib),
    suppressions: str(data.suppressions),
    headSha: str(data.head_sha),
    report: '',
    source: file,
  };
  if (entry.verdict === 'error' && !entry.summary) {
    entry.summary = 'verdict.json is missing or unrecognized; ABI verdict is undetermined.';
  }

  // The report lives next to verdict.json; only its basename is honoured so a
  // crafted artifact cannot point outside its own directory.
  const reportName = path.basename(str(data.report) || 'abidiff-report.txt');
  const reportPath = path.join(path.dirname(file), reportName);
  if (fs.existsSync(reportPath) && fs.statSync(reportPath).isFile()) {
    entry.report = fs.readFileSync(reportPath, 'utf8');
  }
  return entry;
}

// Every verdict.json below dir. actions/download-artifact places each
// artifact in its own sub-directory (merge-multiple: false), so several
// libraries do not collide.
function loadVerdicts(dir, core) {
  const entries = [];
  if (!dir || !fs.existsSync(dir)) return entries;
  const walk = (d) => {
    for (const dirent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, dirent.name);
      if (dirent.isDirectory()) walk(p);
      else if (dirent.isFile() && dirent.name === 'verdict.json') entries.push(readEntry(p, core));
    }
  };
  walk(dir);
  // Plain code-point order: stable across runner locales.
  entries.sort((a, b) => (a.library < b.library ? -1 : a.library > b.library ? 1 : 0));
  return entries;
}

function renderComment(entries, { headSha = '', markerSuffix = 'abi-check' } = {}) {
  const marker = `<!-- libabigail-action-marker:${sanitizeMarkerSuffix(markerSuffix)} -->`;
  const overall = overallVerdict(entries) || 'error';
  const sha = shortSha(headSha);
  const single = entries.length === 1;

  const lines = [
    '## ABI Compliance Check',
    '',
    `${ICON[overall]} **Verdict: ${TITLE[overall]}**`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('No ABI verdict was produced by the check run (no verdict.json found in its artifacts).', '');
  } else if (single) {
    const e = entries[0];
    lines.push(e.summary, '');
    lines.push('Compared:', `- Base: \`${code(e.baseLib)}\``, `- Head: \`${code(e.headLib)}\`${sha ? ` @ ${sha}` : ''}`, '');
  } else {
    lines.push('| Library | Verdict | Summary |', '|---|---|---|');
    for (const e of entries) {
      lines.push(`| \`${code(e.library)}\` | ${ICON[e.verdict]} ${e.verdict} | ${cell(e.summary)} |`);
    }
    lines.push('');
  }

  // Share the comment budget between libraries.
  const budget = Math.max(
    MIN_REPORT_BUDGET,
    Math.floor((MAX_COMMENT_CHARS - WRAPPER_RESERVE) / Math.max(entries.length, 1)),
  );
  for (const e of entries) {
    const title = single
      ? 'Full abidiff report'
      : `${ICON[e.verdict]} <code>${code(e.library)}</code> — full abidiff report`;
    let body = e.report.length === 0
      ? '(empty report — no differences printed by abidiff)'
      : e.report;
    let note = '';
    if (body.length > budget) {
      body = body.slice(0, budget);
      note = '\n... (report truncated; see the full report in the workflow run artifacts)';
    }
    lines.push(`<details><summary>${title}</summary>`, '');
    if (!single) {
      lines.push('Compared:', `- Base: \`${code(e.baseLib)}\``, `- Head: \`${code(e.headLib)}\`${sha ? ` @ ${sha}` : ''}`, '');
    }
    lines.push('```', body + note, '```', '', '</details>', '');
  }

  const suppressions = [...new Set(entries.map((e) => e.suppressions).filter(Boolean))];
  lines.push(
    `<sub>Updated for commit ${sha || '(unknown)'}` +
      (suppressions.length ? ` · suppressions: ${suppressions.map((s) => `\`${code(s)}\``).join(', ')}` : '') +
      '</sub>',
    marker,
  );
  return { body: lines.join('\n'), marker, overall };
}

async function upsertComment(github, core, { owner, repo, prNumber, marker, body }) {
  const existing = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  const found = existing.find((c) => c.body && c.body.includes(marker));
  if (found) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: found.id, body });
    core.info(`Updated existing ABI check comment id=${found.id}.`);
    return { id: found.id, created: false };
  }
  const created = await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  core.info(`Created ABI check comment id=${created.data.id}.`);
  return { id: created.data.id, created: true };
}

// Returns the list of errors (empty on success); 404 on remove is not an error.
async function reconcileLabels(github, core, { owner, repo, prNumber, verdict, labelCompat, labelBreak }) {
  const isCompatible = (verdict === 'compatible' || verdict === 'additions-only');
  const isBreak = (verdict === 'incompatible');
  const toAdd = [];
  const toRemove = [];
  if (labelCompat) (isCompatible ? toAdd : toRemove).push(labelCompat);
  if (labelBreak) (isBreak ? toAdd : toRemove).push(labelBreak);

  const errors = [];
  if (toAdd.length) {
    try {
      await github.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: toAdd });
      core.info(`Added labels: ${toAdd.join(', ')}`);
    } catch (e) {
      errors.push({ op: `addLabels(${toAdd.join(', ')})`, error: e });
    }
  }
  for (const name of toRemove) {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name });
      core.info(`Removed label: ${name}`);
    } catch (e) {
      if (e.status !== 404) errors.push({ op: `removeLabel(${name})`, error: e });
    }
  }
  return errors;
}

// Post the comment and reconcile labels for a set of entries on one PR.
//
//   strict: false  -> failures are warnings (in-job mode: fork PRs are expected)
//   strict: true   -> failures fail the step (publish mode: a real misconfiguration)
async function publish({
  github, context, core, entries, prNumber, headSha,
  isFork = false, strict = false,
  commentPr = true, labelCompat = '', labelBreak = '', markerSuffix = 'abi-check',
}) {
  const { owner, repo } = context.repo;
  const { body, marker, overall } = renderComment(entries, { headSha, markerSuffix });
  const failures = [];

  if (commentPr) {
    try {
      await upsertComment(github, core, { owner, repo, prNumber, marker, body });
    } catch (e) {
      failures.push({ op: 'post / update PR comment', error: e });
    }
  } else {
    core.info('comment-pr=false; skipping sticky comment.');
  }

  failures.push(...await reconcileLabels(github, core, {
    owner, repo, prNumber, verdict: overall, labelCompat, labelBreak,
  }));

  const report = strict ? core.error.bind(core) : core.warning.bind(core);
  for (const f of failures) report(`${f.op} failed: ${f.error && f.error.message ? f.error.message : f.error}`);
  if (failures.some((f) => f.error && f.error.status === 403)) {
    core.notice(isFork ? FORK_HINT : PERMISSION_HINT);
  }
  if (strict && failures.length) {
    core.setFailed(`${failures.length} write(s) to pull request #${prNumber} failed.`);
  }
  return { verdict: overall, failures, body };
}

// workflow_run payloads carry no pull_requests for fork PRs; resolve the PR
// by head commit, then by head "owner:branch". Only open PRs at that exact
// head are accepted, so a stale or merged PR is never annotated.
async function findPullRequest(github, context, core, run) {
  const { owner, repo } = context.repo;
  if (Array.isArray(run.pull_requests) && run.pull_requests.length) {
    return run.pull_requests[0].number;
  }
  try {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner, repo, commit_sha: run.head_sha,
    });
    const open = data.filter((p) => p.state === 'open' && p.head && p.head.sha === run.head_sha);
    if (open.length) return open[0].number;
  } catch (e) {
    core.info(`listPullRequestsAssociatedWithCommit(${run.head_sha}) failed: ${e.message}`);
  }
  if (run.head_repository && run.head_repository.owner && run.head_repository.owner.login && run.head_branch) {
    const head = `${run.head_repository.owner.login}:${run.head_branch}`;
    try {
      const { data } = await github.rest.pulls.list({ owner, repo, state: 'open', head, per_page: 10 });
      const match = data.find((p) => p.head && p.head.sha === run.head_sha);
      if (match) return match.number;
    } catch (e) {
      core.info(`pulls.list(head=${head}) failed: ${e.message}`);
    }
  }
  return 0;
}

// Entry point of publish/action.yml. Configuration comes through env.
async function publishFromArtifacts({ github, context, core, env }) {
  const { owner, repo } = context.repo;
  const dir = env.VERDICTS_DIR || '';
  const commentPr = (env.COMMENT_PR || 'true').toLowerCase() === 'true';
  const skipStale = (env.SKIP_STALE || 'true').toLowerCase() === 'true';
  const setOutputs = (verdict, prNumber, count) => {
    core.setOutput('verdict', verdict || '');
    core.setOutput('pr-number', prNumber ? String(prNumber) : '');
    core.setOutput('count', String(count));
  };

  const entries = loadVerdicts(dir, core);
  core.info(`Found ${entries.length} verdict file(s) under ${dir || '(unset)'}.`);

  const run = context.payload && context.payload.workflow_run;
  const pr = context.payload && context.payload.pull_request;
  let prNumber = parseInt(env.PR_NUMBER || '', 10) || 0;
  let headSha = env.HEAD_SHA || '';
  if (!headSha && run) headSha = run.head_sha || '';
  if (!headSha && pr) headSha = (pr.head && pr.head.sha) || '';
  if (!headSha) headSha = entries.map((e) => e.headSha).find(Boolean) || '';
  if (!prNumber && pr) prNumber = pr.number;
  if (!prNumber && run) prNumber = await findPullRequest(github, context, core, run);

  if (!prNumber) {
    core.notice('No open pull request could be associated with this run; nothing to publish.');
    setOutputs(overallVerdict(entries), 0, entries.length);
    return { verdict: overallVerdict(entries), prNumber: 0, count: entries.length, skipped: 'no-pr' };
  }

  if (skipStale && headSha) {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (data.head && data.head.sha && data.head.sha !== headSha) {
      core.notice(`Pull request #${prNumber} has moved on to ${shortSha(data.head.sha)}; not publishing the verdict for ${shortSha(headSha)}.`);
      setOutputs(overallVerdict(entries), prNumber, entries.length);
      return { verdict: overallVerdict(entries), prNumber, count: entries.length, skipped: 'stale' };
    }
  }

  if (entries.length === 0) {
    core.notice(`No verdict.json found under ${dir}; the check run produced no ABI verdict (build failure, cancelled, or artifact-pattern mismatch). Comment and labels left untouched.`);
    setOutputs('', prNumber, 0);
    return { verdict: '', prNumber, count: 0, skipped: 'no-verdicts' };
  }

  const result = await publish({
    github, context, core, entries, prNumber, headSha,
    isFork: false, strict: true,
    commentPr,
    labelCompat: env.LABEL_COMPAT || '',
    labelBreak: env.LABEL_BREAK || '',
    markerSuffix: env.MARKER_SUFFIX || 'abi-check',
  });
  setOutputs(result.verdict, prNumber, entries.length);
  return { verdict: result.verdict, prNumber, count: entries.length, failures: result.failures };
}

// Entry point of action.yml (in-job). Configuration comes through env.
async function publishFromJob({ github, context, core, env = process.env }) {
  const pr = context.payload && context.payload.pull_request;
  if (!pr) {
    core.info('Not a pull_request event; skipping PR comment and labels.');
    return { skipped: 'no-pr' };
  }
  const entry = entryFromEnv(env);
  return publish({
    github, context, core,
    entries: [entry],
    prNumber: pr.number,
    headSha: (pr.head && pr.head.sha) || '',
    isFork: isForkPullRequest(context),
    strict: false,
    commentPr: (env.COMMENT_PR || 'true').toLowerCase() === 'true',
    labelCompat: env.LABEL_COMPAT || '',
    labelBreak: env.LABEL_BREAK || '',
    markerSuffix: env.MARKER_SUFFIX || 'abi-check',
  });
}

module.exports = publishFromJob;
Object.assign(module.exports, {
  VERDICTS,
  FORK_HINT,
  PERMISSION_HINT,
  normalizeVerdict,
  overallVerdict,
  sanitizeMarkerSuffix,
  isForkPullRequest,
  entryFromEnv,
  readEntry,
  loadVerdicts,
  renderComment,
  upsertComment,
  reconcileLabels,
  publish,
  findPullRequest,
  publishFromArtifacts,
  publishFromJob,
});
