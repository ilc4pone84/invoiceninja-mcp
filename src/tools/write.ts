// Schreibende Werkzeuge: nur Entwürfe, Ausgaben und Kunden anlegen.
// Nie löschen, versenden, als bezahlt markieren oder Nicht-Entwürfe ändern.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NinjaClient } from "../ninja.js";
import type { Notifier } from "../notify.js";
import * as f from "./format.js";
import type { Ninja } from "./format.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const UPDATE = { ...WRITE, idempotentHint: true } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT");
const id = z.string().regex(/^[A-Za-z0-9]{1,32}$/, "ID aus Invoice Ninja");
const text = (max: number) => z.string().max(max);

const position = z.object({
  text: text(2000).describe("Beschreibung der Leistung"),
  menge: z.number().positive().max(1_000_000).default(1),
  preis: z.number().min(0).max(10_000_000).describe("Einzelpreis netto oder brutto, wie in den Firmeneinstellungen"),
  produkt: text(100).optional().describe("Produktschlüssel, siehe stammdaten_auflisten"),
  rabatt: z.number().min(0).max(100).optional().describe("Rabatt in Prozent"),
  steuer_name: text(50).optional().describe("z. B. MwSt."),
  steuer_satz: z.number().min(0).max(100).optional().describe("z. B. 19"),
});
type Position = z.infer<typeof position>;

const documentFields = {
  positionen: z.array(position).min(1).max(100),
  datum: date.optional().describe("Dokumentdatum, Standard heute"),
  faellig: date.optional().describe("Fälligkeit (Rechnung) oder gültig bis (Angebot)"),
  oeffentliche_notiz: text(5000).optional().describe("erscheint auf dem Dokument"),
  private_notiz: text(5000).optional().describe("nur intern"),
  bestellnummer: text(100).optional(),
};

function lineItems(ps: Position[]) {
  return ps.map((p) => ({
    type_id: "1",
    product_key: p.produkt ?? "",
    notes: p.text,
    quantity: p.menge,
    cost: p.preis,
    discount: p.rabatt ?? 0,
    is_amount_discount: false,
    tax_name1: p.steuer_name ?? "",
    tax_rate1: p.steuer_satz ?? 0,
  }));
}

function marked(marker: string, note?: string): string {
  return note ? `${marker}\n${note}` : marker;
}

function documentBody(
  marker: string,
  a: { positionen?: Position[]; datum?: string; faellig?: string; oeffentliche_notiz?: string; private_notiz?: string; bestellnummer?: string },
  existingPrivate?: string,
) {
  const body: Record<string, unknown> = {};
  if (a.positionen) body.line_items = lineItems(a.positionen);
  if (a.datum) body.date = a.datum;
  if (a.faellig) body.due_date = a.faellig;
  if (a.oeffentliche_notiz !== undefined) body.public_notes = a.oeffentliche_notiz;
  if (a.bestellnummer !== undefined) body.po_number = a.bestellnummer;
  if (a.private_notiz !== undefined || existingPrivate === undefined) {
    body.private_notes = marked(marker, a.private_notiz);
  } else if (!existingPrivate.includes(marker)) {
    body.private_notes = marked(marker, existingPrivate);
  }
  return body;
}

const fmt = (x: unknown) => Number(x ?? 0).toFixed(2);

