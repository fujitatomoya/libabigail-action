#!/usr/bin/env node
// Unit tests for scripts/post-comment.js: rendering, verdict aggregation,
// artifact loading, label reconciliation, fork-PR diagnostics, and the
// workflow_run publish flow. Runs with plain node (no dependencies):
//
//   node test/test-publish.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = require('../scripts/post-comment.js');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeCore() {
  const log = { info: [], warning: [], error: [], notice: [], failed: [], outputs: {} };
  return {
    log,
    info: (m) => log.info.push(m),
    warning: (m) => log.warning.push(m),
    error: (m) => log.error.push(m),
    notice: (m) => log.notice.push(m),
    setFailed: (m) => log.failed.push(m),
    setOutput: (k, v) => { log.outputs[k] = v; },
  };
}

function httpError(status, message) {
  const e = new Error(message || `HTTP ${status}`);
  e.status = status;
  return e;
}

// Minimal Octokit stand-in. `state` records every write; `fail` makes every
// write throw the given error.
function fakeGithub({ comments = [], labels = [], fail = null, prHead = null, associated = [], listed = [] } = {}) {
  const state = { comments: comments.map((c, i) => ({ id: i + 1, body: c })), labels: [...labels], calls: [] };
  const write = (name, fn) => async (args) => {
    state.calls.push({ name, args });
    if (fail) throw fail;
    return fn(args);
  };
  const github = {
    state,
    paginate: async (fn, args) => (await fn(args)).data,
    rest: {
      issues: {
        listComments: async () => ({ data: state.comments }),
        updateComment: write('updateComment', ({ comment_id, body }) => {
          const c = state.comments.find((x) => x.id === comment_id);
          c.body = body;
          return { data: c };
        }),
        createComment: write('createComment', ({ body }) => {
          const c = { id: state.comments.length + 100, body };
          state.comments.push(c);
          return { data: c };
        }),
        addLabels: write('addLabels', ({ labels: ls }) => {
          for (const l of ls) if (!state.labels.includes(l)) state.labels.push(l);
          return { data: state.labels };
        }),
        removeLabel: write('removeLabel', ({ name }) => {
          if (!state.labels.includes(name)) throw httpError(404, 'Label does not exist');
          state.labels = state.labels.filter((l) => l !== name);
          return { data: state.labels };
        }),
      },
      pulls: {
        get: async () => ({ data: { head: { sha: prHead } } }),
        list: async () => ({ data: listed }),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: async () => ({ data: associated }),
      },
    },
  };
  return github;
}

function context({ payload = {}, owner = 'ros2', repo = 'rclcpp' } = {}) {
  return { payload, repo: { owner, repo } };
}

function entry(over = {}) {
  return {
    library: 'libfoo.so', verdict: 'compatible', summary: 'No ABI changes detected.',
    baseLib: 'base/libfoo.so', headLib: 'head/libfoo.so', suppressions: '', headSha: '',
    report: '', source: '', ...over,
  };
}

function writeBundle(root, name, json, report) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (json !== null) {
    fs.writeFileSync(path.join(dir, 'verdict.json'), typeof json === 'string' ? json : JSON.stringify(json));
  }
  if (report !== undefined) fs.writeFileSync(path.join(dir, 'abidiff-report.txt'), report);
  return dir;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('normalizeVerdict maps unknown values to error', () => {
  assert.strictEqual(mod.normalizeVerdict('compatible'), 'compatible');
  assert.strictEqual(mod.normalizeVerdict('additions-only'), 'additions-only');
  assert.strictEqual(mod.normalizeVerdict('incompatible'), 'incompatible');
  assert.strictEqual(mod.normalizeVerdict('bogus'), 'error');
  assert.strictEqual(mod.normalizeVerdict(''), 'error');
});

