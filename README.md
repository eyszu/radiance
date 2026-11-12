# Blog

A single-author blog built with [Spectre](vendor/spectre) (a Crystal web framework) and SQLite.
One admin, one password, kept in `.env`. Visitors read; only you can write.

- Public pages: post list with pagination, post pages, RSS feed at `/feed.xml`.
- Admin: log in, write in Markdown, save drafts, publish, edit, delete. Drafts are visible only to you.
- Backup: a **Download backup** button on the dashboard saves the whole database as one file.
- One small binary. Templates and the stylesheet are compiled in, so nothing else has to sit next to it
  except `.env` and the database file.

## Run it

Requires Crystal 1.10+ and the SQLite development library (`sudo apt install libsqlite3-dev` on Ubuntu,
`brew install sqlite` on macOS).

```sh
cp .env.example .env        # then edit .env and set ADMIN_PASSWORD
shards install
shards build --release      # builds bin/blog
./bin/blog
```

Open http://localhost:3000, then go to `/login` (there is an "Admin" link in the footer).
For development you can skip the build step: `crystal run src/main.cr`.

The server refuses to start if `ADMIN_PASSWORD` is missing or still `change-me`.

## Configuration

Set in `.env` (or the real environment, which wins over `.env`):

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | none, required | The one password. Use 12+ characters; a shorter one prints a warning. |
| `BLOG_TITLE` | `My Blog` | Site name. |
| `BLOG_DESCRIPTION` | `Notes and essays.` | Meta description and feed description. |
| `BLOG_AUTHOR` | `Admin` | Shown under each post. |
| `BASE_URL` | `http://localhost:<PORT>` | The public address. Used in the feed and to accept form posts. Set it in production. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` in a container or to listen on all interfaces. |
| `PORT` | `3000` | |
| `DATABASE_PATH` | `data/blog.db` | Created on first run, along with its folder. |
| `SESSION_DAYS` | `14` | How long a login lasts. |
| `POSTS_PER_PAGE` | `10` | |
| `COOKIE_SECURE` | automatic | On when `BASE_URL` starts with `https://`. |
| `ENV_FILE` | `.env` | Path of the file to load. |

`.env` format: `KEY=value`, optional quotes, no inline comments (so a `#` in a password is safe).
Quote a password that has leading or trailing spaces. Keep the file private: `chmod 600 .env`, and never commit it
(`.gitignore` already excludes it).

## Writing posts

The editor takes a small, safe Markdown subset: `# headings` (rendered as `<h2>` and down, because the title is
the page's `<h1>`), paragraphs, `- lists`, `**bold**`, `*italic*`, `` `code` ``, fenced code blocks and
`[links](https://...)`. Raw HTML is shown as text, and links are limited to http, https and mailto.

- A post is a draft until **Published** is ticked. Drafts never appear on the site or in the feed, but you can open one
  while logged in to preview it.
- The URL (`/posts/my-title`) is made from the title when the post is created and never changes, even if you rename it.
- A post is dated when it is first published. Unpublishing and publishing again gives it a new date.
- Limits: 200 characters for the title, 100 KB for the body.

## How login works

- Your password is compared in constant time. After 5 wrong attempts from one address, logins are blocked for
  15 minutes (even with the right password).
- A successful login creates a random session token. The cookie holds the token (`HttpOnly`, `SameSite=Lax`, and
  `Secure` with a `__Host-` prefix over HTTPS). The database stores only its SHA-256, so a leaked database does not
  leak live sessions. Logging out deletes the session on the server.
- Every form that changes data carries a per-session token, and requests whose `Origin` header names another site
  are rejected.
- Responses carry a strict Content-Security-Policy (no scripts at all, styles only from this site), `X-Frame-Options: DENY`
  and `nosniff`. The site uses no JavaScript.
- All text is HTML-escaped on output.

## Deploying

Run the binary behind a reverse proxy that terminates HTTPS (Caddy, nginx, ...), and set
`BASE_URL=https://your.domain`, keep `HOST=127.0.0.1`, and pass the `Host` header through.

Two things to know behind a proxy:

- The login lockout counts failures per client address as the server sees it. Behind a proxy that is the proxy's
  address, so five bad attempts from anyone lock everyone out for 15 minutes. Spectre does not read `X-Forwarded-For`.
- The lockout list lives in memory and resets when the server restarts.

## Backup and restore

**Backup.** Log in, open the dashboard and press **Download backup**. You get one file, for example
`my-blog-2026-11-12-034820.db` (the time is UTC): a complete SQLite database with every post, drafts included.

- It is a consistent snapshot, made with SQLite's `VACUUM INTO`, so it is safe to take while the site is live.
- Login sessions are left out, so the file never contains anything that could log someone in.
- The download is a POST with the form token, and the temporary copy is made in a private folder and deleted as soon as it
  has been sent. The file is not stored on the server.
- The file is not encrypted. It holds your drafts, so keep it somewhere private.

From the command line, without the browser, on the server: `sqlite3 data/blog.db ".backup backup.db"`.
Do not use plain `cp` on a running server, because the database runs in WAL mode.

**Restore.** Stop the server, replace the database file, start it again:

```sh
cp my-blog-2026-11-12-034820.db data/blog.db
rm -f data/blog.db-wal data/blog.db-shm     # leftovers of the old database, if present
./bin/blog
```

You will have to log in again, because sessions are not part of a backup. Your password still comes from `.env`.

## Tests

`crystal spec` runs 33 specs against a temporary database: login and logout, lockout, CSRF and origin checks, drafts,
escaping, Markdown, slugs, feed, pagination, config handling and the backup download.

## Layout

```
src/main.cr            entry point
src/blog/app.cr        routes, handlers, middleware
src/blog/store.cr      SQLite access (posts, sessions)
src/blog/auth.cr       password check, sessions, login lockout
src/blog/markdown.cr   Markdown subset renderer
src/blog/views.cr      ECR view structs and the RSS feed
src/views/*.ecr        templates
public/style.css       stylesheet, compiled into the binary
vendor/spectre         the Spectre framework (0.1.0)
spec/                  specs
```

## Not included

Comments, image uploads, multiple users or password reset (change `ADMIN_PASSWORD` and restart),
tags, search, editing a post's URL, scheduled or automatic backups, and importing a backup from the browser
(restore is the manual steps above).
