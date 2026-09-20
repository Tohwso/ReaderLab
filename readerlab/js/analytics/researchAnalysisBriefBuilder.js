// ============ ReaderLab — Research Analysis Brief (v1) ============
// Módulo PURO (sem I/O, sem LLM, sem Math.random): recebe um
// PopulationAnalysisDataset v2 JÁ CONSTRUÍDO (ver
// analytics/populationAnalysisDatasetBuilder.js) — que continua existindo
// intacto, nunca é substituído ou destruído — e produz um
// ResearchAnalysisBrief bem menor, otimizado para consumo pela LLM.
//
// PRINCÍPIO (em vez de compactar agressivamente o dataset inteiro — ver
// llm/researchAnalystCompaction.js, mantido só para uso pontual/legado):
// o Research Analyst NUNCA precisa ver todos os ReadingResults individuais.
// Ele recebe:
//   1) agregados COMPLETOS, nunca amostrados (quantitativeMetrics,
//      reactionAggregates, segments) — os mesmos números de sempre;
//   2) evidências INDIVIDUAIS selecionadas deterministicamente (outliers
//      quantitativos, amostras qualitativas espalhadas pela população,
//      amostras de reação de baixa/média/alta intensidade) — nunca o
//      catálogo completo de respostas/Personas.
//
// Isso faz o tamanho do brief crescer com o número de perguntas/
// reactionCodes/segmentos configurados — não com o número de Personas (ver
// llm/researchAnalysisBriefScale.test.mjs para os testes de 50/100/500
// Personas confirmando este comportamento).
import { evenlySpacedIndices } from "../llm/researchAnalystCompaction.js";

export const RESEARCH_ANALYSIS_BRIEF_VERSION = 1;

function byPersonaCode(a, b) {
  return String(a.personaCode || "").localeCompare(String(b.personaCode || ""));
}

