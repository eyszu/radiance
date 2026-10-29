// HTML views: plain string templates. Everything user-controlled goes through esc().
import type { Config } from "./env";
import type { Post } from "./store";
import { esc, formatDate, isoDate, markdown, rfc822 } from "./text";

export const CSS = `
:root{--bg:#fbfaf8;--fg:#1c1b1a;--muted:#6b6862;--line:#e5e2dc;--accent:#b4411f;--card:#fff;--code:#f1eee8}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#ecebe8;--muted:#9a968f;--line:#2c2a27;--accent:#ee8a68;--card:#1d1c1a;--code:#242220}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.7 Georgia,"Iowan Old Style","Times New Roman",serif}
a{color:var(--accent)}
.wrap{max-width:42rem;margin:0 auto;padding:0 20px}
header.site{border-bottom:1px solid var(--line);padding:22px 0;margin-bottom:34px}
header.site .wrap{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header.site a.brand{font-size:1.35rem;font-weight:700;text-decoration:none;color:var(--fg)}
header.site nav{margin-left:auto;font:14px/1 system-ui,sans-serif;display:flex;gap:16px;align-items:center}
header.site nav a,header.site nav button{color:var(--muted);text-decoration:none;background:none;border:0;padding:0;cursor:pointer;font:inherit}
header.site nav a:hover,header.site nav button:hover{color:var(--accent)}
main{padding-bottom:60px}
h1,h2,h3{line-height:1.25}
.meta{color:var(--muted);font:14px/1.4 system-ui,sans-serif}
.post-item{padding:0 0 26px;margin-bottom:26px;border-bottom:1px solid var(--line)}
.post-item h2{margin:0 0 4px;font-size:1.45rem}
.post-item h2 a{color:var(--fg);text-decoration:none}
.post-item h2 a:hover{color:var(--accent)}
.post-item p{margin:8px 0 0}
.draft{font:600 11px/1 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;background:var(--code);color:var(--muted);padding:3px 6px;border-radius:4px;margin-left:8px;vertical-align:middle}
article h1{font-size:2.1rem;margin:0 0 6px}
article .content{margin-top:28px}
article img{max-width:100%}
pre{background:var(--code);padding:14px 16px;overflow:auto;border-radius:6px;font-size:.85em;line-height:1.5}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.88em}
pre code{background:none;padding:0}
blockquote{margin:1.2em 0;padding:0 0 0 18px;border-left:3px solid var(--line);color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
form.search{margin:0 0 30px;display:flex;gap:8px}
input,textarea,button.btn,a.btn{font:16px/1.4 system-ui,sans-serif}
input[type=text],input[type=password],input[type=search],textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
textarea{min-height:24rem;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.55;resize:vertical}
label{display:block;font:600 13px/1 system-ui,sans-serif;margin:18px 0 6px;color:var(--muted)}
.btn{display:inline-block;padding:9px 16px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
.btn.secondary{background:none;color:var(--accent)}
.btn.danger{background:none;border-color:#b3261e;color:#b3261e}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:20px}
.check{display:flex;gap:8px;align-items:center;font:15px/1 system-ui,sans-serif;margin-top:18px}
.check input{width:auto}
.err{background:#fdecea;color:#8a1c14;border:1px solid #f3b8b3;padding:10px 14px;border-radius:6px;font:15px/1.4 system-ui,sans-serif;margin:0 0 16px}
@media (prefers-color-scheme:dark){.err{background:#3a1b18;color:#ffb4ab;border-color:#6b2a24}}
table.admin{width:100%;border-collapse:collapse;font:15px/1.4 system-ui,sans-serif}
table.admin td,table.admin th{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
table.admin th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
table.admin form{display:inline}
.row.spread{justify-content:space-between;margin:0 0 14px}.row.spread h1{margin:0}
form.inline{margin:0}
table.admin td.actions{text-align:right;white-space:nowrap}
.pager{display:flex;justify-content:space-between;font:15px/1 system-ui,sans-serif;margin-top:10px}
footer{border-top:1px solid var(--line);padding:22px 0 40px;color:var(--muted);font:14px/1.4 system-ui,sans-serif}
`;

