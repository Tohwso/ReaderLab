-- ============ ReaderLab — Schema Supabase (Postgres) ============
-- Este schema é o backend real por trás de js/db.js. Uma tabela por
-- "store" do frontend, cada uma guardando o objeto de domínio inteiro em
-- `data` (jsonb) — mesma forma que já existia em IndexedDB/localStorage.
-- Colunas geradas (STORED) expõem campos-chave para indexação/consulta,
-- sem impor FKs rígidas: o app original permite referências "soltas" (ex.:
-- apagar uma persona não apaga suas execuções antigas), então preservamos
-- esse comportamento aqui.
--
-- Como aplicar: Supabase Dashboard → SQL Editor → cole este arquivo → Run.
-- (ou `supabase db push` / `psql` apontando para o projeto).

-- ------------------------------------------------------------- utilidades
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- --------------------------------------------------------------- personas
create table if not exists personas (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  code text generated always as (data->>'code') stored,
  name text generated always as (data->>'name') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists personas_status_idx on personas (status);
create index if not exists personas_code_idx on personas (code);

-- -------------------------------------------------------------- attributes
create table if not exists attributes (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  slug text generated always as (data->>'slug') stored,
  "group" text generated always as (data->>'group') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists attributes_group_idx on attributes ("group");

-- --------------------------------------------------------------- reactions
create table if not exists reactions (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  code text generated always as (data->>'code') stored,
  polarity text generated always as (data->>'polarity') stored,
  status text generated always as (data->>'status') stored,
  "order" int generated always as (coalesce((data->>'order')::int, 0)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reactions_order_idx on reactions ("order");

-- ----------------------------------------------------------------- surveys
create table if not exists surveys (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  kind text generated always as (data->>'kind') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------------- tags
create table if not exists tags (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  name text generated always as (data->>'name') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tags_name_idx on tags (name);

-- ------------------------------------------------------------- populations
create table if not exists populations (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  name text generated always as (data->>'name') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- runs
create table if not exists runs (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  persona_id text generated always as (data->>'personaId') stored,
  survey_id text generated always as (data->>'surveyId') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists runs_persona_idx on runs (persona_id);
create index if not exists runs_survey_idx on runs (survey_id);
create index if not exists runs_status_idx on runs (status);

-- --------------------------------------------------------------- results
create table if not exists results (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  reading_run_id text generated always as (data->>'readingRunId') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists results_run_idx on results (reading_run_id);

-- ------------------------------------------------------------------- meta
-- key/value simples (flags de seed, preferências de app).
create table if not exists meta (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------- trigger updated_at
do $$
declare t text;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results','meta'])
  loop
    execute format('drop trigger if exists trg_%1$s_updated_at on %1$s;', t);
    execute format('create trigger trg_%1$s_updated_at before update on %1$s for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- ================================================================== RLS
-- Sem tela de login nesta fase: qualquer sessão autenticada (inclusive
-- anônima, via supabase.auth.signInAnonymously()) tem acesso de
-- leitura/escrita a um workspace compartilhado. Não habilite acesso ao
-- papel `anon` sem sessão — apenas `authenticated`.
do $$
declare t text;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results','meta'])
  loop
    execute format('alter table %1$s enable row level security;', t);
    execute format('drop policy if exists %1$s_rw on %1$s;', t);
    execute format(
      'create policy %1$s_rw on %1$s for all to authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- Lembrete: habilite "Allow anonymous sign-ins" em
-- Authentication → Settings no Dashboard do Supabase para que
-- supabase.auth.signInAnonymously() funcione (usado por js/db.js).
