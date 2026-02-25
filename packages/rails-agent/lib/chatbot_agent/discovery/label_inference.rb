require 'set'

module ChatbotAgent
  module Discovery
    class LabelInference
      # Matches standard Rails enum declarations:
      #   enum status: { 'Active': 1, 'Inactive': 2 }
      #   enum status: { active: 1, inactive: 2 }
      #   enum :status, { active: 1, inactive: 2 }  (Rails 7+ syntax)
      # Captures: column_name, the full hash body
      RAILS_ENUM_HASH = /enum\s+:?['""]?(\w+)['""]?\s*[,:]?\s*\{([^}]+)\}/

      # Inside a hash body, matches 'Label': value, label => value, label: value, or Label = value
      HASH_ENTRY = /['""]?(\w[\w\s]*?)['""]?\s*(?:=>|:|=)\s*(\d+)/

      class << self
        # Infers enum labels by scanning Ruby model files for enum declarations.
        # candidates: array of { table:, column:, distinct_values:, labels: }
        # models_path: path to app/models directory
        # code_chunks_finder: optional fallback lambda(query, limit) -> [{ content: }]
        # Returns candidates with :labels populated.
        def infer_labels(candidates, models_path: nil, code_chunks_finder: nil)
          # Build a lookup of all enum definitions found in model files
          enum_defs = models_path ? scan_models_for_enums(models_path) : {}

          candidates.map do |candidate|
            labels = infer_for_candidate(candidate, enum_defs, code_chunks_finder)
            candidate.merge(labels: labels)
          end
        end

        private

        # Scans all .rb files under models_path for Rails enum declarations.
        # Returns: { "column_name" => { "1" => "Active", "2" => "Inactive" }, ... }
        def scan_models_for_enums(models_path)
          return {} unless models_path && Dir.exist?(models_path)

          enum_defs = {}

          Dir.glob(File.join(models_path, '**', '*.rb')).each do |file|
            content = File.read(file) rescue next

            content.scan(RAILS_ENUM_HASH).each do |column_name, hash_body|
              mappings = {}
              hash_body.scan(HASH_ENTRY).each do |label, value|
                mappings[value] = label.strip
              end
              # Merge into existing (later files can override, concerns get picked up)
              if mappings.any?
                enum_defs[column_name] ||= {}
                enum_defs[column_name].merge!(mappings)
              end
            end
          end

          enum_defs
        end

        def infer_for_candidate(candidate, enum_defs, finder)
          column = candidate[:column]
          values_set = candidate[:distinct_values].to_set

          # Strategy 1: Match from scanned Rails enum definitions
          if enum_defs.key?(column)
            mappings = {}
            enum_defs[column].each do |value_str, label|
              mappings[value_str] = label if values_set.include?(value_str.to_i)
            end
            return mappings if mappings.any?
          end

          # Strategy 2: Fallback to code index search (if available)
          if finder
            mappings = infer_from_code_search(candidate, finder)
            return mappings if mappings.any?
          end

          # Strategy 3: Numeric fallback
          fallback = {}
          candidate[:distinct_values].each do |val|
            fallback[val.to_s] = "#{column}_#{val}"
          end
          fallback
        end

        GENERIC_KEYWORDS = Set.new(%w[enum const var let id type class def end module include extend]).freeze

        def infer_from_code_search(candidate, finder)
          code_chunks = fetch_code_chunks(candidate, finder)
          values_set = candidate[:distinct_values].to_set

          # Strategy A: Try Rails enum hash declarations first
          mappings = extract_from_enum_declarations(code_chunks, values_set)
          return mappings if mappings.any?

          # Strategy B: Fall back to general assignment patterns
          mappings = {}
          code_chunks.each do |chunk|
            chunk[:content].scan(HASH_ENTRY).each do |label, value|
              cleaned = label.strip
              next if GENERIC_KEYWORDS.include?(cleaned.downcase)
              next unless values_set.include?(value.to_i)
              mappings[value] = titleize_label(cleaned)
            end
          end

          mappings
        end

        def extract_from_enum_declarations(code_chunks, values_set)
          mappings = {}
          code_chunks.each do |chunk|
            chunk[:content].scan(RAILS_ENUM_HASH).each do |_column, hash_body|
              hash_body.scan(HASH_ENTRY).each do |label, value|
                mappings[value] = label.strip if values_set.include?(value.to_i)
              end
            end
          end
          mappings
        end

        def titleize_label(label)
          if label.include?('_')
            label.split('_').map(&:capitalize).join(' ')
          else
            label
          end
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
      end
    end
  end
end
