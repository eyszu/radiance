# radiance — a mini blog using scritpc + huskar + sqlc

A small blogging app that compiles to **one native executable** (`build/blog`, ~2.9 MB). The web layer is
[huskar](lib/huskar), the database is SQLite through [sqlc](lib/sqlc/README.md), and both are vendored under `lib/`, so
there are no npm dependencies at all.

One person writes; everyone reads. There is no user-account module: the author signs in with a single password from `.env`.

## Run it
```bash
cp .env.example .env            # then set ADMIN_PASSWORD to something long
export SCRIPTC=/path/to/scriptc # scriptc >= 0.4.5, plus clang
bash ./build.sh                      # builds build/blog (first build also compiles SQLite, ~35 s)
./build/blog                    # reads ./.env;   ./build/blog /path/to/other.env  to choose a file
```
Open <http://localhost:3000>, go to `/login`, and sign in. Tests: `bun test` (needs the binary built; see below).

## Configuration (`.env`)
| Key | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | **required** | the author's password; the server refuses to start without it |
| `PORT` | 3000 | |
| `DB_PATH` | `./blog.db` | SQLite file (created, WAL mode) |
| `SITE_TITLE`, `SITE_DESCRIPTION` | My Blog … | header, `<title>`, RSS |
| `BASE_URL` | `http://localhost:PORT` | absolute URLs in the RSS feed |
| `COOKIE_SECURE` | false | set `true` behind HTTPS (adds `Secure` to the cookie) |
| `POSTS_PER_PAGE` | 10 | |

Real environment variables override the file. The file parser is ~20 lines (`src/env.ts`): `KEY=value`, `#` comments, optional quotes.
**Keep `.env` out of version control** (it is in `.gitignore`).

## Features
- Home page with pagination, **full-text search** (SQLite FTS5, prefix matching), RSS at `/feed.xml`
- Posts written in Markdown (headings, bold/italic, inline and fenced code, links, lists, quotes, rules)
- Dashboard `/admin`: create, edit, delete (with a confirmation page), draft ↔ published
- Drafts are invisible to the public (page, home, search, RSS) and visible to the author
- Slugs derive from the title, are unique (`-2`, `-3`…) and **freeze once a post has been published**, so links never break
- Dark mode, responsive, no JavaScript at all

## Routes
| | |
|---|---|
| `GET /`, `/?q=…`, `/?page=N` | list / search / paginate |
| `GET /post/:slug` | a post (drafts: author only) |
| `GET /feed.xml`, `/style.css`, `/healthz` | |
| `GET/POST /login`, `POST /logout` | |
| `GET /admin`, `GET/POST /admin/new` | dashboard, new post |
| `GET /admin/posts/:id/edit`, `POST /admin/posts/:id` | edit |
| `GET/POST /admin/posts/:id/delete` | confirm / delete |

## Security model
| Concern | What the code does |
|---|---|
| Auth | one password; compared in constant time (both sides hashed, then `timingSafeEqual`) |
| Sessions | random 256-bit token in an `HttpOnly; SameSite=Lax` cookie; **only its SHA-256 is stored** in SQLite, so a DB leak yields no usable cookies; 7-day expiry; logout deletes the row server-side; a new session replaces any old one on login |
| Brute force | 5 wrong passwords lock that client IP for 60 s (HTTP 429 + `Retry-After`); in-memory, bounded |
| CSRF | every state-changing request needs the session's per-session token in the form (constant-time compare) on top of `SameSite=Lax`; GET never changes state (delete uses a confirm page + POST) |
| XSS | every dynamic value is HTML-escaped; Markdown is "escape first, then structure" — raw HTML in posts is never passed through; links allow only `http(s):`, `mailto:`, `/…`, `#…`; plus a strict CSP (`default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'`) that also blocks inline scripts and styles |
| SQL injection | every query is parameterised through sqlc; FTS input is split into quoted tokens so it can't inject FTS operators |
| Misc | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`; request body capped at 300 KB; admin pages `Cache-Control: no-store`; drafts and 404s are `noindex` |

Not included (by design, for a one-author blog): password hashing (the password lives in `.env`, not in the DB), 2FA, image uploads,
comments. Put a TLS-terminating proxy in front for production and set `COOKIE_SECURE=true`. Throttling is per client IP as seen
by the app; behind a proxy all clients share the proxy's address unless huskar's `trustProxy` is enabled.

## Layout
```
src/main.ts    entry: config → Store → app.listen         src/store.ts   all SQL (schema, posts, FTS, sessions)
src/app.ts     routes, middleware, CSRF, error pages      src/views.ts   HTML templates + CSS
src/auth.ts    tokens, constant-time compare, throttle    src/text.ts    escape, slug, dates, Markdown renderer
src/env.ts     .env parser + Config                       tests/         bun end-to-end tests (drive the real binary)
lib/huskar/    web framework (copied from ../huskar/src)  lib/sqlc/      SQLite driver + vendored SQLite
```

## Database
`user_version`-based migrations run on start. Tables: `posts` (with a `published` CHECK, index on `(published, published_at DESC)`),
`posts_fts` (FTS5, content-linked, kept in sync by triggers) and `sessions`. WAL + `synchronous=NORMAL`.

## Tests
`bun test` spawns the compiled binary on a random port with a temp database and a clean environment (important: Bun auto-loads
`.env` into `process.env`, and real env vars override the file) and drives it over HTTP: 25 tests / 170+ assertions covering
auth, cookie flags, CSRF (missing, wrong, cross-session), throttling, stored XSS and `javascript:` links, SQL-metacharacter
inputs, drafts, slugs, validation, pagination, search (including index updates on edit/delete), RSS escaping, unicode,
body-size limit, 404s, **persistence across restarts** (posts *and* sessions), and refusal to start without a password.

## scriptc notes
The whole app compiles 100% statically (`lib/sqlc/sqlc coverage src/main.ts`; 1638/1638 statements). Markdown and HTML escaping
are hand-written scanners rather than regexes to stay on scriptc's static path.
