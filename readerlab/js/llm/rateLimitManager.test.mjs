// ============ ReaderLab — Testes: coordenador central de rate limit (LLM) ============
// Sem infraestrutura de testes no projeto — roda direto com
// `node js/llm/rateLimitManager.test.mjs`. Usa sleepFn injetado (resolve na
// hora) para as esperas de POLL, e valores minúsculos de intervalo/cooldown
// (dezenas de ms) para os casos que precisam do relógio real (Date.now()).
import assert from "node:assert/strict";
import { LLM_ERROR_TYPES } from "./errorTypes.js";
import { RateLimitManager, RateLimitedError, RateLimitCancelledError, CIRCUIT_STATE } from "./rateLimitManager.js";

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

function fakeProviderError(errorType, retryAfterMs = null) {
  const err = new Error(errorType);
  err.errorType = errorType;
  err.retryAfterMs = retryAfterMs;
  return err;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noWait = async () => {}; // seguro quando o teste não depende de tempo real decorrido

function makeManager(overrides = {}) {
  return new RateLimitManager({
    provider: "test",
    maxConcurrency: 1,
    minRequestIntervalMs: 0,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 50,
    sleepFn: noWait,
    ...overrides,
  });
}

// ----------------------------------------------------- Concorrência
await test("A) maxConcurrency=1: uma 2ª chamada só roda depois que a 1ª libera o slot", async () => {
  const mgr = makeManager({ sleepFn: realSleep });
  const order = [];
  let releaseFirst;
  const first = mgr.run(() => new Promise((resolve) => {
    order.push("first-start");
    releaseFirst = () => { order.push("first-end"); resolve("ok1"); };
  }));
  await realSleep(20); // dá tempo da 1ª realmente começar antes da 2ª ser disparada
  const second = mgr.run(() => { order.push("second-start"); return Promise.resolve("ok2"); });
  await realSleep(20);
  assert.deepEqual(order, ["first-start"]); // a 2ª ainda não deveria ter rodado
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

await test("B) uma falha na chamada sempre libera o slot (nunca trava em deadlock)", async () => {
  const mgr = makeManager();
  await assert.rejects(mgr.run(() => Promise.reject(fakeProviderError(LLM_ERROR_TYPES.NETWORK_ERROR))));
  // se o slot não tivesse sido liberado no finally, esta 2ª chamada travaria (maxConcurrency=1)
  const result = await mgr.run(() => Promise.resolve("ok"));
  assert.equal(result, "ok");
});

// ----------------------------------------------------- Intervalo mínimo
await test("C) respeita o intervalo mínimo entre o INÍCIO de requests consecutivas", async () => {
  const mgr = makeManager({ minRequestIntervalMs: 40, sleepFn: realSleep });
  const starts = [];
  await mgr.run(() => { starts.push(Date.now()); return Promise.resolve("ok"); });
  await mgr.run(() => { starts.push(Date.now()); return Promise.resolve("ok"); });
  assert.ok(starts[1] - starts[0] >= 35, `esperava >=~40ms entre inícios, teve ${starts[1] - starts[0]}ms`);
});

// ----------------------------------------------------- Cooldown global (Retry-After)
await test("D) RATE_LIMIT com Retry-After ativa cooldown global — próxima chamada é rejeitada SEM tentar de novo", async () => {
  const mgr = makeManager();
  let calls = 0;
  await assert.rejects(
    mgr.run(() => { calls++; return Promise.reject(fakeProviderError(LLM_ERROR_TYPES.RATE_LIMIT, 5000)); })
  );
  assert.equal(calls, 1);
  await assert.rejects(
    mgr.run(() => { calls++; return Promise.resolve("nunca deveria chamar"); }),
    (err) => err instanceof RateLimitedError && err.reason === "global-cooldown" && err.retryAfterMs > 0
  );
  assert.equal(calls, 1); // a 2ª chamada nem tentou — cooldown bloqueou antes
});

// ----------------------------------------------------- Circuit breaker (cenário do item 11)
await test("E) 5 RATE_LIMIT consecutivos abrem o circuito (OPEN) — nenhuma chamada nova durante o cooldown", async () => {
  const mgr = makeManager({ circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 10000 });
  let calls = 0;
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mgr.run(() => { calls++; return Promise.reject(fakeProviderError(LLM_ERROR_TYPES.RATE_LIMIT)); }));
  }
  assert.equal(calls, 5);
  assert.equal(mgr.circuitState, CIRCUIT_STATE.OPEN);

  // 6ª chamada: circuito OPEN -> rejeitada NA HORA, sem nem tentar a rede
  await assert.rejects(
    mgr.run(() => { calls++; return Promise.resolve("nunca deveria chamar"); }),
    (err) => err instanceof RateLimitedError && err.reason === "circuit-open"
  );
  assert.equal(calls, 5); // não incrementou — não chegou a chamar fn()
});

await test("F) após o cooldown do circuito, a próxima chamada é a única tentativa de teste (HALF_OPEN) — sucesso fecha (CLOSED)", async () => {
  const mgr = makeManager({ circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 30, sleepFn: realSleep });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mgr.run(() => Promise.reject(fakeProviderError(LLM_ERROR_TYPES.RATE_LIMIT))));
  }
  assert.equal(mgr.circuitState, CIRCUIT_STATE.OPEN);
  await realSleep(40); // espera o cooldown do circuito passar de verdade

  let calls = 0;
  const result = await mgr.run(() => { calls++; return Promise.resolve("ok-teste"); });
  assert.equal(result, "ok-teste");
  assert.equal(calls, 1);
  assert.equal(mgr.circuitState, CIRCUIT_STATE.CLOSED);

  // depois de CLOSED, chamadas voltam ao normal
  const again = await mgr.run(() => Promise.resolve("ok-normal"));
  assert.equal(again, "ok-normal");
});

