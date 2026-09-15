// ============ ReaderLab — Research Analyst: validação da resposta da LLM ============
// Duas camadas, nunca confiar no JSON recebido:
//   1) validação ESTRUTURAL (schema) — mesma filosofia de llm/validate.js:
//      cada item malformado é descartado individualmente; só falha a
//      análise inteira quando "executiveSummary" está ausente.
//   2) validação SEMÂNTICA de evidence — cada `evidence` citada pelo
//      Analyst precisa referenciar um dado que EXISTE literalmente no
//      dataset determinístico (ver analytics/populationAnalysisDatasetBuilder.js)
//      e o "value" citado precisa CORRESPONDER ao valor real (tolerância
//      apenas para float/serialização, nunca para números diferentes). A
//      LLM interpreta; ela não pode fabricar métricas, personas, segmentos,
//      reações, perguntas ou valores inexistentes. Qualquer evidence
//      inválida reprova a análise inteira (ver analysisEngine.js para o
//      fluxo de retry único + FAILED).
//
// Compatibilidade histórica: este validator SÓ roda no momento da geração
// de uma AnalysisRun nova — nunca é reaplicado sobre `analysisJson` já
// persistido. AnalysisRuns antigas (schema de evidence v1, formato livre
// `{ type, reference, value }`) continuam legíveis pela UI (ver
// `renderEvidenceList` em ui.js), só não passaram por esta verificação.

export const RESEARCH_ANALYST_EVIDENCE_SCHEMA_VERSION = 2;

const CONFIDENCE_VALUES = ["low", "medium", "high"];
const EVIDENCE_TYPES = ["metric", "reaction", "persona", "segment", "qualitative"];
const METRIC_FIELDS = ["n", "mean", "median", "minimum", "maximum", "standardDeviation", "divergence"];
const REACTION_FIELDS = ["readerCount", "validReaderCount", "percentage", "meanIntensity", "minimumIntensity", "maximumIntensity"];

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const asArray = (v) => (Array.isArray(v) ? v : []);

// Comparador numérico centralizado — única fonte de tolerância aceita em
// todo o validator. Tolerância mínima serve SOMENTE para diferenças de
// serialização/ponto flutuante (ex.: 74 vs "74.0"), nunca para números
// realmente diferentes (74 vs 81 nunca deve passar).
export function numbersEqual(a, b, tolerance = 0.01) {
  const toNum = (v) => (typeof v === "string" ? Number(v.replace(",", ".").replace("%", "").trim()) : Number(v));
  const na = toNum(a);
  const nb = toNum(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return Math.abs(na - nb) <= tolerance;
}

// Estrutura evidence sem confiar no shape — mantém apenas os campos
// reconhecidos, tudo mais é ignorado (nunca texto livre não verificável).
function cleanEvidence(list) {
  return asArray(list)
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      type: typeof e.type === "string" ? e.type : "",
      metricId: e.metricId != null ? String(e.metricId) : undefined,
      reactionCode: e.reactionCode != null ? String(e.reactionCode) : undefined,
      personaCode: e.personaCode != null ? String(e.personaCode) : undefined,
      segmentId: e.segmentId != null ? String(e.segmentId) : undefined,
      questionId: e.questionId != null ? String(e.questionId) : undefined,
      field: typeof e.field === "string" ? e.field : undefined,
      value: typeof e.value === "number" || typeof e.value === "string" ? e.value : undefined,
    }));
}

