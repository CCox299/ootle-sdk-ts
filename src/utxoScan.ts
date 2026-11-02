// UTXO-based stealth output discovery against the Ootle 0.48+ indexer REST API.
//
//   scanUtxosDelta  — incremental, checkpoint-based (POST /utxos/stream).  Given per-shard state
//                     version watermarks (empty = every shard from genesis), reads the next
//                     `per_shard_limit` rows of each shard: new outputs (tag + public nonce) and
//                     spends/burns.  Candidate outputs are fetched in full (POST /utxos/fetch) and
//                     trial-decrypted with the view key.
//   scanUtxosPage   — "full" scan.  0.48 removed `GET /utxos`, so this is the same stream read with
//                     `unspent_only: true`, its watermarks carried in an opaque string cursor.  It
//                     finds every live output; it reports no spends.
//
// Wire format (tari-ootle v0.49 `rest_api/streaming/utxo_stream.rs`): the stream answers
// `application/x-ndjson` with one `UtxoUpdatePayload` per line —
//   { "sos": { shard, max_state_version, num_updates, has_more, spends_incomplete } | null,
//     "update": { "Unspent": { tag, public_nonce: number[] } } | { "Spent": { id: number[], version } }
//               | { "Burnt": { id: number[], version } } | null,
//     "eos": { max_state_version } | null }
// A request that names no shards reads nothing, so a first scan names every shard at version 0.
// `/utxos/fetch` answers `{ utxos: [UtxoId, base64-CBOR Utxo][], spent, next_cursor? }`.
import { decryptInputData, decodeUtxo, type StealthCryptoProvider } from "@tari-project/ootle";
import type { Shard, StateVersion, UtxoId, UtxoTag, Utxo } from "@tari-project/ootle-ts-bindings";
import { fromHex, toHex } from "./vault.js";
import type { ScannedStealthOutput } from "./confidential.js";

/** Shards 1..=NUM_PRESHARDS (shard 0 is the global shard, which holds no UTXOs). */
export const NUM_PRESHARDS = 256;
const MAX_FETCH_PAIRS = 1000;

/** Checkpoint for one resource's delta scan: a `[Shard, StateVersion]` pair per shard read so far.
 * Serialize as JSON; pass back verbatim on the next call. Empty = scan every shard from genesis. */
export type UtxoScanWatermark = Array<[Shard, StateVersion]>;

/** Result of a delta scan (`scanUtxosDelta`). */
export interface UtxosDeltaResult {
  /** Outputs we decrypted as ours. Pass each to `addShieldedOutput`. */
  owned: ScannedStealthOutput[];
  /** Commitments whose outputs were spent or burnt on-chain since the last scan.
   * Pass each to `markShieldedOutputSpent`. */
  spentCommitments: string[];
  /** Persist these with `setUtxoScanWatermarks` and pass on the next call. */
  watermarks: UtxoScanWatermark;
  /** True if at least one shard still has rows above the new watermark.
   * Call `scanUtxosDelta` again (with the returned `watermarks`) until this is false. */
  hasMore: boolean;
}

/** Result of one pass of a full scan (`scanUtxosPage`). */
export interface UtxosPageResult {
  /** Outputs we decrypted as ours. Pass each to `addShieldedOutput`. */
  owned: ScannedStealthOutput[];
  /** Opaque cursor for the next pass (save with `setUtxoScanPageCursor`, pass as `fromId`).
   * `null` means the sweep reached the end of every shard. */
  nextCursor: string | null;
}

// ── wire ─────────────────────────────────────────────────────────────────────────────────────────

type Bytes = number[] | string;

interface StreamPayload {
  sos?: { shard: number; max_state_version: number; num_updates: number; has_more: boolean; spends_incomplete?: boolean } | null;
  update?: { Unspent: { tag: number; public_nonce: Bytes } } | { Spent: { id: Bytes; version: number } } | { Burnt: { id: Bytes; version: number } } | null;
  eos?: { max_state_version: number } | null;
}

