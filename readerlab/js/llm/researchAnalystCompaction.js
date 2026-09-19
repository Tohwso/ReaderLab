// ============ ReaderLab — Compactação determinística do dataset do Analyst ============
// Módulo PURO (sem I/O, sem import de store.js/config.js): recebe o
// dataset v2 já construído (ver populationAnalysisDatasetBuilder.js) e, só
// quando o prompt final excede o orçamento (ANALYST_MAX_PROMPT_CHARS, ver
// analysisEngine.js), aplica uma sequência FIXA e determinística de
// reduções — NUNCA pede à LLM para resumir o dataset, NUNCA usa
// Math.random. Cada FASE é aplicada apenas se a fase anterior não foi
// suficiente para caber no orçamento (medido via `measureUserPromptChars`,
// injetado pelo chamador — normalmente `buildResearchAnalystPrompt`).
//
// Fases (nunca remove quantitativeMetrics/reactionAggregates/segments —
// ver seção 7 da tarefa; nunca referências necessárias à evidence
// validation, ver llm/researchAnalystValidate.js):
//   1) remove campos redundantes (derivados de outros já presentes);
//   2) limita reaction reasons por reactionCode — ADAPTATIVO: tenta níveis
//      progressivamente mais agressivos (ex.: 20 -> 10 -> 5 -> 3) até caber
//      ou esgotar os níveis (reactionAggregates continuam com os totais
//      agregados intactos, só a lista detalhada de reactionEntries encolhe);
//   3) limita quantidade de qualitative answers por pergunta — mesma
//      estratégia adaptativa (qualitativeQuestions continua listando TODAS
//      as perguntas, só o array `answers` de cada uma encolhe);
//   4) trunca (com marcador explícito) respostas qualitativas e reaction
//      reasons que ainda estejam longos — também adaptativo (níveis de
//      tamanho de caractere progressivamente menores);
//   5) remove metadata não-analítica (bookkeeping, não dado do experimento).
//
// Amostragem determinística (nunca aleatória, nunca só os primeiros N
// personaCodes — ver seção 6 da tarefa):
//   - qualitative answers: ordenadas por personaCode (ordem lexicográfica
//     estável), depois selecionadas em posições aproximadamente uniformes
//     ao longo da lista (ver `evenlySpacedIndices`) — espalha a amostra por
//     toda a população em vez de enviesar para R0001...R00NN.
//   - reaction reasons: ordenadas por intensity (com personaCode como
//     desempate), depois as mesmas posições uniformes são selecionadas —
//     preserva exemplos de intensidade baixa/média/alta em vez de só um
//     extremo, mantendo a saída final ordenada por personaCode para
//     legibilidade.

function byPersonaCode(a, b) {
  return String(a.personaCode || "").localeCompare(String(b.personaCode || ""));
}

function countQualitativeAnswers(dataset) {
  return (dataset.qualitativeQuestions || []).reduce((sum, q) => sum + (q.answers || []).length, 0);
}

function countReactionEntries(dataset) {
  return (dataset.reactionEntries || []).length;
}

