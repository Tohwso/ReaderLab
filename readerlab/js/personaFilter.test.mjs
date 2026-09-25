// ============ ReaderLab — Testes: personaFilter (seletor de membros) ============
// Roda direto com `node js/personaFilter.test.mjs`. Módulo puro sob teste.
//
// Cobre a engine de filtro/seleção de Personas usada em ui.js/membersModal
// (ver tarefa "evoluir Editar membros de uma Population" — seção "Testes A-O").
import assert from "node:assert/strict";
import {
  filterPersonas,
  blankMemberFilters,
  computeAttributeAdherence,
  resolveMemberFilterPresets,
} from "./personaFilter.js";

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

// ------------------------------------------------------------- Fixtures
const ATTRS = [
  { id: "att_acao", name: "Necessidade de ação", slug: "necessidade-de-acao", min: 0, max: 100 },
  { id: "att_ritmo", name: "Tolerância a ritmo lento", slug: "tolerancia-a-ritmo-lento", min: 0, max: 100 },
  { id: "att_scale10", name: "Escala custom", slug: "escala-custom", min: 0, max: 10 },
];

function persona(id, overrides = {}) {
  return {
    id, code: id.toUpperCase(), name: "Persona " + id, shortDescription: "", tags: [], attributeValues: {},
    ...overrides,
  };
}

const P1 = persona("p1", { code: "P001", name: "Amélia Rocha", shortDescription: "Leitora de ficção científica", tags: ["scifi", "critica"], attributeValues: { att_acao: 90, att_ritmo: 20 } });
const P2 = persona("p2", { code: "P002", name: "Bruno Alves", shortDescription: "Fã de fantasia contemplativa", tags: ["fantasia"], attributeValues: { att_acao: 40, att_ritmo: 80 } });
const P3 = persona("p3", { code: "P003", name: "Carla Nunes", shortDescription: "Sem atributos definidos", tags: ["scifi", "fantasia"], attributeValues: {} });
const PERSONAS = [P1, P2, P3];

function run(overrides = {}, selectedIds = []) {
  return filterPersonas({ personas: PERSONAS, attributes: ATTRS, filters: { ...blankMemberFilters(), ...overrides }, selectedIds });
}

// A) busca por código
test("A) busca por código encontra a persona certa", () => {
  const r = run({ search: "p002" });
  assert.deepEqual(r.map((x) => x.persona.id), ["p2"]);
});

// B) busca por nome
test("B) busca por nome encontra a persona certa", () => {
  const r = run({ search: "Bruno" });
  assert.deepEqual(r.map((x) => x.persona.id), ["p2"]);
});

// C) busca é insensível a acento/maiúsculas
test("C) busca ignora acento e caixa (Amelia == Amélia == AMÉLIA)", () => {
  assert.deepEqual(run({ search: "amelia" }).map((x) => x.persona.id), ["p1"]);
  assert.deepEqual(run({ search: "AMÉLIA" }).map((x) => x.persona.id), ["p1"]);
});

// D) tagMode "any"
test("D) tagMode 'any' retorna quem tem QUALQUER uma das tags", () => {
  const r = run({ tags: ["scifi", "fantasia"], tagMode: "any" });
  assert.deepEqual(r.map((x) => x.persona.id).sort(), ["p1", "p2", "p3"]);
});

// E) tagMode "all"
test("E) tagMode 'all' exige TODAS as tags", () => {
  const r = run({ tags: ["scifi", "fantasia"], tagMode: "all" });
  assert.deepEqual(r.map((x) => x.persona.id), ["p3"]);
});

// F) membership "selected"
test("F) membership 'selected' só retorna quem já está selecionado", () => {
  const r = run({ membership: "selected" }, ["p2"]);
  assert.deepEqual(r.map((x) => x.persona.id), ["p2"]);
});

// G) membership "unselected"
test("G) membership 'unselected' só retorna quem NÃO está selecionado", () => {
  const r = run({ membership: "unselected" }, ["p2"]);
  assert.deepEqual(r.map((x) => x.persona.id).sort(), ["p1", "p3"]);
});

// H) operador gte
test("H) operador 'gte' inclui só valores >= threshold", () => {
  const r = run({ attributeFilters: [{ attributeId: "att_acao", operator: "gte", value: 70 }] });
  assert.deepEqual(r.map((x) => x.persona.id), ["p1"]);
});

// I) operador lte
test("I) operador 'lte' inclui só valores <= threshold", () => {
  const r = run({ attributeFilters: [{ attributeId: "att_acao", operator: "lte", value: 70 }] });
  assert.deepEqual(r.map((x) => x.persona.id), ["p2"]);
});

