// ============ ReaderLab — Taxonomia de erros da LLM ============
// Único lugar que define os tipos de erro possíveis numa chamada ao
// provider (KimiProvider) e quais são transitórios (retryable) por
// padrão. Usado por provider.js (classificação da resposta HTTP/payload)
// e engine.js (decisão de retry) — nunca duplicar esta lista/lógica em
// outro arquivo.
export const LLM_ERROR_TYPES = Object.freeze({
  RATE_LIMIT: "RATE_LIMIT",
  ENGINE_OVERLOADED: "ENGINE_OVERLOADED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  AUTH_ERROR: "AUTH_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  SERVER_ERROR: "SERVER_ERROR",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  UNKNOWN: "UNKNOWN",
});

// Transitórios: vale a pena tentar de novo automaticamente (ver llm/retry.js).
// Tudo que não está aqui (QUOTA_EXCEEDED, AUTH_ERROR, INVALID_REQUEST,
// INVALID_RESPONSE, UNKNOWN) é tratado como permanente nesta versão.
const RETRYABLE = new Set([
  LLM_ERROR_TYPES.RATE_LIMIT,
  LLM_ERROR_TYPES.ENGINE_OVERLOADED,
  LLM_ERROR_TYPES.NETWORK_ERROR,
  LLM_ERROR_TYPES.TIMEOUT,
  LLM_ERROR_TYPES.SERVER_ERROR,
]);

export function isRetryableErrorType(errorType) {
  return RETRYABLE.has(errorType);
}

// Mapeia o `error.type` retornado pela API da Kimi/Moonshot (quando o
// proxy consegue repassá-lo, ver supabase/functions/llm-proxy) para a
// taxonomia interna. Retorna null se não reconhecido.
export function classifyProviderErrorTypeString(providerErrorType) {
  switch (providerErrorType) {
    case "rate_limit_reached_error": return LLM_ERROR_TYPES.RATE_LIMIT;
    case "engine_overloaded_error": return LLM_ERROR_TYPES.ENGINE_OVERLOADED;
    case "exceeded_current_quota_error": return LLM_ERROR_TYPES.QUOTA_EXCEEDED;
    case "invalid_request_error": return LLM_ERROR_TYPES.INVALID_REQUEST;
    case "authentication_error": return LLM_ERROR_TYPES.AUTH_ERROR;
    default: return null;
  }
}

// Mapeia um status HTTP para a taxonomia interna — usado como base/fallback
// quando o error.type específico do provider não está disponível ou não é
// reconhecido (classifyProviderErrorTypeString retornou null).
export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return LLM_ERROR_TYPES.AUTH_ERROR;
  if (status === 429) return LLM_ERROR_TYPES.RATE_LIMIT;
  if (status === 408) return LLM_ERROR_TYPES.TIMEOUT;
  if (status === 400 || status === 404 || status === 405 || status === 413) return LLM_ERROR_TYPES.INVALID_REQUEST;
  if (status >= 500) return LLM_ERROR_TYPES.SERVER_ERROR;
  return LLM_ERROR_TYPES.UNKNOWN;
}

// Classificação completa de uma resposta HTTP de erro: prioriza o sinal
// explícito de timeout do nosso proxy, depois refina 429 com o error.type
// do provider (quando presente), e por fim cai para o status HTTP puro.
export function classifyHttpErrorResponse(status, body) {
  if (body && body.error === "timeout") return LLM_ERROR_TYPES.TIMEOUT;
  if (status === 429) {
    const providerType = body?.errorType ? classifyProviderErrorTypeString(body.errorType) : null;
    if (providerType) return providerType;
  }
  return classifyHttpStatus(status);
}

// Remove tokens/segredos que possam ter vazado para dentro de uma mensagem
// de erro (defensivo — as mensagens usadas no ReaderLab já são strings
// fixas em português, nunca o payload cru) e limita o tamanho persistido.
const SECRET_LIKE = /[A-Za-z0-9_-]{24,}/g;
export function sanitizeErrorMessage(message, maxLen = 300) {
  if (typeof message !== "string") return "";
  const scrubbed = message.replace(SECRET_LIKE, "[redigido]");
  return scrubbed.length > maxLen ? scrubbed.slice(0, maxLen) + "…" : scrubbed;
}
