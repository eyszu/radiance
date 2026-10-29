import { huskar, urlencoded, HttpError } from "../lib/huskar/index";
import type { App, Req, Res } from "../lib/huskar/index";
import type { Config } from "./env";
import type { Store } from "./store";
import { COOKIE, SESSION_TTL, Throttle, currentCsrf, cookieValue, randomToken, safeEqual, sha256 } from "./auth";
import { CSS, Page, adminBody, deleteBody, editorBody, feedXml, homeBody, layout, loginBody, messageBody, postBody } from "./views";
import { nowSeconds } from "./text";

function field(body: unknown, name: string): string {
  if (body === undefined || body === null || typeof body !== "object") return "";
  const rec = body as Record<string, string>;
  const v = rec[name];
  return v === undefined ? "" : v;
}

function q(req: Req, name: string): string {
  const v = req.query[name];
  return v === undefined ? "" : v;
}

function intParam(req: Req, name: string): number {
  const v = req.params[name];
  if (v === undefined) return -1;
  const n = parseInt(v, 10);
  return n > 0 && String(n) === v ? n : -1;
}

export function buildApp(cfg: Config, store: Store): App {
  const app = huskar({ silent: true });
  const throttle = new Throttle();
  const MAX_TITLE = 200;
  const MAX_BODY = 200000;

  function page(res: Res, status: number, title: string, body: string, csrf: string, noindex: boolean): void {
    res.status(status).type("html").send(layout(cfg, new Page(title, body, csrf, "", noindex)));
  }

  // --- security headers + session lookup + body parsing --------------------------------------
  app.use((req, res, next) => {
    res.set("x-content-type-options", "nosniff");
    res.set("x-frame-options", "DENY");
    res.set("referrer-policy", "same-origin");
    res.set(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    req.locals.set("csrf", currentCsrf(req, store));
    next();
  });
  app.use(urlencoded({ limit: 300 * 1024 }));

  function csrfOf(req: Req): string {
    const v = req.locals.get("csrf");
    return typeof v === "string" ? v : "";
  }

  function requireAuth(req: Req, res: Res, next: (err?: unknown) => void): void {
    if (csrfOf(req).length === 0) {
      res.redirect("/login");
      return;
    }
    res.set("cache-control", "no-store");
    next();
  }

  /** For state-changing admin requests: the form token must match the session's. */
  function csrfOk(req: Req): boolean {
    const want = csrfOf(req);
    return want.length > 0 && safeEqual(field(req.body, "_csrf"), want);
  }

  // --- public ---------------------------------------------------------------------------------
  app.get("/style.css", (req, res) => {
    res.set("cache-control", "public, max-age=3600").type("css").send(CSS);
  });
  app.get("/healthz", (req, res) => { res.text("ok"); });

  app.get("/", (req, res) => {
    const csrf = csrfOf(req);
    const query = q(req, "q").trim().slice(0, 100);
    if (query.length > 0) {
      page(res, 200, "Search", homeBody(store.search(query, 50), query, 1, 1), csrf, true);
      return;
    }
    const total = store.countPublished();
    const pages = Math.max(1, Math.ceil(total / cfg.postsPerPage));
    let pg = parseInt(q(req, "page") === "" ? "1" : q(req, "page"), 10);
    if (!(pg >= 1)) pg = 1;
    if (pg > pages) pg = pages;
    const posts = store.listPublished(cfg.postsPerPage, (pg - 1) * cfg.postsPerPage);
    page(res, 200, "", homeBody(posts, "", pg, pages), csrf, false);
  });

  app.get("/post/:slug", (req, res) => {
    const csrf = csrfOf(req);
    const p = store.bySlug(req.params["slug"]);
    if (p === undefined || (!p.published && csrf.length === 0)) {
      page(res, 404, "Not found", messageBody("Not found", "There is no such post."), csrf, true);
      return;
    }
    const authed = csrf.length > 0;
    res.set("cache-control", p.published && !authed ? "public, max-age=60" : "no-store");
    res.status(200).type("html").send(layout(cfg, new Page(p.title, postBody(p, authed), csrf, p.excerpt, !p.published)));
  });

  app.get("/feed.xml", (req, res) => {
    res.type("application/rss+xml").send(feedXml(cfg, store.listPublished(20, 0)));
  });

  // --- auth -----------------------------------------------------------------------------------
  app.get("/login", (req, res) => {
    if (csrfOf(req).length > 0) { res.redirect("/admin"); return; }
    page(res, 200, "Sign in", loginBody(""), "", true);
  });

  app.post("/login", (req, res) => {
    const ip = req.ip;
    const wait = throttle.wait(ip);
    if (wait > 0) {
      res.set("retry-after", String(wait));
      page(res, 429, "Sign in", loginBody("Too many attempts. Try again in " + String(wait) + " seconds."), "", true);
      return;
    }
    if (!safeEqual(field(req.body, "password"), cfg.password)) {
      throttle.fail(ip);
      page(res, 401, "Sign in", loginBody("Wrong password."), "", true);
      return;
    }
    throttle.success(ip);
    // Drop any session cookie the client already had, then start a fresh one (prevents fixation).
    const old = cookieValue(req.get("cookie"), COOKIE);
    if (old.length > 0) store.deleteSession(sha256(old));
    const token = randomToken();
    store.createSession(sha256(token), randomToken(), nowSeconds() + SESSION_TTL);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL, secure: cfg.secureCookies });
    res.redirect(303, "/admin");
  });

  app.post("/logout", (req, res) => {
    if (csrfOk(req)) {
      store.deleteSession(sha256(cookieValue(req.get("cookie"), COOKIE)));
    }
    res.clearCookie(COOKIE);
    res.redirect(303, "/");
  });

  // --- admin ----------------------------------------------------------------------------------
  app.useAt("/admin", requireAuth);

  app.get("/admin", (req, res) => {
    const csrf = csrfOf(req);
    page(res, 200, "Dashboard", adminBody(store.listAll()), csrf, true);
  });

  app.get("/admin/new", (req, res) => {
    const csrf = csrfOf(req);
    page(res, 200, "New post", editorBody(csrf, "/admin/new", "New post", "", "", true, ""), csrf, true);
  });

  function validate(title: string, body: string): string {
    if (title.trim().length === 0) return "Title is required.";
    if (title.length > MAX_TITLE) return "Title is too long (max " + String(MAX_TITLE) + " characters).";
    if (body.trim().length === 0) return "Body is required.";
    if (body.length > MAX_BODY) return "Body is too long.";
    return "";
  }

  app.post("/admin/new", (req, res) => {
    const csrf = csrfOf(req);
    if (!csrfOk(req)) throw new HttpError(403, "Invalid CSRF token");
    const title = field(req.body, "title").trim();
    const body = field(req.body, "body");
    const published = field(req.body, "published") === "1";
    const err = validate(title, body);
    if (err.length > 0) {
      page(res, 400, "New post", editorBody(csrf, "/admin/new", "New post", title, body, published, err), csrf, true);
      return;
    }
    const post = store.create(title, body, published);
    res.redirect(303, published ? "/post/" + post.slug : "/admin");
  });

  app.get("/admin/posts/:id/edit", (req, res) => {
    const csrf = csrfOf(req);
    const p = store.byId(intParam(req, "id"));
    if (p === undefined) { page(res, 404, "Not found", messageBody("Not found", "There is no such post."), csrf, true); return; }
    page(res, 200, "Edit post", editorBody(csrf, "/admin/posts/" + String(p.id), "Edit post", p.title, p.body, p.published, ""), csrf, true);
  });

  app.post("/admin/posts/:id", (req, res) => {
    const csrf = csrfOf(req);
    if (!csrfOk(req)) throw new HttpError(403, "Invalid CSRF token");
    const id = intParam(req, "id");
    const title = field(req.body, "title").trim();
    const body = field(req.body, "body");
    const published = field(req.body, "published") === "1";
    const err = validate(title, body);
    if (err.length > 0) {
      page(res, 400, "Edit post", editorBody(csrf, "/admin/posts/" + String(id), "Edit post", title, body, published, err), csrf, true);
      return;
    }
    const post = store.update(id, title, body, published);
    if (post === undefined) { page(res, 404, "Not found", messageBody("Not found", "There is no such post."), csrf, true); return; }
    res.redirect(303, published ? "/post/" + post.slug : "/admin");
  });

  app.get("/admin/posts/:id/delete", (req, res) => {
    const csrf = csrfOf(req);
    const p = store.byId(intParam(req, "id"));
    if (p === undefined) { page(res, 404, "Not found", messageBody("Not found", "There is no such post."), csrf, true); return; }
    page(res, 200, "Delete post", deleteBody(p, csrf), csrf, true);
  });

  app.post("/admin/posts/:id/delete", (req, res) => {
    if (!csrfOk(req)) throw new HttpError(403, "Invalid CSRF token");
    store.remove(intParam(req, "id"));
    res.redirect(303, "/admin");
  });

  // --- fallbacks ------------------------------------------------------------------------------
  app.use((req, res, next) => {
    page(res, 404, "Not found", messageBody("Not found", "There is nothing at this address."), csrfOf(req), true);
  });

  app.onError((err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error("error:", err instanceof Error ? err.message : "unknown");
    const msg = status === 403 ? "Your session or form token is invalid. Go back, reload the page and try again." :
      status === 413 ? "That request is too large." : status >= 500 ? "Something went wrong on our side." : "Bad request.";
    page(res, status, "Error", messageBody(String(status), msg), csrfOf(req), true);
  });

  return app;
}
