// ============ ReaderLab — Roteamento de modelo por finalidade (purpose) ============
// Módulo PURO (sem Deno.env/fetch/I-O) — importado pela Edge Function
// llm-proxy (Deno, ver ./index.ts) e testável direto com
// `node modelRouting.test.mjs`. Nunca decide segredos/URLs/API key; só
// resolve `purpose` -> nome de modelo e monta o payload comum/específico
// por modelo. Extraído para módulo próprio porque Deno importa .mjs/.js
// relativos sem build step, igual ao resto do projeto (sem TS aqui).

export const ALLOWED_PURPOSES = ["reader", "analyst"];
// Compatibilidade com chamadas antigas (antes de "purpose" existir): sem o
// campo, a requisição é tratada como "reader" — nunca um erro.
export const DEFAULT_PURPOSE = "reader";

import { findModel, isModelSuitableForPurpose } from "./modelCatalog.mjs";

/**
 * @param {unknown} rawPurpose
 * @returns {{ ok: true, purpose: string } | { ok: false, error: string }}
 */
export function resolvePurpose(rawPurpose) {
  if (rawPurpose === undefined || rawPurpose === null) {
    /** @type {{ ok: true, purpose: string }} */
    const result = { ok: true, purpose: DEFAULT_PURPOSE };
    return result;
  }
  if (typeof rawPurpose === "string" && ALLOWED_PURPOSES.includes(rawPurpose)) {
    /** @type {{ ok: true, purpose: string }} */
    const result = { ok: true, purpose: rawPurpose };
    return result;
  }
  /** @type {{ ok: false, error: string }} */
  const result = { ok: false, error: `"purpose" deve ser um de: ${ALLOWED_PURPOSES.join(", ")}.` };
  return result;
}

// Prioridade: LLM_READER_MODEL/LLM_ANALYST_MODEL -> LLM_MODEL (legado) ->
// defaultModel. O frontend nunca escolhe o modelo — só a `purpose`.
export function resolveModel({ purpose, readerModelEnv, analystModelEnv, legacyModelEnv, defaultModel }) {
  const readerModel = readerModelEnv || legacyModelEnv || defaultModel;
  const analystModel = analystModelEnv || legacyModelEnv || defaultModel;
  return purpose === "analyst" ? analystModel : readerModel;
}

// Capacidades conhecidas por modelo — para os dois modelos do Model Catalog
// (ver modelCatalog.mjs), a fonte de verdade é o catálogo (nunca duplicar
// `if (model === ...)` aqui); modelos fora do catálogo (ex.: DEFAULT_MODEL
// legado da OpenAI) caem no comportamento conservador que já existia antes
// do catálogo — nunca especulamos capacidades de um modelo desconhecido.
export function getModelCapabilities(model) {
  const catalogEntry = findModel(model);
  if (catalogEntry) {
    return {
      supportsReasoningEffort: catalogEntry.capabilities.reasoningEffort === true,
      supportsCustomTemperature: catalogEntry.capabilities.reasoningEffort !== true,
    };
  }
  if (model === "kimi-k3") {
    return { supportsReasoningEffort: true, supportsCustomTemperature: false };
  }
  return { supportsReasoningEffort: false, supportsCustomTemperature: true };
}

// Valida um `modelId` explicitamente escolhido pelo cliente (seção 6/33 da
// tarefa "seleção explícita de modelo") contra o Model Catalog — nunca
// aceita um modelo fora do catálogo, inativo, ou incompatível com a
// `purpose` da chamada. Nunca confia no nome do modelo vindo do body sem
// checar as três condições abaixo.
/**
 * @param {{ modelId: string, purpose: string }} params
 * @returns {{ ok: true, model: string } | { ok: false, error: string }}
 */
export function validateRequestedModel({ modelId, purpose }) {
  const model = findModel(modelId);
  if (!model) {
    /** @type {{ ok: false, error: string }} */
    const result = { ok: false, error: `"modelId" desconhecido: ${String(modelId)}.` };
    return result;
  }
  if (!model.active) {
    /** @type {{ ok: false, error: string }} */
    const result = { ok: false, error: `"modelId" não está ativo: ${modelId}.` };
    return result;
  }
  if (!isModelSuitableForPurpose(modelId, purpose)) {
    /** @type {{ ok: false, error: string }} */
    const result = { ok: false, error: `"modelId" ${modelId} não é compatível com a finalidade "${purpose}".` };
    return result;
  }
  /** @type {{ ok: true, model: string }} */
  const result = { ok: true, model: modelId };
  return result;
}

// Separa parâmetros comuns (model/messages/max_completion_tokens/
// response_format) dos específicos por modelo (reasoning_effort/
// temperature) — nunca envia um parâmetro exclusivo de K3 para outro modelo.
/**
 * @param {{ model: string, messages: Array<{role: string, content: string}>, reasoningEffort?: string, maxCompletionTokens?: number|null, jsonMode?: boolean }} params
 * @returns {{ model: string, messages: Array<{role: string, content: string}>, temperature?: number, reasoning_effort?: string, max_completion_tokens?: number, response_format?: { type: string } }}
 */
export function buildUpstreamPayload({ model, messages, reasoningEffort, maxCompletionTokens, jsonMode }) {
  const capabilities = getModelCapabilities(model);
  /** @type {{ model: string, messages: Array<{role: string, content: string}>, temperature?: number, reasoning_effort?: string, max_completion_tokens?: number, response_format?: { type: string } }} */
  const payload = { model, messages };
  if (capabilities.supportsCustomTemperature) payload.temperature = 0.7;
  if (capabilities.supportsReasoningEffort) payload.reasoning_effort = reasoningEffort;
  if (maxCompletionTokens) payload.max_completion_tokens = maxCompletionTokens;
  if (jsonMode) payload.response_format = { type: "json_object" };
  return payload;
}
