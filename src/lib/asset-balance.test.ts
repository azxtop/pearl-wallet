import { describe, expect, it } from 'vitest';
import { estimatedSpotAssetsUSDT, totalAssetBalance } from './asset-balance';

describe('SafeTrade asset totals', () => {
  it('adds available and order-locked amounts exactly', () => {
    expect(totalAssetBalance({ available: '400.12345678', locked: '99.87654322' })).toBe('500');
    expect(totalAssetBalance({ available: '499.9', locked: '0.1' })).toBe('500');
    expect(totalAssetBalance({ available: '0', locked: '0' })).toBe('0');
  });

  it('includes both assets and locked funds in estimated USDT value', () => {
    const balances = { PRL: { available: '400', locked: '100' }, USDT: { available: '20.5', locked: '4.5' } };
    expect(estimatedSpotAssetsUSDT(balances, 1.5)).toBe(775);
    expect(estimatedSpotAssetsUSDT(balances, null)).toBeNull();
    expect(estimatedSpotAssetsUSDT({ ...balances, PRL: { available: '0', locked: '0' } }, null)).toBe(25);
  });
});
