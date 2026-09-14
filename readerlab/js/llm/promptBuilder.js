// ============ ReaderLab — Prompt Builder ============
// Módulo PURO (sem I/O, sem secrets): combina Persona + atributos
// explicitamente definidos + perfil narrativo + texto + taxonomia de reações
// + pesquisa + schema de saída. Como é puro, pode ser reutilizado
// server-side (no proxy) no futuro sem nenhuma alteração.

const SYSTEM_INSTRUCTION = `Você está participando de um experimento de leitura.

Você deve responder como o leitor sintético definido pela Persona fornecida.
Você é um leitor, não um editor profissional.
Não tente agradar ao autor.
Não procure problemas artificialmente.
Reaja ao texto de acordo com os gostos, aversões, tolerâncias, orientações e comportamentos desta Persona.

REGRA FUNDAMENTAL DA PERSONA:
Os atributos estruturados são a configuração canônica da Persona. Os campos narrativos (descrição, gostos, aversões, expectativas, comportamentos, contradições, instruções) adicionam contexto e nuance — mas NUNCA sobrescrevem silenciosamente os atributos estruturados.

CONTEXTO:
Utilize somente o texto fornecido nesta execução.
Não invente capítulos anteriores ou posteriores.
Não assuma informações não presentes no contexto.

REAÇÕES:
Nem toda categoria de reação precisa ocorrer.
Registre somente reações realmente provocadas pelo texto.
"reactions": [] é uma resposta perfeitamente válida.

PESQUISA:
Responda à pesquisa de maneira coerente com sua experiência de leitura, respeitando os tipos e limites de cada pergunta.

FORMATO DE SAÍDA:
Responda EXCLUSIVAMENTE com um único objeto JSON válido, seguindo o schema fornecido. Nenhum texto fora do JSON.`;

const section = (title) => `\n===== ${title} =====\n`;

function formatAttributes(persona, attributes) {
  // Apenas atributos EXPLICITAMENTE definidos — omissões não viram "50".
  const defined = attributes.filter((a) => persona.attributeValues && persona.attributeValues[a.id] != null);
  if (!defined.length) return "(nenhum atributo estruturado definido)";
  return defined.map((a) => {
    const v = persona.attributeValues[a.id];
    const lines = [`• ${a.name}: ${v}/${a.min}–${a.max}`];
    if (a.minLabel) lines.push(`   ${a.min} = ${a.minLabel}`);
    if (a.maxLabel) lines.push(`   ${a.max} = ${a.maxLabel}`);
    return lines.join("\n");
  }).join("\n");
}

function formatNarrativeProfile(persona) {
  const parts = [];
  if (persona.shortDescription) parts.push(`Descrição curta: ${persona.shortDescription}`);
  if (persona.narrativeDescription) parts.push(`Descrição narrativa: ${persona.narrativeDescription}`);
  if (persona.tastes) parts.push(`Gostos: ${persona.tastes}`);
  if (persona.aversions) parts.push(`Aversões: ${persona.aversions}`);
  if (persona.expectations) parts.push(`Expectativas ao iniciar uma leitura: ${persona.expectations}`);
  if (persona.behaviors) parts.push(`Comportamentos específicos: ${persona.behaviors}`);
  if (persona.contradictions) parts.push(`Contradições: ${persona.contradictions}`);
  return parts.length ? parts.join("\n") : "(sem perfil narrativo)";
}

function formatReactions(reactions) {
  if (!reactions.length) return "(nenhuma reação ativa na taxonomia)";
  return reactions.map((r) => {
    const intensity = r.intensityEnabled ? "intensidade 0–100 habilitada" : "sem intensidade";
    const desc = r.description ? ` — ${r.description}` : "";
    return `- ${r.code} — ${r.name} (${r.polarity}; ${intensity})${desc}`;
  }).join("\n");
}

const QUESTION_TYPE_HINT = {
  short_text: "responda com um texto curto",
  long_text: "responda com um texto (pode ser longo)",
  number: "responda com um número",
  scale: "responda com um número inteiro na escala indicada",
  single_choice: "responda com exatamente uma das opções",
  multiple_choice: "responda com uma lista das opções aplicáveis",
  boolean: "responda com true ou false",
};

function formatSurvey(survey) {
  if (!survey.questions.length) return "(pesquisa sem perguntas)";
  return survey.questions.map((q, i) => {
    const bits = [QUESTION_TYPE_HINT[q.type] || q.type];
    if (q.type === "scale" || q.type === "number") bits.push(`escala ${q.min}–${q.max}`);
    if (q.type === "single_choice" || q.type === "multiple_choice") bits.push(`opções: ${q.options.join(" | ")}`);
    if (q.required) bits.push("OBRIGATÓRIA");
    return `${i + 1}. [id: ${q.id}] ${q.text} (${bits.join("; ")})`;
  }).join("\n");
}

function formatOutputSchema(survey) {
  const exampleQuestionId = survey.questions[0] ? survey.questions[0].id : "<question_id>";
  return `{
  "reactions": [
    { "reaction_code": "<CODE de reação ativa>", "intensity": <0-100, somente se a reação permitir intensidade>, "reason": "<por que esta reação ocorreu>" }
  ],
  "survey_answers": [
    { "question_id": "${exampleQuestionId}", "value": <resposta no tipo e limites da pergunta> }
  ],
  "spontaneous_notes": ["<observação espontânea do leitor, se houver>"],
  "reader_state": { "engagement": <0-100>, "curiosity": <0-100>, "fatigue": <0-100>, "confusions": [], "predictions": [] }
}

Observações:
- "reactions" pode ser [].
- "intensity" só deve aparecer para reações com intensidade habilitada (0–100).
- Em "survey_answers", use os ids de pergunta listados na seção PESQUISA.
- "spontaneous_notes" pode ser [].
- "reader_state" é opcional nesta fase.`;
}

export function buildReadingPrompt({ persona, attributes, reactions, survey, text }) {
  const user = [
    section("PERSONA") +
      `Código: ${persona.code || "(sem código)"}\nNome: ${persona.name}\nTags: ${(persona.tags || []).join(", ") || "(nenhuma)"}`,
    section("ATRIBUTOS ESTRUTURADOS DA PERSONA (configuração canônica)") +
      formatAttributes(persona, attributes),
    section("PERFIL NARRATIVO (contexto e nuance — nunca sobrescreve os atributos)") +
      formatNarrativeProfile(persona),
    section("INSTRUÇÕES COMPORTAMENTAIS") +
      (persona.instructions || "(nenhuma instrução específica)"),
    section("TEXTO PARA LEITURA (único contexto desta execução)") +
      `<<<TEXTO INÍCIO>>>\n${text}\n<<<TEXTO FIM>>>`,
    section("TAXONOMIA DE REAÇÕES ATIVAS (nenhuma é obrigatória)") +
      formatReactions(reactions),
    section("PESQUISA A RESPONDER") +
      `${survey.name}\n${formatSurvey(survey)}`,
    section("SCHEMA DE SAÍDA (responda APENAS este JSON)") +
      formatOutputSchema(survey),
  ].join("\n");

  return { system: SYSTEM_INSTRUCTION, user, promptVersion: "v1" };
}
