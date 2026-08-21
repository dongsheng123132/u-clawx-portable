---
id: converge-wallet-import-with-running-gateway
title: Converge device-wallet changes while Gateway is already running
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Make an explicitly confirmed wallet import or credential change converge without leaving the UI busy on repeated Gateway RPC timeouts.
touchedAreas:
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - electron/services/uclaw-cloud-account.ts
  - src/components/uclaw-cloud/UclawCloudPanel.tsx
  - tests/e2e/device-wallet.spec.ts
  - docs/device-wallet.md
  - harness/specs/rules/device-wallet-lifecycle.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/tasks/converge-wallet-import-with-running-gateway.md
expectedUserBehavior:
  - Importing a confirmed legacy wallet persists the wallet and its provider once, then immediately exposes the current wallet and provider state.
  - If the managed Gateway is already running, U-Claw pauses it before writing runtime configuration and starts it again in the background from the newly persisted credential state.
  - The UI may show Gateway restarting, but the wallet action does not remain disabled while sequential config RPC calls time out.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredTests:
  - tests/unit/uclaw-device-wallet.test.ts
  - tests/e2e/device-wallet.spec.ts
acceptance:
  - The legacy wallet file remains untouched and no plaintext key crosses into Renderer state or logs.
  - Wallet and provider persistence complete while the managed Gateway is stopped, avoiding live config RPC timeout chains.
  - A Gateway that was running or starting before the change is restarted in the background; an intentionally stopped Gateway remains stopped.
  - Wallet actions refresh both the wallet snapshot and the provider snapshot after success.
  - Chat uses the imported wallet after Gateway recovery without requiring an application restart.
docs:
  required: true
---

This preserves the single device-wallet authority while making runtime convergence explicit and recoverable.
