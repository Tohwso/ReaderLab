// ============ ReaderLab — Testes: formatação v1 vs v2 do dataset do Analyst ============
// Sem infraestrutura de testes no projeto (sem build step, sem package.json)
// — roda direto com `node js/analytics/populationAnalysisDatasetFormat.test.mjs`.
// Módulo puro: usa dados 100% sintéticos (runs/personas/results) + as
// mesmas funções puras de populationMetrics.js (computeQuestionStats/
// computeReactionAggregates) para simular, sem tocar store.js/db.js (que
// depende do client Supabase e não roda em Node puro — ver comentário no
// topo de db.js), a mesma pipeline usada por
// populationAnalysisDatasetBuilder.js.
//
// Requisito 12 da tarefa: gerar v1 e v2 "para a mesma PopulationRun" e
// comparar tamanho (chars), conteúdo analítico (métricas/segmentos/reações)
// e respostas qualitativas — objetivo: redução grande de tamanho sem perda
// de informação necessária ao Analyst.
import assert from "node:assert/strict";
import { computeQuestionStats, computeReactionAggregates } from "./populationMetrics.js";
import {
  formatReactionAggregatesBase,
  formatReactionAggregatesV1,
  formatReactionEntries,
  formatQualitativeAnswersV1,
  formatQualitativeQuestionsV2,
  formatIndividualResultsV1,
  formatIndividualResultsV2,
} from "./populationAnalysisDatasetFormat.js";

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

// ------------------------------------------------------------ fixture
const questions = [
  { id: "q1", type: "scale", text: "Quão envolvente foi a leitura?", min: 0, max: 100 },
  { id: "q2", type: "long_text", text: "O que mais te marcou na leitura?" },
];
const quantitativeQuestionDefs = questions.filter((q) => q.type === "scale");
const qualitativeQuestionDefs = questions.filter((q) => q.type !== "scale");

const reactionDefs = [
  { code: "BORING", name: "Tédio", polarity: "negative", intensityEnabled: true },
  { code: "SURPRISE", name: "Surpresa", polarity: "positive", intensityEnabled: true },
];

const attributeById = new Map([["a1", { id: "a1", name: "Idade" }]]);

const LONG_ANSWER = "O final foi muito surpreendente e me pegou de jeito. ".repeat(4);
const LONG_REASON = "Achei o ritmo do meio da história bastante arrastado e repetitivo. ".repeat(3);

// 6 personas / ReadingRuns COMPLETED — o suficiente para gerar volume
// perceptível de duplicação em v1.
const personas = Array.from({ length: 6 }, (_, i) => ({
  id: `p${i + 1}`,
  code: `R00${i + 1}`,
  name: `Leitor(a) ${i + 1}`,
  attributeValues: { a1: 20 + i },
}));
const runs = personas.map((p, i) => ({ id: `run${i + 1}`, personaId: p.id, status: "COMPLETED" }));

const resultsByRunId = new Map(runs.map((r, i) => [r.id, {
  surveyAnswers: [
    { questionId: "q1", value: 40 + i * 5 },
    { questionId: "q2", value: LONG_ANSWER },
  ],
  reactions: [
    { reactionCode: "BORING", intensity: 50 + i, reason: LONG_REASON },
    ...(i % 2 === 0 ? [{ reactionCode: "SURPRISE", intensity: 70 + i, reason: LONG_REASON }] : []),
  ],
  readerState: { finishedReading: true },
}]));
const getResult = (runId) => resultsByRunId.get(runId);

const resolvedRows = runs.map((r) => ({ runId: r.id, persona: personas.find((p) => p.id === r.personaId), result: getResult(r.id) }));

// Reaproveita EXATAMENTE as mesmas funções puras usadas pelo builder real.
const quantitativeMetrics = computeQuestionStats(quantitativeQuestionDefs, runs, personas, getResult).map(({ question, stats }) => ({
  questionId: question.id, questionText: question.text, n: stats.n, mean: stats.mean, median: stats.median,
}));
const { validCount, stats: reactionStats } = computeReactionAggregates(reactionDefs, runs, personas, getResult);

function buildDatasetV1() {
  const truncatedFields = [];
  return {
    analysisDatasetVersion: 1,
    quantitativeMetrics,
    reactionAggregates: formatReactionAggregatesV1(reactionStats, validCount, { truncatedFields, maxReasonChars: 600 }),
    qualitativeAnswers: formatQualitativeAnswersV1(qualitativeQuestionDefs, resolvedRows, { truncatedFields, maxAnswerChars: 600 }),
    individualResults: formatIndividualResultsV1(resolvedRows, { attributeById, quantitativeQuestionDefs, qualitativeQuestionDefs }),
    segments: [],
    segmentComparisons: [],
    truncatedFields,
  };
}

