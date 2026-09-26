import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils";
import { derivePearlWallet, isValidMnemonic, newMnemonic, normalizeMnemonic } from "../lib/pearl";
import { decryptMnemonic, encryptMnemonic, type EncryptedWallet } from "../lib/keystore";
import { scriptForAddress, type SendPreview } from "../lib/send";

interface WalletSession {
  mnemonic: string;
  addresses: string[];
  children: HDKey[];
}

let session: WalletSession | null = null;

function lock() {
  if (session) for (const child of session.children) child.privateKey?.fill(0);
  session = null;
}

async function load(mnemonic: string): Promise<string[]> {
  lock();
  const wallet = await derivePearlWallet(mnemonic);
  session = { mnemonic: normalizeMnemonic(mnemonic), addresses: wallet.addresses, children: wallet.children };
  return wallet.addresses;
}

function requireSession(): WalletSession {
  if (!session) throw new Error("钱包已锁定");
  return session;
}

async function authenticate(blob: EncryptedWallet, password?: string, biometricMnemonic?: string): Promise<WalletSession> {
  const actual = password ? await decryptMnemonic(blob, password) : biometricMnemonic;
  if (!actual || !isValidMnemonic(actual)) throw new Error("转账授权失败");
  const current = session;
  if (current && blob.address === current.addresses[0] && normalizeMnemonic(actual) === current.mnemonic) return current;
  const addresses = await load(actual);
  if (addresses[0] !== blob.address) { lock(); throw new Error("钱包数据不匹配"); }
  return requireSession();
}

async function signSend(blob: EncryptedWallet, preview: SendPreview, password?: string, biometricMnemonic?: string) {
  const wallet = await authenticate(blob, password, biometricMnemonic);
  if (!Array.isArray(preview.inputs) || !preview.inputs.length || !Array.isArray(preview.outputs) || preview.outputs.length > 2) {
    throw new Error("交易结构无效");
  }
  if (preview.destination !== preview.outputs[0]?.address || preview.amountGrains !== preview.outputs[0]?.amountGrains) {
    throw new Error("交易预览已变更");
  }
  if (preview.changeGrains !== (preview.outputs[1]?.amountGrains ?? "0")) throw new Error("找零金额与预览不一致");
  if (preview.outputs[1] && preview.outputs[1].address !== wallet.addresses[0]) throw new Error("找零地址无效");
  let totalIn = 0n;
  let totalOut = 0n;
  const seen = new Set<string>();
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (const input of preview.inputs) {
    if (!/^[a-fA-F0-9]{64}$/.test(input.txid) || !Number.isInteger(input.vout) || input.vout < 0 || !Number.isInteger(input.poolIndex) || input.poolIndex < 0 || input.poolIndex >= wallet.addresses.length) {
      throw new Error("交易输入无效");
    }
    const id = `${input.txid}:${input.vout}`;
    if (seen.has(id)) throw new Error("重复交易输入");
    seen.add(id);
    const value = BigInt(input.valueGrains);
    if (value <= 0n || input.scriptHex.toLowerCase() !== scriptForAddress(wallet.addresses[input.poolIndex]!)) {
      throw new Error("交易输入与钱包地址不匹配");
    }
    const child = wallet.children[input.poolIndex]!;
    if (!child.publicKey) throw new Error("签名公钥缺失");
    tx.addInput({
      txid: hexToBytes(input.txid),
      index: input.vout,
      witnessUtxo: { amount: value, script: hexToBytes(input.scriptHex) },
      tapInternalKey: child.publicKey.slice(1),
    });
    totalIn += value;
  }
  const network = { bech32: "prl", pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
  for (const output of preview.outputs) {
    scriptForAddress(output.address);
    const amount = BigInt(output.amountGrains);
    if (amount < 546n) throw new Error("交易输出低于最小金额");
    tx.addOutputAddress(output.address, amount, network);
    totalOut += amount;
  }
  const fee = totalIn - totalOut;
  if (fee !== BigInt(preview.feeGrains) || fee <= 0n || fee > 1_000_000n) throw new Error("交易手续费异常");
  for (let index = 0; index < preview.inputs.length; index++) {
    const child = wallet.children[preview.inputs[index]!.poolIndex]!;
    if (!child.privateKey) throw new Error("签名私钥缺失");
    tx.signIdx(child.privateKey, index);
  }
  tx.finalize();
  return { rawHex: tx.hex };
}

type Request = { id: number; cmd: string; payload?: Record<string, unknown> };

async function execute(cmd: string, payload: Record<string, unknown>) {
  switch (cmd) {
    case "create": {
      const password = String(payload.password ?? "");
      const mnemonic = newMnemonic();
      const addresses = await load(mnemonic);
      const blob = await encryptMnemonic(mnemonic, password, addresses[0]!);
      return { mnemonic, blob, addresses };
    }
    case "restore": {
      const mnemonic = normalizeMnemonic(String(payload.mnemonic ?? ""));
      if (!isValidMnemonic(mnemonic)) throw new Error("助记词无效或校验和错误");
      const password = String(payload.password ?? "");
      const addresses = await load(mnemonic);
      const blob = await encryptMnemonic(mnemonic, password, addresses[0]!);
      return { blob, addresses };
    }
    case "unlock": {
      const blob = payload.blob as EncryptedWallet;
      const mnemonic = await decryptMnemonic(blob, String(payload.password ?? ""));
      const addresses = await load(mnemonic);
      if (addresses[0] !== blob.address) { lock(); throw new Error("钱包数据不匹配"); }
      return { addresses };
    }
    case "unlockBiometric": {
      const blob = payload.blob as EncryptedWallet;
      const mnemonic = String(payload.mnemonic ?? "");
      if (!isValidMnemonic(mnemonic)) throw new Error("指纹授权数据无效");
      const addresses = await load(mnemonic);
      if (addresses[0] !== blob.address) { lock(); throw new Error("指纹数据与当前钱包不匹配，请输入密码"); }
      return { addresses };
    }
    case "lock": lock(); return { ok: true };
    case "export": {
      const mnemonic = await decryptMnemonic(payload.blob as EncryptedWallet, String(payload.password ?? ""));
      const derived = await derivePearlWallet(mnemonic);
      const matches = derived.addresses[0] === (payload.blob as EncryptedWallet).address;
      for (const child of derived.children) child.privateKey?.fill(0);
      if (!matches) throw new Error("钱包数据不匹配");
      return { mnemonic };
    }
    case "changePassword": {
      const mnemonic = await decryptMnemonic(payload.blob as EncryptedWallet, String(payload.oldPassword ?? ""));
      const derived = await derivePearlWallet(mnemonic);
      const address = derived.addresses[0]!;
      for (const child of derived.children) child.privateKey?.fill(0);
      if (address !== (payload.blob as EncryptedWallet).address) throw new Error("钱包数据不匹配");
      return { blob: await encryptMnemonic(mnemonic, String(payload.newPassword ?? ""), address) };
    }
    case "sign": return signSend(
      payload.blob as EncryptedWallet,
      payload.preview as unknown as SendPreview,
      payload.password === undefined ? undefined : String(payload.password),
      payload.biometricMnemonic === undefined ? undefined : String(payload.biometricMnemonic),
    );
    default: throw new Error("未知钱包操作");
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, cmd, payload = {} } = event.data;
  try {
    self.postMessage({ id, result: await execute(cmd, payload) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "钱包操作失败" });
  }
};
