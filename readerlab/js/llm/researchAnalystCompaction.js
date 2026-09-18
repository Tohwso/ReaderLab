// ============ ReaderLab — Compactação determinística do dataset do Analyst ============
// Módulo PURO (sem I/O, sem import de store.js/config.js): recebe o
// dataset v2 já construído (ver populationAnalysisDatasetBuilder.js) e, só
// quando o prompt final excede o orçamento (ANALYST_MAX_PROMPT_CHARS, ver
// analysisEngine.js), aplica uma sequência FIXA e determinística de
// reduções — NUNCA pede à LLM para resumir o dataset, NUNCA usa
// Math.random. Cada passo é aplicado apenas se o passo anterior não foi
// suficiente para caber no orçamento (medido via `measureUserPromptChars`,
// injetado pelo chamador — normalmente `buildResearchAnalystPrompt`).
//
// Ordem de redução (nunca remove quantitativeMetrics/N/divergence/
// reactionAggregates/segments/IDs necessários à evidence validation — ver
// llm/researchAnalystValidate.js):
//   1) remove campos redundantes (derivados de outros já presentes);
//   2) limita reaction reasons por reactionCode (reactionAggregates
//      continuam com os totais agregados intactos);
//   3) limita quantidade de qualitative answers por pergunta;
//   4) trunca (com marcador explícito) respostas qualitativas e reaction
//      reasons que ainda estejam longos;
//   5) remove metadata não-analítica (bookkeeping, não dado do experimento).
//
// Seleção determinística (nunca aleatória): sempre as primeiras N entradas
// ordenadas por personaCode (ordem lexicográfica estável).

function byPersonaCode(a, b) {
  return String(a.personaCode || "").localeCompare(String(b.personaCode || ""));
}

function countQualitativeAnswers(dataset) {
  return (dataset.qualitativeQuestions || []).reduce((sum, q) => sum + (q.answers || []).length, 0);
}

function countReactionEntries(dataset) {
  return (dataset.reactionEntries || []).length;
}

// 1) Campos redundantes: inteiramente derivados de dados que permanecem no
// dataset (segmentComparisons é só a combinação par-a-par de segments[],
// já presentes) — remover não perde nenhuma métrica, só uma conveniência.
export function removeRedundantFields(dataset) {
  const { segmentComparisons, ...rest } = dataset;
  return rest;
}

// 2) Reaction reasons por reactionCode — reactionAggregates (contagens,
// percentuais, média/min/máx de intensidade) NUNCA são tocados aqui; só a
// lista plana e detalhada de reactionEntries é limitada por código.
export function limitReactionReasonsPerCode(dataset, maxPerCode) {
  const entries = dataset.reactionEntries || [];
  const byCode = new Map();
  entries.forEach((e) => {
    if (!byCode.has(e.reactionCode)) byCode.set(e.reactionCode, []);
    byCode.get(e.reactionCode).push(e);
  });
  const kept = [];
  [...byCode.keys()].sort().forEach((code) => {
    const sorted = [...byCode.get(code)].sort(byPersonaCode);
    kept.push(...sorted.slice(0, maxPerCode));
  });
  return { ...dataset, reactionEntries: kept };
}

// 3) Quantidade de respostas qualitativas por pergunta — qualitativeQuestions
// continua listando todas as perguntas, só o array `answers` é limitado.
export function limitQualitativeAnswersPerQuestion(dataset, maxPerQuestion) {
  const qualitativeQuestions = (dataset.qualitativeQuestions || []).map((q) => ({
    ...q,
    answers: [...(q.answers || [])].sort(byPersonaCode).slice(0, maxPerQuestion),
  }));
  return { ...dataset, qualitativeQuestions };
}

// 4) Truncamento explícito (nunca silencioso) do que ainda estiver longo.
const TRUNCATION_MARKER = "...[truncated]";
function truncateWithMarker(str, max) {
  if (typeof str !== "string" || str.length <= max) return { value: str, truncated: false };
  return { value: str.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER, truncated: true };
}

