require "ecr"
require "html"

module Blog
  module Helpers
    def h(value) : String
      HTML.escape(value.to_s)
    end

    def date(unix : Int64) : String
      Time.unix(unix).to_s("%B %-d, %Y")
    end

    def iso(unix : Int64) : String
      Time.unix(unix).to_rfc3339
    end
  end

  # Templates are compiled into the binary by ECR, so there is no template
  # parsing at request time. Every interpolated value goes through `h`.
  module Views
    struct Layout
      include Helpers

      def initialize(@config : Config, @page_title : String, @description : String,
                     @content : String, @admin : Bool, @csrf : String, @css_version : String)
      end

      ECR.def_to_s "#{__DIR__}/../views/layout.ecr"
    end

    struct Index
      include Helpers

      def initialize(@posts : Array(Post), @page : Int32, @has_next : Bool)
      end

      ECR.def_to_s "#{__DIR__}/../views/index.ecr"
    end

    struct PostPage
      include Helpers

      def initialize(@post : Post, @author : String, @admin : Bool)
      end

      ECR.def_to_s "#{__DIR__}/../views/post.ecr"
    end

    struct Login
      include Helpers

      def initialize(@error : String?)
      end

      ECR.def_to_s "#{__DIR__}/../views/login.ecr"
    end

    struct Admin
      include Helpers

      def initialize(@posts : Array(Post), @notice : String?, @csrf : String)
      end

      ECR.def_to_s "#{__DIR__}/../views/admin.ecr"
    end

    struct Form
      include Helpers

      def initialize(@post : Post?, @title : String, @body : String, @publish : Bool,
                     @csrf : String, @error : String?)
      end

      ECR.def_to_s "#{__DIR__}/../views/form.ecr"
    end

    struct ErrorPage
      include Helpers

      def initialize(@status : Int32, @message : String)
      end

      ECR.def_to_s "#{__DIR__}/../views/error.ecr"
    end
  end

  module Feed
    def self.render(config : Config, posts : Array(Post)) : String
      String.build do |io|
        io << %(<?xml version="1.0" encoding="UTF-8"?>\n)
        io << %(<rss version="2.0"><channel>\n)
        io << "<title>" << HTML.escape(config.title) << "</title>\n"
        io << "<link>" << HTML.escape(config.base_url) << "/</link>\n"
        io << "<description>" << HTML.escape(config.description) << "</description>\n"
        posts.each do |post|
          url = "#{config.base_url}/posts/#{post.slug}"
          io << "<item>\n"
          io << "<title>" << HTML.escape(post.title) << "</title>\n"
          io << "<link>" << HTML.escape(url) << "</link>\n"
          io << %(<guid isPermaLink="true">) << HTML.escape(url) << "</guid>\n"
          io << "<pubDate>" << Time.unix(post.published_at || post.created_at).to_rfc2822 << "</pubDate>\n"
          io << "<description>" << HTML.escape(Markdown.render(post.body)) << "</description>\n"
          io << "</item>\n"
        end
        io << "</channel></rss>\n"
      end
    end
  end
end
