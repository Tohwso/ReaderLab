-- ============ ReaderLab — Migration: workspace privado por usuário ============
-- Converte um projeto ReaderLab EXISTENTE (schema antigo: workspace
-- anônimo compartilhado, sem owner_id) para o novo modelo de dados
-- privado por usuário, SEM apagar nenhum dado. Depois desta migration:
--   - todas as linhas hoje existentes passam a pertencer ao usuário/UUID
--     que você indicar no passo 0;
--   - toda leitura/escrita passa a exigir owner_id = auth.uid() (RLS);
--   - a tabela `meta` passa a ter chave composta (owner_id, key).
--
-- Rode isto UMA VEZ, direto no SQL Editor do Supabase Dashboard (cole o
-- arquivo inteiro e clique em Run) — é uma migration em duas fases:
-- adiciona owner_id anulável, faz o backfill e só então aplica NOT NULL +
-- as policies restritivas.
--
-- Pré-requisito: crie seu usuário ANTES de rodar isto, em
-- Authentication → Users → Add user (e-mail + senha, "Auto Confirm User"
-- marcado). Copie o "User UID" gerado e cole no passo 0 abaixo.

-- ---------------------------------------------------------------------
-- PASSO 0 — OBRIGATÓRIO: troque o UUID abaixo pelo UUID real do usuário
-- que você criou em Authentication → Users (coluna "User UID"). Todas as
-- linhas existentes (personas, execuções, etc.) serão atribuídas a ele.
-- ---------------------------------------------------------------------
select set_config('readerlab.migration_owner', '1df6f8dc-4ae3-4f7b-8ebc-780aa1ac7e21', false);

-- Guarda de segurança: falha alto e claro em vez de silenciosamente
-- atribuir os dados a um UUID inválido/inexistente.
do $$
begin
  if current_setting('readerlab.migration_owner', true) is null
     or current_setting('readerlab.migration_owner') = 'COLOQUE-AQUI-O-UUID-DO-USUARIO'
     or current_setting('readerlab.migration_owner') = '' then
    raise exception 'Edite este arquivo: troque COLOQUE-AQUI-O-UUID-DO-USUARIO pelo UUID real do usuário (Authentication → Users) antes de rodar esta migration.';
  end if;

  perform 1 from auth.users where id = current_setting('readerlab.migration_owner')::uuid;
  if not found then
    raise exception 'UUID % não existe em auth.users — crie o usuário em Authentication → Users antes de rodar esta migration.', current_setting('readerlab.migration_owner');
  end if;
end $$;

-- ---------------------------------------------------- 1) adiciona coluna
do $$
declare t text;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results'])
  loop
    execute format('alter table %1$s add column if not exists owner_id uuid;', t);
  end loop;
end $$;
alter table meta add column if not exists owner_id uuid;

-- --------------------------------------------------------- 2) backfill
-- Atribui todas as linhas existentes (de todas as tabelas) ao usuário
-- indicado no passo 0. Não apaga nem sobrescreve `data` — só preenche
-- owner_id onde ainda está nulo.
do $$
declare
  t text;
  v_owner uuid := current_setting('readerlab.migration_owner')::uuid;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results','meta'])
  loop
    execute format('update %1$s set owner_id = $1 where owner_id is null;', t) using v_owner;
  end loop;
end $$;

-- ------------------------------------------------- 3) meta: chave composta
-- `key` sozinha não pode mais ser única globalmente (dois usuários podem
-- ter a mesma key, ex.: "seeded"). Move a PK para (owner_id, key).
alter table meta drop constraint if exists meta_pkey;
alter table meta add constraint meta_pkey primary key (owner_id, key);

-- ------------------------------------------ 4) NOT NULL + FK + índices
do $$
declare t text;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results','meta'])
  loop
    execute format('alter table %1$s alter column owner_id set not null;', t);
    execute format('alter table %1$s drop constraint if exists %1$s_owner_id_fkey;', t);
    execute format('alter table %1$s add constraint %1$s_owner_id_fkey foreign key (owner_id) references auth.users(id) on delete cascade;', t);
    execute format('create index if not exists %1$s_owner_idx on %1$s (owner_id);', t);
  end loop;
end $$;

-- --------------------------------------------------- 5) RLS restritiva
-- Substitui a policy antiga (permissiva, "using (true)") por policies por
-- operação exigindo owner_id = auth.uid().
do $$
declare t text;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results','meta'])
  loop
    execute format('alter table %1$s enable row level security;', t);
    execute format('drop policy if exists %1$s_rw on %1$s;', t);
    execute format('drop policy if exists %1$s_select on %1$s;', t);
    execute format('drop policy if exists %1$s_insert on %1$s;', t);
    execute format('drop policy if exists %1$s_update on %1$s;', t);
    execute format('drop policy if exists %1$s_delete on %1$s;', t);
    execute format('create policy %1$s_select on %1$s for select to authenticated using (owner_id = auth.uid());', t);
    execute format('create policy %1$s_insert on %1$s for insert to authenticated with check (owner_id = auth.uid());', t);
    execute format('create policy %1$s_update on %1$s for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());', t);
    execute format('create policy %1$s_delete on %1$s for delete to authenticated using (owner_id = auth.uid());', t);
  end loop;
end $$;

-- limpeza: nada sensível ficou aqui, mas não custa desfazer o setting.
select set_config('readerlab.migration_owner', '', false);

-- ---------------------------------------------------------------------
-- DEPOIS DE RODAR: em Authentication → Settings, desabilite "Allow
-- anonymous sign-ins" (não é mais usado — js/db.js não chama mais
-- signInAnonymously()).
-- ---------------------------------------------------------------------
