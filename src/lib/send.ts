import { bech32m } from "@scure/base";
import { GRAINS_PER_PRL, isValidPearlAddress } from "./pearl";
import type { WalletUtxo } from "./rpc";

export interface SendPreview {
  destination: string;
  amountGrains: string;
  feeGrains: string;
  changeGrains: string;
  inputs: { txid: string; vout: number; valueGrains: string; scriptHex: string; poolIndex: number }[];
  outputs: { address: string; amountGrains: string }[];
}

const FEE_RATE = 2n;
const DUST = 546n;
const MAX_FEE = GRAINS_PER_PRL / 100n;

export function scriptForAddress(address: string): string {
  if (!isValidPearlAddress(address)) throw new Error("收款地址无效");
  const decoded = bech32m.decode(address as `${string}1${string}`, 90);
  return "5120" + Array.from(bech32m.fromWords(decoded.words.slice(1)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function estimateFee(inputs: number, outputs: number): bigint {
  return (11n + 58n * BigInt(inputs) + 43n * BigInt(outputs)) * FEE_RATE;
}

export function prepareSend(utxos: WalletUtxo[], destination: string, amountGrains: bigint, changeAddress: string): SendPreview {
  scriptForAddress(destination);
  scriptForAddress(changeAddress);
  if (amountGrains < DUST) throw new Error("转账金额低于链上最小输出");
  const sorted = [...utxos].sort((a, b) => a.valueGrains > b.valueGrains ? -1 : a.valueGrains < b.valueGrains ? 1 : 0);
  const selected: WalletUtxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.valueGrains;
    if (total >= amountGrains + estimateFee(selected.length, 2)) break;
  }
  if (!selected.length) throw new Error("没有可用的链上资金");
  let fee = estimateFee(selected.length, 2);
  if (total < amountGrains + fee) throw new Error("PRL 余额不足以支付金额和手续费");
  let change = total - amountGrains - fee;
  if (change < DUST) {
    fee = total - amountGrains;
    change = 0n;
  }
  if (fee > MAX_FEE) throw new Error("手续费超过安全上限，请减少输入数量");
  const outputs = [{ address: destination, amountGrains: amountGrains.toString() }];
  if (change > 0n) outputs.push({ address: changeAddress, amountGrains: change.toString() });
  return {
    destination,
    amountGrains: amountGrains.toString(),
    feeGrains: fee.toString(),
    changeGrains: change.toString(),
    inputs: selected.map((utxo) => ({ ...utxo, valueGrains: utxo.valueGrains.toString() })),
    outputs,
  };
}
