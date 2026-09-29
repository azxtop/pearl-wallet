import type { AccountData } from './safetrade';

function decimal(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return { value: BigInt(whole + fraction), places: fraction.length };
}

export function totalAssetBalance(balance: { available: string; locked: string }): string | null {
  const available = decimal(balance.available);
  const locked = decimal(balance.locked);
  if (!available || !locked) return null;
  const places = Math.max(available.places, locked.places);
  const sum = available.value * 10n ** BigInt(places - available.places)
    + locked.value * 10n ** BigInt(places - locked.places);
  if (places === 0) return sum.toString();
  const padded = sum.toString().padStart(places + 1, '0');
  const fraction = padded.slice(-places).replace(/0+$/, '');
  return fraction ? `${padded.slice(0, -places)}.${fraction}` : padded.slice(0, -places);
}

export function estimatedSpotAssetsUSDT(balances: AccountData['balances'] | null | undefined, prlPrice: number | null | undefined): number | null {
  if (!balances) return null;
  const prl = totalAssetBalance(balances.PRL);
  const usdt = totalAssetBalance(balances.USDT);
  if (prl === null || usdt === null) return null;
  const prlAmount = Number(prl);
  const usdtAmount = Number(usdt);
  if (!Number.isFinite(prlAmount) || !Number.isFinite(usdtAmount)) return null;
  if (prlAmount === 0) return usdtAmount;
  return prlPrice != null && Number.isFinite(prlPrice) && prlPrice > 0
    ? usdtAmount + prlAmount * prlPrice : null;
}
