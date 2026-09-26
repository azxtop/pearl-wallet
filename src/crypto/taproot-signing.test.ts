import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils";
import { schnorr } from "@noble/curves/secp256k1";
import { derivePearlWallet } from "../lib/pearl";
import { prepareSend, scriptForAddress } from "../lib/send";

const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("taproot signing is consensus-valid", () => {
  it("schnorr signatures verify against the tweaked output key", async () => {
    const { children, addresses } = await derivePearlWallet(mnemonic);
    const utxo = {
      txid: "22".repeat(32),
      vout: 0,
      valueGrains: 100_000_000n,
      scriptHex: scriptForAddress(addresses[0]!),
      poolIndex: 0,
    };
    const preview = prepareSend([utxo], addresses[1]!, 10_000_000n, addresses[0]!);
    expect(preview.inputs.length).toBe(1);
    expect(preview.outputs.length).toBe(2);

    // Build exactly like signSend() in src/crypto/wallet-worker.ts
    const tx = new btc.Transaction({ allowUnknownOutputs: false });
    for (const input of preview.inputs) {
      const child = children[input.poolIndex]!;
      tx.addInput({
        txid: hexToBytes(input.txid),
        index: input.vout,
        witnessUtxo: { amount: BigInt(input.valueGrains), script: hexToBytes(input.scriptHex) },
        tapInternalKey: child.publicKey!.slice(1),
      });
    }
    const network = { bech32: "prl", pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
    for (const output of preview.outputs) {
      tx.addOutputAddress(output.address, BigInt(output.amountGrains), network);
    }

    // Sighash preimages BEFORE signing (finalize wipes witnessUtxo)
    const prevScripts = preview.inputs.map((i) => hexToBytes(i.scriptHex));
    const amounts = preview.inputs.map((i) => BigInt(i.valueGrains));
    const messages = preview.inputs.map((_, idx) =>
      tx.preimageWitnessV1(idx, prevScripts, btc.SigHash.DEFAULT, amounts)
    );

    preview.inputs.forEach((input, index) => {
      tx.signIdx(children[input.poolIndex]!.privateKey!, index);
    });
    tx.finalize();

    expect(preview.inputs.length).toBe(1);
    for (let idx = 0; idx < preview.inputs.length; idx++) {
      const input = tx.getInput(idx);
      const witness = (input as { finalScriptWitness?: Uint8Array[] }).finalScriptWitness;
      expect(witness).toBeDefined();
      const sig = witness![0]!;
      expect(sig.length).toBe(64); // DEFAULT sighash: no appended sighash byte
      // The tweaked output key is the last 32 bytes of the P2TR scriptPubKey
      const tweakedKey = hexToBytes(preview.inputs[idx]!.scriptHex).slice(2);
      expect(schnorr.verify(sig, messages[idx]!, tweakedKey)).toBe(true);
    }

    // Also verify the raw hex round-trips and stays a sane segwit tx
    const raw = tx.hex;
    expect(raw).toMatch(/^[0-9a-f]+$/);
    const reparsed = btc.Transaction.fromRaw(hexToBytes(raw));
    expect(reparsed.outputsLength).toBe(2);
    expect(reparsed.inputsLength).toBe(1);

    for (const child of children) child.privateKey?.fill(0);
  });
});
