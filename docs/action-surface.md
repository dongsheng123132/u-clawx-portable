# Stable machine action surface

This is the first ActionParity/影核 boundary for U-Clawx. It is intentionally
small: business actions belong here once, while GUI, CLI, and future MCP
surfaces remain callers.

| Action ID | Class | Current implementation boundary |
| --- | --- | --- |
| `wallet.status` | read | `electron/services/uclaw-device-wallet.ts` + host API |
| `wallet.ensure` | external, idempotent | device-wallet state machine |
| `wallet.key.adopt` | write | device-wallet adopt + `applyKey()` |
| `wallet.key.rotate` | financial, confirmed | two-phase device-wallet rotate |
| `wallet.reset_local` | destructive, confirmed | consumer-first local reset |
| `portable.status` | read | portable path/runtime diagnostics |
| `runtime.status` | read | bundled OpenClaw runtime diagnostics |
| `diagnostics.export` | write | host-side log export with secret redaction |

The current release still exposes these through the existing Main/host-api
boundary. A future ActionParity registry must preserve these IDs and generate
CLI/MCP bindings from one core; it must not duplicate wallet or runtime
business logic. Window navigation, animations, and chat composition are not
business actions and stay outside this table.
