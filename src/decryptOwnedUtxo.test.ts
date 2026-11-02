import { describe, expect, it } from "vitest";
import { Network, WasmStealthCrypto, createOutput, decryptOwnedUtxo as upstream } from "@tari-project/ootle";
import { OotleAccount } from "./index";
import { decryptOwnedUtxo } from "./wallet";

const R = "resource_0101010101010101010101010101010101010101010101010101010101010101";

async function ownedOutput() {
  const account = OotleAccount.fromSeed(new Uint8Array(16).fill(3), 0, "esmeralda") as any;
  const crypto = new WasmStealthCrypto(Network.Esmeralda);
  const out = createOutput({ destination: await account.getWalletAddress(), amount: 12345n, resourceAddress: R });
  const { statement } = await crypto.generateOutputsStatement([out], null as never);
  const o = (statement.parsed() as any).outputs[0].output;
  // The shape getSubstateDecoded hands back: the CBOR value already decoded.
  const decoded = {
    version: 0,
    state: { up: { substate: { Utxo: { output: { output: { public_nonce: o.sender_public_nonce, encrypted_data: o.encrypted_data, minimum_value_promise: 0, viewable_balance: null }, auth: { Key: "00".repeat(32) }, tag: 1 }, is_frozen: false } } } },
  };
  return { crypto, viewSecret: await account.signer.getViewSecret(), decoded, substateId: `utxo_${R.slice(9)}_${o.commitment}` };
}

describe("decryptOwnedUtxo (decoded substate)", () => {
  it("decrypts an already-decoded substate that upstream's helper rejects", async () => {
    const { crypto, viewSecret, decoded, substateId } = await ownedOutput();
    await expect(upstream(crypto, viewSecret, decoded as never, substateId)).rejects.toThrow();
    const d = await decryptOwnedUtxo(crypto, viewSecret, decoded, substateId);
    expect(d?.value).toBe(12345n);
  });

  it("returns null for another key, and for a frozen output", async () => {
    const { crypto, decoded, substateId, viewSecret } = await ownedOutput();
    expect(await decryptOwnedUtxo(crypto, new Uint8Array(32).fill(1), decoded, substateId)).toBeNull();
    const frozen = structuredClone(decoded);
    frozen.state.up.substate.Utxo.is_frozen = true;
    expect(await decryptOwnedUtxo(crypto, viewSecret, frozen, substateId)).toBeNull();
  });
});
