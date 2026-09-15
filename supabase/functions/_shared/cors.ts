// ============ ReaderLab — CORS compartilhado entre Edge Functions ============
// Sem wildcard: só origens explicitamente listadas em
// READERLAB_ALLOWED_ORIGINS (secret/env, lista separada por vírgula) podem
// receber os headers de CORS. Requisições sem header Origin (chamadas
// server-to-server, curl, etc.) não passam por checagem de CORS — a
// segurança real delas é feita por JWT + owner check no handler.
export function resolveAllowedOrigins(): string[] {
  const raw = Deno.env.get("READERLAB_ALLOWED_ORIGINS") || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  return !origin || allowedOrigins.includes(origin);
}

export function corsHeadersFor(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function handlePreflight(req: Request, allowedOrigins: string[]): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("origin");
  if (!isOriginAllowed(origin, allowedOrigins)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeadersFor(origin, allowedOrigins) });
}

