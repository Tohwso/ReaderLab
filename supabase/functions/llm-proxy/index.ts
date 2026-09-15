// ============ ReaderLab — Proxy seguro para API de LLM ============
// Endpoint restrito ao ReaderLab (não é mais um proxy OpenAI-compatible
// genérico): só aceita chamadas de um usuário Supabase autenticado e
// autorizado, de uma origem conhecida, com o contrato de payload abaixo.
// Continua sendo a única peça do backend que conhece o secret da API de
// LLM — model/base URL/API key nunca vêm do frontend.
//
// Contrato de entrada: { systemPrompt: string, userPrompt: string, reasoning_effort?: string, max_completion_tokens?: number }
// Contrato de saída:   { content: string, model: string, usage?: {...} }
//
// Segredos (definir com `supabase secrets set ...`, nunca no código):
//   LLM_API_KEY               — obrigatório, API key do provedor de LLM.
//   LLM_API_BASE_URL          — ex.: "https://api.moonshot.ai/v1". Default: OpenAI.
//   LLM_MODEL                 — modelo usado nas execuções. Default: gpt-4o-mini.
//   READERLAB_OWNER_USER_ID   — obrigatório. UUID (auth.uid()) do único
//                               usuário autorizado a executar leituras
//                               nesta fase single-user.
//   READERLAB_ALLOWED_ORIGINS — obrigatório. Lista de origens separadas
//                               por vírgula (ex.: URL do GitHub Pages +
//                               http://localhost:5173 para dev).
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente no
// ambiente de toda Edge Function — não precisam ser cadastrados.)
//
// Deploy: supabase functions deploy llm-proxy

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor, handlePreflight, isOriginAllowed, resolveAllowedOrigins } from "../_shared/cors.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
// Supabase Edge Functions free plan wall-clock limit is 150s; stay under it.
const TIMEOUT_MS = 140_000;

const ALLOWED_REASONING_EFFORTS = ["low", "medium", "high", "max"];
const MAX_SYSTEM_PROMPT_CHARS = 20_000;
const MAX_USER_PROMPT_CHARS = 200_000;
const MAX_BODY_BYTES = 2_000_000; // 2MB — bem acima do necessário, só evita abuso grosseiro
// Limite superior de sanidade para max_completion_tokens vindo do frontend —
// nunca confiar cegamente num número arbitrário do chamador.
const MAX_COMPLETION_TOKENS_CEILING = 1_048_576;

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// Retry-After pode vir como segundos (ex.: "20") ou como data HTTP (ex.:
// "Wed, 21 Oct 2026 07:28:00 GMT") — normaliza para segundos a partir de
// agora. Retorna null quando ausente/não interpretável.
function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return null;
}

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY indisponíveis no ambiente da função.");
  }

  // Client com service role só para validar o JWT do chamador — nunca é
  // exposto, nunca sai desta função.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

