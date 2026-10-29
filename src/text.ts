// HTML escaping, slugs, dates, and a small *safe* Markdown renderer (escape first, then structure).

export function esc(s: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = "";
    if (c === 38) rep = "&amp;";
    else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    if (rep.length > 0) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

export function slugify(title: string): string {
  let out = "";
  let dash = false;
  const lower = title.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (alnum) {
      if (dash && out.length > 0) out += "-";
      out += lower.charAt(i);
      dash = false;
    } else {
      dash = true;
    }
    if (out.length >= 60) break;
  }
  return out.length > 0 ? out : "post";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return MONTHS[d.getUTCMonth()] + " " + String(d.getUTCDate()) + ", " + String(d.getUTCFullYear());
}

export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export function rfc822(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toUTCString();
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

function safeUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (u.length === 0) return false;
  if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("mailto:")) return true;
  if (u.startsWith("//")) return false;
  return u.charAt(0) === "/" || u.charAt(0) === "#";
}

/** Inline Markdown: `code`, **bold**, *italic*, [text](url). Everything else is escaped text. */
export function inline(s: string): string {
  const out: string[] = [];
  let text = "";
  let i = 0;
  const n = s.length;
  const flush = (): void => {
    if (text.length > 0) {
      out.push(esc(text));
      text = "";
    }
  };
  while (i < n) {
    const ch = s.charAt(i);
    if (ch === "\\" && i + 1 < n) {
      text += s.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push("<code>" + esc(s.slice(i + 1, end)) + "</code>");
        i = end + 1;
        continue;
      }
    } else if (ch === "*" && s.charAt(i + 1) === "*") {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push("<strong>" + inline(s.slice(i + 2, end)) + "</strong>");
        i = end + 2;
        continue;
      }
    } else if (ch === "*") {
      const end = s.indexOf("*", i + 1);
      if (end > i + 1) {
        flush();
        out.push("<em>" + inline(s.slice(i + 1, end)) + "</em>");
        i = end + 1;
        continue;
      }
    } else if (ch === "[") {
      const close = s.indexOf("]", i + 1);
      if (close > i && s.charAt(close + 1) === "(") {
        const paren = s.indexOf(")", close + 2);
        if (paren > close) {
          const url = s.slice(close + 2, paren);
          if (safeUrl(url)) {
            flush();
            out.push('<a href="' + esc(url.trim()) + '" rel="nofollow noopener">' + inline(s.slice(i + 1, close)) + "</a>");
            i = paren + 1;
            continue;
          }
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out.join("");
}

function isBlank(l: string): boolean {
  return l.trim().length === 0;
}

function headingLevel(l: string): number {
  let n = 0;
  while (n < l.length && l.charAt(n) === "#") n++;
  return n >= 1 && n <= 6 && l.charAt(n) === " " ? n : 0;
}

function bulletText(l: string): string | undefined {
  if ((l.startsWith("- ") || l.startsWith("* ")) && l.length > 2) return l.slice(2);
  return undefined;
}

function orderedText(l: string): string | undefined {
  let i = 0;
  while (i < l.length && l.charCodeAt(i) >= 48 && l.charCodeAt(i) <= 57) i++;
  if (i > 0 && i <= 9 && l.charAt(i) === "." && l.charAt(i + 1) === " ") return l.slice(i + 2);
  return undefined;
}

function isRule(l: string): boolean {
  const t = l.trim();
  if (t.length < 3) return false;
  const c = t.charAt(0);
  if (c !== "-" && c !== "*" && c !== "_") return false;
  for (let i = 1; i < t.length; i++) if (t.charAt(i) !== c) return false;
  return true;
}

/** Renders Markdown to HTML. Raw HTML in the source is never passed through. */
export function markdown(src: string): string {
  const lines = src.split("\r\n").join("\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
      i++;
      out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
      continue;
    }
    const lvl = headingLevel(line);
    if (lvl > 0) {
      out.push("<h" + String(lvl) + ">" + inline(line.slice(lvl + 1).trim()) + "</h" + String(lvl) + ">");
      i++;
      continue;
    }
    if (isRule(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) { q.push(lines[i].slice(1).trim()); i++; }
      out.push("<blockquote><p>" + inline(q.join(" ")) + "</p></blockquote>");
      continue;
    }
    if (bulletText(line) !== undefined) {
      out.push("<ul>");
      while (i < lines.length) {
        const t = bulletText(lines[i]);
        if (t === undefined) break;
        out.push("<li>" + inline(t) + "</li>");
        i++;
      }
      out.push("</ul>");
      continue;
    }
    if (orderedText(line) !== undefined) {
      out.push("<ol>");
      while (i < lines.length) {
        const t = orderedText(lines[i]);
        if (t === undefined) break;
        out.push("<li>" + inline(t) + "</li>");
        i++;
      }
      out.push("</ol>");
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length && !isBlank(lines[i]) && !lines[i].startsWith("```") && headingLevel(lines[i]) === 0 && !isRule(lines[i]) &&
      !lines[i].startsWith(">") && bulletText(lines[i]) === undefined && orderedText(lines[i]) === undefined
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push("<p>" + inline(para.join(" ")) + "</p>");
  }
  return out.join("\n");
}

/** Plain-text teaser (~200 chars) for lists, search and RSS. */
export function excerpt(src: string): string {
  let text = "";
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("```") || line.startsWith("#")) continue;
    text += (text.length > 0 ? " " : "") + line;
    if (text.length > 400) break;
  }
  let plain = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c !== "*" && c !== "`" && c !== "_" && c !== ">" && c !== "\\") plain += c;
  }
  if (plain.length <= 200) return plain;
  const cut = plain.slice(0, 200);
  const sp = cut.lastIndexOf(" ");
  return (sp > 120 ? cut.slice(0, sp) : cut) + "…";
}
