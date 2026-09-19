// ============ ReaderLab — Testes: Research Analyst evidence validation ============
// Sem infraestrutura de testes no projeto (sem build step, sem package.json)
// — este arquivo roda direto com `node js/llm/researchAnalystValidate.test.mjs`
// (nenhuma dependência externa, só o módulo ESM sob teste + assert nativo).
//
// Cobre os cenários pedidos na especificação de endurecimento do Research
// Analyst (evidence estruturada verificada deterministicamente contra o
// dataset determinístico — ver researchAnalystValidate.js):
//   A) metric correta                → PASS
//   B) metric inexistente            → FAIL
//   C) valor numérico correto        → PASS
//   D) valor numérico incorreto      → FAIL
//   E) persona correta               → PASS
//   F) persona inexistente           → FAIL
//   G) reactionCode correto          → PASS
//   H) reactionCode inexistente      → FAIL
//   I) segmento correto              → PASS
//   J) segmento inexistente          → FAIL
//   K) qualitative reference correta → PASS
// + extras: qualitative persona sem resposta → FAIL; numbersEqual tolerância
// de serialização; validateResearchAnalysis (schema + semântica) fim-a-fim.
import assert from "node:assert/strict";
import { validateResearchAnalysis, validateEvidenceSemantics, numbersEqual } from "./researchAnalystValidate.js";

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

// Dataset determinístico mínimo, no mesmo shape produzido por
// buildPopulationAnalysisDataset() versão 2 (compacta) — o suficiente para
// exercitar todos os tipos de evidence sem precisar de S.state/store.js/db.js.
const dataset = {
  analysisDatasetVersion: 2,
  quantitativeMetrics: [
    { questionId: "q1", questionText: "Quão envolvente foi a leitura?", n: 3, mean: 74, median: 75, minimum: 60, maximum: 90, standardDeviation: 12.5, divergence: 0.32, divergenceClassification: "Divergência moderada" },
  ],
  reactionAggregates: [
    { reactionCode: "BORING", reactionName: "Tédio", readerCount: 3, validReaderCount: 10, percentage: 30, meanIntensity: 55, minimumIntensity: 40, maximumIntensity: 70 },
  ],
  reactionEntries: [
    { personaCode: "R002", reactionCode: "BORING", intensity: 60, reason: "Achei o meio da história arrastado." },
  ],
  individualResults: [
    { personaCode: "R002", quantitativeAnswers: { q1: 43 } },
    { personaCode: "R003", quantitativeAnswers: {} },
  ],
  segments: [
    {
      name: "Jovens", n: 5,
      quantitativeMetrics: [{ questionId: "q1", questionText: "Quão envolvente foi a leitura?", n: 5, mean: 48, median: 50, minimum: 20, maximum: 80, standardDeviation: 15, divergence: 0.4 }],
    },
  ],
  qualitativeQuestions: [
    { questionId: "q2", questionText: "O que mais te marcou?", answers: [{ personaCode: "R003", value: "O final surpreendente." }] },
  ],
};

const evidenceOk = (type, extra) => ({ ok: validateEvidenceSemantics({ consensus: [{ evidence: [{ type, ...extra }] }], polarization: [], outliers: [], segmentInsights: [], reactionPatterns: [], qualitativePatterns: [], interestingContradictions: [], investigationPoints: [] }, dataset) });

// A) metric correta → PASS
test("A) metric correta -> PASS", () => {
  const r = evidenceOk("metric", { metricId: "q1", field: "mean", value: 74 });
  assert.equal(r.ok.ok, true);
});

// B) metric inexistente → FAIL
test("B) metricId inexistente -> FAIL", () => {
  const r = evidenceOk("metric", { metricId: "q999", field: "mean", value: 74 });
  assert.equal(r.ok.ok, false);
});

// C) valor numérico correto (com ruído de serialização) → PASS
test("C) valor numérico correto (string '74.0') -> PASS", () => {
  const r = evidenceOk("metric", { metricId: "q1", field: "mean", value: "74.0" });
  assert.equal(r.ok.ok, true);
});

// D) valor numérico incorreto → FAIL
test("D) valor numérico incorreto (81 em vez de 74) -> FAIL", () => {
  const r = evidenceOk("metric", { metricId: "q1", field: "mean", value: 81 });
  assert.equal(r.ok.ok, false);
});