Deno.serve(async (req: Request) => {
  const allowedOrigins = resolveAllowedOrigins();
  const origin = req.headers.get("origin");

  const preflight = handlePreflight(req, allowedOrigins);
  if (preflight) return preflight;

  const cors = corsHeadersFor(origin, allowedOrigins);

  if (!isOriginAllowed(origin, allowedOrigins)) {
    return json({ error: "origin_not_allowed", message: "Origem não autorizada." }, 403, cors);
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405, cors);
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", message: "Corpo da requisição excede o tamanho máximo permitido." }, 413, cors);
  }

  // 1) Autenticação — nunca confiar apenas em o header ter sido enviado;
  // valida o JWT contra o Supabase Auth e resolve o usuário real.
  let user;
  try {
    user = await getAuthenticatedUser(req);
  } catch (err) {
    console.error("llm-proxy auth_check_failed", err instanceof Error ? err.message : String(err));
    return json({ error: "internal_error", message: "Falha interna ao validar autenticação." }, 500, cors);
  }
  if (!user) {
    return json({ error: "unauthorized", message: "Autenticação necessária." }, 401, cors);
  }

  // 2) Autorização — fase single-user: só o dono configurado pode executar.
  const ownerUserId = Deno.env.get("READERLAB_OWNER_USER_ID");
  if (!ownerUserId) {
    return json({ error: "not_configured", message: "READERLAB_OWNER_USER_ID não configurado no servidor." }, 500, cors);
  }
  if (user.id !== ownerUserId) {
    return json({ error: "forbidden", message: "Usuário não autorizado a executar leituras." }, 403, cors);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json", message: "Corpo da requisição não é JSON válido." }, 400, cors);
  }

  // 5) Payload — contrato fixo, sem aceitar messages/model/baseUrl arbitrários.
  const systemPrompt = body?.systemPrompt;
  const userPrompt = body?.userPrompt;
  if (typeof systemPrompt !== "string" || typeof userPrompt !== "string" || !systemPrompt.trim() || !userPrompt.trim()) {
    return json({ error: "invalid_request", message: '"systemPrompt" e "userPrompt" são obrigatórios e devem ser strings não vazias.' }, 400, cors);
  }
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS || userPrompt.length > MAX_USER_PROMPT_CHARS) {
    return json({ error: "payload_too_large", message: "Texto excede o tamanho máximo permitido." }, 413, cors);
  }
  const reasoningEffort = typeof body?.reasoning_effort === "string" && ALLOWED_REASONING_EFFORTS.includes(body.reasoning_effort)
    ? body.reasoning_effort
    : "low";
  // Opcional — quando ausente/inválido, o upstream usa seu próprio default
  // (ex.: Kimi K3 usa 131072). Repassado como veio, sem impor um default
  // próprio aqui: quem decide o valor é o frontend (js/config.js), este
  // proxy só valida sanidade.
  const maxCompletionTokens = typeof body?.max_completion_tokens === "number"
    && Number.isFinite(body.max_completion_tokens)
    && body.max_completion_tokens > 0
    && body.max_completion_tokens <= MAX_COMPLETION_TOKENS_CEILING
    ? Math.floor(body.max_completion_tokens)
    : null;

  const apiKey = Deno.env.get("LLM_API_KEY");
  if (!apiKey) {
    return json({ error: "not_configured", message: "LLM_API_KEY não configurada no servidor (supabase secrets set)." }, 500, cors);
  }
  // 4) Modelo/base URL/provider vêm exclusivamente do servidor — o browser
  // não pode transformar isto num proxy para modelos/APIs arbitrários.
  const baseUrl = Deno.env.get("LLM_API_BASE_URL") || DEFAULT_BASE_URL;
  const model = Deno.env.get("LLM_MODEL") || DEFAULT_MODEL;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // kimi-k3 always reasons and only allows the implicit default temperature (1);
  // sending any other value is rejected with an invalid_request_error.
  const isKimiK3 = model === "kimi-k3";
  const payload: Record<string, unknown> = { model, messages };
  if (!isKimiK3) payload.temperature = 0.7;
  if (isKimiK3) payload.reasoning_effort = reasoningEffort;
  if (maxCompletionTokens) payload.max_completion_tokens = maxCompletionTokens;

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
      aborted ? 504 : 502,
      cors
    );
  }
  clearTimeout(timer);

  let data: any = null;
  try {
    data = await upstream.json();
  } catch {
    return json({ error: "invalid_upstream_json", message: "A API de LLM retornou uma resposta que não é JSON." }, 502, cors);
  }

  if (!upstream.ok) {
    // 7) Nunca repassar o corpo/headers crus do upstream (podem conter
    // detalhes internos do provedor) — só código, mensagem curta, o
    // error.type (quando presente, ex.: "rate_limit_reached_error" /
    // "engine_overloaded_error" / "exceeded_current_quota_error" da Kimi —
    // usado pelo frontend para diferenciar erros transitórios de
    // permanentes) e o Retry-After em segundos (quando presente).
    const message = typeof data?.error?.message === "string" ? data.error.message : "Falha ao chamar a API de LLM.";
    const errorType = typeof data?.error?.type === "string" ? data.error.type : undefined;
    const retryAfterSeconds = parseRetryAfterSeconds(upstream.headers.get("retry-after"));
    console.error("llm-proxy upstream_error", upstream.status, errorType || "(sem type)", message);
    return json(
      {
        error: "upstream_error",
        status: upstream.status,
        message,
        ...(errorType ? { errorType } : {}),
        ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}),
      },
      upstream.status,
      cors
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return json({ error: "empty_response", message: "A API de LLM retornou uma resposta vazia." }, 502, cors);
  }

  // 8) Resposta enxuta — sem o objeto raw inteiro da API de LLM.
  const usage = data?.usage && typeof data.usage === "object"
    ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      }
    : undefined;

  return json({ content, model, ...(usage ? { usage } : {}) }, 200, cors);
});

