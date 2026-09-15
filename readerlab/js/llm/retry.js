// ============ ReaderLab — Retry com backoff exponencial para chamadas à LLM ============
// Único lugar que decide QUANTAS vezes tentar de novo e QUANTO esperar
// entre tentativas de uma chamada ao provider. Usado por engine.js — nunca
// duplicar esta lógica em outro arquivo. Defaults vêm de config.js (única
// fonte de verdade), nunca hardcoded aqui ou no chamador.
import { LLM_MAX_ATTEMPTS, LLM_RETRY_BASE_DELAY_MS, LLM_RETRY_MAX_DELAY_MS } from "../config.js";
import { isRetryableErrorType } from "./errorTypes.js";

export function getRetryConfig(overrides = {}) {
  return {
    maxAttempts: overrides.maxAttempts ?? LLM_MAX_ATTEMPTS,
    baseDelayMs: overrides.baseDelayMs ?? LLM_RETRY_BASE_DELAY_MS,
    maxDelayMs: overrides.maxDelayMs ?? LLM_RETRY_MAX_DELAY_MS,
  };
}

// delay = min(maxDelay, baseDelay * 2^(attempt-1)), com jitter de ±20%.
// Um Retry-After do servidor (retryAfterMs), quando maior que esse backoff,
// tem prioridade sobre o valor calculado localmente.
export function computeBackoffDelayMs(attempt, { baseDelayMs, maxDelayMs, retryAfterMs = 0 } = {}) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitter = exponential * (Math.random() * 0.4 - 0.2); // ±20%
  const withJitter = Math.max(0, Math.round(exponential + jitter));
  return retryAfterMs > withJitter ? Math.round(retryAfterMs) : withJitter;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Executa `attempt(attemptNumber)` até resolver ou esgotar as tentativas.
// `classify(err)` deve retornar `{ errorType, retryAfterMs }` a partir do
// erro lançado (ex.: ProviderError já carrega isso, ver llm/provider.js) —
// a decisão de retry nunca é tomada fora da taxonomia de errorTypes.js.
// `onAttempt({ attempt, ok, errorType, retryable, error })` é chamado a
// cada tentativa (sucesso ou falha) para permitir persistir metadata/log
// sem que esta função saiba nada sobre ReadingRun.
export async function runWithRetry(attempt, {
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
  classify,
  onAttempt,
  sleepFn = sleep,
} = {}) {
  const cfg = getRetryConfig({ maxAttempts, baseDelayMs, maxDelayMs });
  let lastError;
  for (let n = 1; n <= cfg.maxAttempts; n++) {
    try {
      const result = await attempt(n);
      await onAttempt?.({ attempt: n, ok: true });
      return result;
    } catch (err) {
      lastError = err;
      const { errorType, retryAfterMs } = classify ? (classify(err) || {}) : {};
      const retryable = isRetryableErrorType(errorType);
      await onAttempt?.({ attempt: n, ok: false, errorType, retryable, error: err });
      if (!retryable || n >= cfg.maxAttempts) throw err;
      const delay = computeBackoffDelayMs(n, { baseDelayMs: cfg.baseDelayMs, maxDelayMs: cfg.maxDelayMs, retryAfterMs });
      await sleepFn(delay);
    }
  }
  throw lastError;
}
