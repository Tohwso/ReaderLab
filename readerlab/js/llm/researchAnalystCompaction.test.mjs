// ============ ReaderLab — Testes: preflight/compactação do Research Analyst ============
// Sem infraestrutura de testes no projeto — roda direto com
// `node js/llm/researchAnalystCompaction.test.mjs`. Módulo puro sob teste
// (sem I/O, ver researchAnalystCompaction.js); usa buildResearchAnalystPrompt
// (também puro) só para medir o userPrompt exatamente como analysisEngine.js
// faz de verdade.
//
// Cenários pedidos na especificação (preflight determinístico de tamanho):
//   A) dataset pequeno            → sem compactação
//   B) dataset médio              → compactação parcial → cabe no orçamento
//   C) dataset enorme             → compactação insuficiente → não cabe
//   D) estatísticas continuam completas (quantitativeMetrics/reactionAggregates/
//      segments) após qualquer nível de compactação
import assert from "node:assert/strict";
import { buildResearchAnalystPrompt } from "./researchAnalystPromptBuilder.js";
import {
  compactAnalysisDatasetForBudget,
  removeRedundantFields,
  removeNonAnalyticMetadata,
  limitReactionReasonsPerCode,
  limitQualitativeAnswersPerQuestion,
  truncateLongTexts,
  evenlySpacedIndices,
  measureDatasetSectionChars,
} from "./researchAnalystCompaction.js";

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

const measureUserPromptChars = (ds) => buildResearchAnalystPrompt(ds).user.length;

const LIMITS = {
  maxPromptChars: 20000,
  maxReactionReasonsPerCode: 5,
  maxQualitativeAnswersPerQuestion: 5,
  maxQualitativeAnswerChars: 200,
  maxReactionReasonChars: 100,
};

// Gera um dataset v2 sintético com `n` personas, cada uma com uma resposta
// qualitativa longa e uma reação com motivo longo.
function makeDataset(n, { answerLen = 300, reasonLen = 300 } = {}) {
  const longAnswer = "x".repeat(answerLen);
  const longReason = "y".repeat(reasonLen);
  const personaCodes = Array.from({ length: n }, (_, i) => `R${String(i + 1).padStart(4, "0")}`);
  return {
    analysisDatasetVersion: 2,
    populationRun: { id: "pr1", title: "Teste", sampleSize: n, completed: n, failed: 0, surveyName: "S", provider: "x", model: "y", promptVersion: "z" },
    population: { name: "Pop", personas: personaCodes.map((c) => ({ code: c, name: `Leitor ${c}` })) },
    quantitativeMetrics: [
      { questionId: "q1", questionText: "Quão envolvente foi a leitura?", n, mean: 70, median: 72, minimum: 10, maximum: 100, standardDeviation: 15, divergence: 0.3, divergenceClassification: "Divergência moderada" },
    ],
    reactionAggregates: [
      { reactionCode: "BORING", reactionName: "Tédio", polarity: "negative", readerCount: n, validReaderCount: n, percentage: 100, meanIntensity: 55, minimumIntensity: 10, maximumIntensity: 90 },
    ],
    reactionEntries: personaCodes.map((code) => ({ personaCode: code, reactionCode: "BORING", intensity: 55, reason: longReason })),
    individualResults: personaCodes.map((code) => ({ personaCode: code, personaName: `Leitor ${code}`, attributes: { Idade: 30 }, quantitativeAnswers: { q1: 70 }, reactionCodes: ["BORING"], readerState: null })),
    qualitativeQuestions: [
      { questionId: "q2", questionText: "O que mais te marcou?", answers: personaCodes.map((code) => ({ personaCode: code, value: longAnswer })) },
    ],
    segments: [
      { name: "Jovens", n: Math.ceil(n / 2), rules: [], quantitativeMetrics: [{ questionId: "q1", questionText: "Quão envolvente foi a leitura?", n: Math.ceil(n / 2), mean: 65, median: 65, minimum: 10, maximum: 90, standardDeviation: 12, divergence: 0.25 }] },
    ],
    segmentComparisons: [{ segmentA: "Jovens", nA: Math.ceil(n / 2), segmentB: "Jovens", nB: Math.ceil(n / 2), metrics: [] }],
    truncatedFields: [],
    attributeCatalogLegacyFallback: false,
  };
}

