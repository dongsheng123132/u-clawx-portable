/**
 * Gateway startup recovery heuristics.
 *
 * This module is intentionally dependency-free so it can be unit-tested
 * without Electron/runtime mocks.
 */

const INVALID_CONFIG_PATTERNS: RegExp[] = [
  /\binvalid config\b/i,
  /\bconfig invalid\b/i,
  /\bfatal configuration error\b/i,
  /\bunrecognized key\b/i,
  /\bstartup migration(?:s)?\b.*\b(?:blocked|failed|did not complete cleanly)\b/i,
  /\bmigration\b.*\bopenclaw doctor --fix\b/i,
  /\brun:\s*openclaw doctor --fix\b/i,
];

const FATAL_RUNTIME_PATTERNS: RegExp[] = [
  /\bNode(?:\.js)?\b.*\boutside the supported range\b/i,
  /\buses SQLite\b.*\bnot WAL-reset-safe\b/i,
  /\bSQLite\b.*\bWAL-reset-safe runtime required\b/i,
  /\bInstall Node 24\.15\+.*\bNode 22\.22\.3\+\b/i,
];

const STARTUP_MIGRATION_LOCK_PATTERNS: RegExp[] = [
  /\bstartup migrations? (?:is|are) already running\b/i,
  /\bretry after the other gateway finishes\b/i,
];

/**
 * Matches the retry deadline OpenClaw embeds in the startup-migration lock
 * error, e.g. "…retry after the other gateway finishes or after
 * 2026-08-24T06:26:37.095Z." (observed verbatim on a customer machine).
 */
const STARTUP_MIGRATION_LOCK_RETRY_AFTER_PATTERN =
  /retry after [^]*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;

/**
 * OpenClaw's startup-migration lease TTL is 5 minutes (STARTUP_MIGRATION_LEASE_TTL_MS
 * in dist/startup-migration-checkpoint-*.js). Allow one renewal cycle plus margin,
 * so a live migrator that legitimately renews still gets waited out — bounded.
 */
export const STARTUP_MIGRATION_LEASE_TTL_MS = 5 * 60_000;
export const STARTUP_MIGRATION_LOCK_MAX_WAIT_MS = 6 * 60_000;

const TRANSIENT_START_ERROR_PATTERNS: RegExp[] = [
  /WebSocket closed before handshake/i,
  /ECONNREFUSED/i,
  /Gateway process exited before becoming ready/i,
  /Timed out waiting for connect\.challenge/i,
  /Connect handshake timeout/i,
  // OpenClaw can emit connect.challenge before the connect RPC is accepted.
  /gateway starting/i,
  // Port occupied after orphan kill: transient, worth retrying with backoff
  /Port \d+ still occupied after \d+ms/i,
];

/** Backoff between connect() attempts when the Gateway rejects with "still starting". */
export const GATEWAY_CONNECT_STARTUP_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000] as const;

function normalizeLogLine(value: string): string {
  return value.trim();
}

/**
 * Returns true when text appears to indicate OpenClaw config validation failure.
 */
