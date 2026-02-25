require 'set'

module ChatbotAgent
  module Db
    class SchemaInspector
      SENSITIVE_COLUMN_PATTERNS = %w[
        password pwd token secret ssn api_key salt
        encr_ stripe_ bank_
      ].freeze

      PII_COLUMN_PATTERNS = %w[
        email phone address first_name last_name
        dob date_of_birth ip_address
      ].freeze

      class << self
        def inspect_schema
          tables_result = connection.execute(<<~SQL)
            SELECT table_name,
                   obj_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass) as comment
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name
          SQL

          tables_result.map do |table_row|
            table_name = table_row['table_name']
            build_table(table_name, table_row['comment'])
          end
        end

        def format_for_prompt(tables)
          tables.map do |t|
            cols = t[:columns].map { |c| c[:name] }.join(', ')
            "TABLE #{t[:name]} (#{cols})"
          end.join("\n")
        end

        # Overridable for testing
        def connection
          ActiveRecord::Base.connection
        end

        private

        def build_table(table_name, comment)
          columns = fetch_columns(table_name)
          primary_keys = fetch_primary_keys(table_name)
          foreign_keys = fetch_foreign_keys(table_name)

          # Mark PK columns
          pk_set = primary_keys.to_set
          columns.each { |c| c[:is_primary_key] = pk_set.include?(c[:name]) }

          {
            name: table_name,
            columns: columns,
            primary_keys: primary_keys,
            foreign_keys: foreign_keys,
            comment: comment,
          }
        end

        def fetch_columns(table_name)
          result = connection.execute(<<~SQL)
            SELECT column_name, data_type, is_nullable,
              col_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, ordinal_position) as comment
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '#{sanitize(table_name)}'
            ORDER BY ordinal_position
          SQL

          result
            .reject { |c| sensitive_column?(c['column_name']) }
            .map do |c|
              {
                name: c['column_name'],
                type: c['data_type'],
                nullable: c['is_nullable'] == 'YES',
                is_primary_key: false,
                comment: c['comment'],
              }
            end
        end

        def fetch_primary_keys(table_name)
          result = connection.execute(<<~SQL)
            SELECT a.attname
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = '#{sanitize(table_name)}'::regclass AND i.indisprimary
          SQL

          result.map { |r| r['attname'] }
        end

        def fetch_foreign_keys(table_name)
          result = connection.execute(<<~SQL)
            SELECT
              kcu.column_name,
              ccu.table_name AS referred_table,
              ccu.column_name AS referred_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '#{sanitize(table_name)}'
          SQL

          result.map do |r|
            {
              column: r['column_name'],
              referred_table: r['referred_table'],
              referred_column: r['referred_column'],
            }
          end
        end

        def sensitive_column?(name)
          lower = name.downcase
          SENSITIVE_COLUMN_PATTERNS.any? { |p| lower.include?(p) } ||
            PII_COLUMN_PATTERNS.any? { |p| lower == p }
        end

        def sanitize(value)
          value.gsub(/[^a-zA-Z0-9_]/, '')
        end
      end
    end
  end
end
