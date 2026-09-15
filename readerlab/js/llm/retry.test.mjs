// ============ ReaderLab — Testes: taxonomia de erros da LLM + retry/backoff ============
// Sem infraestrutura de testes no projeto (sem build step, sem package.json)
// — roda direto com `node js/llm/retry.test.mjs` (só os módulos sob teste +
// assert nativo). Usa sleepFn injetado (resolve na hora) para não esperar
// segundos reais de backoff durante os testes.
//
// Cobre os cenários pedidos na especificação de resiliência a rate limit:
//   429 RATE_LIMIT          → retry
//   429 ENGINE_OVERLOADED   → retry
//   429 QUOTA_EXCEEDED      → sem retry
//   503 SERVER_ERROR        → retry
//   timeout                 → retry
//   400 INVALID_REQUEST     → FAILED direto (sem retry)
//   200                     → sucesso na 1ª tentativa
// + backoff exponencial (cap em maxDelay, jitter ±20%, Retry-After prioritário).
import assert from "node:assert/strict";
import {
  LLM_ERROR_TYPES,
  isRetryableErrorType,
  classifyProviderErrorTypeString,
  classifyHttpStatus,
  classifyHttpErrorResponse,
} from "./errorTypes.js";
import { computeBackoffDelayMs, runWithRetry } from "./retry.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS - ${name}`);
  } catch (err) {
    console.log(`FAIL - ${name}`);
    console.log("  " + err.message);
    process.exitCode = 1;
  }
}

// Erro simulado no mesmo shape de ProviderError (code/message/errorType/retryAfterMs).
function fakeError(errorType, retryAfterMs = null) {
  const err = new Error(errorType);
  err.errorType = errorType;
  err.retryAfterMs = retryAfterMs;
  return err;
}

const classify = (err) => ({ errorType: err?.errorType || LLM_ERROR_TYPES.UNKNOWN, retryAfterMs: err?.retryAfterMs || 0 });

// ----------------------------------------------------- Classificação de erros
await test("A) 429 genérico -> RATE_LIMIT, retryable", () => {
  const type = classifyHttpErrorResponse(429, {});
  assert.equal(type, LLM_ERROR_TYPES.RATE_LIMIT);
  assert.equal(isRetryableErrorType(type), true);
});

await test("B) 429 + error.type=rate_limit_reached_error -> RATE_LIMIT, retryable", () => {
  const type = classifyHttpErrorResponse(429, { errorType: "rate_limit_reached_error" });
  assert.equal(type, LLM_ERROR_TYPES.RATE_LIMIT);
  assert.equal(isRetryableErrorType(type), true);
});

await test("C) 429 + error.type=engine_overloaded_error -> ENGINE_OVERLOADED, retryable", () => {
  const type = classifyHttpErrorResponse(429, { errorType: "engine_overloaded_error" });
  assert.equal(type, LLM_ERROR_TYPES.ENGINE_OVERLOADED);
  assert.equal(isRetryableErrorType(type), true);
});

await test("D) 429 + error.type=exceeded_current_quota_error -> QUOTA_EXCEEDED, SEM retry", () => {
  const type = classifyHttpErrorResponse(429, { errorType: "exceeded_current_quota_error" });
  assert.equal(type, LLM_ERROR_TYPES.QUOTA_EXCEEDED);
  assert.equal(isRetryableErrorType(type), false);
});

await test("E) 503 -> SERVER_ERROR, retryable", () => {
  const type = classifyHttpErrorResponse(503, {});
  assert.equal(type, LLM_ERROR_TYPES.SERVER_ERROR);
  assert.equal(isRetryableErrorType(type), true);
});

await test("F) sinal explícito de timeout do proxy -> TIMEOUT, retryable", () => {
  const type = classifyHttpErrorResponse(504, { error: "timeout" });
  assert.equal(type, LLM_ERROR_TYPES.TIMEOUT);
  assert.equal(isRetryableErrorType(type), true);
});

await test("G) 400 -> INVALID_REQUEST, SEM retry (FAILED direto)", () => {
  const type = classifyHttpErrorResponse(400, {});
  assert.equal(type, LLM_ERROR_TYPES.INVALID_REQUEST);
  assert.equal(isRetryableErrorType(type), false);
});

await test("H) 401/403 -> AUTH_ERROR, SEM retry", () => {
  assert.equal(classifyHttpStatus(401), LLM_ERROR_TYPES.AUTH_ERROR);
  assert.equal(classifyHttpStatus(403), LLM_ERROR_TYPES.AUTH_ERROR);
  assert.equal(isRetryableErrorType(LLM_ERROR_TYPES.AUTH_ERROR), false);
});

await test("I) error.type desconhecido -> null (cai para o status HTTP)", () => {
  assert.equal(classifyProviderErrorTypeString("algo_nao_mapeado"), null);
});

await test("J) INVALID_RESPONSE (schema/prompt) -> SEM retry", () => {
  assert.equal(isRetryableErrorType(LLM_ERROR_TYPES.INVALID_RESPONSE), false);
});