interface StreamRead {
  unspent: Array<[UtxoTag, string]>;
  spent: string[];
  reached: Map<number, StateVersion>;
  hasMore: boolean;
}

function bytesHex(b: Bytes): string {
  return typeof b === "string" ? b.toLowerCase() : toHex(Uint8Array.from(b));
}

/** Every shard at version 0 — the request a first scan sends. */
export function genesisWatermarks(): UtxoScanWatermark {
  return Array.from({ length: NUM_PRESHARDS }, (_, i) => [i + 1, 0] as [Shard, StateVersion]);
}

function baseUrl(indexerBaseUrl: string): string {
  return indexerBaseUrl.replace(/\/$/, "");
}

/** Parses an ndjson UTXO stream body into updates and per-shard resume points. */
export function parseUtxoStream(body: string): StreamRead {
  const out: StreamRead = { unspent: [], spent: [], reached: new Map(), hasMore: false };
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = JSON.parse(trimmed) as StreamPayload;
    if (payload.sos) {
      if (payload.sos.has_more) out.hasMore = true;
      out.reached.set(payload.sos.shard, payload.sos.max_state_version);
    }
    const u = payload.update;
    if (u) {
      if ("Unspent" in u) out.unspent.push([u.Unspent.tag, bytesHex(u.Unspent.public_nonce)]);
      else if ("Spent" in u) out.spent.push(bytesHex(u.Spent.id));
      else if ("Burnt" in u) out.spent.push(bytesHex(u.Burnt.id));
    }
  }
  return out;
}

async function readStream(
  indexerBaseUrl: string,
  resourceAddress: string,
  watermarks: UtxoScanWatermark,
  perShardLimit: number,
  unspentOnly: boolean,
): Promise<StreamRead> {
  const shardStateVersions = watermarks.length > 0 ? watermarks : genesisWatermarks();
  const resp = await fetch(`${baseUrl(indexerBaseUrl)}/utxos/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({
      from_epoch: 0,
      resource_address: resourceAddress,
      shard_state_versions: shardStateVersions,
      unspent_only: unspentOnly,
      per_shard_limit: Math.max(1, Math.min(1000, perShardLimit)),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`UTXO scan POST /utxos/stream failed: ${resp.status} ${resp.statusText} — ${text}`);
  }
  return parseUtxoStream(await resp.text());
}

/** Watermarks after a read: every requested shard, advanced to where the read reached. */
function mergeWatermarks(previous: UtxoScanWatermark, reached: Map<number, StateVersion>): UtxoScanWatermark {
  const base = previous.length > 0 ? previous : genesisWatermarks();
  return base.map(([shard, version]) => {
    const r = reached.get(shard as number);
    return [shard, r !== undefined && r > version ? r : version] as [Shard, StateVersion];
  });
}

/** Full bodies for candidate (tag, nonce) pairs, following `next_cursor`. */
async function fetchUtxos(indexerBaseUrl: string, resourceAddress: string, pairs: Array<[UtxoTag, string]>): Promise<Array<[UtxoId, Utxo]>> {
  const out: Array<[UtxoId, Utxo]> = [];
  for (let i = 0; i < pairs.length; i += MAX_FETCH_PAIRS) {
    const chunk = pairs.slice(i, i + MAX_FETCH_PAIRS);
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const resp = await fetch(`${baseUrl(indexerBaseUrl)}/utxos/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ resource_address: resourceAddress, tag_and_nonce_pairs: chunk, ...(cursor ? { cursor } : {}) }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`UTXO scan POST /utxos/fetch failed: ${resp.status} ${resp.statusText} — ${text}`);
      }
      const body = (await resp.json()) as { utxos: Array<[UtxoId, string | Utxo]>; next_cursor?: string | null };
      for (const [id, utxo] of body.utxos) out.push([id, typeof utxo === "string" ? decodeUtxo(utxo) : utxo]);
      if (!body.next_cursor || body.next_cursor === cursor) break;
      cursor = body.next_cursor;
    }
  }
  return out;
}

