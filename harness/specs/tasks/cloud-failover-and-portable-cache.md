---
id: cloud-failover-and-portable-cache
title: Add editable U-Claw cloud failover and restore portable cache acceleration
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Give U-Claw cloud traffic one shared editable primary/fallback policy and keep disposable Chromium caches off slow portable media without moving credentials or user data off the portable directory.
touchedAreas:
  - electron/main/index.ts
  - electron/services/providers/uclaw-cloud-endpoint.ts
  - electron/shared/providers/uclaw-cloud-config.ts
  - electron/shared/providers/uclaw-cloud-endpoints.json
  - electron/services/uclaw-device-wallet.ts
  - electron/services/uclaw-cloud-account.ts
  - electron/services/providers/uclaw-cloud-catalog.ts
  - electron/shared/providers/registry.ts
  - tests/unit/uclaw-cloud-endpoint.test.ts
  - tests/unit/uclaw-device-wallet.test.ts
  - tests/unit/portable-paths.test.ts
  - tests/unit/portable-session-data.test.ts
  - docs/device-wallet.md
  - scripts/prepare-win-portable-lib.mjs
  - scripts/prepare-win-portable.mjs
  - tests/unit/prepare-win-portable.test.ts
  - harness/specs/tasks/cloud-failover-and-portable-cache.md
expectedUserBehavior:
  - Chat, wallet binding, balance, catalog, image defaults, and recharge prefer api.u-claw.org.cn and fail over together to api.u-claw.org.
  - An operator can edit uclaw-cloud-endpoints.json next to U-Claw.exe to change the ordered HTTPS endpoints without rebuilding.
  - Portable credentials, configuration, and conversations remain under the executable-adjacent data directory on C, D, E, or removable drives.
  - Disposable Chromium session caches use the host system cache by default, with the existing portable setting able to opt out.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/uclaw-cloud-endpoint.test.ts
  - tests/unit/uclaw-device-wallet.test.ts
  - tests/unit/portable-paths.test.ts
  - tests/unit/portable-session-data.test.ts
  - tests/unit/prepare-win-portable.test.ts
acceptance:
  - The primary API/pay bases are api.u-claw.org.cn and the fallback API/pay bases are api.u-claw.org.
  - A 4xx response keeps the current endpoint; only network failures and 5xx responses trigger fallback.
  - Missing, invalid, non-HTTPS, or empty external endpoint configs fall back to the bundled list.
  - Main configures both portable userData and the disposable system sessionData path before app.whenReady().
  - Wallet secrets never move into the host cache directory.
  - Network failures remain fail-soft and never block application startup.
docs:
  required: true
---

This task restores the older portable-cache startup optimization while preserving the device wallet as portable state.
