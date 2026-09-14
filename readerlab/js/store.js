// ============ ReaderLab — Estado e ações (repositórios) ============
import * as db from "./db.js";
import * as D from "./domain.js";

export const state = {
  personas: [],
  attributes: [],
  reactions: [],
  surveys: [],
  tags: [],
  populations: [],
  runs: [],
  results: [],
  ready: false,
};

const byUpdated = (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "");

function sortAll() {
  state.personas.sort(byUpdated);
  state.attributes.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  state.reactions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  state.surveys.sort(byUpdated);
}

export async function loadAll() {
  const [personas, attributes, reactions, surveys, tags, populations, runs, results] = await Promise.all([
    db.getAll("personas"), db.getAll("attributes"), db.getAll("reactions"),
    db.getAll("surveys"), db.getAll("tags"), db.getAll("populations"),
    db.getAll("runs"), db.getAll("results"),
  ]);
  Object.assign(state, { personas, attributes, reactions, surveys, tags, populations, runs, results, ready: true });
  state.runs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  sortAll();
}

export async function seedIfEmpty() {
  const seeded = await db.metaGet("seeded");
  if (seeded) return;
  await db.bulkPut("attributes", D.seedAttributes());
  await db.bulkPut("reactions", D.seedReactions());
  await db.bulkPut("surveys", D.seedSurveys());
  await db.metaSet("seeded", true);
}

// Personas de exemplo (R001–R010): semeadas uma única vez por workspace,
// idempotentes por código. Excluir uma persona de seed não a recria no
// próximo boot — "Restaurar dados de exemplo" recria todas.
export async function ensureSeedPersonas() {
  const done = (await db.metaGet("seededPersonaCodes")) || [];
  const todo = D.seedPersonaDefs().filter((d) => !done.includes(d.code));
  if (!todo.length) return [];
  const report = [];
  for (const def of todo) {
    const { persona, missing } = D.buildSeedPersona(def, state.attributes);
    await db.put("personas", persona);
    state.personas.unshift(persona);
    for (const tag of persona.tags) await ensureTag(tag);
    done.push(def.code);
    if (missing.length) report.push({ code: def.code, missing });
  }
  await db.metaSet("seededPersonaCodes", done);
  sortAll();
  return report;
}

// --------------------------------------------------------------- genéricos
function upsert(list, obj) {
  const i = list.findIndex((x) => x.id === obj.id);
  if (i >= 0) list[i] = obj; else list.unshift(obj);
  sortAll();
}

function removeFrom(list, id) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
}

// ---------------------------------------------------------------- Personas
export async function savePersona(persona) {
  persona.updatedAt = D.nowISO();
  await db.put("personas", persona);
  upsert(state.personas, persona);
  await syncTagsFromPersona(persona);
  return persona;
}

async function syncTagsFromPersona(persona) {
  for (const name of persona.tags || []) await ensureTag(name);
}

export async function deletePersona(id) {
  await db.remove("personas", id);
  removeFrom(state.personas, id);
  for (const pop of state.populations) {
    if (pop.personaIds.includes(id)) {
      pop.personaIds = pop.personaIds.filter((x) => x !== id);
      pop.updatedAt = D.nowISO();
      await db.put("populations", pop);
    }
  }
}

export async function duplicatePersona(id) {
  const src = state.personas.find((p) => p.id === id);
  if (!src) return null;
  const copy = D.duplicatePersona(src);
  await db.put("personas", copy);
  state.personas.unshift(copy);
  return copy;
}

// --------------------------------------------------------------- Atributos
export async function saveAttribute(attribute) {
  attribute.updatedAt = D.nowISO();
  await db.put("attributes", attribute);
  upsert(state.attributes, attribute);
  return attribute;
}

export function attributeUsage(attributeId) {
  return state.personas.filter((p) => p.attributeValues && p.attributeValues[attributeId] != null).length;
}

export async function deleteAttribute(id) {
  await db.remove("attributes", id);
  removeFrom(state.attributes, id);
}

// ---------------------------------------------------------------- Reações
export async function saveReaction(reaction) {
  reaction.updatedAt = D.nowISO();
  await db.put("reactions", reaction);
  upsert(state.reactions, reaction);
  return reaction;
}

export async function deleteReaction(id) {
  await db.remove("reactions", id);
  removeFrom(state.reactions, id);
  state.reactions.forEach((r, i) => (r.order = i));
  await db.bulkPut("reactions", state.reactions);
}

export async function moveReaction(id, dir) {
  const list = state.reactions;
  const i = list.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((r, k) => (r.order = k));
  await db.bulkPut("reactions", list);
}

// ---------------------------------------------------------------- Pesquisas
export async function saveSurvey(survey) {
  survey.updatedAt = D.nowISO();
  await db.put("surveys", survey);
  upsert(state.surveys, survey);
  return survey;
}

export async function deleteSurvey(id) {
  await db.remove("surveys", id);
  removeFrom(state.surveys, id);
}

export async function duplicateSurvey(id) {
  const src = state.surveys.find((s) => s.id === id);
  if (!src) return null;
  const copy = D.duplicateSurvey(src);
  await db.put("surveys", copy);
  state.surveys.unshift(copy);
  return copy;
}