// ----------------------------------------------------- Backoff exponencial
await test("K) computeBackoffDelayMs cresce exponencialmente e respeita jitter ±20%", () => {
  const cfg = { baseDelayMs: 2000, maxDelayMs: 120000 };
  for (const attempt of [1, 2, 3, 4]) {
    const expected = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
    const delay = computeBackoffDelayMs(attempt, cfg);
    assert.ok(delay >= expected * 0.8 - 1 && delay <= expected * 1.2 + 1, `attempt ${attempt}: ${delay} fora da faixa de ${expected}`);
  }
});

await test("L) computeBackoffDelayMs nunca ultrapassa maxDelayMs mesmo em attempts altos", () => {
  const delay = computeBackoffDelayMs(10, { baseDelayMs: 2000, maxDelayMs: 120000 });
  assert.ok(delay <= 120000 * 1.2 + 1);
});

await test("M) Retry-After maior que o backoff calculado tem prioridade", () => {
  const delay = computeBackoffDelayMs(1, { baseDelayMs: 2000, maxDelayMs: 120000, retryAfterMs: 90000 });
  assert.equal(delay, 90000);
});

await test("N) Retry-After menor que o backoff calculado NÃO reduz o backoff", () => {
  const delay = computeBackoffDelayMs(3, { baseDelayMs: 2000, maxDelayMs: 120000, retryAfterMs: 10 });
  assert.ok(delay > 10);
});

// ----------------------------------------------------- runWithRetry (fluxo completo)
await test("O) 200/sucesso imediato -> COMPLETED normalmente, 1 tentativa", async () => {
  let calls = 0;
  const result = await runWithRetry(() => { calls++; return Promise.resolve({ content: "ok" }); }, {
    classify, sleepFn: async () => {},
  });
  assert.deepEqual(result, { content: "ok" });
  assert.equal(calls, 1);
});

await test("P) 429 RATE_LIMIT falha 2x depois sucede -> retry automático, sem FAILED prematuro", async () => {
  let calls = 0;
  const attempts = [];
  const result = await runWithRetry(
    () => {
      calls++;
      if (calls <= 2) return Promise.reject(fakeError(LLM_ERROR_TYPES.RATE_LIMIT));
      return Promise.resolve({ content: "ok-depois-de-retry" });
    },
    { classify, sleepFn: async () => {}, onAttempt: (info) => attempts.push(info) }
  );
  assert.equal(calls, 3);
  assert.deepEqual(result, { content: "ok-depois-de-retry" });
  assert.equal(attempts.filter((a) => !a.ok).length, 2);
  assert.equal(attempts.every((a, i) => i === attempts.length - 1 || a.retryable), true);
});

await test("Q) 429 ENGINE_OVERLOADED -> retry automático", async () => {
  let calls = 0;
  const result = await runWithRetry(
    () => { calls++; return calls === 1 ? Promise.reject(fakeError(LLM_ERROR_TYPES.ENGINE_OVERLOADED)) : Promise.resolve({ content: "ok" }); },
    { classify, sleepFn: async () => {} }
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { content: "ok" });
});

await test("R) 429 QUOTA_EXCEEDED -> SEM retry (falha na 1ª tentativa)", async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry(() => { calls++; return Promise.reject(fakeError(LLM_ERROR_TYPES.QUOTA_EXCEEDED)); }, { classify, sleepFn: async () => {} }),
    /QUOTA_EXCEEDED/
  );
  assert.equal(calls, 1);
});

await test("S) 503 SERVER_ERROR -> retry automático", async () => {
  let calls = 0;
  const result = await runWithRetry(
    () => { calls++; return calls < 3 ? Promise.reject(fakeError(LLM_ERROR_TYPES.SERVER_ERROR)) : Promise.resolve({ content: "ok" }); },
    { classify, sleepFn: async () => {} }
  );
  assert.equal(calls, 3);
  assert.deepEqual(result, { content: "ok" });
});

await test("T) timeout -> retry automático", async () => {
  let calls = 0;
  const result = await runWithRetry(
    () => { calls++; return calls === 1 ? Promise.reject(fakeError(LLM_ERROR_TYPES.TIMEOUT)) : Promise.resolve({ content: "ok" }); },
    { classify, sleepFn: async () => {} }
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { content: "ok" });
});

await test("U) 400 INVALID_REQUEST -> FAILED direto (1 tentativa, sem retry)", async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry(() => { calls++; return Promise.reject(fakeError(LLM_ERROR_TYPES.INVALID_REQUEST)); }, { classify, sleepFn: async () => {} }),
    /INVALID_REQUEST/
  );
  assert.equal(calls, 1);
});

await test("V) esgota maxAttempts em falha persistente e propaga o erro final", async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry(() => { calls++; return Promise.reject(fakeError(LLM_ERROR_TYPES.SERVER_ERROR)); }, { classify, sleepFn: async () => {}, maxAttempts: 3 }),
    /SERVER_ERROR/
  );
  assert.equal(calls, 3);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
