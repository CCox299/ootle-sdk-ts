// A `StealthTransfer` whose revealed output is left on the workspace as a named bucket (instead of
// being deposited back into the source account), followed by caller-supplied instructions that
// consume it in the same transaction. This is what `withdrawStealthAndExecute` needs; upstream
// `@tari-project/ootle` only offers `toRevealedOutput`, which always deposits the revealed amount.
//
// Replaces the vendored ootle.ts 0.3 fork (`@chironbuilder/ootle-legacy`): everything except the
// final "what happens to the revealed bucket" step is the upstream builder's own code, so the
// statement / input / signer handling tracks upstream releases automatically.
import { StealthTransfer } from "@tari-project/ootle";
import type { Instruction } from "@tari-project/ootle-ts-bindings";

type Internals = {
  state: { revealedOutput: unknown; revealedInput: unknown };
  builder: { saveVar(name: string): unknown; withInstructions(i: Instruction[]): unknown };
};

// `emitInstructions` is a (TS-)private method of the upstream class; reach it via the prototype.
const baseEmit = (StealthTransfer.prototype as unknown as { emitInstructions(statement: unknown): void }).emitInstructions;
if (typeof baseEmit !== "function") {
  throw new Error("@tari-project/ootle StealthTransfer no longer has emitInstructions(); BucketStealthTransfer needs updating");
}

export class BucketStealthTransfer extends StealthTransfer {
  private bucketVar: string | null = null;
  private followUps: Instruction[] = [];

  /** Reveal `amount` to `receiver` and keep it on the workspace as `workspaceVarName`. */
  toRevealedOutputAsBucket(amount: bigint, workspaceVarName: string, receiver: Uint8Array): this {
    if (this.bucketVar !== null && this.bucketVar !== workspaceVarName) {
      throw new Error(`toRevealedOutputAsBucket: already saving to "${this.bucketVar}"`);
    }
    this.bucketVar = workspaceVarName;
    return this.toRevealedOutput(amount, receiver);
  }

  /** Instructions appended after the stealth transfer (they may reference the bucket). */
  andThen(instructions: Instruction[]): this {
    this.followUps.push(...instructions);
    return this;
  }

  constructor(...args: ConstructorParameters<typeof StealthTransfer>) {
    super(...args);
    // Shadow the upstream (TS-private) emitInstructions on this instance: emit withdraw +
    // StealthTransfer exactly as upstream, minus its trailing deposit, then save the bucket.
    Object.defineProperty(this, "emitInstructions", {
      value: (statement: unknown) => {
        const self = this as unknown as Internals;
        if (this.bucketVar === null) {
          baseEmit.call(this, statement);
        } else {
          const saved = self.state.revealedOutput;
          self.state.revealedOutput = null;
          try {
            baseEmit.call(this, statement);
          } finally {
            self.state.revealedOutput = saved;
          }
          self.builder.saveVar(this.bucketVar);
        }
        if (this.followUps.length > 0) self.builder.withInstructions(this.followUps);
      },
    });
  }
}
