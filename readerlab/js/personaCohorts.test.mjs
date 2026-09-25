// ============ ReaderLab — Testes: personaCohorts (Populations seed focadas) ============
// Roda direto com `node js/personaCohorts.test.mjs`. Módulo puro sob teste.
import assert from "node:assert/strict";
import {
  scorePersonaForCohort,
  computeFocusedPopulationMembers,
  filterEligiblePersonas,
  isPopulationAlreadySeeded,
  averageAttributeValue,
  normalizeAttributeValue,
  COHORT_DEFINITIONS,
  SEED_FOCUSED_POPULATION_DEFS,
} from "./personaCohorts.js";
import { seedAttributes, seedPersonaDefs, buildSeedPersona, SEED_PERSONA_CODES } from "./domain.js";

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

// ------------------------------------------------------------- Fixtures sintéticas
const ATTRS = [
  { id: "att_action", name: "Necessidade de ação", min: 0, max: 100 },
  { id: "att_ritmo", name: "Tolerância a ritmo lento", min: 0, max: 100 },
];
const SIMPLE_COHORT = { weights: [
  { attribute: "Necessidade de ação", weight: 0.7 },
  { attribute: "Tolerância a ritmo lento", weight: 0.3, inverse: true },
] };

function persona(code, values, status = "ativa") {
  return { id: "id_" + code, code, status, attributeValues: values };
}

function makeCrowd(n) {
  return Array.from({ length: n }, (_, i) => {
    const code = "S" + String(i + 1).padStart(2, "0");
    return persona(code, { att_action: 50 + (i % 40), att_ritmo: 20 + (i % 30) });
  });
}

// A) mesma entrada -> mesmos 20 (aqui, top 3) códigos
test("A) mesma entrada produz sempre a mesma seleção (determinismo)", () => {
  const crowd = makeCrowd(10);
  const r1 = computeFocusedPopulationMembers({ personas: crowd, attributes: ATTRS, cohort: SIMPLE_COHORT, size: 3 });
  const r2 = computeFocusedPopulationMembers({ personas: crowd, attributes: ATTRS, cohort: SIMPLE_COHORT, size: 3 });
  assert.deepEqual(r1.map((x) => x.personaCode), r2.map((x) => x.personaCode));
});

// B) ordem de entrada não altera a seleção final
test("B) embaralhar a ordem das Personas de entrada não muda o resultado", () => {
  const crowd = makeCrowd(10);
  const shuffled = [...crowd].reverse();
  const r1 = computeFocusedPopulationMembers({ personas: crowd, attributes: ATTRS, cohort: SIMPLE_COHORT, size: 5 });
  const r2 = computeFocusedPopulationMembers({ personas: shuffled, attributes: ATTRS, cohort: SIMPLE_COHORT, size: 5 });
  assert.deepEqual(r1.map((x) => x.personaCode), r2.map((x) => x.personaCode));
});

// C) empate de score resolve por persona.code ASC
test("C) empate de score é desempatado por code (ordem alfabética)", () => {
  const tied = [
    persona("S03", { att_action: 60, att_ritmo: 40 }),
    persona("S01", { att_action: 60, att_ritmo: 40 }),
    persona("S02", { att_action: 60, att_ritmo: 40 }),
  ];
  const r = computeFocusedPopulationMembers({ personas: tied, attributes: ATTRS, cohort: SIMPLE_COHORT, size: 3 });
  assert.deepEqual(r.map((x) => x.personaCode), ["S01", "S02", "S03"]);
});

// D) Persona sem o atributo citado recebe tratamento conservador/documentado (neutro, nem penaliza nem beneficia)
test("D) Persona sem o atributo do cohort usa fallback neutro documentado (50)", () => {
  const p = persona("S99", { att_action: 80 }); // sem att_ritmo
  const audit = scorePersonaForCohort(p, ATTRS, SIMPLE_COHORT);
  const ritmoContribution = audit.contributions.find((c) => c.attributeName === "Tolerância a ritmo lento");
  assert.equal(ritmoContribution.usedFallback, true);
  assert.equal(ritmoContribution.normalizedValue, 50);
  // score = 0.7*80 + 0.3*(100-50) = 56 + 15 = 71
  assert.ok(Math.abs(audit.score - 71) < 1e-9, `esperado 71, recebido ${audit.score}`);
});

