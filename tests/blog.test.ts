// End-to-end tests: spawn the compiled native binary (huskar + sqlc + SQLite) and drive it over HTTP.
//   ./build.sh && bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "../build/blog");
const PASSWORD = "correct horse battery staple";
const dir = mkdtempSync(join(tmpdir(), "blogtest-"));
const dbPath = join(dir, "blog.db");
let port = 0;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let base = "";

async function start(): Promise<void> {
  port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const envFile = join(dir, ".env");
  writeFileSync(envFile, `ADMIN_PASSWORD="${PASSWORD}"\nPORT=${port}\nDB_PATH=${dbPath}\nSITE_TITLE=Test <Blog>\nBASE_URL=http://example.test\nPOSTS_PER_PAGE=3\n`);
  // Clean env: `bun test` auto-loads the project .env into process.env, and real env vars override the file.
  proc = Bun.spawn([BIN, envFile], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + "/healthz")).ok) return; } catch {}
    await Bun.sleep(10);
  }
  proc.kill();
  throw new Error("server did not start: " + (await new Response(proc.stderr as ReadableStream).text()) + (await new Response(proc.stdout as ReadableStream).text()));
}
async function stop(): Promise<void> {
  proc?.kill();
  await proc?.exited;
}

beforeAll(start);
afterAll(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });

const get = (path: string, cookie = "") => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
const post = (path: string, form: Record<string, string>, cookie = "") =>
  fetch(base + path, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form).toString(),
  });

async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await post("/login", { password: PASSWORD });
  expect(r.status).toBe(303);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  const html = await (await get("/admin", cookie)).text();
  const csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
  expect(csrf.length).toBe(64);
  return { cookie, csrf };
}

async function publish(s: { cookie: string; csrf: string }, title: string, body: string, published = true) {
  const form: Record<string, string> = { _csrf: s.csrf, title, body };
  if (published) form.published = "1";
  return post("/admin/new", form, s.cookie);
}

describe("public site", () => {
  test("empty home page, security headers, CSS and health", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("No posts yet");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const css = await get("/style.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await get("/healthz")).status).toBe(200);
  });

  test("site title from config is HTML-escaped", async () => {
    expect(await (await get("/")).text()).toContain("Test &lt;Blog&gt;");
  });

  test("unknown URLs render an HTML 404", async () => {
    const r = await get("/nope/nothing");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect((await get("/post/does-not-exist")).status).toBe(404);
  });
});

describe("authentication", () => {
  test("admin pages require a session", async () => {
    for (const p of ["/admin", "/admin/new", "/admin/posts/1/edit", "/admin/posts/1/delete"]) {
      const r = await get(p);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/login");
    }
    expect((await post("/admin/new", { title: "x", body: "y" })).status).toBe(302);
  });

  test("a forged or malformed cookie is not a session", async () => {
    expect((await get("/admin", "blog_session=" + "a".repeat(64))).status).toBe(302);
    expect((await get("/admin", "blog_session=short")).status).toBe(302);
  });

  test("login sets a hardened cookie; logout destroys the session server-side", async () => {
    const r = await post("/login", { password: PASSWORD });
    expect(r.status).toBe(303);
    const sc = r.headers.get("set-cookie") ?? "";
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    const cookie = sc.split(";")[0];
    expect(cookie.split("=")[1].length).toBe(64);
    const dash = await get("/admin", cookie);
    expect(dash.status).toBe(200);
    const csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(await dash.text())![1];
    // logout with a wrong CSRF token must NOT end the session
    await post("/logout", { _csrf: "bad" }, cookie);
    expect((await get("/admin", cookie)).status).toBe(200);
    expect((await post("/logout", { _csrf: csrf }, cookie)).status).toBe(303);
    expect((await get("/admin", cookie)).status).toBe(302); // the old cookie is dead even if replayed
  });

  test("two logins get different sessions", async () => {
    const a = await login();
    const b = await login();
    expect(a.cookie).not.toBe(b.cookie);
    expect(a.csrf).not.toBe(b.csrf);
  });
});

