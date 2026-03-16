module SqlChatbot
  module Services
    module SqlExecutor
      KEYWORD_BLOCKLIST = %w[INSERT UPDATE DELETE DROP ALTER CREATE GRANT TRUNCATE EXECUTE REVOKE COPY INTO].freeze
      FUNCTION_BLOCKLIST = %w[pg_read_file pg_read_binary_file dblink pg_terminate_backend lo_import lo_export pg_sleep set_config current_setting].freeze
      CATALOG_BLOCKLIST = %w[pg_shadow pg_roles pg_authid pg_user information_schema].freeze
      AGGREGATE_PATTERN = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i

      def self.validate_sql(sql)
        trimmed = sql.gsub(/^\s+/, "")
        trimmed = trimmed.gsub(/--[^\n]*/, "").gsub(/\/\*[\s\S]*?\*\//, "")
        trimmed = trimmed.strip

        # Fix missing space after SELECT
        trimmed = trimmed.sub(/^SELECT(?=[A-Z])/i, "SELECT ")

        # Single statement check
        parts = trimmed.split(";").select { |p| p.strip.length > 0 }
        if parts.length > 1
          return { valid: false, reason: "Only a single statement is allowed" }
        end

        working_sql = trimmed.sub(/;\s*$/, "").strip

        # Must start with SELECT
        unless working_sql.match?(/^SELECT\b/i)
          return { valid: false, reason: "Only SELECT queries are allowed" }
        end

        # Keyword blocklist
        KEYWORD_BLOCKLIST.each do |keyword|
          if working_sql.match?(/\b#{keyword}\b/i)
            return { valid: false, reason: "Blocked keyword: #{keyword}" }
          end
        end

        # Function blocklist
        FUNCTION_BLOCKLIST.each do |fn|
          if working_sql.match?(/\b#{fn}\b/i)
            return { valid: false, reason: "Blocked function: #{fn}" }
          end
        end

        # Catalog blocklist
        CATALOG_BLOCKLIST.each do |catalog|
          if working_sql.match?(/\b#{catalog}\b/i)
            return { valid: false, reason: "Blocked system catalog: #{catalog}" }
          end
        end

        # Auto-add LIMIT
        has_limit = working_sql.match?(/\bLIMIT\b/i)
        is_aggregate = AGGREGATE_PATTERN.match?(working_sql)
        working_sql += " LIMIT 500" if !has_limit && !is_aggregate

        { valid: true, sql: working_sql }
      end

      def self.execute_sql(sql)
        connection = ActiveRecord::Base.connection
        connection.execute("SET statement_timeout = '10s'")
        connection.execute("BEGIN")
        connection.execute("SET TRANSACTION READ ONLY")

        result = connection.execute(sql)
        rows = result.to_a
        columns = rows.first&.keys || []

        connection.execute("COMMIT")

        { columns: columns, rows: rows, row_count: rows.length }
      rescue => e
        connection.execute("ROLLBACK") rescue nil
        raise e
      ensure
        # Reset statement_timeout on shared AR connection
        connection.execute("SET statement_timeout = '0'") rescue nil
      end
    end
  end
end
