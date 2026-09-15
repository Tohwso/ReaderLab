// ============ ReaderLab — Validação da resposta da LLM ============
// Nunca confiar no JSON recebido: rejeita reação desconhecida, id de
// pergunta desconhecido, valores fora da escala configurada e tipos errados.
//
// Limites de tamanho (ver llm/promptBuilder.js, seção SCHEMA DE SAÍDA): o
// prompt já instrui o modelo a respeitá-los, mas nunca confiamos apenas na
// instrução — os arrays são cortados defensivamente aqui (sem falhar a
// validação por isso, já que exceder o limite não torna a resposta inválida
// como contrato, só maior que o necessário).
const MAX_REACTIONS = 8;
const MAX_SPONTANEOUS_NOTES = 3;
const MAX_READER_STATE_LIST = 5; // confusions / predictions

export function validateLLMResponse(parsed, { reactions, survey }) {
  const errors = [];
  const reactionByCode = new Map(reactions.map((r) => [r.code, r]));
  const questionById = new Map(survey.questions.map((q) => [q.id, q]));
  const clean = { reactions: [], surveyAnswers: [], spontaneousNotes: [], readerState: null };

  // ------------------------------------------------------------ reactions
  if (!Array.isArray(parsed.reactions)) {
    errors.push('"reactions" deve ser uma lista.');
  } else {
    for (const r of parsed.reactions) {
      const code = r && r.reaction_code;
      const def = reactionByCode.get(code);
      if (!def) { errors.push(`Reação desconhecida: "${code}".`); continue; }
      let intensity = null;
      if (def.intensityEnabled) {
        const n = Number(r.intensity);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          errors.push(`Intensidade inválida para ${code} (esperado 0–100).`);
          continue;
        }
        intensity = Math.round(n);
      }
      clean.reactions.push({
        reactionCode: code,
        intensity,
        reason: typeof r.reason === "string" ? r.reason : "",
      });
    }
    if (clean.reactions.length > MAX_REACTIONS) clean.reactions = clean.reactions.slice(0, MAX_REACTIONS);
  }

  // ------------------------------------------------------- survey_answers
  if (!Array.isArray(parsed.survey_answers)) {
    errors.push('"survey_answers" deve ser uma lista.');
  } else {
    for (const a of parsed.survey_answers) {
      const q = a && questionById.get(a.question_id);
      if (!q) { errors.push(`ID de pergunta desconhecido: "${a && a.question_id}".`); continue; }
      const v = a.value;
      const label = `"${q.text.slice(0, 50)}${q.text.length > 50 ? "…" : ""}"`;
      switch (q.type) {
        case "scale":
        case "number": {
          const n = Number(v);
          if (!Number.isFinite(n)) { errors.push(`Resposta não numérica para ${label}.`); continue; }
          if (n < q.min || n > q.max) { errors.push(`Valor ${n} fora da escala ${q.min}–${q.max} em ${label}.`); continue; }
          clean.surveyAnswers.push({ questionId: q.id, value: n });
          break;
        }
        case "boolean":
          if (typeof v !== "boolean") { errors.push(`Resposta deve ser true/false em ${label}.`); continue; }
          clean.surveyAnswers.push({ questionId: q.id, value: v });
          break;
        case "single_choice":
          if (!q.options.includes(v)) { errors.push(`Opção inválida em ${label}.`); continue; }
          clean.surveyAnswers.push({ questionId: q.id, value: v });
          break;
        case "multiple_choice": {
          if (!Array.isArray(v) || v.some((o) => !q.options.includes(o))) {
            errors.push(`Opções inválidas em ${label}.`);
            continue;
          }
          clean.surveyAnswers.push({ questionId: q.id, value: [...v] });
          break;
        }
        default: // short_text / long_text
          if (typeof v !== "string") { errors.push(`Resposta deve ser texto em ${label}.`); continue; }
          clean.surveyAnswers.push({ questionId: q.id, value: v });
      }
    }
  }

  // ----------------------------------------------------- spontaneous_notes
  if (parsed.spontaneous_notes != null) {
    if (!Array.isArray(parsed.spontaneous_notes)) {
      errors.push('"spontaneous_notes" deve ser uma lista.');
    } else {
      clean.spontaneousNotes = parsed.spontaneous_notes.filter((n) => typeof n === "string").map(String).slice(0, MAX_SPONTANEOUS_NOTES);
    }
  }

  // ----------------------------------------------------------- reader_state
  if (parsed.reader_state != null) {
    if (typeof parsed.reader_state !== "object" || Array.isArray(parsed.reader_state)) {
      errors.push('"reader_state" deve ser um objeto.');
    } else {
      clean.readerState = parsed.reader_state;
      // "confusions"/"predictions" respeitam o mesmo limite de tamanho do
      // schema — cortados aqui sem falhar a validação por excedê-lo.
      if (Array.isArray(clean.readerState.confusions) && clean.readerState.confusions.length > MAX_READER_STATE_LIST) {
        clean.readerState = { ...clean.readerState, confusions: clean.readerState.confusions.slice(0, MAX_READER_STATE_LIST) };
      }
      if (Array.isArray(clean.readerState.predictions) && clean.readerState.predictions.length > MAX_READER_STATE_LIST) {
        clean.readerState = { ...clean.readerState, predictions: clean.readerState.predictions.slice(0, MAX_READER_STATE_LIST) };
      }
    }
  }

  return { ok: errors.length === 0, value: clean, errors };
}
