// ============ ReaderLab — Bootstrap ============
import * as db from "./db.js";
import * as S from "./store.js";
import * as UI from "./ui.js";

async function boot() {
  try {
    await db.openDB();
    await S.seedIfEmpty();
    await S.loadAll();
    await S.ensureSeedPersonas();
    UI.renderApp();
  } catch (err) {
    console.error(err);
    document.getElementById("app").innerHTML = `
      <div class="boot">
        <div class="boot-mark"></div>
        <p>Não foi possível iniciar o ReaderLab.</p>
        <p class="mono" style="font-size:12px">${String(err && err.message || err)}</p>
        <p style="font-size:12px">Verifique a configuração do Supabase em js/config.js (veja supabase/README.md) e recarregue.</p>
      </div>`;
  }
}

boot();
