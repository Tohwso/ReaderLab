// ============ ReaderLab — Relatório de leitura individual (ReadingRun/ReadingResult) ============
// Este módulo é puramente de apresentação: recebe uma ReadingRun + seu ReadingResult (se existir)
// e produz o HTML do "relatório de leitura" daquele leitor sintético. Nenhum dado é inferido além
// do que já está persistido — nada de resumos gerados, nada de "conclusões" automáticas.
import * as S from "../store.js";
import * as D from "../domain.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};
const fmtDuration = (a, b) => {
  if (!a || !b) return "—";
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`;
};
const runStatusBadge = (status) => {
  const cls = { COMPLETED: "ok", FAILED: "bad", RUNNING: "accent", PENDING: "neutral" }[status] || "neutral";
  return `<span class="badge ${cls}">${D.RUN_STATUS[status] || esc(status)}</span>`;
};
const reactionPolarityBadge = (pol) => {
  const cls = pol === "positiva" ? "ok" : pol === "negativa" ? "bad" : "neutral";
  return `<span class="badge ${cls}">${D.POLARITIES[pol] || esc(pol)}</span>`;
};
function download(filename, content, mime = "application/json") {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
function tryParseJSON(str) {
  if (typeof str !== "string" || !str.trim()) return null;
  try { return JSON.parse(str); } catch { return null; }
}

// ---------------------------------------------------------------- Cabeçalho
function renderRunHeader(run, persona, survey, backContext) {
  const personaName = persona ? `${persona.code ? esc(persona.code) + " — " : ""}${esc(persona.name)}` : "(persona removida)";
  return `
    <div class="card run-report-header">
      ${backContext?.breadcrumb?.length ? `<div class="breadcrumb">${backContext.breadcrumb.map((b) => esc(b)).join(' <span class="faint">›</span> ')}</div>` : ""}
      <div class="run-report-head-top">
        <div>
          <h1 style="font-size:21px;margin-bottom:6px">${esc(run.title || "Resultado da leitura")}</h1>
          <div class="muted small">${runStatusBadge(run.status)}
            <span class="mono" style="margin-left:6px">${fmtDate(run.createdAt)}</span>
            <span class="faint">·</span>
            <span class="mono">${fmtDuration(run.startedAt, run.completedAt)}</span>
          </div>
        </div>
        <div class="head-actions">
          <a class="btn" href="${backContext?.href || "#/execucoes"}">${esc(backContext?.label || "Voltar às execuções")}</a>
          <button type="button" class="btn" id="rr-copy-json">Copiar JSON</button>
          <button type="button" class="btn" id="rr-download-json">Baixar JSON</button>
        </div>
      </div>
      <div class="run-report-persona">
        <div class="faint small run-report-label">Persona</div>
        <div style="font-weight:700;font-size:15.5px">${personaName}</div>
        ${persona?.shortDescription ? `<p class="muted small" style="margin-top:2px">${esc(persona.shortDescription)}</p>` : ""}
        ${persona?.tags?.length ? `<div class="tags" style="margin-top:7px">${persona.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</div>` : ""}
      </div>
      <div class="run-report-meta faint small">
        Pesquisa: <b class="muted">${esc(survey ? survey.name : "(pesquisa removida)")}</b>
        <span class="mono" style="margin-left:10px">${esc(run.provider)} / ${esc(run.model)}</span>
      </div>
    </div>`;
}

// -------------------------------------------------- Resumo da experiência
const READER_STATE_LABELS = { engagement: "Engajamento", curiosity: "Curiosidade", fatigue: "Fadiga" };
function renderReaderStateSummary(readerState) {
  if (!readerState || typeof readerState !== "object") return "";
  const keys = Object.keys(READER_STATE_LABELS).filter((k) => typeof readerState[k] === "number");
  Object.keys(readerState).forEach((k) => {
    if (!keys.includes(k) && typeof readerState[k] === "number" && !["confusions", "predictions"].includes(k)) keys.push(k);
  });
  if (!keys.length) return "";
  return `
    <div class="section-title">Resumo da experiência</div>
    <div class="metrics-grid">
      ${keys.map((k) => {
        const v = Math.round(readerState[k]);
        const pct = Math.max(0, Math.min(100, v));
        return `<div class="card metric-card">
          <div class="metric-label">${esc(READER_STATE_LABELS[k] || k)}</div>
          <div class="metric-value">${v}</div>
          <div class="metric-max faint">/100</div>
          <div class="bar" style="width:100%"><i style="width:${pct}%"></i></div>
        </div>`;
      }).join("")}
    </div>`;
}

// ------------------------------------------------------------- Reações
function renderReactions(reactions, reactionDefs) {
  if (!reactions || !reactions.length) return "";
  const sorted = [...reactions].sort((a, b) => {
    if (a.intensity == null && b.intensity == null) return 0;
    if (a.intensity == null) return 1;
    if (b.intensity == null) return -1;
    return b.intensity - a.intensity;
  });
  return `
    <div class="section-title">Reações da leitura</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${sorted.map((rr) => {
        const def = reactionDefs.find((r) => r.code === rr.reactionCode);
        const color = def ? def.color : "#8b98a9";
        const name = def ? def.name : rr.reactionCode;
        const pct = rr.intensity != null ? rr.intensity : null;
        return `<div class="card" style="padding:13px 16px">
          <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
            <span class="reaction-dot" style="background:${esc(color)}"></span>
            <b>${esc(name)}</b>
            <span class="mono faint small">${esc(rr.reactionCode)}</span>
            ${def ? reactionPolarityBadge(def.polarity) : ""}
            ${pct != null ? `<span class="mono small" style="margin-left:auto">${pct} / 100</span>` : ""}
          </div>
          ${pct != null ? `<div class="bar" style="margin:8px 0 6px"><i style="width:${pct}%"></i></div>` : ""}
          ${rr.reason ? `<p class="muted small" style="margin-top:4px">${esc(rr.reason)}</p>` : ""}
        </div>`;
      }).join("")}
    </div>`;
}

// ---------------------------------------------- Respostas: split quali/quanti
const QUANTITATIVE_TYPES = new Set(["scale", "number", "boolean"]);
function renderQuantitativeAnswers(answers, survey) {
  const items = answers.filter((ans) => {
    const q = survey?.questions.find((x) => x.id === ans.questionId);
    return q && QUANTITATIVE_TYPES.has(q.type);
  });
  if (!items.length) return "";
  return `
    <div class="section-title">Avaliações quantitativas</div>
    <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      ${items.map((ans) => {
        const q = survey.questions.find((x) => x.id === ans.questionId);
        if (q.type === "boolean") {
          return `<div class="card quant-card">
            <div class="q-label">${esc(q.text)}</div>
            <div class="q-value">${ans.value ? "Sim" : "Não"}</div>
          </div>`;
        }
        const min = q.min ?? 0, max = q.max ?? 100;
        const pct = max > min ? Math.round(((ans.value - min) / (max - min)) * 100) : 0;
        return `<div class="card quant-card">
          <div class="q-label">${esc(q.text)}</div>
          <div class="q-value">${esc(String(ans.value))} <span class="faint small">/ ${max}</span></div>
          <div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
        </div>`;
      }).join("")}
    </div>`;
}

function formatQualitativeValue(q, value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return String(value ?? "");
}
function renderQualitativeAnswers(answers, survey) {
  const items = answers.filter((ans) => {
    const q = survey?.questions.find((x) => x.id === ans.questionId);
    return !q || !QUANTITATIVE_TYPES.has(q.type);
  });
  if (!items.length) return "";
  return `
    <div class="section-title">Respostas do leitor</div>
    <div class="card qual-answers">
      ${items.map((ans) => {
        const q = survey?.questions.find((x) => x.id === ans.questionId);
        const label = q ? q.text : `(pergunta removida: ${ans.questionId})`;
        return `<div class="qual-answer">
          <div class="qual-question">${esc(label)}</div>
          <p class="qual-value">${esc(formatQualitativeValue(q, ans.value))}</p>
        </div>`;
      }).join("")}
    </div>`;
}

// --------------------------------------------------- Confusões / previsões
function renderConfusionsPredictions(readerState) {
  const confusions = Array.isArray(readerState?.confusions) ? readerState.confusions : [];
  const predictions = Array.isArray(readerState?.predictions) ? readerState.predictions : [];
  if (!confusions.length && !predictions.length) return "";
  const box = (title, icon, list) => !list.length ? "" : `
    <div class="card">
      <div class="cp-title">${icon} ${title}</div>
      <ul class="cp-list">${list.map((x) => `<li>${esc(String(x))}</li>`).join("")}</ul>
    </div>`;
  return `
    <div class="section-title">Confusões e previsões</div>
    <div class="cp-grid">
      ${box("Confusões", "?", confusions)}
      ${box("Previsões", "→", predictions)}
    </div>`;
}

// ------------------------------------------------------------- Notas
function renderSpontaneousNotes(notes) {
  if (!notes || !notes.length) return "";
  return `
    <div class="section-title">Anotações espontâneas</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${notes.map((n) => `<div class="note-callout">${esc(n)}</div>`).join("")}
    </div>`;
}

// ---------------------------------------------------------- Persona (detalhe)
function renderPersonaDetails(persona, attributeDefs) {
  if (!persona) return "";
  const fields = [
    ["Descrição narrativa", persona.narrativeDescription],
    ["Gostos", persona.tastes],
    ["Aversões", persona.aversions],
    ["Expectativas", persona.expectations],
    ["Comportamentos específicos", persona.behaviors],
    ["Contradições", persona.contradictions],
  ].filter(([, v]) => v && String(v).trim());

  const explicitIds = Object.keys(persona.attributeValues || {});
  const MAX_ATTRS = 12;
  const shown = explicitIds.slice(0, MAX_ATTRS);
  const rest = explicitIds.length - shown.length;
  const attrsHTML = shown.length ? `
    <div class="attr-bars" style="margin-top:12px">
      ${shown.map((id) => {
        const a = attributeDefs.find((x) => x.id === id);
        const v = persona.attributeValues[id];
        if (!a) return `<div class="attr-bar-row"><span class="lbl mono">${esc(id)}</span><div class="bar"><i style="width:${v}%"></i></div><span class="val">${v}</span></div>`;
        const pct = a.max > a.min ? Math.round(((v - a.min) / (a.max - a.min)) * 100) : 0;
        return `<div class="attr-bar-row"><span class="lbl">${esc(a.name)}</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div><span class="val">${v}</span></div>`;
      }).join("")}
    </div>
    ${rest > 0 ? `<p class="faint small" style="margin-top:8px">+ ${rest} outro(s) atributo(s) configurado(s)</p>` : ""}` :
    `<p class="muted small" style="margin-top:12px">Nenhum atributo explicitamente configurado nesta persona.</p>`;

  return `
    <details class="card" style="margin-top:16px">
      <summary style="cursor:pointer;font-weight:650">Sobre este leitor</summary>
      <div style="margin-top:14px">
        ${fields.map(([label, v]) => `<div style="margin-bottom:12px"><div class="faint small" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">${label}</div><p class="muted" style="white-space:pre-wrap">${esc(v)}</p></div>`).join("")}
        <div class="faint small" style="text-transform:uppercase;letter-spacing:.05em">Atributos explicitamente configurados</div>
        ${attrsHTML}
      </div>
    </details>`;
}

// ------------------------------------------------------------- Texto avaliado
function renderEvaluatedText(inputText) {
  const text = inputText || "";
  return `
    <details class="card" style="margin-top:16px">
      <summary style="cursor:pointer;font-weight:650">Texto avaliado <span class="faint small mono">(${text.length} caracteres)</span></summary>
      <p class="muted mono small" style="white-space:pre-wrap;margin-top:12px;line-height:1.7">${esc(text)}</p>
    </details>`;
}

// ---------------------------------------------------------- Detalhes técnicos
function renderTechnicalDetails(run, result, snap) {
  const parsedRaw = tryParseJSON(run.rawResponse);
  const rows = [
    ["Provider", run.provider],
    ["Modelo", run.model],
    ["Prompt version", run.promptVersion],
    ["ReadingRun ID", run.id],
    ["ReadingResult ID", result ? result.id : "—"],
    ["Data", fmtDate(run.createdAt)],
    ["Duração", fmtDuration(run.startedAt, run.completedAt)],
  ];
  return `
    <details class="card" style="margin-top:16px">
      <summary style="cursor:pointer;font-weight:650">Detalhes técnicos</summary>
      <div style="margin-top:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 18px">
        ${rows.map(([label, v]) => `<div><div class="faint small">${esc(label).toUpperCase()}</div><span class="mono small">${esc(String(v))}</span></div>`).join("")}
      </div>
      ${run.requestMetadata && Object.keys(run.requestMetadata).length ? `
        <div style="margin-top:14px">
          <div class="faint small" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">requestMetadata</div>
          <pre class="mono small" style="white-space:pre-wrap;margin:0">${esc(JSON.stringify(run.requestMetadata, null, 2))}</pre>
        </div>` : ""}
      ${snap ? `
        <details style="margin-top:14px">
          <summary style="cursor:pointer;font-weight:600">Ver snapshot da execução (persona/atributos/survey/reações congelados)</summary>
          <pre class="mono small" style="white-space:pre-wrap;margin-top:10px">${esc(JSON.stringify(snap, null, 2))}</pre>
        </details>` : ""}
      <details style="margin-top:14px">
        <summary style="cursor:pointer;font-weight:600">Ver JSON bruto</summary>
        ${run.rawResponse
          ? `<pre class="mono small" style="white-space:pre-wrap;margin-top:10px">${esc(parsedRaw ? JSON.stringify(parsedRaw, null, 2) : run.rawResponse)}</pre>`
          : `<p class="muted small" style="margin-top:10px">Nenhuma resposta recebida.</p>`}
        ${run.rawResponse ? `<div class="head-actions" style="margin-top:10px">
          <button type="button" class="btn btn-sm" id="rr-copy-raw">Copiar JSON</button>
          <button type="button" class="btn btn-sm" id="rr-download-raw">Baixar JSON</button>
        </div>` : ""}
      </details>
    </details>`;
}

// ------------------------------------------------------------- Erro
function renderErrorPanel(run) {
  return `
    <div class="info-box warn" style="margin-bottom:16px">
      <span>⚠</span>
      <span><b>Esta leitura não pôde ser concluída.</b> ${esc(run.errorMessage || "Erro não detalhado.")}</span>
    </div>`;
}

// ================================================================= Entrada
export function renderRunResultView(main, run, result, { toast, backContext } = {}) {
  const snap = run.executionSnapshot || null;
  const survey = snap?.survey || S.state.surveys.find((s) => s.id === run.surveyId);
  const persona = snap?.persona || S.state.personas.find((p) => p.id === run.personaId);
  const reactionDefs = snap?.reactions || S.state.reactions;
  const attributeDefs = snap?.attributes || S.state.attributes;

  const legacyNotice = !snap && run.status === "COMPLETED" ? `
    <div class="info-box" style="margin-bottom:16px"><span>ℹ</span>
      <span>Execução anterior à introdução do snapshot de configuração — Persona/Pesquisa/Reações exibidas abaixo refletem o estado <b>atual</b> dessas entidades, que pode ter mudado desde a execução.</span>
    </div>` : "";

  const missingResultNotice = run.status === "COMPLETED" && !result ? `
    <div class="info-box warn" style="margin-bottom:16px"><span>⚠</span>
      <span>Execução concluída, mas o resultado estruturado não foi encontrado (possível perda de dados).</span>
    </div>` : "";

  const reportBody = result ? `
    ${renderReaderStateSummary(result.readerState)}
    ${renderReactions(result.reactions, reactionDefs)}
    ${renderQuantitativeAnswers(result.surveyAnswers, survey)}
    ${renderQualitativeAnswers(result.surveyAnswers, survey)}
    ${renderConfusionsPredictions(result.readerState)}
    ${renderSpontaneousNotes(result.spontaneousNotes)}
  ` : "";

  main.innerHTML = `
    ${renderRunHeader(run, persona, survey, backContext)}
    ${run.status === "FAILED" ? renderErrorPanel(run) : ""}
    ${legacyNotice}
    ${missingResultNotice}
    ${reportBody}
    ${renderPersonaDetails(persona, attributeDefs)}
    ${renderEvaluatedText(run.inputText)}
    ${renderTechnicalDetails(run, result, snap)}
  `;

  const bundle = () => JSON.stringify({ run, result }, null, 2);
  const copyBtn = main.querySelector("#rr-copy-json");
  const dlBtn = main.querySelector("#rr-download-json");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(bundle()); toast?.("JSON copiado", "ok"); }
    catch { toast?.("Não foi possível copiar", "bad"); }
  });
  if (dlBtn) dlBtn.addEventListener("click", () => download(`readerlab-run-${run.id}.json`, bundle()));

  const rawCopyBtn = main.querySelector("#rr-copy-raw");
  const rawDlBtn = main.querySelector("#rr-download-raw");
  const parsedRaw = tryParseJSON(run.rawResponse);
  const rawContent = () => parsedRaw ? JSON.stringify(parsedRaw, null, 2) : (run.rawResponse || "");
  if (rawCopyBtn) rawCopyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(rawContent()); toast?.("JSON copiado", "ok"); }
    catch { toast?.("Não foi possível copiar", "bad"); }
  });
  if (rawDlBtn) rawDlBtn.addEventListener("click", () => download(`readerlab-run-${run.id}-raw.json`, rawContent()));
}