// ============================================================ 1) schema
function validateSchema(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, value: null, errors: ["Resposta não é um objeto JSON."] };
  }

  if (!isNonEmptyString(parsed.executiveSummary)) errors.push('"executiveSummary" ausente ou vazio.');

  const value = {
    executiveSummary: isNonEmptyString(parsed.executiveSummary) ? parsed.executiveSummary.trim() : "",
    consensus: [],
    polarization: [],
    outliers: [],
    segmentInsights: [],
    reactionPatterns: [],
    qualitativePatterns: [],
    interestingContradictions: [],
    investigationPoints: [],
    limitations: [],
  };

  value.consensus = asArray(parsed.consensus).map((c, i) => {
    if (!isNonEmptyString(c?.title) || !isNonEmptyString(c?.observation)) { errors.push(`consensus[${i}] incompleto — descartado.`); return null; }
    return { title: c.title.trim(), observation: c.observation.trim(), evidence: cleanEvidence(c.evidence) };
  }).filter(Boolean);

  value.polarization = asArray(parsed.polarization).map((p, i) => {
    if (!isNonEmptyString(p?.title) || !isNonEmptyString(p?.observation)) { errors.push(`polarization[${i}] incompleto — descartado.`); return null; }
    return {
      title: p.title.trim(),
      observation: p.observation.trim(),
      interpretation: isNonEmptyString(p.interpretation) ? p.interpretation.trim() : "",
      evidence: cleanEvidence(p.evidence),
    };
  }).filter(Boolean);

  value.outliers = asArray(parsed.outliers).map((o, i) => {
    if (!isNonEmptyString(o?.personaCode) || !isNonEmptyString(o?.observation)) { errors.push(`outliers[${i}] incompleto — descartado.`); return null; }
    return {
      personaCode: o.personaCode.trim(),
      personaName: isNonEmptyString(o.personaName) ? o.personaName.trim() : "",
      observation: o.observation.trim(),
      evidence: cleanEvidence(o.evidence),
    };
  }).filter(Boolean);

  value.segmentInsights = asArray(parsed.segmentInsights).map((s, i) => {
    if (!isNonEmptyString(s?.segment) || !isNonEmptyString(s?.observation)) { errors.push(`segmentInsights[${i}] incompleto — descartado.`); return null; }
    return {
      segment: s.segment.trim(),
      observation: s.observation.trim(),
      interpretation: isNonEmptyString(s.interpretation) ? s.interpretation.trim() : "",
      evidence: cleanEvidence(s.evidence),
    };
  }).filter(Boolean);

  value.reactionPatterns = asArray(parsed.reactionPatterns).map((r, i) => {
    if (!isNonEmptyString(r?.reactionCode) || !isNonEmptyString(r?.observation)) { errors.push(`reactionPatterns[${i}] incompleto — descartado.`); return null; }
    return { reactionCode: r.reactionCode.trim(), observation: r.observation.trim(), evidence: cleanEvidence(r.evidence) };
  }).filter(Boolean);

  value.qualitativePatterns = asArray(parsed.qualitativePatterns).map((q, i) => {
    if (!isNonEmptyString(q?.pattern)) { errors.push(`qualitativePatterns[${i}] incompleto — descartado.`); return null; }
    return {
      questionId: isNonEmptyString(q.questionId) ? q.questionId.trim() : "",
      pattern: q.pattern.trim(),
      evidence: cleanEvidence(q.evidence),
    };
  }).filter(Boolean);

  value.interestingContradictions = asArray(parsed.interestingContradictions).map((c, i) => {
    if (!isNonEmptyString(c?.observation)) { errors.push(`interestingContradictions[${i}] incompleto — descartado.`); return null; }
    return {
      observation: c.observation.trim(),
      interpretation: isNonEmptyString(c.interpretation) ? c.interpretation.trim() : "",
      evidence: cleanEvidence(c.evidence),
    };
  }).filter(Boolean);

  value.investigationPoints = asArray(parsed.investigationPoints).map((p, i) => {
    if (!isNonEmptyString(p?.title) || !isNonEmptyString(p?.hypothesis)) { errors.push(`investigationPoints[${i}] incompleto — descartado.`); return null; }
    const confidence = CONFIDENCE_VALUES.includes(p.confidence) ? p.confidence : "low";
    return {
      title: p.title.trim(),
      hypothesis: p.hypothesis.trim(),
      whyInvestigate: isNonEmptyString(p.whyInvestigate) ? p.whyInvestigate.trim() : "",
      confidence,
      evidence: cleanEvidence(p.evidence),
    };
  }).filter(Boolean);

  value.limitations = asArray(parsed.limitations).filter(isNonEmptyString).map((l) => l.trim());

  // Só a ausência de "executiveSummary" invalida a análise inteira — itens
  // malformados dentro das listas são descartados individualmente (ver
  // `errors` para diagnóstico) sem derrubar o restante da análise.
  return { ok: !!value.executiveSummary, value, errors };
}

