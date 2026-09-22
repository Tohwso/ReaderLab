// ============ ReaderLab — Proxy seguro para API de LLM ============
// Endpoint restrito ao ReaderLab (não é mais um proxy OpenAI-compatible
// genérico): só aceita chamadas de um usuário Supabase autenticado e
// autorizado, de uma origem conhecida, com o contrato de payload abaixo.
// Continua sendo a única peça do backend que conhece o secret da API de
// LLM — model/base URL/API key nunca vêm do frontend.
//
// Contrato de entrada: { systemPrompt: string, userPrompt: string, purpose?: "reader"|"analyst", modelId?: string, reasoning_effort?: string, max_completion_tokens?: number }
//                    ou { action: "models" } (discovery do Model Catalog, ver abaixo)
// Contrato de saída:   { content: string, model: string, structuredOutputMode: string, usage?: {...}, finish_reason?: string }
//
// Segredos (definir com `supabase secrets set ...`, nunca no código):
//   LLM_API_KEY               — obrigatório, API key do provedor de LLM.
//   LLM_API_BASE_URL          — ex.: "https://api.moonshot.ai/v1". Default: OpenAI.
//   LLM_READER_MODEL          — modelo usado pelas ReadingRuns (ex.: "kimi-k3").
//   LLM_ANALYST_MODEL         — modelo usado pelo Research Analyst (ex.: "kimi-k2.6").
//   LLM_MODEL                 — legado/fallback comum a ambos quando o específico
//                               não está configurado. Prioridade: LLM_READER_MODEL/
//                               LLM_ANALYST_MODEL -> LLM_MODEL -> DEFAULT_MODEL.
//   LLM_RESPONSE_FORMAT_MODE  — "json_object" (default) ou "off". Controla se
//                               response_format é enviado ao upstream (ver
//                               JSON Mode abaixo) — só desligar se o provider
//                               configurado não suportar o parâmetro.
//   READERLAB_OWNER_USER_ID   — obrigatório. UUID (auth.uid()) do único
//                               usuário autorizado a executar leituras
//                               nesta fase single-user.
//   READERLAB_ALLOWED_ORIGINS — obrigatório. Lista de origens separadas
//                               por vírgula (ex.: URL do GitHub Pages +
//                               http://localhost:5173 para dev).
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente no
// ambiente de toda Edge Function — não precisam ser cadastrados.)
//
// `purpose` ("reader" | "analyst", default "reader" para compatibilidade
// com chamadas antigas) restringe QUAIS modelos são elegíveis. `modelId`
// (opcional) é a seleção EXPLÍCITA do usuário (ver Model Catalog em
// modelCatalog.mjs) — só aceito se existir no catálogo, estiver ativo e for
// compatível com a purpose (senão 400 invalid_request; NUNCA um fallback
// silencioso para outro modelo). Sem `modelId`, cai no roteamento por env
// vars (ver modelRouting.mjs) — o frontend nunca escolhe o nome do modelo
// fora dessas duas vias controladas.
//
// Model discovery: { action: "models" } (POST) retorna a interseção entre o
// Model Catalog ativo (modelCatalog.mjs) e os modelos que o provider
// upstream efetivamente lista em GET {LLM_API_BASE_URL}/models — nunca a
// lista crua do provider (pode conter modelos não suportados/testados), e
// nunca a API key. Se a consulta ao upstream falhar, retorna o catálogo
// ativo com `availabilityUnverified: true` em vez de quebrar (ver seção 30
// da tarefa "model catalog" — abordagem conservadora, documentada).
//
// Deploy: supabase functions deploy llm-proxy

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor, handlePreflight, isOriginAllowed, resolveAllowedOrigins } from "../_shared/cors.ts";
import { resolvePurpose, resolveModel, buildUpstreamPayload, validateRequestedModel } from "./modelRouting.mjs";
import { getActiveModels, sanitizeModelForClient, intersectWithProviderModels } from "./modelCatalog.mjs";

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

