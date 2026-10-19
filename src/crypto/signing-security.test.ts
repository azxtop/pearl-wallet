// All secrets below are public, unfunded test fixtures.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, concatBytes } from '@noble/hashes/utils';
import { decryptMnemonic, encryptMnemonic } from '../lib/keystore';
import { scriptForAddress } from '../lib/send';



const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'audit-only-public-password';
let blob: any, addresses: string[], base: any, nextId = 0;
const messages = new Map<number, any>();
const host: any = { onmessage: null, postMessage: (m: any) => messages.set(m.id, m) };
async function request(cmd: string, payload: any = {}) {
  const id = ++nextId;
  await host.onmessage({ data: { id, cmd, payload } });
  return messages.get(id);
}
const le = (value: bigint | number, size: number) => {
  let n = BigInt(value); const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++, n >>= 8n) bytes[i] = Number(n & 255n);
  return bytes;
};
const varBytes = (b: Uint8Array) => concatBytes(new Uint8Array([b.length]), b);

describe('independent wallet security probes (no network or real funds)', () => {
  beforeAll(async () => {
    vi.stubGlobal('self', host);
    await import('./wallet-worker');
    const result = await request('restore', { mnemonic: phrase, password });
    expect(result.error).toBeUndefined();
    ({ blob, addresses } = result.result);
    base = {
      destination: addresses[1], amountGrains: '10000000', feeGrains: '400', changeGrains: '189999600',
      inputs: [0, 1].map((i) => ({ txid: (i ? '89abcdef' : '01234567').repeat(8), vout: i + 2,
        valueGrains: '100000000', scriptHex: scriptForAddress(addresses[i]), poolIndex: i })),
      outputs: [{ address: addresses[1], amountGrains: '10000000' }, { address: addresses[0], amountGrains: '189999600' }],
    };
  });
  afterAll(() => vi.unstubAllGlobals());

  it('verifies raw two-input Schnorr signatures with a separately constructed BIP341 digest', async () => {
    const result = await request('sign', { blob, preview: base, password });
    expect(result.error).toBeUndefined();
    const raw = hexToBytes(result.result.rawHex);
    let at = 0;
    const take = (n: number) => { const b = raw.slice(at, at + n); at += n; return b; };
    const version = take(4);
    expect([...take(2)]).toEqual([0, 1]);
    expect(take(1)[0]).toBe(2);
    const outpoints: Uint8Array[] = [], sequences: Uint8Array[] = [];
    for (const input of base.inputs) {
      const outpoint = take(36);
      expect(outpoint).toEqual(concatBytes(hexToBytes(input.txid).reverse(), le(input.vout, 4)));
      outpoints.push(outpoint);
      expect(take(1)[0]).toBe(0);
      sequences.push(take(4));
    }
    expect(take(1)[0]).toBe(2);
    const outputs: Uint8Array[] = [];
    for (const output of base.outputs) {
      const expected = concatBytes(le(output.amountGrains, 8), varBytes(hexToBytes(scriptForAddress(output.address))));
      const actual = take(expected.length); expect(actual).toEqual(expected); outputs.push(actual);
    }
    const signatures: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) {
      expect(take(1)[0]).toBe(1); expect(take(1)[0]).toBe(64); signatures.push(take(64));
    }
    const locktime = take(4); expect(at).toBe(raw.length);
    const nonWitness = concatBytes(version, new Uint8Array([2]), ...outpoints.map((point, index) =>
      concatBytes(point, new Uint8Array([0]), sequences[index])), new Uint8Array([2]), ...outputs, locktime);
    expect(result.result.txid).toBe(Buffer.from(sha256(sha256(nonWitness))).reverse().toString('hex'));
    const tag = sha256(new TextEncoder().encode('TapSighash'));
    const common = concatBytes(new Uint8Array([0, 0]), version, locktime,
      sha256(concatBytes(...outpoints)),
      sha256(concatBytes(...base.inputs.map((i: any) => le(i.valueGrains, 8)))),
      sha256(concatBytes(...base.inputs.map((i: any) => varBytes(hexToBytes(i.scriptHex))))),
      sha256(concatBytes(...sequences)), sha256(concatBytes(...outputs)), new Uint8Array([0]));
    for (let i = 0; i < 2; i++) {
      const digest = sha256(concatBytes(tag, tag, common, le(i, 4)));
      expect(schnorr.verify(signatures[i], digest, hexToBytes(base.inputs[i].scriptHex).slice(2))).toBe(true);
      digest[0] ^= 1;
      expect(schnorr.verify(signatures[i], digest, hexToBytes(base.inputs[i].scriptHex).slice(2))).toBe(false);
    }
  });

  it.each([
    ['foreign change address', (p: any) => { p.outputs[1].address = addresses[2]; }],
    ['changed recipient', (p: any) => { p.outputs[0].address = addresses[2]; }],
    ['changed amount', (p: any) => { p.outputs[0].amountGrains = '9999999'; }],
    ['wrong input script', (p: any) => { p.inputs[0].scriptHex = scriptForAddress(addresses[3]); }],
    ['duplicate input', (p: any) => { p.inputs[1] = { ...p.inputs[0] }; }],
    ['excessive fee', (p: any) => { p.feeGrains = '1000001'; p.changeGrains = p.outputs[1].amountGrains = '188999999'; }],
    ['extra output', (p: any) => { p.outputs.push({ ...p.outputs[0] }); }],
    ['invalid input index', (p: any) => { p.inputs[0].poolIndex = 20; }],
    ['negative output index', (p: any) => { p.inputs[0].vout = -1; }],
    ['overflow output index', (p: any) => { p.inputs[0].vout = 2 ** 32; }],
    ['fractional output index', (p: any) => { p.inputs[0].vout = 0.5; }],
    ['negative input value', (p: any) => { p.inputs[0].valueGrains = '-1'; }],
    ['overflow input value', (p: any) => { p.inputs[0].valueGrains = (2n ** 64n).toString(); }],
    ['non-numeric input value', (p: any) => { p.inputs[0].valueGrains = 'NaN'; }],
    ['mixed-case duplicate input', (p: any) => { p.inputs[1] = { ...p.inputs[0], txid: p.inputs[0].txid.toUpperCase() }; }],
    ['no inputs', (p: any) => { p.inputs = []; }],
    ['no outputs', (p: any) => { p.outputs = []; }],
  ])('rejects %s', async (_name, mutate) => {
    const preview = structuredClone(base); mutate(preview);
    expect((await request('sign', { blob, preview, biometricMnemonic: phrase })).error).toBeTruthy();
  });

  it('rejects wrong password even when a session has already been unlocked', async () => {
    expect((await request('sign', { blob, preview: base, password: 'incorrect-password' })).error).toBeTruthy();
    expect((await request('sign', { blob, preview: base })).error).toBeTruthy();
  });

  it('authenticates ciphertext, address and encryption metadata', async () => {
    const encrypted = await encryptMnemonic(phrase, password, addresses[0]);
    for (const field of ['ciphertext', 'iv', 'salt'] as const) {
      const changed = { ...encrypted };
      const data = Buffer.from(changed[field], 'base64'); data[0] ^= 1; changed[field] = data.toString('base64');
      await expect(decryptMnemonic(changed, password)).rejects.toThrow();
    }
    await expect(decryptMnemonic({ ...encrypted, address: addresses[1] }, password)).rejects.toThrow();
  });

  it('rejects a missing preview instead of producing any signed bytes', async () => {
    expect((await request('sign', { blob, preview: null, biometricMnemonic: phrase })).error).toBeTruthy();
  });
});
