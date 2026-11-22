import { createAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { NinjaClient } from "./ninja.js";
import { createNotifier, log } from "./notify.js";
import { createHttpServer, VERSION } from "./server.js";

const cfg = loadConfig();
const ninja = new NinjaClient({ baseUrl: cfg.ninjaUrl, token: cfg.ninjaToken, host: cfg.ninjaHost });
const http = createHttpServer(cfg, ninja, createNotifier(cfg), createAuthenticator(cfg));

http.listen(cfg.port, () => log({ event: "start", version: VERSION, port: cfg.port, auth: cfg.authMode }));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log({ event: "stop", signal: sig });
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
