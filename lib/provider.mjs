// One provider: any endpoint that speaks the OpenAI chat-completions shape with tool calls. That covers local servers
// (Ollama, LM Studio, llama.cpp, vLLM and others expose it) and hosted ones, so the agent runs offline on your own machine
// or against a hosted model with the same code. A model is a function: ({ messages, tools }) -> { content, tool_calls }.
export function openaiCompatible({ baseUrl = "http://127.0.0.1:11434/v1", model, apiKey, timeoutMs = 300000 } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const parse = (m) => ({
    content: typeof m.content === "string" ? m.content : typeof m.content === "number" ? String(m.content) : "",
    tool_calls: (m.tool_calls ?? []).map((c, i) => {
      const name = c.function?.name ?? "", raw = c.function?.arguments ?? "{}", id = c.id ?? `call_${i}`;
      try { return { id, name, args: typeof raw === "string" ? JSON.parse(raw || "{}") : raw }; } catch { return { id, name, args: {}, error: `the arguments for ${name} were not valid JSON: ${String(raw).slice(0, 200)}` }; }
    }),
  });
  // With onDelta the reply is streamed (server-sent events): text is handed over as it arrives, and tool calls, which come in
  // fragments keyed by index, are assembled before they are returned. Without it the reply comes whole.
  return async ({ messages, tools, onDelta }) => {
    const body = { model, messages, ...(tools?.length ? { tools, tool_choice: "auto" } : {}), ...(onDelta ? { stream: true } : {}) };
    let res;
    try { res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new Error(`could not reach ${url} (${e?.cause?.code ?? e?.message ?? e}). Start a local model server (for example \`ollama serve\`) or set PULSE_AGENT_BASE_URL.`); }
    if (onDelta && res.ok && /text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
      let content = "", buf = ""; const calls = [], dec = new TextDecoder();
      const event = (line) => {
        if (!line.startsWith("data:")) return; const data = line.slice(5).trim(); if (!data || data === "[DONE]") return;
        let j; try { j = JSON.parse(data); } catch { return; }
        if (j.error) throw new Error(`${url} failed mid-stream: ${j.error.message ?? JSON.stringify(j.error).slice(0, 200)}`);
        const d = j.choices?.[0]?.delta; if (!d) return;
        if ((typeof d.content === "string" && d.content) || typeof d.content === "number") { const t = String(d.content); content += t; onDelta(t); }   // some servers stream digits as JSON numbers
        for (const t of d.tool_calls ?? []) { const c = (calls[t.index ?? 0] ??= { id: null, function: { name: "", arguments: "" } }); if (t.id) c.id = t.id; if (t.function?.name) c.function.name += t.function.name; if (typeof t.function?.arguments === "string") c.function.arguments += t.function.arguments; }
      };
      for await (const chunk of res.body) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); event(line); } }
      if (buf.trim()) event(buf.trim());
      return parse({ content, tool_calls: calls.filter(Boolean) });
    }
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { /* reported below */ }
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${data?.error?.message ?? text.slice(0, 300)}`);
    const m = data?.choices?.[0]?.message; if (!m) throw new Error(`${url} answered without a message: ${text.slice(0, 300)}`);
    const out = parse(m); if (onDelta && out.content) onDelta(out.content);
    return out;
  };
}