// E) score sempre permanece 0-100, mesmo com valores fora da escala do Attribute
test("E) score nunca sai do intervalo 0-100 (mesmo com valores brutos fora de min/max)", () => {
  const extremes = [
    persona("S90", { att_action: 99999, att_ritmo: -99999 }),
    persona("S91", { att_action: -99999, att_ritmo: 99999 }),
  ];
  for (const p of extremes) {
    const audit = scorePersonaForCohort(p, ATTRS, SIMPLE_COHORT);
    assert.ok(audit.score >= 0 && audit.score <= 100, `score fora de faixa: ${audit.score}`);
  }
});

// F) nenhum grupo contém IDs duplicados
test("F) a seleção nunca contém personaId duplicado", () => {
  const crowd = makeCrowd(30);
  const r = computeFocusedPopulationMembers({ personas: crowd, attributes: ATTRS, cohort: SIMPLE_COHORT, size: 20 });
  assert.equal(new Set(r.map((x) => x.personaId)).size, r.length);
});

// G) cada grupo tem exatamente `size` membros quando existem Personas válidas suficientes
test("G) retorna exatamente `size` membros quando há Personas suficientes", () => {
  const crowd = makeCrowd(30);
  const r = computeFocusedPopulationMembers({ personas: crowd, attributes: ATTRS, cohort: SIMPLE_COHORT, size: 20 });
  assert.equal(r.length, 20);
});

// H) apenas Personas ativas e com code permitido (ex.: R001-R100) participam
test("H) filterEligiblePersonas exclui arquivadas e códigos fora da lista permitida", () => {
  const pool = [
    persona("R001", { att_action: 10 }),
    persona("R002", { att_action: 10 }, "arquivada"),
    persona("U001", { att_action: 10 }), // criada manualmente pelo usuário
  ];
  const eligible = filterEligiblePersonas(pool, ["R001", "R002"]);
  assert.deepEqual(eligible.map((p) => p.code), ["R001"]);
});

// I) overlap entre cohorts é permitido — mesma Persona pode liderar em mais de um grupo
test("I) uma Persona pode aparecer selecionada em mais de um cohort (overlap permitido)", () => {
  const versatile = persona("S50", { att_action: 95, att_ritmo: 5 });
  const crowd = [versatile, ...makeCrowd(10)];
  const cohortAlpha = { weights: [{ attribute: "Necessidade de ação", weight: 1 }] };
  const cohortBeta = { weights: [{ attribute: "Tolerância a ritmo lento", weight: 1, inverse: true }] };
  const selA = computeFocusedPopulationMembers({ personas: crowd, attributes: ATTRS, cohort: cohortAlpha, size: 1 });
  const selB = computeFocusedPopulationMembers({ personas: crowd, attributes: ATTRS, cohort: cohortBeta, size: 1 });
  assert.equal(selA[0].personaCode, "S50");
  assert.equal(selB[0].personaCode, "S50");
});

// J) Population existente (mesmo id) nunca é sobrescrita — guard de idempotência
test("J) isPopulationAlreadySeeded detecta Population já existente e nunca a recalcula", () => {
  const existing = [{ id: "pop_seed_action", name: "Nome editado manualmente pelo usuário", personaIds: ["x"] }];
  assert.equal(isPopulationAlreadySeeded(existing, "pop_seed_action"), true);
  assert.equal(isPopulationAlreadySeeded(existing, "pop_seed_contemplative"), false);
});

// Extra: normalizeAttributeValue usa o min/max real do Attribute (nunca 0-100 fixo)
test("normalizeAttributeValue normaliza pelo min/max real do Attribute", () => {
  const attr10 = { id: "a", name: "Escala custom", min: 0, max: 10 };
  assert.ok(Math.abs(normalizeAttributeValue(5, attr10) - 50) < 1e-9);
});

// ------------------------------------------------------- Validação de qualidade (seção 17)
// Usa os dados REAIS de seed (100 Personas + catálogo de atributos), não uma
// expectativa arbitrária — só afirma que cada cohort fica mais alinhado ao
// seu critério do que a média das 100 Personas.
const REAL_ATTRIBUTES = seedAttributes();
const REAL_PERSONAS = seedPersonaDefs().map((def) => buildSeedPersona(def, REAL_ATTRIBUTES).persona);
assert.equal(REAL_PERSONAS.length, 100);
assert.deepEqual(REAL_PERSONAS.map((p) => p.code).sort(), [...SEED_PERSONA_CODES].sort());