await test("G) se a chamada de teste (HALF_OPEN) falhar, reabre o circuito imediatamente (sem esperar novo threshold)", async () => {
  const mgr = makeManager({ circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 30, sleepFn: realSleep });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mgr.run(() => Promise.reject(fakeProviderError(LLM_ERROR_TYPES.RATE_LIMIT))));
  }
  await realSleep(40);
  // a chamada de teste falha de novo -> reabre na hora (não precisa de 5 falhas de novo)
  await assert.rejects(mgr.run(() => Promise.reject(fakeProviderError(LLM_ERROR_TYPES.RATE_LIMIT))));
  assert.equal(mgr.circuitState, CIRCUIT_STATE.OPEN);
  await assert.rejects(
    mgr.run(() => Promise.resolve("nunca deveria chamar")),
    (err) => err instanceof RateLimitedError && err.reason === "circuit-open"
  );
});

await test("H) erros NÃO relacionados a rate limit/sobrecarga não contam para o circuito", async () => {
  const mgr = makeManager({ circuitBreakerThreshold: 3 });
  for (let i = 0; i < 10; i++) {
    await assert.rejects(mgr.run(() => Promise.reject(fakeProviderError(LLM_ERROR_TYPES.NETWORK_ERROR))));
  }
  assert.equal(mgr.circuitState, CIRCUIT_STATE.CLOSED);
});

// ----------------------------------------------------- Cancelamento (nunca deadlock)
await test("I) isCancelled() interrompe a espera por uma vaga sem deixar o slot preso", async () => {
  const mgr = makeManager({ maxConcurrency: 1, sleepFn: realSleep });
  let releaseFirst;
  const first = mgr.run(() => new Promise((resolve) => { releaseFirst = () => resolve("ok1"); }));
  await realSleep(10);
  let cancelled = false;
  const second = mgr.run(() => Promise.resolve("nunca deveria chamar"), { isCancelled: () => cancelled });
  await realSleep(10);
  cancelled = true;
  await assert.rejects(second, (err) => err instanceof RateLimitCancelledError && err.cancelled === true);
  releaseFirst();
  await first;
  // slot deve estar livre de novo (sem deadlock)
  const third = await mgr.run(() => Promise.resolve("ok3"));
  assert.equal(third, "ok3");
});

