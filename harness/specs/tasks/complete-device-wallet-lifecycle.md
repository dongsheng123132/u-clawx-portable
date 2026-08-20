---
id: complete-device-wallet-lifecycle
title: Complete the device wallet lifecycle and unified wallet card
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add safe local-wallet removal and expose the complete device-wallet lifecycle without creating a second credential authority.
touchedAreas:
  - docs/device-wallet.md
  - electron/main/ipc-handlers.ts
  - electron/services/uclaw-device-wallet.ts
  - electron/services/uclaw-cloud-account.ts
  - electron/services/uclaw-api.ts
  - shared/host-api/contract.ts
  - src/lib/host-api.ts
  - src/stores/uclaw-cloud.ts
  - src/components/uclaw-cloud/UclawCloudPanel.tsx
  - shared/i18n/locales/**/settings.json
  - tests/unit/uclaw-device-wallet.test.ts
  - tests/e2e/device-wallet.spec.ts
  - harness/specs/rules/device-wallet-lifecycle.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/tasks/complete-device-wallet-lifecycle.md
expectedUserBehavior:
  - The Models page presents one localized card titled Device Wallet with balance, recharge, copy, rotate, adopt, and remove-local actions.
  - Removing the local wallet warns the user to back up the key, clears ClawX-managed chat and image consumers, then creates a new zero-balance wallet on the next online convergence.
  - The old server wallet and balance remain untouched and can be restored by adopting the backed-up key.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredTests:
  - tests/unit/uclaw-device-wallet.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/e2e/device-wallet.spec.ts
acceptance:
  - Unknown pending wallet operations are preserved and local removal is rejected.
  - A known pending rotation is settled and removal requires a fresh confirmation.
  - Managed provider and image credentials are cleared before local wallet state.
  - Renderer code uses only typed hostApi.uclaw calls.
  - All visible strings have en, zh, ja, and ru translations.
  - No registration, login, activation gate, server-wallet deletion, or balance deletion is introduced.
docs:
  required: true
---

Implements the local lifecycle defined by `docs/device-wallet.md` and keeps OpenClaw config changes behind the Main-owned coordinator.
