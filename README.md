# invoiceninja-mcp

MCP-Server für Invoice Ninja v5 auf olav. Claude liest Kunden, Rechnungen, Angebote, Zahlungen und Ausgaben und legt Entwürfe an. Betrieb, Zugang und Entscheidung stehen im Repo `homeserver-linux`: `docs/dienste/invoiceninja-mcp.md`, ADR 0007.

## Grenzen

| Darf | Darf nicht |
|---|---|
| alles lesen außer PDFs und Dokumenten | löschen, archivieren |
| Rechnungs- und Angebotsentwürfe anlegen und ändern, solange Entwurf | per Mail versenden, als versendet oder bezahlt markieren |
| Ausgaben erfassen, Kunden anlegen | Nicht-Entwürfe ändern, Zahlungen anlegen |

Durchgesetzt an drei Stellen: Es gibt keine solchen Werkzeuge. Der API-Client lässt nur eine feste Liste von Methoden und Pfaden zu, ohne Query-Parameter beim Schreiben ([src/ninja.ts](src/ninja.ts)). Der Invoice-Ninja-Benutzer `mcp` hat kein Löschrecht.

Jeder Entwurf, jede Ausgabe und jeder Kunde trägt `Angelegt von Claude über MCP` in den privaten Notizen. Jeder Schreibzugriff schickt eine ntfy-Meldung, ohne Kundennamen.

## Werkzeuge

Lesen: `verbindung_pruefen`, `kunden_suchen`, `kunde_anzeigen`, `rechnungen_auflisten`, `rechnung_anzeigen`, `angebote_auflisten`, `angebot_anzeigen`, `zahlungen_auflisten`, `ausgaben_auflisten`, `stammdaten_auflisten`, `auswertung`.

Schreiben: `rechnung_entwurf_anlegen`, `rechnung_entwurf_aendern`, `angebot_entwurf_anlegen`, `angebot_entwurf_aendern`, `ausgabe_anlegen`, `kunde_anlegen`.

## Anmeldung

Der Server steht hinter Cloudflare Access mit Managed OAuth. Er prüft das Access-JWT (`Cf-Access-Jwt-Assertion`) ein zweites Mal gegen Team-Domain, AUD und `ALLOWED_EMAILS`. Transport: Streamable HTTP unter `/mcp`, zustandslos. `/health` ist ohne Anmeldung erreichbar.

## Konfiguration

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `INVOICENINJA_URL` | ja | z. B. `http://invoiceninja-web` |
| `INVOICENINJA_API_TOKEN` | ja | Token des Benutzers `mcp` |
| `INVOICENINJA_HOST` | nein | Host-Kopfzeile, z. B. `rechnung.jonas-kuhlmann.de` |
| `CF_ACCESS_TEAM_DOMAIN` | ja | `https://<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | ja | AUD der Access-App |
| `ALLOWED_EMAILS` | ja | durch Komma getrennt |
| `NTFY_TOPIC` | nein | Thema auf ntfy.sh, ohne fällt die Meldung weg |
| `AUTH_MODE` | nein | `cloudflare_access` (Standard) oder `none`, das nur mit `ALLOW_INSECURE_NO_AUTH=1` startet und nur für lokale Tests gedacht ist |

## Entwicklung

```bash
npm ci
npm run typecheck && npm test
docker build -t invoiceninja-mcp:dev .
```

## Lieferkette

`main` baut nach grüner CI ein Image nach `ghcr.io/ilc4pone84/invoiceninja-mcp:main` und signiert es keyless mit cosign. olav rollt nur Images aus, deren Signatur von `.github/workflows/docker-image.yml@refs/heads/main` stammt.

Die API-Aufrufe orientieren sich an [ambaloo/invoiceninja-mcp](https://github.com/ambaloo/invoiceninja-mcp) (MIT), der Code ist neu geschrieben. Filter nach den Quellen von Invoice Ninja (`app/Filters/*`).
