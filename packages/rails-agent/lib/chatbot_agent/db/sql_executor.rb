module ChatbotAgent
  module Db
    class SqlExecutor
      class << self
        def execute(sql)
          conn = connection
          conn.execute('BEGIN')
          conn.execute('SET TRANSACTION READ ONLY')

          result = conn.execute(sql)
          conn.execute('COMMIT')

          rows = result.to_a
          columns = rows.first&.keys || []

          {
            success: true,
            columns: columns,
            rows: rows,
            row_count: rows.length,
          }
        rescue => e
          begin
            conn.execute('ROLLBACK')
          rescue
            # ignore rollback errors
          end

          {
            success: false,
            error: e.message,
            columns: [],
            rows: [],
            row_count: 0,
          }
        end

        # Overridable for testing
        def connection
          ActiveRecord::Base.connection
        end
      end
    end
  end
end
