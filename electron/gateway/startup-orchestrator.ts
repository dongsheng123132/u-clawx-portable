import { logger } from '../utils/logger';
import { LifecycleSupersededError } from './lifecycle-controller';
import {
  connectGatewayWithStartupRetry,
  getGatewayStartupRecoveryAction,
  getStartupMigrationLockWaitDelayMs,
} from './startup-recovery';

export interface ExistingGatewayInfo {
  port: number;
  externalToken?: string;
}

type StartupHooks = {
  port: number;
  ownedPid?: never; // Removed: pid is now read dynamically in findExistingGateway to avoid stale-snapshot bug
  shouldWaitForPortFree: boolean;
  maxStartAttempts?: number;
  /** Returns true when the manager still owns a living Gateway process (e.g. after a code-1012 in-process restart). */
  hasOwnedProcess: () => boolean;
  resetStartupStderrLines: () => void;
  getStartupStderrLines: () => string[];
  assertLifecycle: (phase: string) => void;
  findExistingGateway: (port: number) => Promise<ExistingGatewayInfo | null>;
  connect: (port: number, externalToken?: string) => Promise<void>;
  onConnectedToExistingGateway: () => void;
  waitForPortFree: (port: number) => Promise<void>;
  startProcess: () => Promise<void>;
  waitForReady: (port: number) => Promise<void>;
  terminateStaleOwnedProcess: () => Promise<void>;
  onConnectedToManagedGateway: () => void;
  runDoctorRepair: () => Promise<boolean>;
  onDoctorRepairSuccess: () => void;
  delay: (ms: number) => Promise<void>;
};

async function connectWithStartupRetry(
  hooks: StartupHooks,
  port: number,
  externalToken?: string,
): Promise<void> {
  await connectGatewayWithStartupRetry({
    connect: hooks.connect,
    port,
    externalToken,
    delay: hooks.delay,
    beforeAttempt: () => hooks.assertLifecycle('start/connect-retry'),
    logWarn: (message) => logger.warn(message),
    logInfo: (message) => logger.info(message),
  });
}

export async function runGatewayStartupSequence(hooks: StartupHooks): Promise<void> {
  let configRepairAttempted = false;
  let startAttempts = 0;
  const maxStartAttempts = hooks.maxStartAttempts ?? 3;
  // Bound the startup-migration lease wait: a healthy migrator self-expires its
  // 5-minute SQLite lease within one cycle; three waited retries (~18 min worst
  // case) cover even a slow upgrade, beyond that treat it as a stuck state.
  let migrationLockWaitCount = 0;
  const MAX_MIGRATION_LOCK_WAITS = 3;

  while (true) {
    startAttempts++;
    hooks.assertLifecycle('start');
    hooks.resetStartupStderrLines();

    try {
      logger.debug('Checking for existing Gateway...');
      const existing = await hooks.findExistingGateway(hooks.port);
      hooks.assertLifecycle('start/find-existing');
      if (existing) {
        logger.debug(`Found existing Gateway on port ${existing.port}`);
        await connectWithStartupRetry(hooks, existing.port, existing.externalToken);
        hooks.assertLifecycle('start/connect-existing');
        hooks.onConnectedToExistingGateway();
        return;
      }

      // When the Gateway did an in-process restart (WS close 1012), the
      // UtilityProcess is still alive but its WS server may be mid-rebuild,
      // so findExistingGateway's quick probe returns null.  Rather than
      // waiting for the port to free (it never will — the process holds it)
      // and then spawning a duplicate, wait for the existing process to
      // become ready and reconnect to it.
      if (hooks.hasOwnedProcess()) {
        logger.info('Owned Gateway process still alive (likely in-process restart); waiting for it to become ready');
        try {
          await hooks.waitForReady(hooks.port);
        } catch (error) {
          logger.warn('Owned Gateway process did not recover after an in-process restart; terminating the stale process');
          await hooks.terminateStaleOwnedProcess();
          throw new Error('Gateway process exited before becoming ready after an in-process restart', { cause: error });
        }
        hooks.assertLifecycle('start/wait-ready-owned');
        await connectWithStartupRetry(hooks, hooks.port);
        hooks.assertLifecycle('start/connect-owned');
        hooks.onConnectedToExistingGateway();
        return;
      }

      logger.debug('No existing Gateway found, starting new process...');

      if (hooks.shouldWaitForPortFree) {
        await hooks.waitForPortFree(hooks.port);
        hooks.assertLifecycle('start/wait-port');
      }

      await hooks.startProcess();
      hooks.assertLifecycle('start/start-process');

      await hooks.waitForReady(hooks.port);
      hooks.assertLifecycle('start/wait-ready');

      await connectWithStartupRetry(hooks, hooks.port);
      hooks.assertLifecycle('start/connect');

      hooks.onConnectedToManagedGateway();
      return;
    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        throw error;
      }

      // OpenClaw's startup-migration lease (SQLite state_leases, TTL 5 min) is
      // expected during first-run upgrades and self-expires. Waiting it out
      // transparently recovers; treating the lock as fatal leaves the window
      // dead until the user manually restarts (pc-8308 incident, 2026-08-24).
      const migrationLockWaitMs = getStartupMigrationLockWaitDelayMs({
        startupError: error,
        startupStderrLines: hooks.getStartupStderrLines(),
      });
      if (migrationLockWaitMs !== null && migrationLockWaitCount < MAX_MIGRATION_LOCK_WAITS) {
        migrationLockWaitCount += 1;
        logger.warn(
          `OpenClaw startup-migration lease is held by another gateway; `
            + `waiting ${Math.round(migrationLockWaitMs / 1000)}s before retrying `
            + `(${migrationLockWaitCount}/${MAX_MIGRATION_LOCK_WAITS})`,
        );
        await hooks.delay(migrationLockWaitMs);
        continue;
      }

      const recoveryAction = getGatewayStartupRecoveryAction({
        startupError: error,
        startupStderrLines: hooks.getStartupStderrLines(),
        configRepairAttempted,
        attempt: startAttempts,
        maxAttempts: maxStartAttempts,
      });

      if (recoveryAction === 'repair') {
        configRepairAttempted = true;
        logger.warn(
          'Detected invalid OpenClaw config during Gateway startup; running doctor repair before retry',
        );
        const repaired = await hooks.runDoctorRepair();
        if (repaired) {
          logger.info('OpenClaw doctor repair completed; retrying Gateway startup');
          hooks.onDoctorRepairSuccess();
          continue;
        }
        logger.error('OpenClaw doctor repair failed; not retrying Gateway startup');
      }

      if (recoveryAction === 'retry') {
        logger.warn(`Transient start error: ${String(error)}. Retrying... (${startAttempts}/${maxStartAttempts})`);
        await hooks.delay(1000);
        continue;
      }

      throw error;
    }
  }
}
