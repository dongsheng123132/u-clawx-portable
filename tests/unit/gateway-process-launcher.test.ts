// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: true,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

import { buildGatewayRuntimeEnv } from '@electron/gateway/process-launcher';

describe('Gateway process launcher environment', () => {
  it('enables safe startup tracing and preserves the source environment', () => {
    const source = {
      PATH: '/usr/bin',
      OPENCLAW_DISABLE_BONJOUR: '0',
      OPENCLAW_GATEWAY_STARTUP_TRACE: '0',
    };

    expect(buildGatewayRuntimeEnv(source)).toEqual({
      PATH: '/usr/bin',
      OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_GATEWAY_STARTUP_TRACE: '1',
    });
    expect(source).toEqual({
      PATH: '/usr/bin',
      OPENCLAW_DISABLE_BONJOUR: '0',
      OPENCLAW_GATEWAY_STARTUP_TRACE: '0',
    });
  });

  // A host provider credential in the environment makes OpenClaw install the
  // matching external provider plugin at startup; that install needs a
  // node_modules/openclaw junction, which exFAT USB sticks cannot create, and
  // the Gateway then refuses to report ready. The drive must not depend on
  // which machine it is plugged into.
  it('strips host provider credential env vars', () => {
    const env = buildGatewayRuntimeEnv({
      PATH: '/usr/bin',
      DASHSCOPE_API_KEY: 'sk-host-secret',
      DEEPSEEK_API_KEY: 'sk-another',
      ANTHROPIC_API_KEY: 'sk-built-in-provider',
    });

    expect(env.DASHSCOPE_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    // Built-in providers ship inside the runtime and are never installed, so
    // their credentials are not part of the failure mode and stay untouched.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-built-in-provider');
  });

  it('leaves empty provider credential values alone', () => {
    // An empty value never triggers an install (OpenClaw tests for a non-blank
    // string), and deleting it would mask a deliberate `VAR=` unset.
    const env = buildGatewayRuntimeEnv({ QWEN_API_KEY: '', MODELSTUDIO_API_KEY: '   ' });

    expect(env.QWEN_API_KEY).toBe('');
    expect(env.MODELSTUDIO_API_KEY).toBe('   ');
  });
});
