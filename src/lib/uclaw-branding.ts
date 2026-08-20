type DealerBrandInfo = {
  description?: unknown;
  marker?: unknown;
  short_name?: unknown;
  version?: unknown;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getUclawDealerDescription(dealer?: DealerBrandInfo | null): string {
  return stringValue(dealer?.description) || stringValue(dealer?.marker);
}

export function getUclawDealerShortName(dealer?: DealerBrandInfo | null): string {
  return stringValue(dealer?.short_name);
}

export function getUclawDealerVersion(dealer?: DealerBrandInfo | null): string {
  return stringValue(dealer?.version);
}

export function getUclawMaskedMobile(mobile?: unknown): string {
  const value = stringValue(mobile);
  if (value.length < 11) return value;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function getUclawSidebarBrandName(dealer?: DealerBrandInfo | null): string {
  const shortName = getUclawDealerShortName(dealer);
  return shortName ? `U-Claw (${shortName})` : 'U-Claw';
}

export function getUclawAboutTagline(
  dealer: DealerBrandInfo | null | undefined,
  fallback: string,
): string {
  return getUclawDealerDescription(dealer) || fallback;
}
