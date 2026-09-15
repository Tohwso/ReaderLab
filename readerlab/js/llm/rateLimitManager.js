// ============ ReaderLab — Rate Limit Manager central para chamadas à LLM ============
// Coordenador ÚNICO por onde passam TODAS as chamadas reais ao provider de
// LLM (nunca o provider demo/local, que não bate em nenhuma API) — nenhuma
// ReadingRun ataca a API independentemente, mesmo quando várias
// PopulationRuns/ReadingRuns avulsas estão em andamento ao mesmo tempo
// nesta aba. Nunca duplicar esta lógica em engine.js/provider.js: eles só
// chamam `manager.run(fn)`.
//
// Estado é por instância de módulo (singleton `kimiRateLimitManager`
// abaixo) — vive só nesta aba/sessão de página, igual ao `inFlight` de
// engine.js; não há coordenação entre abas/dispositivos (fora de escopo:
// exigiria um componente de servidor).
//
// Antes de deixar uma chamada prosseguir, `run()` verifica, nesta ordem:
//   1) circuito (circuit breaker) — se OPEN, rejeita NA HORA (sem tentar a
//      rede) com um erro no mesmo formato de ProviderError (errorType
//      RATE_LIMIT + retryAfterMs) — o retry.js já existente (persistência
//      WAITING_RETRY + backoff) trata a espera sem precisar saber que o
//      motivo foi o circuito e não o provider;
//   2) cooldown global — mesma rejeição imediata, se um Retry-After
//      recente ainda não expirou;
//   3) concorrência máxima — espera (em pedaços pequenos, cancelável) até
//      haver uma vaga;
//   4) intervalo mínimo entre o INÍCIO de requests consecutivas — espera
//      (idem) o restante desse intervalo.
import { LLM_ERROR_TYPES } from "./errorTypes.js";
import { waitUntil, sleep } from "./retry.js";
import {
  LLM_MAX_CONCURRENCY,
  LLM_MIN_REQUEST_INTERVAL_MS,
  LLM_CIRCUIT_BREAKER_THRESHOLD,
  LLM_CIRCUIT_BREAKER_COOLDOWN_MS,
} from "../config.js";

export const CIRCUIT_STATE = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

// Erro sintético (mesmo shape de ProviderError) lançado pelo manager SEM
// chamar o provider — para circuito aberto/cooldown global. `classify()`
// em engine.js lê `errorType`/`retryAfterMs` normalmente, sem saber que a
// origem foi o coordenador e não a API.
export class RateLimitedError extends Error {
  constructor(message, retryAfterMs, reason) {
    super(message);
    this.name = "RateLimitedError";
    this.errorType = LLM_ERROR_TYPES.RATE_LIMIT;
    this.retryAfterMs = Math.max(0, Math.round(retryAfterMs || 0));
    this.reason = reason; // "circuit-open" | "half-open-busy" | "global-cooldown" — só para log/diagnóstico
  }
}

// Interrompe a espera por uma vaga de concorrência/intervalo mínimo por
// cancelamento (ver isCancelled) — mesmo espírito do RetryCancelledError
// de retry.js: não é uma falha, é a run ficando parada onde estava.
export class RateLimitCancelledError extends Error {
  constructor() {
    super("Execução cancelada enquanto aguardava o coordenador de rate limit.");
    this.name = "RateLimitCancelledError";
    this.cancelled = true;
  }
}

const POLL_MS = 250;

export class RateLimitManager {
  constructor({
    provider = "llm",
    maxConcurrency = LLM_MAX_CONCURRENCY,
    minRequestIntervalMs = LLM_MIN_REQUEST_INTERVAL_MS,
    circuitBreakerThreshold = LLM_CIRCUIT_BREAKER_THRESHOLD,
    circuitBreakerCooldownMs = LLM_CIRCUIT_BREAKER_COOLDOWN_MS,
    sleepFn = sleep,
  } = {}) {
    this.provider = provider;
    this.maxConcurrency = maxConcurrency;
    this.minRequestIntervalMs = minRequestIntervalMs;
    this.circuitBreakerThreshold = circuitBreakerThreshold;
    this.circuitBreakerCooldownMs = circuitBreakerCooldownMs;
    this.sleepFn = sleepFn;

    this.active = 0;
    this.lastRequestStartedAt = 0;
    this.globalCooldownUntil = 0;
    this.circuitState = CIRCUIT_STATE.CLOSED;
    this.circuitOpenUntil = 0;
    this.consecutiveTransientErrors = 0;
    this.halfOpenTrialInFlight = false;
  }

  // Estado consultável pela UI (ver ui.js: banner "Provider temporariamente
  // limitado"/"Cooldown da API") — nunca inclui secrets/manuscrito.
  getState() {
    const now = Date.now();
    const cooldownUntil = this.globalCooldownUntil > now ? this.globalCooldownUntil : null;
    const circuitOpenUntil = this.circuitState === CIRCUIT_STATE.OPEN ? this.circuitOpenUntil : null;
    return {
      provider: this.provider,
      circuitState: this.circuitState,
      circuitOpenUntil,
      globalCooldownUntil: cooldownUntil,
      active: this.active,
      limited: circuitOpenUntil != null || cooldownUntil != null,
    };
  }

  _log(msg, extra = {}) {
    console.warn(`[RateLimitManager:${this.provider}] ${msg}`, {
      ts: new Date().toISOString(),
      circuitState: this.circuitState,
      ...extra,
    });
  }

