# Fix the order-dependent `doctorSetupInspection` test

Work only in `C:/Users/2supe/All Coding/Google-Tools-MCP/gtm-flake`, branch `fix/doctor-flake`, cut
from `main` at `a95bf30`. Dependencies are installed. **Do not push. Do not touch any other
worktree. Do not post to GitHub.**

Read `.planning/constraints.md` in the main worktree first. Override: **you DO have network access
and `npm` works**; `gh` is still off limits.

## Why this matters now

`.github/workflows/publish.yml` runs `npm run test:ci` in the **gated** publish job, after a human
approves the release. A test that fails roughly 1 run in 5 will eventually fail a real publish run
and burn that approval. This is a release blocker for 3.0.0, which is otherwise ready to tag.

## What is observed, precisely

`tests/doctorSetupInspection.test.js:238`, "surfaces malformed-config warnings in the troubleshoot
report".

- Fails about 2 runs in 9 of the **full** suite, always under heavy IO (measured: once alongside an
  unrelated failing suite, once immediately after an `npm ci`).
- Passes **20/20** when that suite runs alone.
- Passes on the same tree most of the time, so it is scheduling, not logic.

The test writes a `.env` into `os.tmpdir()`, calls `loadEnvFile(envPath)`, calls `registerAllTools`,
then asserts `report.config.warnings` contains a string mentioning `${envPath}:1`.

## The state to look at first

`dist/config.js:54` holds `const configWarnings = []` at module scope. It is read through
`getConfigWarnings()` (`dist/config.js:69`), which returns a copy, and consumed by
`inspectSetup` (`dist/setupInspect.js:101`) as a **default parameter**,
`configWarnings = getConfigWarnings()`, so it is evaluated per call.

That array accumulates and is never reset. Jest runs several suites per worker process, so what is
in it when this test runs depends on which suites the scheduler put in the same worker first.

**Do not assume that is the whole story.** The observed failure is the expected warning being
*absent*, not extra entries being present, and pure accumulation would not remove anything. So
there is a second mechanism — a dedupe, an early return, a cached module registry, a path
normalisation, or `loadEnvFile` refusing to re-process something it has seen. Find the actual cause
before changing anything. Reproduce it deliberately rather than waiting for luck: run the full suite
under load, or run this suite in the same worker as whichever suite precedes it, or drive
`loadEnvFile` twice in one process. When you can make it fail on demand, you understand it.

## What a good fix looks like

Isolate the state so worker scheduling cannot decide the outcome. Options, in rough order of
preference: give `config.js` an explicit reset seam the test calls in `beforeEach`; or have the test
inject `configWarnings` rather than relying on the module-level default; or reset modules between
tests. Pick based on what you find, and say why.

Two things that would make this worse, not better:
- Weakening the assertion so it passes either way. The test is checking real behaviour.
- Marking it skipped, serial-only, or retried. That hides the bug rather than removing it.

If the root cause turns out to be a genuine defect in `config.js` rather than test hygiene — for
example warnings being silently dropped on a second load in one process — then fix the runtime and
say so clearly, because that would affect a long-lived server too, not just the suite.

## Gates

- Full `npm test` **five consecutive times**, all green. Report all five `Test Suites:` lines.
  Five is the point: one green run proves nothing about a 1-in-5 flake.
- `npm run test:ci` once, green.
- The suite alone still passes.
- Tool count stays **160** default / **232** aliases-enabled.
- **No test count is a target**, and the count must not go down.
- Commit on `fix/doctor-flake` with a message naming the mechanism. Do not push.

## Report

The actual root cause, with the evidence that proves it rather than a plausible story. How you
reproduced it on demand. What you changed and why that specific fix. The five test lines. Anything
you suspect is wrong but left alone.