export function isInvalidConfigSignal(text: string): boolean {
  const normalized = normalizeLogLine(text);
  if (!normalized) return false;
  return INVALID_CONFIG_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns true when either startup stderr lines or startup error message
 * indicate an OpenClaw config validation failure.
 */
export function hasInvalidConfigFailureSignal(
  startupError: unknown,
  startupStderrLines: string[],
): boolean {
  for (const line of startupStderrLines) {
    if (isInvalidConfigSignal(line)) {
      return true;
    }
  }

  const errorText = startupError instanceof Error
    ? `${startupError.name}: ${startupError.message}`
    : String(startupError ?? '');

  return isInvalidConfigSignal(errorText);
}

function startupFailureCandidates(startupError: unknown, startupStderrLines: string[]): string[] {
  return [
    ...startupStderrLines,
    startupError instanceof Error
      ? `${startupError.name}: ${startupError.message}`
      : String(startupError ?? ''),
  ];
}

/** Returns true for OpenClaw runtime/SQLite failures that doctor cannot repair. */
export function hasFatalRuntimeFailureSignal(
  startupError: unknown,
  startupStderrLines: string[],
): boolean {
  return startupFailureCandidates(startupError, startupStderrLines)
    .some((text) => FATAL_RUNTIME_PATTERNS.some((pattern) => pattern.test(text)));
}

/** Returns true while another/stale OpenClaw startup migration lease is active. */
export function hasStartupMigrationLockSignal(
  startupError: unknown,
  startupStderrLines: string[],
): boolean {
  return startupFailureCandidates(startupError, startupStderrLines)
    .some((text) => STARTUP_MIGRATION_LOCK_PATTERNS.some((pattern) => pattern.test(text)));
}

/**
 * Extracts the lease expiry timestamp OpenClaw embeds in the lock error.
 *
 * The error text looks like:
 *   "OpenClaw startup migrations are already running for this state directory;
 *    retry after the other gateway finishes or after 2026-08-24T06:26:37.095Z."
 *
 * Returns the parsed Date, or null when the message carries no parseable deadline
 * (caller then falls back to the fixed TTL).
 */
export function parseStartupMigrationLockRetryAfter(
  startupError: unknown,
  startupStderrLines: string[],
): Date | null {
  for (const text of startupFailureCandidates(startupError, startupStderrLines)) {
    const match = STARTUP_MIGRATION_LOCK_RETRY_AFTER_PATTERN.exec(text);
    if (!match?.[1]) continue;
    const date = new Date(match[1]);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Small buffer added on top of the parsed lease expiry before retrying. */
const STARTUP_MIGRATION_RETRY_AFTER_GRACE_MS = 1_500;
/** Parsed deadline already passed: short nudge before probing again. */
const STARTUP_MIGRATION_PAST_DEADLINE_RETRY_MS = 5_000;
/** No parseable deadline in the message: probe again after one minute. */
const STARTUP_MIGRATION_UNKNOWN_DEADLINE_RETRY_MS = 60_000;

/**
 * How long to wait before retrying Gateway startup when OpenClaw's
 * startup-migration lease blocks us. Returns null when the failure is NOT a
 * startup-migration lock (caller should use normal recovery rules).
 *
 * Root cause this serves (pc-8308 customer machine, 2026-08-24): the shell used
 * to treat the lock as fatal and gave up, leaving the window dead until the user
 * manually restarted after the 5-minute lease expired. Waiting out the embedded
 * deadline turns that 13-minute dead window into a transparent recovery.
 */
export function getStartupMigrationLockWaitDelayMs(options: {
  startupError: unknown;
  startupStderrLines: string[];
  nowMs?: number;
}): number | null {
  if (!hasStartupMigrationLockSignal(options.startupError, options.startupStderrLines)) {
    return null;
  }
  const nowMs = options.nowMs ?? Date.now();
  const retryAfter = parseStartupMigrationLockRetryAfter(
    options.startupError,
    options.startupStderrLines,
  );
  if (!retryAfter) {
    return STARTUP_MIGRATION_UNKNOWN_DEADLINE_RETRY_MS;
  }
  const remainingMs =
    retryAfter.getTime() + STARTUP_MIGRATION_RETRY_AFTER_GRACE_MS - nowMs;
  if (remainingMs <= 0) {
    return STARTUP_MIGRATION_PAST_DEADLINE_RETRY_MS;
  }
  // A live migrator keeps renewing its lease (TTL 5 min), so never sleep longer
  // than one TTL cycle without re-probing.
  return Math.min(remainingMs, STARTUP_MIGRATION_LOCK_MAX_WAIT_MS);
}

/**
 * Retry guard for one-time config repair during a single startup flow.
 */
export function shouldAttemptConfigAutoRepair(
  startupError: unknown,
  startupStderrLines: string[],
  alreadyAttempted: boolean,
): boolean {
  if (alreadyAttempted) return false;
  return hasInvalidConfigFailureSignal(startupError, startupStderrLines);
}

export function isTransientGatewayStartError(error: unknown): boolean {
  const errorText = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error ?? '');
  return TRANSIENT_START_ERROR_PATTERNS.some((pattern) => pattern.test(errorText));
}

export function isGatewayStillStartingError(error: unknown): boolean {
  const errorText = error instanceof Error
    ? error.message
    : String(error ?? '');
  return /gateway starting/i.test(errorText);
}

export async function connectGatewayWithStartupRetry(options: {
  connect: (port: number, externalToken?: string) => Promise<void>;
  port: number;
  externalToken?: string;
  delay: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  beforeAttempt?: () => void;
  logWarn?: (message: string) => void;
  logInfo?: (message: string) => void;
}): Promise<void> {
  const retryDelaysMs = options.retryDelaysMs ?? GATEWAY_CONNECT_STARTUP_RETRY_DELAYS_MS;
  const logWarn = options.logWarn ?? (() => {});
  const logInfo = options.logInfo ?? (() => {});
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    options.beforeAttempt?.();
    try {
      await options.connect(options.port, options.externalToken);
      if (attempt > 0) {
        logInfo(`Gateway connect succeeded after ${attempt + 1} attempt(s)`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (!isGatewayStillStartingError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }
      const delayMs = retryDelaysMs[attempt] ?? retryDelaysMs[retryDelaysMs.length - 1]!;
      logWarn(
        `Gateway connect rejected while still starting (${String(error)}); `
        + `retrying in ${delayMs}ms (${attempt + 1}/${retryDelaysMs.length})`,
      );
      await options.delay(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Gateway connect failed'));
}

export type GatewayStartupRecoveryAction = 'repair' | 'retry' | 'fail';

export function getGatewayStartupRecoveryAction(options: {
  startupError: unknown;
  startupStderrLines: string[];
  configRepairAttempted: boolean;
  attempt: number;
  maxAttempts: number;
}): GatewayStartupRecoveryAction {
  if (
    hasFatalRuntimeFailureSignal(options.startupError, options.startupStderrLines)
    || hasStartupMigrationLockSignal(options.startupError, options.startupStderrLines)
  ) {
    return 'fail';
  }

  if (hasInvalidConfigFailureSignal(options.startupError, options.startupStderrLines)) {
    // One doctor pass is the only automated repair. If the same migration or
    // config failure remains afterward, stop instead of treating the generic
    // process-exited error as transient.
    return options.configRepairAttempted ? 'fail' : 'repair';
  }

  if (options.attempt < options.maxAttempts && isTransientGatewayStartError(options.startupError)) {
    return 'retry';
  }

  return 'fail';
}

