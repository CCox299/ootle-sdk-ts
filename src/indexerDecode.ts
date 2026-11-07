// Ootle 0.48+ indexers serve substate values, execution results, events and UTXOs as base64 CBOR
// blobs (tari-ootle #3100/#3101/#3110). The SDK's own readers were written against the decoded
// JSON shapes, so every internal read goes through these helpers, which decode once and hand back
// the pre-0.48 shape. Values that are already objects (an older JSON indexer) pass through, so the
// helpers are safe against either server.
//
// Upstream `@tari-project/ootle` code (StealthTransfer, resolveTransaction, ...) is still handed
// the raw provider: it expects the encoded shapes itself.
import { decodeEvent, decodeExecuteResult, decodeSubstateValue, decodeUtxo } from "@tari-project/ootle";
import type { IndexerProvider } from "@tari-project/ootle-indexer";

/** Decodes a substate value if it is a base64 CBOR string; returns objects unchanged. */
export function substateValueOf<T = any>(value: unknown): T {
  return (typeof value === "string" ? decodeSubstateValue(value) : value) as T;
}

/** Decodes an `ExecuteResult` if it is a base64 CBOR string; returns objects/null unchanged. */
export function executeResultOf<T = any>(value: unknown): T {
  return (typeof value === "string" ? decodeExecuteResult(value) : value) as T;
}

export function eventOf<T = any>(value: unknown): T {
  return (typeof value === "string" ? decodeEvent(value) : value) as T;
}

export function utxoValueOf<T = any>(value: unknown): T {
  return (typeof value === "string" ? decodeUtxo(value) : value) as T;
}

/** `getSubstate` response with `state.up.substate` decoded. */
export function decodeSubstateResponse<T = any>(response: any): T {
  if (response && response.state && typeof response.state === "object" && "up" in response.state) {
    return { ...response, state: { up: { ...response.state.up, substate: substateValueOf(response.state.up.substate) } } } as T;
  }
  return response as T;
}

export async function getSubstateDecoded(provider: IndexerProvider, substateId: string, version?: number | null): Promise<any> {
  return decodeSubstateResponse(await provider.getSubstate(substateId, version));
}

/** The most substates the indexer serves in one request. It refuses a larger one outright. */
export const MAX_SUBSTATES_PER_REQUEST = 20;

/**
 * `fetchSubstates` with each entry given the pre-0.48 `{ version, substate }` shape. Asks in batches, because an account
 * holding more than a batch's worth of tokens is ordinary: every campaign it claims from adds a receipt vault.
 */
export async function fetchSubstatesDecoded(provider: IndexerProvider, ids: string[]): Promise<{ substates: Record<string, { version: number; substate: any } | undefined> } & Record<string, any>> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_SUBSTATES_PER_REQUEST) batches.push(ids.slice(i, i + MAX_SUBSTATES_PER_REQUEST));
  const responses = (await Promise.all((batches.length ? batches : [[]]).map((batch) => provider.fetchSubstates(batch as never)))) as any[];
  const substates: Record<string, { version: number; substate: any } | undefined> = {};
  for (const response of responses) {
    for (const [id, entry] of Object.entries<any>(response.substates ?? {})) {
      if (!entry) continue;
      substates[id] = { ...entry, substate: substateValueOf(entry.value ?? entry.substate) };
    }
  }
  return { ...Object.assign({}, ...responses), substates };
}

/** Decodes `Finalized.execution_result` (and nested event blobs) in a transaction-result response. */
export function decodeTransactionResultResponse<T = any>(response: any): T {
  const result = response?.result;
  if (result && typeof result === "object" && "Finalized" in result) {
    const finalized = result.Finalized;
    return {
      ...response,
      result: { Finalized: { ...finalized, execution_result: decodeExecuteResultDeep(finalized.execution_result) } },
    } as T;
  }
  return response as T;
}

/** An `ExecuteResult` with any CBOR-string events also decoded. */
export function decodeExecuteResultDeep<T = any>(value: unknown): T {
  const decoded = executeResultOf<any>(value);
  const events = decoded?.finalize?.events;
  if (Array.isArray(events) && events.some((e) => typeof e === "string")) {
    return { ...decoded, finalize: { ...decoded.finalize, events: events.map(eventOf) } } as T;
  }
  return decoded as T;
}

export async function getTransactionResultDecoded(provider: IndexerProvider, transactionId: string): Promise<any> {
  return decodeTransactionResultResponse(await provider.getTransactionResult(transactionId));
}
