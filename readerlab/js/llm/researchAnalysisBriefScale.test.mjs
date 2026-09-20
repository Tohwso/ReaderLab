// ============ ReaderLab — Teste de escala: ResearchAnalysisBrief v1 ============
// Sem infraestrutura de testes no projeto — roda direto com
// `node js/llm/researchAnalysisBriefScale.test.mjs`. Reproduz, com dados
// 100% sintéticos e SOMENTE módulos puros (nunca store.js/db.js, que
// dependem do client Supabase), a pipeline completa usada em produção:
// formatação v2 -> buildResearchAnalysisBrief -> buildResearchAnalystPrompt.
//
// Substitui o antigo researchAnalyst100PersonasRegression.test.mjs (testava
// a estratégia de compactação agressiva do dataset inteiro, abandonada).
//
// Objetivo: confirmar que o tamanho do ResearchAnalysisBrief v1 (e do
// userPrompt final) escala com o número de perguntas/reactionCodes/
// segmentos — NUNCA linearmente com o número de Personas. Fixamos 10
// perguntas quantitativas, 9 qualitativas e 15 reactionCodes (mesmo em
// 500 Personas) e variamos SÓ o número de Personas: 50, 100 e 500.
import assert from "node:assert/strict";
import { computeQuestionStats, computeReactionAggregates } from "../analytics/populationMetrics.js";
import {
  formatReactionAggregatesBase,
  formatReactionEntries,
  formatQualitativeQuestionsV2,
  formatIndividualResultsV2,
} from "../analytics/populationAnalysisDatasetFormat.js";
import { buildResearchAnalysisBrief } from "../analytics/researchAnalysisBriefBuilder.js";
import { buildResearchAnalystPrompt } from "./researchAnalystPromptBuilder.js";
import { validateResearchAnalysis } from "./researchAnalystValidate.js";
import {
  ANALYST_MAX_PROMPT_CHARS,
  ANALYST_MAX_QUALITATIVE_ANSWER_CHARS,
  ANALYST_MAX_REACTION_REASON_CHARS,
  ANALYST_OUTLIERS_PER_SIDE,
  ANALYST_QUALITATIVE_SAMPLES_PER_QUESTION,
  ANALYST_QUALITATIVE_SAMPLE_MAX_CHARS,
  ANALYST_REACTION_SAMPLES_PER_CODE,
  ANALYST_REACTION_SAMPLE_MAX_CHARS,
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

const N_QUANTITATIVE = 10;
const N_QUALITATIVE = 9;
const N_REACTIONS = 15;
const LONG_TEXT = "Este trecho da leitura me fez refletir bastante sobre as escolhas dos personagens e o ritmo da narrativa. ";

// Constrói um PopulationAnalysisDataset v2 100% sintético com `nPersonas`
// Personas e a quantidade FIXA de perguntas/reactionCodes acima — reproduz
// exatamente a forma produzida por populationAnalysisDatasetBuilder.js.
function buildSyntheticDataset(nPersonas) {
  const quantitativeQuestions = Array.from({ length: N_QUANTITATIVE }, (_, i) => ({
    id: `qq${i + 1}`, type: "scale", text: `Pergunta quantitativa ${i + 1} sobre a leitura?`, min: 0, max: 100,
  }));
  const qualitativeQuestions = Array.from({ length: N_QUALITATIVE }, (_, i) => ({
    id: `ql${i + 1}`, type: "long_text", text: `Pergunta qualitativa ${i + 1}: o que você achou?`,
  }));
  const reactionDefs = Array.from({ length: N_REACTIONS }, (_, i) => ({
    code: `REACTION_${i + 1}`, name: `Reação ${i + 1}`, polarity: i % 2 === 0 ? "positive" : "negative", intensityEnabled: true,
  }));

  const personas = Array.from({ length: nPersonas }, (_, i) => ({
    id: `p${i + 1}`, code: `R${String(i + 1).padStart(4, "0")}`, name: `Leitor(a) ${i + 1}`, attributeValues: {},
  }));
  const runs = personas.map((p, i) => ({ id: `run${i + 1}`, personaId: p.id, status: "COMPLETED" }));

  const resultsByRunId = new Map(runs.map((r, i) => {
    const surveyAnswers = [
      ...quantitativeQuestions.map((q, qi) => ({ questionId: q.id, value: (i * 7 + qi * 3) % 101 })),
      ...qualitativeQuestions.map((q) => ({ questionId: q.id, value: LONG_TEXT.repeat(3) + `(persona ${i + 1})` })),
    ];
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

  const segments = [
    {
      name: "Todos",
      rules: [{ attributeName: "Idade", op: ">=", value: 0 }],
      n: personas.length,
      quantitativeMetrics,
      reactionAggregates: reactionStats.map((s) => ({
        reactionCode: s.def.code, reactionName: s.def.name, readerCount: s.count, validReaderCount: validCount, percentage: s.pct, meanIntensity: s.avg,
      })),
    },
  ];

  const truncatedFields = [];
  return {
    analysisDatasetVersion: 2,
    populationRun: { id: "pr", title: `Teste ${nPersonas} Personas`, sampleSize: personas.length, completed: runs.length, failed: 0, surveyName: "Survey", provider: "demo", model: "demo", promptVersion: "v1" },
    population: { name: `População ${nPersonas}`, personas: personas.map((p) => ({ code: p.code, name: p.name })) },
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
}

function briefOptions() {
  return {
    outliersPerSide: ANALYST_OUTLIERS_PER_SIDE,
    qualitativeSamplesPerQuestion: ANALYST_QUALITATIVE_SAMPLES_PER_QUESTION,
    qualitativeSampleMaxChars: ANALYST_QUALITATIVE_SAMPLE_MAX_CHARS,
    reactionSamplesPerCode: ANALYST_REACTION_SAMPLES_PER_CODE,
    reactionSampleMaxChars: ANALYST_REACTION_SAMPLE_MAX_CHARS,
  };
}

function measure(nPersonas) {
  const dataset = buildSyntheticDataset(nPersonas);
  const datasetChars = JSON.stringify(dataset).length;
  const brief = buildResearchAnalysisBrief(dataset, briefOptions());
  const briefChars = JSON.stringify(brief).length;
  const { user: userPrompt } = buildResearchAnalystPrompt(brief);
  return { nPersonas, dataset, datasetChars, brief, briefChars, userPromptChars: userPrompt.length };
}

const r50 = measure(50);
const r100 = measure(100);
const r500 = measure(500);

console.log("\n--- Tamanho por escala (Personas) ---");
[r50, r100, r500].forEach((r) => {
  console.log(`${r.nPersonas} Personas: dataset=${r.datasetChars} chars | brief=${r.briefChars} chars | userPrompt=${r.userPromptChars} chars | compressão=${(100 * (1 - r.briefChars / r.datasetChars)).toFixed(1)}%`);
});
console.log(`Limite rígido (ANALYST_MAX_PROMPT_CHARS): ${ANALYST_MAX_PROMPT_CHARS}`);
console.log("--------------------------------------\n");

// --------------------------------------------------------------- testes
test("50 Personas: userPrompt < 50000 chars", () => {
  assert.ok(r50.userPromptChars < 50000, `esperava < 50000, obteve ${r50.userPromptChars}`);
});

test("100 Personas: userPrompt < 60000 chars", () => {
  assert.ok(r100.userPromptChars < 60000, `esperava < 60000, obteve ${r100.userPromptChars}`);
});

test("100 Personas: crescimento vs 50 Personas NÃO é ~2x (escala sub-linear com Personas)", () => {
  const growthRatio = r100.userPromptChars / r50.userPromptChars;
  assert.ok(growthRatio < 1.5, `esperava crescimento < 1.5x (não-linear), obteve ${growthRatio.toFixed(2)}x`);
});

test("500 Personas: userPrompt cai confortavelmente abaixo de ANALYST_MAX_PROMPT_CHARS", () => {
  assert.ok(r500.userPromptChars < ANALYST_MAX_PROMPT_CHARS * 0.5, `esperava < ${ANALYST_MAX_PROMPT_CHARS * 0.5}, obteve ${r500.userPromptChars}`);
});

test("500 Personas: crescimento vs 50 Personas é bem menor que 10x (500/50 = 10x mais Personas)", () => {
  const growthRatio = r500.userPromptChars / r50.userPromptChars;
  assert.ok(growthRatio < 3, `esperava crescimento < 3x apesar de 10x mais Personas, obteve ${growthRatio.toFixed(2)}x`);
});

test("agregados completos (quantitativeMetrics/reactionAggregates/segments) preservados intactos em todas as escalas", () => {
  [r50, r100, r500].forEach((r) => {
    assert.deepEqual(r.brief.quantitativeMetrics, r.dataset.quantitativeMetrics);
    assert.deepEqual(r.brief.reactionAggregates, r.dataset.reactionAggregates);
    assert.deepEqual(r.brief.segments, r.dataset.segments);
  });
});

test("validação de evidence: métrica citada corretamente ainda passa (500 Personas)", () => {
  const m = r500.brief.quantitativeMetrics[0];
  const analysis = {
    executiveSummary: "Resumo de teste.",
    consensus: [{ description: "Consenso de teste", evidence: [{ type: "metric", metricId: m.questionId, field: "mean", value: m.mean }] }],
  };
  const result = validateResearchAnalysis(analysis, r500.brief);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validação de evidence: persona citada em quantitativeOutliers ainda resolvível (500 Personas)", () => {
  const qo = r500.brief.quantitativeOutliers[0];
  const sample = qo.low[0];
  const analysis = {
    executiveSummary: "Resumo de teste.",
    outliers: [{ description: "Outlier de teste", evidence: [{ type: "persona", personaCode: sample.personaCode, metricId: qo.questionId, field: "value", value: sample.value }] }],
  };
  const result = validateResearchAnalysis(analysis, r500.brief);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("nenhuma fase de construção do brief usa Math.random (100% determinística e reprodutível)", () => {
  const brief2 = buildResearchAnalysisBrief(r100.dataset, briefOptions());
  assert.deepEqual(brief2, r100.brief, "duas execuções com o mesmo input deveriam produzir exatamente o mesmo resultado");
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
