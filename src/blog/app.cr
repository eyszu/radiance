require "spectre"
require "uri"
require "file_utils"

module Blog
  # The stylesheet is read at compile time and served from memory, so the
  # binary needs no files next to it.
  STYLE_CSS   = {{ read_file("#{__DIR__}/../../public/style.css") }}
  CSS_VERSION = Digest::SHA256.hexdigest(STYLE_CSS)[0, 10]

  NOTICES = {
    "created" => "Post created.",
    "saved"   => "Post saved.",
    "deleted" => "Post deleted.",
  }

  # Adds browser hardening headers to every response. The CSP allows only
  # this site's own stylesheet: no scripts, no inline styles, no framing.
  def self.security_headers : Spectre::Layer
    Spectre.layer do |req, res, nxt|
      res.header("X-Content-Type-Options", "nosniff")
      res.header("X-Frame-Options", "DENY")
      res.header("Referrer-Policy", "same-origin")
      res.header("Content-Security-Policy",
        "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
      nxt.call
    end
  end

  # Rejects state-changing requests whose Origin header names another site.
  def self.same_origin(config : Config) : Spectre::Layer
    allowed = origin_of(config.base_url)
    Spectre.layer do |req, res, nxt|
      unless req.method == "GET" || req.method == "HEAD" || req.method == "OPTIONS"
        if origin = req.header("Origin")
          unless origin == allowed || authority_of(origin) == req.header("Host")
            Spectre.halt(403, "Cross-origin request blocked.")
          end
        end
      end
      nxt.call
    end
  end

  def self.authority_of(url : String) : String?
    uri = URI.parse(url)
    host = uri.host
    return nil unless host
    uri.port ? "#{host}:#{uri.port}" : host
  end

  def self.origin_of(url : String) : String
    uri = URI.parse(url)
    "#{uri.scheme}://#{authority_of(url)}"
  end

  # Looks up the session cookie on every request. It never blocks anyone;
  # `require_admin` does that.
  def self.load_session(auth : Auth) : Spectre::Layer
    Spectre.layer do |req, res, nxt|
      if token = req.cookies[auth.cookie_name]?.try(&.value)
        if session = auth.session_for(token)
          req.session = session
          res.header("Cache-Control", "private, no-store")
        end
      end
      nxt.call
    end
  end

  def self.require_admin : Spectre::Layer
    Spectre.layer do |req, res, nxt|
      if req.session
        nxt.call
      else
        res.redirect("/login", 303)
      end
    end
  end

  class Site
    def initialize(@config : Config, @store : Store, @auth : Auth, @throttle : Throttle)
    end

    # ---- public pages

    def index(req : Spectre::Request, res : Spectre::Response) : Nil
      page = (req.query["page"]?.try(&.to_i?) || 1).clamp(1, 100_000)
      per = @config.per_page
      posts = @store.published(per, (page - 1) * per)
      has_next = page * per < @store.count_published
      render_page(req, res, Views::Index.new(posts, page, has_next).to_s,
        title: page > 1 ? "Page #{page}" : "")
    end

    def show(req : Spectre::Request, res : Spectre::Response) : Nil
      post = @store.find_by_slug(req.params["slug"])
      if post.nil? || (!post.published? && req.session.nil?)
        render_error(req, res, 404, "That page does not exist.")
        return
      end
      html = Views::PostPage.new(post, @config.author, !req.session.nil?).to_s
      render_page(req, res, html, title: post.title, description: Markdown.excerpt(post.body, 160))
    end

    def feed(req : Spectre::Request, res : Spectre::Response) : Nil
      res.type("application/rss+xml; charset=utf-8")
      res.send(Feed.render(@config, @store.published(20, 0)))
    end

    # ---- login and logout

    def login_form(req : Spectre::Request, res : Spectre::Response) : Nil
      if req.session
        res.redirect("/admin", 303)
      else
        res.header("Cache-Control", "no-store")
        render_page(req, res, Views::Login.new(nil).to_s, title: "Log in")
      end
    end

    def login(req : Spectre::Request, res : Spectre::Response) : Nil
      key = req.ip || "unknown"
      res.header("Cache-Control", "no-store")
      if @throttle.blocked?(key)
        res.header("Retry-After", "900")
        render_page(req, res, Views::Login.new("Too many failed attempts. Try again in 15 minutes.").to_s,
          title: "Log in", status: 429)
      elsif @auth.password_ok?(req.form["password"]? || "")
        @throttle.clear(key)
        token = @auth.start_session
        res.cookie(@auth.cookie_name, token, max_age: @auth.max_age, http_only: true,
          secure: @config.cookie_secure, samesite: HTTP::Cookie::SameSite::Lax)
        res.redirect("/admin", 303)
      else
        @throttle.record(key)
        render_page(req, res, Views::Login.new("Wrong password.").to_s, title: "Log in", status: 401)
      end
    end

    def logout(req : Spectre::Request, res : Spectre::Response) : Nil
      if session = req.session
        check_csrf!(req, session)
        if token = req.cookies[@auth.cookie_name]?.try(&.value)
          @auth.end_session(token)
        end
      end
      res.cookie(@auth.cookie_name, "", max_age: 0.seconds, http_only: true,
        secure: @config.cookie_secure, samesite: HTTP::Cookie::SameSite::Lax)
      res.redirect("/", 303)
    end

    # ---- admin

    def admin_index(req : Spectre::Request, res : Spectre::Response) : Nil
      notice = req.query["notice"]?.try { |key| NOTICES[key]? }
      render_page(req, res, Views::Admin.new(@store.all_posts, notice, req.session.not_nil!.csrf).to_s, title: "Dashboard")
    end

    def admin_new(req : Spectre::Request, res : Spectre::Response) : Nil
      render_form(req, res, nil, "", "", false, nil)
    end

    def admin_create(req : Spectre::Request, res : Spectre::Response) : Nil
      form = req.form
      check_csrf!(req, req.session.not_nil!)
      title, body, publish = read_post(form)
      if error = validate(title, body)
        render_form(req, res, nil, title, body, publish, error, 422)
      else
        @store.create(title, body, publish)
        res.redirect("/admin?notice=created", 303)
      end
    end

    def admin_edit(req : Spectre::Request, res : Spectre::Response) : Nil
      post = find_post(req)
      render_form(req, res, post, post.title, post.body, post.published?, nil)
    end

    def admin_update(req : Spectre::Request, res : Spectre::Response) : Nil
      post = find_post(req)
      form = req.form
      check_csrf!(req, req.session.not_nil!)
      title, body, publish = read_post(form)
      if error = validate(title, body)
        render_form(req, res, post, title, body, publish, error, 422)
      else
        @store.update(post.id, title, body, publish)
        res.redirect("/admin?notice=saved", 303)
      end
    end

    def admin_delete(req : Spectre::Request, res : Spectre::Response) : Nil
      post = find_post(req)
      req.form # parse before the CSRF check so a bad token never reaches the database
      check_csrf!(req, req.session.not_nil!)
      @store.delete(post.id)
      res.redirect("/admin?notice=deleted", 303)
    end

    # Streams a snapshot of the database as a file download. It is a POST with
    # the form token, so a link or image on another site cannot trigger it.
    # The copy is made in a private (0700) temporary folder that is always removed.
    def admin_backup(req : Spectre::Request, res : Spectre::Response) : Nil
      req.form
      check_csrf!(req, req.session.not_nil!)
      dir = File.join(Dir.tempdir, "blog-backup-#{Random::Secure.hex(8)}")
      Dir.mkdir(dir, 0o700)
      begin
        path = File.join(dir, "backup.db")
        @store.backup_to(path)
        name = "#{Store.slugify(@config.title)}-#{Time.utc.to_s("%Y-%m-%d-%H%M%S")}.db"
        res.header("Content-Disposition", %(attachment; filename="#{name}"))
        res.header("Cache-Control", "no-store")
        File.open(path) { |file| res.send_io(file, file.size, "application/vnd.sqlite3") }
      ensure
        FileUtils.rm_rf(dir)
      end
    end

    # ---- shared

    def render_error(req : Spectre::Request, res : Spectre::Response, status : Int32, message : String) : Nil
      render_page(req, res, Views::ErrorPage.new(status, message).to_s, title: status.to_s, status: status)
    end

    private def render_page(req : Spectre::Request, res : Spectre::Response, content : String,
                            title : String = "", description : String? = nil, status : Int32 = 200) : Nil
      session = req.session
      html = Views::Layout.new(@config, title, description || @config.description, content,
        !session.nil?, session.try(&.csrf) || "", CSS_VERSION).to_s
      res.status(status).html(html)
    end

    private def render_form(req : Spectre::Request, res : Spectre::Response, post : Post?, title : String,
                            body : String, publish : Bool, error : String?, status : Int32 = 200) : Nil
      csrf = req.session.not_nil!.csrf
      html = Views::Form.new(post, title, body, publish, csrf, error).to_s
      render_page(req, res, html, title: post ? "Edit post" : "New post", status: status)
    end

    private def find_post(req : Spectre::Request) : Post
      @store.find(req.params.int("id")) || Spectre.halt(404, "That post does not exist.")
    end

    private def read_post(form : URI::Params) : {String, String, Bool}
      title = (form["title"]? || "").strip
      body = (form["body"]? || "").gsub("\r\n", "\n").gsub('\r', '\n')
      {title, body, form["publish"]? == "1"}
    end

    private def validate(title : String, body : String) : String?
      if title.empty?
        "Title is required."
      elsif title.size > 200
        "Title must be 200 characters or fewer."
      elsif body.blank?
        "Body is required."
      elsif body.bytesize > 100_000
        "Body is too long. The limit is 100 KB."
      end
    end

    private def check_csrf!(req : Spectre::Request, session : Session) : Nil
      token = req.form["csrf"]? || ""
      unless Crypto::Subtle.constant_time_compare(token, session.csrf)
        Spectre.halt(403, "Invalid or missing form token. Reload the page and try again.")
      end
    end
  end

  def self.build_app(config : Config, store : Store) : Spectre::App
    auth = Auth.new(store, config)
    site = Site.new(config, store, auth, Throttle.new)

    app = Spectre.new
    app.max_body = 256 * 1024
    app.use Spectre::Middleware.logger
    app.use security_headers
    app.use same_origin(config)
    app.use load_session(auth)

    app.get("/static/style.css") do |req, res|
      res.header("Cache-Control", "public, max-age=31536000, immutable")
      res.send(STYLE_CSS.to_slice, "text/css; charset=utf-8")
    end
    app.get("/favicon.ico") { |req, res| res.send_status(204) }

    app.get("/") { |req, res| site.index(req, res) }
    app.get("/posts/:slug") { |req, res| site.show(req, res) }
    app.get("/feed.xml") { |req, res| site.feed(req, res) }

    app.get("/login") { |req, res| site.login_form(req, res) }
    app.post("/login") { |req, res| site.login(req, res) }
    app.post("/logout") { |req, res| site.logout(req, res) }

    app.use "/admin", require_admin
    app.get("/admin") { |req, res| site.admin_index(req, res) }
    app.get("/admin/new") { |req, res| site.admin_new(req, res) }
    app.post("/admin/backup") { |req, res| site.admin_backup(req, res) }
    app.post("/admin/posts") { |req, res| site.admin_create(req, res) }
    app.get("/admin/posts/:id/edit") { |req, res| site.admin_edit(req, res) }
    app.post("/admin/posts/:id") { |req, res| site.admin_update(req, res) }
    app.post("/admin/posts/:id/delete") { |req, res| site.admin_delete(req, res) }

    app.not_found { |req, res| site.render_error(req, res, 404, "That page does not exist.") }
    app.error do |ex, req, res|
      status = ex.is_a?(Spectre::HTTPError) ? ex.status : 500
      site.render_error(req, res, status, status == 500 ? "Something went wrong." : ex.message.to_s)
    end
    app
  end

  def self.run : Nil
    Env.load(ENV.fetch("ENV_FILE", ".env"))
    config = Config.from_env
    STDERR.puts "Warning: ADMIN_PASSWORD is short. Use at least 12 characters." if config.password.size < 12
    store = Store.new(config.db_path)
    app = build_app(config, store)
    app.listen(config.port, config.host)
    store.close
  rescue ex : ConfigError
    STDERR.puts "Configuration error: #{ex.message}"
    exit 1
  end
end
