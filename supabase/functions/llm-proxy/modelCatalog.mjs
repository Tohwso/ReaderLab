// ============ ReaderLab — Catálogo de modelos LLM permitidos ============
// Módulo PURO (sem Deno.env/fetch/I-O) — fonte única de verdade sobre QUAIS
// modelos existem, seus preços e capacidades. Testável direto com
// `node modelCatalog.test.mjs`, importado pelo Deno via path relativo
// (index.ts) exatamente como modelRouting.mjs.
//
// NUNCA adicionar um modelo especulativo/desconhecido aqui — cada entrada
// deve corresponder a um modelo real já em uso/testado no ReaderLab.
// Preços são cadastrados manualmente (nunca via scraping em runtime da
// página de pricing do provedor) — `pricingUpdatedAt` documenta quando
// cada preço foi conferido pela última vez contra a fonte oficial, para
// permitir revisão periódica. `cachedInputPerMillionTokens: null` significa
// "preço de cache ainda não confirmado" — nesse caso o custo de cache NUNCA
// é calculado (ver readerlab/js/llm/costEstimate.js), o cálculo cai para o
// preço de input normal.

export const MODEL_CATALOG = [
  {
    id: "kimi-k2.6",
    displayName: "Kimi K2.6",
    provider: "moonshot",
    active: true,
    category: "econômico",
    contextTokens: 256_000,
    pricing: {
      currency: "CNY",
      inputPerMillionTokens: 6.5,
      cachedInputPerMillionTokens: null, // TODO: confirmar preço de cache oficial antes de habilitar
      outputPerMillionTokens: 27,
      pricingUpdatedAt: "2026-09-21",
    },
    capabilities: {
      jsonMode: true,
      thinkingToggle: true,
      reasoningEffort: false,
      maxCompletionTokens: true,
      customTemperature: false,
      suitableForReader: true,
      suitableForAnalyst: true,
    },
    tags: ["rápido", "econômico"],
  },
  {
    id: "kimi-k3",
    displayName: "Kimi K3",
    provider: "moonshot",
    active: true,
    category: "alta capacidade",
    contextTokens: 1_000_000,
    pricing: {
      currency: "CNY",
      inputPerMillionTokens: 20,
      cachedInputPerMillionTokens: null, // TODO: confirmar preço de cache oficial antes de habilitar
      outputPerMillionTokens: 100,
      pricingUpdatedAt: "2026-09-21",
    },
    capabilities: {
      jsonMode: true,
      thinkingToggle: false,
      alwaysThinking: true,
      reasoningEffort: true,
      maxCompletionTokens: true,
      customTemperature: false,
      suitableForReader: true,
      suitableForAnalyst: true,
    },
    tags: ["reasoning", "alta capacidade"],
  },
];

export function getActiveModels() {
  return MODEL_CATALOG.filter((m) => m.active);
}

export function findModel(modelId) {
  return MODEL_CATALOG.find((m) => m.id === modelId) || null;
}

export function isModelActive(modelId) {
  const model = findModel(modelId);
  return !!model && model.active === true;
}

// purpose "reader"|"analyst" -> qual flag de capability checar. Qualquer
// outro valor é tratado como incompatível (nunca assume permissivo).
export function isModelSuitableForPurpose(modelId, purpose) {
  const model = findModel(modelId);
  if (!model) return false;
  if (purpose === "analyst") return model.capabilities.suitableForAnalyst === true;
  if (purpose === "reader") return model.capabilities.suitableForReader === true;
  return false;
}

// Nunca repassar campos internos/futuros não previstos aqui — o frontend
// só recebe exatamente o que precisa para exibir e estimar custo.
export function sanitizeModelForClient(model) {
  const { id, displayName, provider, category, contextTokens, pricing, capabilities, tags } = model;
  return { id, displayName, provider, category, contextTokens, pricing, capabilities, tags };
}

// Interseção segura (seção 4 da task): só modelos presentes tanto no
// catálogo ativo do ReaderLab quanto na lista retornada pelo provider
// ficam selecionáveis — nunca confiar cegamente no catálogo (modelo pode
// ter sido descontinuado) nem no provider (pode listar modelos que o
// ReaderLab não suporta/testou).
export function intersectWithProviderModels(activeModels, providerModelIds) {
  const providerSet = new Set(providerModelIds || []);
  return activeModels.filter((m) => providerSet.has(m.id));
}