function topFor(cohortKey, size = 20) {
  const cohort = COHORT_DEFINITIONS[cohortKey];
  const top = computeFocusedPopulationMembers({ personas: REAL_PERSONAS, attributes: REAL_ATTRIBUTES, cohort, size });
  const topPersonas = top.map((r) => REAL_PERSONAS.find((p) => p.id === r.personaId));
  return { top, topPersonas };
}

test("qualidade) Ávidos por Ação: média de 'Necessidade de ação' do grupo > média geral", () => {
  const { topPersonas } = topFor("action");
  const groupAvg = averageAttributeValue(topPersonas, REAL_ATTRIBUTES, "Necessidade de ação");
  const overallAvg = averageAttributeValue(REAL_PERSONAS, REAL_ATTRIBUTES, "Necessidade de ação");
  assert.ok(groupAvg > overallAvg, `grupo=${groupAvg} geral=${overallAvg}`);
});

test("qualidade) Contemplativos: média de 'Tolerância a ritmo lento' e 'Orientação a ideias' do grupo > média geral", () => {
  const { topPersonas } = topFor("contemplative");
  for (const attrName of ["Tolerância a ritmo lento", "Orientação a ideias"]) {
    const groupAvg = averageAttributeValue(topPersonas, REAL_ATTRIBUTES, attrName);
    const overallAvg = averageAttributeValue(REAL_PERSONAS, REAL_ATTRIBUTES, attrName);
    assert.ok(groupAvg > overallAvg, `${attrName}: grupo=${groupAvg} geral=${overallAvg}`);
  }
});

test("qualidade) Personagens e Emoção: média de 'Orientação a personagens' e 'Orientação emocional' do grupo > média geral", () => {
  const { topPersonas } = topFor("characterEmotion");
  for (const attrName of ["Orientação a personagens", "Orientação emocional"]) {
    const groupAvg = averageAttributeValue(topPersonas, REAL_ATTRIBUTES, attrName);
    const overallAvg = averageAttributeValue(REAL_PERSONAS, REAL_ATTRIBUTES, attrName);
    assert.ok(groupAvg > overallAvg, `${attrName}: grupo=${groupAvg} geral=${overallAvg}`);
  }
});

test("qualidade) Céticos de Coerência: média de 'Sensibilidade a inconsistências' do grupo > média geral", () => {
  const { topPersonas } = topFor("coherence");
  const groupAvg = averageAttributeValue(topPersonas, REAL_ATTRIBUTES, "Sensibilidade a inconsistências");
  const overallAvg = averageAttributeValue(REAL_PERSONAS, REAL_ATTRIBUTES, "Sensibilidade a inconsistências");
  assert.ok(groupAvg > overallAvg, `grupo=${groupAvg} geral=${overallAvg}`);
});

test("qualidade) Humor/Absurdo/Sátira: média de 'Afinidade com humor absurdo' OU 'Afinidade com sátira' do grupo > média geral", () => {
  const { topPersonas } = topFor("humorAbsurd");
  const abs = { g: averageAttributeValue(topPersonas, REAL_ATTRIBUTES, "Afinidade com humor absurdo"), o: averageAttributeValue(REAL_PERSONAS, REAL_ATTRIBUTES, "Afinidade com humor absurdo") };
  const sat = { g: averageAttributeValue(topPersonas, REAL_ATTRIBUTES, "Afinidade com sátira"), o: averageAttributeValue(REAL_PERSONAS, REAL_ATTRIBUTES, "Afinidade com sátira") };
  assert.ok(abs.g > abs.o || sat.g > sat.o, `absurdo grupo=${abs.g} geral=${abs.o} | satira grupo=${sat.g} geral=${sat.o}`);
});

test("SEED_FOCUSED_POPULATION_DEFS tem 5 defs com ids fixos e size=20", () => {
  assert.equal(SEED_FOCUSED_POPULATION_DEFS.length, 5);
  assert.deepEqual(SEED_FOCUSED_POPULATION_DEFS.map((d) => d.id), [
    "pop_seed_action", "pop_seed_contemplative", "pop_seed_character_emotion", "pop_seed_coherence", "pop_seed_humor_absurd",
  ]);
  assert.ok(SEED_FOCUSED_POPULATION_DEFS.every((d) => d.size === 20 && COHORT_DEFINITIONS[d.cohortKey]));
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
