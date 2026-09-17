# libabigail-action

[![ci](https://github.com/fujitatomoya/libabigail-action/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fujitatomoya/libabigail-action/actions/workflows/ci.yml?query=branch%3Amain)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A reusable GitHub Action that detects **ABI-breaking changes** in C/C++ shared libraries on every pull request, using [libabigail](https://sourceware.org/libabigail/)'s `abidiff`.

The action takes two pre-built shared libraries — typically the target branch's baseline and the PR's head build — diffs them, and surfaces the verdict as:

- a **PR check** that passes / fails per a configurable `fail-on` policy,
- a **sticky PR comment** updated in place on every push,
- optional **labels** so maintainers can scan ABI status at a glance,
- the **full `abidiff` report** plus a machine-readable **`verdict.json`** uploaded as a workflow artifact.

The action is deliberately repo-agnostic: it knows nothing about any specific build system or framework.
You produce the two `.so` files however you like; this action only diffs them.

Pull requests from **forks** need one extra workflow: on `pull_request` events from a fork the job token is read-only, so the comment and labels are posted afterwards by the [`publish` sub-action](#fork-pull-requests) from a `workflow_run` workflow.

Inspired by the unmaintained [buildsi/libabigail-action](https://github.com/buildsi/libabigail-action).

---

## Quick start

```yaml
# .github/workflows/abi.yml
name: ABI Compliance Check
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write   # comment + label
  issues: write          # label

jobs:
  abi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build baseline
        run: |
          # Build the target branch into /tmp/base and produce a .so
          # with -g (DWARF). Replace this with your real build.
          ...

      - name: Build head
        run: |
          # Build the PR head into ./build with -g (DWARF).
          ...

      - uses: fujitatomoya/libabigail-action@v1
        with:
          base-lib: /tmp/base/build/libmylib.so
          head-lib: build/libmylib.so
          # Optional:
          suppressions:    .abignore
          headers-dir-base: /tmp/base/include
          headers-dir-head: include
          fail-on:         incompatible
          label-compat:    abi-compatible
          label-break:     abi-break
```

A complete, copy-pasteable template lives at [test/workflow.yml](test/workflow.yml).

---

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `base-lib` | yes | — | Path to the baseline `.so` (must be built with `-g`). |
| `head-lib` | yes | — | Path to the PR-built `.so` (must be built with `-g`). |
| `suppressions` | no | — | Path to a libabigail suppression spec file (e.g. `.abignore`). |
| `headers-dir-base` | no | — | Public-headers dir for the baseline; filters the ABI surface. |
| `headers-dir-head` | no | — | Public-headers dir for the head build; filters the ABI surface. |
| `fail-on` | no | `incompatible` | `none` \| `addition` \| `change` \| `incompatible`. See [Verdict logic](#verdict-logic). |
| `comment-pr` | no | `true` | Post / update a sticky PR comment. |
| `label-compat` | no | — | Label applied when the verdict is compatible or additions-only. |
| `label-break` | no | — | Label applied when the verdict is incompatible. |
| `report-name` | no | `abidiff-report` | Artifact name for the report bundle (`abidiff-report.txt` + `verdict.json`). Use a distinct name per invocation in a run; the `publish` sub-action selects bundles by glob (`abidiff-*`). |
| `library` | no | head-lib file name | Display name of the library in the comment and in `verdict.json`. |
| `abidiff-extra-args` | no | — | Extra arguments passed verbatim to `abidiff`. |
| `marker-suffix` | no | `abi-check` | Suffix in the sticky-comment HTML marker, so multiple ABI checks (e.g. one per library) can coexist on a single PR. |
| `github-token` | no | `${{ github.token }}` | Token used to read / write PR comments and labels. |

## Outputs

| Name | Description |
|---|---|
| `exit-code` | Raw `abidiff` bitmap exit code. |
| `verdict` | `compatible` \| `additions-only` \| `incompatible` \| `error`. |
| `report` | Filesystem path to the full `abidiff` text report (also uploaded as an artifact). |
| `verdict-file` | Filesystem path to `verdict.json` (uploaded next to the report). |
| `report-dir` | Directory uploaded as the report artifact. |
| `summary` | One-line human-readable verdict summary. |

---

## Verdict logic

`abidiff` returns a bitmap, but the bitmap alone cannot classify every change: per `abidiff(1)`, `ABIDIFF_ABI_CHANGE` (bit 4) only means "the ABIs are different" — it is set for harmless additions *and* for modified declarations that libabigail flags as "possibly incompatible, needs human review" (e.g. a parameter or return type change on a symbol whose name is unchanged). `ABIDIFF_ABI_INCOMPATIBLE_CHANGE` (bit 8) is set only for *proven* incompatibilities (removed symbols, vtable changes, …). So the action decodes in two stages:

| `abidiff` result | Verdict |
|---|---|
| exit `0` | `compatible` |
| `ABIDIFF_ABI_INCOMPATIBLE_CHANGE` (with or without `ABI_CHANGE`) | `incompatible` |
| `ABIDIFF_ABI_CHANGE` only, report summary shows any `Removed` or `Changed` declarations | `incompatible` |
| `ABIDIFF_ABI_CHANGE` only, report summary shows only `Added` declarations | `additions-only` |
| `ABIDIFF_ABI_CHANGE` only, report unreadable / unclassifiable | `incompatible` (fail-safe, with a workflow warning) |
| `ABIDIFF_ERROR` or `ABIDIFF_USAGE_ERROR` | `error` |

The second stage parses the report's `… changes summary:` lines (e.g. `Functions changes summary: 0 Removed, 1 Changed, 0 Added function`), which is the only place `abidiff` distinguishes additions from modifications.

`fail-on` decides which verdicts cause the job to fail:

| `fail-on` | Pass | Fail |
|---|---|---|
| `none` | every non-error verdict | _(only `error` fails)_ |
| `addition` | `compatible` | `additions-only`, `incompatible` |
| `change` | `compatible` | `additions-only`, `incompatible` (same as `addition` today; reserved for finer-grained future policy) |
| `incompatible` *(default)* | `compatible`, `additions-only` | `incompatible` |

`error` always fails the job, regardless of `fail-on` — when `abidiff` itself errors out, the verdict is undetermined and callers cannot trust it.

The split between `incompatible` and `additions-only` is the part that matters for **backports**: additions-only changes are safe to backport to a released, ABI-stable branch, but breaking changes are not.

---

## Sticky PR comment

````markdown
## ABI Compliance Check

✅ **Verdict: compatible (additions only)**

ABI changed but only with additions (backward-compatible).

Compared:
- Base: `libmylib.so`
- Head: `libmylib.so` @ abc1234

<details><summary>Full abidiff report</summary>

```
…raw abidiff output…
```

</details>

<sub>Updated for commit abc1234 · suppressions: `.abignore`</sub>
<!-- libabigail-action-marker:abi-check -->
````

The trailing HTML marker line identifies the comment for find-and-update; rebases and force-pushes don't spam new comments.
If you run multiple ABI checks on a single PR (e.g. one per library), give each invocation a distinct `marker-suffix`.

When the [`publish` sub-action](#fork-pull-requests) posts several libraries at once, the comment carries the **worst** verdict in its title, a per-library table, and one collapsible report per library:

```markdown
## ABI Compliance Check

❌ **Verdict: incompatible**

| Library | Verdict | Summary |
|---|---|---|
| `librclcpp.so` | ✅ compatible | No ABI changes detected. |
| `librclcpp_action.so` | ❌ incompatible | ABI-incompatible changes detected. |
```

---

## Required permissions

For the sticky comment and label reconciliation to work, the calling workflow must grant:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
```

If you only want the check (no comment, no labels), set `comment-pr: 'false'` and leave `label-*` empty; then `contents: read` alone is enough.

**This is not sufficient for pull requests from forks.** On `pull_request` events from a fork GitHub hands the job a read-only `GITHUB_TOKEN` whatever the `permissions:` block says; every write then fails with `Resource not accessible by integration`. The action reports that as a warning plus a hint and never fails the job, because the ABI verdict itself is still valid. See the next section for how to publish anyway.

---

## Fork pull requests

The check job must build and diff the pull request's code, so GitHub deliberately runs it with a read-only token when that code comes from a fork. Writing the comment and labels therefore has to happen in a second workflow that:

1. is triggered by `workflow_run` when the check workflow completes (any conclusion),
2. runs the workflow file from the **default branch** of the base repository with a normal write token,
3. never checks out or executes anything from the pull request,
4. reads the verdicts from the check run's report artifacts and posts them.

That second workflow is a few lines with the `publish` sub-action ([complete template](test/workflow-report.yml)):

```yaml
# .github/workflows/abi-report.yml
name: ABI Compliance Check (report)
on:
  workflow_run:
    workflows: ["ABI Compliance Check"]   # the `name:` of your check workflow
    types: [completed]

permissions:
  contents: read
  pull-requests: write
  issues: write
  actions: read                          # download the check run's artifacts

jobs:
  report:
    if: github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: fujitatomoya/libabigail-action/publish@v1
        with:
          run-id: ${{ github.event.workflow_run.id }}
          label-compat: abi-compatible
          label-break: abi-break
```

In the check workflow set `comment-pr: 'false'` and leave `label-*` empty so the check job does not try (and fail) to post by itself; the report artifact it uploads is all the publisher needs.

Notes:

- `workflow_run` workflows only start firing once the file exists on the default branch.
- The publisher resolves the pull request from the run's head commit (then from `owner:branch`), because the `workflow_run` payload lists no `pull_requests` for forks. Only an **open** PR at exactly that head is annotated; if the PR has moved on, the run is skipped (`skip-stale`).
- The check run's pass / fail status is unchanged; the publisher only adds the comment and labels.
- Everything in the artifact was produced in the PR context and is treated as data: unknown verdicts become `error`, report files are looked up by basename only, names are displayed as text. A malicious PR can at most make its own report look odd, exactly as it could by editing its source.

### `publish` inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `run-id` | no | — | Run whose report artifacts to download (`github.event.workflow_run.id`). Empty: publish what is already under `verdicts-dir`. |
| `artifact-pattern` | no | `abidiff-*` | Glob selecting the report bundles of that run. |
| `verdicts-dir` | no | `$RUNNER_TEMP/libabigail-verdicts` | Where the bundles are downloaded to / read from (one sub-directory per artifact). |
| `pr-number` | no | auto | Pull request to annotate; resolved from the payload when empty. |
| `head-sha` | no | `workflow_run.head_sha` | Commit the verdicts belong to. |
| `skip-stale` | no | `true` | Do nothing when the PR head has moved past `head-sha`. |
| `comment-pr` | no | `true` | Post / update one sticky comment covering every library. |
| `label-compat` | no | — | Label applied when every library is compatible / additions-only. |
| `label-break` | no | — | Label applied when any library is incompatible. |
| `marker-suffix` | no | `abi-check` | Sticky-comment marker suffix. |
| `github-token` | no | `${{ github.token }}` | Needs `actions: read`, `pull-requests: write`, `issues: write`. |

### `publish` outputs

| Name | Description |
|---|---|
| `verdict` | Worst verdict across libraries; empty when nothing was published. |
| `pr-number` | Pull request that was annotated; empty when none could be resolved. |
| `count` | Number of `verdict.json` files found. |

### `verdict.json`

Each report artifact holds `abidiff-report.txt` and this file, written by [scripts/write-verdict.sh](scripts/write-verdict.sh) even when `abidiff` could not run:

```json
{
  "schema": 1,
  "library": "librclcpp.so",
  "verdict": "compatible",
  "summary": "No ABI changes detected.",
  "exit_code": 0,
  "fail_on": "incompatible",
  "should_fail": false,
  "base_lib": "lib-base/librclcpp.so",
  "head_lib": "lib-pr/librclcpp.so",
  "suppressions": "",
  "report": "abidiff-report.txt",
  "head_sha": "ec6a61d0dd787ca7b7970733b0bd8ee51db254ab"
}
```

---

## Suppressions (`.abignore`)

`abidiff` accepts suppression specs that filter known-benign or intentional ABI deltas.
Pass a file via `suppressions:`.
Example:

```ini
# Ignore an internal type that leaked into DWARF.
[suppress_type]
  name = internal::Detail

# Ignore changes to a private symbol regex.
[suppress_function]
  symbol_name_regexp = ^_ZN6detail.*
```

See the [libabigail manual on suppression specifications](https://sourceware.org/libabigail/manual/libabigail-concepts.html#suppression-specifications) for the full grammar.

---

## Filtering the ABI surface with public headers

If you ship a subset of types and functions as your public ABI, point `headers-dir-base` / `headers-dir-head` at your public-headers directory.
`abidiff` will then ignore changes to types and functions that are not reachable from those headers, dramatically cutting noise.
Both directories must contain the headers as they were at the corresponding build (so usually one points into your baseline checkout and the other into the PR checkout).

---

## Requirements for the libraries

- ELF shared objects (`.so`).
  libabigail does not support PE/COFF or Mach-O, so this action is Linux-only.
- Compiled with **`-g`** so that DWARF debug info is present.
  Without DWARF, `abidiff` falls back to symbol-table-only diffs and the resulting reports are far less useful.
  The action emits a workflow warning if DWARF is missing.
- Built with the **same toolchain version and flags** on both sides whenever possible.
  Comparing a baseline built with GCC 11 against a head build with GCC 13, or `-O0` against `-O2`, can produce noisy diffs that have nothing to do with the source change.

---

## How it works

`action.yml` is a **composite action** (not a Docker action), so it runs directly on the host runner:

1. `apt-get install -y abigail-tools` (or `libabigail-tools` on older Debian/Ubuntu releases — the package was renamed in Debian 12 / Ubuntu 24.04) if `abidiff` is not already present.
   This is a no-op inside containers that already ship the libabigail binaries.
2. [scripts/run-abidiff.sh](scripts/run-abidiff.sh) validates inputs, assembles the `abidiff` command line, and captures stdout+stderr to a report file in `$RUNNER_TEMP`.
3. [scripts/decode-verdict.sh](scripts/decode-verdict.sh) decodes the `abidiff` bitmap — plus the report's changes-summary lines when only `ABI_CHANGE` is set — into a verdict and a `should-fail` flag based on `fail-on`.
4. [scripts/write-verdict.sh](scripts/write-verdict.sh) records the verdict as `verdict.json` next to the report (also when `abidiff` failed to run), and the directory is uploaded as one artifact via `actions/upload-artifact`.
5. [scripts/post-comment.js](scripts/post-comment.js), called through `actions/github-script`, finds the existing sticky comment by HTML marker and updates it (or creates one), then reconciles the configured labels. On a fork PR this step can only warn; see [Fork pull requests](#fork-pull-requests).
6. A final step exits non-zero iff `should-fail=true`.

[publish/action.yml](publish/action.yml) is the second, write-only entry point: it downloads the report artifacts of a finished run with `actions/download-artifact`, resolves the pull request, and calls the same `post-comment.js` to post one comment for all libraries and reconcile the labels.

Because everything runs on the host, this action composes cleanly with `container:` jobs that already provide `abidiff`.

---

## Repository layout

```
libabigail-action/
├── action.yml                 # check: diff two libraries, upload report + verdict.json, comment (same-repo PRs)
├── publish/
│   └── action.yml             # publish: comment + labels from a workflow_run job (fork PRs)
├── README.md
├── scripts/
│   ├── run-abidiff.sh         # invokes abidiff, captures output
│   ├── decode-verdict.sh      # interprets the exit bitmap + report summary
│   ├── write-verdict.sh       # records verdict.json next to the report
│   └── post-comment.js        # sticky comment + label management (both entry points)
├── test/
│   ├── fixtures/              # toy libs with known ABI deltas
│   │   ├── Makefile
│   │   ├── v1/                # baseline
│   │   ├── v2_additions/      # adds a new symbol — additions-only
│   │   ├── v3_breaking/       # changes parameter types — incompatible
│   │   └── v4_changed/        # changes a return type — incompatible (exit bit 4 only)
│   ├── test-publish.js        # unit tests for post-comment.js (node test/test-publish.js)
│   ├── workflow.yml           # copy-pasteable check workflow
│   └── workflow-report.yml    # copy-pasteable workflow_run publisher for fork PRs
└── .github/
    └── workflows/
        ├── ci.yml             # builds fixtures, runs the action against each pair, dry-runs publish
        └── release.yml        # moves the floating major-version tag
```

---

## Versioning

Pin to a major-version tag for automatic patch / minor updates:

```yaml
- uses: fujitatomoya/libabigail-action@v1
```

Or pin to a specific release for full reproducibility:

```yaml
- uses: fujitatomoya/libabigail-action@v1.0.0
```

The `release` workflow re-points the floating `vMAJOR` tag at the latest `vMAJOR.MINOR.PATCH` release whenever a new release is published.

---

## Why libabigail rather than abi-compliance-checker?

The de-facto alternative for this kind of check is [`abi-compliance-checker`](https://github.com/lvc/abi-compliance-checker) (ABICC), and most existing CI integrations wrap it.

ABICC has been effectively unmaintained for a long time — the upstream repository has seen no substantive release in years — and any tooling built on top of it inherits that staleness: lagging compiler / DWARF support, friction on modern distributions, and accumulating quirks around contemporary C++.

[libabigail](https://sourceware.org/libabigail/) is part of the sourceware.org family (alongside binutils, glibc, and gdb) and is actively maintained, with regular releases that track current toolchains and DWARF revisions.
It also produces a more CI-friendly output model than ABICC: a documented exit-code bitmap, an explicit "harmful" vs "harmless" change classification, and suppression specs that let projects filter known-benign deltas without forking the tool.

That combination — active upstream maintenance plus a structured, machine-readable verdict — is why this action wraps `abidiff`.

---

## Non-goals

- **Source-level API compatibility** — `libabigail` is binary ABI only.
- **Inline / templated code that doesn't appear in the `.so`** — there is nothing in the binary for `abidiff` to compare.
- **MSVC / macOS** — `libabigail` is ELF / DWARF only.

---

## License

[Apache-2.0](LICENSE).