// ======================================================= 2) evidence
// Índices de busca O(1) construídos uma única vez por validação, direto
// sobre o dataset determinístico (nunca sobre S.state — o Analyst só vê o
// dataset, então é exatamente contra ele que citações são verificadas).
function buildDatasetIndex(dataset) {
  const d = dataset || {};
  return {
    metricById: new Map(asArray(d.quantitativeMetrics).map((m) => [String(m.questionId), m])),
    reactionByCode: new Map(asArray(d.reactionAggregates).map((r) => [r.reactionCode, r])),
    personaByCode: new Map(asArray(d.individualResults).map((p) => [p.personaCode, p])),
    segmentByName: new Map(asArray(d.segments).map((s) => [s.name, s])),
    qualitativeByQuestionId: new Map(asArray(d.qualitativeAnswers).map((q) => [String(q.questionId), q])),
  };
}

// Retorna `null` se a evidence é válida, ou uma string descrevendo o
// problema encontrado (referência inexistente, campo inválido ou valor que
// não corresponde ao dataset).
function checkEvidence(e, index) {
  if (!e || typeof e !== "object") return "evidence não é um objeto.";
  if (!EVIDENCE_TYPES.includes(e.type)) return `type de evidence desconhecido: "${e.type}".`;

  if (e.type === "metric") {
    const m = index.metricById.get(e.metricId);
    if (!m) return `metricId inexistente no dataset: "${e.metricId}".`;
    if (!METRIC_FIELDS.includes(e.field)) return `field inválido para metric: "${e.field}".`;
    if (m[e.field] == null) return `metric "${e.metricId}" não possui valor para field "${e.field}" (amostra vazia).`;
    if (!numbersEqual(e.value, m[e.field])) return `valor divergente para metric "${e.metricId}".${e.field} (dataset=${m[e.field]}, citado=${e.value}).`;
    return null;
  }

  if (e.type === "reaction") {
    const r = index.reactionByCode.get(e.reactionCode);
    if (!r) return `reactionCode inexistente no dataset: "${e.reactionCode}".`;
    if (!REACTION_FIELDS.includes(e.field)) return `field inválido para reaction: "${e.field}".`;
    if (r[e.field] == null) return `reaction "${e.reactionCode}" não possui valor para field "${e.field}".`;
    if (!numbersEqual(e.value, r[e.field])) return `valor divergente para reaction "${e.reactionCode}".${e.field} (dataset=${r[e.field]}, citado=${e.value}).`;
    return null;
  }

  if (e.type === "persona") {
    const persona = index.personaByCode.get(e.personaCode);
    if (!persona) return `personaCode inexistente no dataset: "${e.personaCode}".`;
    if (e.metricId && e.reactionCode) return `evidence de persona deve referenciar metricId OU reactionCode, não ambos.`;
    if (e.metricId) {
      const m = index.metricById.get(e.metricId);
      if (!m) return `metricId inexistente no dataset: "${e.metricId}".`;
      if (e.field !== "value") return `field inválido para persona+metric (use "value"): "${e.field}".`;
      const qa = persona.quantitativeAnswers.find((q) => q.questionText === m.questionText);
      if (!qa) return `Persona "${e.personaCode}" não respondeu à métrica "${e.metricId}".`;
      if (!numbersEqual(e.value, qa.value)) return `valor divergente para persona "${e.personaCode}" / metric "${e.metricId}" (dataset=${qa.value}, citado=${e.value}).`;
      return null;
    }
    if (e.reactionCode) {
      const r = index.reactionByCode.get(e.reactionCode);
      if (!r) return `reactionCode inexistente no dataset: "${e.reactionCode}".`;
      if (e.field !== "intensity") return `field inválido para persona+reaction (use "intensity"): "${e.field}".`;
      const pr = persona.reactions.find((x) => x.reactionCode === e.reactionCode);
      if (!pr) return `Persona "${e.personaCode}" não emitiu a reação "${e.reactionCode}".`;
      if (pr.intensity == null || !numbersEqual(e.value, pr.intensity)) return `valor divergente para persona "${e.personaCode}" / reação "${e.reactionCode}" (dataset=${pr.intensity}, citado=${e.value}).`;
      return null;
    }
    return `evidence de persona precisa referenciar metricId ou reactionCode.`;
  }

  if (e.type === "segment") {
    const seg = index.segmentByName.get(e.segmentId);
    if (!seg) return `segmentId inexistente no dataset: "${e.segmentId}".`;
    const m = seg.quantitativeMetrics.find((x) => String(x.questionId) === e.metricId);
    if (!m) return `metricId inexistente no segmento "${e.segmentId}": "${e.metricId}".`;
    if (!METRIC_FIELDS.includes(e.field)) return `field inválido para segment: "${e.field}".`;
    if (m[e.field] == null) return `segmento "${e.segmentId}" não possui valor para field "${e.field}" na métrica "${e.metricId}".`;
    if (!numbersEqual(e.value, m[e.field])) return `valor divergente para segmento "${e.segmentId}" / metric "${e.metricId}".${e.field} (dataset=${m[e.field]}, citado=${e.value}).`;
    return null;
  }

  if (e.type === "qualitative") {
    const q = index.qualitativeByQuestionId.get(e.questionId);
    if (!q) return `questionId inexistente no dataset: "${e.questionId}".`;
    if (!index.personaByCode.has(e.personaCode)) return `personaCode inexistente no dataset: "${e.personaCode}".`;
    const answered = q.answers.some((a) => a.personaCode === e.personaCode);
    if (!answered) return `Persona "${e.personaCode}" não possui resposta registrada para a pergunta "${e.questionId}".`;
    return null;
  }

  return `type de evidence não tratado: "${e.type}".`;
}

