// ============ ReaderLab — Camada de Persistência (Supabase) ============
// Backend real: Postgres via Supabase (REST/PostgREST por baixo do
// supabase-js). Mantém a MESMA interface pública que existia sobre
// IndexedDB (getAll/getOne/put/remove/clear/bulkPut/metaGet/metaSet) — este
// é o único arquivo que fala com o backend; domínio e UI não mudam.
//
// Schema esperado (ver /supabase/schema.sql): uma tabela por "store", cada
// uma com colunas (id text primary key, owner_id uuid, data jsonb,
// created_at, updated_at). O objeto de domínio inteiro é guardado em
// `data`; `id` é extraído para a chave primária.
//
// Autenticação: e-mail + senha (sem cadastro público — contas são criadas
// manualmente no Supabase Dashboard). Não há mais sessão anônima nem
// workspace compartilhado: cada linha pertence a um `owner_id` (auth.uid())
// e RLS garante que cada usuário só acessa as próprias linhas. `owner_id`
// nunca vem do frontend — é sempre resolvido aqui a partir da sessão atual.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const STORES = ["personas", "attributes", "reactions", "surveys", "tags", "populations", "runs", "results"];

// "connecting" | "supabase" | "offline" — usado pela UI para avisos de estado
// de CONEXÃO (não de autenticação — ver isAuthenticated()/onAuthChange()).
export let persistenceMode = "connecting";

let client = null;
let session = null;
let authInitialized = false;
const authListeners = [];

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
// proxy de LLM (a Edge Function exige um JWT válido do usuário logado).
export function getAccessToken() {
  return (session && session.access_token) || null;
}
export function getAnonKey() {
  return resolveConfig().anonKey || null;
}

export function getSession() {
  return session;
}
export function isAuthenticated() {
  return !!session;
}

function requireUserId() {
  if (!session || !session.user) throw new Error("Nenhuma sessão autenticada — faça login novamente.");
  return session.user.id;
}

// Assina mudanças de autenticação (login, logout, expiração de sessão).
// Chama o callback imediatamente com o estado atual assim que openDB()
// tiver resolvido (evita corrida entre app.js e o primeiro evento real).
export function onAuthChange(callback) {
  authListeners.push(callback);
  if (authInitialized) callback(session);
  return () => {
    const i = authListeners.indexOf(callback);
    if (i >= 0) authListeners.splice(i, 1);
  };
}

function notifyAuthChange() {
  for (const cb of authListeners) cb(session);
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

  // Restaura sessão persistida (login anterior), se houver — sem criar
  // nenhuma sessão nova automaticamente (nada de signInAnonymously()).
  const { data: existing } = await client.auth.getSession();
  session = existing.session;
  authInitialized = true;
  persistenceMode = "supabase";

  // Cobre login, logout e expiração/perda de sessão (ex.: refresh token
  // inválido) — ui.js/app.js decidem o que fazer via onAuthChange().
  client.auth.onAuthStateChange((_event, s) => {
    session = s;
    notifyAuthChange();
  });

  return client;
}

export async function signInWithPassword(email, password) {
  if (!client) throw new Error("Banco de dados não inicializado — chame openDB() antes.");
  const { error } = await client.auth.signInWithPassword({ email, password });
  // Não atualiza `session` manualmente: o listener onAuthStateChange acima
  // já recebe o evento SIGNED_IN e notifica os assinantes.
  return { error };
}

export async function signOut() {
  if (!client) return;
  await client.auth.signOut();
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
  const owner_id = requireUserId();
  const { error } = await table(store).upsert({ id: obj.id, owner_id, data: obj }, { onConflict: "id" });
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
  const owner_id = requireUserId();
  const rows = objs.map((o) => ({ id: o.id, owner_id, data: o }));
  const { error } = await table(store).upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

// `meta` usa chave composta (owner_id, key): a mesma `key` (ex.: "seeded")
// pode existir uma vez por usuário sem colidir com a de outro.
export async function metaSet(key, value) {
  const owner_id = requireUserId();
  const { error } = await client.from("meta").upsert({ owner_id, key, value }, { onConflict: "owner_id,key" });
  if (error) throw error;
}

export async function metaGet(key) {
  const owner_id = requireUserId();
  const { data, error } = await client.from("meta").select("value").eq("key", key).eq("owner_id", owner_id).maybeSingle();
  if (error) throw error;
  return data ? data.value : undefined;
}
