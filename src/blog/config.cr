module Blog
  class ConfigError < Exception
  end

  # Loads KEY=VALUE pairs from a .env file into ENV. Variables that are
  # already set in the real environment win. Values may be quoted with single
  # or double quotes; there are no inline comments, so a `#` inside a password
  # is safe.
  module Env
    def self.load(path : String) : Nil
      return unless File.file?(path)
      File.each_line(path) do |raw|
        line = raw.strip
        next if line.empty? || line.starts_with?('#')
        line = line.lchop("export ").lstrip
        key, sep, value = line.partition('=')
        next if sep.empty?
        key = key.strip
        value = value.strip
        if value.size >= 2 && (value[0] == '"' || value[0] == '\'') && value[-1] == value[0]
          value = value[1..-2]
        end
        ENV[key] = value unless key.empty? || ENV.has_key?(key)
      end
    end
  end

  struct Config
    getter password : String
    getter title : String
    getter description : String
    getter author : String
    getter base_url : String
    getter db_path : String
    getter host : String
    getter port : Int32
    getter cookie_secure : Bool
    getter session_days : Int32
    getter per_page : Int32

    def initialize(@password : String, @title : String = "My Blog",
                   @description : String = "Notes and essays.", @author : String = "Admin",
                   @base_url : String = "http://localhost:3000", @db_path : String = "data/blog.db",
                   @host : String = "127.0.0.1", @port : Int32 = 3000, @cookie_secure : Bool = false,
                   @session_days : Int32 = 14, @per_page : Int32 = 10)
    end

    def self.from_env : Config
      password = ENV["ADMIN_PASSWORD"]?.to_s
      if password.empty?
        raise ConfigError.new("ADMIN_PASSWORD is not set. Copy .env.example to .env and choose a password.")
      end
      if password == "change-me"
        raise ConfigError.new("ADMIN_PASSWORD is still the placeholder from .env.example. Choose your own.")
      end

      port = ENV.fetch("PORT", "3000").to_i? || raise ConfigError.new("PORT must be a number")
      base_url = ENV.fetch("BASE_URL", "http://localhost:#{port}").rstrip('/')
      secure = if value = ENV["COOKIE_SECURE"]?
                 %w(1 true yes on).includes?(value.downcase)
               else
                 base_url.starts_with?("https://")
               end

      new(
        password: password,
        title: ENV.fetch("BLOG_TITLE", "My Blog"),
        description: ENV.fetch("BLOG_DESCRIPTION", "Notes and essays."),
        author: ENV.fetch("BLOG_AUTHOR", "Admin"),
        base_url: base_url,
        db_path: ENV.fetch("DATABASE_PATH", "data/blog.db"),
        host: ENV.fetch("HOST", "127.0.0.1"),
        port: port,
        cookie_secure: secure,
        session_days: (ENV["SESSION_DAYS"]?.try(&.to_i?) || 14).clamp(1, 365),
        per_page: (ENV["POSTS_PER_PAGE"]?.try(&.to_i?) || 10).clamp(1, 100),
      )
    end
  end
end
