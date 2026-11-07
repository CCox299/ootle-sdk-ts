import { describe, expect, it } from "vitest";
import { fetchSubstatesDecoded, MAX_SUBSTATES_PER_REQUEST } from "./indexerDecode";

function fakeProvider() {
  const calls: string[][] = [];
  return {
    calls,
    async fetchSubstates(ids: string[]) {
      calls.push(ids);
      // The real indexer's behaviour: "Cannot request more than 20 substates at once".
      if (ids.length > MAX_SUBSTATES_PER_REQUEST) throw new Error("HTTP 400: Cannot request more than 20 substates at once");
      return { substates: Object.fromEntries(ids.map((id) => [id, { version: 1, substate: { id } }])) };
    },
  };
}

describe("fetchSubstatesDecoded", () => {
  it("splits a large request and merges every answer", async () => {
    const provider = fakeProvider();
    const ids = Array.from({ length: 47 }, (_, i) => `vault_${i}`);
    const { substates } = await fetchSubstatesDecoded(provider as never, ids);
    expect(provider.calls.map((c) => c.length)).toEqual([20, 20, 7]);
    expect(Object.keys(substates).sort()).toEqual([...ids].sort());
  });

  it("makes one request when the ids fit in one", async () => {
    const provider = fakeProvider();
    await fetchSubstatesDecoded(provider as never, ["a", "b"]);
    expect(provider.calls.length).toBe(1);
  });

  it("still answers for an empty list", async () => {
    const provider = fakeProvider();
    expect((await fetchSubstatesDecoded(provider as never, [])).substates).toEqual({});
  });
});
