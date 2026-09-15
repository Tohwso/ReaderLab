// ============ ReaderLab — Interface (views e componentes) ============
import * as S from "./store.js";
import * as D from "./domain.js";
import { persistenceMode, signOut } from "./db.js";
import { getLLMConfig } from "./llm/provider.js";
import { renderRunResultView } from "./components/runResultView.js";
import { executeReadingRun, executePopulationRun, resumePopulationRun, cancelPopulationRun, isPopulationRunActive } from "./engine.js";
import { SEGMENT_RULE_OPS, filterPersonasBySegment, computeQuestionStats, computeReactionAggregates } from "./analytics/populationMetrics.js";
import { runPopulationAnalysis } from "./analysisEngine.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
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
const options = (obj, selected) =>
  Object.entries(obj).map(([v, l]) => `<option value="${v}" ${v === selected ? "selected" : ""}>${l}</option>`).join("");

// ------------------------------------------------------------------ Login
export function renderLogin({ onSubmit }) {
  document.getElementById("app").innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="brand" style="justify-content:center;padding-bottom:6px">
          <div class="brand-mark">R</div>
          <div><div class="brand-name">ReaderLab</div><div class="brand-sub">Synthetic Readers</div></div>
        </div>
        <p class="muted small" style="text-align:center;margin:0 0 20px">Acesso restrito. Sua conta é criada pelo administrador no Supabase — não há cadastro público.</p>
        <form id="login-form" novalidate>
          <div class="field">
            <label for="login-email">E-mail</label>
            <input type="email" id="login-email" autocomplete="username" required>
          </div>
          <div class="field">
            <label for="login-password">Senha</label>
            <input type="password" id="login-password" autocomplete="current-password" required>
          </div>
          <div id="login-error" class="info-box warn" style="display:none;margin-bottom:14px"></div>
          <button type="submit" class="btn btn-primary" id="login-submit" style="width:100%;justify-content:center">Entrar</button>
        </form>
      </div>
    </div>`;
  const form = $("#login-form");
  const errBox = $("#login-error");
  const submitBtn = $("#login-submit");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    errBox.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.textContent = "Entrando…";
    try {
      const message = await onSubmit(email, password);
      if (message) {
        errBox.style.display = "flex";
        errBox.innerHTML = `<span>⚠</span><span>${esc(message)}</span>`;
      }
    } catch (err) {
      errBox.style.display = "flex";
      errBox.innerHTML = `<span>⚠</span><span>${esc(String(err && err.message || err))}</span>`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Entrar";
    }
  });
  $("#login-email").focus();
}

// ------------------------------------------------------------------ Toasts
export function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.style.transition = ".35s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 380); }, 2600);
}

// ------------------------------------------------------------------ Modal
function openModal({ title, body, onSubmit, submitLabel = "Salvar", wide = false }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></div>
      <form class="modal-form" novalidate>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          <button type="button" class="btn" data-close>Cancelar</button>
          <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  $$("[data-close]", overlay).forEach((b) => b.addEventListener("click", close));
  $(".modal-form", overlay).addEventListener("submit", (e) => {
    e.preventDefault();
    const keep = onSubmit($(".modal-form", overlay), close);
    if (keep !== false) close();
  });
  const first = $("input, select, textarea", overlay);
  if (first) first.focus();
  return close;
}

function download(filename, content, mime = "application/json") {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

// ----------------------------------------------------------------- Layout
const NAV = [
  ["#/dashboard", "Dashboard", null],
  ["#/personas", "Personas", "personas"],
  ["#/atributos", "Atributos", "attributes"],
  ["#/reacoes", "Reações", "reactions"],
  ["#/pesquisas", "Pesquisas", "surveys"],
  ["#/execucoes", "Execuções", "runs"],
  ["#/populacoes", "Populações", "populations"],
  ["#/tags", "Tags", "tags"],
  ["#/dados", "Dados", null],
];
const countFor = (key) =>
  key === "personas" ? S.state.personas.length
  : key === "attributes" ? S.state.attributes.length
  : key === "reactions" ? S.state.reactions.length
  : key === "surveys" ? S.state.surveys.length
  : key === "runs" ? S.state.runs.length
  : key === "populations" ? S.state.populations.length
  : key === "tags" ? S.state.tags.length : null;

export function renderApp() {
  $("#app").innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">R</div>
          <div><div class="brand-name">ReaderLab</div><div class="brand-sub">Synthetic Readers</div></div>
        </div>
        <div class="nav-section">Laboratório</div>
        <nav id="nav">
          ${NAV.map(([href, label, key]) => `
            <a class="nav-item" href="${href}" data-nav="${href}">
              <span>${label}</span>${key !== null ? `<span class="count">${countFor(key)}</span>` : ""}
            </a>`).join("")}
        </nav>
        <div class="sidebar-foot">
          Backend: Supabase<br>LLM: proxy seguro (Edge Function)
          <div style="margin-top:10px"><button type="button" class="btn btn-ghost btn-sm" id="logout-btn">Sair</button></div>
        </div>
      </aside>
      <div class="main-col">
        ${persistenceMode !== "supabase" ? `
        <div class="info-box warn" style="margin-bottom:18px">
          <span>⚠</span>
          <span><b>Backend indisponível</b> — não foi possível confirmar a conexão com o Supabase. Os dados podem não estar sendo persistidos. Verifique js/config.js e recarregue.</span>
        </div>` : ""}
        <main class="main" id="main"></main>
      </div>
    </div>`;
  $("#logout-btn").addEventListener("click", () => signOut());
  window.addEventListener("hashchange", renderRoute);
  renderRoute();
}

// Intervalo de polling da tela de acompanhamento de PopulationRun — só uma
// rota por vez o mantém vivo; qualquer navegação (inclusive re-render da
// mesma rota) o encerra antes de montar a próxima view.
let activePoll = null;

export function renderRoute() {
  if (activePoll) { clearInterval(activePoll); activePoll = null; }
  const hash = location.hash || "#/dashboard";
  const [pathPart, queryStr] = hash.split("?");
  const query = Object.fromEntries(new URLSearchParams(queryStr || ""));
  $$("#nav .nav-item").forEach((a) => a.classList.toggle("active", a.dataset.nav === pathPart || (a.dataset.nav !== "#/dashboard" && pathPart.startsWith(a.dataset.nav))));
  const parts = pathPart.replace(/^#\//, "").split("/");
  const route = parts[0] || "dashboard";
  const param = parts[1] ? decodeURIComponent(parts[1]) : null;
  const main = $("#main");
  if (!main) return;
  window.scrollTo(0, 0);
  if (route === "personas" && param) return viewPersonaForm(main, param);
  switch (route) {
    case "personas": return viewPersonas(main);
    case "atributos": return viewAttributes(main);
    case "reacoes": return viewReactions(main);
    case "pesquisas": return param ? viewSurveyEditor(main, param) : viewSurveys(main);
    case "execucoes":
      if (param === "nova") return viewNewRun(main);
      return param ? viewRunDetail(main, param, query) : viewRuns(main);
    case "populacoes":
      if (param && parts[2] === "executar") return viewExecutePopulation(main, param);
      return viewPopulations(main);
    case "population-runs": return viewPopulationRunDetail(main, param, query);
    case "tags": return viewTags(main);
    case "dados": return viewData(main);
    default: return viewDashboard(main);
  }
}

function pageHead(title, sub, actions = "") {
  return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div><div class="head-actions">${actions}</div></div>`;
}

function statusBadge(status) {
  const cls = status === "ativa" ? "ok" : status === "arquivada" ? "warn" : "neutral";
  return `<span class="badge ${cls}">${D.PERSONA_STATUS[status] || esc(status)}</span>`;
}

// ============================================================== DASHBOARD
function viewDashboard(main) {
  const stats = [
    ["Personas", S.state.personas.length, "#/personas", "leitores sintéticos modelados"],
    ["Atributos", S.state.attributes.length, "#/atributos", "características do catálogo"],
    ["Tipos de reação", S.state.reactions.length, "#/reacoes", "eventos de leitura"],
    ["Pesquisas", S.state.surveys.length, "#/pesquisas", "questionários estruturados"],
  ];
  const recent = S.state.personas.slice(0, 5);
  main.innerHTML = `
    ${pageHead("Dashboard", "Laboratório experimental de leitores sintéticos — modelagem de personas, reações e pesquisas, sem execução de agentes nesta fase.")}
    <div class="info-box" style="margin-bottom:20px">
      <span>ⓘ</span>
      <span><b>Princípio central:</b> o ReaderLab prioriza divergência e diversidade de comportamento — não consenso artificial entre agentes. Tudo o que você configurar aqui será o contrato de domínio para as futuras execuções de leitura.</span>
    </div>
    <div class="cards" style="margin-bottom:26px">
      ${stats.map(([label, num, href, hint]) => `
        <a class="card stat-card" href="${href}">
          <span class="stat-num">${num}</span>
          <span class="stat-label">${label}</span>
          <span class="stat-hint">${hint}</span>
        </a>`).join("")}
    </div>
    <div class="section-title">Atalhos</div>
    <div class="toolbar" style="margin-bottom:26px">
      <a class="btn btn-primary" href="#/personas/nova">+ Nova persona</a>
      <button class="btn" id="d-new-attr">+ Novo atributo</button>
      <button class="btn" id="d-new-rea">+ Nova reação</button>
      <button class="btn" id="d-new-survey">+ Nova pesquisa</button>
    </div>
    <div class="section-title">Personas recentes</div>
    ${recent.length === 0
      ? `<div class="empty-state"><div class="big">Nenhuma persona criada ainda</div><p>Comece modelando seu primeiro leitor sintético.</p><div style="margin-top:14px"><a class="btn btn-primary" href="#/personas/nova">Criar primeira persona</a></div></div>`
      : `<div class="cards">${recent.map(personaCard).join("")}</div>`}`;
  $("#d-new-attr").addEventListener("click", () => attributeModal());
  $("#d-new-rea").addEventListener("click", () => reactionModal());
  $("#d-new-survey").addEventListener("click", surveyTemplateModal);
  bindPersonaCards(main);
}

// =============================================================== PERSONAS
let personaFilter = { q: "", status: "", tag: "", sort: "recentes" };

function personaCard(p) {
  const attrs = S.state.attributes.filter((a) => a.status === "ativa").slice(0, 4);
  const bars = attrs.map((a) => {
    const v = p.attributeValues ? p.attributeValues[a.id] : null;
    if (v == null) return "";
    const pct = a.max > a.min ? Math.round(((v - a.min) / (a.max - a.min)) * 100) : 0;
    return `<div class="attr-bar-row"><span class="lbl" title="${esc(a.name)}">${esc(a.name)}</span><span class="bar"><i style="width:${pct}%"></i></span><span class="val">${v}</span></div>`;
  }).join("");
  return `
    <div class="card persona-card" data-persona="${p.id}">
      <div class="persona-top">
        ${p.code ? `<span class="persona-code">${esc(p.code)}</span>` : ""}
        <div style="min-width:0">
          <div class="persona-name">${esc(p.name) || "Sem nome"}</div>
          <div style="margin-top:3px">${statusBadge(p.status)}</div>
        </div>
      </div>
      ${p.shortDescription ? `<p class="persona-desc">${esc(p.shortDescription)}</p>` : ""}
      ${bars ? `<div class="attr-bars">${bars}</div>` : ""}
      ${(p.tags || []).length ? `<div class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="card-actions">
        <a class="btn btn-sm" href="#/personas/${p.id}">Editar</a>
        <button class="btn btn-sm btn-ghost" data-act="dup">Duplicar</button>
        <button class="btn btn-sm btn-ghost" data-act="arch">${p.status === "arquivada" ? "Reativar" : "Arquivar"}</button>
        <button class="btn btn-sm btn-ghost btn-danger" data-act="del">Excluir</button>
      </div>
    </div>`;
}

function bindPersonaCards(root) {
  $$("[data-persona]", root).forEach((card) => {
    const id = card.dataset.persona;
    const p = S.state.personas.find((x) => x.id === id);
    card.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.preventDefault();
      if (btn.dataset.act === "dup") {
        const copy = await S.duplicatePersona(id);
        toast(`Persona duplicada: ${copy.name}`, "ok");
        renderRoute();
      } else if (btn.dataset.act === "arch") {
        p.status = p.status === "arquivada" ? "ativa" : "arquivada";
        await S.savePersona(p);
        toast(p.status === "arquivada" ? "Persona arquivada" : "Persona reativada", "ok");
        renderRoute();
      } else if (btn.dataset.act === "del") {
        if (confirm(`Excluir a persona "${p.name}" definitivamente?`)) {
          await S.deletePersona(id);
          toast("Persona excluída", "ok");
          renderRoute();
        }
      }
    });
  });
}

function filteredPersonas() {
  let list = [...S.state.personas];
  const f = personaFilter;
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((p) =>
      (p.name || "").toLowerCase().includes(q) ||
      (p.code || "").toLowerCase().includes(q) ||
      (p.shortDescription || "").toLowerCase().includes(q) ||
      (p.tags || []).some((t) => t.toLowerCase().includes(q)));
  }
  if (f.status) list = list.filter((p) => p.status === f.status);
  if (f.tag) list = list.filter((p) => (p.tags || []).some((t) => t.toLowerCase() === f.tag.toLowerCase()));
  if (f.sort === "nome") list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (f.sort === "codigo") list.sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  else list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return list;
}

