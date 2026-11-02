import { Network, createOutput } from "@tari-project/ootle";
import { generateOotleAddress, publicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { describe, expect, it } from "vitest";
import { BucketStealthTransfer } from "./bucketStealthTransfer";

const RESOURCE = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const ACCOUNT = "component_" + "ab".repeat(32);

function scalar(seed: number): Uint8Array {
  const b = new Uint8Array(32);
  b[0] = seed;
  return b;
}

const provider = {
  network: () => Network.Esmeralda,
  getCurrentEpoch: async () => 100,
  getSubstate: async () => ({ version: 0, state: { down: {} }, verified: false }),
  resolveInputs: async (inputs: unknown[]) => inputs,
} as never;

describe("BucketStealthTransfer", () => {
  it("leaves the revealed output on the workspace and appends the follow-ups instead of depositing", async () => {
    const owner = publicKeyFromSecretKey(scalar(7));
    const view = publicKeyFromSecretKey(scalar(9));
    const address = generateOotleAddress(owner, view, Network.Esmeralda);
    const followUp = { CallMethod: { call: { Address: "component_" + "cd".repeat(32) }, method: "pay", args: [{ Workspace: { id: 1, offset: null } }] } };

    const spec = await new BucketStealthTransfer(provider, RESOURCE)
      .spendRevealedInput(ACCOUNT, 1001n)
      .toStealthOutput(createOutput({ destination: address, amount: 1n, resourceAddress: RESOURCE }))
      .toRevealedOutputAsBucket(1000n, "bucket", owner)
      .andThen([followUp as never])
      .prepare();

    const instructions = spec.unsignedTx.instructions as unknown as Record<string, any>[];
    const kinds = instructions.map((i) => Object.keys(i)[0]);
    expect(kinds).toEqual(["CallMethod", "PutLastInstructionOutputOnWorkspace", "StealthTransfer", "PutLastInstructionOutputOnWorkspace", "CallMethod"]);
    expect(instructions[0]!.CallMethod.method).toBe("withdraw");
    expect(instructions[4]).toEqual(followUp);
    // No deposit back into the source account.
    expect(instructions.some((i) => i.CallMethod?.method === "deposit")).toBe(false);
    expect(spec.statement.outputsStatement).toBeDefined();
  });

  it("without a bucket behaves like upstream (deposits the revealed output)", async () => {
    const owner = publicKeyFromSecretKey(scalar(7));
    const view = publicKeyFromSecretKey(scalar(9));
    const address = generateOotleAddress(owner, view, Network.Esmeralda);
    const spec = await new BucketStealthTransfer(provider, RESOURCE)
      .spendRevealedInput(ACCOUNT, 1001n)
      .toStealthOutput(createOutput({ destination: address, amount: 1n, resourceAddress: RESOURCE }))
      .toRevealedOutput(1000n, owner)
      .prepare();
    const instructions = spec.unsignedTx.instructions as unknown as Record<string, any>[];
    expect(instructions.at(-1)!.CallMethod.method).toBe("deposit");
  });
});
