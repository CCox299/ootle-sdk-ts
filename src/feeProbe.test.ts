import { describe, expect, it } from "vitest";
import { requiredFeeFromRejection, unshieldFeeProbes } from "./wallet";

describe("requiredFeeFromRejection", () => {
  it("reads every wording the engine uses", () => {
    expect(requiredFeeFromRejection(new Error("Required fees 11049 but 4522 paid"))).toBe(11049n);
    expect(requiredFeeFromRejection(new Error("Committing requires 11049 but 4522 paid"))).toBe(11049n);
    // The real 0.50 abort, which names the paid amount first.
    expect(
      requiredFeeFromRejection(new Error("Transaction cc80 was aborted (InsufficientFeesPaid): Insufficient fees paid: Insufficient fees paid: 4522, required fees: 11049")),
    ).toBe(11049n);
    expect(requiredFeeFromRejection("Required fees 7 but 1 paid")).toBe(7n);
  });

  it("returns null when no fee is named", () => {
    expect(requiredFeeFromRejection(new Error("Insufficient fees to fund native verification requiring 900 points: 1 of 2 allowance points already consumed"))).toBeNull();
    expect(requiredFeeFromRejection(new Error("Resource did not contain sufficient balance"))).toBeNull();
  });
});

describe("unshieldFeeProbes", () => {
  it("keeps a change output when the balance is below maxFee", () => {
    // The live failure: 60000 held, 20000 unshielded. The old probe of 59999 consumed all the change,
    // so the dry run priced 4522 for a transaction that really needed 11049.
    const { first, withoutChange } = unshieldFeeProbes(40_000n, 20_000n, 100_000n);
    expect(first).toBe(39_999n);
    expect(first).toBeLessThan(40_000n);
    expect(withoutChange).toBe(59_999n);
  });

  it("uses maxFee when it still leaves change", () => {
    expect(unshieldFeeProbes(500_000n, 20_000n, 100_000n).first).toBe(100_000n);
  });

  it("has only the change-free shape when nothing can remain", () => {
    expect(unshieldFeeProbes(0n, 60_000n, 100_000n)).toEqual({ first: 59_999n, withoutChange: null });
    expect(unshieldFeeProbes(1n, 60_000n, 100_000n)).toEqual({ first: 60_000n, withoutChange: null });
  });
});
