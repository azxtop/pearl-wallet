import { bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { maxSpendable, prepareSend, SEND_FEE_RATES } from './send';
import { formatPrlInput, parsePrl } from './pearl';
import type { WalletUtxo } from './rpc';

const address = bech32m.encode('prl', [1, ...bech32m.toWords(new Uint8Array(32).fill(1))], 90);
const destination = bech32m.encode('prl', [1, ...bech32m.toWords(new Uint8Array(32).fill(2))], 90);
const utxos: WalletUtxo[] = [
  { txid: 'a'.repeat(64), vout: 0, valueGrains: 200_000_000n, scriptHex: '5120', poolIndex: 0 },
  { txid: 'b'.repeat(64), vout: 0, valueGrains: 100_000_000n, scriptHex: '5120', poolIndex: 0 },
];

describe('send fee choices and maximum amount', () => {
  it('makes MAX spendable and leaves no change at every fee tier', () => {
    for (const rate of Object.values(SEND_FEE_RATES)) {
      const maximum = maxSpendable(utxos, rate);
      const preview = prepareSend(utxos, destination, maximum, address, rate);
      expect(BigInt(preview.amountGrains)).toBe(maximum);
      expect(BigInt(preview.feeGrains)).toBe(300_000_000n - maximum);
      expect(preview.outputs).toHaveLength(1);
      expect(preview.changeGrains).toBe('0');
    }
  });

  it('uses the selected rate and does not add uneconomical tiny inputs to MAX', () => {
    const tiny = { ...utxos[0], txid: 'c'.repeat(64), valueGrains: 100n };
    const maximum = maxSpendable([...utxos, tiny], SEND_FEE_RATES.priority);
    expect(maximum).toBe(maxSpendable(utxos, SEND_FEE_RATES.priority));
    const preview = prepareSend([...utxos, tiny], destination, maximum, address, SEND_FEE_RATES.priority);
    expect(preview.inputs).toHaveLength(2);
    expect(() => prepareSend(utxos, destination, maximum + 1n, address, SEND_FEE_RATES.priority)).toThrow();
  });

  it('keeps MAX amounts above 1,000 PRL valid when inserted into the amount field', () => {
    const largeUtxos = [{ ...utxos[0], valueGrains: 123_456_789_123n }];
    const maximum = maxSpendable(largeUtxos);
    const amountText = formatPrlInput(maximum);
    expect(amountText).toBe('1234.56788899');
    expect(parsePrl(amountText)).toBe(maximum);
    expect(prepareSend(largeUtxos, destination, parsePrl(amountText), address).changeGrains).toBe('0');
  });
});
