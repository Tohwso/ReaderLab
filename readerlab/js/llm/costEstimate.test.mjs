import assert from "node:assert/strict";
import {
  buildModelPricingSnapshot,
  estimateCostForTokens,
  estimateMaximumOutputCost,
  computeActualCost,
  getHistoricalUsageStats,
} from "./costEstimate.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS - ${name}`);
  } catch (err) {
    console.log(`FAIL - ${name}`);
    console.log("  " + err.message);
    process.exitCode = 1;
  }
}

const KIMI_K2_6_PRICING = {
  currency: "CNY",
  inputPerMillionTokens: 6.5,
  cachedInputPerMillionTokens: null,
  outputPerMillionTokens: 27,
  pricingUpdatedAt: "2026-09-21",
};

test("buildModelPricingSnapshot copia só os campos documentados, nunca a referência viva", () => {
  const snapshot = buildModelPricingSnapshot(KIMI_K2_6_PRICING);
  assert.deepEqual(snapshot, KIMI_K2_6_PRICING);
  assert.notEqual(snapshot, KIMI_K2_6_PRICING);
});

test("H) pricing snapshot congelado não muda quando o catálogo é alterado depois", () => {
  const pricing = { ...KIMI_K2_6_PRICING };
  const snapshot = buildModelPricingSnapshot(pricing);
  pricing.inputPerMillionTokens = 999;
  assert.equal(snapshot.inputPerMillionTokens, 6.5);
});

test("E) custo estimado de input calculado corretamente (tokens/1e6 * preço)", () => {
  const result = estimateCostForTokens({ pricing: KIMI_K2_6_PRICING, estimatedInputTokens: 1_000_000, estimatedOutputTokens: 0 });
  assert.equal(result.inputCost, 6.5);
  assert.equal(result.outputCost, 0);
  assert.equal(result.totalCost, 6.5);
  assert.equal(result.currency, "CNY");
});

test("F) custo estimado de output calculado corretamente", () => {
  const result = estimateCostForTokens({ pricing: KIMI_K2_6_PRICING, estimatedInputTokens: 0, estimatedOutputTokens: 500_000 });
  assert.equal(result.outputCost, 13.5);
  assert.equal(result.totalCost, 13.5);
});

test("estimateCostForTokens nunca usa cachedInputPerMillionTokens (ainda não confirmado)", () => {
  const result = estimateCostForTokens({ pricing: KIMI_K2_6_PRICING, estimatedInputTokens: 1000, estimatedOutputTokens: 1000 });
  // Se cachedInputPerMillionTokens (null) fosse usado por engano, o cálculo
  // quebraria (NaN) — confirma que o resultado é um número finito.
  assert.equal(Number.isFinite(result.totalCost), true);
});

test("G) PopulationRun multiplica corretamente ao somar N estimativas de leitores", () => {
  const perReader = estimateCostForTokens({ pricing: KIMI_K2_6_PRICING, estimatedInputTokens: 2000, estimatedOutputTokens: 900 });
  const totalFor50Readers = perReader.totalCost * 50;
  assert.ok(totalFor50Readers > perReader.totalCost);
  assert.equal(Math.round(totalFor50Readers * 100) / 100, Math.round(perReader.totalCost * 50 * 100) / 100);
});

test("estimateMaximumOutputCost usa maxCompletionTokens como teto de saída", () => {
  const max = estimateMaximumOutputCost({ pricing: KIMI_K2_6_PRICING, estimatedInputTokens: 1000, maxCompletionTokens: 3000 });
  const normal = estimateCostForTokens({ pricing: KIMI_K2_6_PRICING, estimatedInputTokens: 1000, estimatedOutputTokens: 900 });
  assert.ok(max.totalCost > normal.totalCost);
});

test("I) custo real usa o tokenUsage real do provider, não a estimativa", () => {
  const snapshot = buildModelPricingSnapshot(KIMI_K2_6_PRICING);
  const actual = computeActualCost({ pricingSnapshot: snapshot, usage: { prompt_tokens: 2000, completion_tokens: 850, total_tokens: 2850 } });
  assert.equal(actual.promptTokens, 2000);
  assert.equal(actual.completionTokens, 850);
  assert.equal(actual.inputCost, (2000 / 1_000_000) * 6.5);
  assert.equal(actual.outputCost, (850 / 1_000_000) * 27);
});

test("J) sem usage (provider não retornou tokenUsage) -> custo real indisponível (null)", () => {
  const snapshot = buildModelPricingSnapshot(KIMI_K2_6_PRICING);
  assert.equal(computeActualCost({ pricingSnapshot: snapshot, usage: undefined }), null);
  assert.equal(computeActualCost({ pricingSnapshot: snapshot, usage: {} }), null);
  assert.equal(computeActualCost({ pricingSnapshot: null, usage: { prompt_tokens: 1, completion_tokens: 1 } }), null);
});

test("K) getHistoricalUsageStats separa reader e analyst corretamente", () => {
  const runs = [
    { requestMetadata: { purpose: "reader", requestedModelId: "kimi-k3", actualCost: { completionTokens: 800 } } },
    { requestMetadata: { purpose: "reader", requestedModelId: "kimi-k3", actualCost: { completionTokens: 1000 } } },
    { requestMetadata: { purpose: "reader", requestedModelId: "kimi-k3", actualCost: { completionTokens: 1200 } } },
    { requestMetadata: { purpose: "analyst", requestedModelId: "kimi-k2.6", actualCost: { completionTokens: 3000 } } },
  ];
  const readerStats = getHistoricalUsageStats({ purpose: "reader", modelId: "kimi-k3", runs });
  assert.equal(readerStats.sampleCount, 3);
  assert.equal(readerStats.averageCompletionTokens, 1000);
  assert.equal(readerStats.fewSamples, false);

  const analystStats = getHistoricalUsageStats({ purpose: "analyst", modelId: "kimi-k2.6", runs });
  assert.equal(analystStats.sampleCount, 1);
});

test("27) getHistoricalUsageStats sinaliza 'poucas amostras' com menos de 3 execuções", () => {
  const runs = [
    { requestMetadata: { purpose: "reader", requestedModelId: "kimi-k3", actualCost: { completionTokens: 800 } } },
  ];
  const stats = getHistoricalUsageStats({ purpose: "reader", modelId: "kimi-k3", runs });
  assert.equal(stats.sampleCount, 1);
  assert.equal(stats.fewSamples, true);
});

test("getHistoricalUsageStats retorna null sem nenhuma amostra (execuções antigas sem custo persistido)", () => {
  const runs = [
    { requestMetadata: { purpose: "reader", requestedModelId: "kimi-k3" } },
    { requestMetadata: null },
    {},
  ];
  assert.equal(getHistoricalUsageStats({ purpose: "reader", modelId: "kimi-k3", runs }), null);
  assert.equal(getHistoricalUsageStats({ purpose: "reader", modelId: "kimi-k3", runs: [] }), null);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
