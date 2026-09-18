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
"reaction_code" deve ser EXATAMENTE um dos códigos ativos listados na seção TAXONOMIA DE REAÇÕES ATIVAS — nunca invente um código novo.
"intensity" é obrigatório quando a reação tiver intensidade habilitada, e deve ser omitido quando não tiver.

PESQUISA:
Responda à pesquisa de maneira coerente com sua experiência de leitura, respeitando os tipos e limites de cada pergunta.
Use exatamente os question_ids fornecidos na seção PESQUISA A RESPONDER — nunca modifique um id, nunca adicione sufixos, nunca crie question_ids novos.
Responda cada question_id no máximo uma vez.
Não responda perguntas inexistentes.
Se uma pergunta NÃO for obrigatória e você não tiver uma resposta para ela, OMITA a entrada em "survey_answers" — nunca envie {"question_id": "...", "value": null}. Perguntas obrigatórias devem sempre ser respondidas.

CONCISÃO:
Seja direto e objetivo em todos os campos de texto. Evite repetições, floreios e explicações desnecessárias. Respeite os limites de itens indicados no schema de saída.

FORMATO DE SAÍDA:
Responda EXCLUSIVAMENTE com um único objeto JSON válido, seguindo o schema fornecido. Nenhum texto fora do JSON.
Retorne apenas o JSON bruto (raw JSON only). Não use Markdown. Não envolva o JSON em blocos de código (não use \`\`\`json nem \`\`\`).`;

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

function formatOutputSchema(survey, reactions) {
  const exampleQuestionId = survey.questions[0] ? survey.questions[0].id : "<question_id>";
  const questionIds = survey.questions.map((q) => q.id);
  const reactionCodes = reactions.map((r) => r.code);
  return `{
  "reactions": [
    { "reaction_code": "<CODE de reação ativa>", "intensity": <0-100, somente se a reação permitir intensidade>, "reason": "<motivo em 1 frase curta>" }
  ],
  "survey_answers": [
    { "question_id": "${exampleQuestionId}", "value": <resposta no tipo e limites da pergunta> }
  ],
  "spontaneous_notes": ["<observação espontânea, se houver>"],
  "reader_state": { "engagement": <0-100>, "curiosity": <0-100>, "fatigue": <0-100>, "confusions": [], "predictions": [] }
}

Observações:
- "reaction_code" DEVE ser exatamente um destes (nunca outro): [${reactionCodes.join(", ")}]
- "intensity" só deve aparecer para reações com intensidade habilitada (0–100); omita para as demais.
- "question_id" DEVE ser exatamente um destes (nunca outro, nunca modificado): [${questionIds.join(", ")}]
- Pergunta opcional sem resposta: OMITA a entrada em "survey_answers" (nunca envie value: null).
- "reader_state" é opcional nesta fase.

Limites de tamanho (obrigatórios — respostas mais longas serão cortadas):
- "reactions": no máximo 8 itens.
- "spontaneous_notes": no máximo 3 itens.
- "confusions" e "predictions" (dentro de reader_state): no máximo 5 itens cada.
- Respostas textuais da pesquisa devem responder à pergunta, mas de forma direta e sem repetição.`;
}

export function buildReadingPrompt({ persona, attributes, reactions, survey, text }) {
  const personaTags = persona.tags && persona.tags.length ? `\nTags: ${persona.tags.join(", ")}` : "";
  const sections = [
    section("PERSONA") +
      `Código: ${persona.code || "(sem código)"}\nNome: ${persona.name}${personaTags}`,
    section("ATRIBUTOS ESTRUTURADOS DA PERSONA (configuração canônica)") +
      formatAttributes(persona, attributes),
    section("PERFIL NARRATIVO (contexto e nuance — nunca sobrescreve os atributos)") +
      formatNarrativeProfile(persona),
  ];
  // Campo vazio nunca vira seção só com um placeholder — se a Persona não
  // tem instruções comportamentais, a seção inteira é omitida.
  if (persona.instructions) {
    sections.push(section("INSTRUÇÕES COMPORTAMENTAIS") + persona.instructions);
  }
  sections.push(
    section("TEXTO PARA LEITURA (único contexto desta execução)") +
      `<<<TEXTO INÍCIO>>>\n${text}\n<<<TEXTO FIM>>>`,
    section("TAXONOMIA DE REAÇÕES ATIVAS (nenhuma é obrigatória)") +
      formatReactions(reactions),
    section("PESQUISA A RESPONDER") +
      `${survey.name}\n${formatSurvey(survey)}`,
    section("SCHEMA DE SAÍDA (responda APENAS este JSON)") +
      formatOutputSchema(survey, reactions),
  );

  return { system: SYSTEM_INSTRUCTION, user: sections.join("\n"), promptVersion: "v1" };
}
