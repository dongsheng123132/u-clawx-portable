---
id: migrate-legacy-device-wallet
title: Prompt before importing a legacy host device wallet
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Preserve a paid wallet when upgrading from the old host-userData build to the portable build, without silently copying credentials or creating a competing empty wallet first.
touchedAreas:
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - docs/device-wallet.md
  - electron/services/uclaw-device-wallet.ts
  - electron/services/uclaw-cloud-account.ts
  - electron/services/providers/uclaw-cloud-endpoint.ts
  - electron/services/uclaw-api.ts
  - shared/host-api/contract.ts
  - src/lib/host-api.ts
  - src/stores/uclaw-cloud.ts
  - src/components/uclaw-cloud/UclawCloudPanel.tsx
  - shared/i18n/locales/**/settings.json
  - tests/unit/uclaw-device-wallet.test.ts
  - tests/unit/uclaw-cloud-endpoint.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/e2e/device-wallet.spec.ts
  - harness/specs/rules/device-wallet-lifecycle.md
  - harness/specs/tasks/migrate-legacy-device-wallet.md
expectedUserBehavior:
  - A portable build with no wallet pauses automatic bind when a valid legacy wallet exists under the host ClawX userData directory.
  - The Models page shows only the legacy wallet's masked key and read-only balance, then asks the user to import it or explicitly create a separate new wallet.
  - If the selected cloud edge lacks the concrete balance route, the read-only query retries the next trusted A/B endpoint without bypassing authentication or rate-limit decisions.
  - Importing validates the legacy key, writes it through the existing adopt path, and applies it to every ClawX-managed consumer.
  - Creating a new wallet leaves the legacy file, key, and server balance untouched.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredTests:
  - tests/unit/uclaw-device-wallet.test.ts
  - tests/unit/uclaw-cloud-endpoint.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/e2e/device-wallet.spec.ts
  - pnpm run typecheck
acceptance:
  - Legacy detection is active only in portable mode and never returns a plaintext key to Renderer.
  - A valid legacy candidate prevents automatic bind until the user chooses import or create-new.
  - Pending or malformed legacy state is not silently imported.
  - Import converges through adoptDeviceKey and applyKeyToProvider; there is no second credential authority.
  - Create-new bypasses the legacy guard only for that explicit action and does not delete or rewrite the legacy wallet.
  - Route-level 404/5xx and transport failures retry the next configured endpoint; authentication and rate-limit responses do not.
  - All visible strings have en, zh, ja, and ru translations.
  - Packaged portable data and repository history contain no real wallet credentials.
docs:
  required: true
---

This task covers the one-time security boundary between the historical `%APPDATA%/clawx` wallet location and the portable `data/clawx-state` authority.
