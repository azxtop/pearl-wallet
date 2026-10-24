import { expect, it } from 'vitest';
import { shouldOfferUpdate } from './update-policy';

it('never offers an update on Wallet, even when a newer version is known', () => {
  expect(shouldOfferUpdate('wallet', '0.2.43', '0.2.44', null)).toBe(false);
  expect(shouldOfferUpdate('market', '0.2.43', '0.2.44', null)).toBe(true);
  expect(shouldOfferUpdate('setting', '0.2.43', '0.2.44', null)).toBe(true);
  expect(shouldOfferUpdate('market', '0.2.43', '0.2.43', null)).toBe(false);
});

it('defers only the dismissed version, and offers it again after the deferral expires', () => {
  const deferred = JSON.stringify({ version: '0.2.44', until: 2000 });
  expect(shouldOfferUpdate('market', '0.2.43', '0.2.44', deferred, 1000)).toBe(false);
  expect(shouldOfferUpdate('market', '0.2.43', '0.2.45', deferred, 1000)).toBe(true);
  expect(shouldOfferUpdate('market', '0.2.43', '0.2.44', deferred, 2001)).toBe(true);
  expect(shouldOfferUpdate('market', '0.2.43', '0.2.44', 'damaged', 1000)).toBe(true);
});
