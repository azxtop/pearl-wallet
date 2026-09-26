import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { bech32m } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

// Pearl MainNetParams.HDCoinType; BIP-86 P2TR external receive branch.
export const PEARL_COIN_TYPE = 808276;
export const RECEIVE_GAP_LIMIT = 20;
export const GRAINS_PER_PRL = 100_000_000n;
export const RPC_URL = "https://rpc.pearlbridge.xyz/";

export function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isValidMnemonic(input: string): boolean {
  return validateMnemonic(normalizeMnemonic(input), wordlist);
}

export function newMnemonic(): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error("安全随机数不可用，已停止创建钱包");
  const entropy = crypto.getRandomValues(new Uint8Array(16));
  try {
    return entropyToMnemonic(entropy, wordlist);
  } finally {
    entropy.fill(0);
  }
}

export function receivePath(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= RECEIVE_GAP_LIMIT) throw new Error("地址序号无效");
  return `m/86'/${PEARL_COIN_TYPE}'/0'/0/${index}`;
}

function taggedHash(tag: string, input: Uint8Array): Uint8Array {
  const prefix = sha256(new TextEncoder().encode(tag));
  const data = new Uint8Array(prefix.length * 2 + input.length);
  data.set(prefix);
  data.set(prefix, prefix.length);
  data.set(input, prefix.length * 2);
  return sha256(data);
}

function bigintFromBytes(data: Uint8Array): bigint {
  let result = 0n;
  for (const byte of data) result = (result << 8n) + BigInt(byte);
  return result;
}

function bigintToBytes(value: bigint): Uint8Array {
  const result = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    result[i] = Number(value & 255n);
    value >>= 8n;
  }
  return result;
}

export function addressFromPublicKey(compressed: Uint8Array): string {
  if (compressed.length !== 33) throw new Error("Pearl 公钥格式无效");
  const internal = compressed.slice(1);
  const point = secp256k1.ProjectivePoint.fromHex(Uint8Array.from([2, ...internal]));
  const tweak = bigintFromBytes(taggedHash("TapTweak", internal));
  if (tweak >= secp256k1.CURVE.n) throw new Error("Taproot tweak 无效");
  const output = point.add(secp256k1.ProjectivePoint.BASE.multiply(tweak));
  const key = bigintToBytes(output.toAffine().x);
  return bech32m.encode("prl", [1, ...bech32m.toWords(key)], 90);
}

export function isValidPearlAddress(address: string): boolean {
  try {
    const decoded = bech32m.decode(address as `${string}1${string}`, 90);
    return decoded.prefix === "prl" && decoded.words[0] === 1 && bech32m.fromWords(decoded.words.slice(1)).length === 32;
  } catch {
    return false;
  }
}

export async function derivePearlWallet(mnemonicInput: string) {
  const mnemonic = normalizeMnemonic(mnemonicInput);
  if (!isValidMnemonic(mnemonic)) throw new Error("助记词无效");
  const seed = await mnemonicToSeed(mnemonic);
  try {
    const master = HDKey.fromMasterSeed(seed);
    try {
      const children = Array.from({ length: RECEIVE_GAP_LIMIT }, (_, index) => master.derive(receivePath(index)));
      const addresses = children.map((child) => {
        if (!child.publicKey) throw new Error("地址推导失败");
        return addressFromPublicKey(child.publicKey);
      });
      return { children, addresses };
    } finally {
      master.privateKey?.fill(0);
    }
  } finally {
    seed.fill(0);
  }
}

export function parsePrl(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) throw new Error("金额最多保留 8 位小数");
  const [whole, fraction = ""] = value.split(".");
  const grains = BigInt(whole) * GRAINS_PER_PRL + BigInt(fraction.padEnd(8, "0"));
  if (grains <= 0n) throw new Error("金额必须大于零");
  return grains;
}

export function formatPrl(grains: bigint, maxFraction = 8): string {
  const sign = grains < 0n ? "-" : "";
  const abs = grains < 0n ? -grains : grains;
  const whole = abs / GRAINS_PER_PRL;
  const fraction = (abs % GRAINS_PER_PRL).toString().padStart(8, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${sign}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
