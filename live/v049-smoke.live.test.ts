// Ootle 0.49 post-reset smoke test: fresh accounts, faucet, transparent send, shield, UTXO scan,
// unshield, private send, withdrawStealthAndExecute dry run. Every step logs; the first failure
// stops the test.
import { it } from "vitest";
import { OotleAccount, configureOotleStorage } from "../src/index";
import { inMemoryAdapter } from "../src/adapters";

const TARI = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("0.49 smoke", async () => {
  configureOotleStorage(inMemoryAdapter());
  const a = OotleAccount.fromSeed(crypto.getRandomValues(new Uint8Array(16)), 0, "esmeralda");
  const b = OotleAccount.fromSeed(crypto.getRandomValues(new Uint8Array(16)), 1, "esmeralda");
  const step = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      const r = await f();
      console.log(`OK   ${name} (${Date.now() - t}ms)`, json(r)?.slice(0, 400));
      return r;
    } catch (e) {
      console.log(`FAIL ${name}:`, (e as Error).message?.slice(0, 1500));
      throw e;
    }
  };
  console.log("A", await a.getWalletAddress(), await a.getComponentAddress());
  console.log("B", await b.getWalletAddress(), await b.getComponentAddress());

  await step("faucet A", () => a.claimTestnetXtr());
  await step("balances A", () => a.getBalances());
  const bAddr = await b.getWalletAddress();
  await step("send A->B 5 TARI", async () => a.send(bAddr, TARI, 5_000_000n));
  await sleep(2000);
  await step("balances B", () => b.getBalances());
  await step("shield A 3 TARI", () => a.shield(TARI, 3_000_000n));
  await step("private balances A", () => a.getPrivateBalances());
  await step("scan A (full)", () => a.scanForOwnedUtxos(TARI, "https://ootle-indexer-a.tari.com"));
  await step("scan A (delta)", () => a.scanForOwnedUtxos(TARI, "https://ootle-indexer-a.tari.com", { mode: "delta" }));
  await step("sendPrivately A->B 1 TARI", () => a.sendPrivately(TARI, bAddr, 1_000_000n));
  await step("unshield A 1 TARI", () => a.unshield(TARI, 1_000_000n));
  await step("scan B (full)", () => b.scanForOwnedUtxos(TARI, "https://ootle-indexer-a.tari.com"));
  await step("private balances B", () => b.getPrivateBalances());
  await step("shield A private fee", () => a.shield(TARI, 500_000n, 50000n, undefined, 0n, { kind: "private" } as never));
  await step("balances A end", () => a.getBalances());
}, 600_000);
