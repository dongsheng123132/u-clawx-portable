# Electron E2E Parallelism

ClawX launches one Electron process per Playwright test with a test-scoped HOME and user-data directory. Ordinary specs can therefore run in separate workers without sharing application stores or OpenClaw files.

The Playwright project graph has three ordered lanes:

1. `exclusive` runs tests tagged `@exclusive` with one worker.
2. `parallel` runs all ordinary functional tests with the configured worker count after `exclusive` succeeds.
3. `performance` runs tests tagged `@performance` with one worker after functional tests finish.

Real clipboard tests are exclusive because Electron renderer instances read and write the same OS clipboard. Renderer performance tests run last because concurrent Electron processes distort CPU, GPU, frame-pacing, and elapsed-time evidence even when their files are otherwise isolated. `test.describe.configure({ mode: 'serial' })` is not sufficient for either case because it does not prevent another spec file or project from running at the same time.

New tests are parallel by default. A test that uses an OS-global resource must import and apply `E2E_EXCLUSIVE_TAG`; a host performance profile must use `E2E_PERFORMANCE_TAG`. Extend `tests/unit/e2e-parallel-policy.test.ts` when another recognizable global API is introduced. No static check can identify every possible external side effect, so reviewers must classify tests that use native dialogs, keychains, fixed ports, fixed writable paths, external runtimes, or other machine-global state.

Use `CLAWX_E2E_WORKERS` to override the ordinary worker count on constrained or high-capacity machines. Playwright project dependencies make a directly filtered ordinary spec run the exclusive prerequisite first; add `--project=parallel --no-deps` when a focused command intentionally needs only an audited ordinary spec. `pnpm run perf:chat` selects the performance project without running its dependencies.
