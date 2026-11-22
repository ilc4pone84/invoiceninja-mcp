// Client für die Invoice-Ninja-API v5.
// Bewusst eng: Nur die Methoden und Pfade aus ALLOWED sind möglich. Löschen,
// Versand, Bulk-Aktionen und Statuswechsel per Query-Parameter gehen nicht,
// auch wenn ein Werkzeug fehlerhaft wäre.

export class NinjaError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "NinjaError";
  }
}

type Method = "GET" | "POST" | "PUT";

const ID = "[A-Za-z0-9]{1,32}";
const ALLOWED: Array<[Method, RegExp]> = [
  ["GET", /^\/ping$/],
  ["GET", new RegExp(`^/(clients|invoices|quotes|payments|expenses|vendors|expense_categories|products)(/${ID})?$`)],
  ["POST", /^\/(clients|invoices|quotes|expenses)$/],
  ["PUT", new RegExp(`^/(invoices|quotes)/${ID}$`)],
];

// Query-Parameter, mit denen Invoice Ninja beim Speichern Aktionen auslöst.
const FORBIDDEN_QUERY = /(^|&)(send_email|mark_sent|paid|amount_paid|approve|convert|action|cancel|reverse|email_type|save_default_footer|save_default_terms)=/i;

export interface ListResponse<T> {
  data: T[];
  meta?: { pagination?: { total: number; count: number; per_page: number; current_page: number; total_pages: number } };
}

export interface NinjaClientOptions {
  baseUrl: string;
  token: string;
  host?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class NinjaClient {
  private fetchImpl: typeof fetch;
  constructor(private opts: NinjaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static assertAllowed(method: Method, path: string): void {
    const [p, q = ""] = path.split("?", 2) as [string, string?];
    if (!ALLOWED.some(([m, re]) => m === method && re.test(p))) {
      throw new NinjaError(`Nicht erlaubt: ${method} ${p}`);
    }
    if (method !== "GET" && q) throw new NinjaError(`Nicht erlaubt: Query-Parameter bei ${method}`);
    if (FORBIDDEN_QUERY.test(q)) throw new NinjaError(`Nicht erlaubt: Query-Parameter in ${path}`);
  }

  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    NinjaClient.assertAllowed(method, path);
    const headers: Record<string, string> = {
      "X-API-TOKEN": this.opts.token,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      // Invoice Ninja läuft mit REQUIRE_HTTPS hinter Cloudflare. Intern kommt
      // die Anfrage per HTTP, deshalb wie Cloudflare das Original-Protokoll angeben.
      "X-Forwarded-Proto": "https",
    };
    if (this.opts.host) headers.Host = this.opts.host;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (res.status >= 300) {
      throw new NinjaError(`Invoice Ninja antwortet ${res.status}: ${summarizeError(text)}`, res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NinjaError(`Invoice Ninja liefert kein JSON (${res.status})`, res.status);
    }
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return this.request<T>("GET", s ? `${path}?${s}` : path);
  }

  /** Alle Seiten einer Liste, höchstens maxItems Einträge. */
  async getAll<T>(path: string, query: Record<string, string | number | undefined>, maxItems = 5000): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    const perPage = 500;
    for (let page = 1; ; page++) {
      const res = await this.get<ListResponse<T>>(path, { ...query, per_page: perPage, page });
      items.push(...res.data);
      const totalPages = res.meta?.pagination?.total_pages ?? 1;
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), truncated: true };
      if (page >= totalPages || res.data.length === 0) return { items, truncated: false };
    }
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
}

function summarizeError(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string; errors?: Record<string, string[]> };
    const errs = j.errors ? Object.entries(j.errors).map(([k, v]) => `${k}: ${v.join(" ")}`).join("; ") : "";
    return [j.message, errs].filter(Boolean).join(" – ").slice(0, 500);
  } catch {
    return text.slice(0, 200);
  }
}
