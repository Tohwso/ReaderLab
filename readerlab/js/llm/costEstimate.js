// ============ ReaderLab — Estimativa/cálculo de custo de execuções LLM ============
// Módulo PURO (sem fetch/db/window) — só matemática sobre tokens/pricing,
// testável direto com `node costEstimate.test.mjs`. Nunca converte moeda
// (preços ficam na moeda nativa do catálogo, ex.: CNY) e nunca usa
// `cachedInputPerMillionTokens` enquanto ele estiver `null` no catálogo
// (preço de cache ainda não confirmado — ver modelCatalog.mjs).
//
// `pricing` aqui é sempre um SNAPSHOT (cópia congelada, ver
// buildModelPricingSnapshot) do preço do catálogo no momento da execução —
// nunca uma referência viva que mudaria retroativamente o custo de runs
// antigas se o catálogo for atualizado depois.

// Congela uma cópia independente da entrada de pricing do catálogo — usar
// isto (nunca a referência direta) ao persistir `modelPricingSnapshot` em
// requestMetadata/executionSnapshot, para que futuras atualizações do
// catálogo NUNCA alterem o custo já registrado de uma execução passada.
export function buildModelPricingSnapshot(pricing) {
  if (!pricing || typeof pricing !== "object") return null;
  return {
    currency: pricing.currency,
    inputPerMillionTokens: pricing.inputPerMillionTokens,
    cachedInputPerMillionTokens: pricing.cachedInputPerMillionTokens ?? null,
    outputPerMillionTokens: pricing.outputPerMillionTokens,
    pricingUpdatedAt: pricing.pricingUpdatedAt,
  };
}

function costForTokens(tokens, pricePerMillionTokens) {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return 0;
  if (typeof pricePerMillionTokens !== "number" || !Number.isFinite(pricePerMillionTokens)) return 0;
  return (tokens / 1_000_000) * pricePerMillionTokens;
}

// Custo estimado ANTES da execução — usa o snapshot de pricing + uma
// estimativa de tokens de entrada (conhecida, o prompt já existe) e de
// saída (chute, ver getHistoricalUsageStats/DEFAULT_EXPECTED_*_OUTPUT_TOKENS
// em config.js). Nunca usa cachedInputPerMillionTokens (não confirmado).
export function estimateCostForTokens({ pricing, estimatedInputTokens, estimatedOutputTokens }) {
  const snapshot = buildModelPricingSnapshot(pricing);
  if (!snapshot) return null;
  const inputCost = costForTokens(estimatedInputTokens, snapshot.inputPerMillionTokens);
  const outputCost = costForTokens(estimatedOutputTokens, snapshot.outputPerMillionTokens);
  return {
    currency: snapshot.currency,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

// Teto de custo teórico (pior caso) usando maxCompletionTokens como
// estimativa de saída — útil para exibir "no máximo, esta execução custa
// até X" além da estimativa "esperada".
export function estimateMaximumOutputCost({ pricing, estimatedInputTokens, maxCompletionTokens }) {
  return estimateCostForTokens({ pricing, estimatedInputTokens, estimatedOutputTokens: maxCompletionTokens });
}

// Soma o usage de MÚLTIPLAS tentativas de uma mesma execução (ReadingRun
// ou AnalysisRun) — cada tentativa que chegou ao upstream e retornou usage
// foi cobrada pelo provedor, mesmo quando a tentativa falhou depois (ex.:
// resposta vazia após gastar tokens de reasoning, ver llm/provider.js e
// engine.js/analysisEngine.js). `usageList` é uma lista de objetos
// `{ prompt_tokens, completion_tokens, total_tokens }` (uma por tentativa
// cobrada); entradas ausentes/inválidas contam como 0 em cada campo — o
// custo real de uma execução deve refletir TODAS as tentativas cobradas,
// nunca só a última (bem-sucedida ou não).
export function sumTokenUsage(usageList) {
  const list = Array.isArray(usageList) ? usageList : [];
  return list.reduce(
    (acc, u) => ({
      prompt_tokens: acc.prompt_tokens + (typeof u?.prompt_tokens === "number" ? u.prompt_tokens : 0),
      completion_tokens: acc.completion_tokens + (typeof u?.completion_tokens === "number" ? u.completion_tokens : 0),
      total_tokens: acc.total_tokens + (typeof u?.total_tokens === "number" ? u.total_tokens : 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  );
}

// Custo REAL após a execução — exige um snapshot de pricing já congelado
// (o mesmo usado na estimativa, nunca o preço "atual" do catálogo) e o
// `usage` real retornado pelo provider. Sem `usage` (provider não retornou
// tokenUsage), retorna null — nunca inventa/estima um valor no lugar do
// custo real.
export function computeActualCost({ pricingSnapshot, usage }) {
  if (!pricingSnapshot) return null;
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  if (promptTokens == null || completionTokens == null) return null;
  const inputCost = costForTokens(promptTokens, pricingSnapshot.inputPerMillionTokens);
  const outputCost = costForTokens(completionTokens, pricingSnapshot.outputPerMillionTokens);
  return {
    currency: pricingSnapshot.currency,
    promptTokens,
    completionTokens,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

// Estatísticas históricas puras — recebe `runs` já filtrada/bruta (o
// chamador no frontend passa state.runs/populationRuns/analysisRuns; aqui
// nunca se importa store.js/db.js, para continuar testável em Node).
// Cada item de `runs` deve expor (quando disponível) algo equivalente a
// { requestMetadata: { requestedModelId, purpose, actualCost: { completionTokens } } }.
// Retorna null quando não há amostras suficientes para uma média confiável.
export function getHistoricalUsageStats({ purpose, modelId, runs }) {
  const samples = (Array.isArray(runs) ? runs : [])
    .map((run) => run?.requestMetadata)
    .filter((meta) => meta && meta.purpose === purpose && meta.requestedModelId === modelId && meta.actualCost && typeof meta.actualCost.completionTokens === "number");

  const sampleCount = samples.length;
  if (sampleCount === 0) return null;

  const totalCompletionTokens = samples.reduce((sum, meta) => sum + meta.actualCost.completionTokens, 0);
  const averageCompletionTokens = totalCompletionTokens / sampleCount;

  return {
    sampleCount,
    averageCompletionTokens,
    // Poucas amostras (< 3) tornam a média pouco confiável — o chamador
    // (UI) decide como exibir este aviso, esta função só sinaliza o fato.
    fewSamples: sampleCount < 3,
  };
}