function buildDatasetV2() {
  const truncatedFields = [];
  return {
    analysisDatasetVersion: 2,
    quantitativeMetrics,
    reactionAggregates: formatReactionAggregatesBase(reactionStats, validCount),
    reactionEntries: formatReactionEntries(reactionStats, { truncatedFields, maxReasonChars: 600 }),
    qualitativeQuestions: formatQualitativeQuestionsV2(qualitativeQuestionDefs, resolvedRows, { truncatedFields, maxAnswerChars: 600 }),
    individualResults: formatIndividualResultsV2(resolvedRows, { attributeById, quantitativeQuestionDefs }),
    segments: [],
    segmentComparisons: [],
    truncatedFields,
  };
}

const v1 = buildDatasetV1();
const v2 = buildDatasetV2();
const v1Json = JSON.stringify(v1);
const v2Json = JSON.stringify(v2);

// --------------------------------------------------------------- testes

test("tamanho: v2 é significativamente menor que v1 (>= 20% de redução)", () => {
  const reduction = 1 - v2Json.length / v1Json.length;
  assert.ok(v2Json.length < v1Json.length, `v2 (${v2Json.length}) deveria ser menor que v1 (${v1Json.length})`);
  assert.ok(reduction >= 0.2, `redução observada foi de apenas ${(reduction * 100).toFixed(1)}%`);
});

test("métricas quantitativas: idênticas entre v1 e v2 (nenhuma perda)", () => {
  assert.deepEqual(v2.quantitativeMetrics, v1.quantitativeMetrics);
});

test("reactionAggregates: v2 não tem 'entries' aninhado (v1 tem)", () => {
  assert.ok(v1.reactionAggregates.every((r) => Array.isArray(r.entries)));
  assert.ok(v2.reactionAggregates.every((r) => !("entries" in r)));
});

test("reactionAggregates: campos agregados (readerCount/percentage/meanIntensity) idênticos entre v1 e v2", () => {
  const strip = (arr) => arr.map(({ entries, ...rest }) => rest);
  assert.deepEqual(strip(v2.reactionAggregates), strip(v1.reactionAggregates));
});

test("reactionEntries (v2): contém todas as reações individuais, sem perder reason/intensity", () => {
  const totalMatchesV1 = v1.reactionAggregates.reduce((sum, r) => sum + r.entries.length, 0);
  assert.equal(v2.reactionEntries.length, totalMatchesV1);
  // cada entry de v1 (personaCode+reactionCode+intensity+reason) tem
  // equivalente em v2.reactionEntries.
  v1.reactionAggregates.forEach((r) => {
    r.entries.forEach((e) => {
      const found = v2.reactionEntries.find((x) => x.personaCode === e.personaCode && x.reactionCode === r.reactionCode);
      assert.ok(found, `entry de ${e.personaCode}/${r.reactionCode} não encontrada em reactionEntries`);
      assert.equal(found.intensity, e.intensity);
      assert.equal(found.reason, e.reason);
    });
  });
});

test("qualitativeQuestions (v2) preserva as mesmas respostas de qualitativeAnswers (v1), sem personaName", () => {
  assert.equal(v2.qualitativeQuestions.length, v1.qualitativeAnswers.length);
  v1.qualitativeAnswers.forEach((qv1, i) => {
    const qv2 = v2.qualitativeQuestions[i];
    assert.equal(qv2.questionId, qv1.questionId);
    assert.equal(qv2.answers.length, qv1.answers.length);
    qv1.answers.forEach((a, j) => {
      assert.equal(qv2.answers[j].personaCode, a.personaCode);
      assert.equal(qv2.answers[j].value, a.answer);
      assert.ok(!("personaName" in qv2.answers[j]), "v2 não deveria repetir personaName na resposta qualitativa");
    });
  });
});

test("individualResults (v2): quantitativeAnswers vira mapa questionId->value equivalente ao array de v1", () => {
  v1.individualResults.forEach((p1, i) => {
    const p2 = v2.individualResults[i];
    p1.quantitativeAnswers.forEach((qa) => {
      const q = quantitativeQuestionDefs.find((q) => q.text === qa.questionText);
      assert.equal(p2.quantitativeAnswers[q.id], qa.value);
    });
  });
});

test("individualResults (v2): reactionCodes preserva os mesmos códigos de v1.reactions", () => {
  v1.individualResults.forEach((p1, i) => {
    const p2 = v2.individualResults[i];
    assert.deepEqual(p2.reactionCodes, p1.reactions.map((r) => r.reactionCode));
  });
});

test("individualResults (v2): NÃO repete qualitativeAnswers (já existe em qualitativeQuestions)", () => {
  v2.individualResults.forEach((p) => assert.ok(!("qualitativeAnswers" in p)));
});

test("individualResults: nenhuma persona/atributo perdido entre v1 e v2", () => {
  assert.equal(v2.individualResults.length, v1.individualResults.length);
  v1.individualResults.forEach((p1, i) => {
    assert.equal(v2.individualResults[i].personaCode, p1.personaCode);
    assert.deepEqual(v2.individualResults[i].attributes, p1.attributes);
    assert.deepEqual(v2.individualResults[i].readerState, p1.readerState);
  });
});

console.log(`\n${passed} teste(s) passaram.`);
console.log(`Tamanho v1: ${v1Json.length} chars | v2: ${v2Json.length} chars | redução: ${(100 * (1 - v2Json.length / v1Json.length)).toFixed(1)}%`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
