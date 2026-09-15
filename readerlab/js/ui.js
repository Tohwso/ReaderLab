// ============ ReaderLab — Interface (views e componentes) ============
import * as S from "./store.js";
import * as D from "./domain.js";
import { persistenceMode, signOut } from "./db.js";
import { getLLMConfig, getProvider, ProviderError, providerErrorMessage } from "./llm/provider.js";
import { buildReadingPrompt } from "./llm/promptBuilder.js";
import { validateLLMResponse } from "./llm/validate.js";
import { DemoProvider } from "./llm/demoProvider.js";
import { renderRunResultView } from "./components/runResultView.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
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

export function renderRoute() {
  const hash = location.hash || "#/dashboard";
  $$("#nav .nav-item").forEach((a) => a.classList.toggle("active", a.dataset.nav === hash || (a.dataset.nav !== "#/dashboard" && hash.startsWith(a.dataset.nav))));
  const parts = hash.replace(/^#\//, "").split("/");
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
      return param ? viewRunDetail(main, param) : viewRuns(main);
    case "populacoes": return viewPopulations(main);
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
      : `<div class="cards">${S.state.populations.map((pop) => `
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
            <button class="btn btn-sm" data-members="${pop.id}">Editar membros</button>
            <button class="btn btn-sm btn-ghost" data-rename="${pop.id}">Renomear</button>
            <button class="btn btn-sm btn-ghost btn-danger" data-del="${pop.id}">Excluir</button>
          </div>
        </div>`).join("")}</div>`}`;
  $("#po-new").addEventListener("click", () => populationModal());
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
    <div class="info-box warn"><span>⚠</span><span>Restaurar os dados de exemplo apaga <b>tudo</b> e recria o estado inicial: atributos, reações, pesquisas padrão e as 10 personas de exemplo (R001–R010).</span></div>
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
const fmtDuration = (a, b) => {
  if (!a || !b) return "—";
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`;
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

    run.status = "RUNNING";
    run.startedAt = D.nowISO();
    await S.saveRun(run);

    try {
      const activeReactions = S.state.reactions.filter((r) => r.status === "ativa");
      const { system, user } = buildReadingPrompt({
        persona, attributes: S.state.attributes, reactions: activeReactions, survey, text,
      });
      // Snapshot criado ANTES de chamar a LLM: congela persona/atributos/survey/reações
      // usados nesta execução, imunes a edições futuras dessas entidades.
      run.executionSnapshot = D.buildExecutionSnapshot({
        persona, attributes: S.state.attributes, survey, reactions: activeReactions,
        provider: run.provider, model: run.model, promptVersion: run.promptVersion,
      });
      run.requestMetadata = {
        promptChars: system.length + user.length,
        reactionCount: activeReactions.length,
        questionCount: survey.questions.length,
        snapshotVersion: 1,
      };
      const provider = isDemo
        ? new DemoProvider({ persona, attributes: S.state.attributes, reactions: activeReactions, survey })
        : getProvider(liveCfg);
      const { content, model } = await provider.complete({ systemPrompt: system, userPrompt: user });
      run.rawResponse = content;
      if (!isDemo && model) {
        run.model = model;
        run.executionSnapshot.llmConfig.model = model;
      }

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (_) {
        throw new ProviderError("INVALID_JSON", "O modelo retornou um JSON inválido.");
      }
      const validation = validateLLMResponse(parsed, { reactions: activeReactions, survey });
      if (!validation.ok) {
        throw new ProviderError("INVALID_SCHEMA", "Resposta fora do schema: " + validation.errors.join(" | "));
      }

      run.status = "COMPLETED";
      run.completedAt = D.nowISO();
      await S.saveRun(run);
      await S.saveResult({ ...D.blankResult(run.id), ...validation.value });
      toast("Leitura concluída e resultado persistido.", "ok");
      location.hash = "#/execucoes/" + run.id;
    } catch (err) {
      run.status = "FAILED";
      run.completedAt = D.nowISO();
      run.errorMessage = providerErrorMessage(err);
      await S.saveRun(run);
      toast(run.errorMessage, "bad");
      location.hash = "#/execucoes/" + run.id;
    }
  });
}

function viewRunDetail(main, id) {
  const run = S.state.runs.find((r) => r.id === id);
  if (!run) { location.hash = "#/execucoes"; return; }
  const result = S.getResultForRun(run.id);
  renderRunResultView(main, run, result, { toast });
}