test('overallVerdict is the worst verdict, null when empty', () => {
  assert.strictEqual(mod.overallVerdict([]), null);
  assert.strictEqual(mod.overallVerdict([entry()]), 'compatible');
  assert.strictEqual(mod.overallVerdict([entry(), entry({ verdict: 'additions-only' })]), 'additions-only');
  assert.strictEqual(mod.overallVerdict([entry({ verdict: 'incompatible' }), entry({ verdict: 'additions-only' })]), 'incompatible');
  assert.strictEqual(mod.overallVerdict([entry({ verdict: 'incompatible' }), entry({ verdict: 'error' })]), 'error');
});

test('sanitizeMarkerSuffix keeps the marker comment-safe', () => {
  assert.strictEqual(mod.sanitizeMarkerSuffix('abi-librclcpp.so'), 'abi-librclcpp.so');
  assert.strictEqual(mod.sanitizeMarkerSuffix('x --> <script>'), 'x------script-');
  assert.strictEqual(mod.sanitizeMarkerSuffix(''), 'abi-check');
});

test('isForkPullRequest compares head repo with the base repo', () => {
  const same = context({ payload: { pull_request: { head: { repo: { full_name: 'ros2/rclcpp' } } } } });
  const fork = context({ payload: { pull_request: { head: { repo: { full_name: 'someone/rclcpp' } } } } });
  assert.strictEqual(mod.isForkPullRequest(same), false);
  assert.strictEqual(mod.isForkPullRequest(fork), true);
  assert.strictEqual(mod.isForkPullRequest(context()), false);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('renderComment: single entry keeps the classic layout', () => {
  const { body, marker, overall } = mod.renderComment(
    [entry({ report: 'Functions changes summary: 0 Removed, 0 Changed, 0 Added function', suppressions: '.abignore' })],
    { headSha: '0123456789abcdef', markerSuffix: 'abi-check' },
  );
  assert.strictEqual(overall, 'compatible');
  assert.strictEqual(marker, '<!-- libabigail-action-marker:abi-check -->');
  assert.ok(body.startsWith('## ABI Compliance Check\n\n✅ **Verdict: compatible**\n\nNo ABI changes detected.'));
  assert.ok(body.includes('- Base: `base/libfoo.so`'));
  assert.ok(body.includes('- Head: `head/libfoo.so` @ 0123456'));
  assert.ok(body.includes('<details><summary>Full abidiff report</summary>'));
  assert.ok(body.includes('suppressions: `.abignore`'));
  assert.ok(body.trimEnd().endsWith(marker));
  assert.ok(!body.includes('| Library |'), 'no table for a single library');
});

test('renderComment: several entries get a table and per-library details', () => {
  const entries = [
    entry({ library: 'libb.so', verdict: 'incompatible', summary: 'ABI changed: 1 removed | pipe', report: 'removed: foo()' }),
    entry({ library: 'liba.so', verdict: 'additions-only', summary: 'ABI changed but only with additions (backward-compatible).' }),
  ];
  const { body, overall } = mod.renderComment(entries, { headSha: 'abcdef0123456789' });
  assert.strictEqual(overall, 'incompatible');
  assert.ok(body.includes('❌ **Verdict: incompatible**'));
  assert.ok(body.includes('| Library | Verdict | Summary |'));
  assert.ok(body.includes('| `libb.so` | ❌ incompatible | ABI changed: 1 removed \\| pipe |'), 'pipes are escaped in cells');
  assert.ok(body.includes('<code>libb.so</code> — full abidiff report'));
  assert.ok(body.includes('<code>liba.so</code> — full abidiff report'));
  assert.ok(body.includes('(empty report — no differences printed by abidiff)'));
  assert.ok(body.includes('removed: foo()'));
});

test('renderComment: zero entries explains the missing verdict', () => {
  const { body, overall } = mod.renderComment([], {});
  assert.strictEqual(overall, 'error');
  assert.ok(body.includes('No ABI verdict was produced'));
});

test('renderComment: long reports are truncated to stay under the comment limit', () => {
  const big = 'x'.repeat(200000);
  const entries = [1, 2, 3, 4].map((i) => entry({ library: `lib${i}.so`, report: big }));
  const { body } = mod.renderComment(entries, {});
  assert.ok(body.length < 65536, `body length ${body.length} must stay under the GitHub limit`);
  assert.strictEqual((body.match(/report truncated/g) || []).length, 4);
});

test('renderComment: backticks in names cannot break out of inline code', () => {
  const { body } = mod.renderComment([entry({ baseLib: 'a`b.so' })], {});
  assert.ok(body.includes('- Base: `a\'b.so`'));
});

// ---------------------------------------------------------------------------
// Artifact loading
// ---------------------------------------------------------------------------

test('loadVerdicts reads every bundle, validates verdicts, and only trusts report basenames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libabigail-publish-'));
  try {
    writeBundle(root, 'abidiff-rclcpp-librclcpp.so', {
      schema: 1, library: 'librclcpp.so', verdict: 'compatible', summary: 'No ABI changes detected.',
      base_lib: 'lib-base/librclcpp.so', head_lib: 'lib-pr/librclcpp.so', report: 'abidiff-report.txt', head_sha: 'deadbeef',
    }, 'report A');
    writeBundle(root, 'abidiff-rclcpp-librclcpp_action.so', {
      schema: 1, library: 'librclcpp_action.so', verdict: 'incompatible', summary: 'ABI-incompatible changes detected.',
      report: '../../../../etc/passwd',
    }, 'report B');
    writeBundle(root, 'abidiff-bogus', { verdict: 'totally-fine' }, 'report C');
    writeBundle(root, 'abidiff-broken', '{ not json', 'report D');
    writeBundle(root, 'no-verdict-here', null, 'orphan report');

    const core = fakeCore();
    const entries = mod.loadVerdicts(root, core);
    assert.deepStrictEqual(entries.map((e) => e.library), [
      'abidiff-bogus', 'abidiff-broken', 'librclcpp.so', 'librclcpp_action.so',
    ]);
    const byLib = Object.fromEntries(entries.map((e) => [e.library, e]));
    assert.strictEqual(byLib['librclcpp.so'].verdict, 'compatible');
    assert.strictEqual(byLib['librclcpp.so'].report, 'report A');
    assert.strictEqual(byLib['librclcpp.so'].headSha, 'deadbeef');
    // A path in "report" is reduced to its basename inside the bundle directory.
    assert.strictEqual(byLib['librclcpp_action.so'].report, '', 'passwd must not be read');
    assert.strictEqual(byLib['abidiff-bogus'].verdict, 'error');
    assert.ok(byLib['abidiff-bogus'].summary.includes('undetermined'));
    assert.strictEqual(byLib['abidiff-broken'].verdict, 'error');
    assert.strictEqual(core.log.warning.length, 1, 'malformed JSON is warned about once');
    assert.strictEqual(mod.overallVerdict(entries), 'error');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerdicts on a missing directory returns nothing', () => {
  assert.deepStrictEqual(mod.loadVerdicts('/nonexistent/dir', fakeCore()), []);
  assert.deepStrictEqual(mod.loadVerdicts('', fakeCore()), []);
});