export class Page {
  title: string;
  description: string;
  body: string;
  csrf: string; // non-empty = signed in
  noindex: boolean;
  constructor(title: string, body: string, csrf: string, description: string, noindex: boolean) {
    this.title = title;
    this.body = body;
    this.csrf = csrf;
    this.description = description;
    this.noindex = noindex;
  }
}

export function layout(cfg: Config, p: Page): string {
  const full = p.title.length > 0 ? p.title + " · " + cfg.siteTitle : cfg.siteTitle;
  const desc = p.description.length > 0 ? p.description : cfg.siteDescription;
  const authed = p.csrf.length > 0;
  const nav = authed
    ? '<a href="/admin">Dashboard</a><a href="/admin/new">New post</a>' +
      '<form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="' + esc(p.csrf) + '"><button type="submit">Sign out</button></form>'
    : '<a href="/feed.xml">RSS</a>';
  return (
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(full) + "</title>" +
    '<meta name="description" content="' + esc(desc) + '">' +
    (p.noindex ? '<meta name="robots" content="noindex">' : "") +
    '<link rel="alternate" type="application/rss+xml" title="' + esc(cfg.siteTitle) + '" href="/feed.xml">' +
    '<link rel="stylesheet" href="/style.css"></head><body>' +
    '<header class="site"><div class="wrap"><a class="brand" href="/">' + esc(cfg.siteTitle) + "</a><nav>" + nav + "</nav></div></header>" +
    '<main class="wrap">' + p.body + "</main>" +
    '<footer><div class="wrap">' + esc(cfg.siteTitle) + " · built with huskar + sqlc</div></footer>" +
    "</body></html>"
  );
}

function postItem(p: Post, showDraft: boolean): string {
  const when = p.publishedAt > 0 ? p.publishedAt : p.createdAt;
  return (
    '<div class="post-item"><h2><a href="/post/' + esc(p.slug) + '">' + esc(p.title) + "</a>" +
    (showDraft && !p.published ? '<span class="draft">Draft</span>' : "") + "</h2>" +
    '<div class="meta"><time datetime="' + isoDate(when) + '">' + formatDate(when) + "</time></div>" +
    "<p>" + esc(p.excerpt) + "</p></div>"
  );
}

export function homeBody(posts: Post[], q: string, page: number, pages: number): string {
  let h =
    '<form class="search" method="get" action="/"><input type="search" name="q" placeholder="Search posts" value="' + esc(q) +
    '" aria-label="Search"><button class="btn" type="submit">Search</button></form>';
  if (q.length > 0) h += '<p class="meta">' + String(posts.length) + " result" + (posts.length === 1 ? "" : "s") + " for “" + esc(q) + "”</p>";
  if (posts.length === 0) h += q.length > 0 ? "<p>Nothing found.</p>" : "<p>No posts yet.</p>";
  for (const p of posts) h += postItem(p, false);
  if (q.length === 0 && pages > 1) {
    h += '<div class="pager"><span>' + (page > 1 ? '<a href="/?page=' + String(page - 1) + '">← Newer</a>' : "") + "</span>";
    h += "<span>Page " + String(page) + " of " + String(pages) + "</span>";
    h += "<span>" + (page < pages ? '<a href="/?page=' + String(page + 1) + '">Older →</a>' : "") + "</span></div>";
  }
  return h;
}

export function postBody(p: Post, authed: boolean): string {
  const when = p.publishedAt > 0 ? p.publishedAt : p.createdAt;
  let h =
    "<article><h1>" + esc(p.title) + (p.published ? "" : '<span class="draft">Draft</span>') + "</h1>" +
    '<div class="meta"><time datetime="' + isoDate(when) + '">' + formatDate(when) + "</time>" +
    (p.updatedAt - when > 86400 ? " · updated " + formatDate(p.updatedAt) : "") +
    (authed ? ' · <a href="/admin/posts/' + String(p.id) + '/edit">Edit</a>' : "") + "</div>" +
    '<div class="content">' + markdown(p.body) + "</div></article>";
  return h;
}