// ---------------------------------------------------------------- A
test("A) dataset pequeno -> sem compactação", () => {
  const dataset = makeDataset(2, { answerLen: 50, reasonLen: 50 });
  const r = compactAnalysisDatasetForBudget(dataset, LIMITS, measureUserPromptChars);
  assert.equal(r.compactionApplied, false);
  assert.equal(r.fits, true);
  assert.deepEqual(r.dataset, dataset);
  assert.equal(r.stats.qualitativeAnswersIncluded, r.stats.qualitativeAnswersOriginal);
  assert.equal(r.stats.reactionReasonsIncluded, r.stats.reactionReasonsOriginal);
});

// ---------------------------------------------------------------- B
test("B) dataset médio -> compactação parcial -> cabe no orçamento", () => {
  const dataset = makeDataset(30, { answerLen: 250, reasonLen: 250 });
  const before = measureUserPromptChars(dataset);
  assert.ok(before > LIMITS.maxPromptChars, "fixture deveria exceder o orçamento antes de compactar");
  const r = compactAnalysisDatasetForBudget(dataset, LIMITS, measureUserPromptChars);
  assert.equal(r.compactionApplied, true);
  assert.equal(r.fits, true);
  assert.ok(r.stepsApplied.length > 0);
  // limites respeitados
  r.dataset.reactionEntries.forEach(() => {});
  const countByCode = new Map();
  (r.dataset.reactionEntries || []).forEach((e) => countByCode.set(e.reactionCode, (countByCode.get(e.reactionCode) || 0) + 1));
  [...countByCode.values()].forEach((c) => assert.ok(c <= LIMITS.maxReactionReasonsPerCode));
  (r.dataset.qualitativeQuestions || []).forEach((q) => assert.ok(q.answers.length <= LIMITS.maxQualitativeAnswersPerQuestion));
});

// ---------------------------------------------------------------- C
test("C) dataset enorme -> compactação insuficiente -> não cabe (falha antes do provider)", () => {
  const dataset = makeDataset(500, { answerLen: 500, reasonLen: 500 });
  const r = compactAnalysisDatasetForBudget(dataset, LIMITS, measureUserPromptChars);
  assert.equal(r.compactionApplied, true);
  assert.equal(r.fits, false);
  assert.deepEqual(r.stepsApplied, [
    "remove_redundant_fields",
    "limit_reaction_reasons_per_code",
    "limit_qualitative_answers_per_question",
    "truncate_long_texts",
    "remove_non_analytic_metadata",
  ]);
});

// ---------------------------------------------------------------- D
test("D) estatísticas continuam completas após compactação", () => {
  const dataset = makeDataset(30, { answerLen: 250, reasonLen: 250 });
  const r = compactAnalysisDatasetForBudget(dataset, LIMITS, measureUserPromptChars);
  assert.deepEqual(r.dataset.quantitativeMetrics, dataset.quantitativeMetrics);
  assert.deepEqual(r.dataset.reactionAggregates, dataset.reactionAggregates);
  assert.deepEqual(r.dataset.segments, dataset.segments);
  assert.equal(r.dataset.population.personas.length, dataset.population.personas.length);
});

// -------------------------------------------------------- passos isolados
test("removeRedundantFields: remove só segmentComparisons", () => {
  const dataset = makeDataset(2);
  const out = removeRedundantFields(dataset);
  assert.ok(!("segmentComparisons" in out));
  assert.deepEqual(out.segments, dataset.segments);
  assert.deepEqual(out.quantitativeMetrics, dataset.quantitativeMetrics);
});

test("removeNonAnalyticMetadata: remove truncatedFields/attributeCatalogLegacyFallback/populationRun técnico, preserva o resto", () => {
  const dataset = makeDataset(2);
  const out = removeNonAnalyticMetadata(dataset);
  assert.ok(!("truncatedFields" in out));
  assert.ok(!("attributeCatalogLegacyFallback" in out));
  assert.ok(!("provider" in out.populationRun));
  assert.ok(!("model" in out.populationRun));
  assert.ok(!("promptVersion" in out.populationRun));
  assert.equal(out.populationRun.sampleSize, dataset.populationRun.sampleSize);
});

