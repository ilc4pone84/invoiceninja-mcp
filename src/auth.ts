// Zweite Prüfung hinter Cloudflare Access: cloudflared prüft das JWT schon,
// der Server prüft es noch einmal gegen Team-Domain, AUD und erlaubte Adressen.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";

export interface Identity {
  email: string;
}

export type Authenticator = (req: IncomingMessage) => Promise<Identity>;

export class AuthError extends Error {}

export function createAuthenticator(cfg: Config, keys?: JWTVerifyGetKey): Authenticator {
  if (cfg.authMode === "none") {
    return async () => ({ email: "lokal" });
  }
  const issuer = cfg.accessTeamDomain!;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (req) => {
    const token = req.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string" || !token) throw new AuthError("Access-JWT fehlt");
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience: cfg.accessAud!, algorithms: ["RS256"] }));
    } catch (e) {
      throw new AuthError(`Access-JWT ungültig: ${(e as Error).message}`);
    }
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email || !cfg.allowedEmails.includes(email)) throw new AuthError("Adresse nicht freigegeben");
    return { email };
  };
}
