---
id: parallelize-electron-e2e
title: Parallelize Electron E2E safely
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Run isolated Electron E2E specs concurrently while fencing OS-global resources and host-sensitive performance profiles.
touchedAreas:
  - playwright.config.ts
  - package.json
  - .github/workflows/electron-e2e.yml
  - AGENTS.md
  - tests/e2e/fixtures/electron.ts
  - tests/e2e/parallel-policy.ts
  - tests/e2e/chat-streamdown-rendering.spec.ts
  - tests/e2e/chat-acp-attachments.spec.ts
  - tests/e2e/markdown-file-preview.spec.ts
  - tests/e2e/renderer-performance.spec.ts
  - tests/unit/e2e-parallel-policy.test.ts
  - harness/reference/e2e-parallelism.md
  - harness/specs/rules/e2e-parallel-isolation.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/tasks/parallelize-electron-e2e.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Local and CI Electron E2E runs execute independent spec files concurrently.
  - Tests that use the OS clipboard and host performance profiles never overlap incompatible tests.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - backend-communication-boundary
  - e2e-parallel-isolation
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/e2e-parallel-policy.test.ts
  - pnpm harness validate --spec harness/specs/tasks/parallelize-electron-e2e.md
  - pnpm run test:e2e
  - pnpm run typecheck
  - pnpm run lint:check
acceptance:
  - The ordinary E2E project uses more than one worker by default and can be overridden for constrained machines.
  - OS-global clipboard tests execute in a one-worker prerequisite project.
  - Renderer performance profiles execute alone after functional E2E tests.
  - Per-test HOME, Electron profile, OpenClaw state, and Host API configuration remain isolated.
  - CI opts into the checked-in parallel worker policy on every supported OS.
  - A durable policy and automated guard explain how future global-resource tests enter the exclusive lane.
docs:
  required: true
---

## Scope

This task changes only Electron E2E scheduling and fixture isolation. It does not change application transport behavior, production Host API routing, or user-visible ClawX features.
