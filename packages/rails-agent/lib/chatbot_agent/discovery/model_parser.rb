require 'fileutils'

module ChatbotAgent
  module Discovery
    class ModelParser
      # Association patterns
      BELONGS_TO_RE = /^\s*belongs_to\s+:(\w+)(.*)$/
      HAS_MANY_RE   = /^\s*has_many\s+:(\w+)(.*)$/
      HAS_ONE_RE    = /^\s*has_one\s+:(\w+)(.*)$/

      # Enum pattern: enum name: { key: val, ... }
      ENUM_RE = /^\s*enum\s+(\w+):\s*\{([^}]+)\}/

      # Default scope patterns
      DEFAULT_SCOPE_BLOCK_RE  = /^\s*default_scope\s*\{(.+)\}/
      DEFAULT_SCOPE_LAMBDA_RE = /^\s*default_scope\s*->\s*\{(.+)\}/

      # Soft delete
      ACTS_AS_PARANOID_RE = /^\s*acts_as_paranoid/
      INCLUDE_PARANOIA_RE = /^\s*include\s+Paranoia\b/

      # Include/concern
      INCLUDE_RE = /^\s*include\s+(\w+)/

      # Option extractors
      OPTION_RE = /(\w+):\s*(?::(\w+)|'([^']*)'|"([^"]*)"|(true|false|\w+))/

      class << self
        def parse(code)
          result = {
            associations: [],
            enums: [],
            default_scopes: [],
            soft_delete: false,
            includes: [],
          }

          code.each_line do |line|
            parse_association(line, result)
            parse_enum(line, result)
            parse_default_scope(line, result)
            parse_soft_delete(line, result)
            parse_include(line, result)
          end

          result
        end

        def parse_directory(dir)
          results = {}

          Dir.glob(File.join(dir, '**', '*.rb')).each do |file_path|
            relative = file_path.sub("#{dir}/", '').sub(/\.rb$/, '')
            content = File.read(file_path)
            results[relative] = parse(content)
          end

          results
        end

        private

        def parse_association(line, result)
          [
            [BELONGS_TO_RE, :belongs_to],
            [HAS_MANY_RE, :has_many],
            [HAS_ONE_RE, :has_one],
          ].each do |pattern, type|
            if (match = line.match(pattern))
              name = match[1]
              opts_str = match[2] || ''
              options = extract_options(opts_str)
              result[:associations] << { type: type, name: name, options: options }
            end
          end
        end

        def parse_enum(line, result)
          return unless (match = line.match(ENUM_RE))

          name = match[1]
          body = match[2]
          values = {}

          # Match both symbol keys (active: 1) and string keys ('Active': 1)
          body.scan(/['"]?(\w[\w\s]*?)['"]?\s*(?:=>|:)\s*(\d+)/) do |label, val|
            values[label.strip] = val
          end

          result[:enums] << { name: name, values: values } unless values.empty?
        end

        def parse_default_scope(line, result)
          if (match = line.match(DEFAULT_SCOPE_LAMBDA_RE))
            result[:default_scopes] << match[1].strip
          elsif (match = line.match(DEFAULT_SCOPE_BLOCK_RE))
            result[:default_scopes] << match[1].strip
          end
        end

        def parse_soft_delete(line, result)
          if line.match?(ACTS_AS_PARANOID_RE) || line.match?(INCLUDE_PARANOIA_RE)
            result[:soft_delete] = true
          end
        end

        def parse_include(line, result)
          return if line.match?(INCLUDE_PARANOIA_RE) # Already handled in soft_delete

          if (match = line.match(INCLUDE_RE))
            module_name = match[1]
            result[:includes] << module_name unless module_name == 'Paranoia'
          end
        end

        def extract_options(opts_str)
          options = {}
          opts_str.scan(OPTION_RE).each do |key, sym_val, sq_val, dq_val, bare_val|
            next if key.start_with?('_') # Skip enum options like _suffix
            value = sym_val || sq_val || dq_val || bare_val
            options[key.to_sym] = value if value
          end
          options
        end
      end
    end
  end
end