// E) persona correta → PASS
test("E) persona correta (metricId) -> PASS", () => {
  const r = evidenceOk("persona", { personaCode: "R002", metricId: "q1", field: "value", value: 43 });
  assert.equal(r.ok.ok, true);
});

// F) persona inexistente → FAIL
test("F) personaCode inexistente -> FAIL", () => {
  const r = evidenceOk("persona", { personaCode: "R999", metricId: "q1", field: "value", value: 43 });
  assert.equal(r.ok.ok, false);
});

// G) reactionCode correto → PASS
test("G) reactionCode correto -> PASS", () => {
  const r = evidenceOk("reaction", { reactionCode: "BORING", field: "percentage", value: 30 });
  assert.equal(r.ok.ok, true);
});

// H) reactionCode inexistente → FAIL
test("H) reactionCode inexistente -> FAIL", () => {
  const r = evidenceOk("reaction", { reactionCode: "NOPE", field: "percentage", value: 30 });
  assert.equal(r.ok.ok, false);
});

// I) segmento correto → PASS
test("I) segmento correto -> PASS", () => {
  const r = evidenceOk("segment", { segmentId: "Jovens", metricId: "q1", field: "mean", value: 48 });
  assert.equal(r.ok.ok, true);
});

// J) segmento inexistente → FAIL
test("J) segmentId inexistente -> FAIL", () => {
  const r = evidenceOk("segment", { segmentId: "Idosos", metricId: "q1", field: "mean", value: 48 });
  assert.equal(r.ok.ok, false);
});

// K) qualitative reference correta → PASS
test("K) qualitative correta (persona respondeu a pergunta) -> PASS", () => {
  const r = evidenceOk("qualitative", { questionId: "q2", personaCode: "R003" });
  assert.equal(r.ok.ok, true);
});

// Extra: qualitative — persona existe mas NÃO respondeu aquela pergunta → FAIL
test("extra) qualitative persona sem resposta naquela pergunta -> FAIL", () => {
  const r = evidenceOk("qualitative", { questionId: "q2", personaCode: "R002" });
  assert.equal(r.ok.ok, false);
});

// Extra: reação individual da persona (reactionCode em vez de metricId)
test("extra) persona + reactionCode correto -> PASS", () => {
  const r = evidenceOk("persona", { personaCode: "R002", reactionCode: "BORING", field: "intensity", value: 60 });
  assert.equal(r.ok.ok, true);
});

// Extra: individualResults v2 não guarda mais reactionCodes — a evidence só
// é válida se existir uma reactionEntry correspondente no dataset FINAL
// (nunca inferida a partir de individualResults, ver seção 2 da tarefa).
test("extra) persona + reactionCode sem reactionEntry correspondente (ex.: removida pela compactação) -> FAIL", () => {
  const r = evidenceOk("persona", { personaCode: "R003", reactionCode: "BORING", field: "intensity", value: 60 });
  assert.equal(r.ok.ok, false);
});

// Extra: numbersEqual — tolerância só para serialização, nunca para número diferente
test("extra) numbersEqual: 74 == '74.0'", () => assert.equal(numbersEqual(74, "74.0"), true));
test("extra) numbersEqual: 74 != 81", () => assert.equal(numbersEqual(74, 81), false));
test("extra) numbersEqual: '30%' == 30", () => assert.equal(numbersEqual("30%", 30), true));

// Extra: validateResearchAnalysis fim-a-fim — schema válido + evidence real -> ok:true
test("extra) validateResearchAnalysis: análise válida fim-a-fim -> ok:true", () => {
  const parsed = {
    executiveSummary: "Resumo de teste.",
    consensus: [{ title: "T", observation: "O", evidence: [{ type: "metric", metricId: "q1", field: "mean", value: 74 }] }],
  };
  const r = validateResearchAnalysis(parsed, dataset);
  assert.equal(r.ok, true);
});

// Extra: validateResearchAnalysis fim-a-fim — evidence fabricada reprova a análise inteira
test("extra) validateResearchAnalysis: evidence fabricada -> ok:false", () => {
  const parsed = {
    executiveSummary: "Resumo de teste.",
    consensus: [{ title: "T", observation: "O", evidence: [{ type: "metric", metricId: "q1", field: "mean", value: 999 }] }],
  };
  const r = validateResearchAnalysis(parsed, dataset);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
