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
//      (idem) o restante desse intervalo;
//   5) orçamento PREVENTIVO de RPM/TPM (ver _respectBudget) — janela
//      deslizante simples dos últimos `budgetWindowMs` (default 60s):
//      espera automaticamente (nunca gera FAILED) se a request excederia o
//      RPM ou TPM configurado. Desativado (sem esperar nada) quando
//      LLM_MAX_RPM/LLM_MAX_TPM não estão configurados — item 7 do pedido.
import { LLM_ERROR_TYPES } from "./errorTypes.js";
import { waitUntil, sleep } from "./retry.js";
import {
  LLM_MAX_CONCURRENCY,
  LLM_MIN_REQUEST_INTERVAL_MS,
  LLM_CIRCUIT_BREAKER_THRESHOLD,
  LLM_CIRCUIT_BREAKER_COOLDOWN_MS,
  LLM_MAX_RPM,
  LLM_MAX_TPM,
  LLM_RATE_LIMIT_SAFETY_FACTOR,
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
    maxRpm = LLM_MAX_RPM,
    maxTpm = LLM_MAX_TPM,
    safetyFactor = LLM_RATE_LIMIT_SAFETY_FACTOR,
    budgetWindowMs = 60000,
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

    // Orçamento preventivo de RPM/TPM — `null` desativa o respectivo
    // controle (item 7: sem configuração, funciona como antes). O fator de
    // segurança já é aplicado aqui uma única vez (ex.: 20 RPM * 0.8 = 16).
    this.effectiveRpm = maxRpm != null ? Math.max(1, Math.floor(maxRpm * safetyFactor)) : null;
    this.effectiveTpm = maxTpm != null ? Math.max(1, Math.floor(maxTpm * safetyFactor)) : null;
    this.budgetWindowMs = budgetWindowMs;
    this._budgetWindow = []; // { id, startedAt, tokens, final } — janela deslizante simples
    this._budgetSeq = 0;
    this._budgetWaiting = false; // exposto via getState() para o banner "controlando ritmo" da UI
  }

  // Estado consultável pela UI (ver ui.js: banner "Provider temporariamente
  // limitado"/"Cooldown da API"/"Controlando ritmo...") — nunca inclui
  // secrets/manuscrito.
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
      // true enquanto uma chamada aguarda o orçamento de RPM/TPM liberar
      // (nunca uma falha — ver _respectBudget) — distinto de `limited`
      // acima, que é sobre circuito/cooldown reativos a um 429 real.
      budgetLimited: this._budgetWaiting,
      effectiveRpm: this.effectiveRpm,
      effectiveTpm: this.effectiveTpm,
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
  // para chamadas reais à LLM fora daqui. `estimatedTokens` (opcional): a
  // melhor estimativa CONSERVADORA do chamador para o consumo total desta
  // request (prompt + teto de saída) — usada apenas para o orçamento de
  // TPM ANTES de a request acontecer; assim que ela conclui, a estimativa
  // é substituída pelo usage real (ver _recordRequestFinal).
  async run(fn, { isCancelled, estimatedTokens = 0 } = {}) {
    const isTrial = this._reserveCircuitPass();
    try {
      this._checkGlobalCooldown();
      await this._acquireSlot(isCancelled);
      try {
        await this._respectMinInterval(isCancelled);
        await this._respectBudget(estimatedTokens, isCancelled);
        this.lastRequestStartedAt = Date.now();
        const entry = this._recordRequestStart(estimatedTokens);
        const result = await fn();
        this._recordRequestFinal(entry, result);
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

  // ------------------------------------------- Orçamento de RPM/TPM (janela deslizante)
  // Descarta entradas mais antigas que `budgetWindowMs` — mantém a janela
  // sempre "dos últimos N segundos", sem precisar de nenhum agendador
  // separado (é recalculada a cada checagem, algoritmo deliberadamente
  // simples conforme pedido).
  _pruneBudgetWindow() {
    const cutoff = Date.now() - this.budgetWindowMs;
    while (this._budgetWindow.length && this._budgetWindow[0].startedAt < cutoff) this._budgetWindow.shift();
  }

  // Espera (em pedaços pequenos, cancelável, nunca gera FAILED) até que
  // NEM o número de requests NEM os tokens estimados/reais na janela dos
  // últimos `budgetWindowMs` ultrapassem o RPM/TPM efetivo configurado.
  // Desativado por completo (retorna na hora) quando nenhum dos dois está
  // configurado — item 7 do pedido.
  async _respectBudget(estimatedTokens, isCancelled) {
    if (this.effectiveRpm == null && this.effectiveTpm == null) return;
    let waiting = false;
    while (true) {
      this._pruneBudgetWindow();
      const requestCount = this._budgetWindow.length;
      const tokenSum = this._budgetWindow.reduce((sum, e) => sum + e.tokens, 0);
      const overRpm = this.effectiveRpm != null && requestCount >= this.effectiveRpm;
      const overTpm = this.effectiveTpm != null && (tokenSum + estimatedTokens) > this.effectiveTpm;
      if (!overRpm && !overTpm) break;
      // Janela já vazia e ainda acima do limite: é a PRÓPRIA request
      // (sozinha) que excede o teto configurado — esperar não ajudaria em
      // nada (não há mais nada a expirar) e travaria para sempre. Deixamos
      // seguir com um aviso, em vez de travar a run indefinidamente.
      if (requestCount === 0) {
        if (overTpm) {
          this._log("estimativa desta request sozinha excede o LLM_MAX_TPM configurado — seguindo mesmo assim (nada a aguardar).", { estimatedTokens, effectiveTpm: this.effectiveTpm });
        }
        break;
      }
      if (!waiting) {
        waiting = true;
        this._budgetWaiting = true;
        this._log("orçamento preventivo de RPM/TPM atingiria o limite configurado — aguardando a janela liberar (nunca gera FAILED).", {
          overRpm, overTpm, requestCount, tokenSum, estimatedTokens, effectiveRpm: this.effectiveRpm, effectiveTpm: this.effectiveTpm,
        });
      }
      if (isCancelled?.()) { this._budgetWaiting = false; throw new RateLimitCancelledError(); }
      await this.sleepFn(POLL_MS);
    }
    if (waiting) this._budgetWaiting = false;
  }

  // Registrada ANTES de chamar fn(): conta para o RPM assim que a request
  // é de fato disparada (nunca antes disso — uma rejeição por
  // circuito/cooldown não chega a chamar fn(), então não conta).
  _recordRequestStart(estimatedTokens) {
    const entry = { id: ++this._budgetSeq, startedAt: Date.now(), tokens: Math.max(0, Math.round(estimatedTokens) || 0), final: false };
    this._budgetWindow.push(entry);
    return entry;
  }

  // Troca a estimativa pelo usage REAL do provider assim que ele chega
  // (prompt_tokens/completion_tokens/total_tokens ou nomenclatura
  // equivalente) — mantém o TPM da janela cada vez mais preciso ao longo
  // do tempo, sem depender só de estimativa conservadora.
  _recordRequestFinal(entry, result) {
    const usage = result?.usage;
    if (!usage) return;
    const total = usage.total_tokens ?? usage.totalTokens
      ?? ((usage.prompt_tokens ?? usage.promptTokens ?? 0) + (usage.completion_tokens ?? usage.completionTokens ?? 0));
    if (typeof total === "number" && Number.isFinite(total) && total > 0) {
      entry.tokens = total;
      entry.final = true;
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
