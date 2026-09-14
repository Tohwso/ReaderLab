// ============ ReaderLab — Validação da resposta da LLM ============
// Nunca confiar no JSON recebido: rejeita reação desconhecida, id de
// pergunta desconhecido, valores fora da escala configurada e tipos errados.

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
      clean.spontaneousNotes = parsed.spontaneous_notes.filter((n) => typeof n === "string").map(String);
    }
  }

  // ----------------------------------------------------------- reader_state
  if (parsed.reader_state != null) {
    if (typeof parsed.reader_state !== "object" || Array.isArray(parsed.reader_state)) {
      errors.push('"reader_state" deve ser um objeto.');
    } else {
      clean.readerState = parsed.reader_state;
    }
  }

  return { ok: errors.length === 0, value: clean, errors };
}
