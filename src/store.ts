// All SQL lives here. Uses sqlc (SQLite statically linked into the executable).
import { Database } from "../lib/sqlc/src/index";
import type { SqlValue } from "../lib/sqlc/src/index";
import { excerpt, nowSeconds, slugify } from "./text";

function num(v: SqlValue): number {
  return typeof v === "number" ? v : 0;
}
function str(v: SqlValue): string {
  return typeof v === "string" ? v : "";
}

export class Post {
  id: number;
  slug: string;
  title: string;
  body: string;
  excerpt: string;
  published: boolean;
  createdAt: number;
  updatedAt: number;
  publishedAt: number;
  constructor(row: SqlValue[]) {
    this.id = num(row[0]);
    this.slug = str(row[1]);
    this.title = str(row[2]);
    this.body = str(row[3]);
    this.excerpt = str(row[4]);
    this.published = num(row[5]) === 1;
    this.createdAt = num(row[6]);
    this.updatedAt = num(row[7]);
    this.publishedAt = num(row[8]);
  }
}

const COLS = "id, slug, title, body, excerpt, published, created_at, updated_at, COALESCE(published_at, 0)";

const SCHEMA_V1 = `
CREATE TABLE posts (
  id           INTEGER PRIMARY KEY,
  slug         TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  excerpt      TEXT    NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX posts_published ON posts (published, published_at DESC);
CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, content='posts', content_rowid='id');
CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO posts_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  csrf       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export class Store {
  db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    const rows = this.db.pragma("user_version");
    const first = rows[0]["user_version"];
    const version = typeof first === "number" ? first : 0;
    if (version < 1) {
      this.db.transaction(() => {
        this.db.exec(SCHEMA_V1);
        this.db.pragma("user_version = 1");
      });
    }
  }

  close(): void {
    this.db.close();
  }

  // --- posts ---------------------------------------------------------------------------------

  private uniqueSlug(title: string, exceptId: number): string {
    const base = slugify(title);
    let candidate = base;
    let n = 2;
    const find = this.db.query("SELECT id FROM posts WHERE slug = ?");
    for (;;) {
      const hit = find.values([candidate]);
      if (hit.length === 0 || num(hit[0][0]) === exceptId) return candidate;
      candidate = base + "-" + String(n);
      n++;
    }
  }

  create(title: string, body: string, published: boolean): Post {
    const now = nowSeconds();
    const slug = this.uniqueSlug(title, 0);
    const res = this.db.query(
      "INSERT INTO posts (slug, title, body, excerpt, published, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run([slug, title, body, excerpt(body), published ? 1 : 0, now, now, published ? now : null]);
    const rid = res.lastInsertRowid;
    return this.byId(typeof rid === "number" ? rid : 0) as Post;
  }

  /** Slugs are stable once a post has been published, so links never break; drafts follow their title. */
  update(id: number, title: string, body: string, published: boolean): Post | undefined {
    const cur = this.byId(id);
    if (cur === undefined) return undefined;
    const now = nowSeconds();
    const slug = cur.published || cur.publishedAt > 0 ? cur.slug : this.uniqueSlug(title, id);
    const publishedAt = published ? (cur.publishedAt > 0 ? cur.publishedAt : now) : (cur.publishedAt > 0 ? cur.publishedAt : null);
    this.db.query(
      "UPDATE posts SET slug = ?, title = ?, body = ?, excerpt = ?, published = ?, updated_at = ?, published_at = ? WHERE id = ?",
    ).run([slug, title, body, excerpt(body), published ? 1 : 0, now, publishedAt, id]);
    return this.byId(id);
  }

  remove(id: number): boolean {
    return this.db.query("DELETE FROM posts WHERE id = ?").run([id]).changes > 0;
  }

  byId(id: number): Post | undefined {
    const rows = this.db.query("SELECT " + COLS + " FROM posts WHERE id = ?").values([id]);
    return rows.length > 0 ? new Post(rows[0]) : undefined;
  }

  bySlug(slug: string): Post | undefined {
    const rows = this.db.query("SELECT " + COLS + " FROM posts WHERE slug = ?").values([slug]);
    return rows.length > 0 ? new Post(rows[0]) : undefined;
  }

  listPublished(limit: number, offset: number): Post[] {
    const rows = this.db.query(
      "SELECT " + COLS + " FROM posts WHERE published = 1 ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?",
    ).values([limit, offset]);
    const out: Post[] = [];
    for (const r of rows) out.push(new Post(r));
    return out;
  }

  countPublished(): number {
    return num(this.db.query("SELECT count(*) FROM posts WHERE published = 1").values()[0][0]);
  }

  listAll(): Post[] {
    const rows = this.db.query("SELECT " + COLS + " FROM posts ORDER BY updated_at DESC, id DESC").values();
    const out: Post[] = [];
    for (const r of rows) out.push(new Post(r));
    return out;
  }

  /** Full-text search over published posts. User input is quoted token-by-token, so it can't inject FTS syntax. */
  search(query: string, limit: number): Post[] {
    const terms: string[] = [];
    for (const raw of query.split(" ")) {
      const t = raw.split('"').join("").trim();
      if (t.length > 0 && terms.length < 8) terms.push('"' + t + '"*');
    }
    if (terms.length === 0) return [];
    const rows = this.db.query(
      "SELECT p.id, p.slug, p.title, p.body, p.excerpt, p.published, p.created_at, p.updated_at, COALESCE(p.published_at, 0) " +
      "FROM posts_fts f JOIN posts p ON p.id = f.rowid WHERE posts_fts MATCH ? AND p.published = 1 ORDER BY rank LIMIT ?",
    ).values([terms.join(" "), limit]);
    const out: Post[] = [];
    for (const r of rows) out.push(new Post(r));
    return out;
  }

  // --- sessions ------------------------------------------------------------------------------

  createSession(tokenHash: string, csrf: string, expiresAt: number): void {
    this.db.query("DELETE FROM sessions WHERE expires_at < ?").run([nowSeconds()]);
    this.db.query("INSERT INTO sessions (token_hash, csrf, expires_at) VALUES (?, ?, ?)").run([tokenHash, csrf, expiresAt]);
  }

  /** Returns the session's CSRF token if the session exists and hasn't expired. */
  sessionCsrf(tokenHash: string): string | undefined {
    const rows = this.db.query("SELECT csrf FROM sessions WHERE token_hash = ? AND expires_at > ?").values([tokenHash, nowSeconds()]);
    return rows.length > 0 ? str(rows[0][0]) : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.query("DELETE FROM sessions WHERE token_hash = ?").run([tokenHash]);
  }
}
