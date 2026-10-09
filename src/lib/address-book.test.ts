import { describe, expect, it } from 'vitest';
import { parseSavedAddresses, profileAddressChoices } from './address-book';
import type { WalletProfile } from './profiles';

const address = 'prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74';
const watch = 'prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm';

describe('send address book', () => {
  it('lists only public profile addresses and removes repeated addresses', () => {
    const profiles: WalletProfile[] = [
      { id: 'one', name: '主钱包', kind: 'wallet', blob: { version: 2, address, salt: 'secret', iv: 'secret', ciphertext: 'secret' }, addresses: [address, watch] },
      { id: 'two', name: '观察地址', kind: 'watch', address: watch },
    ];
    expect(profileAddressChoices(profiles)).toEqual([
      { address, note: '地址 1', profileId: 'one', kind: 'wallet', index: 1 },
      { address: watch, note: '地址 2', profileId: 'one', kind: 'wallet', index: 2 },
      { address: watch, note: '观察地址', profileId: 'two', kind: 'watch', index: 1 },
    ]);
  });

  it('accepts only valid public addresses and bounded notes from local storage', () => {
    expect(parseSavedAddresses(JSON.stringify([
      { address: watch, note: '  Exchange  ', privateKey: 'must never be loaded' },
      { address: watch, note: 'duplicate' },
      { address: 'invalid', note: 'bad' },
    ]))).toEqual([{ address: watch, note: 'Exchange' }]);
  });
});