// Percorre toda evidence citada em todas as seções da análise já
// estruturalmente válida — cada evidence PRECISA existir e corresponder ao
// dataset; qualquer falha aqui reprova a análise inteira (ver
// analysisEngine.js: retry único de correção, depois FAILED).
export function validateEvidenceSemantics(value, dataset) {
  const index = buildDatasetIndex(dataset);
  const errors = [];
  const walk = (sectionName, items) => {
    asArray(items).forEach((item, i) => {
      asArray(item?.evidence).forEach((e, j) => {
        const err = checkEvidence(e, index);
        if (err) errors.push(`${sectionName}[${i}].evidence[${j}]: ${err}`);
      });
    });
  };
  walk("consensus", value.consensus);
  walk("polarization", value.polarization);
  walk("outliers", value.outliers);
  walk("segmentInsights", value.segmentInsights);
  walk("reactionPatterns", value.reactionPatterns);
  walk("qualitativePatterns", value.qualitativePatterns);
  walk("interestingContradictions", value.interestingContradictions);
  walk("investigationPoints", value.investigationPoints);
  return { ok: errors.length === 0, errors };
}

// API principal — conceitualmente validateResearchAnalysis(analysis, dataset):
// 1) valida o schema (descarta itens malformados individualmente);
// 2) se estruturalmente ok, valida semanticamente cada evidence citada
//    contra o dataset determinístico. Só retorna ok:true se AMBAS as
//    camadas passarem — evidence fabricada/incorreta reprova a análise
//    inteira (nunca é silenciosamente descartada).
export function validateResearchAnalysis(parsed, dataset) {
  const structural = validateSchema(parsed);
  if (!structural.ok) return structural;
  const semantic = validateEvidenceSemantics(structural.value, dataset);
  if (!semantic.ok) return { ok: false, value: structural.value, errors: [...structural.errors, ...semantic.errors] };
  return { ok: true, value: structural.value, errors: structural.errors };
}
