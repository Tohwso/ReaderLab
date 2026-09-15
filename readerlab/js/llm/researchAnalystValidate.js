// ============ ReaderLab — Research Analyst: validação da resposta da LLM ============
// Nunca confiar no JSON recebido: mesma filosofia de llm/validate.js — cada
// item malformado é descartado individualmente; só falha o item inteiro
// (não a análise inteira) quando algo obrigatório está ausente. A análise
// só é considerada válida (ok: true) se ao menos "executiveSummary" existir.

const CONFIDENCE_VALUES = ["low", "medium", "high"];
const EVIDENCE_TYPES = ["metric", "reaction", "segment", "qualitative"];

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const asArray = (v) => (Array.isArray(v) ? v : []);

function cleanEvidence(list) {
  return asArray(list)
    .filter((e) => e && typeof e === "object" && isNonEmptyString(e.reference))
    .map((e) => ({
      type: EVIDENCE_TYPES.includes(e.type) ? e.type : "metric",
      reference: String(e.reference),
      value: e.value != null ? String(e.value) : "",
    }));
}

export function validateResearchAnalysis(parsed) {
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