  // Ponto único de entrada: nunca chame provider.complete() diretamente
  // para chamadas reais à LLM fora daqui.
  async run(fn, { isCancelled } = {}) {
    const isTrial = this._reserveCircuitPass();
    try {
      this._checkGlobalCooldown();
      await this._acquireSlot(isCancelled);
      try {
        await this._respectMinInterval(isCancelled);
        this.lastRequestStartedAt = Date.now();
        const result = await fn();
        this._onSuccess(isTrial);
        return result;
      } catch (err) {
        this._onFailure(err, isTrial);
        throw err;
      } finally {
        this.active--;
      }
    } finally {
      if (isTrial) this.halfOpenTrialInFlight = false;
    }
  }

  // Decide/reserva ATOMICAMENTE (sem nenhum `await` no meio) se esta
  // chamada é a única tentativa de teste do HALF_OPEN — evita que duas
  // chamadas concorrentes dupliquem a mesma tentativa de teste.
  _reserveCircuitPass() {
    const now = Date.now();
    if (this.circuitState === CIRCUIT_STATE.OPEN) {
      if (now < this.circuitOpenUntil) {
        throw new RateLimitedError(
          "Provider temporariamente limitado (circuito aberto) — aguardando antes de tentar de novo.",
          this.circuitOpenUntil - now,
          "circuit-open"
        );
      }
      this.circuitState = CIRCUIT_STATE.HALF_OPEN;
      this.halfOpenTrialInFlight = true;
      this._log("circuito meio-aberto (HALF_OPEN) — permitindo 1 chamada de teste.");
      return true;
    }
    if (this.circuitState === CIRCUIT_STATE.HALF_OPEN) {
      if (this.halfOpenTrialInFlight) {
        throw new RateLimitedError(
          "Já há uma chamada de teste em andamento (circuito meio-aberto) — aguardando o resultado.",
          2000,
          "half-open-busy"
        );
      }
      this.halfOpenTrialInFlight = true;
      return true;
    }
    return false;
  }

  _checkGlobalCooldown() {
    const now = Date.now();
    if (this.globalCooldownUntil > now) {
      throw new RateLimitedError(
        "Cooldown global da API ainda ativo — aguardando antes de tentar de novo.",
        this.globalCooldownUntil - now,
        "global-cooldown"
      );
    }
  }

  async _acquireSlot(isCancelled) {
    while (this.active >= this.maxConcurrency) {
      if (isCancelled?.()) throw new RateLimitCancelledError();
      await this.sleepFn(POLL_MS);
    }
    this.active++;
  }

  async _respectMinInterval(isCancelled) {
    const nextAllowedAt = this.lastRequestStartedAt + this.minRequestIntervalMs;
    if (nextAllowedAt > Date.now()) {
      const cancelled = await waitUntil(nextAllowedAt, { chunkMs: POLL_MS, isCancelled, sleepFn: this.sleepFn });
      if (cancelled) throw new RateLimitCancelledError();
    }
  }

  _onSuccess(isTrial) {
    this.consecutiveTransientErrors = 0;
    if (isTrial) {
      this.circuitState = CIRCUIT_STATE.CLOSED;
      this.circuitOpenUntil = 0;
      this._log("chamada de teste OK — circuito fechado (CLOSED).");
    }
  }

  _onFailure(err, isTrial) {
    const errorType = err?.errorType;
    const isRateSignal = errorType === LLM_ERROR_TYPES.RATE_LIMIT || errorType === LLM_ERROR_TYPES.ENGINE_OVERLOADED;

    if (errorType === LLM_ERROR_TYPES.RATE_LIMIT && typeof err.retryAfterMs === "number" && err.retryAfterMs > 0) {
      const until = Date.now() + err.retryAfterMs;
      if (until > this.globalCooldownUntil) {
        this.globalCooldownUntil = until;
        this._log("RATE_LIMIT com Retry-After — cooldown global atualizado.", { cooldownMs: err.retryAfterMs });
      }
    }

    if (isTrial) {
      // Falhou a chamada de teste do HALF_OPEN -> reabre na hora,
      // independentemente do tipo de erro ou do contador de consecutivos.
      this._openCircuit();
      return;
    }

    if (isRateSignal) {
      this.consecutiveTransientErrors++;
      this._log(`erro transitório consecutivo (${this.consecutiveTransientErrors}/${this.circuitBreakerThreshold}).`, { errorType });
      if (this.consecutiveTransientErrors >= this.circuitBreakerThreshold) this._openCircuit();
    } else {
      this.consecutiveTransientErrors = 0;
    }
  }

  _openCircuit() {
    this.circuitState = CIRCUIT_STATE.OPEN;
    this.circuitOpenUntil = Date.now() + this.circuitBreakerCooldownMs;
    this.consecutiveTransientErrors = 0;
    this._log("circuito aberto (OPEN) — chamadas novas bloqueadas até o fim do cooldown.", {
      cooldownMs: this.circuitBreakerCooldownMs,
    });
  }
}

// Singleton do único provider real em uso hoje (Kimi via proxy, ver
// llm/provider.js) — se um dia existir mais de um provider real
// simultâneo, criar uma instância por provider (nunca compartilhar estado
// entre providers distintos).
export const kimiRateLimitManager = new RateLimitManager({ provider: "kimi" });