// J) operador between
test("J) operador 'between' inclui só valores dentro do intervalo (inclusive)", () => {
  const r = run({ attributeFilters: [{ attributeId: "att_ritmo", operator: "between", min: 15, max: 25 }] });
  assert.deepEqual(r.map((x) => x.persona.id), ["p1"]);
});

// K) múltiplos filtros numéricos combinam com AND
test("K) múltiplos attributeFilters combinam com AND", () => {
  const r = run({ attributeFilters: [
    { attributeId: "att_acao", operator: "gte", value: 70 },
    { attributeId: "att_ritmo", operator: "lte", value: 30 },
  ] });
  assert.deepEqual(r.map((x) => x.persona.id), ["p1"]);
  // P2 falha no primeiro critério (ação=40 < 70) mesmo passando no segundo (ritmo=80, não <=30)
  const r2 = run({ attributeFilters: [
    { attributeId: "att_acao", operator: "lte", value: 100 },
    { attributeId: "att_ritmo", operator: "lte", value: 30 },
  ] });
  assert.deepEqual(r2.map((x) => x.persona.id), ["p1"]);
});

// L) persona sem valor definido para o atributo nunca passa no filtro numérico
test("L) persona sem attributeValues[attributeId] nunca passa em filtro numérico", () => {
  const r = run({ attributeFilters: [{ attributeId: "att_acao", operator: "gte", value: 0 }] });
  assert.ok(!r.some((x) => x.persona.id === "p3"), "p3 não tem att_acao definido e não deveria passar mesmo com threshold 0");
});

// M) score de aderência usa o min/max REAL do Attribute (nunca hardcoda 0-100)
test("M) computeAttributeAdherence normaliza pelo min/max real do Attribute", () => {
  const attr10 = ATTRS.find((a) => a.id === "att_scale10");
  const scoreOn10Scale = computeAttributeAdherence(9, { operator: "gte", value: 5 }, attr10);
  // se a engine hardcodasse 0-100, (9-5)/(100-5) seria ~0.04 — o correto,
  // usando o max real (10), é (9-5)/(10-5) = 0.8
  assert.ok(Math.abs(scoreOn10Scale - 0.8) < 1e-9, `esperado ~0.8, recebido ${scoreOn10Scale}`);
});

// N) score de aderência é determinístico (mesma entrada -> mesma saída sempre)
test("N) computeAttributeAdherence é determinístico", () => {
  const attr = ATTRS.find((a) => a.id === "att_acao");
  const filter = { operator: "gte", value: 50 };
  const scores = Array.from({ length: 5 }, () => computeAttributeAdherence(90, filter, attr));
  assert.ok(scores.every((s) => s === scores[0]));
  assert.ok(Math.abs(scores[0] - 0.8) < 1e-9); // (90-50)/(100-50) = 0.8
});

// O) filtrar NUNCA altera selectedIds (nem qualquer outro parâmetro de entrada)
test("O) filterPersonas não muta selectedIds nem personas/attributes/filters", () => {
  const selectedIds = ["p1"];
  const filters = blankMemberFilters();
  const personasCopy = JSON.parse(JSON.stringify(PERSONAS));
  const attrsCopy = JSON.parse(JSON.stringify(ATTRS));
  filterPersonas({ personas: PERSONAS, attributes: ATTRS, filters, selectedIds });
  assert.deepEqual(selectedIds, ["p1"]);
  assert.deepEqual(filters, blankMemberFilters());
  assert.deepEqual(JSON.parse(JSON.stringify(PERSONAS)), personasCopy);
  assert.deepEqual(JSON.parse(JSON.stringify(ATTRS)), attrsCopy);
});

// Extra: sort "adherence" ordena do maior para o menor score
test("sortBy 'adherence' ordena do maior para o menor score", () => {
  const r = run({ attributeFilters: [{ attributeId: "att_acao", operator: "gte", value: 0 }], sortBy: "adherence" });
  assert.deepEqual(r.map((x) => x.persona.id), ["p1", "p2"]);
});

// Extra: presets sempre resolvidos por nome/slug, nunca por ID fixo
test("resolveMemberFilterPresets resolve por slug (nunca hardcoda IDs)", () => {
  const presets = resolveMemberFilterPresets(ATTRS);
  const acao = presets.find((p) => p.label === "Alta necessidade de ação");
  assert.equal(acao.attributeId, "att_acao");
  // atributo não existente no catálogo -> preset correspondente some, sem erro
  const semRitmo = resolveMemberFilterPresets(ATTRS.filter((a) => a.id !== "att_ritmo"));
  assert.ok(!semRitmo.some((p) => p.label === "Contemplativos"));
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
