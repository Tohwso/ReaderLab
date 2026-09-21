// ============ ReaderLab — Abstração LLMProvider ============
//
// NENHUMA API KEY EXISTE NESTE CÓDIGO. O provider nunca chama uma API de
// LLM diretamente do browser: ele fala APENAS com um endpoint proxy
// configurável (getLLMConfig().endpoint) — a Supabase Edge Function
// `llm-proxy` (ver /supabase/functions/llm-proxy) — cuja única
// responsabilidade no servidor é segurar o secret e repassar a requisição
// à API real (compatível com o formato de chat da OpenAI).
//
// Arquitetura (seam único de integração):
//   ReaderLab (estático)  --HTTPS-->  Supabase Edge Function (segura a key)
//                                      --HTTPS--> API de LLM (OpenAI-compatível)
//
// Trocar de provider = trocar variáveis de ambiente da Edge Function (ou
// implementar outra classe *Provider com a mesma interface).

import { getAccessToken, getAnonKey } from "../db.js";
import { LLM_PROXY_ENDPOINT } from "../config.js";
import { LLM_ERROR_TYPES, classifyHttpErrorResponse } from "./errorTypes.js";
export { LLM_ERROR_TYPES } from "./errorTypes.js";

// provider/model/temperature aqui são só rótulos de exibição — o servidor
// (Edge Function) é quem decide de fato o modelo/base URL/provider real;
// o frontend não consegue mais transformá-lo num proxy para outro modelo.
export const LLM_PROXY_CONFIG = {
  endpoint: LLM_PROXY_ENDPOINT, // ex.: "https://<ref>.supabase.co/functions/v1/llm-proxy"
  provider: "openai-compatible",
  model: "(definido pelo servidor)",
  promptVersion: "v1",
  temperature: 0.7,
  timeoutMs: 140000,
};

// Hook de configuração NÃO-secreta: o endpoint do proxy é apenas uma URL
// pública. Pode ser definido pelo hospedeiro da página sem rebuild:
// window.READERLAB_LLM_ENDPOINT = "https://..."
export function getLLMConfig() {
  let endpoint = LLM_PROXY_CONFIG.endpoint;
  try {
    if (typeof window !== "undefined" && window.READERLAB_LLM_ENDPOINT) {
      endpoint = window.READERLAB_LLM_ENDPOINT;
    }
  } catch (_) { /* ambiente sem window */ }
  return { ...LLM_PROXY_CONFIG, endpoint };
}

export class ProviderError extends Error {
  constructor(code, message, { errorType = LLM_ERROR_TYPES.UNKNOWN, retryAfterMs = null, detail } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code; // rótulo específico legado (NOT_CONFIGURED | NETWORK | TIMEOUT | AUTH | HTTP | INVALID_JSON | INVALID_SCHEMA | EMPTY)
    this.errorType = errorType; // taxonomia interna (ver llm/errorTypes.js) — usada para decidir retry
    this.retryAfterMs = retryAfterMs; // Retry-After (ms) informado pela API, quando disponível
    this.detail = detail;
  }
}

// Mensagens amigáveis (sem stack trace, sem secrets) para o frontend.
// `errorType` presente identifica tanto ProviderError quanto os erros
// sintéticos do coordenador central de rate limit (ver
// llm/rateLimitManager.js) — ambos já trazem mensagem pronta para exibir.
export function providerErrorMessage(err) {
  if (err instanceof ProviderError) return err.message;
  if (err?.cancelled) return err.message || "Execução interrompida (cancelada).";
  if (err && typeof err.errorType === "string" && typeof err.message === "string") return err.message;
  if (err && err.name === "AbortError") return "A chamada foi interrompida (timeout).";
  return "Erro inesperado durante a execução. Tente novamente.";
}

// Interface conceitual LLMProvider:
//   complete({ systemPrompt, userPrompt, purpose?, modelId?, reasoningEffort?, maxCompletionTokens? }) -> { content: string, raw: any }
// `purpose` ("reader" | "analyst") diz ao servidor QUAL modelo usar por
// padrão (LLM_READER_MODEL/LLM_ANALYST_MODEL, ver supabase/functions/llm-proxy)
// quando `modelId` não é enviado. `modelId` (opcional) é a seleção EXPLÍCITA
// do usuário (ver Model Catalog, js/llm/modelCatalog.js) — validada no
// servidor contra o catálogo (existir + estar ativo + ser compatível com a
// `purpose`); nunca um nome de modelo arbitrário aceito sem checagem.
// `reasoningEffort`/`maxCompletionTokens` são OPCIONAIS e nunca têm default
// aqui — quem decide enviá-los é o chamador (ex.: engine.js, só para
// ReadingRuns, usando js/config.js como única fonte de verdade). Isso
// garante que nenhum outro chamador/provider herde esses valores sem pedir
// explicitamente (ver LLM_READER_REASONING_EFFORT/LLM_READER_MAX_COMPLETION_TOKENS).
export class KimiProvider {
  constructor(cfg = getLLMConfig()) {
    this.cfg = cfg;
  }

