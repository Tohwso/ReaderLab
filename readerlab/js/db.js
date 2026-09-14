// ============ ReaderLab — Camada de Persistência (Supabase) ============
// Backend real: Postgres via Supabase (REST/PostgREST por baixo do
// supabase-js). Mantém a MESMA interface pública que existia sobre
// IndexedDB (getAll/getOne/put/remove/clear/bulkPut/metaGet/metaSet) — este
// é o único arquivo que fala com o backend; domínio e UI não mudam.
//
// Schema esperado (ver /supabase/schema.sql): uma tabela por "store", cada
// uma com colunas (id text primary key, data jsonb, created_at, updated_at).
// O objeto de domínio inteiro é guardado em `data`; `id` é extraído para a
// chave primária. RLS exige apenas uma sessão autenticada (inclusive
// anônima) — não há tela de login nesta fase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const STORES = ["personas", "attributes", "reactions", "surveys", "tags", "populations", "runs", "results"];

// "connecting" | "supabase" | "offline" — usado pela UI para avisos de estado.
export let persistenceMode = "connecting";

let client = null;
let session = null;

function resolveConfig() {
  let url = SUPABASE_URL;
  let anonKey = SUPABASE_ANON_KEY;
  try {
    if (typeof window !== "undefined") {
      if (window.READERLAB_SUPABASE_URL) url = window.READERLAB_SUPABASE_URL;
      if (window.READERLAB_SUPABASE_ANON_KEY) anonKey = window.READERLAB_SUPABASE_ANON_KEY;
    }
  } catch (_) { /* ambiente sem window */ }
  return { url, anonKey };
}

// Exportado para js/llm/provider.js: anexa a mesma sessão à chamada do
// proxy de LLM (a Edge Function exige um JWT válido — anon ou de usuário).
export function getAccessToken() {
  return (session && session.access_token) || null;
}
export function getAnonKey() {
  return resolveConfig().anonKey || null;
}

export async function openDB() {
  const { url, anonKey } = resolveConfig();
  if (!url || !anonKey) {
    persistenceMode = "offline";
    throw new Error(
      "Supabase não configurado. Preencha SUPABASE_URL/SUPABASE_ANON_KEY em js/config.js " +
      "(ou defina window.READERLAB_SUPABASE_URL / window.READERLAB_SUPABASE_ANON_KEY antes de js/app.js). " +
      "Veja supabase/README.md para criar o projeto e aplicar o schema."
    );
  }

  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const { data: existing } = await client.auth.getSession();
  session = existing.session;
  if (!session) {
    const { data, error } = await client.auth.signInAnonymously();
    if (error) {
      persistenceMode = "offline";
      throw new Error(
        "Falha ao autenticar (anônimo) no Supabase: " + error.message +
        ". Verifique se \"Allow anonymous sign-ins\" está habilitado no projeto."
      );
    }
    session = data.session;
  }
  client.auth.onAuthStateChange((_event, s) => { session = s; });

  persistenceMode = "supabase";
  return client;
}

function table(store) {
  if (!client) throw new Error("Banco de dados não inicializado — chame openDB() antes.");
  return client.from(store);
}

const rowToObject = (row) => ({ ...row.data, id: row.id });

export async function getAll(store) {
  const { data, error } = await table(store).select("id, data");
  if (error) throw error;
  return data.map(rowToObject);
}

export async function getOne(store, id) {
  const { data, error } = await table(store).select("id, data").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToObject(data) : undefined;
}

export async function put(store, obj) {
  const { error } = await table(store).upsert({ id: obj.id, data: obj }, { onConflict: "id" });
  if (error) throw error;
  return obj.id;
}

export async function remove(store, id) {
  const { error } = await table(store).delete().eq("id", id);
  if (error) throw error;
}

export async function clear(store) {
  const { error } = await table(store).delete().not("id", "is", null);
  if (error) throw error;
}

export async function bulkPut(store, objs) {
  if (!objs || !objs.length) return;
  const rows = objs.map((o) => ({ id: o.id, data: o }));
  const { error } = await table(store).upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

export async function metaSet(key, value) {
  const { error } = await client.from("meta").upsert({ key, value }, { onConflict: "key" });
  if (error) throw error;
}

export async function metaGet(key) {
  const { data, error } = await client.from("meta").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data ? data.value : undefined;
}