// Truncamento defensivo simples (nunca dado do experimento além do texto em
// si) — usado apenas nas amostras individuais do brief, nunca nos
// agregados (que já vêm prontos do dataset).
function truncate(value, max) {
  if (typeof value !== "string" || value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

// Substitui o envio de TODAS as respostas quantitativas de TODAS as
// Personas (individualResults completo) pelos `outliersPerSide` menores e
// `outliersPerSide` maiores valores de cada métrica, deterministicamente
// (empate resolvido por personaCode). Nunca duplica a mesma Persona entre
// low/high quando os dois grupos colidiriam (amostra pequena).
export function selectQuantitativeOutliers(dataset, outliersPerSide) {
  const individualResults = dataset.individualResults || [];
  return (dataset.quantitativeMetrics || []).map((m) => {
    const entries = individualResults
      .filter((p) => p.quantitativeAnswers && p.quantitativeAnswers[m.questionId] != null)
      .map((p) => ({ personaCode: p.personaCode, value: p.quantitativeAnswers[m.questionId] }));
    const sorted = [...entries].sort((a, b) => (a.value - b.value) || byPersonaCode(a, b));
    const n = sorted.length;
    const side = Math.min(outliersPerSide, n);
    let low = sorted.slice(0, side);
    let high = sorted.slice(n - side);
    if (low.length + high.length > n) {
      const lowCodes = new Set(low.map((e) => e.personaCode));
      high = high.filter((e) => !lowCodes.has(e.personaCode));
    }
    return { questionId: m.questionId, questionText: m.questionText, low, high };
  });
}

// Cada pergunta qualitativa preserva o total real de respostas
// (`answerCount`) e uma amostra determinística ESPALHADA pela população
// inteira (evenlySpacedIndices, nunca só R0001..R00NN — ver
// llm/researchAnalystCompaction.js), truncada defensivamente.
export function selectQualitativeEvidence(dataset, samplesPerQuestion, maxChars) {
  return (dataset.qualitativeQuestions || []).map((q) => {
    const answers = q.answers || [];
    const sorted = [...answers].sort(byPersonaCode);
    const idxs = evenlySpacedIndices(sorted.length, samplesPerQuestion);
    const samples = idxs.map((i) => ({ personaCode: sorted[i].personaCode, value: truncate(sorted[i].value, maxChars) }));
    return { questionId: q.questionId, questionText: q.questionText, answerCount: answers.length, samples };
  });
}

// reactionAggregates (números completos) permanecem intocados fora desta
// função; aqui só selecionamos exemplos individuais representativos de
// intensidade baixa/média/alta (nunca todos os reasons) — mesma amostragem
// espalhada por intensidade usada pela compactação legada.
export function selectReactionEvidence(dataset, samplesPerCode, maxChars) {
  const byCode = new Map();
  (dataset.reactionEntries || []).forEach((e) => {
    if (!byCode.has(e.reactionCode)) byCode.set(e.reactionCode, []);
    byCode.get(e.reactionCode).push(e);
  });
  return (dataset.reactionAggregates || []).map((agg) => {
    const group = byCode.get(agg.reactionCode) || [];
    const sortedByIntensity = [...group].sort((a, b) => (a.intensity - b.intensity) || byPersonaCode(a, b));
    const idxs = evenlySpacedIndices(sortedByIntensity.length, samplesPerCode);
    const samples = idxs
      .map((i) => sortedByIntensity[i])
      .sort(byPersonaCode)
      .map((e) => ({ personaCode: e.personaCode, intensity: e.intensity, reason: truncate(e.reason || "", maxChars) }));
    return { reactionCode: agg.reactionCode, occurrenceCount: group.length, samples };
  });
}

// Catálogo MÍNIMO de Personas: apenas personaCode -> personaName, e SÓ
// para Personas que de fato aparecem em alguma evidência individual
// selecionada acima — nunca o catálogo completo da população.
export function buildPersonaIndex(dataset, { quantitativeOutliers, qualitativeEvidence, reactionEvidence }) {
  const nameByCode = new Map((dataset.population?.personas || []).map((p) => [p.code, p.name]));
  const codes = new Set();
  quantitativeOutliers.forEach((qo) => {
    qo.low.forEach((e) => codes.add(e.personaCode));
    qo.high.forEach((e) => codes.add(e.personaCode));
  });
  qualitativeEvidence.forEach((q) => q.samples.forEach((s) => codes.add(s.personaCode)));
  reactionEvidence.forEach((r) => r.samples.forEach((s) => codes.add(s.personaCode)));
  const index = {};
  [...codes].sort().forEach((code) => { index[code] = nameByCode.get(code) || "(persona removida)"; });
  return index;
}

// Constrói o ResearchAnalysisBrief v1 a partir de um PopulationAnalysisDataset
// v2 completo. `options` (todas com defaults — o chamador real,
// analysisEngine.js, injeta os valores configuráveis de config.js):
//   outliersPerSide, qualitativeSamplesPerQuestion, qualitativeSampleMaxChars,
//   reactionSamplesPerCode, reactionSampleMaxChars.
export function buildResearchAnalysisBrief(dataset, options = {}) {
  const {
    outliersPerSide = 3,
    qualitativeSamplesPerQuestion = 5,
    qualitativeSampleMaxChars = 240,
    reactionSamplesPerCode = 3,
    reactionSampleMaxChars = 160,
  } = options;

  const quantitativeOutliers = selectQuantitativeOutliers(dataset, outliersPerSide);
  const qualitativeEvidence = selectQualitativeEvidence(dataset, qualitativeSamplesPerQuestion, qualitativeSampleMaxChars);
  const reactionEvidence = selectReactionEvidence(dataset, reactionSamplesPerCode, reactionSampleMaxChars);
  const personaIndex = buildPersonaIndex(dataset, { quantitativeOutliers, qualitativeEvidence, reactionEvidence });

  return {
    researchAnalysisBriefVersion: RESEARCH_ANALYSIS_BRIEF_VERSION,
    sourceDatasetVersion: dataset.analysisDatasetVersion ?? null,
    populationRun: {
      id: dataset.populationRun?.id ?? null,
      title: dataset.populationRun?.title ?? null,
      sampleSize: dataset.populationRun?.sampleSize ?? null,
      completed: dataset.populationRun?.completed ?? null,
      failed: dataset.populationRun?.failed ?? null,
      surveyName: dataset.populationRun?.surveyName ?? null,
    },
    // Catálogo completo de Personas NÃO é enviado (ver personaIndex acima)
    // — só o nome da população, para contexto no resumo executivo.
    population: { name: dataset.population?.name ?? null },
    // Agregados COMPLETOS, nunca amostrados (ver cabeçalho do módulo).
    quantitativeMetrics: dataset.quantitativeMetrics || [],
    reactionAggregates: dataset.reactionAggregates || [],
    quantitativeOutliers,
    qualitativeEvidence,
    reactionEvidence,
    personaIndex,
    // Segmentos configurados pelo usuário: preservados por completo (n,
    // rules, quantitativeMetrics, reactionAggregates) — nunca membros
    // individuais do segmento (ver seção 9 da tarefa).
    segments: dataset.segments || [],
  };
}
