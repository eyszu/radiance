// Tiny .env loader (no dependency). Real environment variables win over the file.
import * as fs from "node:fs";

export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.charAt(0) === "#") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2) {
      const first = val.charAt(0);
      const last = val.charAt(val.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) val = val.slice(1, val.length - 1);
    }
    out.set(key, val);
  }
  return out;
}

export class Config {
  port: number;
  dbPath: string;
  password: string;
  siteTitle: string;
  siteDescription: string;
  baseUrl: string;
  secureCookies: boolean;
  postsPerPage: number;
  constructor(
    port: number, dbPath: string, password: string, siteTitle: string, siteDescription: string,
    baseUrl: string, secureCookies: boolean, postsPerPage: number,
  ) {
    this.port = port;
    this.dbPath = dbPath;
    this.password = password;
    this.siteTitle = siteTitle;
    this.siteDescription = siteDescription;
    this.baseUrl = baseUrl;
    this.secureCookies = secureCookies;
    this.postsPerPage = postsPerPage;
  }
}

function pick(file: Map<string, string>, name: string, fallback: string): string {
  const e = process.env[name];
  if (e !== undefined && e.length > 0) return e;
  const f = file.get(name);
  if (f !== undefined && f.length > 0) return f;
  return fallback;
}

/** Loads configuration. Throws if ADMIN_PASSWORD is missing: the blog never starts without a password. */
export function loadConfig(envPath: string): Config {
  const file = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : new Map<string, string>();
  const password = pick(file, "ADMIN_PASSWORD", "");
  if (password.length === 0) {
    throw new Error("ADMIN_PASSWORD is not set. Put it in " + envPath + " (see .env.example).");
  }
  const port = parseInt(pick(file, "PORT", "3000"), 10);
  const perPage = parseInt(pick(file, "POSTS_PER_PAGE", "10"), 10);
  let base = pick(file, "BASE_URL", "http://localhost:" + String(port));
  while (base.length > 0 && base.charAt(base.length - 1) === "/") base = base.slice(0, base.length - 1);
  return new Config(
    port > 0 ? port : 3000,
    pick(file, "DB_PATH", "./blog.db"),
    password,
    pick(file, "SITE_TITLE", "My Blog"),
    pick(file, "SITE_DESCRIPTION", "Thoughts, notes and write-ups."),
    base,
    pick(file, "COOKIE_SECURE", "false") === "true",
    perPage > 0 ? perPage : 10,
  );
}
