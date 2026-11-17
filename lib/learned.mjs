// The learned read: memory-pulse's engine learns, from the ledger's own words, which corrections bear on what you are about
// to do, including ones your wording never names. It runs on the engine, so it is used only when a key is set, and using it
// sends the ledger's rows to that engine. Without a key nothing leaves the machine and the local checks stand alone.
// It never throws and never guesses: any failure comes back as { unavailable: why }.
import { gzipSync } from "node:zlib";

export async function learnedBefore({ events, operation, key, api = "https://pulse.strategic-innovations.ai", timeoutMs = 20000 }) {
  if (!key) return { unavailable: "no key (set MEMORY_PULSE_KEY to use the learned read)" };
  const url = `${String(api).replace(/\/+$/, "")}/v1/before`;
  let res;
  try { res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", "x-mp-key": key, "user-agent": "pulse-agent" }, body: gzipSync(JSON.stringify({ events, operation, path: "", text: "", blocks: [] })), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { return { unavailable: `could not reach ${url} (${e?.cause?.code ?? e?.name ?? e})` }; }
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { /* reported below */ }
  if (!res.ok) return { unavailable: `${url} answered ${res.status}: ${data?.error ?? text.slice(0, 120)}` };
  if (!data || typeof data !== "object") return { unavailable: `${url} did not answer in JSON` };
  return { rung: data.rung ?? "none", reason: data.reason, hits: Array.isArray(data.hits) ? data.hits : [] };
}
