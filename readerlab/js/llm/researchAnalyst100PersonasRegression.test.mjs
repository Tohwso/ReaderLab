// ============ ReaderLab — Teste de regressão: 100 Personas cabem em 1 chamada ============
// Sem infraestrutura de testes no projeto — roda direto com
// `node js/llm/researchAnalyst100PersonasRegression.test.mjs`. Reproduz,
// com dados 100% sintéticos e SOMENTE módulos puros (nunca store.js/db.js,
// que dependem do client Supabase — ver comentário no topo de db.js), a
// pipeline completa usada em produção para uma PopulationRun de ~100
// Personas: formatação v2 -> compactação adaptativa (compactAnalysisDatasetForBudget)
// -> construção do prompt (buildResearchAnalystPrompt).
//
// Objetivo (tarefa "corrigir definitivamente o problema de tamanho do
// prompt do Research Analyst"): confirmar que o userPrompt final cabe em
// ANALYST_MAX_PROMPT_CHARS (150000, valor de produção — NUNCA aumentado
// aqui) SEM: (a) aumentar o limite da Edge Function, (b) dividir o
// Research Analyst em múltiplas chamadas, (c) usar outra LLM para resumir
// o dataset — só compactação determinística. E que os agregados
// (quantitativeMetrics/reactionAggregates/segments) e a validação de
// evidence permanecem 100% íntegros após a compactação.
import assert from "node:assert/strict";
import { computeQuestionStats, computeReactionAggregates, filterPersonasBySegment } from "../analytics/populationMetrics.js";
import {
  formatReactionAggregatesBase,
  formatReactionEntries,
  formatQualitativeQuestionsV2,
  formatIndividualResultsV2,
} from "../analytics/populationAnalysisDatasetFormat.js";
import { compactAnalysisDatasetForBudget } from "./researchAnalystCompaction.js";
import { buildResearchAnalystPrompt } from "./researchAnalystPromptBuilder.js";
import { validateResearchAnalysis } from "./researchAnalystValidate.js";
import {
  ANALYST_MAX_PROMPT_CHARS,
  ANALYST_MAX_QUALITATIVE_ANSWERS_PER_QUESTION,
  ANALYST_MAX_QUALITATIVE_ANSWER_CHARS,
  ANALYST_MAX_REACTION_REASON_CHARS,
  ANALYST_MAX_REACTION_REASONS_PER_CODE,
} from "../config.js";

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

// ------------------------------------------------------------ fixture: ~100 Personas
const N_PERSONAS = 100;
const N_QUANTITATIVE = 10;
const N_QUALITATIVE = 9;
const N_REACTIONS = 15;

const quantitativeQuestions = Array.from({ length: N_QUANTITATIVE }, (_, i) => ({
  id: `qq${i + 1}`, type: "scale", text: `Pergunta quantitativa ${i + 1} sobre a leitura?`, min: 0, max: 100,
}));
const qualitativeQuestions = Array.from({ length: N_QUALITATIVE }, (_, i) => ({
  id: `ql${i + 1}`, type: "long_text", text: `Pergunta qualitativa ${i + 1}: o que você achou?`,
}));
const reactionDefs = Array.from({ length: N_REACTIONS }, (_, i) => ({
  code: `REACTION_${i + 1}`, name: `Reação ${i + 1}`, polarity: i % 2 === 0 ? "positive" : "negative", intensityEnabled: true,
}));

const personas = Array.from({ length: N_PERSONAS }, (_, i) => ({
  id: `p${i + 1}`,
  code: `R${String(i + 1).padStart(4, "0")}`,
  name: `Leitor(a) ${i + 1}`,
  attributeValues: {},
}));
const runs = personas.map((p, i) => ({ id: `run${i + 1}`, personaId: p.id, status: "COMPLETED" }));

const LONG_TEXT = "Este trecho da leitura me fez refletir bastante sobre as escolhas dos personagens e o ritmo da narrativa. ";

const resultsByRunId = new Map(runs.map((r, i) => {
  const surveyAnswers = [
    ...quantitativeQuestions.map((q, qi) => ({ questionId: q.id, value: (i * 7 + qi * 3) % 101 })),
    ...qualitativeQuestions.map((q) => ({ questionId: q.id, value: LONG_TEXT.repeat(3) + `(persona ${i + 1})` })),
  ];
  // Cada persona reage a várias reactionDefs, com intensidade variando por
  // persona (garante variedade baixa/média/alta para a amostragem espalhada).
  const reactions = reactionDefs
    .filter((_, ri) => (i + ri) % 3 !== 0)
    .map((def, ri) => ({
      reactionCode: def.code,
      intensity: (i * 5 + ri * 11) % 101,
      reason: LONG_TEXT.repeat(2) + `(motivo persona ${i + 1}, reação ${def.code})`,
    }));
  return [r.id, { surveyAnswers, reactions, readerState: { finishedReading: true } }];
}));
const getResult = (runId) => resultsByRunId.get(runId);

