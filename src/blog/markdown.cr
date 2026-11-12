require "html"

module Blog
  # A small, safe Markdown subset: headings, paragraphs, bullet lists, fenced
  # code, **bold**, *italic*, `code` and [links](https://...). All input is
  # HTML-escaped first, so post bodies cannot inject markup or scripts, and
  # links are limited to http, https and mailto.
  #
  # `#` renders as <h2>, because the post title is the page's <h1>.
  module Markdown
    def self.render(source : String) : String
      Renderer.new.render(source)
    end

    def self.inline(text : String) : String
      # NUL is used as a placeholder delimiter below, so it must not appear in the input.
      escaped = HTML.escape(text.delete('\0'))
      # Code spans are set aside first so emphasis can wrap them (**`x`**)
      # and nothing inside them is formatted.
      codes = [] of String
      stashed = escaped.gsub(/`([^`\n]+)`/) do |_, match|
        codes << match[1]
        "\0#{codes.size - 1}\0"
      end
      format(stashed).gsub(/\x00(\d+)\x00/) { |_, match| "<code>#{codes[match[1].to_i]}</code>" }
    end

    private def self.format(text : String) : String
      text
        .gsub(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/, %(<a href="\\2" rel="nofollow noopener">\\1</a>))
        .gsub(/\*\*([^*\n]+)\*\*/, "<strong>\\1</strong>")
        .gsub(/(?<![*\w])\*([^*\s][^*\n]*?)\*(?!\*)/, "<em>\\1</em>")
    end

    # Plain-text teaser for lists and feeds.
    def self.excerpt(source : String, limit : Int32 = 200) : String
      first = source.gsub("\r\n", "\n").split(/\n\s*\n/).find { |block| !block.strip.empty? && !block.starts_with?("```") } || ""
      text = first.gsub(/\[([^\]]*)\]\([^)]*\)/, "\\1").gsub(/[#*_`>]/, "").gsub(/\s+/, " ").strip
      text.size > limit ? text[0, limit].rstrip + "…" : text
    end

    private class Renderer
      def initialize
        @io = String::Builder.new
        @paragraph = [] of String
        @items = [] of String
        @code = nil.as(Array(String)?)
      end

      def render(source : String) : String
        source.gsub("\r\n", "\n").gsub('\r', '\n').each_line(chomp: true) do |line|
          if code = @code
            if line.starts_with?("```")
              @io << "<pre><code>" << HTML.escape(code.join('\n')) << "</code></pre>\n"
              @code = nil
            else
              code << line
            end
            next
          end

          if line.starts_with?("```")
            flush
            @code = [] of String
          elsif line.blank?
            flush
          elsif heading = heading_level(line)
            flush
            level, text = heading
            @io << "<h#{level + 1}>" << Markdown.inline(text) << "</h#{level + 1}>\n"
          elsif line.starts_with?("- ") || line.starts_with?("* ")
            flush_paragraph
            @items << line[2..]
          else
            flush_list
            @paragraph << line
          end
        end

        if code = @code
          @io << "<pre><code>" << HTML.escape(code.join('\n')) << "</code></pre>\n"
        end
        flush
        @io.to_s
      end

      private def heading_level(line : String) : {Int32, String}?
        if line.starts_with?("### ")
          {3, line[4..].strip}
        elsif line.starts_with?("## ")
          {2, line[3..].strip}
        elsif line.starts_with?("# ")
          {1, line[2..].strip}
        end
      end

      private def flush
        flush_paragraph
        flush_list
      end

      private def flush_paragraph
        return if @paragraph.empty?
        @io << "<p>" << Markdown.inline(@paragraph.join('\n')) << "</p>\n"
        @paragraph.clear
      end

      private def flush_list
        return if @items.empty?
        @io << "<ul>\n"
        @items.each { |item| @io << "<li>" << Markdown.inline(item) << "</li>\n" }
        @io << "</ul>\n"
        @items.clear
      end
    end
  end
end
