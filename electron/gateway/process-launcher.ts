import { app, utilityProcess } from 'electron';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import type { GatewayLaunchContext } from './config-sync';
import type { GatewayLifecycleState } from './process-policy';
import { logger } from '../utils/logger';
import { getOpenClawPortableEnv } from '../utils/paths';
import { appendNodeRequireToNodeOptions } from '../utils/paths';

const GATEWAY_FETCH_PRELOAD_SOURCE = `'use strict';
(function () {
  var _f = globalThis.fetch;
  if (typeof _f !== 'function') return;
  if (globalThis.__clawxFetchPatched) return;
  globalThis.__clawxFetchPatched = true;

  globalThis.fetch = function clawxFetch(input, init) {
    var url =
      typeof input === 'string' ? input
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url : '';

    if (url.indexOf('openrouter.ai') !== -1) {
      init = init ? Object.assign({}, init) : {};
      var prev = init.headers;
      var flat = {};
      if (prev && typeof prev.forEach === 'function') {
        prev.forEach(function (v, k) { flat[k] = v; });
      } else if (prev && typeof prev === 'object') {
        Object.assign(flat, prev);
      }
      delete flat['http-referer'];
      delete flat['HTTP-Referer'];
      delete flat['x-title'];
      delete flat['X-Title'];
      delete flat['x-openrouter-title'];
      delete flat['X-OpenRouter-Title'];
      flat['HTTP-Referer'] = 'https://claw-x.com';
      flat['X-OpenRouter-Title'] = 'U-ClawX';
      init.headers = flat;
    }
    return _f.call(globalThis, input, init);
  };

  if (process.platform === 'win32') {
    try {
      var cp = require('child_process');
      if (!cp.__clawxPatched) {
        cp.__clawxPatched = true;
        ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'].forEach(function(method) {
          var original = cp[method];
          if (typeof original !== 'function') return;
          cp[method] = function() {
            var args = Array.prototype.slice.call(arguments);
            var optIdx = -1;
            for (var i = 1; i < args.length; i++) {
              var a = args[i];
              if (a && typeof a === 'object' && !Array.isArray(a)) {
                optIdx = i;
                break;
              }
            }
            if (optIdx >= 0) {
              args[optIdx].windowsHide = true;
            } else {
              var opts = { windowsHide: true };
              if (typeof args[args.length - 1] === 'function') {
                args.splice(args.length - 1, 0, opts);
              } else {
                args.push(opts);
              }
            }
            return original.apply(this, args);
          };
        });
      }
    } catch (e) {
      // ignore
    }
  }
})();
`;

/**
 * Environment variables that make OpenClaw treat an *external* provider plugin
 * as configured, taken from its official external provider catalog.
 *
 * Why they must not reach the Gateway: OpenClaw's startup migration installs
 * every plugin it believes is configured. Installing one creates a plugin-local
 * `node_modules/openclaw` junction — which exFAT, the filesystem on virtually
 * every customer USB stick, cannot create. The install fails, migrations report
 * unclean, and the Gateway refuses to become ready. The portable build then
 * never starts, with a failure that depends on nothing but which machine the
 * stick happens to be plugged into.
 *
 * That last part is the real problem, and it is why this list is stripped
 * rather than the individual plugins bundled: a portable drive must behave the
 * same everywhere. A developer machine with DASHSCOPE_API_KEY set (Alibaba's
 * CLI) breaks; the identical drive on a clean machine works. Inheriting these
 * would also silently spend the host owner's API credits.
 *
 * U-ClawX never configured providers through the environment anyway — provider
 * credentials are passed explicitly at launch (see `loadedProviderKeyCount`),
 * so nothing that U-ClawX supports is lost by dropping them.
 *
 * Kept honest by `scripts/check-provider-env-catalog-drift.mjs`, which
 * re-derives this list from the bundled OpenClaw runtime and fails when an
 * upstream sync adds a provider we do not strip.
 */
const OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS = [
  'AI_GATEWAY_API_KEY',
  'ARCEEAI_API_KEY',
  'CEREBRAS_API_KEY',
  'CHUTES_API_KEY',
  'CHUTES_OAUTH_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPINFRA_API_KEY',
  'DEEPSEEK_API_KEY',
  'FEATHERLESS_API_KEY',
  'FIREWORKS_API_KEY',
  'GROQ_API_KEY',
  'KILOCODE_API_KEY',
  'KIMI_API_KEY',
  'KIMICODE_API_KEY',
  'LONGCAT_API_KEY',
  'MODEL_API_KEY',
  'MODELSTUDIO_API_KEY',
  'MOONSHOT_API_KEY',
  'QIANFAN_API_KEY',
  'QWEN_API_KEY',
  'STEPFUN_API_KEY',
  'TOKENHUB_API_KEY',
  'TOKENPLAN_API_KEY',
  'VENICE_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
] as const;

export function buildGatewayRuntimeEnv(
  forkEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = { ...forkEnv };
  const stripped: string[] = [];
  for (const envVar of OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS) {
    if (typeof sanitized[envVar] !== 'string' || sanitized[envVar]?.trim() === '') continue;
    delete sanitized[envVar];
    stripped.push(envVar);
  }
  if (stripped.length > 0) {
    // Names only — the values are third-party credentials.
    logger.info(
      `Stripped ${stripped.length} host provider credential env var(s) from the Gateway environment: ${stripped.join(', ')}`,
    );
  }

  return {
    ...sanitized,
    // U-ClawX does not expose LAN discovery, so keep Bonjour disabled even if
    // the parent process inherited an explicit opt-in value.
    OPENCLAW_DISABLE_BONJOUR: '1',
    // OpenClaw's built-in trace contains stage names and timings only. Keep it
    // enabled so packaged startup incidents are diagnosable from normal logs.
    OPENCLAW_GATEWAY_STARTUP_TRACE: '1',
  };
}