// ---------------------------------------------------------------------------
// Publishing (in-job)
// ---------------------------------------------------------------------------

test('publish creates the comment and adds the compat label, removing the break label', async () => {
  const github = fakeGithub({ labels: ['ABI break'] });
  const core = fakeCore();
  const res = await mod.publish({
    github, context: context(), core, entries: [entry()], prNumber: 7, headSha: 'abc1234',
    labelCompat: 'ABI compatible', labelBreak: 'ABI break',
  });
  assert.strictEqual(res.verdict, 'compatible');
  assert.strictEqual(res.failures.length, 0);
  assert.strictEqual(github.state.comments.length, 1);
  assert.deepStrictEqual(github.state.labels, ['ABI compatible']);
});

test('publish updates the existing sticky comment instead of creating another', async () => {
  const marker = '<!-- libabigail-action-marker:abi-check -->';
  const github = fakeGithub({ comments: ['unrelated', `old body\n${marker}`] });
  const core = fakeCore();
  await mod.publish({ github, context: context(), core, entries: [entry({ verdict: 'incompatible' })], prNumber: 7 });
  assert.strictEqual(github.state.comments.length, 2);
  assert.ok(github.state.comments[1].body.includes('❌ **Verdict: incompatible**'));
  assert.ok(github.state.calls.some((c) => c.name === 'updateComment'));
  assert.ok(!github.state.calls.some((c) => c.name === 'createComment'));
});

