import { describe, expect, it, vi } from 'vitest';
import {
  connectGatewayWithStartupRetry,
  getGatewayStartupRecoveryAction,
  getStartupMigrationLockWaitDelayMs,
  hasFatalRuntimeFailureSignal,
  hasInvalidConfigFailureSignal,
  hasStartupMigrationLockSignal,
  isGatewayStillStartingError,
  isInvalidConfigSignal,
  isTransientGatewayStartError,
  parseStartupMigrationLockRetryAfter,
  shouldAttemptConfigAutoRepair,
  STARTUP_MIGRATION_LOCK_MAX_WAIT_MS,
} from '@electron/gateway/startup-recovery';

describe('gateway startup recovery heuristics', () => {
  it('detects invalid-config signal from stderr lines', () => {
    const lines = [
      'Invalid config at C:\\Users\\pc\\.openclaw\\openclaw.json:\\n- skills: Unrecognized key: "enabled"',
      'Run: openclaw doctor --fix',
    ];
    expect(hasInvalidConfigFailureSignal(new Error('gateway start failed'), lines)).toBe(true);
  });

  it('detects invalid-config signal from error message fallback', () => {
    expect(
      hasInvalidConfigFailureSignal(
        new Error('Config invalid. Run: openclaw doctor --fix'),
        [],
      ),
    ).toBe(true);
  });

  it('does not treat unrelated startup failures as invalid-config failures', () => {
    const lines = [
      'Gateway process exited (code=1, expected=no)',
      'WebSocket closed before handshake',
    ];
    expect(
      hasInvalidConfigFailureSignal(
        new Error('Gateway process exited before becoming ready (code=1)'),
        lines,
      ),
    ).toBe(false);
  });

  it('attempts auto-repair only once per startup flow', () => {
    const lines = ['Config invalid', '- skills: Unrecognized key: "enabled"'];
    expect(shouldAttemptConfigAutoRepair(new Error('start failed'), lines, false)).toBe(true);
    expect(shouldAttemptConfigAutoRepair(new Error('start failed'), lines, true)).toBe(false);
  });

  it('matches common invalid-config and migration phrases robustly', () => {
    expect(isInvalidConfigSignal('Config invalid')).toBe(true);
    expect(isInvalidConfigSignal('skills: Unrecognized key: "enabled"')).toBe(true);
    expect(isInvalidConfigSignal('Startup migration blocked by legacy state')).toBe(true);
    expect(isInvalidConfigSignal(
      'OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.',
    )).toBe(true);
    expect(isInvalidConfigSignal('Run: openclaw doctor --fix')).toBe(true);
    expect(isInvalidConfigSignal('Gateway ready after 3 attempts')).toBe(false);
  });

  it('detects an active startup-migration lease that must not be restart-looped', () => {
    expect(hasStartupMigrationLockSignal(undefined, [
      'OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after 2026-07-21T03:02:57.489Z.',
    ])).toBe(true);
    expect(hasStartupMigrationLockSignal(new Error('gateway start failed'), [])).toBe(false);
  });

  it('detects Node and SQLite failures that cannot be repaired by doctor', () => {
    expect(hasFatalRuntimeFailureSignal(undefined, [
      'System Node 24.14.0 at /usr/bin/node uses SQLite 3.49.1, which is not WAL-reset-safe. Install Node 24.15+ (recommended) or Node 22.22.3+.',
    ])).toBe(true);
    expect(hasFatalRuntimeFailureSignal(
      new Error('System Node 23.11.0 is outside the supported range'),
      [],
    )).toBe(true);
    expect(hasFatalRuntimeFailureSignal(new Error('Config invalid'), [])).toBe(false);
  });
});

describe('getGatewayStartupRecoveryAction', () => {
  const configInvalidStderr = ['Config invalid', 'Run: openclaw doctor --fix'];
  const transientError = new Error('Gateway process exited before becoming ready (code=1)');

  it('returns repair on first config-invalid failure', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: transientError,
      startupStderrLines: configInvalidStderr,
      configRepairAttempted: false,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('repair');
  });

  it('fails when the config error remains after the one doctor repair', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: transientError,
      startupStderrLines: configInvalidStderr,
      configRepairAttempted: true,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('fail');
  });

  it('returns retry for transient errors after successful repair (no config signal)', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: transientError,
      startupStderrLines: ['Gateway process exited (code=1, expected=no)'],
      configRepairAttempted: true,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('retry');
  });

  it('returns fail when max attempts exceeded even for transient errors', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: transientError,
      startupStderrLines: [],
      configRepairAttempted: false,
      attempt: 3,
      maxAttempts: 3,
    });
    expect(action).toBe('fail');
  });

  it('returns fail for non-transient, non-config errors', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: new Error('Unknown fatal error'),
      startupStderrLines: [],
      configRepairAttempted: false,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('fail');
  });

  it('does not retry while an OpenClaw startup-migration lease is active', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: transientError,
      startupStderrLines: [
        'OpenClaw startup migrations are already running; retry after the other gateway finishes.',
      ],
      configRepairAttempted: false,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('fail');
  });

  it('does not retry or run doctor for a fatal runtime incompatibility', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: new Error('Gateway process exited before becoming ready (code=1)'),
      startupStderrLines: [
        'System Node 24.14.0 uses SQLite 3.49.1, which is not WAL-reset-safe. Install Node 24.15+ or Node 22.22.3+.',
        'Run: openclaw doctor --fix',
      ],
      configRepairAttempted: false,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('fail');
  });

  it('returns retry for gateway still starting handshake rejection', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: new Error('gateway starting; retry shortly'),
      startupStderrLines: [],
      configRepairAttempted: false,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('retry');
    expect(isTransientGatewayStartError(new Error('gateway starting; retry shortly'))).toBe(true);
    expect(isGatewayStillStartingError(new Error('gateway starting; retry shortly'))).toBe(true);
  });
});

