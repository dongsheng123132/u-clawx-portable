---
id: add-manual-technical-support
title: Add privacy-first manual technical support
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Give portable U-Claw users a stable WeChat and manual email support path without automatically collecting sensitive local data.
touchedAreas:
  - harness/specs/tasks/add-manual-technical-support.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/rules/ui-i18n-design-tokens.md
  - src/App.tsx
  - electron/main/menu.ts
  - src/components/layout/Sidebar.tsx
  - src/pages/Support/index.tsx
  - src/assets/wechat-support-qr.jpg
  - shared/i18n/resources.ts
  - shared/i18n/locales/en/common.json
  - shared/i18n/locales/zh/common.json
  - shared/i18n/locales/ja/common.json
  - shared/i18n/locales/ru/common.json
  - shared/i18n/locales/en/menu.json
  - shared/i18n/locales/zh/menu.json
  - shared/i18n/locales/ja/menu.json
  - shared/i18n/locales/ru/menu.json
  - shared/i18n/locales/en/support.json
  - shared/i18n/locales/zh/support.json
  - shared/i18n/locales/ja/support.json
  - shared/i18n/locales/ru/support.json
  - tests/e2e/support.spec.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - The sidebar footer exposes a Technical Support page above Settings.
  - The native Help menu opens the same local Support page instead of a public issue tracker.
  - Users can scan a readable WeChat QR code or copy the support WeChat ID and email address.
  - Users can type feedback and open a prefilled draft in their default email application for review and manual sending.
  - No chat history, credentials, wallet data, file paths, logs, device identifiers, or diagnostics are attached automatically.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - ui-i18n-design-tokens
  - e2e-parallel-isolation
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/support.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/add-manual-technical-support.md
acceptance:
  - The Support page is reachable from the persistent sidebar footer and uses localized accessible controls in English, Chinese, Japanese, and Russian.
  - The native Help menu routes to the same local page and does not open the former public ClawX issue tracker.
  - The WeChat QR code is large enough to scan and the WeChat ID and support email remain available as text.
  - Empty feedback is rejected locally; non-empty feedback opens a mailto draft through hostApi.shell.openExternal and includes only manually entered text, app version, and OS type.
  - The page clearly warns users not to paste secrets and promises that sensitive local state and diagnostics are not attached automatically.
  - Typecheck, lint, Vite build, focused Electron E2E, communication regression, and harness validation pass.
docs:
  required: true
---

## Scope

This task adds a small, always-available manual support surface for the portable U-Claw distribution. It intentionally reuses the existing typed shell Host API and does not add a background reporter, upload endpoint, GitHub token, diagnostic archive, or automatic collection path.

## Out Of Scope

- Automatic crash or bug uploads.
- Direct client access to a private GitHub repository.
- Changing the existing U-King private report collector.
- Attaching screenshots, local logs, chat transcripts, or wallet/provider data.
