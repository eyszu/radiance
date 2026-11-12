require "./spec_helper"

describe Blog::Markdown do
  it "renders headings, paragraphs, lists and inline styles" do
    html = Blog::Markdown.render("# Title\n\nHello **bold** and *it* and `code`.\n\n- a\n- b\n")
    html.should contain "<h2>Title</h2>"
    html.should contain "<p>Hello <strong>bold</strong> and <em>it</em> and <code>code</code>.</p>"
    html.should contain "<li>a</li>"
  end

  it "lets emphasis wrap code spans and leaves code spans alone" do
    Blog::Markdown.inline("A **single `cp`** works").should eq "A <strong>single <code>cp</code></strong> works"
    Blog::Markdown.inline("`*not em*` and `**not bold**`").should eq "<code>*not em*</code> and <code>**not bold**</code>"
    Blog::Markdown.inline("a lone ` backtick").should eq "a lone ` backtick"
    Blog::Markdown.inline("nul\0byte `x`").should eq "nulbyte <code>x</code>"
  end

  it "escapes HTML and never produces script tags" do
    html = Blog::Markdown.render("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>")
    html.should_not contain "<script"
    html.should_not contain "<img"
    html.should contain "&lt;script&gt;"
  end

  it "only links http, https and mailto" do
    Blog::Markdown.inline("[ok](https://a.example/x?y=1&z=2)").should contain %(href="https://a.example/x?y=1&amp;z=2")
    Blog::Markdown.inline("[bad](javascript:alert(1))").should_not contain "<a "
    Blog::Markdown.inline("[bad](data:text/html;base64,AAAA)").should_not contain "<a "
  end

  it "cannot break out of an href with quotes" do
    html = Blog::Markdown.inline(%q{[x](https://a.example/"onmouseover="alert(1)})
    html.should_not contain %(onmouseover=")
  end

  it "keeps fenced code literal" do
    Blog::Markdown.render("```\n<b>**not bold**</b>\n```").should eq "<pre><code>&lt;b&gt;**not bold**&lt;/b&gt;</code></pre>\n"
  end

  it "builds plain excerpts" do
    Blog::Markdown.excerpt("# Hi\n\nSee [the docs](https://x.example) for **more**.").should eq "Hi"
    Blog::Markdown.excerpt("See [the docs](https://x.example) for **more**.").should eq "See the docs for more."
    Blog::Markdown.excerpt("a" * 300, 50).size.should eq 51
  end
end

describe Blog::Store do
  it "makes unique, stable slugs" do
    with_blog do |_app, store|
      store.create("Hello World!", "x", true).slug.should eq "hello-world"
      second = store.create("Hello World!", "x", true)
      second.slug.should eq "hello-world-2"
      store.update(second.id, "Totally different", "x", true).not_nil!.slug.should eq "hello-world-2"
      store.create("???", "x", false).slug.should eq "post"
    end
  end

  it "dates a post when first published and keeps the date on later edits" do
    with_blog do |_app, store|
      post = store.create("Draft", "x", false)
      post.published?.should be_false
      live = store.update(post.id, "Draft", "x", true).not_nil!
      live.published?.should be_true
      store.update(post.id, "Draft v2", "y", true).not_nil!.published_at.should eq live.published_at
      store.update(post.id, "Draft v2", "y", false).not_nil!.published?.should be_false
    end
  end

  it "only returns published posts in public queries" do
    with_blog do |_app, store|
      store.create("Live", "x", true)
      store.create("Hidden", "x", false)
      store.count_published.should eq 1
      store.published(10, 0).map(&.title).should eq ["Live"]
      store.all_posts.size.should eq 2
    end
  end
end

describe Blog::Env do
  it "parses .env files without overriding real variables" do
    path = File.join(Dir.tempdir, "env_spec_#{Random::Secure.hex(4)}")
    File.write(path, <<-ENV)
      # comment
      SPEC_PLAIN=value
      export SPEC_EXPORT = spaced
      SPEC_QUOTED="has # hash and spaces"
      SPEC_SINGLE='single'
      SPEC_PRESET=from_file
      ENV
    ENV["SPEC_PRESET"] = "from_real_env"
    Blog::Env.load(path)
    ENV["SPEC_PLAIN"].should eq "value"
    ENV["SPEC_EXPORT"].should eq "spaced"
    ENV["SPEC_QUOTED"].should eq "has # hash and spaces"
    ENV["SPEC_SINGLE"].should eq "single"
    ENV["SPEC_PRESET"].should eq "from_real_env"
  ensure
    File.delete(path) if path
  end

  it "refuses to start without a real password" do
    ENV.delete("ADMIN_PASSWORD")
    expect_raises(Blog::ConfigError, /not set/) { Blog::Config.from_env }
    ENV["ADMIN_PASSWORD"] = "change-me"
    expect_raises(Blog::ConfigError, /placeholder/) { Blog::Config.from_env }
    ENV["ADMIN_PASSWORD"] = "something real"
    Blog::Config.from_env.password.should eq "something real"
    ENV.delete("ADMIN_PASSWORD")
  end
end

describe Blog::Throttle do
  it "blocks after the limit and clears on success" do
    t = Blog::Throttle.new(max: 2, window: 1.minute)
    t.blocked?("a").should be_false
    t.record("a")
    t.record("a")
    t.blocked?("a").should be_true
    t.blocked?("b").should be_false
    t.clear("a")
    t.blocked?("a").should be_false
  end
end

describe "public site" do
  it "shows posts, hides drafts, and paginates" do
    with_blog do |app, store|
      store.create("First", "one", true)
      store.create("Second", "two", true)
      store.create("Third", "three", true)
      store.create("Secret", "draft", false)

      home = app.request("GET", "/")
      home.status_code.should eq 200
      home.body.should contain "Third"
      home.body.should_not contain "Secret"
      home.body.should contain "Older"
      app.request("GET", "/?page=2").body.should contain "First"
      app.request("GET", "/posts/secret").status_code.should eq 404
      app.request("GET", "/posts/first").body.should contain "<h1>First</h1>"
      app.request("GET", "/posts/missing").status_code.should eq 404
    end
  end

  it "escapes titles and bodies" do
    with_blog do |app, store|
      store.create(%(<script>alert("t")</script>), "<img src=x onerror=alert(1)>", true)
      body = app.request("GET", "/posts/script-alert-t-script").body
      body.should_not contain "<script>alert"
      body.should_not contain "<img"
      app.request("GET", "/").body.should_not contain "<script>alert"
    end
  end

  it "serves an RSS feed of published posts only" do
    with_blog do |app, store|
      store.create("Live", "x", true)
      store.create("Hidden", "x", false)
      feed = app.request("GET", "/feed.xml")
      feed.headers["Content-Type"].should start_with "application/rss+xml"
      feed.body.should contain "<title>Live</title>"
      feed.body.should_not contain "Hidden"
    end
  end

  it "sends security headers and serves the stylesheet" do
    with_blog do |app, _store|
      r = app.request("GET", "/")
      r.headers["Content-Security-Policy"].should contain "default-src 'none'"
      r.headers["X-Frame-Options"].should eq "DENY"
      css = app.request("GET", "/static/style.css")
      css.headers["Content-Type"].should start_with "text/css"
      css.body.should contain "--accent"
    end
  end

  it "shows a styled 404" do
    with_blog do |app, _store|
      r = app.request("GET", "/nope")
      r.status_code.should eq 404
      r.body.should contain "That page does not exist."
    end
  end
end

describe "authentication" do
  it "sends visitors to the login page for every admin path" do
    with_blog do |app, _store|
      ["/admin", "/admin/new", "/admin/posts/1/edit", "/admin/anything"].each do |path|
        r = app.request("GET", path)
        r.status_code.should eq 303
        r.headers["Location"].should eq "/login"
      end
      app.request("POST", "/admin/posts", form(title: "x", body: "y")).status_code.should eq 303
    end
  end

  it "rejects a wrong password and accepts the right one" do
    with_blog do |app, _store|
      app.request("POST", "/login", "password=wrong").status_code.should eq 401
      res = app.request("POST", "/login", form(password: PASSWORD))
      res.status_code.should eq 303
      cookie = res.headers["Set-Cookie"]
      cookie.should contain "HttpOnly"
      cookie.should contain "SameSite=Lax"
      cookie.should_not contain "Secure"
    end
  end

  it "never stores the session token itself" do
    with_blog do |app, store|
      cookie, _ = login(app)
      token = cookie.split('=').last
      store.db.scalar("SELECT COUNT(*) FROM sessions WHERE id = ?", token).as(Int64).should eq 0
      store.db.scalar("SELECT COUNT(*) FROM sessions").as(Int64).should eq 1
    end
  end

  it "ends the session server-side on logout" do
    with_blog do |app, _store|
      cookie, csrf = login(app)
      headers = HTTP::Headers{"Cookie" => cookie}
      app.request("GET", "/admin", headers: headers).status_code.should eq 200
      app.request("POST", "/logout", form(csrf: "wrong"), headers).status_code.should eq 403
      app.request("POST", "/logout", form(csrf: csrf), headers).status_code.should eq 303
      app.request("GET", "/admin", headers: headers).status_code.should eq 303
    end
  end

  it "locks out after repeated failures, even for the right password" do
    with_blog do |app, _store|
      5.times { app.request("POST", "/login", "password=bad").status_code.should eq 401 }
      app.request("POST", "/login", "password=bad").status_code.should eq 429
      app.request("POST", "/login", form(password: PASSWORD)).status_code.should eq 429
    end
  end

  it "does not cache pages shown to a logged-in admin" do
    with_blog do |app, _store|
      cookie, _ = login(app)
      r = app.request("GET", "/", headers: HTTP::Headers{"Cookie" => cookie})
      r.headers["Cache-Control"].should contain "no-store"
      r.body.should contain "Log out"
      app.request("GET", "/").body.should_not contain "Log out"
    end
  end
end

describe "admin" do
  it "creates, edits and deletes posts" do
    with_blog do |app, store|
      cookie, csrf = login(app)
      h = HTTP::Headers{"Cookie" => cookie}

      created = app.request("POST", "/admin/posts", form(csrf: csrf, title: "My Post", body: "Hello\r\nthere", publish: "1"), h)
      created.status_code.should eq 303
      created.headers["Location"].should eq "/admin?notice=created"
      post = store.find_by_slug("my-post").not_nil!
      post.published?.should be_true
      post.body.should eq "Hello\nthere"

      app.request("GET", "/admin", headers: h).body.should contain "My Post"
      app.request("GET", "/admin/posts/#{post.id}/edit", headers: h).body.should contain "Hello"

      app.request("POST", "/admin/posts/#{post.id}", form(csrf: csrf, title: "Renamed", body: "Changed"), h).status_code.should eq 303
      store.find(post.id).not_nil!.title.should eq "Renamed"
      store.find(post.id).not_nil!.published?.should be_false # box left unchecked

      app.request("POST", "/admin/posts/#{post.id}/delete", form(csrf: csrf), h).status_code.should eq 303
      store.find(post.id).should be_nil
      app.request("GET", "/admin/posts/#{post.id}/edit", headers: h).status_code.should eq 404
    end
  end

  it "lets the admin preview a draft" do
    with_blog do |app, store|
      cookie, _ = login(app)
      store.create("Draft", "wip", false)
      r = app.request("GET", "/posts/draft", headers: HTTP::Headers{"Cookie" => cookie})
      r.status_code.should eq 200
      r.body.should contain "Draft preview"
    end
  end

  it "requires a valid CSRF token on every change" do
    with_blog do |app, store|
      cookie, csrf = login(app)
      h = HTTP::Headers{"Cookie" => cookie}
      post = store.create("Keep me", "x", true)
      app.request("POST", "/admin/posts", form(title: "t", body: "b"), h).status_code.should eq 403
      app.request("POST", "/admin/posts", form(csrf: "nope", title: "t", body: "b"), h).status_code.should eq 403
      app.request("POST", "/admin/posts/#{post.id}", form(title: "hacked", body: "b"), h).status_code.should eq 403
      app.request("POST", "/admin/posts/#{post.id}/delete", "", h).status_code.should eq 403
      store.find(post.id).not_nil!.title.should eq "Keep me"
      store.all_posts.size.should eq 1
    end
  end

  it "blocks cross-origin form posts" do
    with_blog do |app, _store|
      evil = HTTP::Headers{"Origin" => "https://evil.example"}
      app.request("POST", "/login", form(password: PASSWORD), evil).status_code.should eq 403
      same = HTTP::Headers{"Origin" => "http://localhost:3000"}
      app.request("POST", "/login", form(password: PASSWORD), same).status_code.should eq 303
    end
  end

  it "validates input and keeps what was typed" do
    with_blog do |app, store|
      cookie, csrf = login(app)
      h = HTTP::Headers{"Cookie" => cookie}
      r = app.request("POST", "/admin/posts", form(csrf: csrf, title: "", body: "Keep this text"), h)
      r.status_code.should eq 422
      r.body.should contain "Title is required."
      r.body.should contain "Keep this text"
      app.request("POST", "/admin/posts", form(csrf: csrf, title: "t", body: "  "), h).body.should contain "Body is required."
      app.request("POST", "/admin/posts", form(csrf: csrf, title: "x" * 201, body: "b"), h).status_code.should eq 422
      store.all_posts.should be_empty
    end
  end
end

describe "backup download" do
  it "is only available to the logged-in admin, with a valid form token" do
    with_blog do |app, _store|
      app.request("POST", "/admin/backup", "").status_code.should eq 303 # redirected to login
      cookie, csrf = login(app)
      h = HTTP::Headers{"Cookie" => cookie}
      app.request("POST", "/admin/backup", "", h).status_code.should eq 403
      app.request("POST", "/admin/backup", form(csrf: "wrong"), h).status_code.should eq 403
      app.request("GET", "/admin/backup", headers: h).status_code.should eq 405
      app.request("POST", "/admin/backup", form(csrf: csrf), HTTP::Headers{"Cookie" => cookie, "Origin" => "https://evil.example"}).status_code.should eq 403
    end
  end

  it "offers the button on the dashboard" do
    with_blog do |app, _store|
      cookie, _ = login(app)
      page = app.request("GET", "/admin", headers: HTTP::Headers{"Cookie" => cookie}).body
      page.should contain %(action="/admin/backup")
      page.should contain "Download backup"
    end
  end

  it "downloads a complete SQLite file with drafts, without sessions" do
    with_blog do |app, store|
      store.create("Published one", "body one", true)
      store.create("A private draft", "draft text", false)
      cookie, csrf = login(app)
      h = HTTP::Headers{"Cookie" => cookie}
      store.db.scalar("SELECT COUNT(*) FROM sessions").as(Int64).should be > 0

      res = app.request("POST", "/admin/backup", form(csrf: csrf), h)
      res.status_code.should eq 200
      res.headers["Content-Type"].should eq "application/vnd.sqlite3"
      res.headers["Content-Disposition"].should match /\Aattachment; filename="spec-blog-\d{4}-\d{2}-\d{2}-\d{6}\.db"\z/
      res.headers["Cache-Control"].should contain "no-store"
      bytes = res.body.to_slice
      res.headers["Content-Length"].to_i.should eq bytes.size
      String.new(bytes[0, 15]).should eq "SQLite format 3"

      copy = File.join(Dir.tempdir, "backup_check_#{Random::Secure.hex(6)}.db")
      File.write(copy, bytes)
      begin
        DB.open("sqlite3://#{copy}") do |db|
          db.query_all("SELECT title FROM posts ORDER BY id", as: String).should eq ["Published one", "A private draft"]
          db.scalar("SELECT COUNT(*) FROM sessions").as(Int64).should eq 0
          db.scalar("PRAGMA integrity_check").as(String).should eq "ok"
        end
        File.read(copy).should_not contain cookie.split('=').last # no raw token anywhere
      ensure
        File.delete(copy)
      end

      # the live database is untouched, and the admin is still logged in
      store.db.scalar("SELECT COUNT(*) FROM sessions").as(Int64).should be > 0
      app.request("GET", "/admin", headers: h).status_code.should eq 200
    end
  end

  it "leaves no temporary files behind" do
    with_blog do |app, _store|
      cookie, csrf = login(app)
      before = Dir.glob(File.join(Dir.tempdir, "blog-backup-*")).size
      2.times { app.request("POST", "/admin/backup", form(csrf: csrf), HTTP::Headers{"Cookie" => cookie}).status_code.should eq 200 }
      Dir.glob(File.join(Dir.tempdir, "blog-backup-*")).size.should eq before
    end
  end
end
