# Portable storage boundary

U-Claw portable builds have two storage domains. The USB drive is the durable
user domain; the host is the disposable performance domain.

| Domain | Location | Contents |
| --- | --- | --- |
| USB durable state | `<appRoot>/data/` | OpenClaw config, sessions, credentials, agents, skills, workspace, ClawX settings, and device wallet |
| Host cache | Windows `%LOCALAPPDATA%/U-Claw/` | Logs, Chromium session data, and future downloaded runtime versions |
| App payload | `<appRoot>/` and `resources/` | The executable and shipped read-only resources |

The device wallet is never moved to the host cache. `app.setPath('userData',
getDataDir())` must run before `app.whenReady()` so `electron-store` writes
`uclaw-device.json` into the USB durable state. Only disposable browser data
and high-churn logs may use the host cache.

## Protocol scope

- ActionParity/影核 is the planned machine interface for stable wallet,
  portable-status, runtime, and diagnostics actions. It must have one action
  implementation shared by GUI, CLI, and future MCP surfaces.
- ShadowFork/影刻 is the upstream derivation contract. It records the upstream
  base, protected portable/wallet boundaries, extension points, and attribution;
  it is not a runtime dependency.
- 本象 resources and 本境 context stay deliberately minimal until the product
  has a second device/interface or cross-device synchronization requirement.
