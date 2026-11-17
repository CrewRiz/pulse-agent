// One provider: any endpoint that speaks the OpenAI chat-completions shape with tool calls. That covers local servers
// (Ollama, LM Studio, llama.cpp, vLLM and others expose it) and hosted ones, so the agent runs offline on your own machine
// or against a hosted model with the same code. A model is a function: ({ messages, tools }) -> { content, tool_calls }.
export function openaiCompatible({ baseUrl = "http://127.0.0.1:11434/v1", model, apiKey, timeoutMs = 300000 } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  return async ({ messages, tools }) => {
    const body = { model, messages, ...(tools?.length ? { tools, tool_choice: "auto" } : {}) };
    let res;
    try { res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new Error(`could not reach ${url} (${e?.cause?.code ?? e?.message ?? e}). Start a local model server (for example \`ollama serve\`) or set PULSE_AGENT_BASE_URL.`); }
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { /* reported below */ }
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${data?.error?.message ?? text.slice(0, 300)}`);
    const m = data?.choices?.[0]?.message; if (!m) throw new Error(`${url} answered without a message: ${text.slice(0, 300)}`);
    return {
      content: typeof m.content === "string" ? m.content : "",
      tool_calls: (m.tool_calls ?? []).map((c, i) => {
        const name = c.function?.name ?? "", raw = c.function?.arguments ?? "{}", id = c.id ?? `call_${i}`;
        try { return { id, name, args: typeof raw === "string" ? JSON.parse(raw || "{}") : raw }; } catch { return { id, name, args: {}, error: `the arguments for ${name} were not valid JSON: ${String(raw).slice(0, 200)}` }; }
      }),
    };
  };
}
