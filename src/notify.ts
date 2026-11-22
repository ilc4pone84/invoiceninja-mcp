// Meldung per ntfy bei jedem Schreibzugriff. Ein Fehler beim Senden hält das Werkzeug nicht auf.
import type { Config } from "./config.js";

export type Notifier = (message: string) => Promise<void>;

export function createNotifier(cfg: Config, fetchImpl: typeof fetch = fetch): Notifier {
  return async (message) => {
    log({ event: "write", message });
    if (!cfg.ntfyUrl) return;
    try {
      await fetchImpl(cfg.ntfyUrl, {
        method: "POST",
        headers: { Title: cfg.ntfyTitle, Tags: "memo" },
        body: message,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log({ event: "ntfy_failed", error: (e as Error).message });
    }
  };
}

export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
