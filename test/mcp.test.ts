// Durchlauf über HTTP mit dem MCP-Client des SDK gegen eine nachgebaute Invoice-Ninja-API.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { NinjaClient } from "../src/ninja.js";
import { createHttpServer } from "../src/server.js";

interface Call {
  method: string;
  url: URL;
  body?: Record<string, unknown>;
}
let calls: Call[] = [];
let notes: string[] = [];
const invoices: Record<string, Record<string, unknown>> = {
  draft1: { id: "draft1", number: "", client_id: "c1", status_id: "1", amount: 100, balance: 0, private_notes: "alt", line_items: [] },
  sent1: { id: "sent1", number: "R-1", client_id: "c1", status_id: "2", amount: 200, balance: 200, due_date: "2026-01-01" },
};

const fakeNinja = (async (u: string, init: RequestInit) => {
  const url = new URL(u);
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const path = url.pathname.replace("/api/v1", "");
  const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  if (path === "/invoices" && method === "GET") {
    return ok({ data: Object.values(invoices), meta: { pagination: { total: 2, count: 2, per_page: 25, current_page: 1, total_pages: 1 } } });
  }
  const m = path.match(/^\/invoices\/(\w+)$/);
  if (m && method === "GET") return ok({ data: invoices[m[1]!] });
  if (m && method === "PUT") return ok({ data: { ...invoices[m[1]!], ...body, amount: 150 } });
  if (path === "/invoices" && method === "POST") return ok({ data: { id: "new1", status_id: "1", amount: 119, ...body } });
  if (path === "/expenses" && method === "POST") return ok({ data: { id: "e1", ...body } });
  return new Response(JSON.stringify({ message: "nope" }), { status: 404 });
}) as typeof fetch;

let base: string;
let close: () => void;
let denyNext = false;

beforeAll(async () => {
  const cfg = loadConfig({ INVOICENINJA_URL: "http://ninja", INVOICENINJA_API_TOKEN: "t", AUTH_MODE: "none", ALLOW_INSECURE_NO_AUTH: "1" });
  const ninja = new NinjaClient({ baseUrl: cfg.ninjaUrl, token: "t", fetchImpl: fakeNinja });
  const auth = async () => {
    if (denyNext) throw new AuthError("nein");
    return { email: "test" };
  };
  const http = createHttpServer(cfg, ninja, async (m) => void notes.push(m), auth);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => http.close();
});
afterAll(() => close());
beforeEach(() => {
  calls = [];
  notes = [];
  denyNext = false;
});

async function client() {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return c;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

describe("MCP über HTTP", () => {
  it("hat /health ohne Anmeldung", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
  });

  it("lehnt ab, wenn die Anmeldung scheitert", async () => {
    denyNext = true;
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(403);
  });

  it("bietet keine Werkzeuge zum Löschen, Versenden oder Bezahlen", async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("rechnungen_auflisten");
    expect(names).toContain("rechnung_entwurf_anlegen");
    expect(names.filter((n) => /loesch|delete|send|versend|bezahl|paid|archiv/i.test(n))).toEqual([]);
    await c.close();
  });

  it("übersetzt Filter für Rechnungen", async () => {
    const c = await client();
    const r = await c.callTool({ name: "rechnungen_auflisten", arguments: { status: "ueberfaellig", von: "2026-01-01", bis: "2026-03-31" } });
    const q = calls[0]!.url.searchParams;
    expect(q.get("client_status")).toBe("overdue");
    expect(q.get("date_range")).toBe("2026-01-01,2026-03-31");
    expect(q.get("status")).toBe("active");
    expect(text(r)).toContain("keine Anweisungen");
    expect(text(r)).toContain("R-1");
    await c.close();
  });

  it("legt Rechnungsentwurf mit Markierung an und meldet ihn", async () => {
    const c = await client();
    await c.callTool({
      name: "rechnung_entwurf_anlegen",
      arguments: { kunde_id: "c1", positionen: [{ text: "Beratung", menge: 2, preis: 50, steuer_name: "MwSt.", steuer_satz: 19 }] },
    });
    const post = calls.find((x) => x.method === "POST")!;
    expect(post.url.pathname).toBe("/api/v1/invoices");
    expect(post.url.search).toBe("");
    expect(post.body!.client_id).toBe("c1");
    expect(post.body!.private_notes).toMatch(/^Angelegt von Claude/);
    expect((post.body!.line_items as Array<Record<string, unknown>>)[0]).toMatchObject({ notes: "Beratung", quantity: 2, cost: 50, tax_rate1: 19 });
    expect(post.body).not.toHaveProperty("status_id");
    expect(notes).toEqual(["Rechnungsentwurf angelegt: ID new1, Betrag 119.00"]);
    await c.close();
  });

  it("ändert nur Entwürfe", async () => {
    const c = await client();
    const r = await c.callTool({ name: "rechnung_entwurf_aendern", arguments: { rechnung_id: "sent1", faellig: "2026-12-31" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/kein offener Entwurf/);
    expect(calls.some((x) => x.method === "PUT")).toBe(false);
    expect(notes).toEqual([]);

    await c.callTool({ name: "rechnung_entwurf_aendern", arguments: { rechnung_id: "draft1", faellig: "2026-12-31" } });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.body).toEqual({ due_date: "2026-12-31", private_notes: "Angelegt von Claude über MCP\nalt" });
    expect(notes).toHaveLength(1);
    await c.close();
  });

  it("prüft Eingaben", async () => {
    const c = await client();
    const r = await c.callTool({ name: "rechnung_anzeigen", arguments: { rechnung_id: "../users" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await c.close();
  });

  it("gibt API-Fehler als Werkzeugfehler zurück", async () => {
    const c = await client();
    const r = await c.callTool({ name: "kunde_anzeigen", arguments: { kunde_id: "fehlt" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/404/);
    await c.close();
  });
});