describe("authoring", () => {
  test("create, read, list, edit, delete a post", async () => {
    const s = await login();
    const created = await publish(s, "Hello, World!", "# Heading\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two");
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/post/hello-world");
    const html = await (await get("/post/hello-world")).text();
    expect(html).toContain("<h1>Hello, World!</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
    expect(await (await get("/")).text()).toContain('href="/post/hello-world"');

    const edit = await get("/admin/posts/1/edit", s.cookie);
    expect(edit.status).toBe(200);
    expect(await edit.text()).toContain("Hello, World!");
    const upd = await post("/admin/posts/1", { _csrf: s.csrf, title: "Hello, Universe!", body: "Updated body", published: "1" }, s.cookie);
    expect(upd.status).toBe(303);
    expect(upd.headers.get("location")).toBe("/post/hello-world"); // slug is stable once published
    expect(await (await get("/post/hello-world")).text()).toContain("Updated body");

    expect((await get("/admin/posts/1/delete", s.cookie)).status).toBe(200); // confirmation page
    expect((await post("/admin/posts/1/delete", { _csrf: s.csrf }, s.cookie)).status).toBe(303);
    expect((await get("/post/hello-world")).status).toBe(404);
  });

  test("slugs are unique and URL-safe", async () => {
    const s = await login();
    const a = await publish(s, "Same Title", "a");
    const b = await publish(s, "Same Title", "b");
    const c = await publish(s, "  ¡Ünïcode & symbols!!  ", "c");
    expect(a.headers.get("location")).toBe("/post/same-title");
    expect(b.headers.get("location")).toBe("/post/same-title-2");
    expect(c.headers.get("location")).toMatch(/^\/post\/[a-z0-9-]+$/);
  });

  test("drafts are hidden from the public and visible to the author", async () => {
    const s = await login();
    const r = await publish(s, "Secret Draft", "not yet", false);
    expect(r.headers.get("location")).toBe("/admin");
    expect((await get("/post/secret-draft")).status).toBe(404);
    expect(await (await get("/")).text()).not.toContain("Secret Draft");
    expect(await (await get("/feed.xml")).text()).not.toContain("Secret Draft");
    expect(await (await get("/?q=secret")).text()).not.toContain("Secret Draft");
    const mine = await get("/post/secret-draft", s.cookie);
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain("Draft");
    expect(mine.headers.get("cache-control")).toBe("no-store");
    expect(await (await get("/admin", s.cookie)).text()).toContain("Secret Draft");
    // publishing it makes it public
    const admin = await (await get("/admin", s.cookie)).text();
    const id = /Secret Draft<\/a><\/td>.*?posts\/(\d+)\/edit/s.exec(admin)?.[1];
    expect(id).toBeDefined();
    await post(`/admin/posts/${id}`, { _csrf: s.csrf, title: "Secret Draft", body: "now public", published: "1" }, s.cookie);
    expect(await (await get("/post/secret-draft")).text()).toContain("now public");
    expect(await (await get("/feed.xml")).text()).toContain("Secret Draft");
  });

  test("validation errors re-render the form with the input preserved", async () => {
    const s = await login();
    const r = await post("/admin/new", { _csrf: s.csrf, title: "", body: "keep me" }, s.cookie);
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("Title is required");
    expect(html).toContain("keep me");
    expect((await post("/admin/new", { _csrf: s.csrf, title: "x".repeat(201), body: "b" }, s.cookie)).status).toBe(400);
    expect((await post("/admin/new", { _csrf: s.csrf, title: "t", body: "   " }, s.cookie)).status).toBe(400);
  });

  test("editing or deleting a post that does not exist is a 404, not a crash", async () => {
    const s = await login();
    expect((await get("/admin/posts/9999/edit", s.cookie)).status).toBe(404);
    expect((await get("/admin/posts/abc/edit", s.cookie)).status).toBe(404);
    expect((await post("/admin/posts/9999", { _csrf: s.csrf, title: "t", body: "b" }, s.cookie)).status).toBe(404);
    expect((await post("/admin/posts/9999/delete", { _csrf: s.csrf }, s.cookie)).status).toBe(303);
  });
});

describe("security", () => {
  test("state-changing requests without a valid CSRF token are refused (403) and change nothing", async () => {
    const s = await login();
    for (const csrf of [undefined, "", "0".repeat(64), "short"]) {
      const form: Record<string, string> = { title: "Evil", body: "x", published: "1" };
      if (csrf !== undefined) form._csrf = csrf;
      expect((await post("/admin/new", form, s.cookie)).status).toBe(403);
    }
    expect((await get("/post/evil")).status).toBe(404);
    expect((await post("/admin/posts/1/delete", {}, s.cookie)).status).toBe(403);
  });

  test("a CSRF token from another session does not work", async () => {
    const a = await login();
    const b = await login();
    expect((await post("/admin/new", { _csrf: a.csrf, title: "X", body: "y" }, b.cookie)).status).toBe(403);
  });

  test("HTML in titles and bodies is escaped everywhere (stored XSS)", async () => {
    const s = await login();
    const evil = '<script>alert(1)</script>';
    await publish(s, `T ${evil} "q" 'a'`, `${evil}\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [ok](https://example.com) **${evil}**\n\n\`\`\`\n${evil}\n\`\`\``);
    const slug = /href="\/post\/(t-script[^"]*)"/.exec(await (await get("/")).text())?.[1];
    expect(slug).toBeDefined();
    const html = await (await get("/post/" + slug)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
    for (const page of ["/", "/feed.xml", "/?q=script"]) {
      const t = await (await get(page)).text();
      expect(t).not.toContain("<script>");
    }
    // the dashboard and the edit form too
    expect(await (await get("/admin", s.cookie)).text()).not.toContain("<script>alert");
  });

  test("SQL metacharacters are inert (titles, search, slugs)", async () => {
    const s = await login();
    await publish(s, "Robert'); DROP TABLE posts;--", "body");
    expect(await (await get("/")).text()).toContain("Robert");
    for (const q of ["'", '"', "a OR b", "NEAR(", "*", "x\" AND \"y", "'; DROP TABLE posts;--"]) {
      expect((await get("/?q=" + encodeURIComponent(q))).status).toBe(200);
    }
    expect((await get("/post/" + encodeURIComponent("' OR 1=1 --"))).status).toBe(404);
    expect(await (await get("/")).text()).toContain("Robert");
  });

  test("oversized bodies are rejected", async () => {
    const s = await login();
    const r = await post("/admin/new", { _csrf: s.csrf, title: "big", body: "x".repeat(400 * 1024) }, s.cookie);
    expect(r.status).toBe(413);
  });
});