const resolvedRows = runs
  .map((r) => ({ runId: r.id, persona: personas.find((p) => p.id === r.personaId), result: getResult(r.id) }))
  .filter((row) => row.persona && row.result);

const toQuantitativeMetric = ({ question, stats }) => ({
  questionId: question.id, questionText: question.text, min: question.min ?? 0, max: question.max ?? 100,
  n: stats.n, mean: stats.n ? Math.round(stats.mean * 100) / 100 : null, median: stats.n ? stats.median : null,
  minimum: stats.min, maximum: stats.max,
  standardDeviation: stats.n ? Math.round(stats.standardDeviation * 100) / 100 : null,
  divergence: stats.divergence != null ? Math.round(stats.divergence * 1000) / 1000 : null,
  divergenceClassification: stats.classification?.label ?? null,
});

const quantitativeMetrics = computeQuestionStats(quantitativeQuestions, runs, personas, getResult).map(toQuantitativeMetric);
const { validCount, stats: reactionStats } = computeReactionAggregates(reactionDefs, runs, personas, getResult);

// Um segmento simples, só para exercitar dataset.segments (nunca tocado
// pela compactação — seção 7 da tarefa).
const segmentRules = [{ attributeId: "a1", op: ">=", value: 0 }];
const segmentPersonas = filterPersonasBySegment(personas, segmentRules.map((r) => ({ ...r, attributeId: "a1" })));
const segments = [
  {
    name: "Todos",
    rules: [{ attributeName: "Idade", op: ">=", value: 0 }],
    n: segmentPersonas.length || personas.length,
    quantitativeMetrics,
    reactionAggregates: reactionStats.map((s) => ({
      reactionCode: s.def.code, reactionName: s.def.name, readerCount: s.count, validReaderCount: validCount, percentage: s.pct, meanIntensity: s.avg,
    })),
  },
];

const truncatedFields = [];
const datasetRaw = {
  analysisDatasetVersion: 2,
  populationRun: { id: "pr100", title: "Teste 100 Personas", sampleSize: personas.length, completed: runs.length, failed: 0, surveyName: "Survey", provider: "demo", model: "demo", promptVersion: "v1" },
  population: { name: "População 100", personas: personas.map((p) => ({ code: p.code, name: p.name })) },
  quantitativeMetrics,
  reactionAggregates: formatReactionAggregatesBase(reactionStats, validCount),
  reactionEntries: formatReactionEntries(reactionStats, { truncatedFields, maxReasonChars: ANALYST_MAX_REACTION_REASON_CHARS }),
  qualitativeQuestions: formatQualitativeQuestionsV2(qualitativeQuestions, resolvedRows, { truncatedFields, maxAnswerChars: ANALYST_MAX_QUALITATIVE_ANSWER_CHARS }),
  individualResults: formatIndividualResultsV2(resolvedRows, { quantitativeQuestionDefs: quantitativeQuestions }),
  segments,
  segmentComparisons: [],
  truncatedFields,
  attributeCatalogLegacyFallback: false,
};

// ---------------------------------------------------------------- pipeline
const datasetOriginalChars = JSON.stringify(datasetRaw).length;
const measureUserPromptChars = (ds) => buildResearchAnalystPrompt(ds).user.length;
const userPromptCharsBeforeCompaction = measureUserPromptChars(datasetRaw);

const preflight = compactAnalysisDatasetForBudget(
  datasetRaw,
  {
    maxPromptChars: ANALYST_MAX_PROMPT_CHARS,
    maxReactionReasonsPerCode: ANALYST_MAX_REACTION_REASONS_PER_CODE,
    maxQualitativeAnswersPerQuestion: ANALYST_MAX_QUALITATIVE_ANSWERS_PER_QUESTION,
    maxQualitativeAnswerChars: ANALYST_MAX_QUALITATIVE_ANSWER_CHARS,
    maxReactionReasonChars: ANALYST_MAX_REACTION_REASON_CHARS,
  },
  measureUserPromptChars
);
const finalDataset = preflight.dataset;
const { user: userPrompt } = buildResearchAnalystPrompt(finalDataset);
const datasetFinalChars = JSON.stringify(finalDataset).length;