// ----------------------------------------------------- Orçamento preventivo de RPM/TPM
await test("J) orçamento de RPM: chamadas além do limite esperam a janela liberar (nunca gera erro)", async () => {
  const mgr = makeManager({ maxConcurrency: 10, minRequestIntervalMs: 0, maxRpm: 2, safetyFactor: 1, budgetWindowMs: 150, sleepFn: realSleep });
  const t0 = Date.now();
  await mgr.run(() => Promise.resolve("ok"));
  await mgr.run(() => Promise.resolve("ok"));
  await mgr.run(() => Promise.resolve("ok")); // 3ª estoura o RPM=2 -> espera a janela (~150ms) liberar
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 140, `esperava >=~150ms de espera pelo orçamento de RPM, decorreu ${elapsed}ms`);
});

await test("K) orçamento de TPM: soma estimada além do limite espera a janela liberar", async () => {
  const mgr = makeManager({ maxConcurrency: 10, minRequestIntervalMs: 0, maxTpm: 100, safetyFactor: 1, budgetWindowMs: 150, sleepFn: realSleep });
  const t0 = Date.now();
  await mgr.run(() => Promise.resolve({ result: "a" }), { estimatedTokens: 60 });
  await mgr.run(() => Promise.resolve({ result: "b" }), { estimatedTokens: 60 }); // 60+60=120 > 100 -> espera
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 140, `esperava >=~150ms de espera pelo orçamento de TPM, decorreu ${elapsed}ms`);
});

await test("L) safetyFactor é aplicado sobre o RPM/TPM configurado (ex.: 20 RPM * 0.8 = 16 efetivo)", () => {
  const mgr = makeManager({ maxRpm: 20, maxTpm: 1000, safetyFactor: 0.8 });
  assert.equal(mgr.effectiveRpm, 16);
  assert.equal(mgr.effectiveTpm, 800);
});

await test("M) usage real do provider substitui a estimativa conservadora na janela", async () => {
  const mgr = makeManager({ maxConcurrency: 10, minRequestIntervalMs: 0, maxTpm: 50, safetyFactor: 1, budgetWindowMs: 5000, sleepFn: realSleep });
  await mgr.run(() => Promise.resolve({ content: "x", usage: { total_tokens: 10 } }), { estimatedTokens: 1000 });
  // Sem a substituição pelo usage real, a próxima chamada ficaria presa
  // esperando os 1000 tokens ESTIMADOS originalmente saírem da janela de
  // 5s (bem maior que o tempo desta asserção) — provando que o real (10)
  // passou a valer no lugar da estimativa.
  const start = Date.now();
  await mgr.run(() => Promise.resolve({ content: "y" }), { estimatedTokens: 30 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 300, `esperava que a 2ª chamada não esperasse a janela inteira, decorreu ${elapsed}ms`);
});

await test("N) sem LLM_MAX_RPM/LLM_MAX_TPM configurados, nenhuma espera adicional é introduzida", async () => {
  const mgr = makeManager({ maxConcurrency: 10, minRequestIntervalMs: 0, sleepFn: realSleep }); // maxRpm/maxTpm ausentes -> null
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await mgr.run(() => Promise.resolve("ok"));
  assert.ok(Date.now() - t0 < 100, "nenhuma chamada deveria ter esperado o orçamento (desativado)");
});

await test("O) getState().budgetLimited fica true só enquanto aguarda o orçamento", async () => {
  const mgr = makeManager({ maxConcurrency: 10, minRequestIntervalMs: 0, maxRpm: 1, safetyFactor: 1, budgetWindowMs: 100, sleepFn: realSleep });
  await mgr.run(() => Promise.resolve("ok"));
  const p = mgr.run(() => Promise.resolve("ok"));
  await realSleep(20);
  assert.equal(mgr.getState().budgetLimited, true);
  await p;
  assert.equal(mgr.getState().budgetLimited, false);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
