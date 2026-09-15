# ReaderLab

Laboratório de leitores sintéticos. Frontend estático (sem build) +
backend Supabase (Postgres + Auth + Edge Functions).

## Estrutura

```
readerlab/          frontend estático — publique este diretório
  index.html
  styles.css
  js/
    app.js           bootstrap
    db.js            ÚNICO seam de backend (Supabase: getAll/put/remove/...)
    domain.js        entidades e seeds
    store.js         estado + ações CRUD
    ui.js            todas as telas
    config.js        SUPABASE_URL / SUPABASE_ANON_KEY / LLM_PROXY_ENDPOINT
    llm/
      provider.js    fala apenas com o proxy (Edge Function) — zero API key
      promptBuilder.js
      validate.js
      demoProvider.js
supabase/            backend — ver supabase/README.md
  schema.sql         tabelas + RLS (instalação nova)
  migrations/        migrations incrementais (ex.: 0001_owner_id_and_auth.sql)
  functions/
    llm-proxy/       Edge Function: segura a API key da LLM no servidor
```

## Setup rápido

1. Configure o backend: siga [`supabase/README.md`](./supabase/README.md)
   (criar projeto, aplicar `schema.sql`, criar seu usuário, deploy da Edge
   Function `llm-proxy`).
2. Preencha `readerlab/js/config.js` com a URL/anon key do projeto e a URL
   da função.
3. Sirva `readerlab/` com qualquer servidor estático.

## Deploy no GitHub Pages

Configure o Pages do repositório para publicar o diretório `readerlab/`
(Settings → Pages → Build and deployment → Deploy from a branch → escolha
a branch e a pasta `/readerlab`, ou use uma GitHub Action que copie apenas
esse diretório para `gh-pages`). Não publique `supabase/` — é código de
backend (schema SQL e Edge Function), não faz parte do site estático.

## Autenticação

ReaderLab é uma aplicação privada e autenticada: não há cadastro público.
Contas são criadas manualmente no Supabase Dashboard (Authentication →
Users) e o login é feito por e-mail + senha na tela inicial do app. Sem
uma sessão válida, nenhuma tela do ReaderLab é acessível — apenas o login.
Cada conta só enxerga os próprios dados (personas, execuções, resultados
etc.), garantido por Row Level Security no Postgres. Veja
[`supabase/README.md`](./supabase/README.md) para criar seu usuário e,
se estiver migrando um projeto já em uso, aplicar a migration não
destrutiva em `supabase/migrations/`.
