---
id: device-wallet-lifecycle
title: Device Wallet Lifecycle
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/uclaw-device-wallet.test.ts
---

Device-wallet credentials have one local authority and must follow `docs/device-wallet.md`.

- `bind`, `rotate`, and `adopt` converge through the same provider-application path.
- Removing the local wallet clears every ClawX-managed consumer before clearing the five wallet fields. It never deletes the server wallet or balance.
- Unknown pending operations fail closed. A known pending rotation is settled before removal and requires the user to confirm again against the resulting key.
- No-wallet and network-failure states never block the rest of the application.
- Renderer controls use the typed `hostApi.uclaw` surface; visible text is translated in English, Chinese, Japanese, and Russian.
