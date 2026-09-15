// ============ ReaderLab — Dataset determinístico para o Research Analyst ============
// Módulo responsável por transformar os resultados JÁ PRODUZIDOS por uma
// PopulationRun (ReadingRuns/ReadingResults) num dataset agregado e
// determinístico — NENHUM número aqui é decidido pela LLM. Reutiliza as
// MESMAS fórmulas do hub de resultados (js/analytics/populationMetrics.js
// e js/analytics/statistics.js) — nunca reimplementa estatística em
// paralelo. O dataset NUNCA inclui o texto/manuscrito lido (inputText) nem
// qualquer segredo — apenas agregados, respostas qualitativas (com
// truncamento defensivo) e metadados de identificação (código/nome da
// Persona).
import * as S from "./store.js";
import { computeQuestionStats, computeReactionAggregates, filterPersonasBySegment } from "./populationMetrics.js";

export const ANALYSIS_DATASET_VERSION = 1;

const MAX_ANSWER_CHARS = 600; // por resposta qualitativa individual
const MAX_REASON_CHARS = 300; // por motivo de reação relatado

function truncate(str, max, truncatedKeys, key) {
  if (typeof str !== "string" || str.length <= max) return str;
  truncatedKeys.push(key);
  return str.slice(0, max) + "…";
}

