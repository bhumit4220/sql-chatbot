require 'pg_query'

module ChatbotAgent
  module Db
    class SqlValidator
      MAX_LIMIT = 500

      BLOCKED_FUNCTIONS = %w[
        pg_read_file pg_read_binary_file pg_ls_dir pg_stat_file
        lo_import lo_export
        dblink dblink_exec
        pg_sleep pg_sleep_for
        pg_terminate_backend pg_cancel_backend pg_reload_conf
        current_setting
      ].freeze

      BLOCKED_SYSTEM_TABLES = %w[
        pg_stat_activity pg_roles pg_shadow pg_authid
        pg_user pg_group
      ].freeze

      class << self
        def validate(sql)
          sql_trimmed = sql.strip.gsub(/;+\z/, '')

          # Layer 1: Parse SQL
          tree = begin
            PgQuery.parse(sql_trimmed)
          rescue PgQuery::ParseError => e
            return invalid("SQL parse error: #{e.message}")
          end

          stmts = tree.tree.stmts

          # Layer 2: Single statement only
          if stmts.length != 1
            return invalid('Multiple statements detected. Only single SELECT allowed.')
          end

          stmt = stmts.first.stmt

          # Layer 3: Must be SELECT
          unless stmt.respond_to?(:select_stmt) && stmt.select_stmt
            return invalid("Only SELECT statements allowed.")
          end

          select_stmt = stmt.select_stmt

          # Layer 4: Block SELECT INTO
          if select_stmt.respond_to?(:into_clause) && select_stmt.into_clause && select_stmt.into_clause.to_h != {}
            return invalid('SELECT INTO not allowed')
          end

          # Layer 4b: Block CTEs with mutations
          sql_lower = sql_trimmed.downcase
          if sql_lower.include?('with')
            if sql_lower.match?(/\b(insert|update|delete|truncate|drop|create|alter)\b/)
              return invalid('CTE with mutation (INSERT/UPDATE/DELETE) not allowed')
            end
          end

          # Layer 5: Blocked functions
          BLOCKED_FUNCTIONS.each do |func|
            if sql_lower.include?(func)
              return invalid("Blocked function: #{func}")
            end
          end

          # Layer 6: System catalog access
          BLOCKED_SYSTEM_TABLES.each do |table|
            if sql_lower.include?(table)
              return invalid("Blocked system catalog: #{table}")
            end
          end
          if sql_lower.include?('information_schema')
            return invalid('Blocked system catalog: information_schema')
          end

          # Layer 7: Add LIMIT if missing
          modified_sql = sql_trimmed
          unless sql_lower.match?(/\blimit\b/)
            modified_sql = "#{sql_trimmed} LIMIT #{MAX_LIMIT}"
          end

          { valid: true, sql: modified_sql, reason: nil }
        end

        private

        def invalid(reason)
          { valid: false, sql: nil, reason: reason }
        end
      end
    end
  end
end
