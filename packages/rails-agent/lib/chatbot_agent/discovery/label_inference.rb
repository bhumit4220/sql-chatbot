require 'set'

module ChatbotAgent
  module Discovery
    class LabelInference
      # Generic keywords to skip in JS/TS/Python pattern
      SKIP_KEYWORDS = Set.new(%w[enum type const let var def class module id pk]).freeze

      # Pattern 1: Ruby/Rails hash enum — 'Label': value or "Label": value
      RUBY_ENUM_PATTERN = /['"](\w[\w\s]*?)['"]:\s*(\d+)/

      # Pattern 2: JS/TS/Python — Label = value or Label: value (unquoted)
      JS_ENUM_PATTERN = /(\w+)\s*[:=]\s*(\d+)/

      class << self
        # Infers enum labels from code search results.
        # candidates: array of { table:, column:, distinct_values:, labels: }
        # code_chunks_finder: lambda(query, limit) -> [{ content:, score: }]
        # Returns candidates with :labels populated.
        def infer_labels(candidates, code_chunks_finder: nil)
          candidates.map do |candidate|
            labels = infer_for_candidate(candidate, code_chunks_finder)
            candidate.merge(labels: labels)
          end
        end

        private

        def infer_for_candidate(candidate, finder)
          code_chunks = fetch_code_chunks(candidate, finder)
          values_set = candidate[:distinct_values].to_set

          mappings = {}
          found_ruby = false

          code_chunks.each do |chunk|
            content = chunk[:content]

            # Try Ruby pattern first
            content.scan(RUBY_ENUM_PATTERN).each do |label, value|
              if values_set.include?(value.to_i)
                mappings[value] = label
                found_ruby = true
              end
            end
          end

          # Only try JS pattern if Ruby pattern didn't match
          unless found_ruby
            code_chunks.each do |chunk|
              content = chunk[:content]

              content.scan(JS_ENUM_PATTERN).each do |label, value|
                next if SKIP_KEYWORDS.include?(label.downcase)
                if values_set.include?(value.to_i)
                  mappings[value] = titleize_label(label)
                end
              end
            end
          end

          # Fallback: numeric labels
          if mappings.empty?
            candidate[:distinct_values].each do |val|
              mappings[val.to_s] = "#{candidate[:column]}_#{val}"
            end
          end

          mappings
        end

        def fetch_code_chunks(candidate, finder)
          return [] unless finder

          chunks = begin
            finder.call("enum #{candidate[:column]}", 10)
          rescue
            []
          end

          if chunks.empty?
            begin
              chunks = finder.call("#{candidate[:column]} enum #{candidate[:table]}", 5)
            rescue
              []
            end
          end

          chunks
        end

        def titleize_label(label)
          label.gsub('_', ' ').gsub(/\b\w/) { |c| c.upcase }
        end
      end
    end
  end
end