export function registerWriteTools(server: McpServer, ninja: NinjaClient, notify: Notifier, marker: string) {
  for (const kind of ["rechnung", "angebot"] as const) {
    const path = kind === "rechnung" ? "/invoices" : "/quotes";
    const label = kind === "rechnung" ? "Rechnungsentwurf" : "Angebotsentwurf";
    const detail = kind === "rechnung" ? f.invoiceDetail : f.quoteDetail;

    server.registerTool(
      `${kind}_entwurf_anlegen`,
      {
        title: `${label} anlegen`,
        description: `Legt einen ${label} für einen vorhandenen Kunden an. Er wird nicht versendet. Versenden und Festschreiben macht Jonas in der Weboberfläche.`,
        inputSchema: { kunde_id: id, ...documentFields },
        annotations: WRITE,
      },
      async ({ kunde_id, ...a }) => {
        const r = await ninja.post<{ data: Ninja }>(path, { client_id: kunde_id, ...documentBody(marker, a) });
        const d = r.data;
        if (String(d.status_id) !== "1") {
          await notify(`WARNUNG: ${label} ${d.id} hat Status ${d.status_id} statt Entwurf. Bitte prüfen.`);
        } else {
          await notify(`${label} angelegt: ID ${d.id}, Betrag ${fmt(d.amount)}`);
        }
        return f.result({ angelegt: detail(d) });
      },
    );

    server.registerTool(
      `${kind}_entwurf_aendern`,
      {
        title: `${label} ändern`,
        description: `Ändert einen ${label}. Geht nur, solange das Dokument ein Entwurf ist. Werden Positionen angegeben, ersetzen sie alle bisherigen.`,
        inputSchema: {
          [`${kind}_id`]: id,
          ...documentFields,
          positionen: documentFields.positionen.optional(),
        },
        annotations: UPDATE,
      },
      async (args: Record<string, unknown>) => {
        const docId = args[`${kind}_id`] as string;
        const cur = (await ninja.get<{ data: Ninja }>(`${path}/${docId}`)).data;
        if (String(cur.status_id) !== "1" || cur.is_deleted || cur.archived_at) {
          return f.errorResult(`${docId} ist kein offener Entwurf (Status ${cur.status_id}). Nur Entwürfe dürfen geändert werden.`);
        }
        const body = documentBody(marker, args as Parameters<typeof documentBody>[1], String(cur.private_notes ?? ""));
        const r = await ninja.put<{ data: Ninja }>(`${path}/${docId}`, body);
        await notify(`${label} geändert: ID ${docId}, Betrag ${fmt(r.data.amount)}`);
        return f.result({ geaendert: detail(r.data) });
      },
    );
  }

  server.registerTool(
    "ausgabe_anlegen",
    {
      title: "Ausgabe erfassen",
      description: "Erfasst eine Ausgabe (Beleg). Lieferant und Kategorie per ID aus stammdaten_auflisten.",
      inputSchema: {
        betrag: z.number().positive().max(10_000_000),
        datum: date,
        lieferant_id: id.optional(),
        kategorie_id: id.optional(),
        notiz: text(2000).optional().describe("Wofür, z. B. Rechnungsnummer des Lieferanten"),
        private_notiz: text(2000).optional(),
        steuer_name: text(50).optional(),
        steuer_satz: z.number().min(0).max(100).optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      const body: Record<string, unknown> = {
        amount: a.betrag,
        date: a.datum,
        public_notes: a.notiz ?? "",
        private_notes: marked(marker, a.private_notiz),
        should_be_invoiced: false,
      };
      if (a.lieferant_id) body.vendor_id = a.lieferant_id;
      if (a.kategorie_id) body.category_id = a.kategorie_id;
      if (a.steuer_name) body.tax_name1 = a.steuer_name;
      if (a.steuer_satz !== undefined) body.tax_rate1 = a.steuer_satz;
      const r = await ninja.post<{ data: Ninja }>("/expenses", body);
      await notify(`Ausgabe erfasst: ID ${r.data.id}, Betrag ${fmt(r.data.amount)}`);
      return f.result({ angelegt: f.expense(r.data) });
    },
  );

  server.registerTool(
    "kunde_anlegen",
    {
      title: "Kunde anlegen",
      description: "Legt einen neuen Kunden an. Vorher mit kunden_suchen prüfen, ob es ihn schon gibt.",
      inputSchema: {
        name: text(200),
        kontakte: z
          .array(z.object({ vorname: text(100).optional(), nachname: text(100).optional(), email: z.email().optional(), telefon: text(50).optional() }))
          .max(10)
          .default([]),
        strasse: text(200).optional(),
        adresszusatz: text(200).optional(),
        plz: text(20).optional(),
        ort: text(100).optional(),
        land_id: z.string().regex(/^\d{1,3}$/).default("276").describe("ISO-3166-Nummer, 276 = Deutschland"),
        ust_id: text(50).optional(),
        private_notiz: text(2000).optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      const body = {
        name: a.name,
        contacts: (a.kontakte.length ? a.kontakte : [{}]).map((k) => ({
          first_name: k.vorname ?? "",
          last_name: k.nachname ?? "",
          email: k.email ?? "",
          phone: k.telefon ?? "",
        })),
        address1: a.strasse ?? "",
        address2: a.adresszusatz ?? "",
        postal_code: a.plz ?? "",
        city: a.ort ?? "",
        country_id: a.land_id,
        vat_number: a.ust_id ?? "",
        private_notes: marked(marker, a.private_notiz),
      };
      const r = await ninja.post<{ data: Ninja }>("/clients", body);
      await notify(`Kunde angelegt: ID ${r.data.id}`);
      return f.result({ angelegt: f.client(r.data) });
    },
  );
}
