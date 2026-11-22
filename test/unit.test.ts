import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createAuthenticator } from "../src/auth.js";
import { loadConfig, type Config } from "../src/config.js";
import { NinjaClient } from "../src/ninja.js";

describe("NinjaClient.assertAllowed", () => {
  const ok: Array<[string, string]> = [
    ["GET", "/invoices"],
    ["GET", "/invoices/abc123?include=client"],
    ["GET", "/ping"],
    ["POST", "/invoices"],
    ["POST", "/expenses"],
    ["PUT", "/quotes/Xy12"],
  ];
  const blocked: Array<[string, string]> = [
    ["DELETE", "/invoices/abc"],
    ["POST", "/invoices/bulk"],
    ["POST", "/invoices/abc/email"],
    ["POST", "/payments"],
    ["PUT", "/clients/abc"],
    ["PUT", "/invoices/abc?mark_sent=true"],
    ["POST", "/invoices?send_email=true"],
    ["GET", "/invoices?paid=true"],
    ["GET", "/invoices/abc/download"],
    ["GET", "/users"],
    ["GET", "/tokens"],
    ["GET", "/invoices/../users"],
  ];
  it.each(ok)("erlaubt %s %s", (m, p) => {
    expect(() => NinjaClient.assertAllowed(m as "GET", p)).not.toThrow();
  });
  it.each(blocked)("sperrt %s %s", (m, p) => {
    expect(() => NinjaClient.assertAllowed(m as "GET", p)).toThrow(/Nicht erlaubt/);
  });

  it("setzt Token, Proto und Host, folgt keiner Umleitung", async () => {
    let seen: RequestInit | undefined;
    let seenUrl = "";
    const c = new NinjaClient({
      baseUrl: "http://invoiceninja-web",
      token: "tok",
      host: "rechnung.example",
      fetchImpl: (async (u: string, init: RequestInit) => {
        seenUrl = u;
        seen = init;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });
    await c.get("/clients", { filter: "a b", page: 1, leer: undefined });
    expect(seenUrl).toBe("http://invoiceninja-web/api/v1/clients?filter=a+b&page=1");
    const h = seen!.headers as Record<string, string>;
    expect(h["X-API-TOKEN"]).toBe("tok");
    expect(h["X-Forwarded-Proto"]).toBe("https");
    expect(h.Host).toBe("rechnung.example");
    expect(seen!.redirect).toBe("manual");
  });

  it("meldet Fehler mit Text aus Invoice Ninja", async () => {
    const c = new NinjaClient({
      baseUrl: "http://x",
      token: "t",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: "The given data was invalid.", errors: { client_id: ["required"] } }), { status: 422 })) as typeof fetch,
    });
    await expect(c.post("/invoices", {})).rejects.toThrow(/422.*client_id: required/);
  });

  it("behandelt eine Umleitung als Fehler", async () => {
    const c = new NinjaClient({
      baseUrl: "http://x",
      token: "t",
      fetchImpl: (async () => new Response("", { status: 302, headers: { Location: "https://x/" } })) as typeof fetch,
    });
    await expect(c.get("/ping")).rejects.toThrow(/302/);
  });
});

describe("loadConfig", () => {
  const base = { INVOICENINJA_URL: "http://invoiceninja-web/api/v1/", INVOICENINJA_API_TOKEN: "t" };
  it("verlangt Access-Werte im Standardmodus", () => {
    expect(() => loadConfig(base)).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
    expect(() => loadConfig({ ...base, CF_ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com", CF_ACCESS_AUD: "a" })).toThrow(/ALLOWED_EMAILS/);
  });
  it("AUTH_MODE=none nur mit ausdrücklicher Zustimmung", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "none" })).toThrow(/ALLOW_INSECURE_NO_AUTH/);
    expect(loadConfig({ ...base, AUTH_MODE: "none", ALLOW_INSECURE_NO_AUTH: "1" }).ninjaUrl).toBe("http://invoiceninja-web");
  });
  it("liest erlaubte Adressen klein und ntfy-Thema", () => {
    const c = loadConfig({
      ...base,
      CF_ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com/",
      CF_ACCESS_AUD: "aud",
      ALLOWED_EMAILS: " A@B.de , c@d.de",
      NTFY_TOPIC: "geheim",
    });
    expect(c.allowedEmails).toEqual(["a@b.de", "c@d.de"]);
    expect(c.accessTeamDomain).toBe("https://t.cloudflareaccess.com");
    expect(c.ntfyUrl).toBe("https://ntfy.sh/geheim");
  });
});

describe("Access-JWT", async () => {
  const team = "https://team.cloudflareaccess.com";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const other = await generateKeyPair("RS256");
  const cfg = { authMode: "cloudflare_access", accessTeamDomain: team, accessAud: "aud1", allowedEmails: ["jonas@example.de"] } as Config;
  const auth = createAuthenticator(cfg, keys);
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; key?: CryptoKey; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? team)
      .setAudience(opts.aud ?? "aud1")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(opts.key ?? privateKey);
  const req = (token?: string) => ({ headers: token ? { "cf-access-jwt-assertion": token } : {} }) as IncomingMessage;

  it("lässt die freigegebene Adresse durch", async () => {
    await expect(auth(req(await sign({ email: "Jonas@Example.de" })))).resolves.toEqual({ email: "jonas@example.de" });
  });
  it("lehnt fehlendes JWT ab", async () => {
    await expect(auth(req())).rejects.toThrow(/fehlt/);
  });
  it("lehnt falsches AUD, falschen Aussteller, fremden Schlüssel und Ablauf ab", async () => {
    await expect(auth(req(await sign({ email: "jonas@example.de" }, { aud: "andere" })))).rejects.toThrow(/ungültig/);
    await expect(auth(req(await sign({ email: "jonas@example.de" }, { iss: "https://evil.cloudflareaccess.com" })))).rejects.toThrow(/ungültig/);
    await expect(auth(req(await sign({ email: "jonas@example.de" }, { key: other.privateKey })))).rejects.toThrow(/ungültig/);
    await expect(auth(req(await sign({ email: "jonas@example.de" }, { exp: "-1m" })))).rejects.toThrow(/ungültig/);
  });
  it("lehnt andere Adressen und Service-Tokens ohne Adresse ab", async () => {
    await expect(auth(req(await sign({ email: "paul@example.de" })))).rejects.toThrow(/nicht freigegeben/);
    await expect(auth(req(await sign({ common_name: "svc" })))).rejects.toThrow(/nicht freigegeben/);
  });
});