test('publish (non-strict) on a fork PR turns 403s into warnings plus one fork hint', async () => {
  const github = fakeGithub({ fail: httpError(403, 'Resource not accessible by integration') });
  const core = fakeCore();
  const res = await mod.publish({
    github, context: context(), core, entries: [entry()], prNumber: 7,
    isFork: true, strict: false, labelCompat: 'ABI compatible', labelBreak: 'ABI break',
  });
  assert.strictEqual(res.failures.length, 3, 'comment + addLabels + removeLabel');
  assert.strictEqual(core.log.warning.length, 3);
  assert.strictEqual(core.log.error.length, 0);
  assert.strictEqual(core.log.failed.length, 0, 'never fails the job in non-strict mode');
  assert.deepStrictEqual(core.log.notice, [mod.FORK_HINT]);
});

test('publish (non-strict) on a same-repo PR with a 403 points at permissions', async () => {
  const github = fakeGithub({ fail: httpError(403, 'Resource not accessible by integration') });
  const core = fakeCore();
  await mod.publish({ github, context: context(), core, entries: [entry()], prNumber: 7, isFork: false });
  assert.deepStrictEqual(core.log.notice, [mod.PERMISSION_HINT]);
});

test('publish (strict) fails the step on write errors', async () => {
  const github = fakeGithub({ fail: httpError(403, 'nope') });
  const core = fakeCore();
  await mod.publish({ github, context: context(), core, entries: [entry()], prNumber: 7, strict: true });
  assert.strictEqual(core.log.error.length, 1);
  assert.strictEqual(core.log.failed.length, 1);
});

test('publish with comment-pr=false only touches labels', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await mod.publish({
    github, context: context(), core, entries: [entry({ verdict: 'incompatible' })], prNumber: 7,
    commentPr: false, labelCompat: 'ABI compatible', labelBreak: 'ABI break',
  });
  assert.strictEqual(github.state.comments.length, 0);
  assert.deepStrictEqual(github.state.labels, ['ABI break']);
});

test('publishFromJob skips outside pull_request events', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  const res = await mod.publishFromJob({ github, context: context({ payload: {} }), core, env: {} });
  assert.strictEqual(res.skipped, 'no-pr');
  assert.strictEqual(github.state.calls.length, 0);
});

// ---------------------------------------------------------------------------
// PR resolution and the workflow_run flow
// ---------------------------------------------------------------------------

test('findPullRequest prefers the payload, then the head commit, then owner:branch', async () => {
  const core = fakeCore();
  const ctx = context();
  const run = { head_sha: 'feed', head_branch: 'fix', head_repository: { owner: { login: 'someone' } } };

  assert.strictEqual(await mod.findPullRequest(fakeGithub(), ctx, core, { ...run, pull_requests: [{ number: 5 }] }), 5);

  const byCommit = fakeGithub({ associated: [
    { number: 8, state: 'closed', head: { sha: 'feed' } },
    { number: 9, state: 'open', head: { sha: 'feed' } },
  ] });
  assert.strictEqual(await mod.findPullRequest(byCommit, ctx, core, run), 9, 'only open PRs at this head');

  const byBranch = fakeGithub({ listed: [{ number: 11, head: { sha: 'other' } }, { number: 12, head: { sha: 'feed' } }] });
  assert.strictEqual(await mod.findPullRequest(byBranch, ctx, core, run), 12);

  assert.strictEqual(await mod.findPullRequest(fakeGithub(), ctx, core, run), 0);
});