// -------------------------------------------------------------------- Tags
export async function ensureTag(name) {
  const clean = (name || "").trim();
  if (!clean) return;
  if (!state.tags.some((t) => t.name.toLowerCase() === clean.toLowerCase())) {
    const tag = { id: D.uid("tag"), name: clean, createdAt: D.nowISO(), updatedAt: D.nowISO() };
    await db.put("tags", tag);
    state.tags.push(tag);
    state.tags.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function tagUsage(name) {
  const n = name.toLowerCase();
  const personas = state.personas.filter((p) => (p.tags || []).some((t) => t.toLowerCase() === n)).length;
  return { personas };
}

export async function deleteTag(id) {
  const tag = state.tags.find((t) => t.id === id);
  await db.remove("tags", id);
  removeFrom(state.tags, id);
  if (tag) {
    for (const p of state.personas) {
      if ((p.tags || []).some((t) => t.toLowerCase() === tag.name.toLowerCase())) {
        p.tags = p.tags.filter((t) => t.toLowerCase() !== tag.name.toLowerCase());
        p.updatedAt = D.nowISO();
        await db.put("personas", p);
      }
    }
  }
}

// ------------------------------------------------------------- Populações
export async function savePopulation(pop) {
  pop.updatedAt = D.nowISO();
  await db.put("populations", pop);
  const i = state.populations.findIndex((x) => x.id === pop.id);
  if (i >= 0) state.populations[i] = pop; else state.populations.push(pop);
  state.populations.sort((a, b) => a.name.localeCompare(b.name));
  return pop;
}

export async function deletePopulation(id) {
  await db.remove("populations", id);
  removeFrom(state.populations, id);
}

// ------------------------------------------------------------- Execuções
export async function saveRun(run) {
  await db.put("runs", run);
  const i = state.runs.findIndex((r) => r.id === run.id);
  if (i >= 0) state.runs[i] = run; else state.runs.unshift(run);
  state.runs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return run;
}

export async function saveResult(result) {
  await db.put("results", result);
  const i = state.results.findIndex((r) => r.id === result.id);
  if (i >= 0) state.results[i] = result; else state.results.push(result);
  return result;
}

export const getResultForRun = (runId) =>
  state.results.find((r) => r.readingRunId === runId) || null;

// ---------------------------------------------------- Importação / Exportação
export function exportAll() {
  return {
    app: "readerlab",
    version: 1,
    exportedAt: D.nowISO(),
    data: {
      personas: state.personas,
      attributes: state.attributes,
      reactions: state.reactions,
      surveys: state.surveys,
      tags: state.tags,
      populations: state.populations,
      runs: state.runs,
      results: state.results,
    },
  };
}

export async function importAll(payload) {
  if (!payload || payload.app !== "readerlab" || !payload.data) {
    throw new Error("Arquivo inválido: não é uma exportação do ReaderLab.");
  }
  const d = payload.data;
  for (const store of db.STORES) await db.clear(store);
  await db.bulkPut("personas", d.personas || []);
  await db.bulkPut("attributes", d.attributes || []);
  await db.bulkPut("reactions", d.reactions || []);
  await db.bulkPut("surveys", d.surveys || []);
  await db.bulkPut("tags", d.tags || []);
  await db.bulkPut("populations", d.populations || []);
  await db.bulkPut("runs", d.runs || []);
  await db.bulkPut("results", d.results || []);
  await db.metaSet("seeded", true);
  await loadAll();
}

export async function resetToSeeds() {
  for (const store of db.STORES) await db.clear(store);
  await db.bulkPut("attributes", D.seedAttributes());
  await db.bulkPut("reactions", D.seedReactions());
  await db.bulkPut("surveys", D.seedSurveys());
  await db.metaSet("seededPersonaCodes", []);
  await loadAll();
  await ensureSeedPersonas();
}

// ------------------------------------------------------------------- CSV
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

export function personasCSV() {
  const attrs = state.attributes.filter((a) => a.status === "ativa");
  const head = ["codigo", "nome", "status", "tags", ...attrs.map((a) => a.name)];
  const rows = state.personas.map((p) => [
    p.code, p.name, p.status, (p.tags || []).join("|"),
    ...attrs.map((a) => (p.attributeValues ? p.attributeValues[a.id] ?? "" : "")),
  ]);
  return toCSV([head, ...rows]);
}

export function attributesCSV() {
  const head = ["nome", "slug", "grupo", "min", "max", "padrao", "rotulo_min", "rotulo_max", "status"];
  const rows = state.attributes.map((a) => [a.name, a.slug, a.group, a.min, a.max, a.defaultValue, a.minLabel, a.maxLabel, a.status]);
  return toCSV([head, ...rows]);
}

export function reactionsCSV() {
  const head = ["codigo", "nome", "polaridade", "intensidade", "ordem", "status"];
  const rows = state.reactions.map((r) => [r.code, r.name, r.polarity, r.intensityEnabled ? "sim" : "não", r.order, r.status]);
  return toCSV([head, ...rows]);
}

export function surveysCSV() {
  const head = ["nome", "tipo", "status", "n_perguntas", "atualizado_em"];
  const rows = state.surveys.map((s) => [s.name, D.SURVEY_KINDS[s.kind] || s.kind, s.status, s.questions.length, s.updatedAt]);
  return toCSV([head, ...rows]);
}
