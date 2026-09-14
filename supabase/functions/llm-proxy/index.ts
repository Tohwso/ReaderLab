// ============ ReaderLab — Proxy seguro para API de LLM ============
// Única função no backend que conhece o secret da API de LLM. Recebe
// exatamente o payload que js/llm/provider.js já envia
// ({ provider, model, temperature, messages }) e repassa para qualquer API
// compatível com o formato de chat completions da OpenAI (Kimi/Moonshot,
// OpenAI, Groq, DeepSeek, etc. — todas compatíveis).
//
// Segredos (definir com `supabase secrets set ...`, nunca no código):
//   LLM_API_KEY       — obrigatório
//   LLM_API_BASE_URL  — ex.: "https://api.moonshot.cn/v1" (Kimi) ou
//                        "https://api.openai.com/v1" (OpenAI). Default: OpenAI.
//   LLM_MODEL         — modelo default caso o frontend não especifique um.
//
// Deploy: supabase functions deploy llm-proxy
// (mantém verificação de JWT: exige Authorization Bearer <anon|user JWT>,
// que js/db.js + js/llm/provider.js já enviam automaticamente.)

import { corsHeaders, handlePreflight } from "../_shared/cors.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
// Supabase Edge Functions free plan wall-clock limit is 150s; stay under it.
const TIMEOUT_MS = 140_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json", message: "Corpo da requisição não é JSON válido." }, 400);
  }

  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "invalid_request", message: '"messages" é obrigatório e não pode ser vazio.' }, 400);
  }

  const apiKey = Deno.env.get("LLM_API_KEY");
  if (!apiKey) {
    return json({ error: "not_configured", message: "LLM_API_KEY não configurada no servidor (supabase secrets set)." }, 500);
  }
  const baseUrl = Deno.env.get("LLM_API_BASE_URL") || DEFAULT_BASE_URL;
  const model = (typeof body.model === "string" && body.model) || Deno.env.get("LLM_MODEL") || DEFAULT_MODEL;
  const temperature = typeof body.temperature === "number" ? body.temperature : 0.7;

  // kimi-k3 always reasons and only allows the implicit default temperature (1);
  // sending any other value is rejected with an invalid_request_error.
  const isKimiK3 = model === "kimi-k3";
  const payload: Record<string, unknown> = { model, messages };
  if (!isKimiK3) payload.temperature = temperature;
  // Default to "low" reasoning effort for snappier responses; caller can override via body.reasoning_effort.
  if (isKimiK3) payload.reasoning_effort = body.reasoning_effort || "low";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    return json(
      { error: aborted ? "timeout" : "upstream_network", message: aborted ? "A API de LLM não respondeu a tempo." : "Falha de rede ao contatar a API de LLM." },
      aborted ? 504 : 502
    );
  }
  clearTimeout(timer);

  let data: any = null;
  try {
    data = await upstream.json();
  } catch {
    return json({ error: "invalid_upstream_json", message: "A API de LLM retornou uma resposta que não é JSON." }, 502);
  }

  if (!upstream.ok) {
    return json({ error: "upstream_error", status: upstream.status, detail: data }, upstream.status);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return json({ error: "empty_response", message: "A API de LLM retornou uma resposta vazia." }, 502);
  }

  return json({ content, raw: data });
});