export function truncateLongTexts(dataset, { maxAnswerChars, maxReasonChars }) {
  let truncatedAnswerCount = 0;
  let truncatedReasonCount = 0;
  const qualitativeQuestions = (dataset.qualitativeQuestions || []).map((q) => ({
    ...q,
    answers: (q.answers || []).map((a) => {
      const { value, truncated } = truncateWithMarker(a.value, maxAnswerChars);
      if (!truncated) return a;
      truncatedAnswerCount++;
      return { ...a, value };
    }),
  }));
  const reactionEntries = (dataset.reactionEntries || []).map((e) => {
    const { value, truncated } = truncateWithMarker(e.reason, maxReasonChars);
    if (!truncated) return e;
    truncatedReasonCount++;
    return { ...e, reason: value };
  });
  return { dataset: { ...dataset, qualitativeQuestions, reactionEntries }, truncatedAnswerCount, truncatedReasonCount };
}

// 5) Metadata não-analítica: bookkeeping sobre a execução (provider/model
// usados, quais campos já haviam sido truncados na construção do dataset)
// — nunca dado do experimento em si, nunca referenciado por evidence.
export function removeNonAnalyticMetadata(dataset) {
  const { truncatedFields, attributeCatalogLegacyFallback, ...rest } = dataset;
  const populationRun = { ...rest.populationRun };
  delete populationRun.provider;
  delete populationRun.model;
  delete populationRun.promptVersion;
  return { ...rest, populationRun };
}

// Orquestra os 5 passos, parando assim que `measureUserPromptChars` indicar
// que o prompt já cabe no orçamento. `measureUserPromptChars(dataset)` é
// injetado pelo chamador (analysisEngine.js) para não acoplar este módulo
// puro a researchAnalystPromptBuilder.js.
export function compactAnalysisDatasetForBudget(dataset, limits, measureUserPromptChars) {
  const qualitativeAnswersOriginal = countQualitativeAnswers(dataset);
  const reactionReasonsOriginal = countReactionEntries(dataset);

  let current = dataset;
  let compactionApplied = false;
  const stepsApplied = [];
  let qualitativeAnswersIncluded = qualitativeAnswersOriginal;
  let reactionReasonsIncluded = reactionReasonsOriginal;
  let truncatedAnswerCount = 0;
  let truncatedReasonCount = 0;

  const fits = () => measureUserPromptChars(current) <= limits.maxPromptChars;

  if (!fits()) {
    current = removeRedundantFields(current);
    compactionApplied = true;
    stepsApplied.push("remove_redundant_fields");
  }

  if (!fits()) {
    current = limitReactionReasonsPerCode(current, limits.maxReactionReasonsPerCode);
    reactionReasonsIncluded = countReactionEntries(current);
    compactionApplied = true;
    stepsApplied.push("limit_reaction_reasons_per_code");
  }

  if (!fits()) {
    current = limitQualitativeAnswersPerQuestion(current, limits.maxQualitativeAnswersPerQuestion);
    qualitativeAnswersIncluded = countQualitativeAnswers(current);
    compactionApplied = true;
    stepsApplied.push("limit_qualitative_answers_per_question");
  }

  if (!fits()) {
    const res = truncateLongTexts(current, { maxAnswerChars: limits.maxQualitativeAnswerChars, maxReasonChars: limits.maxReactionReasonChars });
    current = res.dataset;
    truncatedAnswerCount = res.truncatedAnswerCount;
    truncatedReasonCount = res.truncatedReasonCount;
    compactionApplied = true;
    stepsApplied.push("truncate_long_texts");
  }

  if (!fits()) {
    current = removeNonAnalyticMetadata(current);
    compactionApplied = true;
    stepsApplied.push("remove_non_analytic_metadata");
  }

  return {
    dataset: current,
    compactionApplied,
    stepsApplied,
    fits: fits(),
    stats: {
      qualitativeAnswersOriginal,
      qualitativeAnswersIncluded,
      truncatedAnswerCount,
      reactionReasonsOriginal,
      reactionReasonsIncluded,
      truncatedReasonCount,
    },
  };
}
