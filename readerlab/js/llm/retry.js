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

// Espera até `timestamp` (epoch ms) em pequenos pedaços (nunca um único
// setTimeout gigante) — permite verificar `isCancelled()` periodicamente
// (ex.: PopulationRun cancelada enquanto uma ReadingRun aguardava) sem
// segurar um timer como única fonte de verdade: a fonte de verdade real é
// sempre o `timestamp` persistido pelo chamador (ver runWithRetry/engine.js),
// nunca este loop em si — se a aba fechar/recarregar no meio da espera, o
// chamador recalcula tudo de novo a partir do que está persistido.
// Retorna `true` se a espera foi interrompida por cancelamento.
export async function waitUntil(timestamp, { chunkMs = 2000, isCancelled, sleepFn = sleep } = {}) {
  while (Date.now() < timestamp) {
    if (isCancelled?.()) return true;
    await sleepFn(Math.min(chunkMs, timestamp - Date.now()));
  }
  return !!isCancelled?.();
}

// Erro sintético lançado quando um retry é interrompido por cancelamento
// (ex.: usuário cancelou a PopulationRun enquanto esta ReadingRun aguardava)
// — distinto de uma falha real, para que o chamador não marque a run como
// FAILED nesse caso (ver engine.js).
export class RetryCancelledError extends Error {
  constructor() {
    super("Retry interrompido: execução cancelada.");
    this.name = "RetryCancelledError";
    this.cancelled = true;
  }
}

// Executa `attempt(attemptNumber)` até resolver ou esgotar as tentativas.
// `classify(err)` deve retornar `{ errorType, retryAfterMs }` a partir do
// erro lançado (ex.: ProviderError já carrega isso, ver llm/provider.js) —
// a decisão de retry nunca é tomada fora da taxonomia de errorTypes.js.
// `onAttempt({ attempt, ok, errorType, retryable, error, result })` é
// chamado a cada tentativa (sucesso ou falha) para permitir persistir
// metadata/log sem que esta função saiba nada sobre ReadingRun. `result`
// só vem preenchido quando `ok: true` (o retorno de `attempt(n)`);
// `errorType`/`retryable`/`error` só quando `ok: false`.
// `onWaitingRetry({ attempt, errorType, nextRetryAt })` é chamado ANTES de
// começar a esperar — é o gancho para persistir status=WAITING_RETRY +
// nextRetryAt, o que torna o retry sobrevivente a um refresh da página.
// `beforeAttempt(attemptNumber)` é chamado logo antes de CADA tentativa
// (inclusive a primeira) — gancho para persistir status=RUNNING.
// `startAttempt`/`initialWaitUntil`: permitem RETOMAR um retry já em
// andamento (persistido antes de um refresh) sem reiniciar attemptCount
// nem pular a espera restante até `next_retry_at`.
// `isCancelled()`: checado durante a espera; se true, interrompe sem
// contar como uma nova tentativa nem marcar falha definitiva.
export async function runWithRetry(attempt, {
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
  startAttempt = 1,
  initialWaitUntil = null,
  classify,
  onAttempt,
  onWaitingRetry,
  beforeAttempt,
  isCancelled,
  waitChunkMs,
  sleepFn = sleep,
} = {}) {
  const cfg = getRetryConfig({ maxAttempts, baseDelayMs, maxDelayMs });

  // Defensivo: só acontece se maxAttempts foi reduzido (ex.: config) entre a
  // persistência do WAITING_RETRY e a retomada — sem isso o loop abaixo
  // nunca rodaria e "lastError" seria lançado undefined.
  if (startAttempt > cfg.maxAttempts) {
    throw new Error(`Retry retomado além do limite de tentativas (${startAttempt - 1}/${cfg.maxAttempts}).`);
  }

  if (initialWaitUntil) {
    const cancelled = await waitUntil(initialWaitUntil, { chunkMs: waitChunkMs, isCancelled, sleepFn });
    if (cancelled) throw new RetryCancelledError();
  }

  let lastError;
  for (let n = startAttempt; n <= cfg.maxAttempts; n++) {
    await beforeAttempt?.(n);
    try {
      const result = await attempt(n);
      // `result` incluído (campo adicional, nunca remove os existentes)
      // para permitir ao chamador (ver engine.js) contabilizar o usage da
      // tentativa que teve sucesso junto com o de tentativas anteriores que
      // falharam mas ainda assim consumiram tokens — ver soma de
      // attemptUsage em engine.js/analysisEngine.js.
      await onAttempt?.({ attempt: n, ok: true, result });
      return result;
    } catch (err) {
      lastError = err;
      const { errorType, retryAfterMs } = classify ? (classify(err) || {}) : {};
      const retryable = isRetryableErrorType(errorType);
      await onAttempt?.({ attempt: n, ok: false, errorType, retryable, error: err });
      if (!retryable || n >= cfg.maxAttempts) throw err;
      const delay = computeBackoffDelayMs(n, { baseDelayMs: cfg.baseDelayMs, maxDelayMs: cfg.maxDelayMs, retryAfterMs });
      const nextRetryAt = Date.now() + delay;
      await onWaitingRetry?.({ attempt: n, errorType, nextRetryAt });
      const cancelled = await waitUntil(nextRetryAt, { chunkMs: waitChunkMs, isCancelled, sleepFn });
      if (cancelled) throw new RetryCancelledError();
    }
  }
  // Só chega aqui se `startAttempt` (retomada) já vier maior que
  // cfg.maxAttempts — ex.: maxAttempts foi reduzido entre sessões via
  // window.READERLAB_LLM_MAX_ATTEMPTS. Nunca deveria acontecer em uso
  // normal (uma run só é persistida em WAITING_RETRY quando ainda havia
  // tentativas restantes), mas nunca lança `undefined` para o chamador.
  throw lastError || new Error("runWithRetry: número de tentativas já esgotado ao retomar (startAttempt > maxAttempts).");
}