describe('startup-migration lock wait (pc-8308 incident regression)', () => {
  // Verbatim stderr observed on the customer machine, 2026-08-24.
  const LOCK_LINES = [
    '[openclaw] Could not start the CLI.',
    '[openclaw] Reason: OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after 2026-08-24T06:26:37.095Z.',
  ];
  const LOCK_ERROR = new Error('Gateway process exited before becoming ready (code=1)');

  it('parses the retry-after deadline embedded in the lock error', () => {
    const retryAfter = parseStartupMigrationLockRetryAfter(LOCK_ERROR, LOCK_LINES);
    expect(retryAfter).not.toBeNull();
    expect(retryAfter!.toISOString()).toBe('2026-08-24T06:26:37.095Z');
    expect(parseStartupMigrationLockRetryAfter(new Error('no deadline here'), [])).toBeNull();
  });

  it('returns null for non-lock failures', () => {
    expect(
      getStartupMigrationLockWaitDelayMs({
        startupError: new Error('WebSocket closed before handshake'),
        startupStderrLines: [],
      }),
    ).toBeNull();
  });

  it('waits until the embedded deadline plus grace', () => {
    // 90.095s before the lease expires.
    const now = Date.parse('2026-08-24T06:25:07.000Z');
    expect(
      getStartupMigrationLockWaitDelayMs({
        startupError: LOCK_ERROR,
        startupStderrLines: LOCK_LINES,
        nowMs: now,
      }),
    ).toBe(90_095 + 1_500);
  });

  it('caps the wait at one lease cycle so a live migrator re-probes', () => {
    // Embedded deadline claims ~7min remaining (only possible via client/server
    // clock skew); the wait must still be bounded by one TTL cycle.
    const now = Date.parse('2026-08-24T06:19:30.000Z');
    expect(
      getStartupMigrationLockWaitDelayMs({
        startupError: LOCK_ERROR,
        startupStderrLines: LOCK_LINES,
        nowMs: now,
      }),
    ).toBe(STARTUP_MIGRATION_LOCK_MAX_WAIT_MS);
  });

  it('nudges quickly when the parsed deadline already passed', () => {
    const now = Date.parse('2026-08-24T06:27:00.000Z'); // deadline passed
    expect(
      getStartupMigrationLockWaitDelayMs({
        startupError: LOCK_ERROR,
        startupStderrLines: LOCK_LINES,
        nowMs: now,
      }),
    ).toBe(5_000);
  });

  it('falls back to a bounded probe interval when no deadline is present', () => {
    expect(
      getStartupMigrationLockWaitDelayMs({
        startupError: new Error(
          'OpenClaw startup migrations are already running for this state directory',
        ),
        startupStderrLines: [],
        nowMs: Date.parse('2026-08-24T06:25:00.000Z'),
      }),
    ).toBe(60_000);
  });
});

describe('connectGatewayWithStartupRetry', () => {
  it('retries connect when gateway is still starting', async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('gateway starting; retry shortly'))
      .mockRejectedValueOnce(new Error('gateway starting; retry shortly'))
      .mockResolvedValueOnce(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);

    await connectGatewayWithStartupRetry({
      connect,
      port: 18789,
      delay,
      retryDelaysMs: [10, 20],
    });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 10);
    expect(delay).toHaveBeenNthCalledWith(2, 20);
  });

  it('throws immediately for non-starting errors', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('token mismatch'));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(connectGatewayWithStartupRetry({
      connect,
      port: 18789,
      delay,
      retryDelaysMs: [10],
    })).rejects.toThrow('token mismatch');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('checks lifecycle before each retry attempt', async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('gateway starting; retry shortly'))
      .mockResolvedValueOnce(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);
    const beforeAttempt = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('Gateway start superseded');
      });

    await expect(connectGatewayWithStartupRetry({
      connect,
      port: 18789,
      delay,
      beforeAttempt,
      retryDelaysMs: [10],
    })).rejects.toThrow('Gateway start superseded');

    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(10);
  });
});