export function loginBody(error: string): string {
  return (
    '<h1>Sign in</h1>' + (error.length > 0 ? '<div class="err" role="alert">' + esc(error) + "</div>" : "") +
    '<form method="post" action="/login"><label for="pw">Password</label>' +
    '<input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>' +
    '<div class="row"><button class="btn" type="submit">Sign in</button></div></form>'
  );
}

export function adminBody(posts: Post[]): string {
  let h = '<div class="row spread"><h1>Posts</h1><a class="btn" href="/admin/new">New post</a></div>';
  if (posts.length === 0) return h + "<p>No posts yet. Write your first one.</p>";
  h += '<table class="admin"><thead><tr><th>Title</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>';
  for (const p of posts) {
    h +=
      '<tr><td><a href="/post/' + esc(p.slug) + '">' + esc(p.title) + "</a></td><td>" + (p.published ? "Published" : "Draft") +
      "</td><td>" + formatDate(p.updatedAt) + '</td><td class="actions">' +
      '<a href="/admin/posts/' + String(p.id) + '/edit">Edit</a> &nbsp; ' +
      '<a href="/admin/posts/' + String(p.id) + '/delete">Delete</a></td></tr>';
  }
  return h + "</tbody></table>";
}

export function editorBody(csrf: string, action: string, heading: string, title: string, body: string, published: boolean, error: string): string {
  return (
    "<h1>" + esc(heading) + "</h1>" + (error.length > 0 ? '<div class="err" role="alert">' + esc(error) + "</div>" : "") +
    '<form method="post" action="' + esc(action) + '"><input type="hidden" name="_csrf" value="' + esc(csrf) + '">' +
    '<label for="t">Title</label><input id="t" type="text" name="title" maxlength="200" value="' + esc(title) + '" required>' +
    '<label for="b">Body (Markdown)</label><textarea id="b" name="body">' + esc(body) + "</textarea>" +
    '<label class="check"><input type="checkbox" name="published" value="1"' + (published ? " checked" : "") + "> Published</label>" +
    '<div class="row"><button class="btn" type="submit">Save</button><a class="btn secondary" href="/admin">Cancel</a></div></form>'
  );
}

export function messageBody(heading: string, text: string): string {
  return "<h1>" + esc(heading) + "</h1><p>" + esc(text) + '</p><p><a href="/">← Home</a></p>';
}

export function feedXml(cfg: Config, posts: Post[]): string {
  let items = "";
  for (const p of posts) {
    const url = cfg.baseUrl + "/post/" + p.slug;
    const when = p.publishedAt > 0 ? p.publishedAt : p.createdAt;
    items +=
      "<item><title>" + esc(p.title) + "</title><link>" + esc(url) + '</link><guid isPermaLink="true">' + esc(url) + "</guid>" +
      "<pubDate>" + rfc822(when) + "</pubDate><description>" + esc(p.excerpt) + "</description></item>";
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>' + esc(cfg.siteTitle) + "</title><link>" + esc(cfg.baseUrl) +
    "/</link><description>" + esc(cfg.siteDescription) + "</description>" + items + "</channel></rss>"
  );
}

export function deleteBody(p: Post, csrf: string): string {
  return (
    "<h1>Delete post?</h1><p>This permanently deletes “" + esc(p.title) + "”.</p>" +
    '<form method="post" action="/admin/posts/' + String(p.id) + '/delete"><input type="hidden" name="_csrf" value="' + esc(csrf) + '">' +
    '<div class="row"><button class="btn danger" type="submit">Delete permanently</button><a class="btn secondary" href="/admin">Cancel</a></div></form>'
  );
}
