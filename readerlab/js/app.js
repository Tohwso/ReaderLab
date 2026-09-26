// ============ ReaderLab — Bootstrap ============
import * as db from "./db.js";
import * as S from "./store.js";
import * as UI from "./ui.js";
import { initTheme } from "./theme.js";

let appStarted = false;
initTheme();

function renderFatal(err) {
  console.error(err);
  document.getElementById("app").innerHTML = `
    <div class="boot">
      <div class="boot-mark"></div>
      <p>Não foi possível iniciar o ReaderLab.</p>
      <p class="mono" style="font-size:12px">${String(err && err.message || err)}</p>
      <p style="font-size:12px">Verifique a configuração do Supabase em js/config.js (veja supabase/README.md) e recarregue.</p>
      <button type="button" class="btn" id="fatal-logout">Sair e tentar novamente</button>
    </div>`;
  // Sem isso, um erro pós-login (ex.: sessão antiga/de outra conta) deixaria
  // o usuário preso nesta tela, sem forma de deslogar pela UI.
  document.getElementById("fatal-logout").addEventListener("click", () => db.signOut());
}

async function startApp() {
  await S.seedIfEmpty();
  await S.loadAll();
  await S.ensureSeedPersonas();
  await S.ensureSeedPopulation();
  await S.ensureSeedFocusedPopulations();
  UI.renderApp();
}

async function handleLogin(email, password) {
  const { error } = await db.signInWithPassword(email, password);
  if (error) return error.message === "Invalid login credentials"
    ? "E-mail ou senha inválidos."
    : error.message;
  // Sucesso: o próprio listener onAuthChange (abaixo) dispara startApp().
  return null;
}

// Única fonte de verdade para a alternância Login ↔ App: reage tanto ao
// boot inicial (sessão restaurada ou não) quanto a login/logout/expiração
// de sessão em qualquer ponto da vida do app.
async function handleAuthChange(session) {
  if (session && !appStarted) {
    appStarted = true;
    try {
      await startApp();
    } catch (err) {
      appStarted = false;
      renderFatal(err);
    }
  } else if (!session) {
    if (appStarted) {
      appStarted = false;
      S.resetState();
    }
    UI.renderLogin({ onSubmit: handleLogin });
  }
}

async function boot() {
  try {
    await db.openDB();
  } catch (err) {
    renderFatal(err);
    return;
  }
  db.onAuthChange(handleAuthChange);
}

boot();

