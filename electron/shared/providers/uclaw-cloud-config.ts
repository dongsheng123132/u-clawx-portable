import bundledConfig from './uclaw-cloud-endpoints.json';

export type UclawCloudEndpointCandidate = {
  id: string;
  apiBase: string;
  payBase: string;
};

/**
 * U-ClawX cloud endpoint policy — the single bundled source of truth.
 * The portable packager copies this same JSON next to U-ClawX.exe so an
 * operator can change the ordered endpoints without rebuilding the app.
 */
export const UCLAW_CLOUD_ENDPOINTS = bundledConfig.endpoints as UclawCloudEndpointCandidate[];

export const UCLAW_CLOUD_PRIMARY_ENDPOINT = UCLAW_CLOUD_ENDPOINTS[0];
export const UCLAW_CLOUD_FALLBACK_ENDPOINT = UCLAW_CLOUD_ENDPOINTS[1];