console.log("\n--- Tamanho por etapa (100 Personas) ---");
console.log(`Dataset v2 bruto (chars):           ${datasetOriginalChars}`);
console.log(`User prompt ANTES da compactação:   ${userPromptCharsBeforeCompaction}`);
console.log(`Dataset v2 após compactação (chars): ${datasetFinalChars}`);
console.log(`User prompt FINAL (após compact.):  ${userPrompt.length}`);
console.log(`Limite (ANALYST_MAX_PROMPT_CHARS):  ${ANALYST_MAX_PROMPT_CHARS}`);
console.log(`Redução dataset bruto -> final:      ${(100 * (1 - datasetFinalChars / datasetOriginalChars)).toFixed(1)}%`);
console.log(`Redução prompt antes -> depois:      ${(100 * (1 - userPrompt.length / userPromptCharsBeforeCompaction)).toFixed(1)}%`);
console.log(`Passos de compactação aplicados:     ${preflight.stepsApplied.join(", ") || "(nenhum)"}`);
console.log("-----------------------------------------\n");

// --------------------------------------------------------------- testes
test("dataset v2 bruto (sem compactação) NÃO cabe no orçamento com 100 Personas (reproduz o bug original)", () => {
  assert.ok(userPromptCharsBeforeCompaction > ANALYST_MAX_PROMPT_CHARS, `esperava > ${ANALYST_MAX_PROMPT_CHARS}, obteve ${userPromptCharsBeforeCompaction}`);
});

test("após compactação determinística, o user prompt final cabe em ANALYST_MAX_PROMPT_CHARS", () => {
  assert.ok(preflight.fits, "preflight.fits deveria ser true");
  assert.ok(userPrompt.length <= ANALYST_MAX_PROMPT_CHARS, `user prompt (${userPrompt.length}) excede o limite (${ANALYST_MAX_PROMPT_CHARS})`);
});

test("quantitativeMetrics permanece 100% intacto após compactação", () => {
  assert.deepEqual(finalDataset.quantitativeMetrics, datasetRaw.quantitativeMetrics);
});

test("reactionAggregates permanece 100% intacto após compactação (só reactionEntries encolhe)", () => {
  assert.deepEqual(finalDataset.reactionAggregates, datasetRaw.reactionAggregates);
});

test("segments permanece 100% intacto após compactação", () => {
  assert.deepEqual(finalDataset.segments, datasetRaw.segments);
});

test("validação de evidence: métrica citada corretamente ainda passa", () => {
  const analysis = {
    executiveSummary: "Resumo de teste.",
    consensus: [{
      description: "Consenso de teste",
      evidence: [{ type: "metric", metricId: finalDataset.quantitativeMetrics[0].questionId, field: "mean", value: finalDataset.quantitativeMetrics[0].mean }],
    }],
  };
  const result = validateResearchAnalysis(analysis, finalDataset);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validação de evidence: persona + quantitativeAnswers ainda resolvível após compactação (individualResults nunca é amostrado)", () => {
  const somePersona = finalDataset.individualResults[0];
  const qId = Object.keys(somePersona.quantitativeAnswers)[0];
  const analysis = {
    executiveSummary: "Resumo de teste.",
    outliers: [{
      description: "Outlier de teste",
      evidence: [{ type: "persona", personaCode: somePersona.personaCode, metricId: qId, value: somePersona.quantitativeAnswers[qId] }],
    }],
  };
  const result = validateResearchAnalysis(analysis, finalDataset);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validação de evidence: persona + reactionCode só valida para reactionEntries realmente presentes no dataset final", () => {
  const survivingEntry = finalDataset.reactionEntries[0];
  const analysis = {
    executiveSummary: "Resumo de teste.",
    reactionPatterns: [{
      description: "Padrão de teste",
      evidence: [{ type: "persona", personaCode: survivingEntry.personaCode, reactionCode: survivingEntry.reactionCode, field: "intensity", value: survivingEntry.intensity }],
    }],
  };
  const result = validateResearchAnalysis(analysis, finalDataset);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("nenhuma fase de compactação usa Math.random (amostragem 100% determinística e reprodutível)", () => {
  const preflight2 = compactAnalysisDatasetForBudget(
    datasetRaw,
    {
      maxPromptChars: ANALYST_MAX_PROMPT_CHARS,
      maxReactionReasonsPerCode: ANALYST_MAX_REACTION_REASONS_PER_CODE,
      maxQualitativeAnswersPerQuestion: ANALYST_MAX_QUALITATIVE_ANSWERS_PER_QUESTION,
      maxQualitativeAnswerChars: ANALYST_MAX_QUALITATIVE_ANSWER_CHARS,
      maxReactionReasonChars: ANALYST_MAX_REACTION_REASON_CHARS,
    },
    measureUserPromptChars
  );
  assert.deepEqual(preflight2.dataset, finalDataset, "duas execuções com o mesmo input deveriam produzir exatamente o mesmo resultado");
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
