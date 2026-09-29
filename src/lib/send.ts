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

export const SEND_FEE_RATES = { economy: 1n, standard: 2n, priority: 4n } as const;
export type SendFeeTier = keyof typeof SEND_FEE_RATES;
const DUST = 546n;
const MAX_FEE = GRAINS_PER_PRL / 100n;

export function scriptForAddress(address: string): string {
  if (!isValidPearlAddress(address)) throw new Error("收款地址无效");
  const decoded = bech32m.decode(address as `${string}1${string}`, 90);
  return "5120" + Array.from(bech32m.fromWords(decoded.words.slice(1)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function estimateFee(inputs: number, outputs: number, feeRate: bigint): bigint {
  return (11n + 58n * BigInt(inputs) + 43n * BigInt(outputs)) * feeRate;
}

export function maxSpendable(utxos: WalletUtxo[], feeRate: bigint = SEND_FEE_RATES.standard): bigint {
  if (feeRate < 1n || feeRate > 1000n) throw new Error("无效手续费率");
  const spendable = utxos.filter((utxo) => utxo.valueGrains > 58n * feeRate);
  if (!spendable.length) return 0n;
  const total = spendable.reduce((sum, utxo) => sum + utxo.valueGrains, 0n);
  const amount = total - estimateFee(spendable.length, 1, feeRate);
  return amount >= DUST ? amount : 0n;
}

export function prepareSend(utxos: WalletUtxo[], destination: string, amountGrains: bigint, changeAddress: string, feeRate: bigint = SEND_FEE_RATES.standard): SendPreview {
  scriptForAddress(destination);
  scriptForAddress(changeAddress);
  if (feeRate < 1n || feeRate > 1000n) throw new Error("无效手续费率");
  if (amountGrains < DUST) throw new Error("转账金额低于链上最小输出");
  const sorted = [...utxos].sort((a, b) => a.valueGrains > b.valueGrains ? -1 : a.valueGrains < b.valueGrains ? 1 : 0);
  const selected: WalletUtxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.valueGrains;
    if (total >= amountGrains + estimateFee(selected.length, 2, feeRate)
      || total >= amountGrains + estimateFee(selected.length, 1, feeRate)
        && total - amountGrains - estimateFee(selected.length, 1, feeRate) < DUST) break;
  }
  if (!selected.length) throw new Error("没有可用的链上资金");
  const feeWithChange = estimateFee(selected.length, 2, feeRate);
  const feeWithoutChange = estimateFee(selected.length, 1, feeRate);
  if (total < amountGrains + feeWithoutChange) throw new Error("PRL 余额不足以支付金额和手续费");
  let fee = feeWithChange;
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