test('publishFromArtifacts: workflow_run for a fork PR aggregates bundles into one comment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libabigail-publish-'));
  try {
    writeBundle(root, 'abidiff-a', { library: 'liba.so', verdict: 'compatible', summary: 'ok' }, '');
    writeBundle(root, 'abidiff-b', { library: 'libb.so', verdict: 'additions-only', summary: 'adds' }, 'added: bar()');
    const github = fakeGithub({ prHead: 'feed', associated: [{ number: 3268, state: 'open', head: { sha: 'feed' } }] });
    const core = fakeCore();
    const ctx = context({ payload: { workflow_run: { id: 1, head_sha: 'feed', head_branch: 'fix', head_repository: { owner: { login: 'someone' } } } } });
    const res = await mod.publishFromArtifacts({
      github, context: ctx, core,
      env: { VERDICTS_DIR: root, LABEL_COMPAT: 'ABI compatible', LABEL_BREAK: 'ABI break', MARKER_SUFFIX: 'ros2-abi' },
    });
    assert.strictEqual(res.prNumber, 3268);
    assert.strictEqual(res.verdict, 'additions-only');
    assert.strictEqual(res.count, 2);
    assert.strictEqual(github.state.comments.length, 1);
    assert.ok(github.state.comments[0].body.includes('| `liba.so` | ✅ compatible | ok |'));
    assert.ok(github.state.comments[0].body.endsWith('<!-- libabigail-action-marker:ros2-abi -->'));
    assert.deepStrictEqual(github.state.labels, ['ABI compatible']);
    assert.deepStrictEqual(core.log.outputs, { verdict: 'additions-only', 'pr-number': '3268', count: '2' });
    assert.strictEqual(core.log.failed.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishFromArtifacts: stale run does not overwrite a newer head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libabigail-publish-'));
  try {
    writeBundle(root, 'abidiff-a', { library: 'liba.so', verdict: 'incompatible', summary: 'bad' }, '');
    const github = fakeGithub({ prHead: 'newer', associated: [{ number: 1, state: 'open', head: { sha: 'old' } }] });
    const core = fakeCore();
    const ctx = context({ payload: { workflow_run: { id: 1, head_sha: 'old' } } });
    const res = await mod.publishFromArtifacts({ github, context: ctx, core, env: { VERDICTS_DIR: root, LABEL_BREAK: 'ABI break' } });
    assert.strictEqual(res.skipped, 'stale');
    assert.strictEqual(github.state.comments.length, 0);
    assert.deepStrictEqual(github.state.labels, []);
    assert.strictEqual(core.log.notice.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishFromArtifacts: no PR and no bundles are notices, not failures', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  const ctx = context({ payload: { workflow_run: { id: 1, head_sha: 'x' } } });
  const res = await mod.publishFromArtifacts({ github, context: ctx, core, env: { VERDICTS_DIR: '/nonexistent' } });
  assert.strictEqual(res.skipped, 'no-pr');
  assert.strictEqual(core.log.failed.length, 0);
  assert.deepStrictEqual(core.log.outputs, { verdict: '', 'pr-number': '', count: '0' });

  const core2 = fakeCore();
  const ctx2 = context({ payload: { pull_request: { number: 4, head: { sha: 'x' } } } });
  const github2 = fakeGithub({ prHead: 'x' });
  const res2 = await mod.publishFromArtifacts({ github: github2, context: ctx2, core: core2, env: { VERDICTS_DIR: '/nonexistent' } });
  assert.strictEqual(res2.skipped, 'no-verdicts');
  assert.strictEqual(github2.state.comments.length, 0, 'comment and labels are left untouched');
  assert.strictEqual(core2.log.failed.length, 0);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL ${t.name}\n${e.stack || e}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
