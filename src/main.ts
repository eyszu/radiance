import { loadConfig } from "./env";
import { Store } from "./store";
import { buildApp } from "./app";

const envPath = process.argv[2] ?? "./.env";
const cfg = loadConfig(envPath);
const store = new Store(cfg.dbPath);
const app = buildApp(cfg, store);
app.listen(cfg.port, () => {
  console.log("blog listening on http://localhost:" + String(cfg.port) + "  (db: " + cfg.dbPath + ")");
});
