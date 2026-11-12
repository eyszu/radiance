require "spec"
require "file_utils"
require "../src/blog"

PASSWORD = "correct horse battery staple"

# A fresh app on a fresh database file for each example.
def with_blog(&)
  dir = File.join(Dir.tempdir, "blog_spec_#{Random::Secure.hex(6)}")
  store = Blog::Store.new(File.join(dir, "blog.db"))
  config = Blog::Config.new(password: PASSWORD, title: "Spec Blog", per_page: 2)
  app = Blog.build_app(config, store)
  begin
    yield app, store
  ensure
    store.close
    FileUtils.rm_rf(dir)
  end
end

# Logs in and returns {cookie header, csrf token}.
def login(app : Spectre::App) : {String, String}
  res = app.request("POST", "/login", "password=#{URI.encode_www_form(PASSWORD)}")
  res.status_code.should eq 303
  cookie = res.headers["Set-Cookie"].split(';').first
  page = app.request("GET", "/admin/new", headers: HTTP::Headers{"Cookie" => cookie})
  csrf = page.body.match(/name="csrf" value="([0-9a-f]+)"/).not_nil![1]
  {cookie, csrf}
end

def form(**fields) : String
  URI::Params.encode(fields.to_h.transform_keys(&.to_s))
end