// JSON Mode (response_format: {type: "json_object"}) — suportado tanto pela
// API padrão da OpenAI (DEFAULT_MODEL) quanto pelo Kimi K3 (ver docs da Kimi
// API, seção "JSON Mode"). É o mecanismo MAIS RESTRITIVO confiável hoje:
// "json_schema" (Structured Output) existe na Kimi API, mas usa um dialeto
// próprio (MFJS) com problemas de validação documentados publicamente pelo
// próprio provedor — não usado aqui para não trocar um INVALID_RESPONSE por
// um 400 do upstream. Nunca inventamos um parâmetro não documentado: só
// enviamos response_format quando LLM_RESPONSE_FORMAT_MODE não for "off"
// (permite desligar por env var se um operador trocar para um provider que
// não suporte o parâmetro). Ver requestMetadata.structuredOutputMode no
// frontend (js/engine.js) para observabilidade.
const LLM_RESPONSE_FORMAT_MODE = (Deno.env.get("LLM_RESPONSE_FORMAT_MODE") || "json_object").trim();

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

// Discovery (seção 3 da tarefa "model catalog") — consulta o endpoint
// oficial de listagem de modelos do provider com a API key server-side.
// Nunca propaga a key nem o corpo cru do provider; retorna só os IDs, ou
// `null` se a consulta falhar por qualquer motivo (rede, formato
// inesperado, upstream fora do ar) — o chamador cai para o catálogo
// conhecido nesse caso (ver seção 30: nunca quebrar o app por isso).
async function fetchProviderModelIds(baseUrl: string, apiKey: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const ids = list.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === "string");
    return ids;
  } catch {
    return null;
  }
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

  const url = new URL(req.url);
  const actionFromQuery = url.searchParams.get("action");

  // GET só existe para a discovery de modelos (?action=models, ver seção 3
  // da tarefa "model catalog") — qualquer outro uso de GET é rejeitado, e
  // POST continua sendo o único método do contrato de conclusão.
  if (req.method === "GET") {
    if (actionFromQuery !== "models") {
      return json({ error: "method_not_allowed", message: 'GET só é aceito com "?action=models".' }, 405, cors);
    }
  } else if (req.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use GET (?action=models) ou POST." }, 405, cors);
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

  // POST pode trazer { action: "models" } no lugar de systemPrompt/userPrompt
  // — só fazemos parse do body para POST (GET de discovery não tem corpo).
  let body: any = null;
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json", message: "Corpo da requisição não é JSON válido." }, 400, cors);
    }
  }

  const action = actionFromQuery || body?.action;
  if (action === "models") {
    const apiKeyForDiscovery = Deno.env.get("LLM_API_KEY");
    if (!apiKeyForDiscovery) {
      return json({ error: "not_configured", message: "LLM_API_KEY não configurada no servidor (supabase secrets set)." }, 500, cors);
    }
    const baseUrlForDiscovery = Deno.env.get("LLM_API_BASE_URL") || DEFAULT_BASE_URL;
    const providerModelIds = await fetchProviderModelIds(baseUrlForDiscovery, apiKeyForDiscovery);
    const activeModels = getActiveModels();
    // Interseção segura (seção 4 da tarefa): só o que está nos DOIS
    // conjuntos fica selecionável. Se a consulta ao provider falhar, cai
    // para o catálogo conhecido (nunca quebra o app) e sinaliza que a
    // disponibilidade real não pôde ser confirmada agora.
    const availableModels = providerModelIds ? intersectWithProviderModels(activeModels, providerModelIds) : activeModels;
    return json(
      {
        models: availableModels.map(sanitizeModelForClient),
        ...(providerModelIds ? {} : { availabilityUnverified: true }),
      },
      200,
      cors
    );
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
  // `purpose` decide QUAL modelo server-side é usado (ver modelRouting.mjs)
  // — nunca o nome do modelo em si, que o cliente não pode escolher.
  const purposeResult = resolvePurpose(body?.purpose);
  if (!purposeResult.ok) {
    return json({ error: "invalid_request", message: purposeResult.error }, 400, cors);
  }
  const purpose = purposeResult.purpose as string;
  // Seleção EXPLÍCITA do usuário (ver Model Catalog em modelCatalog.mjs) —
  // só aceita um modelo que exista no catálogo, esteja ativo e seja
  // compatível com `purpose`; nunca um fallback silencioso para outro
  // modelo (seção 20 da tarefa "model catalog": sem fallback automático).
  const requestedModelId = typeof body?.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : null;
  let requestedModelValidation: { ok: true; model: string } | { ok: false; error: string } | null = null;
  if (requestedModelId) {
    requestedModelValidation = validateRequestedModel({ modelId: requestedModelId, purpose });
    if (!requestedModelValidation.ok) {
      return json({ error: "invalid_request", message: requestedModelValidation.error }, 400, cors);
    }
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
  // Modelo resolvido a partir da `purpose` (nunca do body diretamente) —
  // ver prioridade de env vars documentada no topo do arquivo. Sobrescrito
  // pelo `modelId` explícito do usuário quando presente e validado acima.
  const baseUrl = Deno.env.get("LLM_API_BASE_URL") || DEFAULT_BASE_URL;
  const model = requestedModelValidation?.ok
    ? requestedModelValidation.model
    : resolveModel({
        purpose,
        readerModelEnv: Deno.env.get("LLM_READER_MODEL") || undefined,
        analystModelEnv: Deno.env.get("LLM_ANALYST_MODEL") || undefined,
        legacyModelEnv: Deno.env.get("LLM_MODEL") || undefined,
        defaultModel: DEFAULT_MODEL,
      });

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Parâmetros comuns vs. específicos por modelo centralizados em
  // modelRouting.mjs (nunca assumir que um modelo novo aceita os mesmos
  // parâmetros do Kimi K3 — ver getModelCapabilities/buildUpstreamPayload).
  const payload = buildUpstreamPayload({
    model,
    messages,
    reasoningEffort,
    maxCompletionTokens,
    jsonMode: LLM_RESPONSE_FORMAT_MODE === "json_object",
  });
  // Rótulo de observabilidade persistido pelo frontend (nunca afeta o
  // comportamento da chamada em si) — reflete exatamente o que foi enviado
  // acima, nunca um valor assumido.
  const structuredOutputMode = payload.response_format ? "json_mode" : "prompt_only";

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
  // 8) Resposta enxuta — sem o objeto raw inteiro da API de LLM. Extraídos
  // ANTES de validar `content` (mesmo quando content vier vazio): uma
  // chamada que gastou tokens de reasoning e terminou sem `content` ainda
  // foi provavelmente cobrada pelo provedor — nunca descartar usage/
  // finish_reason só porque o resultado final ficou vazio (ver "empty_response" abaixo).
  const usage = data?.usage && typeof data.usage === "object"
    ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      }
    : undefined;
  // finish_reason ("stop" | "length" | ...) do upstream — repassado como
  // veio, sem interpretar aqui; o frontend usa "length" para distinguir
  // uma resposta cortada por max_completion_tokens de um JSON só malformado
  // (ver analysisEngine.js).
  const finishReason = typeof data?.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : undefined;
  // Diagnóstico seguro (nunca o texto do reasoning em si — pode conter
  // raciocínio extenso/sensível) para investigar "content vazio" quando o
  // modelo suporta thinking mode (ex.: Kimi K2.6): só um booleano.
  const reasoningContent = data?.choices?.[0]?.message?.reasoning_content;
  const hasReasoningContent = typeof reasoningContent === "string" && reasoningContent.trim().length > 0;

  if (typeof content !== "string" || !content.trim()) {
    console.error(
      "llm-proxy empty_response",
      model,
      finishReason || "(sem finish_reason)",
      "hasReasoningContent=" + hasReasoningContent
    );
    return json(
      {
        error: "empty_response",
        message: "A API de LLM retornou uma resposta vazia.",
        model,
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finish_reason: finishReason } : {}),
        hasReasoningContent,
      },
      502,
      cors
    );
  }

  return json({ content, model, structuredOutputMode, ...(usage ? { usage } : {}), ...(finishReason ? { finish_reason: finishReason } : {}) }, 200, cors);
});

