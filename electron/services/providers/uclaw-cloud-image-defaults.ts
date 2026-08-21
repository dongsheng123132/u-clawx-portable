import { logger } from '../../utils/logger';
import { readOpenClawConfig } from '../../utils/channel-config';
import { readOpenAiCompatibleImageRelayState } from '../../utils/openclaw-auth';
import {
  applyOpenAiImageRelaySettings,
  readImageGenerationConfig,
  setImageGenerationConfig,
} from '../../utils/openclaw-image-generation';
import {
  CLAWX_OPENAI_IMAGE_DEFAULT_MODEL,
  CLAWX_OPENAI_IMAGE_PROVIDER_KEY,
} from '../../utils/openclaw-image-relay-constants';
import { detectBestEndpoint, UCLAW_CLOUD_PRIMARY_API_BASE } from './uclaw-cloud-endpoint';

/**
 * 给 image_generate 工具配一个 OpenAI Images 兼容端点，指向虾盘云。
 * **它和聊天 provider 完全独立** —— 单独的 relay、单独的模型选择。
 *
 * 模型按规范来（虾盘云《系统不变量与开发规范》三之二）：
 *   推荐用哪个 → 注册表 featured 里 kind=image 的那个（当前是 gpt-image-2）
 *   拉不到     → 退回上游常量 CLAWX_OPENAI_IMAGE_DEFAULT_MODEL（也是 gpt-image-2）
 * 这里**不硬编码模型 id**，调用方把策展结果传进来。
 *
 * 绝不覆盖用户选择：已经配过主图像模型就不动；relay 属于别家 provider
 * （用户自己配的 models.providers.openai 之类）也不动。
 * 用户随时可以在设置里改端点、换模型、或者整个关掉。
 */
export async function ensureUclawCloudImageDefaults(
  apiKey: string,
  options: { apiBaseUrl?: string; model?: string } = {},
): Promise<void> {
  const { apiBaseUrl } = options;
  const imageModel = options.model?.trim() || CLAWX_OPENAI_IMAGE_DEFAULT_MODEL;
  const imageRef = `${CLAWX_OPENAI_IMAGE_PROVIDER_KEY}/${imageModel}`;
  const key = apiKey?.trim();
  if (!key) {
    return;
  }

  try {
    const current = await readImageGenerationConfig();
    if (current.primary) {
      return;
    }

    const config = await readOpenClawConfig();
    const relay = readOpenAiCompatibleImageRelayState(config as Record<string, unknown>);
    if (relay.enabled && relay.providerKey !== CLAWX_OPENAI_IMAGE_PROVIDER_KEY) {
      return;
    }

    if (!relay.enabled) {
      const baseUrl = apiBaseUrl?.trim() || (await detectBestEndpoint().catch(() => ({
        apiBase: UCLAW_CLOUD_PRIMARY_API_BASE,
      }))).apiBase;
      await applyOpenAiImageRelaySettings({
        enabled: true,
        baseUrl,
        apiKey: key,
        model: imageModel,
      });
    }

    await setImageGenerationConfig({
      primary: imageRef,
      fallbacks: [],
      timeoutMs: null,
    });
    logger.info(`[uclaw-cloud] 已配置图像生成端点：${imageRef}`);
  } catch (error) {
    // Image defaults are best-effort — never block provider bootstrap on them.
    logger.warn('[uclaw-cloud] Failed to seed default image generation:', error);
  }
}
