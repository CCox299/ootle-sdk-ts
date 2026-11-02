import { it } from "vitest";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { Network, XTR_FAUCET_COMPONENT_ADDRESS, XTR_FAUCET_VAULT_ADDRESS } from "@tari-project/ootle";
import { fetchSubstatesDecoded, getSubstateDecoded } from "../src/indexerDecode";
import { scanUtxosDelta } from "../src/utxoScan";
import { WasmStealthCrypto } from "@tari-project/ootle";

it("decode live substates", async () => {
  const p = await IndexerProvider.connect({ url: "https://ootle-indexer-a.tari.com", network: Network.Esmeralda });
  const s = await getSubstateDecoded(p, XTR_FAUCET_COMPONENT_ADDRESS);
  console.log("faucet component keys", Object.keys(s.state.up.substate), JSON.stringify(s.state.up.substate).slice(0, 300));
  const f = await fetchSubstatesDecoded(p, [XTR_FAUCET_VAULT_ADDRESS, "resource_0101010101010101010101010101010101010101010101010101010101010101"]);
  for (const [k, v] of Object.entries(f.substates)) console.log(k.slice(0, 20), JSON.stringify(v?.substate).slice(0, 300));
  const r = await scanUtxosDelta("https://ootle-indexer-a.tari.com", "resource_0101010101010101010101010101010101010101010101010101010101010101", new WasmStealthCrypto(Network.Esmeralda), crypto.getRandomValues(new Uint8Array(32)).map((x, i) => (i === 31 ? 0 : x)), [], 50);
  console.log("delta", r.owned.length, r.spentCommitments.length, r.hasMore, JSON.stringify(r.watermarks.filter(([, v]) => v > 0)).slice(0, 300));
}, 120_000);