test("limitReactionReasonsPerCode: amostragem espalhada por intensidade (nunca só os primeiros personaCodes)", () => {
  const dataset = makeDataset(10);
  const out = limitReactionReasonsPerCode(dataset, 3);
  const kept = out.reactionEntries.map((e) => e.personaCode);
  assert.deepEqual(kept, ["R0001", "R0006", "R0010"]);
  const sampling = out.reactionEntriesSampling.find((s) => s.reactionCode === "BORING");
  assert.deepEqual(sampling, { reactionCode: "BORING", originalCount: 10, includedCount: 3 });
});

test("limitReactionReasonsPerCode: preserva variedade de intensidade (baixa/média/alta), nunca só um extremo", () => {
  const dataset = makeDataset(9);
  // intensidades bem distintas por persona (0..80) em vez do valor fixo do fixture padrão
  dataset.reactionEntries.forEach((e, i) => { e.intensity = i * 10; });
  const out = limitReactionReasonsPerCode(dataset, 3);
  const intensities = out.reactionEntries.map((e) => e.intensity).sort((a, b) => a - b);
  assert.deepEqual(intensities, [0, 40, 80]);
});

test("limitQualitativeAnswersPerQuestion: amostragem espalhada pela população (nunca só os primeiros personaCodes)", () => {
  const dataset = makeDataset(10);
  const out = limitQualitativeAnswersPerQuestion(dataset, 4);
  const kept = out.qualitativeQuestions[0].answers.map((a) => a.personaCode);
  assert.deepEqual(kept, ["R0001", "R0004", "R0007", "R0010"]);
  assert.equal(out.qualitativeQuestions[0].answersOriginalCount, 10);
  assert.equal(out.qualitativeQuestions[0].answersIncludedCount, 4);
});

test("truncateLongTexts: aplica marcador explícito e conta truncamentos", () => {
  const dataset = makeDataset(2, { answerLen: 1000, reasonLen: 1000 });
  const { dataset: out, truncatedAnswerCount, truncatedReasonCount } = truncateLongTexts(dataset, { maxAnswerChars: 50, maxReasonChars: 30 });
  assert.equal(truncatedAnswerCount, 2);
  assert.equal(truncatedReasonCount, 2);
  out.qualitativeQuestions[0].answers.forEach((a) => assert.ok(a.value.endsWith("...[truncated]")));
  out.reactionEntries.forEach((e) => assert.ok(e.reason.endsWith("...[truncated]")));
});

// ------------------------------------------------- evenlySpacedIndices
test("evenlySpacedIndices: n=100,k=10 -> inclui os dois extremos, espaçamento uniforme (nunca Math.random)", () => {
  assert.deepEqual(evenlySpacedIndices(100, 10), [0, 11, 22, 33, 44, 55, 66, 77, 88, 99]);
});

test("evenlySpacedIndices: k >= n -> retorna todos os índices", () => {
  assert.deepEqual(evenlySpacedIndices(3, 10), [0, 1, 2]);
});

test("evenlySpacedIndices: determinístico (chamadas repetidas produzem o mesmo resultado)", () => {
  const a = evenlySpacedIndices(37, 6);
  const b = evenlySpacedIndices(37, 6);
  assert.deepEqual(a, b);
});

// ------------------------------------------------- measureDatasetSectionChars
test("measureDatasetSectionChars: retorna um breakdown de tamanho por seção", () => {
  const dataset = makeDataset(5);
  const breakdown = measureDatasetSectionChars(dataset);
  assert.ok(breakdown.individualResults > 0);
  assert.ok(breakdown.qualitativeQuestions > 0);
  assert.ok(breakdown.reactionEntries > 0);
  assert.ok(breakdown.quantitativeMetrics > 0);
  assert.ok(breakdown.reactionAggregates > 0);
  assert.ok(breakdown.segments > 0);
  assert.ok(breakdown.population > 0);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