function ensureGatewayFetchPreload(): string {
  const dest = path.join(app.getPath('userData'), 'gateway-fetch-preload.cjs');
  try {
    writeFileSync(dest, GATEWAY_FETCH_PRELOAD_SOURCE, 'utf-8');
  } catch {
    // best-effort
  }
  return dest;
}

export async function launchGatewayProcess(options: {
  port: number;
  launchContext: GatewayLaunchContext;
  sanitizeSpawnArgs: (args: string[]) => string[];
  getCurrentState: () => GatewayLifecycleState;
  getShouldReconnect: () => boolean;
  onStderrLine: (line: string) => void;
  onSpawn: (pid: number | undefined) => void;
  onExit: (child: Electron.UtilityProcess, code: number | null) => void;
  onError: (error: Error) => void;
}): Promise<{ child: Electron.UtilityProcess; lastSpawnSummary: string }> {
  const {
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  } = options.launchContext;

  logger.info(
    `Starting Gateway process (mode=${mode}, port=${options.port}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'}, providerKeys=${loadedProviderKeyCount}, channels=${channelStartupSummary}, proxy=${proxySummary})`,
  );
  const lastSpawnSummary = `mode=${mode}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}"`;

  const runtimeEnv = buildGatewayRuntimeEnv(forkEnv);

  // 🔴 便携模式：把 OPENCLAW_HOME / OPENCLAW_STATE_DIR 注入子进程。
  //
  // 内置的 OpenClaw runtime 自己会去解析 `~/.openclaw` —— 不注入的话它读写的是
  // **宿主机**的用户目录：U 盘上看不到自己的会话，却能看到（并污染）这台电脑
  // 主人的数据。Electron 侧的 userData 重定向管不到子进程，必须显式传。
  Object.assign(runtimeEnv, getOpenClawPortableEnv());

  // Disable OpenClaw's mDNS/Bonjour gateway advertiser unconditionally.
  //
  // The OpenClaw gateway advertises `_openclaw-gw._tcp.local` on every
  // active network interface using a hardcoded `openclaw.local` hostname,
  // which causes:
  //   - cross-machine name collisions when multiple OpenClaw/U-ClawX peers
  //     share a LAN (each falls back to "<name> (OpenClaw) (2)")
  //   - self-collisions on multi-homed hosts (Wi-Fi + Tailscale + utun ...)
  //   - "ghost" record collisions after an unclean U-ClawX exit, because
  //     SIGKILL prevents ciao from emitting the mDNS goodbye record.
  //
  // U-ClawX has no UI for LAN gateway discovery today, so the advertiser is
  // pure log noise.  `OPENCLAW_DISABLE_BONJOUR=1` short-circuits
  // `startGatewayBonjourAdvertiser()` (openclaw `src/infra/bonjour.ts`,
  // `isDisabledByEnv()`).  Set after the `forkEnv` spread so any
  // pre-existing value inherited from the user shell cannot re-enable it.
  // buildGatewayRuntimeEnv() applies both this policy and startup tracing
  // before any development-only environment augmentation below.

  // Only apply the fetch/child_process preload in dev mode.
  // In packaged builds Electron's UtilityProcess rejects NODE_OPTIONS
  // with --require, logging "Most NODE_OPTIONs are not supported in
  // packaged apps" and the preload never loads.
  if (!app.isPackaged) {
    try {
      const preloadPath = ensureGatewayFetchPreload();
      if (existsSync(preloadPath)) {
        runtimeEnv.NODE_OPTIONS = appendNodeRequireToNodeOptions(
          runtimeEnv.NODE_OPTIONS,
          preloadPath,
        );
      }
    } catch (err) {
      logger.warn('Failed to set up OpenRouter headers preload:', err);
    }
  }

  return await new Promise<{ child: Electron.UtilityProcess; lastSpawnSummary: string }>((resolve, reject) => {
    const child = utilityProcess.fork(entryScript, gatewayArgs, {
      cwd: openclawDir,
      stdio: 'pipe',
      env: runtimeEnv as NodeJS.ProcessEnv,
      serviceName: 'OpenClaw Gateway',
    });

    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve({ child, lastSpawnSummary });
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on('error', (error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logger.error('Gateway process spawn error:', error);
      options.onError(normalizedError);
      rejectOnce(normalizedError);
    });

    child.on('exit', (code: number) => {
      // Only check shouldReconnect — not current state.  On Windows the WS
      // close handler fires before the process exit handler and sets state to
      // 'stopped', which would make an unexpected crash look like a planned
      // shutdown in logs.  shouldReconnect is the reliable indicator: stop()
      // sets it to false (expected), crashes leave it true (unexpected).
      const expectedExit = !options.getShouldReconnect();
      const level = expectedExit ? logger.info : logger.warn;
      level(`Gateway process exited (code=${code}, expected=${expectedExit ? 'yes' : 'no'})`);
      options.onExit(child, code);
    });

    child.stderr?.on('data', (data) => {
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        options.onStderrLine(line);
      }
    });

    child.on('spawn', () => {
      logger.info(`Gateway process started (pid=${child.pid})`);
      options.onSpawn(child.pid);
      resolveOnce();
    });
  });
}
