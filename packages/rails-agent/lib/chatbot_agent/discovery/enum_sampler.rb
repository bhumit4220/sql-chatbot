require 'set'

module ChatbotAgent
  module Discovery
    class EnumSampler
      MAX_TABLES = 100
      MAX_ROW_COUNT = 1_000_000
      MAX_DISTINCT = 30
      SAMPLE_TIMEOUT_MS = 5000

      class << self
        def detect_candidates(exclude_pks: Set.new, exclude_fks: Set.new)
          # Get table row estimates to skip huge tables
          table_sizes = fetch_table_sizes
          eligible_tables = table_sizes
            .select { |t| t['row_estimate'].to_i <= MAX_ROW_COUNT }
            .map { |t| t['tablename'] }
            .first(MAX_TABLES)

          return [] if eligible_tables.empty?

          # Get all integer columns from eligible tables
          columns = fetch_integer_columns(eligible_tables)

          candidates = []
          columns.each do |col|
            key = "#{col['table_name']}.#{col['column_name']}"
            next if exclude_pks.include?(key) || exclude_fks.include?(key)
            next unless eligible_tables.include?(col['table_name'])

            values = sample_distinct_values(col['table_name'], col['column_name'])
            next if values.empty? || values.length > MAX_DISTINCT

            candidates << {
              table: col['table_name'],
              column: col['column_name'],
              distinct_values: values,
              labels: {},
            }
          end

          candidates
        end

        def format_for_prompt(candidates)
          candidates.map do |c|
            if c[:labels] && !c[:labels].empty?
              values = c[:distinct_values].map { |v| "#{v}=#{c[:labels][v] || v}" }.join(', ')
            else
              values = c[:distinct_values].join(', ')
            end
            "#{c[:table]}.#{c[:column]}: #{values}"
          end.join("\n")
        end

        # Overridable for testing
        def connection
          ActiveRecord::Base.connection
        end

        private

        def fetch_table_sizes
          connection.execute(<<~SQL)
            SELECT relname AS tablename, reltuples::bigint AS row_estimate
            FROM pg_class
            JOIN pg_namespace ON pg_namespace.oid = relnamespace
            WHERE nspname = 'public' AND relkind = 'r'
            ORDER BY reltuples
          SQL
        end

        def fetch_integer_columns(eligible_tables)
          table_list = eligible_tables.map { |t| "'#{t.gsub(/[^a-zA-Z0-9_]/, '')}'" }.join(', ')
          connection.execute(<<~SQL)
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN (#{table_list})
              AND data_type IN ('integer', 'smallint', 'bigint')
            ORDER BY table_name, column_name
          SQL
        end

        def sample_distinct_values(table_name, column_name)
          table = table_name.gsub(/[^a-zA-Z0-9_]/, '')
          column = column_name.gsub(/[^a-zA-Z0-9_]/, '')

          connection.execute("SET statement_timeout = '#{SAMPLE_TIMEOUT_MS}'")

          result = connection.execute(<<~SQL)
            SELECT DISTINCT "#{column}" as val
            FROM "#{table}"
            WHERE "#{column}" IS NOT NULL
            ORDER BY val
            LIMIT #{MAX_DISTINCT + 1}
          SQL

          connection.execute("SET statement_timeout = '0'")

          result.map { |r| r['val'].to_i }
        rescue => e
          # Timeout or other error — skip this column
          begin
            connection.execute("SET statement_timeout = '0'")
          rescue
            nil
          end
          []
        end
      end
    end
  end
end
