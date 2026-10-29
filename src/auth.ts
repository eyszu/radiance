// Single-user authentication: one shared password from .env, server-side sessions in SQLite.
//  - the cookie holds a random 256-bit token; only its SHA-256 is stored, so a DB leak can't be replayed
//  - password and CSRF comparisons are constant-time
//  - failed logins are throttled per client IP
import * as crypto from "node:crypto";
import type { Req } from "../lib/huskar/index";
import type { Store } from "./store";
import { nowSeconds } from "./text";

export const COOKIE = "blog_session";
export const SESSION_TTL = 7 * 24 * 3600;

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Constant-time string equality (hash both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function cookieValue(header: string | undefined, name: string): string {
  if (header === undefined) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

class Attempt {
  fails: number;
  until: number;
  constructor() {
    this.fails = 0;
    this.until = 0;
  }
}

const MAX_FAILS = 5;
const LOCK_SECONDS = 60;

export class Throttle {
  private map: Map<string, Attempt> = new Map();

  /** Seconds the client must still wait, or 0. */
  wait(ip: string): number {
    const a = this.map.get(ip);
    if (a === undefined) return 0;
    const left = a.until - nowSeconds();
    if (left > 0) return left;
    if (a.until > 0) this.map.delete(ip);
    return 0;
  }

  fail(ip: string): void {
    let a = this.map.get(ip);
    if (a === undefined) {
      if (this.map.size > 5000) this.map.clear(); // bound memory under a spray of addresses
      a = new Attempt();
      this.map.set(ip, a);
    }
    a.fails++;
    if (a.fails >= MAX_FAILS) {
      a.until = nowSeconds() + LOCK_SECONDS;
      a.fails = 0;
    }
  }

  success(ip: string): void {
    this.map.delete(ip);
  }
}

/** The CSRF token of the current request's session, or "" when not signed in. */
export function currentCsrf(req: Req, store: Store): string {
  const token = cookieValue(req.get("cookie"), COOKIE);
  if (token.length !== 64) return "";
  const csrf = store.sessionCsrf(sha256(token));
  return csrf === undefined ? "" : csrf;
}
