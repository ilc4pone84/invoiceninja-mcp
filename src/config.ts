// Konfiguration aus Umgebungsvariablen. Fehlt etwas Pflichtiges, startet der Server nicht.

export type AuthMode = "cloudflare_access" | "none";

export interface Config {
  port: number;
  /** Basis-URL von Invoice Ninja ohne /api/v1, auf olav http://invoiceninja-web */
  ninjaUrl: string;
  ninjaToken: string;
  /** Kopfzeile Host für Invoice Ninja, damit Laravel die richtige APP_URL sieht */
  ninjaHost?: string;
  authMode: AuthMode;
  /** z. B. https://jonas-kuhlmann.cloudflareaccess.com */
  accessTeamDomain?: string;
  accessAud?: string;
  /** Nur diese Adressen dürfen, zusätzlich zur Access-Policy */
  allowedEmails: string[];
  ntfyUrl?: string;
  ntfyTitle: string;
  /** Text, der in die privaten Notizen jedes Entwurfs geschrieben wird */
  draftMarker: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? "cloudflare_access") as AuthMode;
  if (authMode !== "cloudflare_access" && authMode !== "none") {
    throw new Error(`AUTH_MODE muss cloudflare_access oder none sein, nicht ${authMode}`);
  }
  // Ohne Anmeldung nur mit ausdrücklicher Zustimmung, gedacht für lokale Tests.
  if (authMode === "none" && env.ALLOW_INSECURE_NO_AUTH !== "1") {
    throw new Error("AUTH_MODE=none braucht zusätzlich ALLOW_INSECURE_NO_AUTH=1");
  }

  const cfg: Config = {
    port: Number(env.PORT ?? 8080),
    ninjaUrl: required(env, "INVOICENINJA_URL").replace(/\/+$/, "").replace(/\/api\/v1$/, ""),
    ninjaToken: required(env, "INVOICENINJA_API_TOKEN"),
    ninjaHost: env.INVOICENINJA_HOST?.trim() || undefined,
    authMode,
    allowedEmails: (env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    ntfyUrl: env.NTFY_TOPIC?.trim() ? `https://ntfy.sh/${env.NTFY_TOPIC.trim()}` : undefined,
    ntfyTitle: env.NTFY_TITLE ?? "Invoice Ninja MCP auf olav",
    draftMarker: env.DRAFT_MARKER ?? "Angelegt von Claude über MCP",
  };

  if (authMode === "cloudflare_access") {
    cfg.accessTeamDomain = required(env, "CF_ACCESS_TEAM_DOMAIN").replace(/\/+$/, "");
    cfg.accessAud = required(env, "CF_ACCESS_AUD");
    if (cfg.allowedEmails.length === 0) throw new Error("ALLOWED_EMAILS fehlt");
  }
  return cfg;
}
