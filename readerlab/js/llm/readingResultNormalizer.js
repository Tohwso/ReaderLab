// ============ ReaderLab — Normalização da resposta bruta do ReadingRun ============
// Etapa explícita entre "raw LLM response" e "JSON.parse": corrige apenas
// desvios de formatação ÓBVIOS e mecânicos (a LLM envolveu o JSON em
// fences Markdown) — nunca tenta "adivinhar" JSON dentro de texto solto.
// Se a resposta tiver texto explicativo significativo antes/depois do
// JSON, esta função deliberadamente NÃO tenta extraí-lo: o JSON.parse
// subsequente vai falhar e a resposta continua sendo INVALID_RESPONSE
// (comportamento correto — ver critério 3 do pedido original).
//
// Reconhece tanto ```json\n{...}\n``` quanto ```\n{...}\n``` (ou variações
// com espaços/quebras de linha antes/depois das fences). Não altera nada
// do conteúdo interno — só remove as fences externas.
const FENCE_RE = /^\s*```[ \t]*[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```\s*$/;

// normalizeReadingResultResponse(rawText) -> { normalizedText, warnings }
// `warnings` é sempre um array (vazio quando nada precisou ser corrigido).
export function normalizeReadingResultResponse(rawText) {
  const warnings = [];
  let text = typeof rawText === "string" ? rawText : "";

  const fenceMatch = text.match(FENCE_RE);
  if (fenceMatch) {
    text = fenceMatch[1];
    warnings.push("markdown_fence_removed");
  }

  return { normalizedText: text.trim(), warnings };
}