  async complete({ systemPrompt, userPrompt, purpose, modelId, reasoningEffort, maxCompletionTokens }) {
    if (!this.cfg.endpoint) {
      throw new ProviderError(
        "NOT_CONFIGURED",
        "Nenhum backend LLM configurado. Conecte um proxy seguro (com a API Key no servidor) para executar leituras reais.",
        { errorType: LLM_ERROR_TYPES.INVALID_REQUEST }
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    // A Edge Function do Supabase exige um JWT válido no Authorization
    // header (a sessão anônima aberta por db.js serve para isso).
    const token = getAccessToken() || getAnonKey();

    let res;
    try {
      res = await fetch(this.cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          systemPrompt,
          userPrompt,
          ...(purpose ? { purpose } : {}),
          ...(modelId ? { modelId } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError") {
        throw new ProviderError("TIMEOUT", `A chamada à LLM excedeu o limite de ${Math.round(this.cfg.timeoutMs / 1000)}s.`, { errorType: LLM_ERROR_TYPES.TIMEOUT });
      }
      throw new ProviderError("NETWORK", "Falha de rede ao contatar o backend LLM.", { errorType: LLM_ERROR_TYPES.NETWORK_ERROR });
    }
    clearTimeout(timer);

    if (!res.ok) {
      // O corpo pode trazer `errorType` (error.type do provider, repassado
      // pelo proxy) e `retryAfterSeconds` (Retry-After da API) — ambos
      // opcionais; nunca contém API key/JWT/payload sensível (ver proxy).
      let body = null;
      try { body = await res.json(); } catch (_) { /* corpo não-JSON — segue sem detalhe extra */ }

      const errorType = res.status === 401 || res.status === 403
        ? LLM_ERROR_TYPES.AUTH_ERROR
        : classifyHttpErrorResponse(res.status, body);
      const retryAfterMs = typeof body?.retryAfterSeconds === "number" && body.retryAfterSeconds > 0
        ? body.retryAfterSeconds * 1000
        : null;

      const message =
        errorType === LLM_ERROR_TYPES.AUTH_ERROR ? (res.status === 401 ? "Sessão inválida ou expirada — faça login novamente." : "Esta conta não está autorizada a executar leituras com LLM.")
        : errorType === LLM_ERROR_TYPES.RATE_LIMIT ? "Limite de requisições atingido (rate limit). Aguarde e tente novamente."
        : errorType === LLM_ERROR_TYPES.ENGINE_OVERLOADED ? "O modelo está sobrecarregado no momento. Tentando novamente."
        : errorType === LLM_ERROR_TYPES.QUOTA_EXCEEDED ? "Cota da API de LLM excedida — verifique o plano/billing do provedor."
        : errorType === LLM_ERROR_TYPES.TIMEOUT ? "A API de LLM não respondeu a tempo."
        : typeof body?.message === "string" ? body.message
        : `O backend retornou erro HTTP ${res.status}.`;

      throw new ProviderError("HTTP", message, { errorType, retryAfterMs });
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new ProviderError("INVALID_JSON", "Resposta inválida do backend LLM (não era JSON).", { errorType: LLM_ERROR_TYPES.SERVER_ERROR });
    }

    const content = typeof data.content === "string" ? data.content : null;
    if (!content || !content.trim()) {
      throw new ProviderError("EMPTY", "O modelo retornou uma resposta vazia.", { errorType: LLM_ERROR_TYPES.SERVER_ERROR });
    }
    // finish_reason ("stop" | "length" | ...) repassado pelo proxy quando o
    // upstream o fornece — usado por analysisEngine.js para distinguir uma
    // resposta genuinamente inválida de uma resposta CORTADA por atingir
    // max_completion_tokens (nunca inferido por heurística de texto).
    return { content: content.trim(), model: data.model, usage: data.usage, structuredOutputMode: data.structuredOutputMode, finishReason: typeof data.finish_reason === "string" ? data.finish_reason : null };
  }
}

// Fábrica — ponto único de troca de provider no futuro
// (OpenAIProvider, AnthropicProvider, GeminiProvider, LocalModelProvider).
export function getProvider(cfg = getLLMConfig()) {
  return new KimiProvider(cfg);
}

// Discovery do Model Catalog (ver supabase/functions/llm-proxy/modelCatalog.mjs
// e js/llm/modelCatalog.js, que envolve esta função com cache) — nunca
// retorna a lista crua do provider, só a interseção sanitizada que o
// servidor já calculou. `availabilityUnverified: true` sinaliza que o
// servidor não conseguiu confirmar contra o provider agora (upstream fora
// do ar) e está retornando o catálogo conhecido mesmo assim — nunca quebra
// a tela por causa disso, quem decide como exibir é o chamador.
export async function fetchAvailableModels(cfg = getLLMConfig()) {
  if (!cfg.endpoint) {
    throw new ProviderError(
      "NOT_CONFIGURED",
      "Nenhum backend LLM configurado. Conecte um proxy seguro para consultar os modelos disponíveis.",
      { errorType: LLM_ERROR_TYPES.INVALID_REQUEST }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const token = getAccessToken() || getAnonKey();

  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action: "models" }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new ProviderError("TIMEOUT", `A consulta de modelos excedeu o limite de ${Math.round(cfg.timeoutMs / 1000)}s.`, { errorType: LLM_ERROR_TYPES.TIMEOUT });
    }
    throw new ProviderError("NETWORK", "Falha de rede ao consultar os modelos disponíveis.", { errorType: LLM_ERROR_TYPES.NETWORK_ERROR });
  }
  clearTimeout(timer);

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (_) { /* corpo não-JSON — segue sem detalhe extra */ }
    const message = typeof body?.message === "string" ? body.message : `Falha ao consultar modelos disponíveis (HTTP ${res.status}).`;
    throw new ProviderError("HTTP", message, { errorType: LLM_ERROR_TYPES.SERVER_ERROR });
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new ProviderError("INVALID_JSON", "Resposta inválida do backend ao consultar modelos (não era JSON).", { errorType: LLM_ERROR_TYPES.SERVER_ERROR });
  }

  return {
    models: Array.isArray(data?.models) ? data.models : [],
    availabilityUnverified: data?.availabilityUnverified === true,
  };
}
