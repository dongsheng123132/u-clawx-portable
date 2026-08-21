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
- A wallet-less portable build checks for the historical host-userData wallet before bind. A valid candidate pauses bind until the user explicitly imports it or chooses a separate new wallet.
- Legacy import exposes only a masked key and read-only balance to Renderer, converges through the existing adopt/provider-application path, and never deletes or rewrites the legacy wallet.
- If a wallet credential changes while the managed Gateway is running or starting, pause it before runtime config persistence and restart it in the background afterward; never hold the wallet action open across repeated live config RPC timeouts.
- A successful wallet action refreshes both the wallet snapshot and the provider snapshot so the two UI surfaces cannot disagree.
- Renderer controls use the typed `hostApi.uclaw` surface; visible text is translated in English, Chinese, Japanese, and Russian.
