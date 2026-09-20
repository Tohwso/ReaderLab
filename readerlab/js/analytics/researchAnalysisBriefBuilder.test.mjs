// ============ ReaderLab — Testes: ResearchAnalysisBrief v1 builder ============
// Roda direto com `node js/analytics/researchAnalysisBriefBuilder.test.mjs`
// (nenhuma dependência externa, módulo puro sob teste + assert nativo).
//
// Cobre: preservação completa de agregados, seleção determinística de
// outliers quantitativos (incl. dedup em amostra pequena), amostragem
// espalhada de evidência qualitativa/de reação, minimalidade do
// personaIndex, e a versão do brief.
import assert from "node:assert/strict";
import {
  RESEARCH_ANALYSIS_BRIEF_VERSION,
  selectQuantitativeOutliers,
  selectQualitativeEvidence,
  selectReactionEvidence,
  buildPersonaIndex,
  buildResearchAnalysisBrief,
} from "./researchAnalysisBriefBuilder.js";

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

function makeDataset({ personaCount = 10 } = {}) {
  const personas = [];
  for (let i = 1; i <= personaCount; i++) {
    personas.push({ code: `R${String(i).padStart(3, "0")}`, name: `Leitor ${i}` });
  }
  const individualResults = personas.map((p, i) => ({
    personaCode: p.code,
    quantitativeAnswers: { q1: (i + 1) * 10 },
  }));
  const qualitativeAnswers = personas.map((p, i) => ({ personaCode: p.code, value: `Resposta ${i + 1}` }));
  const reactionEntries = personas.map((p, i) => ({ personaCode: p.code, reactionCode: "BORING", intensity: (i + 1) * 5, reason: `Motivo ${i + 1}` }));

  return {
    analysisDatasetVersion: 2,
    populationRun: { id: "run1", title: "Run 1", sampleSize: personaCount, completed: personaCount, failed: 0, surveyName: "Survey" },
    population: { name: "Pop 1", personas },
    quantitativeMetrics: [{ questionId: "q1", questionText: "Q1?", n: personaCount, mean: 55, median: 55, minimum: 10, maximum: 100, standardDeviation: 10, divergence: 0.2 }],
    reactionAggregates: [{ reactionCode: "BORING", reactionName: "Tédio", readerCount: personaCount, validReaderCount: personaCount, percentage: 50, meanIntensity: 30, minimumIntensity: 5, maximumIntensity: 50 }],
    individualResults,
    qualitativeQuestions: [{ questionId: "q2", questionText: "Q2?", answers: qualitativeAnswers }],
    reactionEntries,
    segments: [{ name: "Seg1", n: personaCount, quantitativeMetrics: [{ questionId: "q1", questionText: "Q1?", n: personaCount, mean: 55, median: 55, minimum: 10, maximum: 100, standardDeviation: 10, divergence: 0.2 }] }],
  };
}

test("RESEARCH_ANALYSIS_BRIEF_VERSION == 1", () => {
  assert.equal(RESEARCH_ANALYSIS_BRIEF_VERSION, 1);
});

test("selectQuantitativeOutliers: seleciona os N menores e N maiores por métrica", () => {
  const dataset = makeDataset({ personaCount: 10 });
  const outliers = selectQuantitativeOutliers(dataset, 3);
  assert.equal(outliers.length, 1);
  const [qo] = outliers;
  assert.equal(qo.low.length, 3);
  assert.equal(qo.high.length, 3);
  assert.deepEqual(qo.low.map((e) => e.value), [10, 20, 30]);
  assert.deepEqual(qo.high.map((e) => e.value), [80, 90, 100]);
});

test("selectQuantitativeOutliers: dedup quando amostra é pequena (n < 2*outliersPerSide)", () => {
  const dataset = makeDataset({ personaCount: 4 });
  const outliers = selectQuantitativeOutliers(dataset, 3);
  const [qo] = outliers;
  const lowCodes = new Set(qo.low.map((e) => e.personaCode));
  const overlap = qo.high.filter((e) => lowCodes.has(e.personaCode));
  assert.equal(overlap.length, 0, "low e high nunca devem compartilhar a mesma Persona");
  assert.equal(qo.low.length + qo.high.length, 4, "todas as 4 Personas devem aparecer exatamente uma vez");
});

test("selectQualitativeEvidence: preserva answerCount completo e amostra espalhada", () => {
  const dataset = makeDataset({ personaCount: 20 });
  const evidence = selectQualitativeEvidence(dataset, 5, 240);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].answerCount, 20);
  assert.equal(evidence[0].samples.length, 5);
});

test("selectQualitativeEvidence: trunca valores longos", () => {
  const dataset = makeDataset({ personaCount: 3 });
  dataset.qualitativeQuestions[0].answers[0].value = "x".repeat(500);
  const evidence = selectQualitativeEvidence(dataset, 5, 50);
  const truncated = evidence[0].samples.find((s) => s.value.length > 0 && s.value.includes("…"));
  assert.ok(truncated, "resposta longa deveria ser truncada com reticências");
  assert.ok(truncated.value.length <= 50);
});

test("selectReactionEvidence: preserva occurrenceCount completo e amostra por intensidade", () => {
  const dataset = makeDataset({ personaCount: 15 });
  const evidence = selectReactionEvidence(dataset, 3, 160);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].occurrenceCount, 15);
  assert.equal(evidence[0].samples.length, 3);
});

test("buildPersonaIndex: só inclui Personas referenciadas nas evidências (nunca o catálogo completo)", () => {
  const dataset = makeDataset({ personaCount: 50 });
  const quantitativeOutliers = selectQuantitativeOutliers(dataset, 3);
  const qualitativeEvidence = selectQualitativeEvidence(dataset, 5, 240);
  const reactionEvidence = selectReactionEvidence(dataset, 3, 160);
  const index = buildPersonaIndex(dataset, { quantitativeOutliers, qualitativeEvidence, reactionEvidence });
  assert.ok(Object.keys(index).length < 50, "personaIndex deve ser bem menor que o total de Personas");
  assert.ok(Object.keys(index).length > 0);
});

test("buildResearchAnalysisBrief: preserva agregados completos (quantitativeMetrics/reactionAggregates/segments) sem amostragem", () => {
  const dataset = makeDataset({ personaCount: 30 });
  const brief = buildResearchAnalysisBrief(dataset);
  assert.deepEqual(brief.quantitativeMetrics, dataset.quantitativeMetrics);
  assert.deepEqual(brief.reactionAggregates, dataset.reactionAggregates);
  assert.deepEqual(brief.segments, dataset.segments);
});

test("buildResearchAnalysisBrief: nunca inclui individualResults/reactionEntries/qualitativeQuestions completos", () => {
  const dataset = makeDataset({ personaCount: 30 });
  const brief = buildResearchAnalysisBrief(dataset);
  assert.equal(brief.individualResults, undefined);
  assert.equal(brief.reactionEntries, undefined);
  assert.equal(brief.qualitativeQuestions, undefined);
  assert.equal(brief.population.personas, undefined);
});

test("buildResearchAnalysisBrief: aplica options customizadas", () => {
  const dataset = makeDataset({ personaCount: 30 });
  const brief = buildResearchAnalysisBrief(dataset, { outliersPerSide: 1, qualitativeSamplesPerQuestion: 2, reactionSamplesPerCode: 1 });
  assert.equal(brief.quantitativeOutliers[0].low.length, 1);
  assert.equal(brief.quantitativeOutliers[0].high.length, 1);
  assert.equal(brief.qualitativeEvidence[0].samples.length, 2);
  assert.equal(brief.reactionEvidence[0].samples.length, 1);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
