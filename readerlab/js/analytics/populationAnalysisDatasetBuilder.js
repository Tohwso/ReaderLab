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
//
// analysisDatasetVersion: as seções que variam de forma entre v1 (legado)
// e v2 (compacto — máxima informação analítica, mínima duplicação) vivem
// em populationAnalysisDatasetFormat.js (módulo PURO, testável em Node sem
// depender do client Supabase). v1 permanece disponível (nunca removido)
// só para comparação/teste (ver populationAnalysisDatasetFormat.test.mjs)
// e para nunca invalidar o entendimento de AnalysisRuns antigas — que
// congelam seu próprio dataset em executionSnapshot e NUNCA são
// reescritas quando este builder muda.
import * as S from "../store.js";
import * as D from "../domain.js";
import { ANALYST_MAX_QUALITATIVE_ANSWER_CHARS, ANALYST_MAX_REACTION_REASON_CHARS } from "../config.js";
import { computeQuestionStats, computeReactionAggregates, filterPersonasBySegment } from "./populationMetrics.js";
import {
  formatReactionAggregatesBase,
  formatReactionAggregatesV1,
  formatReactionEntries,
  formatQualitativeAnswersV1,
  formatQualitativeQuestionsV2,
  formatIndividualResultsV1,
  formatIndividualResultsV2,
  attributeUnavailableLabel,
} from "./populationAnalysisDatasetFormat.js";

export const ANALYSIS_DATASET_VERSION = 2;
export const LEGACY_ANALYSIS_DATASET_VERSION = 1;

const MAX_ANSWER_CHARS = ANALYST_MAX_QUALITATIVE_ANSWER_CHARS; // por resposta qualitativa individual
const MAX_REASON_CHARS = ANALYST_MAX_REACTION_REASON_CHARS; // por motivo de reação relatado

// Constrói o dataset analítico de uma PopulationRun já finalizada.
// `segments`: lista opcional de { name, rules } — apenas os segmentos
// efetivamente configurados pelo usuário na aba "Segmentos" entram no
// dataset (nunca segmentos inventados/hipotéticos).
// `version`: 2 (padrão, compacto) ou 1 (legado — só para comparação/teste;
// nunca usado para gerar uma AnalysisRun nova por padrão).
export function buildPopulationAnalysisDataset(popRun, { segments = [], version = ANALYSIS_DATASET_VERSION } = {}) {
  const population = S.state.populations.find((p) => p.id === popRun.populationId);
  const survey = popRun.executionSnapshot?.survey || S.state.surveys.find((s) => s.id === popRun.surveyId);
  const snapshotPersonas = popRun.executionSnapshot?.personas || [];
  const snapshotReactions = popRun.executionSnapshot?.reactions || [];
  const runs = S.getReadingRunsForPopulationRun(popRun.id);
  const getResult = S.getResultForRun;
  const completedRuns = runs.filter((r) => r.status === "COMPLETED");
  const failedRuns = runs.filter((r) => r.status === "FAILED");

  // AttributeDefinitions desta execução: SEMPRE o snapshot congelado quando
  // existir (PopulationRuns novas) — só cai para o catálogo atual em
  // PopulationRuns anteriores à snapshotVersion 2 (ver domain.js). O
  // Research Analyst nunca deve ver nomes/descrições/grupos que mudaram
  // depois da execução.
  const { attributes: runAttributes, legacyFallback: attributeCatalogLegacyFallback } = D.resolvePopulationSnapshotAttributes(popRun, S.state.attributes);
  const attributeById = new Map(runAttributes.map((a) => [a.id, a]));

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

  // Pares (persona, result) já resolvidos para as runs concluídas — insumo
  // comum das seções que variam por versão (ver populationAnalysisDatasetFormat.js).
  const resolvedRows = completedRuns
    .map((r) => ({ runId: r.id, persona: snapshotPersonas.find((p) => p.id === r.personaId), result: getResult(r.id) }))
    .filter((row) => row.persona && row.result);

  const reactionAggregates = version === 1
    ? formatReactionAggregatesV1(reactionStats, validCount, { truncatedFields, maxReasonChars: MAX_REASON_CHARS })
    : formatReactionAggregatesBase(reactionStats, validCount);
  const reactionEntries = version === 1 ? undefined : formatReactionEntries(reactionStats, { truncatedFields, maxReasonChars: MAX_REASON_CHARS });

  const qualitativeAnswers = version === 1
    ? formatQualitativeAnswersV1(qualitativeQuestions, resolvedRows, { truncatedFields, maxAnswerChars: MAX_ANSWER_CHARS })
    : undefined;
  const qualitativeQuestionsOut = version === 1
    ? undefined
    : formatQualitativeQuestionsV2(qualitativeQuestions, resolvedRows, { truncatedFields, maxAnswerChars: MAX_ANSWER_CHARS });

  const individualResults = version === 1
    ? formatIndividualResultsV1(resolvedRows, { attributeById, quantitativeQuestionDefs: quantitativeQuestions, qualitativeQuestionDefs: qualitativeQuestions })
    : formatIndividualResultsV2(resolvedRows, { attributeById, quantitativeQuestionDefs: quantitativeQuestions });

  const segmentSummaries = segments.map((seg) => {
    const personas = filterPersonasBySegment(snapshotPersonas, seg.rules);
    const segRuns = runs.filter((r) => personas.some((p) => p.id === r.personaId));
    const qMetrics = computeQuestionStats(quantitativeQuestions, segRuns, personas, getResult).map(toQuantitativeMetric);
    const { validCount: segValid, stats: segReactionStats } = computeReactionAggregates(snapshotReactions, segRuns, personas, getResult);
    return {
      name: seg.name,
      rules: seg.rules.map((r) => ({
        attributeName: attributeById.get(r.attributeId)?.name || attributeUnavailableLabel(r.attributeId),
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

  const dataset = {
    analysisDatasetVersion: version,
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
    individualResults,
    segments: segmentSummaries,
    segmentComparisons,
    truncatedFields,
    attributeCatalogLegacyFallback, // true só para PopulationRuns anteriores à snapshotVersion 2 (ver domain.js)
  };
  if (version === 1) {
    dataset.qualitativeAnswers = qualitativeAnswers;
  } else {
    dataset.qualitativeQuestions = qualitativeQuestionsOut;
    dataset.reactionEntries = reactionEntries;
  }
  return dataset;
}