describe("reading", () => {
  test("pagination", async () => {
    const s = await login();
    for (let i = 1; i <= 7; i++) await publish(s, `Paged ${i}`, `page body ${i}`);
    const p1 = await (await get("/")).text();
    expect(p1).toContain("Older");
    expect(p1).not.toContain("Newer");
    const last = await (await get("/?page=999")).text(); // clamped
    expect(last).toContain("Newer");
    expect((await get("/?page=-4")).status).toBe(200);
    expect((await get("/?page=abc")).status).toBe(200);
  });

  test("full-text search finds published posts, with prefix matching", async () => {
    const s = await login();
    await publish(s, "Compiling TypeScript natively", "scriptc turns TypeScript into executables");
    await publish(s, "Gardening notes", "tomatoes and basil");
    const hit = await (await get("/?q=typescr")).text();
    expect(hit).toContain("Compiling TypeScript natively");
    expect(hit).not.toContain("Gardening notes");
    expect(await (await get("/?q=basil")).text()).toContain("Gardening notes");
    expect(await (await get("/?q=nothingmatches")).text()).toContain("Nothing found");
  });

  test("search index follows edits and deletes", async () => {
    const s = await login();
    const created = await publish(s, "Mutable zebra", "zebra stripes");
    const slug = created.headers.get("location")!.replace("/post/", "");
    expect(await (await get("/?q=zebra")).text()).toContain("Mutable zebra");
    const id = /\/admin\/posts\/(\d+)\/edit/.exec(await (await get("/post/" + slug, s.cookie)).text())![1];
    await post("/admin/posts/" + id, { _csrf: s.csrf, title: "Mutable giraffe", body: "tall neck", published: "1" }, s.cookie);
    expect(await (await get("/?q=zebra")).text()).toContain("Nothing found");
    expect(await (await get("/?q=giraffe")).text()).toContain("Mutable giraffe");
    await post(`/admin/posts/${id}/delete`, { _csrf: s.csrf }, s.cookie);
    expect(await (await get("/?q=giraffe")).text()).toContain("Nothing found");
  });

  test("RSS feed is valid-looking, absolute and escaped", async () => {
    const s = await login();
    await publish(s, "Feed & <friends>", "hello feed");
    const r = await get("/feed.xml");
    expect(r.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await r.text();
    expect(xml).toStartWith('<?xml version="1.0"');
    expect(xml).toContain("<link>http://example.test/post/feed-friends</link>");
    expect(xml).toContain("Feed &amp; &lt;friends&gt;");
    expect(xml).not.toContain("<friends>");
  });

  test("unicode content round-trips", async () => {
    const s = await login();
    await publish(s, "日本語 ✓ 🎉 émoji", "こんにちは世界 🌏");
    expect(await (await get("/?q=" + encodeURIComponent("こんにちは"))).text()).toContain("日本語");
  });
});

describe("persistence", () => {
  test("posts and sessions survive a restart (real SQLite file, WAL)", async () => {
    const s = await login();
    await publish(s, "Durable post", "still here after restart");
    await stop();
    await start();
    expect(await (await get("/post/durable-post")).text()).toContain("still here after restart");
    expect((await get("/admin", s.cookie)).status).toBe(200); // the session lived in SQLite, too
  });
});

describe("rate limiting", () => {
  test("5 wrong passwords lock the login for this client; correct password is refused while locked", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await post("/login", { password: "nope" + i });
      expect(r.status).toBe(401);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    const locked = await post("/login", { password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(locked.headers.get("set-cookie")).toBeNull();
  });
});

describe("startup", () => {
  test("refuses to start without ADMIN_PASSWORD", async () => {
    const envFile = join(dir, "empty.env");
    writeFileSync(envFile, "PORT=1\n");
    const p = Bun.spawn([BIN, envFile], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
    const code = await p.exited;
    expect(code).not.toBe(0);
  });
});