// Seleciona até `k` posições aproximadamente uniformes ao longo de `n`
// itens, SEMPRE incluindo os dois extremos quando k >= 2 (nunca Math.random,
// nunca só os primeiros). Ex.: n=100, k=10 -> índices 0, 11, 22, ..., 99.
// Quando k >= n, todos os índices são retornados (nada a reduzir).
export function evenlySpacedIndices(n, k) {
  if (n <= 0 || k <= 0) return [];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  if (k === 1) return [Math.floor((n - 1) / 2)];
  const step = (n - 1) / (k - 1);
  const indices = [];
  for (let i = 0; i < k; i++) indices.push(Math.round(i * step));
  return [...new Set(indices)];
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
// lista plana e detalhada de reactionEntries é limitada por código, com
// amostragem espalhada por intensidade (ver cabeçalho do módulo). Registra
// em `reactionEntriesSampling` quantos exemplos existiam originalmente e
// quantos foram incluídos, por reactionCode (seção 9 da tarefa).
export function limitReactionReasonsPerCode(dataset, maxPerCode) {
  const entries = dataset.reactionEntries || [];
  const byCode = new Map();
  entries.forEach((e) => {
    if (!byCode.has(e.reactionCode)) byCode.set(e.reactionCode, []);
    byCode.get(e.reactionCode).push(e);
  });
  const kept = [];
  const reactionEntriesSampling = [];
  [...byCode.keys()].sort().forEach((code) => {
    const group = byCode.get(code);
    const sortedByIntensity = [...group].sort((a, b) => (a.intensity - b.intensity) || byPersonaCode(a, b));
    const idxs = evenlySpacedIndices(sortedByIntensity.length, maxPerCode);
    const selected = idxs.map((i) => sortedByIntensity[i]).sort(byPersonaCode);
    kept.push(...selected);
    reactionEntriesSampling.push({ reactionCode: code, originalCount: group.length, includedCount: selected.length });
  });
  return { ...dataset, reactionEntries: kept, reactionEntriesSampling };
}

// 3) Quantidade de respostas qualitativas por pergunta — qualitativeQuestions
// continua listando todas as perguntas, só o array `answers` é limitado
// (amostragem espalhada por personaCode, ver cabeçalho do módulo). Registra
// quantas respostas existiam originalmente e quantas foram incluídas por
// pergunta (seção 8 da tarefa).
export function limitQualitativeAnswersPerQuestion(dataset, maxPerQuestion) {
  const qualitativeQuestions = (dataset.qualitativeQuestions || []).map((q) => {
    const sorted = [...(q.answers || [])].sort(byPersonaCode);
    const idxs = evenlySpacedIndices(sorted.length, maxPerQuestion);
    const answers = idxs.map((i) => sorted[i]);
    return { ...q, answers, answersOriginalCount: sorted.length, answersIncludedCount: answers.length };
  });
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

// Diagnóstico determinístico de tamanho (seção 10 da tarefa): quantos
// caracteres (JSON.stringify) cada seção do dataset ocupa aproximadamente.
// Usado por analysisEngine.js para persistir datasetSectionCharsBefore/
// datasetSectionCharsAfter em AnalysisRun.requestMetadata, permitindo
// identificar futuras explosões de tamanho por seção.
export function measureDatasetSectionChars(dataset) {
  const d = dataset || {};
  const sectionChars = (key) => (d[key] !== undefined ? JSON.stringify(d[key]).length : 0);
  return {
    population: sectionChars("population"),
    quantitativeMetrics: sectionChars("quantitativeMetrics"),
    reactionAggregates: sectionChars("reactionAggregates"),
    individualResults: sectionChars("individualResults"),
    qualitativeQuestions: sectionChars("qualitativeQuestions"),
    reactionEntries: sectionChars("reactionEntries"),
    segments: sectionChars("segments"),
  };
}

// Níveis adicionais de degradação (seção 5 da tarefa) — sempre ANEXADOS ao
// limite configurado (config.js), nunca substituindo-o: o nível 1 de cada
// sequência é sempre o valor configurável pelo operador, os seguintes são
// degradações fixas e determinísticas.
const REACTION_REASONS_PER_CODE_EXTRA_LEVELS = [10, 5, 3];
const QUALITATIVE_ANSWERS_PER_QUESTION_EXTRA_LEVELS = [10, 5, 3];
const QUALITATIVE_ANSWER_CHARS_EXTRA_LEVELS = [400, 250, 160];
const REACTION_REASON_CHARS_EXTRA_LEVELS = [200, 140, 100];

// Monta uma sequência estritamente decrescente de níveis de corte,
// começando pelo limite configurado e degradando pelos níveis fixos acima
// — um nível só entra na sequência se for de fato mais restritivo que o
// anterior (permite overrides de operador sem produzir uma sequência
// inconsistente, ex.: base já menor que um nível "fixo").
function degradationLevels(base, extraLevels) {
  const out = [];
  [base, ...extraLevels].forEach((lv) => {
    if (out.length === 0 || lv < out[out.length - 1]) out.push(lv);
  });
  return out;
}

// Orquestra as 5 fases, parando assim que `measureUserPromptChars` indicar
// que o prompt já cabe no orçamento. Fases 2-4 são adaptativas: tentam
// cada nível da sequência de degradação até caber ou esgotar os níveis
// (nunca aplicam um nível mais agressivo do que o necessário).
// `measureUserPromptChars(dataset)` é injetado pelo chamador
// (analysisEngine.js) para não acoplar este módulo puro a
// researchAnalystPromptBuilder.js.
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
  let finalReactionReasonsPerCodeLimit = null;
  let finalQualitativeAnswersPerQuestionLimit = null;
  let finalQualitativeAnswerCharsLimit = null;
  let finalReactionReasonCharsLimit = null;

  const fits = () => measureUserPromptChars(current) <= limits.maxPromptChars;

  if (!fits()) {
    current = removeRedundantFields(current);
    compactionApplied = true;
    stepsApplied.push("remove_redundant_fields");
  }

  if (!fits()) {
    compactionApplied = true;
    stepsApplied.push("limit_reaction_reasons_per_code");
    for (const level of degradationLevels(limits.maxReactionReasonsPerCode, REACTION_REASONS_PER_CODE_EXTRA_LEVELS)) {
      current = limitReactionReasonsPerCode(current, level);
      finalReactionReasonsPerCodeLimit = level;
      if (fits()) break;
    }
    reactionReasonsIncluded = countReactionEntries(current);
  }

  if (!fits()) {
    compactionApplied = true;
    stepsApplied.push("limit_qualitative_answers_per_question");
    for (const level of degradationLevels(limits.maxQualitativeAnswersPerQuestion, QUALITATIVE_ANSWERS_PER_QUESTION_EXTRA_LEVELS)) {
      current = limitQualitativeAnswersPerQuestion(current, level);
      finalQualitativeAnswersPerQuestionLimit = level;
      if (fits()) break;
    }
    qualitativeAnswersIncluded = countQualitativeAnswers(current);
  }

  if (!fits()) {
    compactionApplied = true;
    stepsApplied.push("truncate_long_texts");
    const answerLevels = degradationLevels(limits.maxQualitativeAnswerChars, QUALITATIVE_ANSWER_CHARS_EXTRA_LEVELS);
    const reasonLevels = degradationLevels(limits.maxReactionReasonChars, REACTION_REASON_CHARS_EXTRA_LEVELS);
    const stepCount = Math.max(answerLevels.length, reasonLevels.length);
    for (let i = 0; i < stepCount; i++) {
      const maxAnswerChars = answerLevels[Math.min(i, answerLevels.length - 1)];
      const maxReasonChars = reasonLevels[Math.min(i, reasonLevels.length - 1)];
      const res = truncateLongTexts(current, { maxAnswerChars, maxReasonChars });
      current = res.dataset;
      truncatedAnswerCount = res.truncatedAnswerCount;
      truncatedReasonCount = res.truncatedReasonCount;
      finalQualitativeAnswerCharsLimit = maxAnswerChars;
      finalReactionReasonCharsLimit = maxReasonChars;
      if (fits()) break;
    }
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
      finalReactionReasonsPerCodeLimit,
      finalQualitativeAnswersPerQuestionLimit,
      finalQualitativeAnswerCharsLimit,
      finalReactionReasonCharsLimit,
    },
  };
}

