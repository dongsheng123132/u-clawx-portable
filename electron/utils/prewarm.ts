import { request } from 'node:http';
import type { GatewayManager } from '../gateway/manager';
import { logger } from './logger';

/**
 * 网关预热线程：HTTP 就绪后立刻在后台焐热模型子系统。
 *
 * 背景（pc-8308 实测，2026-08-24）：网关进程「就绪」只代表 HTTP 能应答，模型
 * 子系统（providers / pricing / models 列表）仍是冷的——用户点第一条消息时才
 * 现场加载，U 盘上这一下要等好几秒。这里在后台提前打一轮带鉴权的轻量请求，
 * 把相关代码路径和缓存焐热。零依赖（node:http），全部 fire-and-forget：
 * 任何失败都静默，绝不影响网关状态判断。
 *
 * 鉴权 token 从 gatewayManager 拿（与 ws-client 同源），拿不到就发无鉴权探测
 * （等价于现状的 ready 探测，仍有预热价值）。
 */

const PREWARM_PATHS = ['/v1/models'] as const;
const PREWARM_TIMEOUT_MS = 8_000;

let warmed = false;

function prewarmOnce(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const req = request(
        { host: '127.0.0.1', port, path, method: 'GET', headers, timeout: PREWARM_TIMEOUT_MS },
        (res) => {
          // 响应体必须消费掉，socket 才会释放；不需要内容。
          res.resume();
          res.on('end', finish);
          res.on('error', finish);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        finish();
      });
      req.on('error', finish);
      req.end();
    } catch {
      finish();
    }
  });
}

/**
 * 网关就绪后调用一次；进程级去重（网关重启/重连反复触发 running 事件时不再重复预热）。
 */
export function prewarmGatewayModels(gatewayManager: GatewayManager): void {
  if (warmed) return;
  warmed = true;
  void (async () => {
    try {
      const status = gatewayManager.getStatus();
      const port = typeof status?.port === 'number' ? status.port : 18789;

      let authHeaders: Record<string, string> = {};
      try {
        const { getSetting } = await import('./store');
        const token = await getSetting('gatewayToken');
        if (token) authHeaders = { Authorization: `Bearer ${token}` };
      } catch {
        // 无 token 就裸探。
      }

      for (const path of PREWARM_PATHS) {
        await prewarmOnce(port, path, authHeaders);
      }
      logger.debug('[prewarm] model subsystem warmup finished');
    } catch (err) {
      logger.debug('[prewarm] skipped:', err instanceof Error ? err.message : err);
    }
  })();
}
