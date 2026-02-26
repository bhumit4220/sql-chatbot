module ChatbotAgent
  module Db
    class SqlExecutor
      MAX_RETRIES = 1

      class << self
        def execute(sql)
          retries = 0
          begin
            conn = fresh_connection
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
            safely_rollback(conn)

            # Retry once on connection errors
            if retries < MAX_RETRIES && connection_error?(e)
              retries += 1
              begin
                ::ActiveRecord::Base.connection_pool.disconnect!
              rescue NameError
                # ActiveRecord not available (e.g. in test)
              end
              retry
            end

            {
              success: false,
              error: sanitize_error(e),
              columns: [],
              rows: [],
              row_count: 0,
            }
          end
        end

        # Overridable for testing
        def connection
          ActiveRecord::Base.connection
        end

        private

        def fresh_connection
          conn = connection
          conn.verify! if conn.respond_to?(:verify!)
          conn
        rescue
          begin
            ::ActiveRecord::Base.connection_pool.disconnect!
          rescue NameError
            # ActiveRecord not available (e.g. in test)
          end
          connection
        end

        def safely_rollback(conn)
          conn&.execute('ROLLBACK')
        rescue
          # ignore rollback errors
        end

        def connection_error?(exception)
          msg = exception.message.to_s.downcase
          msg.include?('connectionbad') || msg.include?('ssl error') ||
            msg.include?('connection reset') || msg.include?('broken pipe') ||
            msg.include?('unable to send')
        end

        def sanitize_error(exception)
          msg = exception.message.to_s
          # Strip connection/internal details, keep SQL-relevant info
          if connection_error?(exception)
            'Database connection error. Please try again.'
          elsif msg.include?('PG::')
            # Extract just the PG error class and user-safe message
            if msg =~ /PG::(\w+).*?ERROR:\s*(.+?)(?:\n|$)/
              "Query error: #{$2.strip}"
            else
              'Query execution failed. Please rephrase your question.'
            end
          elsif msg =~ /relation "(.+?)" does not exist/
            "Query error: relation \"#{$1}\" does not exist"
          elsif msg =~ /column "(.+?)" does not exist/
            "Query error: column \"#{$1}\" does not exist"
          else
            'An unexpected error occurred. Please try again.'
          end
        end
      end
    end
  end
end