function viewPersonas(main) {
  const list = filteredPersonas();
  main.innerHTML = `
    ${pageHead("Personas", "Leitores sintéticos: combinações persistentes de preferências, tolerâncias, vieses e comportamentos de leitura.",
      `<a class="btn btn-primary" href="#/personas/nova">+ Nova persona</a>`)}
    <div class="toolbar">
      <input type="text" class="search-input" id="f-q" placeholder="Buscar por nome, código, descrição ou tag…" value="${esc(personaFilter.q)}">
      <select id="f-status"><option value="">Status: todos</option>${options(D.PERSONA_STATUS, personaFilter.status)}</select>
      <select id="f-tag"><option value="">Tags: todas</option>${S.state.tags.map((t) => `<option ${personaFilter.tag === t.name ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
      <select id="f-sort">
        <option value="recentes" ${personaFilter.sort === "recentes" ? "selected" : ""}>Ordenar: recentes</option>
        <option value="nome" ${personaFilter.sort === "nome" ? "selected" : ""}>Ordenar: nome</option>
        <option value="codigo" ${personaFilter.sort === "codigo" ? "selected" : ""}>Ordenar: código</option>
      </select>
      <span class="spacer"></span>
      <span class="muted small">${list.length} de ${S.state.personas.length}</span>
    </div>
    ${list.length === 0
      ? `<div class="empty-state"><div class="big">Nenhuma persona encontrada</div><p>Ajuste os filtros ou crie uma nova persona.</p></div>`
      : `<div class="cards">${list.map(personaCard).join("")}</div>`}`;
  $("#f-q").addEventListener("input", (e) => { personaFilter.q = e.target.value; refreshListOnly(main); });
  $("#f-status").addEventListener("change", (e) => { personaFilter.status = e.target.value; viewPersonas(main); });
  $("#f-tag").addEventListener("change", (e) => { personaFilter.tag = e.target.value; viewPersonas(main); });
  $("#f-sort").addEventListener("change", (e) => { personaFilter.sort = e.target.value; viewPersonas(main); });
  bindPersonaCards(main);
}

function refreshListOnly(main) {
  const list = filteredPersonas();
  let cards = $(".cards", main);
  const empty = $(".empty-state", main);
  if (list.length) {
    if (!cards) {
      const d = document.createElement("div");
      d.className = "cards";
      main.appendChild(d);
      cards = d;
    }
    if (empty) empty.remove();
    cards.innerHTML = list.map(personaCard).join("");
    bindPersonaCards(main);
  } else if (cards) {
    cards.remove();
    if (!empty) {
      const d = document.createElement("div");
      d.className = "empty-state";
      d.innerHTML = `<div class="big">Nenhuma persona encontrada</div><p>Ajuste os filtros ou crie uma nova persona.</p>`;
      main.appendChild(d);
    }
  }
  const counter = $(".toolbar .muted", main);
  if (counter) counter.textContent = `${list.length} de ${S.state.personas.length}`;
}

// ------------------------------------------------------- Editor de persona
// attributeValues contém SOMENTE atributos explicitamente configurados nesta
// Persona — ausência de chave != valor padrão. O checkbox "Definido" é o
// único jeito de entrar/sair de attributeValues.
function attrEditorHTML(a, value) {
  const defined = value != null;
  const fallback = a.defaultValue != null ? a.defaultValue : a.min;
  const display = defined ? value : fallback;
  return `
    <div class="attr-editor">
      <div class="attr-editor-head">
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;min-width:0">
          <input type="checkbox" data-attr-toggle="${a.id}" ${defined ? "checked" : ""}>
          <span class="attr-editor-name">${esc(a.name)}</span>
        </label>
        <span class="attr-editor-group">${esc(a.group)}</span>
      </div>
      <div class="attr-editor-body">
        <span class="ext">${a.min}</span>
        <input type="range" min="${a.min}" max="${a.max}" step="1" value="${display}" data-attr="${a.id}" ${defined ? "" : "disabled"}>
        <span class="ext max">${a.max}</span>
      </div>
      <div class="attr-editor-foot">
        <div class="attr-extremes">
          ${a.minLabel ? `<span><b>${a.min}</b> ${esc(a.minLabel)}</span>` : ""}
          ${a.maxLabel ? `<span><b>${a.max}</b> ${esc(a.maxLabel)}</span>` : ""}
        </div>
        <input type="number" class="attr-num" min="${a.min}" max="${a.max}" step="1" value="${display}" data-attr-num="${a.id}" ${defined ? "" : "disabled"}>
      </div>
      <div class="faint small">${defined ? `Valor da Persona: ${display}` : `Padrão sugerido: ${display} (não definido nesta Persona)`}</div>
    </div>`;
}

function viewPersonaForm(main, id) {
  const isNew = !id || id === "nova";
  const existing = isNew ? null : S.state.personas.find((p) => p.id === id);
  if (!isNew && !existing) { location.hash = "#/personas"; return; }
  const draft = existing ? structuredClone(existing) : D.blankPersona();
  const renderAttrGroups = () => {
    const attrsByGroup = {};
    S.state.attributes.filter((a) => a.status === "ativa").forEach((a) => {
      (attrsByGroup[a.group] = attrsByGroup[a.group] || []).push(a);
    });
    return Object.entries(attrsByGroup).map(([g, attrs]) => `
      <div class="group-title">${esc(g)}</div>
      <div class="attrs-grid">${attrs.map((a) => attrEditorHTML(a, draft.attributeValues[a.id])).join("")}</div>`).join("");
  };
  const textField = (field, label, opts = "") => `
    <div class="field"><label>${label}</label><textarea data-field="${field}" ${opts}>${esc(draft[field] || "")}</textarea></div>`;
  const groups = renderAttrGroups();

  main.innerHTML = `
    ${pageHead(isNew ? "Nova persona" : `Editar persona · ${esc(existing.name || "sem nome")}`,
      isNew ? "Defina identificação, atributos, perfil narrativo e instruções comportamentais." : `Criada em ${fmtDate(draft.createdAt)} · última atualização ${fmtDate(draft.updatedAt)}`,
      existing ? `<button class="btn" id="pf-dup">Duplicar</button>` : "")}
    <form id="persona-form" novalidate>
      <div class="section-title">Identificação</div>
      <div class="form-grid">
        <div class="field"><label>Nome <span class="req">*</span></label><input type="text" data-field="name" value="${esc(draft.name)}" placeholder="Explorador Filosófico"></div>
        <div class="field"><label>Código (opcional)</label><input type="text" class="mono" data-field="code" value="${esc(draft.code)}" placeholder="R017"></div>
        <div class="field full"><label>Descrição curta</label><input type="text" data-field="shortDescription" value="${esc(draft.shortDescription)}" placeholder="Uma linha que resume quem é este leitor"></div>
        <div class="field full"><label>Descrição narrativa</label><textarea data-field="narrativeDescription" placeholder="Retrato mais rico deste leitor, em prosa livre">${esc(draft.narrativeDescription)}</textarea></div>
        <div class="field"><label>Status</label><select data-field="status">${options(D.PERSONA_STATUS, draft.status)}</select></div>
        <div class="field"><label>Tags <span class="hint">(separadas por vírgula)</span></label>
          <input type="text" data-field="tags" list="tag-list" value="${esc((draft.tags || []).join(", "))}" placeholder="sci-fi, filosofia, crítico">
          <datalist id="tag-list">${S.state.tags.map((t) => `<option value="${esc(t.name)}">`).join("")}</datalist>
        </div>
      </div>

      <div class="section-title">Atributos</div>
      <div id="pf-attrs">${groups || `<div class="empty-state"><div class="big">Nenhum atributo ativo</div><p>Ative ou crie atributos no módulo Atributos.</p></div>`}</div>

      <div class="section-title">Perfil narrativo</div>
      <div class="form-grid">
        <div class="field"><label>Gostos</label><textarea data-field="tastes" placeholder="O que este leitor aprecia">${esc(draft.tastes)}</textarea></div>
        <div class="field"><label>Aversões</label><textarea data-field="aversions" placeholder="O que este leitor rejeita">${esc(draft.aversions)}</textarea></div>
        <div class="field"><label>Expectativas ao iniciar uma leitura</label><textarea data-field="expectations">${esc(draft.expectations)}</textarea></div>
        <div class="field"><label>Comportamentos específicos</label><textarea data-field="behaviors" placeholder="Hábitos e reações durante a leitura">${esc(draft.behaviors)}</textarea></div>
        <div class="field full"><label>Contradições <span class="hint">(personas não devem ser caricaturas perfeitamente coerentes)</span></label>
          <textarea class="tall" data-field="contradictions" placeholder="Ex.: adora ficção científica, mas detesta explicações técnicas">${esc(draft.contradictions)}</textarea></div>
      </div>

      <div class="section-title">Execução futura (agente)</div>
      <div class="form-grid">
        <div class="field full"><label>Instruções comportamentais <span class="hint">(farão parte do prompt do agente)</span></label>
          <textarea class="tall" data-field="instructions" placeholder="Ex.: você lê principalmente por entretenimento; tem baixa tolerância a explicações longas; quando perde o interesse, abandona rápido…">${esc(draft.instructions)}</textarea></div>
        <div class="field full"><label>Observações internas <span class="hint">(nunca serão enviadas ao modelo)</span></label>
          <textarea data-field="internalNotes">${esc(draft.internalNotes)}</textarea></div>
      </div>

      <div class="save-bar">
        <a class="btn" href="#/personas">Cancelar</a>
        <button type="submit" class="btn btn-primary">${isNew ? "Criar persona" : "Salvar alterações"}</button>
      </div>
    </form>`;

  const form = $("#persona-form");
  const syncPair = (attrId, v) => {
    const r = form.querySelector(`[data-attr="${attrId}"]`);
    const n = form.querySelector(`[data-attr-num="${attrId}"]`);
    if (r && +r.value !== v) r.value = v;
    if (n && +n.value !== v) n.value = v;
  };
  const onInput = (e) => {
    const t = e.target;
    if (t.dataset.attrToggle) {
      if (e.type !== "change") return; // evita processar duas vezes (input+change)
      const attrId = t.dataset.attrToggle;
      const a = S.state.attributes.find((x) => x.id === attrId);
      if (t.checked) {
        if (draft.attributeValues[attrId] == null) draft.attributeValues[attrId] = a.defaultValue != null ? a.defaultValue : a.min;
      } else {
        delete draft.attributeValues[attrId];
      }
      $("#pf-attrs").innerHTML = renderAttrGroups() || `<div class="empty-state"><div class="big">Nenhum atributo ativo</div><p>Ative ou crie atributos no módulo Atributos.</p></div>`;
    } else if (t.dataset.attr) {
      const a = S.state.attributes.find((x) => x.id === t.dataset.attr);
      let v = parseInt(t.value, 10);
      if (isNaN(v)) v = a.defaultValue ?? a.min;
      v = Math.max(a.min, Math.min(a.max, v));
      draft.attributeValues[t.dataset.attr] = v;
      syncPair(t.dataset.attr, v);
    } else if (t.dataset.attrNum) {
      const a = S.state.attributes.find((x) => x.id === t.dataset.attrNum);
      let v = parseInt(t.value, 10);
      if (isNaN(v)) return;
      v = Math.max(a.min, Math.min(a.max, v));
      draft.attributeValues[t.dataset.attrNum] = v;
      syncPair(t.dataset.attrNum, v);
    } else if (t.dataset.field) {
      draft[t.dataset.field] = t.value;
    }
  };
  form.addEventListener("input", onInput);
  form.addEventListener("change", onInput);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    draft.tags = String(draft.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!draft.name.trim()) { toast("Informe um nome para a persona.", "bad"); form.querySelector('[data-field="name"]').focus(); return; }
    await S.savePersona(draft);
    toast(isNew ? "Persona criada" : "Persona salva", "ok");
    location.hash = "#/personas";
  });
  const dupBtn = $("#pf-dup");
  if (dupBtn) dupBtn.addEventListener("click", async () => {
    const copy = await S.duplicatePersona(existing.id);
    toast(`Persona duplicada: ${copy.name}`, "ok");
    location.hash = "#/personas/" + copy.id;
  });
}

// ============================================================== ATRIBUTOS
function attributeModal(existing = null) {
  const a = existing ? structuredClone(existing) : D.blankAttribute();
  openModal({
    title: existing ? "Editar atributo" : "Novo atributo",
    wide: true,
    body: `
      <div class="form-grid">
        <div class="field"><label>Nome <span class="req">*</span></label><input type="text" id="a-name" value="${esc(a.name)}" placeholder="Tolerância a exposição"></div>
        <div class="field"><label>Slug</label><input type="text" class="mono" id="a-slug" value="${esc(a.slug)}" placeholder="tolerancia-a-exposicao"></div>
        <div class="field"><label>Grupo</label><select id="a-group">${D.ATTRIBUTE_GROUPS.map((g) => `<option ${g === a.group ? "selected" : ""}>${g}</option>`).join("")}</select></div>
        <div class="field"><label>Status</label><select id="a-status">${options(D.PERSONA_STATUS, a.status)}</select></div>
        <div class="field full"><label>Descrição</label><textarea id="a-desc">${esc(a.description)}</textarea></div>
        <div class="field"><label>Valor mínimo</label><input type="number" id="a-min" value="${a.min}"></div>
        <div class="field"><label>Valor máximo</label><input type="number" id="a-max" value="${a.max}"></div>
        <div class="field"><label>Valor padrão (opcional)</label><input type="number" id="a-default" value="${a.defaultValue ?? ""}"></div>
        <div class="field"><label></label><span class="hint" style="padding-top:10px">A escala define os sliders usados nas personas.</span></div>
        <div class="field"><label>O que significa o mínimo</label><textarea id="a-minlabel" placeholder="Detesta explicações prolongadas…">${esc(a.minLabel)}</textarea></div>
        <div class="field"><label>O que significa o máximo</label><textarea id="a-maxlabel" placeholder="Gosta de longas exposições conceituais…">${esc(a.maxLabel)}</textarea></div>
      </div>`,
    onSubmit: async (form) => {
      const name = $("#a-name", form).value.trim();
      if (!name) { toast("Informe um nome para o atributo.", "bad"); return false; }
      const min = parseInt($("#a-min", form).value, 10);
      const max = parseInt($("#a-max", form).value, 10);
      const def = $("#a-default", form).value === "" ? null : parseInt($("#a-default", form).value, 10);
      if (isNaN(min) || isNaN(max) || min >= max) { toast("Escala inválida: mínimo deve ser menor que o máximo.", "bad"); return false; }
      if (def != null && (def < min || def > max)) { toast("Valor padrão fora da escala.", "bad"); return false; }
      a.name = name;
      a.slug = $("#a-slug", form).value.trim() || D.slugify(name);
      a.group = $("#a-group", form).value;
      a.status = $("#a-status", form).value;
      a.description = $("#a-desc", form).value;
      a.min = min; a.max = max; a.defaultValue = def;
      a.minLabel = $("#a-minlabel", form).value;
      a.maxLabel = $("#a-maxlabel", form).value;
      await S.saveAttribute(a);
      toast(existing ? "Atributo atualizado" : "Atributo criado", "ok");
      renderRoute();
    },
  });
  const nameInput = $("#a-name");
  const slugInput = $("#a-slug");
  nameInput.addEventListener("input", () => { if (!existing) slugInput.value = D.slugify(nameInput.value); });
}

function viewAttributes(main) {
  main.innerHTML = `
    ${pageHead("Atributos de Persona", "Catálogo configurável de características mensuráveis — preferências, tolerâncias, exigências e orientações de leitura.",
      `<button class="btn btn-primary" id="at-new">+ Novo atributo</button>`)}
    <div class="table-wrap"><table>
      <thead><tr><th>Nome</th><th>Grupo</th><th>Escala</th><th>Extremos</th><th>Padrão</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${S.state.attributes.map((a) => `
          <tr>
            <td><b>${esc(a.name)}</b><div class="faint small mono">${esc(a.slug)}</div></td>
            <td class="muted">${esc(a.group)}</td>
            <td class="mono">${a.min}–${a.max}</td>
            <td class="muted small">${esc(a.minLabel || "—")} <span class="faint">→</span> ${esc(a.maxLabel || "—")}</td>
            <td class="mono">${a.defaultValue ?? "—"}</td>
            <td>${statusBadge(a.status)}</td>
            <td><div class="row-actions">
              <button class="btn btn-sm" data-edit="${a.id}">Editar</button>
              <button class="btn btn-sm btn-ghost btn-danger" data-del="${a.id}">Excluir</button>
            </div></td>
          </tr>`).join("")}
      </tbody>
    </table></div>
    <p class="hint" style="margin-top:10px">Atributos desativados deixam de aparecer no editor de personas, mas seus valores já salvos são preservados. A exclusão só é permitida quando o atributo não é usado por nenhuma persona.</p>`;
  $("#at-new").addEventListener("click", () => attributeModal());
  $$("[data-edit]", main).forEach((b) => b.addEventListener("click", () =>
    attributeModal(S.state.attributes.find((a) => a.id === b.dataset.edit))));
  $$("[data-del]", main).forEach((b) => b.addEventListener("click", async () => {
    const a = S.state.attributes.find((x) => x.id === b.dataset.del);
    const used = S.attributeUsage(a.id);
    if (used > 0) { toast(`Atributo usado por ${used} persona(s). Desative-o em vez de excluir.`, "bad"); return; }
    if (confirm(`Excluir o atributo "${a.name}"?`)) {
      await S.deleteAttribute(a.id);
      toast("Atributo excluído", "ok");
      renderRoute();
    }
  }));
}

// =============================================================== REAÇÕES
function reactionPolarityBadge(pol) {
  const cls = pol === "positiva" ? "ok" : pol === "negativa" ? "bad" : "neutral";
  return `<span class="badge ${cls}">${D.POLARITIES[pol]}</span>`;
}

function reactionModal(existing = null) {
  const r = existing ? structuredClone(existing) : D.blankReaction(S.state.reactions.length);
  openModal({
    title: existing ? "Editar reação" : "Nova reação",
    body: `
      <div class="form-grid">
        <div class="field"><label>Nome <span class="req">*</span></label><input type="text" id="r-name" value="${esc(r.name)}" placeholder="Chato"></div>
        <div class="field"><label>Código</label><input type="text" class="mono" id="r-code" value="${esc(r.code)}" placeholder="BORING"></div>
        <div class="field"><label>Polaridade</label><select id="r-pol">${options(D.POLARITIES, r.polarity)}</select></div>
        <div class="field"><label>Cor de interface</label><input type="color" id="r-color" value="${r.color || "#4f8ef7"}"></div>
        <div class="field"><label>Ícone (opcional)</label><input type="text" id="r-icon" value="${esc(r.icon)}" placeholder="um caractere ou emoji"></div>
        <div class="field"><label>Status</label><select id="r-status">${options(D.PERSONA_STATUS, r.status)}</select></div>
        <div class="field full"><label>Descrição</label><textarea id="r-desc">${esc(r.description)}</textarea></div>
        <div class="field full">
          <label class="checkbox-row" style="padding-left:0"><input type="checkbox" id="r-intensity" ${r.intensityEnabled ? "checked" : ""}> Permite intensidade (0–100)</label>
          <span class="hint">A intensidade permitirá futuramente construir heatmaps do manuscrito.</span>
        </div>
      </div>`,
    onSubmit: async (form) => {
      const name = $("#r-name", form).value.trim();
      if (!name) { toast("Informe um nome para a reação.", "bad"); return false; }
      r.name = name;
      r.code = ($("#r-code", form).value.trim() || D.slugify(name).replace(/-/g, "_")).toUpperCase();
      r.polarity = $("#r-pol", form).value;
      r.color = $("#r-color", form).value;
      r.icon = $("#r-icon", form).value.trim();
      r.status = $("#r-status", form).value;
      r.description = $("#r-desc", form).value;
      r.intensityEnabled = $("#r-intensity", form).checked;
      await S.saveReaction(r);
      toast(existing ? "Reação atualizada" : "Reação criada", "ok");
      renderRoute();
    },
  });
}

function viewReactions(main) {
  main.innerHTML = `
    ${pageHead("Taxonomia de Reações", "Categorias de eventos que poderão ser registradas durante a leitura. Nenhuma reação é obrigatória — a ausência de evento também é informação.",
      `<button class="btn btn-primary" id="re-new">+ Nova reação</button>`)}
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>Nome</th><th>Código</th><th>Polaridade</th><th>Intensidade</th><th>Status</th><th>Ordem</th><th></th></tr></thead>
      <tbody>
        ${S.state.reactions.map((r, i) => `
          <tr>
            <td><span class="reaction-dot" style="background:${esc(r.color)}"></span></td>
            <td><b>${esc(r.icon ? r.icon + " " : "")}${esc(r.name)}</b></td>
            <td class="mono muted">${esc(r.code)}</td>
            <td>${reactionPolarityBadge(r.polarity)}</td>
            <td>${r.intensityEnabled ? `<span class="badge accent">0–100</span>` : `<span class="faint">—</span>`}</td>
            <td>${statusBadge(r.status)}</td>
            <td><div class="row-actions" style="justify-content:flex-start">
              <button class="btn btn-sm btn-ghost" data-move="${r.id}" data-dir="-1" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="btn btn-sm btn-ghost" data-move="${r.id}" data-dir="1" ${i === S.state.reactions.length - 1 ? "disabled" : ""}>↓</button>
            </div></td>
            <td><div class="row-actions">
              <button class="btn btn-sm" data-edit="${r.id}">Editar</button>
              <button class="btn btn-sm btn-ghost btn-danger" data-del="${r.id}">Excluir</button>
            </div></td>
          </tr>`).join("")}
      </tbody>
    </table></div>`;
  $("#re-new").addEventListener("click", () => reactionModal());
  $$("[data-edit]", main).forEach((b) => b.addEventListener("click", () =>
    reactionModal(S.state.reactions.find((r) => r.id === b.dataset.edit))));
  $$("[data-del]", main).forEach((b) => b.addEventListener("click", async () => {
    const r = S.state.reactions.find((x) => x.id === b.dataset.del);
    if (confirm(`Excluir a reação "${r.name}" (${r.code})?`)) {
      await S.deleteReaction(r.id);
      toast("Reação excluída", "ok");
      renderRoute();
    }
  }));
  $$("[data-move]", main).forEach((b) => b.addEventListener("click", async () => {
    await S.moveReaction(b.dataset.move, parseInt(b.dataset.dir, 10));
    renderRoute();
  }));
}

// =============================================================== PESQUISAS
function surveyKindBadge(kind) {
  return `<span class="badge accent">${D.SURVEY_KINDS[kind] || esc(kind)}</span>`;
}

function viewSurveys(main) {
  main.innerHTML = `
    ${pageHead("Pesquisas", "Questionários estruturados que os leitores sintéticos responderão futuramente — por capítulo, por seção, ao final ou sob demanda.",
      `<button class="btn btn-primary" id="sv-new">+ Nova pesquisa</button>`)}
    ${S.state.surveys.length === 0
      ? `<div class="empty-state"><div class="big">Nenhuma pesquisa criada</div><p>Crie a partir de um template ou comece do zero.</p></div>`
      : `<div class="cards">${S.state.surveys.map((s) => `
        <div class="card persona-card" data-survey="${s.id}">
          <div class="persona-top">
            <div style="min-width:0">
              <div class="persona-name">${esc(s.name) || "Sem nome"}</div>
              <div class="q-meta">${surveyKindBadge(s.kind)} ${statusBadge(s.status)} <span class="badge neutral">${s.questions.length} pergunta(s)</span></div>
            </div>
          </div>
          ${s.description ? `<p class="persona-desc">${esc(s.description)}</p>` : ""}
          <p class="faint small">Atualizada em ${fmtDate(s.updatedAt)}</p>
          <div class="card-actions">
            <a class="btn btn-sm" href="#/pesquisas/${s.id}">Editar</a>
            <button class="btn btn-sm btn-ghost" data-act="dup">Duplicar</button>
            <button class="btn btn-sm btn-ghost" data-act="arch">${s.status === "arquivada" ? "Reativar" : "Arquivar"}</button>
            <button class="btn btn-sm btn-ghost btn-danger" data-act="del">Excluir</button>
          </div>
        </div>`).join("")}</div>`}`;
  $("#sv-new").addEventListener("click", surveyTemplateModal);
  $$("[data-survey]", main).forEach((card) => {
    const id = card.dataset.survey;
    const s = S.state.surveys.find((x) => x.id === id);
    card.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.preventDefault();
      if (btn.dataset.act === "dup") { await S.duplicateSurvey(id); toast("Pesquisa duplicada", "ok"); renderRoute(); }
      else if (btn.dataset.act === "arch") {
        s.status = s.status === "arquivada" ? "ativa" : "arquivada";
        await S.saveSurvey(s);
        toast("Pesquisa atualizada", "ok");
        renderRoute();
      } else if (btn.dataset.act === "del") {
        if (confirm(`Excluir a pesquisa "${s.name}"?`)) { await S.deleteSurvey(id); toast("Pesquisa excluída", "ok"); renderRoute(); }
      }
    });
  });
}

function surveyTemplateModal() {
  const templates = [
    ["chapter", "Leitura de capítulo", "10 métricas 0–100 + 9 perguntas qualitativas"],
    ["section", "Leitura de ato/seção", "Blocos narrativos: métricas rápidas e comentários"],
    ["final", "Avaliação final", "17 perguntas pós-obra (personagens, ritmo, revelações, nota)"],
    ["custom", "Pesquisa vazia", "Comece do zero com o tipo de sua escolha"],
  ];
  openModal({
    title: "Nova pesquisa — escolha um template",
    submitLabel: "Fechar",
    body: `<div class="template-grid">
      ${templates.map(([kind, name, desc]) => `
        <button type="button" class="template-card" data-tpl="${kind}"><b>${name}</b><span>${desc}</span></button>`).join("")}
    </div>`,
    onSubmit: () => {},
  });
  $$("[data-tpl]").forEach((b) => b.addEventListener("click", async () => {
    const kind = b.dataset.tpl;
    let s;
    if (kind === "chapter") s = D.seedSurveys()[0];
    else if (kind === "section") s = D.seedSurveys()[1];
    else if (kind === "final") s = D.seedSurveys()[2];
    else { s = D.blankSurvey("custom"); s.name = "Nova pesquisa"; }
    await S.saveSurvey(s);
    toast("Pesquisa criada a partir do template", "ok");
    document.querySelector(".modal-overlay")?.remove();
    location.hash = "#/pesquisas/" + s.id;
  }));
}

// ------------------------------------------------------- Editor de pesquisa
function questionMeta(q) {
  const parts = [];
  if (q.type === "scale" || q.type === "number") parts.push(`<span class="badge neutral">${q.min}–${q.max}</span>`);
  if (q.type === "single_choice" || q.type === "multiple_choice") parts.push(`<span class="badge neutral">${q.options.length} opção(ões)</span>`);
  if (q.type === "boolean") parts.push(`<span class="badge neutral">Sim / Não</span>`);
  if (q.required) parts.push(`<span class="badge warn">obrigatória</span>`);
  return parts.join(" ");
}

function questionModal(survey, index = null) {
  const editing = index != null;
  const q = editing ? structuredClone(survey.questions[index]) : D.makeQuestion("short_text", "");
  openModal({
    title: editing ? "Editar pergunta" : "Adicionar pergunta",
    wide: true,
    body: `
      <div class="field"><label>Tipo de resposta</label>
        <select id="q-type">${options(D.QUESTION_TYPES, q.type)}</select></div>
      <div class="field"><label>Pergunta <span class="req">*</span></label>
        <textarea id="q-text" placeholder="Ex.: Qual foi o melhor momento do capítulo?">${esc(q.text)}</textarea></div>
      <div class="field"><label>Ajuda (opcional)</label>
        <input type="text" id="q-help" value="${esc(q.help || "")}" placeholder="Instrução curta para o respondente"></div>
      <div class="form-grid">
        <div class="q-cond" data-types="number scale">
          <div class="inline-fields">
            <div class="field"><label>Mínimo</label><input type="number" id="q-min" value="${q.min ?? 0}"></div>
            <div class="field"><label>Máximo</label><input type="number" id="q-max" value="${q.max ?? 100}"></div>
          </div>
        </div>
        <div class="q-cond full" data-types="single_choice multiple_choice">
          <div class="field"><label>Opções (uma por linha)</label>
            <textarea id="q-options" placeholder="Personagens&#10;Enredo&#10;Humor">${esc((q.options || []).join("\n"))}</textarea></div>
        </div>
      </div>
      <label class="checkbox-row" style="padding-left:0"><input type="checkbox" id="q-required" ${q.required ? "checked" : ""}> Pergunta obrigatória</label>`,
    onSubmit: async (form) => {
      const text = $("#q-text", form).value.trim();
      if (!text) { toast("Informe o texto da pergunta.", "bad"); return false; }
      q.type = $("#q-type", form).value;
      q.text = text;
      q.help = $("#q-help", form).value.trim();
      q.required = $("#q-required", form).checked;
      if (q.type === "number" || q.type === "scale") {
        q.min = parseInt($("#q-min", form).value, 10) || 0;
        q.max = parseInt($("#q-max", form).value, 10) || (q.type === "scale" ? 100 : 10);
        q.options = [];
      } else if (q.type === "single_choice" || q.type === "multiple_choice") {
        q.options = $("#q-options", form).value.split("\n").map((o) => o.trim()).filter(Boolean);
        if (q.options.length < 2) { toast("Informe pelo menos 2 opções.", "bad"); return false; }
      } else q.options = [];
      if (editing) survey.questions[index] = q;
      else survey.questions.push(q);
      await S.saveSurvey(survey);
      toast(editing ? "Pergunta atualizada" : "Pergunta adicionada", "ok");
      renderRoute();
    },
  });
  const toggleConds = () => {
    const type = $("#q-type").value;
    $$(".q-cond").forEach((c) => { c.style.display = c.dataset.types.includes(type) ? "" : "none"; });
  };
  $("#q-type").addEventListener("change", toggleConds);
  toggleConds();
}

function viewSurveyEditor(main, id) {
  const isNew = id === "nova";
  const existing = isNew ? null : S.state.surveys.find((s) => s.id === id);
  if (!isNew && !existing) { location.hash = "#/pesquisas"; return; }
  const draft = existing ? structuredClone(existing) : D.blankSurvey("custom");
  main.innerHTML = `
    ${pageHead(isNew ? "Nova pesquisa" : `Editar pesquisa · ${esc(existing.name || "sem nome")}`,
      isNew ? "Configure o questionário e adicione as perguntas." : `Criada em ${fmtDate(draft.createdAt)} · última atualização ${fmtDate(draft.updatedAt)}`,
      `<button class="btn" id="sq-dup">Duplicar pesquisa</button>`)}
    <form id="survey-form" novalidate>
      <div class="card" style="margin-bottom:18px">
        <div class="form-grid">
          <div class="field"><label>Nome <span class="req">*</span></label><input type="text" id="s-name" value="${esc(draft.name)}" placeholder="Pós-capítulo"></div>
          <div class="field"><label>Momento de aplicação</label><select id="s-kind">${options(D.SURVEY_KINDS, draft.kind)}</select></div>
          <div class="field"><label>Status</label><select id="s-status">${options(D.PERSONA_STATUS, draft.status)}</select></div>
          <div class="field"><label>Descrição</label><input type="text" id="s-desc" value="${esc(draft.description)}" placeholder="Quando e para que esta pesquisa é aplicada"></div>
          <div class="field full"><label>Instruções ao respondente</label>
            <textarea id="s-instructions" placeholder="Ex.: responda com base apenas no capítulo recém-lido…">${esc(draft.instructions)}</textarea></div>
        </div>
      </div>

      <div class="section-title">Perguntas <span class="faint" style="text-transform:none;letter-spacing:0">(arraste para reordenar)</span></div>
      <div class="q-list" id="q-list" style="margin-bottom:12px">
        ${draft.questions.length === 0
          ? `<div class="empty-state"><div class="big">Nenhuma pergunta ainda</div><p>Adicione perguntas com diferentes formatos de resposta.</p></div>`
          : draft.questions.map((q, i) => `
            <div class="q-item" draggable="true" data-index="${i}">
              <span class="q-drag">⠿</span>
              <div class="q-body">
                <div class="q-text">${i + 1}. ${esc(q.text)}</div>
                <div class="q-meta">
                  <span class="badge accent">${D.QUESTION_TYPES[q.type]}</span>
                  ${questionMeta(q)}
                </div>
              </div>
              <div class="q-actions">
                <button type="button" class="btn btn-sm" data-qact="edit" data-i="${i}">Editar</button>
                <button type="button" class="btn btn-sm btn-ghost" data-qact="dup" data-i="${i}">Duplicar</button>
                <button type="button" class="btn btn-sm btn-ghost btn-danger" data-qact="del" data-i="${i}">Excluir</button>
              </div>
            </div>`).join("")}
      </div>
      <button type="button" class="btn" id="q-add">+ Adicionar pergunta</button>

      <div class="save-bar">
        <a class="btn" href="#/pesquisas">Voltar</a>
        <button type="submit" class="btn btn-primary">${isNew ? "Criar pesquisa" : "Salvar pesquisa"}</button>
      </div>
    </form>`;

  const form = $("#survey-form");
  ["s-name", "s-kind", "s-status", "s-desc", "s-instructions"].forEach((fid) => {
    $("#" + fid).addEventListener("input", (e) => {
      draft[{ "s-name": "name", "s-kind": "kind", "s-status": "status", "s-desc": "description", "s-instructions": "instructions" }[fid]] = e.target.value;
    });
  });
  $("#q-add").addEventListener("click", () => questionModal(draft));
  $$("[data-qact]", main).forEach((b) => b.addEventListener("click", async () => {
    const i = parseInt(b.dataset.i, 10);
    if (b.dataset.qact === "edit") questionModal(draft, i);
    else if (b.dataset.qact === "dup") {
      const copy = { ...structuredClone(draft.questions[i]), id: D.uid("qst") };
      draft.questions.splice(i + 1, 0, copy);
      await S.saveSurvey(draft);
      toast("Pergunta duplicada", "ok");
      renderRoute();
    } else if (b.dataset.qact === "del") {
      if (confirm("Excluir esta pergunta?")) {
        draft.questions.splice(i, 1);
        await S.saveSurvey(draft);
        toast("Pergunta excluída", "ok");
        renderRoute();
      }
    }
  }));

  // Drag-and-drop para reordenar
  const list = $("#q-list");
  let dragIndex = null;
  $$(".q-item", list).forEach((item) => {
    item.addEventListener("dragstart", () => { dragIndex = parseInt(item.dataset.index, 10); item.classList.add("dragging"); });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", (e) => e.preventDefault());
    item.addEventListener("drop", async (e) => {
      e.preventDefault();
      const to = parseInt(item.dataset.index, 10);
      if (dragIndex == null || dragIndex === to) return;
      const [moved] = draft.questions.splice(dragIndex, 1);
      draft.questions.splice(to, 0, moved);
      await S.saveSurvey(draft);
      renderRoute();
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) { toast("Informe um nome para a pesquisa.", "bad"); $("#s-name").focus(); return; }
    await S.saveSurvey(draft);
    toast(isNew ? "Pesquisa criada" : "Pesquisa salva", "ok");
    location.hash = "#/pesquisas";
  });
  $("#sq-dup").addEventListener("click", async () => {
    const copy = await S.duplicateSurvey(draft.id);
    toast("Pesquisa duplicada", "ok");
    location.hash = "#/pesquisas/" + copy.id;
  });
}

// ============================================================== POPULAÇÕES
function populationModal(existing = null) {
  const pop = existing ? structuredClone(existing) : D.blankPopulation();
  openModal({
    title: existing ? "Editar população" : "Nova população",
    body: `
      <div class="field"><label>Nome <span class="req">*</span></label><input type="text" id="p-name" value="${esc(pop.name)}" placeholder="Beta Sci-Fi Diversificada"></div>
      <div class="field"><label>Descrição</label><textarea id="p-desc" placeholder="Objetivo desta população de leitores">${esc(pop.description)}</textarea></div>`,
    onSubmit: async (form) => {
      const name = $("#p-name", form).value.trim();
      if (!name) { toast("Informe um nome para a população.", "bad"); return false; }
      pop.name = name;
      pop.description = $("#p-desc", form).value;
      await S.savePopulation(pop);
      toast(existing ? "População atualizada" : "População criada", "ok");
      renderRoute();
    },
  });
}

function membersModal(pop) {
  const active = S.state.personas.filter((p) => p.status !== "arquivada");
  openModal({
    title: `Membros — ${pop.name}`,
    wide: true,
    submitLabel: "Salvar membros",
    body: `
      <p class="muted small" style="margin-bottom:10px">Selecione as personas que compõem esta população (${active.length} disponíveis).</p>
      <div style="max-height:46vh;overflow-y:auto">
        ${active.map((p) => `
          <label class="checkbox-row">
            <input type="checkbox" data-member="${p.id}" ${pop.personaIds.includes(p.id) ? "checked" : ""}>
            <span class="mono faint small">${esc(p.code || "—")}</span>
            <span>${esc(p.name)}</span>
            <span class="faint small" style="margin-left:auto">${D.PERSONA_STATUS[p.status]}</span>
          </label>`).join("")}
      </div>`,
    onSubmit: async (form) => {
      pop.personaIds = $$("[data-member]:checked", form).map((c) => c.dataset.member);
      await S.savePopulation(pop);
      toast("Membros atualizados", "ok");
      renderRoute();
    },
  });
}

function viewPopulations(main) {
  main.innerHTML = `
    ${pageHead("Populations", "Conjuntos nomeados de personas — preparação para futuras execuções em escala. Uma população permite criar amostras heterogêneas de leitores.",
      `<button class="btn btn-primary" id="po-new">+ Nova população</button>`)}
    ${S.state.populations.length === 0
      ? `<div class="empty-state"><div class="big">Nenhuma população criada</div><p>Populações são opcionais no MVP, mas o domínio já está preparado para elas.</p></div>`
      : `<div class="cards">${S.state.populations.map((pop) => {
        const popRuns = S.getPopulationRunsForPopulation(pop.id);
        return `
        <div class="card persona-card">
          <div class="persona-name">${esc(pop.name)}</div>
          ${pop.description ? `<p class="persona-desc">${esc(pop.description)}</p>` : ""}
          <div class="q-meta"><span class="badge accent">${pop.personaIds.length} persona(s)</span></div>
          <div class="pop-members">
            ${pop.personaIds.slice(0, 8).map((id) => {
              const p = S.state.personas.find((x) => x.id === id);
              return p ? `<span class="tag">${esc(p.code || "")} ${esc(p.name)}</span>` : "";
            }).join("")}
            ${pop.personaIds.length > 8 ? `<span class="tag">+${pop.personaIds.length - 8}</span>` : ""}
          </div>
          <div class="card-actions">
            <button class="btn btn-sm btn-primary" data-exec="${pop.id}" ${pop.personaIds.length ? "" : "disabled"}>Executar população</button>
            <button class="btn btn-sm" data-members="${pop.id}">Editar membros</button>
            <button class="btn btn-sm btn-ghost" data-rename="${pop.id}">Renomear</button>
            <button class="btn btn-sm btn-ghost btn-danger" data-del="${pop.id}">Excluir</button>
          </div>
          <div class="pop-run-history">
            <div class="pop-run-history-title">Execuções${popRuns.length ? ` (${popRuns.length})` : ""}</div>
            ${popRuns.length === 0 ? `<p class="faint small">Nenhuma execução ainda.</p>` : popRuns.slice(0, 5).map((pr) => {
              const survey = S.state.surveys.find((s) => s.id === pr.surveyId) || pr.executionSnapshot?.survey;
              const leitores = pr.executionSnapshot?.personas?.length ?? 0;
              return `
              <a class="pop-run-row" href="#/population-runs/${pr.id}">
                <div class="pop-run-row-top">
                  <span class="pop-run-row-title">${esc(pr.title || "(sem título)")}</span>
                  ${populationRunStatusBadge(pr.status)}
                </div>
                <span class="faint small mono">${fmtDate(pr.createdAt)} · ${esc(survey ? survey.name : "—")} · ${leitores} leitor(es)</span>
              </a>`;
            }).join("")}
            ${popRuns.length > 5 ? `<p class="faint small" style="margin:2px 0 0">+${popRuns.length - 5} execução(ões) anterior(es)</p>` : ""}
          </div>
        </div>`;
      }).join("")}</div>`}`;
  $("#po-new").addEventListener("click", () => populationModal());
  $$("[data-exec]", main).forEach((b) => b.addEventListener("click", () => { location.hash = "#/populacoes/" + b.dataset.exec + "/executar"; }));
  $$("[data-members]", main).forEach((b) => b.addEventListener("click", () =>
    membersModal(S.state.populations.find((p) => p.id === b.dataset.members))));
  $$("[data-rename]", main).forEach((b) => b.addEventListener("click", () =>
    populationModal(S.state.populations.find((p) => p.id === b.dataset.rename))));
  $$("[data-del]", main).forEach((b) => b.addEventListener("click", async () => {
    const pop = S.state.populations.find((p) => p.id === b.dataset.del);
    if (confirm(`Excluir a população "${pop.name}"? As personas não serão afetadas.`)) {
      await S.deletePopulation(pop.id);
      toast("População excluída", "ok");
      renderRoute();
    }
  }));
}

function viewExecutePopulation(main, popId) {
  const pop = S.state.populations.find((p) => p.id === popId);
  if (!pop) { location.hash = "#/populacoes"; return; }
  const members = pop.personaIds.map((id) => S.state.personas.find((p) => p.id === id)).filter(Boolean);
  const cfg = getLLMConfig();
  const surveys = S.state.surveys.filter((s) => s.status === "ativa");

  if (!members.length) {
    main.innerHTML = `${pageHead("Executar população", "", `<a class="btn" href="#/populacoes">Voltar</a>`)}
      <div class="info-box warn"><span>⚠</span><span>Esta população não tem personas membros. Edite os membros antes de executar.</span></div>`;
    return;
  }
  if (!surveys.length) {
    main.innerHTML = `${pageHead("Executar população", "", `<a class="btn" href="#/populacoes">Voltar</a>`)}
      <div class="info-box warn"><span>⚠</span><span>É necessária ao menos uma <b>pesquisa ativa</b> para executar uma população.</span></div>`;
    return;
  }

  main.innerHTML = `
    ${pageHead(`Executar população · ${esc(pop.name)}`, "Uma PopulationRun cria uma ReadingRun independente por Persona — mesmo texto, mesma Pesquisa, mesma configuração de modelo. As personas não compartilham respostas nem contexto entre si.",
      `<a class="btn" href="#/populacoes">Voltar</a>`)}
    ${!cfg.endpoint ? `
    <div class="info-box warn" style="margin-bottom:16px"><span>⚠</span>
      <span><b>Backend LLM não configurado.</b> Use o modo demo local ou conecte um proxy seguro para executar leituras reais.</span>
    </div>` : ""}
    <form id="pr-form" novalidate>
      <div class="field" style="max-width:520px">
        <label>Título da execução <span class="hint">(opcional)</span></label>
        <input type="text" id="pr-title" placeholder="Capítulo 1 — leitura em população">
      </div>

      <div class="section-title">Texto</div>
      <div class="field">
        <label>Cole o texto ou envie um arquivo (.txt / .md)</label>
        <textarea id="pr-text" class="tall" placeholder="Cole aqui o texto a ser lido por todas as personas desta população…"></textarea>
        <div class="toolbar" style="margin:6px 0 0">
          <input type="file" id="pr-file" accept=".txt,.md">
          <span class="hint" id="pr-count">0 caracteres</span>
        </div>
      </div>

      <div class="field">
        <label>Pesquisa <span class="req">*</span></label>
        <select id="pr-survey">
          <option value="">Selecione…</option>
          ${surveys.map((s) => `<option value="${s.id}">${esc(s.name)} (${D.SURVEY_KINDS[s.kind]})</option>`).join("")}
        </select>
      </div>

      <div class="field">
        <label>Modo de execução</label>
        <label class="checkbox-row" style="padding-left:0">
          <input type="radio" name="pr-mode" value="demo" checked> Demo local (simulador — sem rede, resultados determinísticos)
        </label>
        <label class="checkbox-row" style="padding-left:0">
          <input type="radio" name="pr-mode" value="llm" ${cfg.endpoint ? "" : "disabled"}>
          LLM real via proxy ${cfg.endpoint ? "" : "(indisponível — nenhum backend configurado)"}
        </label>
      </div>

      <div class="section-title">Resumo</div>
      <div class="card" style="margin-bottom:16px">
        <p><b>${members.length}</b> persona(s) serão executadas, sequencialmente e de forma isolada entre si.</p>
        <div class="tags" style="margin-top:10px">
          ${members.map((p) => `<span class="tag">${esc(p.code ? p.code + " — " : "")}${esc(p.name)}</span>`).join(" ")}
        </div>
        <p class="hint" style="margin-top:10px">Provider/model: <span class="mono">${esc(cfg.provider)} / ${esc(cfg.model)}</span> · Prompt version: <span class="mono">${esc(cfg.promptVersion)}</span></p>
      </div>

      <div class="save-bar">
        <a class="btn" href="#/populacoes">Cancelar</a>
        <button type="submit" class="btn btn-primary" id="pr-execute">Executar ${members.length} leitura(s)</button>
      </div>
    </form>`;

  const textEl = $("#pr-text");
  textEl.addEventListener("input", () => { $("#pr-count").textContent = `${textEl.value.length} caracteres`; });
  $("#pr-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) { toast("Formato não suportado nesta fase. Use .txt ou .md.", "bad"); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      textEl.value = String(reader.result || "");
      textEl.dispatchEvent(new Event("input", { bubbles: true }));
      toast(`Arquivo "${file.name}" carregado — revise o conteúdo antes de executar.`, "ok");
    };
    reader.readAsText(file);
  });

  let executing = false;
  const form = $("#pr-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (executing) return;
    const survey = surveys.find((x) => x.id === $("#pr-survey").value);
    const text = textEl.value.trim();
    if (!survey) { toast("Selecione uma pesquisa.", "bad"); return; }
    if (text.length < 10) { toast("Forneça um texto para leitura (mínimo de algumas linhas).", "bad"); textEl.focus(); return; }

    executing = true;
    const btn = $("#pr-execute");
    btn.disabled = true;
    btn.textContent = "Criando execução…";

    const liveCfg = getLLMConfig();
    const mode = form.querySelector('input[name="pr-mode"]:checked')?.value || "demo";
    const isDemo = mode === "demo";

    const popRun = D.blankPopulationRun();
    popRun.populationId = pop.id;
    popRun.title = $("#pr-title").value.trim();
    popRun.inputText = text;
    popRun.surveyId = survey.id;
    popRun.provider = isDemo ? "demo-local" : liveCfg.provider;
    popRun.model = isDemo ? "simulador-v1" : "";
    popRun.promptVersion = liveCfg.promptVersion;
    // Persiste em PENDING e navega já para a tela de acompanhamento — a
    // orquestração roda em background (fora do ciclo de vida desta view) e
    // essa mesma PopulationRun já está localizável em S.state antes do
    // redirect, evitando qualquer "não encontrada" transitório.
    await S.savePopulationRun(popRun);
    location.hash = "#/population-runs/" + popRun.id;
    executePopulationRun(popRun, { population: pop, personas: members, survey, mode, liveCfg }).catch((err) => {
      console.error("Falha inesperada ao orquestrar PopulationRun", err);
    });
  });
}

// ---------------------------------------------- Acompanhamento de PopulationRun
// Estados visuais da ReadingRun de cada Persona dentro da PopulationRun —
// ícone + rótulo textual sempre juntos (status nunca é comunicado só por
// cor, conforme exigido).
const RUN_STATE_META = {
  PENDING: { icon: "○", label: "Aguardando", cls: "neutral" },
  RUNNING: { icon: "●", label: "Executando…", cls: "accent" },
  COMPLETED: { icon: "✓", label: "Concluído", cls: "ok" },
  FAILED: { icon: "✕", label: "Falhou", cls: "bad" },
};

function populationRunStatusBadge(status) {
  const cls = { PENDING: "neutral", RUNNING: "accent", COMPLETED: "ok", PARTIAL: "warn", FAILED: "bad", CANCELLED: "neutral" }[status] || "neutral";
  return `<span class="badge ${cls}">${esc(D.POPULATION_RUN_STATUS[status] || status)}</span>`;
}

function viewPopulationRunDetail(main, popRunId, query = {}) {
  let resumeAttempted = false;
  let hubMounted = false;

  const renderProgress = (popRun) => {
    const population = S.state.populations.find((p) => p.id === popRun.populationId);
    const snapshotPersonas = popRun.executionSnapshot?.personas || [];
    const total = snapshotPersonas.length;
    const runs = S.getReadingRunsForPopulationRun(popRun.id);
    const runByPersona = new Map(runs.map((r) => [r.personaId, r]));
    const completed = runs.filter((r) => r.status === "COMPLETED").length;
    const failed = runs.filter((r) => r.status === "FAILED").length;
    const pct = total ? Math.round(((completed + failed) / total) * 100) : 0;

    main.innerHTML = `
      ${pageHead(
        `Execução de população · ${esc(popRun.title || population?.name || "")}`,
        `Population: <b>${esc(population?.name || "—")}</b>`,
        `<button class="btn btn-danger" id="pr-cancel">Cancelar execução</button><a class="btn" href="#/populacoes">Voltar às populações</a>`
      )}
      ${popRun.legacyAttributeFallback ? `
      <div class="info-box warn" style="margin-bottom:14px"><span>⚠</span><span>Execução criada antes do congelamento de AttributeDefinitions (snapshot legado) — os atributos usados aqui foram lidos do catálogo atual no momento da retomada, e podem não corresponder exatamente ao catálogo original.</span></div>` : ""}
      <div class="card" style="margin-bottom:18px">
        <div class="q-meta" style="margin-bottom:10px">${populationRunStatusBadge(popRun.status)}</div>
        <p class="mono">${completed + failed} / ${total} leituras concluídas${failed ? ` · ${failed} falharam` : ""}</p>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="section-title">Personas</div>
      <div class="pr-status-list">
        ${snapshotPersonas.map((persona) => {
          const run = runByPersona.get(persona.id);
          const status = run ? run.status : "PENDING";
          const meta = RUN_STATE_META[status] || RUN_STATE_META.PENDING;
          return `
          <div class="pr-status-item">
            <div class="pr-status-main">
              <span class="pr-status-icon ${meta.cls}">${meta.icon}</span>
              <span>${esc(persona.code ? persona.code + " — " : "")}${esc(persona.name)}</span>
            </div>
            <div class="pr-status-side">
              <span class="badge ${meta.cls}">${meta.label}</span>
              ${status === "COMPLETED" ? `<a class="btn btn-sm" href="#/execucoes/${run.id}?from=population-runs/${popRun.id}">Ver resultado</a>` : ""}
              ${status === "FAILED" ? `<button type="button" class="btn btn-sm btn-ghost" data-toggle-err="${run.id}">Ver erro</button>` : ""}
            </div>
          </div>
          ${status === "FAILED" ? `<div class="pr-error-msg" id="err-${run.id}" hidden>${esc(run.errorMessage || "Falha desconhecida.")}</div>` : ""}`;
        }).join("")}
      </div>`;

    $("#pr-cancel")?.addEventListener("click", async () => {
      if (!confirm("Cancelar esta execução de população? Leituras já concluídas não serão apagadas.")) return;
      await cancelPopulationRun(popRun.id);
      toast("Execução de população cancelada.", "ok");
      tick();
    });
    $$("[data-toggle-err]", main).forEach((b) => b.addEventListener("click", () => {
      const box = document.getElementById("err-" + b.dataset.toggleErr);
      if (box) box.hidden = !box.hidden;
    }));
  };

  const tick = () => {
    const popRun = S.state.populationRuns.find((p) => p.id === popRunId);
    if (!popRun) {
      main.innerHTML = `${pageHead("Execução de população", "", `<a class="btn" href="#/populacoes">Voltar</a>`)}
        <div class="info-box warn"><span>⚠</span><span>Esta execução de população não foi encontrada.</span></div>`;
      if (activePoll) { clearInterval(activePoll); activePoll = null; }
      return;
    }

    const isRunning = popRun.status === "RUNNING" || popRun.status === "PENDING";
    if (isRunning) {
      hubMounted = false;
      renderProgress(popRun);
      // Retoma automaticamente (uma única vez por montagem desta tela) uma
      // execução presa em RUNNING sem loop ativo nesta aba — cobre o caso de
      // a página ter sido recarregada no meio da execução.
      if (popRun.status === "RUNNING" && !resumeAttempted && !isPopulationRunActive(popRun.id)) {
        resumeAttempted = true;
        resumePopulationRun(popRun.id).catch((err) => console.error("Falha ao retomar PopulationRun", err));
      }
      return;
    }

    if (activePoll) { clearInterval(activePoll); activePoll = null; }
    // Estado terminal: a partir daqui nada mais muda nesta execução — o hub
    // é montado uma única vez (troca de aba não precisa de novo polling).
    if (!hubMounted) {
      hubMounted = true;
      renderPopulationRunHub(main, popRun, { initialTab: query.tab });
    }
  };

  tick();
  activePoll = setInterval(tick, 900);
}

// ---------------------------------------------------- Hub de resultados
// Tela de uma PopulationRun já finalizada (COMPLETED/PARTIAL/FAILED/
// CANCELLED): cabeçalho com os metadados da execução + abas. Apenas
// Resumo/Leitores/Dados são implementadas por completo nesta etapa —
// Heatmap/Reações/Perguntas existem só como placeholder, preparando a
// navegação para os módulos analíticos futuros.
const HUB_TABS = [
  ["resumo", "Resumo"],
  ["heatmap", "Heatmap"],
  ["reacoes", "Reações"],
  ["segmentos", "Segmentos"],
  ["analise", "Análise"],
  ["perguntas", "Perguntas"],
  ["leitores", "Leitores"],
  ["dados", "Dados"],
];

// Presets iniciais referenciados por SLUG do atributo (nunca por ID) — só
// aparecem se o atributo correspondente existir no catálogo atual.
const BUILTIN_SEGMENT_PRESETS = [
  { name: "Plot-driven", ruleDefs: [{ slug: "orientacao-a-enredo", op: ">=", value: 70 }] },
  { name: "Character-driven", ruleDefs: [{ slug: "orientacao-a-personagens", op: ">=", value: 70 }] },
  { name: "Ideas-driven", ruleDefs: [{ slug: "orientacao-a-ideias", op: ">=", value: 70 }] },
];

function populationRunBundle(popRun) {
  const readingRuns = S.getReadingRunsForPopulationRun(popRun.id);
  const readingResults = readingRuns.map((r) => S.getResultForRun(r.id)).filter(Boolean);
  return { populationRun: popRun, readingRuns, readingResults };
}

// Tipos de pergunta com valor numérico comparável entre leitores — a matriz
// nunca lista perguntas por nome fixo, sempre a partir da Survey congelada.
const HEATMAP_QUESTION_TYPES = new Set(["scale", "number"]);

function renderPopulationRunHub(main, popRun, { initialTab } = {}) {
  const population = S.state.populations.find((p) => p.id === popRun.populationId);
  const survey = S.state.surveys.find((s) => s.id === popRun.surveyId) || popRun.executionSnapshot?.survey || null;
  const snapshotSurvey = popRun.executionSnapshot?.survey || survey;
  const snapshotPersonas = popRun.executionSnapshot?.personas || [];
  const total = snapshotPersonas.length;
  const runs = S.getReadingRunsForPopulationRun(popRun.id);
  const runByPersona = new Map(runs.map((r) => [r.personaId, r]));
  const completed = runs.filter((r) => r.status === "COMPLETED").length;
  const failed = runs.filter((r) => r.status === "FAILED").length;

  let activeTab = HUB_TABS.some(([key]) => key === initialTab) ? initialTab : "resumo";
  let heatmapSort = { by: "code", dir: "asc" };
  let questionStatsSort = "mean_desc";
  let reactionsSort = { by: "freq", dir: "desc" };
  let reactionsShowZero = false;
  let openReactionCodes = new Set();
  let segmentCompareMode = "vs-all"; // "vs-all" | "vs-segment"
  let segmentARules = [];
  let segmentBRules = [];
  // Presets salvos nesta sessão (sem persistência — reinicia ao sair do hub).
  let customPresets = [];
  let analysisRunning = false;
  let selectedAnalysisId = null;

  // Link contextual para o relatório individual — preserva de onde veio
  // (esta PopulationRun + aba atual) para o botão "Voltar" funcionar.
  const runReportLink = (runId) => `#/execucoes/${runId}?from=population-runs/${popRun.id}&tab=${encodeURIComponent(activeTab)}`;

  // Atributos elegíveis para regras de segmento: só os que ao menos uma
  // Persona desta execução tem explicitamente configurados.
  const ruleAttributeOptions = () => {
    const ids = new Set();
    snapshotPersonas.forEach((p) => Object.keys(p.attributeValues || {}).forEach((id) => ids.add(id)));
    return [...ids]
      .map((id) => S.state.attributes.find((a) => a.id === id))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  };

  // Resolve os slugs de um preset contra o catálogo atual de atributos —
  // preset só fica disponível se TODOS os atributos referenciados existirem.
  const resolvePresetRules = (ruleDefs) => {
    const rules = ruleDefs.map((rd) => {
      const attribute = S.state.attributes.find((a) => a.slug === rd.slug);
      return attribute ? { attributeId: attribute.id, op: rd.op, value: rd.value } : null;
    });
    return rules.every(Boolean) ? rules : null;
  };

  const availablePresets = () => [
    ...BUILTIN_SEGMENT_PRESETS.map((p) => ({ name: p.name, rules: resolvePresetRules(p.ruleDefs) })).filter((p) => p.rules),
    ...customPresets,
  ];

  // Filtro de segmento e busca de fonte única — reutiliza literalmente as
  // mesmas fórmulas do módulo compartilhado (também usado pelo dataset do
  // Research Analyst).
  const segmentPersonas = (rules) => filterPersonasBySegment(snapshotPersonas, rules);
  const runsForPersonas = (personaList) => runs.filter((r) => personaList.some((p) => p.id === r.personaId));

  // Colunas dinâmicas: perguntas quantitativas (scale/number) da Survey
  // congelada no snapshot — nunca por nome fixo.
  const heatmapQuestions = (snapshotSurvey?.questions || []).filter((q) => HEATMAP_QUESTION_TYPES.has(q.type));

  // Estatísticas por pergunta (N, média, mediana, faixa, desvio populacional
  // e Índice de Divergência) — só sobre respostas válidas dos leitores que
  // concluíram a leitura; ausência de resposta nunca vira zero. Guarda quem
  // deu o maior/menor valor para permitir navegar até o leitor de origem.
  // Aceita um subconjunto de ReadingRuns (usado pela aba Segmentos); por
  // padrão considera todos os leitores desta PopulationRun.
  const questionStats = (runsSubset = runs) =>
    computeQuestionStats(heatmapQuestions, runsSubset, snapshotPersonas, S.getResultForRun);

  const sortedQuestionStats = () => {
    const list = questionStats();
    const [key, dir] = questionStatsSort.split("_");
    const mul = dir === "desc" ? -1 : 1;
    list.sort((a, b) => {
      const av = key === "mean" ? a.stats.mean : a.stats.divergence;
      const bv = key === "mean" ? b.stats.mean : b.stats.divergence;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // sem estatística (N=0) sempre por último
      if (bv == null) return -1;
      return (av - bv) * mul;
    });
    return list;
  };

  // Rótulo + link de um leitor destacado (maior/menor valor) — a Persona é
  // sempre clicável até seu relatório individual.
  const outlierLink = (entry) => {
    if (!entry?.run) return "";
    const label = entry.persona ? `${entry.persona.code ? esc(entry.persona.code) + " — " : ""}${esc(entry.persona.name)}` : "(persona removida)";
    return `<div class="qstat-outlier"><a href="${runReportLink(entry.run.id)}">${label}</a></div>`;
  };

  const renderQuestionStatsCards = () => {
    const list = sortedQuestionStats();
    return `
      <div class="heatmap-toolbar">
        <label class="hint" for="qstats-sort">Ordenar por</label>
        <select id="qstats-sort">
          <option value="mean_desc" ${questionStatsSort === "mean_desc" ? "selected" : ""}>Maior média</option>
          <option value="mean_asc" ${questionStatsSort === "mean_asc" ? "selected" : ""}>Menor média</option>
          <option value="divergence_desc" ${questionStatsSort === "divergence_desc" ? "selected" : ""}>Maior divergência</option>
          <option value="divergence_asc" ${questionStatsSort === "divergence_asc" ? "selected" : ""}>Menor divergência</option>
        </select>
        <span class="hint" title="Índice comparativo interno baseado na dispersão das respostas.">ⓘ o que é divergência?</span>
      </div>
      <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:18px">
        ${list.map(({ question, stats, maxEntry, minEntry }) => `
          <div class="card qstat-card">
            <div class="qstat-title">${esc(question.text)}</div>
            ${stats.n === 0
              ? `<p class="faint small">Sem respostas válidas.</p>`
              : `
                <div class="qstat-row"><span>Média</span><b class="mono">${Math.round(stats.mean)}</b></div>
                <div class="qstat-row"><span>Mediana</span><b class="mono">${Math.round(stats.median)}</b></div>
                <div class="qstat-row"><span>Maior valor</span><b class="mono">${stats.max}</b></div>
                ${outlierLink(maxEntry)}
                <div class="qstat-row"><span>Menor valor</span><b class="mono">${stats.min}</b></div>
                ${outlierLink(minEntry)}
                <div class="qstat-row"><span>Desvio (populacional)</span><b class="mono">${Math.round(stats.standardDeviation)}</b></div>
                ${stats.divergence != null
                  ? `<div class="qstat-row"><span>Divergência</span><b class="mono">${Math.round(stats.divergence * 100)}%</b></div>
                     <span class="badge ${stats.classification.cls}" title="Índice comparativo interno baseado na dispersão das respostas.">${stats.classification.label}</span>`
                  : `<p class="faint small">Escala sem amplitude — divergência não calculada.</p>`}
                <p class="hint" style="margin-top:6px">N = ${stats.n}</p>`}
          </div>`).join("")}
      </div>`;
  };

  const heatmapRows = () => snapshotPersonas.map((persona) => {
    const run = runByPersona.get(persona.id);
    const result = run && run.status === "COMPLETED" ? S.getResultForRun(run.id) : null;
    const values = heatmapQuestions.map((q) => {
      const ans = result?.surveyAnswers.find((a) => a.questionId === q.id);
      return ans ? ans.value : null;
    });
    return { persona, run, values };
  });

  const sortedHeatmapRows = () => {
    const rows = heatmapRows();
    const { by, dir } = heatmapSort;
    const mul = dir === "desc" ? -1 : 1;
    const qIdx = by.startsWith("q:") ? heatmapQuestions.findIndex((q) => q.id === by.slice(2)) : -1;
    rows.sort((a, b) => {
      let av, bv;
      if (by === "code") { av = a.persona.code || ""; bv = b.persona.code || ""; }
      else if (by === "name") { av = a.persona.name || ""; bv = b.persona.name || ""; }
      else { av = qIdx >= 0 ? a.values[qIdx] : null; bv = qIdx >= 0 ? b.values[qIdx] : null; }
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // sem valor sempre por último, em qualquer direção
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv, "pt-BR") * mul;
      return (av - bv) * mul;
    });
    return rows;
  };

  const renderHeatmapTab = () => {
    if (!heatmapQuestions.length) {
      return `<div class="empty-state"><div class="big">Sem perguntas quantitativas</div><p>Esta Survey não possui perguntas do tipo escala ou número para comparar visualmente.</p></div>`;
    }
    const rows = sortedHeatmapRows();
    return `
      ${renderQuestionStatsCards()}
      <div class="section-title">Matriz por leitor</div>
      <div class="heatmap-toolbar">
        <label class="hint" for="heatmap-sort-by">Ordenar por</label>
        <select id="heatmap-sort-by">
          <option value="code" ${heatmapSort.by === "code" ? "selected" : ""}>Código da persona</option>
          <option value="name" ${heatmapSort.by === "name" ? "selected" : ""}>Nome da persona</option>
          ${heatmapQuestions.map((q) => `<option value="q:${q.id}" ${heatmapSort.by === "q:" + q.id ? "selected" : ""}>${esc(q.text)}</option>`).join("")}
        </select>
        <button type="button" class="btn btn-sm" id="heatmap-sort-dir">${heatmapSort.dir === "asc" ? "↑ Crescente" : "↓ Decrescente"}</button>
      </div>
      <div class="table-wrap heatmap-table-wrap">
        <table class="heatmap-table">
          <thead><tr>
            <th>Persona</th>
            ${heatmapQuestions.map((q) => `<th title="${esc(q.text)}"><span class="heatmap-q-head">${esc(q.text)}</span></th>`).join("")}
          </tr></thead>
          <tbody>
            ${rows.map(({ persona, run, values }) => `
              <tr>
                <td class="heatmap-persona-cell">
                  <span>${esc(persona.code ? persona.code + " — " : "")}${esc(persona.name)}</span>
                  ${run?.status === "FAILED" ? ` <span class="badge bad">Falhou</span>` : ""}
                  ${run ? `<a class="heatmap-persona-link" href="${runReportLink(run.id)}">Ver relatório</a>` : ""}
                </td>
                ${heatmapQuestions.map((q, i) => {
                  const val = values[i];
                  if (val == null || typeof val !== "number") {
                    return `<td class="heatmap-cell empty">—</td>`;
                  }
                  const min = q.min ?? 0, max = q.max ?? 100;
                  const norm = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
                  const alpha = (0.08 + norm * 0.72).toFixed(2);
                  return `<td class="heatmap-cell" style="background:rgba(79,142,247,${alpha})"
                    data-heatmap-cell
                    data-persona="${esc(persona.code ? persona.code + " — " : "")}${esc(persona.name)}"
                    data-question="${esc(q.text)}"
                    data-value="${val}"
                    data-max="${max}"
                    data-run="${run.id}">${esc(String(val))}</td>`;
                }).join("")}
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div class="heatmap-detail" id="heatmap-detail" hidden></div>`;
  };

  // Só agrega reaction_code presentes no snapshot desta execução — reações
  // criadas/renomeadas depois não contaminam o histórico. Aceita um
  // subconjunto de ReadingRuns (usado pela aba Segmentos); por padrão
  // considera todos os leitores desta PopulationRun.
  const computeReactionStats = (runsSubset = runs) =>
    computeReactionAggregates(popRun.executionSnapshot?.reactions || [], runsSubset, snapshotPersonas, S.getResultForRun);

  const renderReactionDrilldown = (s) => {
    if (!s.matches.length) return `<p class="faint small" style="padding:0 2px">Nenhum leitor registrou esta reação.</p>`;
    return `
      <div class="pr-status-list">
        ${s.matches.map(({ run, rr, persona }) => `
          <div class="pr-status-item">
            <div class="pr-status-main">
              <div>
                <div>${esc(persona?.code ? persona.code + " — " : "")}${esc(persona?.name || "(persona removida)")}</div>
                ${rr.intensity != null ? `<div class="mono small faint">${rr.intensity} / 100</div>` : ""}
                ${rr.reason ? `<p class="muted small" style="margin-top:4px">${esc(rr.reason)}</p>` : ""}
              </div>
            </div>
            <div class="pr-status-side">
              <a class="btn btn-sm" href="${runReportLink(run.id)}">Ver relatório individual</a>
            </div>
          </div>`).join("")}
      </div>`;
  };

  const renderReacoesTab = () => {
    const snapshotReactions = popRun.executionSnapshot?.reactions || [];
    if (!snapshotReactions.length) {
      return `<div class="empty-state"><div class="big">Sem reações no snapshot</div><p>Esta execução não tinha reações configuradas.</p></div>`;
    }
    const { validCount, stats } = computeReactionStats();
    let list = reactionsShowZero ? stats : stats.filter((s) => s.count > 0);
    const mul = reactionsSort.dir === "desc" ? -1 : 1;
    list = [...list].sort((a, b) => {
      if (reactionsSort.by === "nome") return a.def.name.localeCompare(b.def.name, "pt-BR") * mul;
      if (reactionsSort.by === "intensidade") {
        if (a.avg == null && b.avg == null) return 0;
        if (a.avg == null) return 1;
        if (b.avg == null) return -1;
        return (a.avg - b.avg) * mul;
      }
      return (a.count - b.count) * mul;
    });
    return `
      <div class="heatmap-toolbar">
        <label class="hint" for="reac-sort-by">Ordenar por</label>
        <select id="reac-sort-by">
          <option value="freq" ${reactionsSort.by === "freq" ? "selected" : ""}>Frequência</option>
          <option value="intensidade" ${reactionsSort.by === "intensidade" ? "selected" : ""}>Intensidade média</option>
          <option value="nome" ${reactionsSort.by === "nome" ? "selected" : ""}>Nome</option>
        </select>
        <button type="button" class="btn btn-sm" id="reac-sort-dir">${reactionsSort.dir === "asc" ? "↑ Crescente" : "↓ Decrescente"}</button>
        <label class="checkbox-row" style="padding-left:0;margin-left:auto">
          <input type="checkbox" id="reac-show-zero" ${reactionsShowZero ? "checked" : ""}> Mostrar reações sem ocorrência
        </label>
      </div>
      ${!list.length
        ? `<div class="empty-state"><div class="big">Nenhuma reação registrada</div><p>Marque "Mostrar reações sem ocorrência" para ver a lista completa.</p></div>`
        : `<div class="pr-status-list">
            ${list.map((s) => {
              const open = openReactionCodes.has(s.def.code);
              return `
              <div class="pr-status-item" style="flex-direction:column;align-items:stretch;gap:8px">
                <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
                  <span class="reaction-dot" style="background:${esc(s.def.color)}"></span>
                  <b>${esc(s.def.name)}</b>
                  <span class="mono faint small">${esc(s.def.code)}</span>
                  ${reactionPolarityBadge(s.def.polarity)}
                  <span class="mono small" style="margin-left:auto">${s.count} / ${validCount}</span>
                  <span class="badge neutral">${s.pct}%</span>
                </div>
                ${s.def.intensityEnabled && s.avg != null ? `
                <div class="q-meta">
                  <span class="hint">Intensidade média: <b class="mono">${s.avg}</b></span>
                  <span class="hint">mín: <b class="mono">${s.min}</b></span>
                  <span class="hint">máx: <b class="mono">${s.max}</b></span>
                </div>` : ""}
                <div>
                  <button type="button" class="btn btn-sm btn-ghost" data-toggle-reaction="${esc(s.def.code)}">${open ? "Ocultar leitores" : `Ver leitores (${s.count})`}</button>
                </div>
                ${open ? renderReactionDrilldown(s) : ""}
              </div>`;
            }).join("")}
          </div>`}`;
  };

  // ---------------------------------------------------------- Segmentos
  // Um "grupo" (A ou B) é combinado com AND — sem clustering automático,
  // apenas filtros determinísticos sobre atributos já existentes.
  const renderRuleRow = (group, rule, idx) => {
    const options = ruleAttributeOptions();
    return `
      <div class="rule-row">
        <select data-rule-field="attributeId" data-rule-group="${group}" data-rule-idx="${idx}">
          <option value="">Selecione um atributo…</option>
          ${options.map((a) => `<option value="${a.id}" ${rule.attributeId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
        </select>
        <select data-rule-field="op" data-rule-group="${group}" data-rule-idx="${idx}">
          ${Object.keys(SEGMENT_RULE_OPS).map((op) => `<option value="${op}" ${rule.op === op ? "selected" : ""}>${op}</option>`).join("")}
        </select>
        <input type="number" data-rule-field="value" data-rule-group="${group}" data-rule-idx="${idx}" value="${rule.value ?? ""}" placeholder="valor">
        <button type="button" class="btn btn-sm btn-ghost btn-danger" data-rule-remove="${group}" data-rule-idx="${idx}">Remover</button>
      </div>`;
  };

  const renderRuleBuilder = (group, rules, title) => {
    const eligible = segmentPersonas(rules);
    return `
      <div class="rule-builder">
        <div class="rule-builder-head">
          <b>${esc(title)}</b>
          <span class="badge neutral">N = ${eligible.length}</span>
        </div>
        ${rules.length === 0 ? `<p class="faint small">Sem filtros — considera todos os leitores desta execução.</p>` : ""}
        ${rules.map((r, i) => `${i > 0 ? `<div class="rule-and">E</div>` : ""}${renderRuleRow(group, r, i)}`).join("")}
        <div class="rule-builder-actions">
          <button type="button" class="btn btn-sm" data-rule-add="${group}">+ Adicionar regra</button>
          ${rules.length ? `<button type="button" class="btn btn-sm btn-ghost" data-rule-clear="${group}">Limpar regras</button>` : ""}
        </div>
      </div>`;
  };

  const renderPresetsRow = () => {
    const presets = availablePresets();
    return `
      <div class="preset-row">
        <span class="hint">Presets (Segmento${segmentCompareMode === "vs-segment" ? " A" : ""}):</span>
        ${presets.length === 0
          ? `<span class="faint small">Nenhum preset disponível para o catálogo de atributos atual.</span>`
          : presets.map((p, i) => `<button type="button" class="btn btn-sm btn-ghost preset-chip" data-preset-apply="${i}">${esc(p.name)}</button>`).join("")}
        ${segmentARules.length ? `<button type="button" class="btn btn-sm btn-ghost" data-preset-save>Salvar Segmento${segmentCompareMode === "vs-segment" ? " A" : ""} como preset</button>` : ""}
      </div>`;
  };

  // Uma "coluna" de comparação: leitores elegíveis + estatísticas por
  // pergunta e por reação, recalculadas apenas sobre esse subconjunto.
  const buildSegmentColumn = (label, rules) => {
    const personas = segmentPersonas(rules);
    const runsSubset = runsForPersonas(personas);
    return { label, personas, runsSubset, questionStats: questionStats(runsSubset), reactionStats: computeReactionStats(runsSubset) };
  };

  const renderQuestionComparisonTable = (columns) => `
    <div class="table-wrap" style="margin-bottom:18px">
      <table>
        <thead><tr>
          <th>Pergunta</th>
          ${columns.map((c) => `<th>${esc(c.label)}<br><span class="faint small mono">N = ${c.personas.length}</span></th>`).join("")}
        </tr></thead>
        <tbody>
          ${heatmapQuestions.map((q, qi) => `
            <tr>
              <td>${esc(q.text)}</td>
              ${columns.map((c) => {
                const s = c.questionStats[qi].stats;
                if (s.n === 0) return `<td class="faint small">sem dados</td>`;
                return `<td>
                  <div class="mono">${Math.round(s.mean)}</div>
                  <div class="faint small">${s.divergence != null ? Math.round(s.divergence * 100) + "% div." : "—"} · n=${s.n}</div>
                </td>`;
              }).join("")}
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  const renderReactionComparisonTable = (columns) => {
    const snapshotReactions = popRun.executionSnapshot?.reactions || [];
    if (!snapshotReactions.length) return `<p class="faint small">Esta execução não tinha reações configuradas.</p>`;
    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Reação</th>
            ${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}
          </tr></thead>
          <tbody>
            ${snapshotReactions.map((def) => `
              <tr>
                <td><span class="reaction-dot" style="background:${esc(def.color)}"></span> ${esc(def.name)}</td>
                ${columns.map((c) => {
                  const s = c.reactionStats.stats.find((x) => x.def.code === def.code);
                  if (!s || !c.reactionStats.validCount) return `<td class="faint small">—</td>`;
                  return `<td><div class="mono">${s.pct}%</div><div class="faint small">${s.count}/${c.reactionStats.validCount}${s.avg != null ? ` · int. ${s.avg}` : ""}</div></td>`;
                }).join("")}
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  };

  // Opcional: ranking simples (não é clustering) dos leitores cujas
  // respostas quantitativas mais se afastam, em média, da média do grupo.
  const renderOutliers = () => {
    const stats = questionStats(runs).filter((qs) => qs.stats.n >= 2 && qs.stats.divergence != null);
    if (!stats.length) return "";
    const scores = new Map();
    stats.forEach(({ question, stats: s }) => {
      const range = (question.max ?? 100) - (question.min ?? 0) || 1;
      runs.filter((r) => r.status === "COMPLETED").forEach((r) => {
        const ans = S.getResultForRun(r.id)?.surveyAnswers.find((a) => a.questionId === question.id);
        if (!ans || typeof ans.value !== "number") return;
        const dist = Math.abs(ans.value - s.mean) / range;
        const entry = scores.get(r.personaId) || { sum: 0, count: 0, run: r };
        entry.sum += dist; entry.count += 1;
        scores.set(r.personaId, entry);
      });
    });
    const list = [...scores.entries()]
      .map(([personaId, e]) => ({ persona: snapshotPersonas.find((p) => p.id === personaId), run: e.run, avgDistance: e.sum / e.count }))
      .filter((x) => x.persona)
      .sort((a, b) => b.avgDistance - a.avgDistance)
      .slice(0, 5);
    if (!list.length) return "";
    return `
      <details class="card" style="margin-top:18px">
        <summary style="cursor:pointer;font-weight:650">Leitores mais distantes da média (todos os leitores)</summary>
        <p class="faint small" style="margin-top:8px">Distância normalizada média entre a resposta do leitor e a média do grupo, por pergunta quantitativa. Ranking simples — não é clustering.</p>
        <div class="pr-status-list" style="margin-top:8px">
          ${list.map(({ persona, run, avgDistance }) => `
            <div class="pr-status-item">
              <div class="pr-status-main">${esc(persona.code ? persona.code + " — " : "")}${esc(persona.name)}</div>
              <div class="pr-status-side">
                <span class="mono small">${Math.round(avgDistance * 100)}% dist.</span>
                <a class="btn btn-sm" href="${runReportLink(run.id)}">Ver relatório</a>
              </div>
            </div>`).join("")}
        </div>
      </details>`;
  };

  const renderSegmentosTab = () => {
    const columns = segmentCompareMode === "vs-all"
      ? [buildSegmentColumn("Todos os leitores", []), buildSegmentColumn("Segmento", segmentARules)]
      : [buildSegmentColumn("Segmento A", segmentARules), buildSegmentColumn("Segmento B", segmentBRules)];
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="toolbar" style="margin-bottom:12px">
          <label class="radio-row"><input type="radio" name="seg-mode" value="vs-all" ${segmentCompareMode === "vs-all" ? "checked" : ""}> Todos vs Segmento</label>
          <label class="radio-row"><input type="radio" name="seg-mode" value="vs-segment" ${segmentCompareMode === "vs-segment" ? "checked" : ""}> Segmento A vs Segmento B</label>
        </div>
        ${renderPresetsRow()}
        ${renderRuleBuilder("A", segmentARules, segmentCompareMode === "vs-all" ? "Segmento" : "Segmento A")}
        ${segmentCompareMode === "vs-segment" ? renderRuleBuilder("B", segmentBRules, "Segmento B") : ""}
      </div>
      <div class="section-title">Perguntas quantitativas</div>
      ${heatmapQuestions.length ? renderQuestionComparisonTable(columns) : `<p class="faint small">Esta Survey não possui perguntas quantitativas.</p>`}
      <div class="section-title">Reações</div>
      ${renderReactionComparisonTable(columns)}
      ${renderOutliers()}`;
  };

  // ------------------------------------------------- Aba Análise (Research Analyst)
  // O Research Analyst interpreta os agregados já calculados por esta
  // PopulationRun (nunca recalcula estatística) — ver js/analysisEngine.js.
  // Reutiliza as regras de segmento já configuradas na aba Segmentos, sem
  // duplicar UI de filtro.
  const isCompleteRuleSet = (rules) => rules.length > 0 && rules.every((r) => r.attributeId && r.value !== "" && r.value != null);

  const activeSegmentsForAnalysis = () => {
    const segs = [];
    if (isCompleteRuleSet(segmentARules)) {
      segs.push({ name: segmentCompareMode === "vs-segment" ? "Segmento A" : "Segmento", rules: segmentARules.map((r) => ({ ...r })) });
    }
    if (segmentCompareMode === "vs-segment" && isCompleteRuleSet(segmentBRules)) {
      segs.push({ name: "Segmento B", rules: segmentBRules.map((r) => ({ ...r })) });
    }
    return segs;
  };

  // Evidence tem dois formatos possíveis: legado (schema v1, texto livre
  // `{ type, reference, value }`, nunca verificado deterministicamente) e
  // estruturado (schema v2+, verificado contra o dataset — ver
  // llm/researchAnalystValidate.js). Detecta pelo shape do próprio item,
  // sem precisar propagar analysisSchemaVersion por toda a árvore de render.
  const renderEvidenceList = (evidence) => {
    if (!evidence || !evidence.length) return "";
    const describe = (e) => {
      if (e.reference !== undefined) {
        return `<span class="badge neutral">${esc(e.type)}</span> <span class="mono small">${esc(e.reference)}</span>${e.value ? ` — <span class="mono">${esc(e.value)}</span>` : ""}`;
      }
      const ref = e.metricId || e.reactionCode || e.segmentId || e.questionId || "";
      const bits = [`<span class="badge ok">${esc(e.type)}</span>`];
      if (e.personaCode) bits.push(`<span class="mono small">${esc(e.personaCode)}</span>`);
      if (ref) bits.push(`<span class="mono small">${esc(ref)}</span>`);
      if (e.field) bits.push(`<span class="faint small">${esc(e.field)}</span>`);
      if (e.value !== undefined && e.value !== "") bits.push(`— <span class="mono">${esc(String(e.value))}</span>`);
      return bits.join(" ");
    };
    return `<ul class="evidence-list">${evidence.map((e) => `<li>${describe(e)}</li>`).join("")}</ul>`;
  };

  const confidenceBadge = (c) => {
    const cls = c === "high" ? "ok" : c === "medium" ? "accent" : "neutral";
    const label = c === "high" ? "Confiança alta" : c === "medium" ? "Confiança média" : "Confiança baixa";
    return `<span class="badge ${cls}" title="Quão diretamente os dados sustentam esta hipótese — não é significância estatística.">${label}</span>`;
  };

  const renderAnalysisReport = (run) => {
    const a = run.analysisJson;
    const outlierLink = (code) => {
      const persona = snapshotPersonas.find((p) => p.code === code);
      const orun = persona ? runByPersona.get(persona.id) : null;
      return orun ? `<a class="btn btn-sm" href="${runReportLink(orun.id)}">Ver relatório individual</a>` : "";
    };
    const cardsGrid = (items, render) => items.length
      ? `<div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-bottom:18px">${items.map(render).join("")}</div>`
      : "";

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="q-meta" style="margin-bottom:8px">
          <span class="badge ${run.status === "COMPLETED" ? "ok" : run.status === "FAILED" ? "bad" : "accent"}">${esc(D.ANALYSIS_RUN_STATUS[run.status] || run.status)}</span>
          <span class="mono small">${fmtDate(run.createdAt)}</span>
          <span class="faint">·</span>
          <span class="mono small">${esc(run.provider)} / ${esc(run.model)}</span>
          <span class="faint">·</span>
          <span class="mono small">prompt ${esc(run.promptVersion)}</span>
        </div>
        ${run.status === "FAILED" ? `<div class="info-box bad"><span>⚠</span><span>${esc(run.errorMessage || "Falha desconhecida.")}</span></div>` : ""}
      </div>
      ${!a ? `<div class="empty-state"><div class="big">Sem resultado estruturado</div><p>Esta análise não produziu um resultado válido.</p></div>` : `
      ${a.executiveSummary ? `<div class="card" style="margin-bottom:18px"><div class="section-title" style="margin-top:0">Resumo executivo</div><p>${esc(a.executiveSummary)}</p></div>` : ""}
      ${a.consensus.length ? `<div class="section-title">Consensos</div>${cardsGrid(a.consensus, (c) => `<div class="card"><div class="qstat-title">${esc(c.title)}</div><p class="muted small">${esc(c.observation)}</p>${renderEvidenceList(c.evidence)}</div>`)}` : ""}
      ${a.polarization.length ? `<div class="section-title">Polarizações</div>${cardsGrid(a.polarization, (p) => `<div class="card"><div class="qstat-title">${esc(p.title)}</div><p class="muted small">${esc(p.observation)}</p>${p.interpretation ? `<p class="faint small"><i>${esc(p.interpretation)}</i></p>` : ""}${renderEvidenceList(p.evidence)}</div>`)}` : ""}
      ${a.segmentInsights.length ? `<div class="section-title">Diferenças entre segmentos</div>${cardsGrid(a.segmentInsights, (s) => `<div class="card"><div class="qstat-title">${esc(s.segment)}</div><p class="muted small">${esc(s.observation)}</p>${s.interpretation ? `<p class="faint small"><i>${esc(s.interpretation)}</i></p>` : ""}${renderEvidenceList(s.evidence)}</div>`)}` : ""}
      ${a.outliers.length ? `<div class="section-title">Outliers</div><div class="pr-status-list" style="margin-bottom:18px">${a.outliers.map((o) => `
        <div class="pr-status-item">
          <div class="pr-status-main"><div>
            <div>${esc(o.personaCode)}${o.personaName ? " — " + esc(o.personaName) : ""}</div>
            <p class="muted small" style="margin-top:4px">${esc(o.observation)}</p>
            ${renderEvidenceList(o.evidence)}
          </div></div>
          <div class="pr-status-side">${outlierLink(o.personaCode)}</div>
        </div>`).join("")}</div>` : ""}
      ${a.reactionPatterns.length ? `<div class="section-title">Padrões de reações</div>${cardsGrid(a.reactionPatterns, (r) => `<div class="card"><div class="qstat-title">${esc(r.reactionCode)}</div><p class="muted small">${esc(r.observation)}</p>${renderEvidenceList(r.evidence)}</div>`)}` : ""}
      ${a.qualitativePatterns.length ? `<div class="section-title">Padrões qualitativos</div>${cardsGrid(a.qualitativePatterns, (q) => `<div class="card">${q.questionId ? `<div class="faint small mono">${esc(q.questionId)}</div>` : ""}<p class="muted small">${esc(q.pattern)}</p>${renderEvidenceList(q.evidence)}</div>`)}` : ""}
      ${a.interestingContradictions.length ? `<div class="section-title">Contradições interessantes</div>${cardsGrid(a.interestingContradictions, (c) => `<div class="card"><p class="muted small">${esc(c.observation)}</p>${c.interpretation ? `<p class="faint small"><i>${esc(c.interpretation)}</i></p>` : ""}${renderEvidenceList(c.evidence)}</div>`)}` : ""}
      ${a.investigationPoints.length ? `<div class="section-title">Pontos de investigação</div>${cardsGrid(a.investigationPoints, (p) => `<div class="card"><div class="qstat-title">${esc(p.title)}</div><p class="muted small">${esc(p.hypothesis)}</p>${p.whyInvestigate ? `<p class="faint small">${esc(p.whyInvestigate)}</p>` : ""}<div style="margin:6px 0">${confidenceBadge(p.confidence)}</div>${renderEvidenceList(p.evidence)}</div>`)}` : ""}
      ${a.limitations.length ? `<div class="section-title">Limitações</div><div class="card" style="margin-bottom:18px"><ul style="margin:0;padding-left:20px">${a.limitations.map((l) => `<li class="muted small">${esc(l)}</li>`).join("")}</ul></div>` : ""}
      <details class="card">
        <summary style="cursor:pointer;font-weight:650">Ver JSON da análise</summary>
        <div class="toolbar" style="margin:10px 0 0">
          <button type="button" class="btn btn-sm" id="analysis-copy-json">Copiar JSON</button>
          <button type="button" class="btn btn-sm" id="analysis-download-json">Baixar JSON</button>
        </div>
      </details>`}`;
  };

  const renderAnaliseTab = () => {
    const list = S.getAnalysisRunsForPopulationRun(popRun.id);
    const cfg = getLLMConfig();
    const willUseDemo = !cfg.endpoint;
    const selected = list.find((a) => a.id === selectedAnalysisId) || list[0] || null;
    return `
      <div class="card" style="margin-bottom:16px">
        <p class="muted small">O Research Analyst interpreta, com IA, os dados já produzidos por esta execução — ele não participa da leitura nem recalcula estatísticas: todos os números vêm do ReaderLab. Cada geração cria uma nova análise no histórico (nunca sobrescreve as anteriores).</p>
        ${willUseDemo ? `<div class="info-box warn" style="margin-top:10px"><span>⚠</span><span>Backend LLM não configurado — esta análise usará o simulador local (modo demo, sem chamada de rede real).</span></div>` : ""}
        <p class="hint" style="margin-top:10px">Provider/modelo que será utilizado: <span class="mono">${willUseDemo ? "demo-local / demo-analyst-v1" : esc(cfg.provider) + " / " + esc(cfg.model)}</span></p>
        <div class="toolbar" style="margin-top:12px">
          <button type="button" class="btn btn-primary" id="analysis-generate" ${analysisRunning ? "disabled" : ""}>${analysisRunning ? "Gerando análise…" : list.length ? "Gerar nova análise com IA" : "Gerar análise com IA"}</button>
        </div>
      </div>
      ${list.length ? `
      <div class="section-title">Histórico de análises</div>
      <div class="pr-status-list" style="margin-bottom:18px">
        ${list.map((a) => `
          <div class="pr-status-item">
            <div class="pr-status-main"><div>
              <div>${esc(a.provider)} / ${esc(a.model)} <span class="faint small">· prompt ${esc(a.promptVersion)}</span></div>
              <div class="faint small">${fmtDate(a.createdAt)}</div>
            </div></div>
            <div class="pr-status-side">
              <span class="badge ${a.status === "COMPLETED" ? "ok" : a.status === "FAILED" ? "bad" : "accent"}">${esc(D.ANALYSIS_RUN_STATUS[a.status] || a.status)}</span>
              <button type="button" class="btn btn-sm ${selected && selected.id === a.id ? "btn-primary" : ""}" data-analysis-open="${a.id}">Abrir</button>
            </div>
          </div>`).join("")}
      </div>` : ""}
      ${selected ? renderAnalysisReport(selected) : (!analysisRunning ? `<div class="empty-state"><div class="big">Nenhuma análise gerada ainda</div><p>Clique em "Gerar análise com IA" para que o Research Analyst interprete os resultados desta execução.</p></div>` : "")}`;
  };

  const renderTabContent = () => {
    if (activeTab === "resumo") {
      return `
        <div class="cards" style="margin-bottom:16px">
          <div class="card stat-card"><span class="stat-num">${total}</span><span class="stat-label">Leitores</span></div>
          <div class="card stat-card"><span class="stat-num">${completed}</span><span class="stat-label">Concluídos</span></div>
          <div class="card stat-card"><span class="stat-num">${failed}</span><span class="stat-label">Falharam</span></div>
        </div>
        <div class="card">
          <div class="kv" style="margin-bottom:6px"><b class="muted">Survey:</b>&nbsp;${esc(survey ? survey.name : "(pesquisa removida)")}</div>
          <div class="kv" style="margin-bottom:6px"><b class="muted">Modelo:</b>&nbsp;${esc(popRun.provider)} / ${esc(popRun.model)} · prompt ${esc(popRun.promptVersion)}</div>
          <div class="kv"><b class="muted">Tempo total:</b>&nbsp;${fmtDuration(popRun.startedAt, popRun.completedAt)}</div>
        </div>
        <p class="faint small" style="margin-top:14px">Estatísticas agregadas (divergência entre leitores, heatmap de reações, respostas por pergunta) chegam em uma próxima etapa.</p>`;
    }
    if (activeTab === "heatmap") return renderHeatmapTab();
    if (activeTab === "reacoes") return renderReacoesTab();
    if (activeTab === "segmentos") return renderSegmentosTab();
    if (activeTab === "analise") return renderAnaliseTab();
    if (activeTab === "leitores") {
      return `
        <div class="pr-status-list">
          ${snapshotPersonas.map((persona) => {
            const run = runByPersona.get(persona.id);
            const status = run ? run.status : "PENDING";
            const meta = RUN_STATE_META[status] || RUN_STATE_META.PENDING;
            return `
            <div class="pr-status-item">
              <div class="pr-status-main">
                <span class="pr-status-icon ${meta.cls}">${meta.icon}</span>
                <div>
                  <div>${esc(persona.code ? persona.code + " — " : "")}${esc(persona.name)}</div>
                  ${persona.shortDescription ? `<div class="faint small">${esc(persona.shortDescription)}</div>` : ""}
                </div>
              </div>
              <div class="pr-status-side">
                <span class="badge ${meta.cls}">${meta.label}</span>
                ${run ? `<a class="btn btn-sm" href="${runReportLink(run.id)}">Ver relatório individual</a>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>`;
    }
    if (activeTab === "dados") {
      return `
        <div class="card">
          <p class="muted small" style="margin-bottom:14px">JSON completo desta execução: PopulationRun, snapshot congelado (Population/Personas/Survey/Reações), ReadingRuns e ReadingResults. Nunca inclui chaves de API, tokens de sessão ou outros segredos — o app não os guarda localmente.</p>
          <div class="toolbar" style="margin-bottom:0">
            <button type="button" class="btn" id="pr-copy-json">Copiar JSON</button>
            <button type="button" class="btn" id="pr-download-json">Baixar JSON</button>
          </div>
        </div>`;
    }
    return `<div class="empty-state"><div class="big">Em breve</div><p>Este módulo será implementado na próxima etapa.</p></div>`;
  };

  const renderAll = () => {
    main.innerHTML = `
      ${pageHead(
        esc(popRun.title || "Execução de população"),
        `${esc(population?.name || "—")} · ${total} leitor(es)${survey ? " · " + esc(survey.name) : ""}`,
        `<a class="btn" href="#/populacoes">Voltar às populações</a>`
      )}
      ${popRun.legacyAttributeFallback ? `
      <div class="info-box warn" style="margin-bottom:14px"><span>⚠</span><span>Execução anterior ao congelamento de AttributeDefinitions (snapshot legado) — atributos exibidos aqui vêm do catálogo atual, não de um snapshot original.</span></div>` : ""}
      <div class="card" style="margin-bottom:18px">
        <div class="q-meta" style="margin-bottom:6px">
          ${populationRunStatusBadge(popRun.status)}
          <span class="mono small">${fmtDate(popRun.createdAt)}</span>
          <span class="faint">·</span>
          <span class="mono small">${fmtDuration(popRun.startedAt, popRun.completedAt)}</span>
        </div>
        <p class="mono">${completed}/${total} concluídas${failed ? ` · ${failed} falharam` : ""}</p>
        <p class="hint" style="margin-top:6px">Provider/model: <span class="mono">${esc(popRun.provider)} / ${esc(popRun.model)}</span> · Prompt version: <span class="mono">${esc(popRun.promptVersion)}</span></p>
        ${popRun.errorMessage ? `<p class="faint small" style="margin-top:6px">${esc(popRun.errorMessage)}</p>` : ""}
      </div>
      <div class="tabs" role="tablist">
        ${HUB_TABS.map(([key, label]) => `<button type="button" class="tab-btn ${activeTab === key ? "active" : ""}" data-tab="${key}">${label}</button>`).join("")}
      </div>
      <div class="tab-panel">${renderTabContent()}</div>`;

    $$("[data-tab]", main).forEach((b) => b.addEventListener("click", () => {
      activeTab = b.dataset.tab;
      renderAll();
    }));

    if (activeTab === "dados") {
      const bundle = () => JSON.stringify(populationRunBundle(popRun), null, 2);
      main.querySelector("#pr-copy-json")?.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(bundle()); toast("JSON copiado", "ok"); }
        catch { toast("Não foi possível copiar", "bad"); }
      });
      main.querySelector("#pr-download-json")?.addEventListener("click", () => download(`readerlab-population-run-${popRun.id}.json`, bundle()));
    }

    if (activeTab === "heatmap") {
      main.querySelector("#qstats-sort")?.addEventListener("change", (e) => {
        questionStatsSort = e.target.value;
        renderAll();
      });
      main.querySelector("#heatmap-sort-by")?.addEventListener("change", (e) => {
        heatmapSort.by = e.target.value;
        renderAll();
      });
      main.querySelector("#heatmap-sort-dir")?.addEventListener("click", () => {
        heatmapSort.dir = heatmapSort.dir === "asc" ? "desc" : "asc";
        renderAll();
      });
      $$("[data-heatmap-cell]", main).forEach((cell) => cell.addEventListener("click", () => {
        const box = main.querySelector("#heatmap-detail");
        if (!box) return;
        box.hidden = false;
        box.innerHTML = `
          <div class="heatmap-detail-persona">${esc(cell.dataset.persona)}</div>
          <div class="heatmap-detail-question">${esc(cell.dataset.question)}</div>
          <div class="heatmap-detail-value">${esc(cell.dataset.value)} / ${esc(cell.dataset.max)}</div>
          ${cell.dataset.run ? `<a class="btn btn-sm" style="margin-top:8px" href="${runReportLink(cell.dataset.run)}">Abrir leitura completa</a>` : ""}`;
      }));
    }

    if (activeTab === "reacoes") {
      main.querySelector("#reac-sort-by")?.addEventListener("change", (e) => {
        reactionsSort.by = e.target.value;
        renderAll();
      });
      main.querySelector("#reac-sort-dir")?.addEventListener("click", () => {
        reactionsSort.dir = reactionsSort.dir === "asc" ? "desc" : "asc";
        renderAll();
      });
      main.querySelector("#reac-show-zero")?.addEventListener("change", (e) => {
        reactionsShowZero = e.target.checked;
        renderAll();
      });
      $$("[data-toggle-reaction]", main).forEach((b) => b.addEventListener("click", () => {
        const code = b.dataset.toggleReaction;
        if (openReactionCodes.has(code)) openReactionCodes.delete(code);
        else openReactionCodes.add(code);
        renderAll();
      }));
    }

    if (activeTab === "segmentos") {
      $$('input[name="seg-mode"]', main).forEach((r) => r.addEventListener("change", (e) => {
        segmentCompareMode = e.target.value;
        renderAll();
      }));
      $$("[data-rule-field]", main).forEach((el) => el.addEventListener("change", (e) => {
        const { ruleField, ruleGroup, ruleIdx } = e.target.dataset;
        const list = ruleGroup === "A" ? segmentARules : segmentBRules;
        const rule = list[Number(ruleIdx)];
        if (!rule) return;
        rule[ruleField] = e.target.value;
        renderAll();
      }));
      $$("[data-rule-add]", main).forEach((b) => b.addEventListener("click", () => {
        const list = b.dataset.ruleAdd === "A" ? segmentARules : segmentBRules;
        list.push({ attributeId: "", op: "<", value: "" });
        renderAll();
      }));
      $$("[data-rule-remove]", main).forEach((b) => b.addEventListener("click", () => {
        const list = b.dataset.ruleRemove === "A" ? segmentARules : segmentBRules;
        list.splice(Number(b.dataset.ruleIdx), 1);
        renderAll();
      }));
      $$("[data-rule-clear]", main).forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.ruleClear === "A") segmentARules = []; else segmentBRules = [];
        renderAll();
      }));
      $$("[data-preset-apply]", main).forEach((b) => b.addEventListener("click", () => {
        const preset = availablePresets()[Number(b.dataset.presetApply)];
        if (preset) segmentARules = preset.rules.map((r) => ({ ...r }));
        renderAll();
      }));
      main.querySelector("[data-preset-save]")?.addEventListener("click", () => {
        const name = prompt("Nome do preset:");
        if (!name) return;
        customPresets.push({ name, rules: segmentARules.map((r) => ({ ...r })) });
        toast("Preset salvo nesta sessão (não persistido).", "ok");
        renderAll();
      });
    }

    if (activeTab === "analise") {
      main.querySelector("#analysis-generate")?.addEventListener("click", async () => {
        if (analysisRunning) return;
        analysisRunning = true;
        renderAll();
        const cfg = getLLMConfig();
        const mode = cfg.endpoint ? "llm" : "demo";
        const liveCfg = mode === "llm" ? cfg : null;
        const { ok, analysisRun } = await runPopulationAnalysis(popRun, { mode, liveCfg, segments: activeSegmentsForAnalysis() });
        analysisRunning = false;
        selectedAnalysisId = analysisRun.id;
        if (ok) toast("Análise gerada com sucesso.", "ok");
        else toast("Falha ao gerar análise: " + (analysisRun.errorMessage || "erro desconhecido"), "bad");
        renderAll();
      });
      $$("[data-analysis-open]", main).forEach((b) => b.addEventListener("click", () => {
        selectedAnalysisId = b.dataset.analysisOpen;
        renderAll();
      }));
      const list = S.getAnalysisRunsForPopulationRun(popRun.id);
      const selected = list.find((a) => a.id === selectedAnalysisId) || list[0] || null;
      if (selected) {
        main.querySelector("#analysis-copy-json")?.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(JSON.stringify(selected, null, 2)); toast("JSON copiado", "ok"); }
          catch { toast("Não foi possível copiar", "bad"); }
        });
        main.querySelector("#analysis-download-json")?.addEventListener("click", () =>
          download(`readerlab-analysis-${selected.id}.json`, JSON.stringify(selected, null, 2)));
      }
    }
  };

  renderAll();
}

// ================================================================== TAGS
function viewTags(main) {
  main.innerHTML = `
    ${pageHead("Tags", "Etiquetas livres para personas, pesquisas e futuros experimentos. Permitem construir subpopulações e segmentar análises.")}
    <form id="tag-form" class="toolbar" style="max-width:460px">
      <input type="text" id="tag-name" placeholder="Nova tag (ex.: sci-fi, crítico, plot-driven)" required>
      <button type="submit" class="btn btn-primary">Adicionar</button>
    </form>
    ${S.state.tags.length === 0
      ? `<div class="empty-state"><div class="big">Nenhuma tag criada</div><p>Tags também são criadas automaticamente ao editar personas.</p></div>`
      : `<div class="table-wrap" style="margin-top:16px"><table>
        <thead><tr><th>Tag</th><th>Uso em personas</th><th>Criada em</th><th></th></tr></thead>
        <tbody>${S.state.tags.map((t) => {
          const usage = S.tagUsage(t.name);
          return `<tr>
            <td><span class="tag">${esc(t.name)}</span></td>
            <td class="mono">${usage.personas}</td>
            <td class="muted small">${fmtDate(t.createdAt)}</td>
            <td><div class="row-actions">
              <button class="btn btn-sm btn-ghost btn-danger" data-del="${t.id}">Excluir</button>
            </div></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`}`;
  $("#tag-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#tag-name").value.trim();
    if (!name) return;
    await S.ensureTag(name);
    $("#tag-name").value = "";
    toast("Tag adicionada", "ok");
    renderRoute();
  });
  $$("[data-del]", main).forEach((b) => b.addEventListener("click", async () => {
    const t = S.state.tags.find((x) => x.id === b.dataset.del);
    if (confirm(`Excluir a tag "${t.name}"? Ela será removida das personas, mas nada mais será afetado.`)) {
      await S.deleteTag(t.id);
      toast("Tag excluída", "ok");
      renderRoute();
    }
  }));
}

// ================================================================= DADOS
function viewData(main) {
  main.innerHTML = `
    ${pageHead("Dados", "Importação e exportação das configurações. O JSON é pensado para futuramente alimentar diretamente o motor de agentes.")}
    <div class="cards" style="margin-bottom:16px">
      <div class="card">
        <div class="stat-label" style="margin-bottom:8px">Exportação completa (JSON)</div>
        <p class="muted small" style="margin-bottom:12px">Personas, atributos, reações, pesquisas, tags e populações em um único arquivo versionado.</p>
        <button class="btn btn-primary" id="ex-json">Exportar JSON</button>
      </div>
      <div class="card">
        <div class="stat-label" style="margin-bottom:8px">Importação (JSON)</div>
        <p class="muted small" style="margin-bottom:12px">Substitui todos os dados atuais pelo conteúdo do arquivo.</p>
        <input type="file" id="im-json" accept="application/json,.json">
      </div>
    </div>
    <div class="section-title">Exportação CSV</div>
    <div class="toolbar">
      <button class="btn" id="csv-personas">Personas (CSV)</button>
      <button class="btn" id="csv-atributos">Atributos (CSV)</button>
      <button class="btn" id="csv-reacoes">Reações (CSV)</button>
      <button class="btn" id="csv-pesquisas">Pesquisas (CSV)</button>
    </div>
    <div class="section-title">Zona de cuidado</div>
    <div class="info-box warn"><span>⚠</span><span>Restaurar os dados de exemplo apaga <b>tudo</b> e recria o estado inicial: atributos, reações, pesquisas padrão, as 100 personas de exemplo (R001–R100) e a população "Painel Geral — 100 Leitores".</span></div>
    <div style="margin-top:12px"><button class="btn btn-danger" id="reset-seeds">Restaurar dados de exemplo</button></div>`;

  const stamp = new Date().toISOString().slice(0, 10);
  $("#ex-json").addEventListener("click", () => {
    download(`readerlab-export-${stamp}.json`, JSON.stringify(S.exportAll(), null, 2));
    toast("Exportação JSON gerada", "ok");
  });
  $("#im-json").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const payload = JSON.parse(reader.result);
        if (!confirm("Importar substituirá TODOS os dados atuais. Continuar?")) return;
        await S.importAll(payload);
        toast("Dados importados com sucesso", "ok");
        renderApp();
      } catch (err) {
        toast("Falha na importação: " + err.message, "bad");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });
  $("#csv-personas").addEventListener("click", () => { download(`readerlab-personas-${stamp}.csv`, S.personasCSV(), "text/csv"); toast("CSV de personas gerado", "ok"); });
  $("#csv-atributos").addEventListener("click", () => { download(`readerlab-atributos-${stamp}.csv`, S.attributesCSV(), "text/csv"); toast("CSV de atributos gerado", "ok"); });
  $("#csv-reacoes").addEventListener("click", () => { download(`readerlab-reacoes-${stamp}.csv`, S.reactionsCSV(), "text/csv"); toast("CSV de reações gerado", "ok"); });
  $("#csv-pesquisas").addEventListener("click", () => { download(`readerlab-pesquisas-${stamp}.csv`, S.surveysCSV(), "text/csv"); toast("CSV de pesquisas gerado", "ok"); });
  $("#reset-seeds").addEventListener("click", async () => {
    if (!confirm("Apagar TODOS os dados e restaurar apenas os dados de exemplo?")) return;
    if (!confirm("Tem certeza? Esta ação não pode ser desfeita.")) return;
    await S.resetToSeeds();
    toast("Dados de exemplo restaurados", "ok");
    renderApp();
  });
}

// ============================================================== EXECUÇÕES
const personaLabel = (id, snapshotPersona) => {
  if (snapshotPersona) return `${snapshotPersona.code ? snapshotPersona.code + " — " : ""}${snapshotPersona.name}`;
  const p = S.state.personas.find((x) => x.id === id);
  return p ? `${p.code ? p.code + " — " : ""}${p.name}` : "(persona removida)";
};
const surveyLabel = (id, snapshotSurvey) => {
  if (snapshotSurvey) return snapshotSurvey.name;
  const s = S.state.surveys.find((x) => x.id === id);
  return s ? s.name : "(pesquisa removida)";
};
const runStatusBadge = (status) => {
  const cls = { COMPLETED: "ok", FAILED: "bad", RUNNING: "accent", PENDING: "neutral" }[status] || "neutral";
  return `<span class="badge ${cls}">${D.RUN_STATUS[status] || esc(status)}</span>`;
};

function viewRuns(main) {
  main.innerHTML = `
    ${pageHead("Execuções", "Leituras experimentais: uma Persona + um texto + uma Pesquisa + a taxonomia de reações + uma LLM = um resultado estruturado e persistido.",
      `<a class="btn btn-primary" href="#/execucoes/nova">+ Nova leitura experimental</a>`)}
    ${S.state.runs.length === 0
      ? `<div class="empty-state">
          <div class="big">Nenhuma execução registrada</div>
          <p>Crie uma nova leitura experimental para validar o núcleo do laboratório.</p>
          <div style="margin-top:14px"><a class="btn btn-primary" href="#/execucoes/nova">Nova leitura experimental</a></div>
        </div>`
      : `<div class="table-wrap"><table>
        <thead><tr><th>Data</th><th>Título</th><th>Persona</th><th>Pesquisa</th><th>Modelo</th><th>Status</th><th></th></tr></thead>
        <tbody>${S.state.runs.map((r) => `
          <tr>
            <td class="muted small" style="white-space:nowrap">${fmtDate(r.createdAt)}</td>
            <td><b>${esc(r.title || "(sem título)")}</b>${r.errorMessage && r.status === "FAILED" ? `<div class="faint small">${esc(r.errorMessage)}</div>` : ""}</td>
            <td class="muted">${esc(personaLabel(r.personaId, r.executionSnapshot?.persona))}</td>
            <td class="muted">${esc(surveyLabel(r.surveyId, r.executionSnapshot?.survey))}</td>
            <td class="mono small">${esc(r.model)}</td>
            <td>${runStatusBadge(r.status)}</td>
            <td><div class="row-actions"><a class="btn btn-sm" href="#/execucoes/${r.id}">Ver resultado</a></div></td>
          </tr>`).join("")}</tbody>
      </table></div>`}`;
}

function viewNewRun(main) {
  const cfg = getLLMConfig();
  const personas = S.state.personas.filter((p) => p.status === "ativa");
  const surveys = S.state.surveys.filter((s) => s.status === "ativa");
  if (!personas.length || !surveys.length) {
    main.innerHTML = `${pageHead("Nova leitura experimental")}
      <div class="info-box warn"><span>⚠</span><span>É necessário ao menos uma <b>persona ativa</b> e uma <b>pesquisa ativa</b> para executar uma leitura.</span></div>
      <div style="margin-top:14px"><a class="btn" href="#/execucoes">Voltar</a></div>`;
    return;
  }
  main.innerHTML = `
    ${pageHead("Nova leitura experimental", "Uma execução = Persona + texto + Pesquisa + taxonomia ativa de reações. Nada é enviado a nenhum modelo além do conteúdo desta tela.")}
    ${!cfg.endpoint ? `
    <div class="info-box warn" style="margin-bottom:16px">
      <span>⚠</span>
      <span><b>Backend LLM não configurado.</b> O ReaderLab está em hosting 100% estático e nenhuma API Key pode viver no browser. Conecte um proxy seguro (que segura a chave no servidor) para executar leituras reais; sem ele, a execução será registrada como <b>Falhou</b> com a causa — o restante do fluxo (prompt, validação, persistência) continua funcional.</span>
    </div>` : `
    <div class="info-box" style="margin-bottom:16px"><span>ⓘ</span><span>Backend LLM conectado: <span class="mono">${esc(cfg.endpoint)}</span>. A API Key não transita por este navegador.</span></div>`}
    <form id="run-form" novalidate>
      <div class="field" style="max-width:520px">
        <label>Título da execução <span class="hint">(opcional)</span></label>
        <input type="text" id="rn-title" placeholder="Capítulo 1 — teste R010">
      </div>

      <div class="section-title">Texto</div>
      <div class="field">
        <label>Cole o texto ou envie um arquivo (.txt / .md)</label>
        <textarea id="rn-text" class="tall" placeholder="Cole aqui o capítulo, seção ou trecho a ser lido pela persona…"></textarea>
        <div class="toolbar" style="margin:6px 0 0">
          <input type="file" id="rn-file" accept=".txt,.md">
          <span class="hint" id="rn-count">0 caracteres</span>
        </div>
      </div>

      <div class="form-grid">
        <div class="field">
          <label>Persona <span class="req">*</span></label>
          <select id="rn-persona">
            <option value="">Selecione…</option>
            ${personas.map((p) => `<option value="${p.id}">${esc(p.code ? p.code + " — " : "")}${esc(p.name)}</option>`).join("")}
          </select>
          <div id="rn-persona-preview" class="hint" style="padding:6px 2px 0"></div>
        </div>
        <div class="field">
          <label>Pesquisa <span class="req">*</span></label>
          <select id="rn-survey">
            <option value="">Selecione…</option>
            ${surveys.map((s) => `<option value="${s.id}">${esc(s.name)} (${D.SURVEY_KINDS[s.kind]})</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="field">
        <label class="checkbox-row" style="padding-left:0">
          <input type="checkbox" id="rn-reactions" checked disabled>
          Usar taxonomia ativa de reações (apenas ReactionDefinitions com status ativo serão enviadas ao agente)
        </label>
      </div>

      <div class="field">
        <label>Modo de execução</label>
        <label class="checkbox-row" style="padding-left:0">
          <input type="radio" name="rn-mode" value="demo" checked> Demo local (simulador — sem rede, resultados determinísticos)
        </label>
        <label class="checkbox-row" style="padding-left:0">
          <input type="radio" name="rn-mode" value="llm" ${cfg.endpoint ? "" : "disabled"}>
          LLM real via proxy ${cfg.endpoint ? "" : "(indisponível — nenhum backend configurado)"}
        </label>
        <label class="checkbox-row faint" style="padding-left:0"><input type="radio" name="rn-mode" disabled> População — em breve</label>
      </div>

      <details class="card" style="margin-bottom:8px">
        <summary style="cursor:pointer;font-weight:650">Configurações avançadas</summary>
        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label>Provider</label><input type="text" value="${esc(cfg.provider)}" disabled></div>
          <div class="field"><label>Model</label><input type="text" value="${esc(cfg.model)}" disabled></div>
          <div class="field"><label>Prompt version</label><input type="text" value="${esc(cfg.promptVersion)}" disabled></div>
          <div class="field"><label>Temperature</label><input type="text" value="${esc(String(cfg.temperature))}" disabled></div>
        </div>
        <p class="hint">Provider/model reais são decididos pelo servidor (Edge Function) — o navegador não escolhe modelo/URL. O campo "Model" aqui é só um rótulo; o modelo efetivamente usado aparece no resultado após a execução.</p>
      </details>

      <div class="save-bar">
        <a class="btn" href="#/execucoes">Cancelar</a>
        <button type="submit" class="btn btn-primary" id="rn-execute">Executar leitura</button>
      </div>
    </form>`;

  const textEl = $("#rn-text");
  textEl.addEventListener("input", () => { $("#rn-count").textContent = `${textEl.value.length} caracteres`; });
  $("#rn-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) { toast("Formato não suportado nesta fase. Use .txt ou .md.", "bad"); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      textEl.value = String(reader.result || "");
      textEl.dispatchEvent(new Event("input", { bubbles: true }));
      toast(`Arquivo "${file.name}" carregado — revise o conteúdo antes de executar.`, "ok");
    };
    reader.readAsText(file);
  });
  $("#rn-persona").addEventListener("change", (e) => {
    const p = personas.find((x) => x.id === e.target.value);
    $("#rn-persona-preview").innerHTML = p
      ? `<span class="tags">${(p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</span> ${esc(p.shortDescription || "")}`
      : "";
  });

  let executing = false;
  const runForm = $("#run-form");
  runForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (executing) return;
    const persona = personas.find((x) => x.id === $("#rn-persona").value);
    const survey = surveys.find((x) => x.id === $("#rn-survey").value);
    const text = textEl.value.trim();
    if (!persona) { toast("Selecione uma persona.", "bad"); return; }
    if (!survey) { toast("Selecione uma pesquisa.", "bad"); return; }
    if (text.length < 10) { toast("Forneça um texto para leitura (mínimo de algumas linhas).", "bad"); textEl.focus(); return; }

    executing = true;
    const btn = $("#rn-execute");
    btn.disabled = true;
    btn.textContent = "Executando…";

    const run = D.blankRun();
    run.title = $("#rn-title").value.trim();
    run.personaId = persona.id;
    run.surveyId = survey.id;
    run.inputText = text;
    const liveCfg = getLLMConfig(); // lê de novo: window.READERLAB_LLM_ENDPOINT pode ter sido definido após o render
    const mode = runForm.querySelector('input[name="rn-mode"]:checked')?.value || "demo";
    const isDemo = mode === "demo";
    run.provider = isDemo ? "demo-local" : liveCfg.provider;
    run.model = isDemo ? "simulador-v1" : ""; // preenchido com o modelo real após a resposta do servidor
    run.promptVersion = liveCfg.promptVersion;
    await S.saveRun(run);

    const { ok } = await executeReadingRun(run, { persona, survey, mode, liveCfg });
    if (ok) toast("Leitura concluída e resultado persistido.", "ok");
    else toast(run.errorMessage, "bad");
    location.hash = "#/execucoes/" + run.id;
  });
}

function viewRunDetail(main, id, query = {}) {
  const run = S.state.runs.find((r) => r.id === id);
  if (!run) { location.hash = "#/execucoes"; return; }
  const result = S.getResultForRun(run.id);
  renderRunResultView(main, run, result, { toast, backContext: buildRunBackContext(run, query) });
}

// Se a leitura veio do hub de uma PopulationRun (via link com ?from=...),
// preserva o caminho (e a aba) de volta em vez de só "Voltar às execuções".
// Também funciona sem query (ex.: reload direto no link), usando
// run.populationRunId como fallback.
function buildRunBackContext(run, query) {
  const from = query?.from || (run.populationRunId ? `population-runs/${run.populationRunId}` : null);
  if (!from || !from.startsWith("population-runs/")) return null;
  const popRun = S.state.populationRuns.find((p) => p.id === from.slice("population-runs/".length));
  if (!popRun) return null;
  const population = S.state.populations.find((p) => p.id === popRun.populationId);
  const persona = popRun.executionSnapshot?.personas?.find((p) => p.id === run.personaId)
    || S.state.personas.find((p) => p.id === run.personaId);
  const tab = query?.tab;
  return {
    href: `#/population-runs/${popRun.id}${tab ? "?tab=" + encodeURIComponent(tab) : ""}`,
    label: "Voltar para resultados da população",
    breadcrumb: [
      population?.name || "Population",
      popRun.title || "Execução de população",
      persona ? `${persona.code ? persona.code + " — " : ""}${persona.name}` : null,
    ].filter(Boolean),
  };
}
