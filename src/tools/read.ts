// Lesende Werkzeuge.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ListResponse, NinjaClient } from "../ninja.js";
import * as f from "./format.js";
import type { Ninja } from "./format.js";

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT");
const id = z.string().regex(/^[A-Za-z0-9]{1,32}$/, "ID aus Invoice Ninja");
const page = {
  seite: z.number().int().min(1).default(1).describe("Seite, beginnt bei 1"),
  pro_seite: z.number().int().min(1).max(100).default(25).describe("Einträge je Seite"),
};

function paging<T>(res: ListResponse<T>) {
  const p = res.meta?.pagination;
  return p ? { gesamt: p.total, seite: p.current_page, seiten: p.total_pages } : undefined;
}

function range(von?: string, bis?: string) {
  return von || bis ? `${von ?? "1970-01-01"},${bis ?? "2999-12-31"}` : undefined;
}

export function registerReadTools(server: McpServer, ninja: NinjaClient) {
  server.registerTool(
    "verbindung_pruefen",
    {
      title: "Verbindung prüfen",
      description: "Prüft die Verbindung zu Invoice Ninja und nennt Firma und Benutzer des Tokens.",
      annotations: READ,
    },
    async () => {
      const r = await ninja.get<{ company_name?: string; user_name?: string }>("/ping");
      return f.result({ firma: r.company_name, benutzer: r.user_name });
    },
  );

  server.registerTool(
    "kunden_suchen",
    {
      title: "Kunden suchen",
      description: "Sucht Kunden nach Name, Nummer, E-Mail oder Freitext. Ohne Suchbegriff alle aktiven Kunden.",
      inputSchema: { suche: z.string().max(100).optional().describe("Suchbegriff"), ...page },
      annotations: READ,
    },
    async ({ suche, seite, pro_seite }) => {
      const r = await ninja.get<ListResponse<Ninja>>("/clients", {
        filter: suche,
        status: "active",
        sort: "name|asc",
        page: seite,
        per_page: pro_seite,
      });
      return f.result({ kunden: r.data.map(f.client), seiten: paging(r) });
    },
  );

  server.registerTool(
    "kunde_anzeigen",
    {
      title: "Kunde anzeigen",
      description: "Zeigt einen Kunden mit Kontakten, Saldo und den letzten Rechnungen.",
      inputSchema: { kunde_id: id },
      annotations: READ,
    },
    async ({ kunde_id }) => {
      const [c, inv] = await Promise.all([
        ninja.get<{ data: Ninja }>(`/clients/${kunde_id}`),
        ninja.get<ListResponse<Ninja>>("/invoices", { client_id: kunde_id, sort: "date|desc", per_page: 10, status: "active" }),
      ]);
      return f.result({ kunde: f.client(c.data), letzte_rechnungen: inv.data.map(f.invoiceSummary) });
    },
  );

  server.registerTool(
    "rechnungen_auflisten",
    {
      title: "Rechnungen auflisten",
      description:
        "Listet Rechnungen, neueste zuerst. Filter nach Status, Kunde, Rechnungsdatum und Freitext. Status 'offen' = versendet oder teilweise bezahlt, 'ueberfaellig' = offen und Fälligkeit vorbei.",
      inputSchema: {
        status: z.enum(["alle", "entwurf", "offen", "ueberfaellig", "bezahlt", "storniert"]).default("alle"),
        kunde_id: id.optional(),
        von: date.optional().describe("Rechnungsdatum ab"),
        bis: date.optional().describe("Rechnungsdatum bis"),
        suche: z.string().max(100).optional(),
        ...page,
      },
      annotations: READ,
    },
    async ({ status, kunde_id, von, bis, suche, seite, pro_seite }) => {
      const map: Record<string, string> = {
        alle: "all",
        entwurf: "draft",
        offen: "unpaid",
        ueberfaellig: "overdue",
        bezahlt: "paid",
        storniert: "cancelled",
      };
      const r = await ninja.get<ListResponse<Ninja>>("/invoices", {
        client_status: map[status],
        client_id: kunde_id,
        date_range: range(von, bis),
        filter: suche,
        status: "active",
        include: "client",
        sort: "date|desc",
        page: seite,
        per_page: pro_seite,
      });
      return f.result({ rechnungen: r.data.map(f.invoiceSummary), seiten: paging(r) });
    },
  );

  server.registerTool(
    "rechnung_anzeigen",
    {
      title: "Rechnung anzeigen",
      description: "Zeigt eine Rechnung mit allen Positionen und Notizen.",
      inputSchema: { rechnung_id: id },
      annotations: READ,
    },
    async ({ rechnung_id }) => {
      const r = await ninja.get<{ data: Ninja }>(`/invoices/${rechnung_id}`, { include: "client" });
      return f.result(f.invoiceDetail(r.data));
    },
  );

  server.registerTool(
    "angebote_auflisten",
    {
      title: "Angebote auflisten",
      description: "Listet Angebote, neueste zuerst, nach Status, Kunde und Datum.",
      inputSchema: {
        status: z.enum(["alle", "entwurf", "versendet", "angenommen", "abgelaufen", "abgelehnt"]).default("alle"),
        kunde_id: id.optional(),
        von: date.optional(),
        bis: date.optional(),
        suche: z.string().max(100).optional(),
        ...page,
      },
      annotations: READ,
    },
    async ({ status, kunde_id, von, bis, suche, seite, pro_seite }) => {
      const map: Record<string, string> = {
        alle: "all",
        entwurf: "draft",
        versendet: "sent",
        angenommen: "approved",
        abgelaufen: "expired",
        abgelehnt: "rejected",
      };
      const r = await ninja.get<ListResponse<Ninja>>("/quotes", {
        client_status: map[status],
        client_id: kunde_id,
        date_range: range(von, bis),
        filter: suche,
        status: "active",
        include: "client",
        sort: "date|desc",
        page: seite,
        per_page: pro_seite,
      });
      return f.result({ angebote: r.data.map(f.quoteSummary), seiten: paging(r) });
    },
  );

  server.registerTool(
    "angebot_anzeigen",
    {
      title: "Angebot anzeigen",
      description: "Zeigt ein Angebot mit allen Positionen.",
      inputSchema: { angebot_id: id },
      annotations: READ,
    },
    async ({ angebot_id }) => {
      const r = await ninja.get<{ data: Ninja }>(`/quotes/${angebot_id}`, { include: "client" });
      return f.result(f.quoteDetail(r.data));
    },
  );

  server.registerTool(
    "zahlungen_auflisten",
    {
      title: "Zahlungen auflisten",
      description: "Listet eingegangene Zahlungen, neueste zuerst, nach Kunde und Zahlungsdatum.",
      inputSchema: { kunde_id: id.optional(), von: date.optional(), bis: date.optional(), ...page },
      annotations: READ,
    },
    async ({ kunde_id, von, bis, seite, pro_seite }) => {
      const r = await ninja.get<ListResponse<Ninja>>("/payments", {
        client_id: kunde_id,
        date_range: range(von, bis),
        status: "active",
        include: "client,paymentables",
        sort: "date|desc",
        page: seite,
        per_page: pro_seite,
      });
      return f.result({ zahlungen: r.data.map(f.payment), seiten: paging(r) });
    },
  );

  server.registerTool(
    "ausgaben_auflisten",
    {
      title: "Ausgaben auflisten",
      description: "Listet Ausgaben, neueste zuerst, nach Datum und Freitext.",
      inputSchema: { von: date.optional(), bis: date.optional(), suche: z.string().max(100).optional(), ...page },
      annotations: READ,
    },
    async ({ von, bis, suche, seite, pro_seite }) => {
      const r = await ninja.get<ListResponse<Ninja>>("/expenses", {
        date_range: range(von, bis),
        filter: suche,
        status: "active",
        sort: "date|desc",
        page: seite,
        per_page: pro_seite,
      });
      return f.result({ ausgaben: r.data.map(f.expense), seiten: paging(r) });
    },
  );

  server.registerTool(
    "stammdaten_auflisten",
    {
      title: "Lieferanten, Kategorien, Produkte",
      description: "Listet Lieferanten, Ausgabenkategorien und Produkte mit ihren IDs, z. B. um eine Ausgabe oder Position zuzuordnen.",
      inputSchema: { art: z.enum(["lieferanten", "kategorien", "produkte"]) },
      annotations: READ,
    },
    async ({ art }) => {
      const path = { lieferanten: "/vendors", kategorien: "/expense_categories", produkte: "/products" }[art];
      const { items, truncated } = await ninja.getAll<Ninja>(path, { status: "active" }, 1000);
      const rows = items.map((x) =>
        art === "produkte"
          ? { id: x.id, produkt: x.product_key, text: x.notes, preis: x.price, steuer: x.tax_name1 ? `${x.tax_name1} ${x.tax_rate1} %` : undefined }
          : { id: x.id, name: x.name },
      );
      return f.result({ [art]: rows, gekuerzt: truncated || undefined });
    },
  );

  server.registerTool(
    "auswertung",
    {
      title: "Umsatz und offene Posten",
      description:
        "Summen für einen Zeitraum: Rechnungsbetrag nach Rechnungsdatum (ohne Entwürfe und Stornos), Zahlungseingang nach Zahlungsdatum, Ausgaben. Dazu offene Posten zum heutigen Tag.",
      inputSchema: { von: date, bis: date },
      annotations: READ,
    },
    async ({ von, bis }) => {
      const dr = `${von},${bis}`;
      const [inv, pay, exp, open] = await Promise.all([
        ninja.getAll<Ninja>("/invoices", { date_range: dr, client_status: "unpaid,paid", status: "active" }),
        ninja.getAll<Ninja>("/payments", { date_range: dr, client_status: "completed,partially_refunded,refunded", status: "active" }),
        ninja.getAll<Ninja>("/expenses", { date_range: dr, status: "active" }),
        ninja.getAll<Ninja>("/invoices", { client_status: "unpaid", status: "active", include: "client" }),
      ]);
      const sum = (xs: Ninja[], k: string) => f.round2(xs.reduce((a, x) => a + Number(x[k] ?? 0), 0));
      const today = new Date().toISOString().slice(0, 10);
      const overdue = open.items.filter((i) => typeof i.due_date === "string" && i.due_date && i.due_date < today);
      return f.result({
        zeitraum: { von, bis },
        rechnungen: { anzahl: inv.items.length, betrag: sum(inv.items, "amount") },
        zahlungseingang: {
          anzahl: pay.items.length,
          betrag: f.round2(sum(pay.items, "amount") - sum(pay.items, "refunded")),
        },
        ausgaben: { anzahl: exp.items.length, betrag: sum(exp.items, "amount") },
        offene_posten_heute: {
          anzahl: open.items.length,
          betrag: sum(open.items, "balance"),
          ueberfaellig_anzahl: overdue.length,
          ueberfaellig_betrag: sum(overdue, "balance"),
          liste: open.items.map(f.invoiceSummary),
        },
        hinweis:
          inv.truncated || pay.truncated || exp.truncated || open.truncated ? "Mehr als 5000 Einträge, Summen unvollständig" : undefined,
        beträge: "Brutto in Firmenwährung, ohne Umrechnung fremder Währungen",
      });
    },
  );
}
