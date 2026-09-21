// ============ ReaderLab — Diálogo de seleção de modelo LLM ============
// Componente AUTOCONTIDO (mesmo padrão de components/runResultView.js: seus
// próprios helpers locais, sem importar de ui.js) que pede ao usuário para
// escolher explicitamente um modelo do Model Catalog ANTES de qualquer
// execução real de LLM (ReadingRun avulsa, PopulationRun, Research
// Analyst) — nunca escolhe "o melhor"/"o mais barato" sozinho, nunca abre
// um fallback automático: se o usuário cancelar, quem chamou deve abortar
// a execução.
//
// showLLMExecutionDialog(...) -> Promise<{ modelId, pricing } | null>
import { getModelCatalog, filterModelsForPurpose } from "../llm/modelCatalog.js";
import { estimateCostForTokens, getHistoricalUsageStats } from "../llm/costEstimate.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtPrice(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${esc(currency || "")}/1M tok`;
}

function fmtCost(cost) {
  if (!cost) return "—";
  return `≈ ${cost.totalCost.toLocaleString("pt-BR", { maximumFractionDigits: 4 })} ${esc(cost.currency || "")}`;
}

function modelCardHtml(model, { estimatedInputTokens, estimatedOutputTokens, populationSize, purpose, runs }, selected) {
  const perCall = estimateCostForTokens({ pricing: model.pricing, estimatedInputTokens, estimatedOutputTokens });
  const total = populationSize > 1 && perCall ? { ...perCall, totalCost: perCall.totalCost * populationSize } : perCall;
  const historical = runs ? getHistoricalUsageStats({ purpose, modelId: model.id, runs }) : null;
  return `
    <label class="card model-card ${selected ? "selected" : ""}" style="display:block;cursor:pointer;margin-bottom:10px">
      <input type="radio" name="llm-model" value="${esc(model.id)}" ${selected ? "checked" : ""} style="margin-right:8px">
      <strong>${esc(model.displayName)}</strong>
      <span class="tags">${(model.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</span>
      <div class="small muted" style="margin-top:4px">
        Contexto: ${esc(String(model.contextTokens))} tokens ·
        Input: ${fmtPrice(model.pricing?.inputPerMillionTokens, model.pricing?.currency)} ·
        Output: ${fmtPrice(model.pricing?.outputPerMillionTokens, model.pricing?.currency)}
      </div>
      <div class="small" style="margin-top:4px">
        Custo estimado desta execução: <strong>${fmtCost(total)}</strong>
        ${populationSize > 1 ? ` (${populationSize} leitores)` : ""}
      </div>
      ${historical ? `<div class="small faint" style="margin-top:2px">Histórico: ${historical.sampleCount} execução(ões) anteriores${historical.fewSamples ? " — poucas amostras, estimativa pouco confiável" : ""}.</div>` : ""}
    </label>`;
}

// `runs` (opcional): array já filtrável de execuções passadas (ver
// getHistoricalUsageStats em costEstimate.js) — só para exibir uma nota de
// histórico, nunca obrigatório.
export function showLLMExecutionDialog({ purpose, estimatedInputTokens = 0, estimatedOutputTokens = 0, populationSize = 1, runs = null } = {}) {
  return new Promise(async (resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>Escolha o modelo LLM</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></div>
        <form class="modal-form" novalidate>
          <div class="modal-body" id="llm-dialog-body"><p class="muted">Carregando modelos disponíveis…</p></div>
          <div class="modal-foot">
            <button type="button" class="btn" data-close>Cancelar</button>
            <button type="submit" class="btn btn-primary" id="llm-dialog-confirm" disabled>Confirmar e executar</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);

    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => finish(null)));

    const body = overlay.querySelector("#llm-dialog-body");
    const confirmBtn = overlay.querySelector("#llm-dialog-confirm");
    let models = [];
    let availabilityUnverified = false;
    try {
      const catalog = await getModelCatalog();
      models = filterModelsForPurpose(catalog.models, purpose);
      availabilityUnverified = catalog.availabilityUnverified === true;
    } catch (_err) {
      models = [];
    }

    if (resolved) return; // usuário já cancelou enquanto a lista carregava

    if (!models.length) {
      body.innerHTML = `<div class="info-box bad">Nenhum modelo disponível para esta finalidade no momento. Tente novamente mais tarde.</div>`;
      return;
    }

    let selectedId = models[0].id;
    const renderCards = () => {
      body.innerHTML =
        (availabilityUnverified ? `<div class="info-box warn" style="margin-bottom:10px">Não foi possível confirmar a disponibilidade dos modelos com o provedor agora — exibindo o catálogo conhecido.</div>` : "") +
        models.map((m) => modelCardHtml(m, { estimatedInputTokens, estimatedOutputTokens, populationSize, purpose, runs }, m.id === selectedId)).join("");
      body.querySelectorAll('input[name="llm-model"]').forEach((input) => {
        input.addEventListener("change", (e) => { selectedId = e.target.value; renderCards(); });
      });
    };
    renderCards();
    confirmBtn.disabled = false;

    overlay.querySelector(".modal-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const model = models.find((m) => m.id === selectedId);
      if (!model) return;
      finish({ modelId: model.id, pricing: model.pricing });
    });
  });
}
