// ============ ReaderLab — Formatação por versão do dataset do Research Analyst ============
// Módulo PURO (sem import de store.js/domain.js): recebe dados já
// resolvidos (ReadingRuns/Personas/Results emparelhados — ver
// `resolvedRows` em populationAnalysisDatasetBuilder.js) e monta as
// seções do dataset que DIFEREM entre analysisDatasetVersion 1 (legado) e
// 2 (compacto). Extraído do builder para ser testável em Node puro sem
// depender do client Supabase (ver populationAnasyticDatasetFormat.test.mjs).
//
// Princípio da v2 (ver builder para o restante — quantitativeMetrics/
// segments/population/populationRun não mudam de forma entre versões):
// cada informação textual longa existe UMA vez; o resto referencia por id/
// code. Isso elimina as duas maiores fontes de duplicação identificadas:
//   1) respostas qualitativas repetidas em qualitativeAnswers E de novo
//      dentro de cada individualResults[i] (v2: só em qualitativeQuestions);
//   2) questionText de cada pergunta quantitativa repetido em
//      individualResults[i].quantitativeAnswers para TODA persona (v2: mapa
//      questionId -> value, texto da pergunta já vive em quantitativeMetrics).

export function truncateText(str, max, truncatedKeys, key) {
  if (typeof str !== "string" || str.length <= max) return str;
  truncatedKeys.push(key);
  return str.slice(0, max) + "…";
}

export const attributeUnavailableLabel = (attributeId) => `Atributo histórico não disponível (${attributeId})`;

function buildAttributesMap(persona, attributeById) {
  const attributes = {};
  Object.keys(persona.attributeValues || {}).forEach((attrId) => {
    const attr = attributeById.get(attrId);
    attributes[attr ? attr.name : attributeUnavailableLabel(attrId)] = persona.attributeValues[attrId];
  });
  return attributes;
}

// -------------------------------------------------------------- reactions
// `reactionStats`: saída de computeReactionAggregates(...).stats — cada item
// { def, matches:[{run,rr,persona}], count, pct, avg, min, max }.
export function formatReactionAggregatesBase(reactionStats, validCount) {
  return reactionStats.map((s) => ({
    reactionCode: s.def.code,
    reactionName: s.def.name,
    polarity: s.def.polarity,
    readerCount: s.count,
    validReaderCount: validCount,
    percentage: s.pct,
    meanIntensity: s.avg,
    minimumIntensity: s.min,
    maximumIntensity: s.max,
  }));
}

// v1: reasons aninhados dentro de cada reactionAggregates[i].entries — uma
// cópia por reactionCode (nunca duplicada entre categorias, mas ainda a
// forma mais "pesada": personaName repetido + estrutura aninhada por reação).
export function formatReactionAggregatesV1(reactionStats, validCount, { truncatedFields, maxReasonChars }) {
  return formatReactionAggregatesBase(reactionStats, validCount).map((agg, i) => ({
    ...agg,
    entries: reactionStats[i].matches.map(({ run, rr, persona }) => ({
      personaCode: persona?.code || null,
      personaName: persona?.name || "(persona removida)",
      intensity: rr.intensity,
      reason: truncateText(rr.reason || "", maxReasonChars, truncatedFields, `reaction:${reactionStats[i].def.code}:${run.id}`),
    })),
  }));
}

// v2: coleção única e achatada (reactionAggregates fica sem "entries") —
// reasons existem em UM lugar só, referenciados por personaCode+reactionCode.
export function formatReactionEntries(reactionStats, { truncatedFields, maxReasonChars }) {
  return reactionStats.flatMap((s) => s.matches.map(({ run, rr, persona }) => ({
    personaCode: persona?.code || null,
    reactionCode: s.def.code,
    intensity: rr.intensity,
    reason: truncateText(rr.reason || "", maxReasonChars, truncatedFields, `reaction:${s.def.code}:${run.id}`),
  })));
}

