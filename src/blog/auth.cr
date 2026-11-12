require "digest/sha256"
require "openssl/hmac"
require "crypto/subtle"

class Spectre::Request
  # Set by the session middleware when a valid session cookie is present.
  property session : Blog::Session?
end

module Blog
  # One admin, one password (from .env). Sessions live in SQLite; the cookie
  # holds a random token and the database holds only its SHA-256.
  class Auth
    getter cookie_name : String

    def initialize(@store : Store, @config : Config)
      # "__Host-" cookies must be Secure, so the prefix is only used over HTTPS.
      @cookie_name = @config.cookie_secure ? "__Host-session" : "session"
    end

    # Compares digests of both values, so neither content nor length leaks through timing.
    def password_ok?(input : String) : Bool
      a = OpenSSL::HMAC.digest(:sha256, "blog-login", input)
      b = OpenSSL::HMAC.digest(:sha256, "blog-login", @config.password)
      Crypto::Subtle.constant_time_compare(a, b)
    end

    # Starts a session and returns the cookie token.
    def start_session : String
      token = Random::Secure.hex(32)
      expires = Time.utc.to_unix + @config.session_days.to_i64 * 86_400
      @store.create_session(digest(token), Random::Secure.hex(24), expires)
      token
    end

    def session_for(token : String) : Session?
      @store.find_session(digest(token))
    end

    def end_session(token : String) : Nil
      @store.delete_session(digest(token))
    end

    def max_age : Time::Span
      @config.session_days.days
    end

    private def digest(token : String) : String
      Digest::SHA256.hexdigest(token)
    end
  end

  # Allows `max` failures per key in a sliding `window`.
  class Throttle
    def initialize(@max : Int32 = 5, @window : Time::Span = 15.minutes)
      @hits = {} of String => Array(Time::Span)
      @mutex = Mutex.new
    end

    def blocked?(key : String) : Bool
      @mutex.synchronize do
        prune(key)
        (@hits[key]? || [] of Time::Span).size >= @max
      end
    end

    def record(key : String) : Nil
      @mutex.synchronize do
        prune(key)
        (@hits[key] ||= [] of Time::Span) << Time.monotonic
      end
    end

    def clear(key : String) : Nil
      @mutex.synchronize { @hits.delete(key) }
    end

    private def prune(key : String) : Nil
      return unless list = @hits[key]?
      cutoff = Time.monotonic - @window
      list.reject! { |t| t < cutoff }
      @hits.delete(key) if list.empty?
    end
  end
end