/** Try to decrypt a UTXO output using the account's view key.
 * Returns a ScannedStealthOutput on success, null if the output doesn't belong to this key. */
async function tryDecryptUtxo(
  crypto: StealthCryptoProvider,
  viewSecret: Uint8Array,
  resourceAddress: string,
  utxoId: UtxoId,
  utxo: Utxo,
): Promise<ScannedStealthOutput | null> {
  if (!utxo.output) return null;
  const body = utxo.output.output;
  try {
    const { value, memo } = await decryptInputData(crypto, fromHex(utxoId), fromHex(body.encrypted_data), {
      senderPublicNonce: fromHex(body.public_nonce),
      viewSecret,
      skipMemo: false,
    });
    return { resourceAddress, commitment: utxoId, amount: value, transactionId: "", memo };
  } catch {
    return null;
  }
}

async function decryptCandidates(
  indexerBaseUrl: string,
  resourceAddress: string,
  crypto: StealthCryptoProvider,
  viewSecret: Uint8Array,
  pairs: Array<[UtxoTag, string]>,
): Promise<ScannedStealthOutput[]> {
  const owned: ScannedStealthOutput[] = [];
  if (pairs.length === 0) return owned;
  for (const [utxoId, utxo] of await fetchUtxos(indexerBaseUrl, resourceAddress, pairs)) {
    const result = await tryDecryptUtxo(crypto, viewSecret, resourceAddress, utxoId, utxo);
    if (result) owned.push(result);
  }
  return owned;
}

// ── incremental delta scan ───────────────────────────────────────────────────────────────────────

/**
 * Reads UTXO updates (new outputs + spends) since `watermarks` and decrypts the new outputs with
 * the account's view key. Pass `[]` (or the saved value) on every call; call again with the
 * returned watermarks until `hasMore` is false.
 */
export async function scanUtxosDelta(
  indexerBaseUrl: string,
  resourceAddress: string,
  crypto: StealthCryptoProvider,
  viewSecret: Uint8Array,
  watermarks: UtxoScanWatermark,
  perShardLimit = 200,
): Promise<UtxosDeltaResult> {
  const read = await readStream(indexerBaseUrl, resourceAddress, watermarks, perShardLimit, false);
  const owned = await decryptCandidates(indexerBaseUrl, resourceAddress, crypto, viewSecret, read.unspent);
  return { owned, spentCommitments: read.spent, watermarks: mergeWatermarks(watermarks, read.reached), hasMore: read.hasMore };
}

// ── full scan ────────────────────────────────────────────────────────────────────────────────────

/**
 * One pass of a sweep over every live UTXO of `resourceAddress`. `fromId` is the cursor a previous
 * pass returned (`null` starts a new sweep); a cursor from the pre-0.48 `GET /utxos` API (a bare
 * UtxoId) is ignored and the sweep restarts.
 */
export async function scanUtxosPage(
  indexerBaseUrl: string,
  resourceAddress: string,
  crypto: StealthCryptoProvider,
  viewSecret: Uint8Array,
  fromId: string | null = null,
  pageSize = 100,
): Promise<UtxosPageResult> {
  let watermarks: UtxoScanWatermark = [];
  if (fromId && fromId.startsWith("[")) {
    try {
      watermarks = JSON.parse(fromId) as UtxoScanWatermark;
    } catch {
      watermarks = [];
    }
  }
  const read = await readStream(indexerBaseUrl, resourceAddress, watermarks, pageSize, true);
  const owned = await decryptCandidates(indexerBaseUrl, resourceAddress, crypto, viewSecret, read.unspent);
  const next = mergeWatermarks(watermarks, read.reached);
  return { owned, nextCursor: read.hasMore ? JSON.stringify(next) : null };
}