// ----------------------------------------------------------- qualitativas
// `resolvedRows`: [{ runId, persona, result }] — já filtrado para runs
// COMPLETED com persona e result resolvidos (ver builder).
export function formatQualitativeAnswersV1(qualitativeQuestionDefs, resolvedRows, { truncatedFields, maxAnswerChars }) {
  return qualitativeQuestionDefs.map((q) => ({
    questionId: q.id,
    questionText: q.text,
    answers: resolvedRows.map(({ runId, persona, result }) => {
      const ans = result.surveyAnswers.find((a) => a.questionId === q.id);
      if (!ans || ans.value == null || ans.value === "") return null;
      const raw = Array.isArray(ans.value) ? ans.value.join(", ") : String(ans.value);
      return {
        personaCode: persona.code || null,
        personaName: persona.name || "(persona removida)",
        answer: truncateText(raw, maxAnswerChars, truncatedFields, `qualitative:${q.id}:${runId}`),
      };
    }).filter(Boolean),
  }));
}

// v2: mesma agregação por pergunta, sem personaName (resolvível via
// individualResults/population.personas) e chave "value" (nunca duplicada
// de novo dentro de individualResults — ver formatIndividualResultsV2).
export function formatQualitativeQuestionsV2(qualitativeQuestionDefs, resolvedRows, { truncatedFields, maxAnswerChars }) {
  return qualitativeQuestionDefs.map((q) => ({
    questionId: q.id,
    questionText: q.text,
    answers: resolvedRows.map(({ runId, persona, result }) => {
      const ans = result.surveyAnswers.find((a) => a.questionId === q.id);
      if (!ans || ans.value == null || ans.value === "") return null;
      const raw = Array.isArray(ans.value) ? ans.value.join(", ") : String(ans.value);
      return {
        personaCode: persona.code || null,
        value: truncateText(raw, maxAnswerChars, truncatedFields, `qualitative:${q.id}:${runId}`),
      };
    }).filter(Boolean),
  }));
}

// -------------------------------------------------------- individualResults
export function formatIndividualResultsV1(resolvedRows, { attributeById, quantitativeQuestionDefs, qualitativeQuestionDefs }) {
  return resolvedRows.map(({ persona, result }) => ({
    personaCode: persona.code || null,
    personaName: persona.name,
    attributes: buildAttributesMap(persona, attributeById),
    quantitativeAnswers: quantitativeQuestionDefs.map((q) => ({
      questionText: q.text,
      value: result.surveyAnswers.find((a) => a.questionId === q.id)?.value ?? null,
    })).filter((x) => x.value != null),
    reactions: result.reactions.map((rr) => ({ reactionCode: rr.reactionCode, intensity: rr.intensity })),
    qualitativeAnswers: qualitativeQuestionDefs.map((q) => ({
      questionText: q.text,
      answer: result.surveyAnswers.find((a) => a.questionId === q.id)?.value ?? null,
    })).filter((x) => x.answer != null && x.answer !== ""),
    readerState: result.readerState || null,
  }));
}

// v2: quantitativeAnswers vira mapa questionId->value (o texto da pergunta
// já existe em quantitativeMetrics — nunca repetido aqui); reactionCodes
// substitui a lista {reactionCode,intensity} (intensidade/reason vivem em
// reactionEntries); qualitativeAnswers é OMITIDO (já existe em
// qualitativeQuestions, nunca duplicado).
export function formatIndividualResultsV2(resolvedRows, { attributeById, quantitativeQuestionDefs }) {
  return resolvedRows.map(({ persona, result }) => {
    const quantitativeAnswers = {};
    quantitativeQuestionDefs.forEach((q) => {
      const v = result.surveyAnswers.find((a) => a.questionId === q.id)?.value;
      if (v != null) quantitativeAnswers[q.id] = v;
    });
    return {
      personaCode: persona.code || null,
      personaName: persona.name,
      attributes: buildAttributesMap(persona, attributeById),
      quantitativeAnswers,
      reactionCodes: result.reactions.map((rr) => rr.reactionCode),
      readerState: result.readerState || null,
    };
  });
}
