require "db"
require "sqlite3"

module Blog
  struct Post
    include DB::Serializable
    include DB::Serializable::NonStrict

    getter id : Int64
    getter slug : String
    getter title : String
    getter body : String
    getter created_at : Int64
    getter updated_at : Int64
    # nil while the post is a draft
    getter published_at : Int64?

    def published? : Bool
      !@published_at.nil?
    end
  end

  struct Session
    include DB::Serializable
    include DB::Serializable::NonStrict

    getter csrf : String
    getter expires_at : Int64
  end

  class Store
    COLUMNS = "id, slug, title, body, created_at, updated_at, published_at"

    getter db : DB::Database

    def initialize(path : String)
      Dir.mkdir_p(File.dirname(path))
      @db = DB.open("sqlite3://#{path}?journal_mode=wal&synchronous=normal&busy_timeout=5000&foreign_keys=1")
      migrate
    end

    def close : Nil
      @db.close
    end

    # ---- posts

    def published(limit : Int32, offset : Int32) : Array(Post)
      @db.query_all("SELECT #{COLUMNS} FROM posts WHERE published_at IS NOT NULL " \
                    "ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?", limit, offset, as: Post)
    end

    def count_published : Int32
      @db.scalar("SELECT COUNT(*) FROM posts WHERE published_at IS NOT NULL").as(Int64).to_i32
    end

    def all_posts : Array(Post)
      @db.query_all("SELECT #{COLUMNS} FROM posts ORDER BY COALESCE(published_at, updated_at) DESC, id DESC", as: Post)
    end

    def find(id : Int64) : Post?
      @db.query_one?("SELECT #{COLUMNS} FROM posts WHERE id = ?", id, as: Post)
    end

    def find_by_slug(slug : String) : Post?
      @db.query_one?("SELECT #{COLUMNS} FROM posts WHERE slug = ?", slug, as: Post)
    end

    def create(title : String, body : String, publish : Bool) : Post
      now = Time.utc.to_unix
      slug = unique_slug(Store.slugify(title))
      id = @db.exec("INSERT INTO posts (slug, title, body, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?)",
        slug, title, body, now, now, publish ? now : nil).last_insert_id
      find(id).not_nil!
    end

    # Keeps the slug, so published URLs never change. Publishing sets the
    # date once; saving an already published post keeps its date.
    def update(id : Int64, title : String, body : String, publish : Bool) : Post?
      current = find(id) || return nil
      now = Time.utc.to_unix
      published_at = publish ? (current.published_at || now) : nil
      @db.exec("UPDATE posts SET title = ?, body = ?, updated_at = ?, published_at = ? WHERE id = ?",
        title, body, now, published_at, id)
      find(id)
    end

    def delete(id : Int64) : Bool
      @db.exec("DELETE FROM posts WHERE id = ?", id).rows_affected > 0
    end

    def self.slugify(title : String) : String
      slug = title.downcase.gsub(/[^a-z0-9]+/, "-").strip('-')
      slug = slug[0, 60].strip('-')
      slug.empty? ? "post" : slug
    end

    # ---- sessions (only a hash of the token is stored)

    def create_session(id : String, csrf : String, expires_at : Int64) : Nil
      @db.exec("DELETE FROM sessions WHERE expires_at <= ?", Time.utc.to_unix)
      @db.exec("INSERT INTO sessions (id, csrf, expires_at) VALUES (?, ?, ?)", id, csrf, expires_at)
    end

    def find_session(id : String) : Session?
      @db.query_one?("SELECT csrf, expires_at FROM sessions WHERE id = ? AND expires_at > ?",
        id, Time.utc.to_unix, as: Session)
    end

    def delete_session(id : String) : Nil
      @db.exec("DELETE FROM sessions WHERE id = ?", id)
    end

    # Writes a consistent copy of the database to `path` (which must not exist),
    # safe to run while the server is serving requests. Login sessions are
    # removed from the copy, so a backup never contains live session hashes.
    def backup_to(path : String) : Nil
      @db.exec("VACUUM INTO ?", path)
      DB.open("sqlite3://#{path}") do |copy|
        copy.exec("DELETE FROM sessions")
        copy.exec("VACUUM") # rewrite the file so the deleted rows are gone from disk too
      end
    end

    private def unique_slug(base : String) : String
      slug = base
      n = 2
      while @db.scalar("SELECT COUNT(*) FROM posts WHERE slug = ?", slug).as(Int64) > 0
        slug = "#{base}-#{n}"
        n += 1
      end
      slug
    end

    private def migrate : Nil
      @db.exec <<-SQL
        CREATE TABLE IF NOT EXISTS posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          published_at INTEGER
        )
      SQL
      @db.exec "CREATE INDEX IF NOT EXISTS idx_posts_published ON posts (published_at DESC)"
      @db.exec <<-SQL
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          csrf TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      SQL
    end
  end
end