// Constrói o dataset analítico de uma PopulationRun já finalizada.
// `segments`: lista opcional de { name, rules } — apenas os segmentos
// efetivamente configurados pelo usuário na aba "Segmentos" entram no
// dataset (nunca segmentos inventados/hipotéticos).
export function buildPopulationAnalysisDataset(popRun, { segments = [] } = {}) {
  const population = S.state.populations.find((p) => p.id === popRun.populationId);
  const survey = popRun.executionSnapshot?.survey || S.state.surveys.find((s) => s.id === popRun.surveyId);
  const snapshotPersonas = popRun.executionSnapshot?.personas || [];
  const snapshotReactions = popRun.executionSnapshot?.reactions || [];
  const runs = S.getReadingRunsForPopulationRun(popRun.id);
  const getResult = S.getResultForRun;
  const completedRuns = runs.filter((r) => r.status === "COMPLETED");
  const failedRuns = runs.filter((r) => r.status === "FAILED");

  const truncatedFields = [];

  const quantitativeQuestions = (survey?.questions || []).filter((q) => q.type === "scale" || q.type === "number");
  const qualitativeQuestions = (survey?.questions || []).filter((q) => q.type !== "scale" && q.type !== "number");

  const toQuantitativeMetric = ({ question, stats }) => ({
    questionId: question.id,
    questionText: question.text,
    min: question.min ?? 0,
    max: question.max ?? 100,
    n: stats.n,
    mean: stats.n ? Math.round(stats.mean * 100) / 100 : null,
    median: stats.n ? stats.median : null,
    minimum: stats.min,
    maximum: stats.max,
    standardDeviation: stats.n ? Math.round(stats.standardDeviation * 100) / 100 : null,
    divergence: stats.divergence != null ? Math.round(stats.divergence * 1000) / 1000 : null,
    divergenceClassification: stats.classification?.label ?? null,
  });

  const quantitativeMetrics = computeQuestionStats(quantitativeQuestions, runs, snapshotPersonas, getResult).map(toQuantitativeMetric);

  const { validCount, stats: reactionStats } = computeReactionAggregates(snapshotReactions, runs, snapshotPersonas, getResult);
  const reactionAggregates = reactionStats.map((s) => ({
    reactionCode: s.def.code,
    reactionName: s.def.name,
    polarity: s.def.polarity,
    readerCount: s.count,
    validReaderCount: validCount,
    percentage: s.pct,
    meanIntensity: s.avg,
    minimumIntensity: s.min,
    maximumIntensity: s.max,
    entries: s.matches.map(({ run, rr, persona }) => ({
      personaCode: persona?.code || null,
      personaName: persona?.name || "(persona removida)",
      intensity: rr.intensity,
      reason: truncate(rr.reason || "", MAX_REASON_CHARS, truncatedFields, `reaction:${s.def.code}:${run.id}`),
    })),
  }));

  const qualitativeAnswers = qualitativeQuestions.map((q) => ({
    questionId: q.id,
    questionText: q.text,
    answers: completedRuns.map((r) => {
      const result = getResult(r.id);
      const ans = result?.surveyAnswers.find((a) => a.questionId === q.id);
      if (!ans || ans.value == null || ans.value === "") return null;
      const persona = snapshotPersonas.find((p) => p.id === r.personaId);
      const raw = Array.isArray(ans.value) ? ans.value.join(", ") : String(ans.value);
      return {
        personaCode: persona?.code || null,
        personaName: persona?.name || "(persona removida)",
        answer: truncate(raw, MAX_ANSWER_CHARS, truncatedFields, `qualitative:${q.id}:${r.id}`),
      };
    }).filter(Boolean),
  }));

  const individualResults = completedRuns.map((r) => {
    const persona = snapshotPersonas.find((p) => p.id === r.personaId);
    const result = getResult(r.id);
    if (!persona || !result) return null;
    const attributes = {};
    Object.keys(persona.attributeValues || {}).forEach((attrId) => {
      const attr = S.state.attributes.find((a) => a.id === attrId);
      if (attr) attributes[attr.name] = persona.attributeValues[attrId];
    });
    return {
      personaCode: persona.code || null,
      personaName: persona.name,
      attributes,
      quantitativeAnswers: quantitativeQuestions.map((q) => ({
        questionText: q.text,
        value: result.surveyAnswers.find((a) => a.questionId === q.id)?.value ?? null,
      })).filter((x) => x.value != null),
      reactions: result.reactions.map((rr) => ({ reactionCode: rr.reactionCode, intensity: rr.intensity })),
      qualitativeAnswers: qualitativeQuestions.map((q) => ({
        questionText: q.text,
        answer: result.surveyAnswers.find((a) => a.questionId === q.id)?.value ?? null,
      })).filter((x) => x.answer != null && x.answer !== ""),
      readerState: result.readerState || null,
    };
  }).filter(Boolean);

  const segmentSummaries = segments.map((seg) => {
    const personas = filterPersonasBySegment(snapshotPersonas, seg.rules);
    const segRuns = runs.filter((r) => personas.some((p) => p.id === r.personaId));
    const qMetrics = computeQuestionStats(quantitativeQuestions, segRuns, personas, getResult).map(toQuantitativeMetric);
    const { validCount: segValid, stats: segReactionStats } = computeReactionAggregates(snapshotReactions, segRuns, personas, getResult);
    return {
      name: seg.name,
      rules: seg.rules.map((r) => ({
        attributeName: S.state.attributes.find((a) => a.id === r.attributeId)?.name || r.attributeId,
        op: r.op,
        value: Number(r.value),
      })),
      n: personas.length,
      quantitativeMetrics: qMetrics,
      reactionAggregates: segReactionStats.map((s) => ({
        reactionCode: s.def.code, reactionName: s.def.name,
        readerCount: s.count, validReaderCount: segValid, percentage: s.pct, meanIntensity: s.avg,
      })),
    };
  });

  // Comparações par-a-par entre os segmentos configurados — só números já
  // calculados acima; a LLM nunca precisa (nem deve) recalcular nada disto.
  const segmentComparisons = [];
  for (let i = 0; i < segmentSummaries.length; i++) {
    for (let j = i + 1; j < segmentSummaries.length; j++) {
      const a = segmentSummaries[i], b = segmentSummaries[j];
      segmentComparisons.push({
        segmentA: a.name, nA: a.n,
        segmentB: b.name, nB: b.n,
        metrics: a.quantitativeMetrics.map((qa) => {
          const qb = b.quantitativeMetrics.find((x) => x.questionId === qa.questionId);
          return {
            questionText: qa.questionText,
            meanA: qa.mean, meanB: qb?.mean ?? null,
            divergenceA: qa.divergence, divergenceB: qb?.divergence ?? null,
          };
        }),
      });
    }
  }

  return {
    analysisDatasetVersion: ANALYSIS_DATASET_VERSION,
    populationRun: {
      id: popRun.id,
      title: popRun.title || null,
      sampleSize: snapshotPersonas.length,
      completed: completedRuns.length,
      failed: failedRuns.length,
      surveyName: survey?.name || null,
      provider: popRun.provider,
      model: popRun.model,
      promptVersion: popRun.promptVersion,
    },
    population: {
      name: population?.name || null,
      personas: snapshotPersonas.map((p) => ({ code: p.code || null, name: p.name })),
    },
    quantitativeMetrics,
    reactionAggregates,
    qualitativeAnswers,
    individualResults,
    segments: segmentSummaries,
    segmentComparisons,
    truncatedFields,
  };
}
