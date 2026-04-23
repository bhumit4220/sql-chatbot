# frozen_string_literal: true

require "json"
require "sql_chatbot/prompts/classify"
require "sql_chatbot/prompts/generate_sql"
require "sql_chatbot/prompts/answer"
require "sql_chatbot/services/sql_executor"
require "sql_chatbot/services/grammar_pipeline"

module SqlChatbot
  module Services
    class Orchestrator
      VALID_TYPES = %w[data data_with_code code navigation guidance greeting unsafe].freeze

      def initialize(llm_client:, schema_service:, code_indexer:, route_introspector_data: nil)
        @llm = llm_client
        @schema = schema_service
        @code_indexer = code_indexer
        @route_introspector_data = route_introspector_data
        @manifest = nil
      end

      def set_manifest(manifest)
        version = manifest["version"] || manifest[:version]
        unless version == 1
          warn "[SqlChatbot] Unsupported manifest version: #{version}"
          return
        end
        @manifest = manifest
      end

      def route_list
        build_route_list
      end

      # Returns an Enumerator that yields SSE event hashes.
      # Events: classifying, classified, sql, executing, token, done, error
      def handle_question(question:, page_context: nil, history: [])
        Enumerator.new do |yielder|
          begin
            # --- Step 1: Classify ---
            yielder.yield({ type: "classifying" })

            table_names_str = @schema.table_names
            classify_messages = Prompts::Classify.build_messages(
              question: question,
              schema_summary: table_names_str,
              page_context: page_context,
              history: history
            )

            raw = @llm.call(classify_messages, json_mode: true)
            classification = parse_classification(raw)

            yielder.yield({
              type: "classified",
              questionType: classification[:type],
              confidence: classification[:confidence]
            })

            # --- Step 2: Route by question type ---
            case classification[:type]
            when "data", "data_with_code"
              handle_data_with_code(yielder, question, classification, page_context, history)
            when "code"
              handle_code(yielder, question, classification, history)
            when "navigation", "guidance"
              handle_navigation(yielder, question, classification[:type], page_context, history)
            when "greeting"
              handle_greeting(yielder, question, history)
            when "unsafe"
              handle_unsafe(yielder)
            end

            yielder.yield({ type: "done" })
          rescue => e
            log_error(e)
            yielder.yield({ type: "error", message: friendly_error_message(e) })
          end
        end
      end

      private

      # ============================================================
      # Route handlers
      # ============================================================

      def handle_data_with_code(yielder, question, classification, page_context, history)
        # --- Grammar-first path (before LLM SQL generation) ---
        grammar_result = try_grammar_path(yielder, question, history)
        if grammar_result == :handled
          return
        end

        # Search code index for context
        search_terms = classification[:searchTerms] || []
        code_results = search_terms.empty? ? [] : @code_indexer.search(search_terms)
        code_context = format_code_context(code_results)
        code_snippets = to_code_snippets(code_results)

        question_type = code_context.empty? ? "data" : "data_with_code"

        # Find lookup hints matching the question
        lookup_hints = @schema.find_lookup_hints(question)

        # Select only relevant schema tables based on search terms
        selected_schema = @schema.select_schema(search_terms)

        # Generate SQL (with one retry on execution error)
        gen_messages = Prompts::GenerateSql.build_messages(
          question: question,
          schema: selected_schema,
          code_context: code_context.empty? ? nil : code_context,
          lookup_hints: lookup_hints.empty? ? nil : lookup_hints,
          history: history
        )
        raw_sql = @llm.call(gen_messages, json_mode: true)
        parsed = parse_sql_generation(raw_sql)

        if parsed[:sql].empty?
          yielder.yield({ type: "error", message: "Failed to generate SQL" })
          return
        end

        yielder.yield({ type: "sql", query: parsed[:sql], explanation: parsed[:explanation] })

        # Validate SQL
        validation = SqlExecutor.validate_sql(parsed[:sql])
        unless validation[:valid]
          yielder.yield({ type: "error", message: "SQL validation failed: #{validation[:reason]}" })
          return
        end

        # Execute SQL with one retry on recoverable errors
        yielder.yield({ type: "executing" })

        begin
          result = SqlExecutor.execute_sql(validation[:sql])
        rescue ActiveRecord::StatementInvalid => e
          # Strategy 1: Try programmatic column fix (fast, no LLM call)
          log_error(e)
          fixed_sql = try_fix_column(e.message, validation[:sql], selected_schema)
          if fixed_sql
            begin
              fixed_validation = SqlExecutor.validate_sql(fixed_sql)
              if fixed_validation[:valid]
                yielder.yield({ type: "sql", query: fixed_sql, explanation: "Auto-corrected column name" })
                result = SqlExecutor.execute_sql(fixed_validation[:sql])
              end
            rescue => _fix_error
              # Fall through to LLM retry
            end
          end

          # Strategy 2: Ask LLM to fix (slower, more flexible)
          unless defined?(result) && result
            error_hint = build_column_hint(e.message, selected_schema)
            retry_messages = gen_messages + [
              { role: "assistant", content: raw_sql },
              { role: "user", content: "The SQL query failed with this error:\n#{e.message}\n\n#{error_hint}Fix the query using ONLY columns from the schema. Keep all SELECT columns — do not drop columns, use the correct names." }
            ]
            begin
              retry_sql = @llm.call(retry_messages, json_mode: true)
              retry_parsed = parse_sql_generation(retry_sql)
              retry_validation = SqlExecutor.validate_sql(retry_parsed[:sql])
              if retry_validation[:valid] && !retry_parsed[:sql].empty?
                yielder.yield({ type: "sql", query: retry_parsed[:sql], explanation: "Corrected: #{retry_parsed[:explanation]}" })
                result = SqlExecutor.execute_sql(retry_validation[:sql])
              else
                raise e
              end
            rescue => retry_error
              log_error(retry_error)
              yielder.yield({ type: "error", message: friendly_error_message(e) })
              return
            end
          end
        rescue => e
          log_error(e)
          yielder.yield({ type: "error", message: friendly_error_message(e) })
          return
        end

        # Extract enum context from the selected schema for answer translation
        enum_context = @schema.extract_enum_context(selected_schema)

        # Stream answer
        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: question_type,
          sql_result: result[:rows],
          sql_query: validation[:sql],
          code_snippets: code_snippets.empty? ? nil : code_snippets,
          page_context: page_context,
          history: history,
          enum_context: enum_context.empty? ? nil : enum_context
        )

        @llm.stream(answer_messages) do |chunk|
          yielder.yield({ type: "token", content: chunk })
        end
      end

      def handle_code(yielder, question, classification, history)
        search_terms = classification[:searchTerms] || []
        code_results = search_terms.empty? ? [] : @code_indexer.search(search_terms)

        if code_results.empty?
          yielder.yield({ type: "token", content: "I couldn't find relevant code for that question." })
          return
        end

        code_snippets = to_code_snippets(code_results)

        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: "code",
          code_snippets: code_snippets,
          history: history
        )

        @llm.stream(answer_messages) do |chunk|
          yielder.yield({ type: "token", content: chunk })
        end
      end

      def handle_navigation(yielder, question, type, page_context, history)
        merged_routes = build_route_list

        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: type,
          page_context: page_context,
          route_list: merged_routes,
          history: history
        )

        @llm.stream(answer_messages) do |chunk|
          yielder.yield({ type: "token", content: chunk })
        end
      end

      def handle_greeting(yielder, question, history)
        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: "greeting",
          history: history
        )

        @llm.stream(answer_messages) do |chunk|
          yielder.yield({ type: "token", content: chunk })
        end
      end

      def handle_unsafe(yielder)
        yielder.yield({ type: "token", content: "I can't help with that request." })
      end

      # ============================================================
      # Parsing helpers
      # ============================================================

      def parse_classification(raw)
        parsed = JSON.parse(raw, symbolize_names: true)
        type = parsed[:type]
        type = "data" unless VALID_TYPES.include?(type)
        {
          type: type,
          confidence: parsed[:confidence].is_a?(Numeric) ? parsed[:confidence] : 0.5,
          searchTerms: parsed[:searchTerms].is_a?(Array) ? parsed[:searchTerms] : []
        }
      rescue JSON::ParserError
        { type: "data", confidence: 0.5, searchTerms: [] }
      end

      def parse_sql_generation(raw)
        parsed = JSON.parse(raw, symbolize_names: true)
        sql = parsed[:sql]
        sql = "" unless sql.is_a?(String) && !sql.empty?
        { sql: sql, explanation: (parsed[:explanation] || "").to_s }
      rescue JSON::ParserError
        { sql: "", explanation: "" }
      end

      # ============================================================
      # Formatting helpers
      # ============================================================

      def format_code_context(results)
        return "" if results.empty?

        results.map { |r| "File: #{r[:file]}\n#{r[:content]}" }.join("\n\n")
      end

      def to_code_snippets(results)
        results.map { |r| { file_path: r[:file], content: r[:content] } }
      end

      def friendly_error_message(exception)
        msg = exception.message.to_s
        cls = exception.class.name.to_s

        if cls.start_with?("PG::")
          case cls
          when "PG::ConnectionBad"
            "I'm having trouble connecting right now. Please try again in a moment."
          when "PG::QueryCanceled"
            "That question required too much processing. Could you try a more specific question?"
          else
            "I couldn't find the information needed to answer that. Could you rephrase your question?"
          end
        elsif msg.include?("timeout") || msg.include?("Timeout")
          "That took too long to process. Try asking a more specific question."
        elsif msg.include?("401") || msg.include?("Unauthorized")
          "I'm having trouble reaching the AI service. Please check the API key configuration."
        elsif msg.include?("429") || msg.include?("rate limit")
          "The AI service is busy right now. Please try again in a moment."
        else
          "Something went wrong while processing your question. Please try again."
        end
      end

      # Attempt to fix an UndefinedColumn error by finding the correct column name.
      # Returns the corrected SQL string, or nil if no fix could be determined.
      def try_fix_column(error_message, sql, schema)
        return nil unless error_message.include?("UndefinedColumn") || error_message.include?("does not exist")

        # Extract "alias.column" from error: column jt.name does not exist
        col_match = error_message.match(/column\s+"?(\w+)\.(\w+)"?\s+does not exist/i)
        return nil unless col_match

        table_alias = col_match[1]
        bad_col = col_match[2]

        # Find the real table name from the SQL (e.g., "FROM job_types jt" → jt = job_types)
        alias_match = sql.match(/(?:FROM|JOIN)\s+(\w+)\s+#{Regexp.escape(table_alias)}\b/i)
        return nil unless alias_match
        real_table = alias_match[1]

        # Extract columns for this table from the schema
        table_line = schema.split("\n").find { |l| l.start_with?("TABLE #{real_table} ") || l.start_with?("TABLE #{real_table}\t") }
        return nil unless table_line

        cols_in_parens = table_line.match(/\((.+)\)/)
        return nil unless cols_in_parens
        columns = cols_in_parens[1].scan(/(\w+)\s+\w+/).flatten

        # Find the best replacement: prefer title > label > description for "name" hallucination
        replacement = nil
        if %w[name names].include?(bad_col.downcase)
          replacement = (columns & %w[title label first_name display_name description]).first
        end
        # Fallback: fuzzy match (column containing the bad name or vice versa)
        replacement ||= columns.find { |c| c.include?(bad_col) || bad_col.include?(c) }

        return nil unless replacement

        # Replace in SQL: "alias.bad_col" → "alias.replacement"
        fixed = sql.gsub(/\b#{Regexp.escape(table_alias)}\.#{Regexp.escape(bad_col)}\b/i, "#{table_alias}.#{replacement}")
        # Also fix ORDER BY or other unqualified uses
        fixed == sql ? nil : fixed
      end

      # Build a helpful hint from the PG error and schema, e.g.:
      #   "Column 'name' does not exist on job_types. Available columns: id, title, ..."
      def build_column_hint(error_message, schema)
        # Extract the bad column from PG::UndefinedColumn errors
        if error_message.include?("UndefinedColumn") || error_message.include?("does not exist")
          # Try to extract "column X does not exist" or "column X.Y does not exist"
          col_match = error_message.match(/column[:\s]+"?(\w+\.)?(\w+)"?\s+(does not exist|of relation)/i)
          if col_match
            bad_col = col_match[2]
            # Find tables in the schema that might be relevant
            table_columns = {}
            current_table = nil
            schema.split("\n").each do |line|
              if line.start_with?("TABLE ")
                current_table = line.match(/^TABLE (\S+)/)[1]
                # Extract column names from the TABLE line (format: "TABLE name (col1 TYPE, col2 TYPE, ...)")
                cols_match = line.match(/\((.+)\)/)
                if cols_match
                  table_columns[current_table] = cols_match[1].scan(/(\w+)\s+\w+/).flatten
                end
              end
            end

            # Find tables whose columns DON'T include the bad column
            hints = table_columns.map do |table, cols|
              next if cols.include?(bad_col)
              "Table '#{table}' columns include: #{cols.first(15).join(', ')}"
            end.compact

            return "HINT: Column '#{bad_col}' does not exist. #{hints.first(3).join(". ")}.\n\n" unless hints.empty?
          end
        end
        ""
      end

      def log_error(exception)
        if defined?(Rails) && Rails.respond_to?(:logger) && Rails.logger
          Rails.logger.error("[SqlChatbot] #{exception.class}: #{exception.message}")
          Rails.logger.error(exception.backtrace&.first(5)&.join("\n")) if exception.backtrace
        end
      end

      # Attempt the grammar-first path.
      # Returns :handled if grammar hit + SQL executed + answer streamed.
      # Returns :miss if grammar missed or disabled — caller should fall through to LLM path.
      def try_grammar_path(yielder, question, history)
        registry = defined?(SqlChatbot) && SqlChatbot.respond_to?(:registry) ? SqlChatbot.registry : nil
        config   = defined?(SqlChatbot) && SqlChatbot.respond_to?(:config) ? SqlChatbot.config : nil

        return :miss unless registry
        return :miss if config && config.respond_to?(:grammar_enabled) && config.grammar_enabled == false

        call_llm = ->(messages) { @llm.call(messages, json_mode: true) }
        threshold = config.respond_to?(:grammar_confidence_threshold) ? config.grammar_confidence_threshold : 0.7
        miss_log  = resolved_miss_log_path(config)

        pipeline = GrammarPipeline.new(
          registry: registry,
          call_llm: call_llm,
          confidence_threshold: threshold,
          miss_log_path: miss_log
        )

        result = pipeline.try(question: question, history: history)

        unless result[:ok]
          yielder.yield({ type: "grammar_fallback", data: { reason: result[:reason] } })
          return :miss
        end

        sql = result[:sql]

        yielder.yield({ type: "grammar_matched", data: {} })
        yielder.yield({ type: "sql", query: sql, explanation: "grammar" })

        validation = SqlExecutor.validate_sql(sql)
        unless validation[:valid]
          yielder.yield({ type: "error", message: "SQL validation failed: #{validation[:reason]}" })
          return :handled
        end

        yielder.yield({ type: "executing" })

        begin
          db_result = SqlExecutor.execute_sql(validation[:sql])
        rescue => e
          log_error(e)
          yielder.yield({ type: "error", message: friendly_error_message(e) })
          return :handled
        end

        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: "data",
          sql_result: db_result[:rows],
          sql_query: validation[:sql],
          history: history
        )

        @llm.stream(answer_messages) do |chunk|
          yielder.yield({ type: "token", content: chunk })
        end

        :handled
      rescue => e
        log_error(e)
        # Grammar path failure — fall through to LLM path
        :miss
      end

      def resolved_miss_log_path(config)
        if config && config.respond_to?(:grammar_miss_log_path) && config.grammar_miss_log_path
          config.grammar_miss_log_path
        elsif defined?(Rails) && Rails.respond_to?(:root) && Rails.root
          Rails.root.join("log", "grammar-misses.ndjson").to_s
        else
          "/tmp/grammar-misses.ndjson"
        end
      end

      def build_route_list
        routes_by_path = {}

        # 1. Code indexer routes (lowest priority)
        @code_indexer.get_routes.each do |r|
          routes_by_path[r[:path]] ||= { path: r[:path], method: r[:method], label: nil, source: "code_indexer" }
        end

        # 2. Manifest routes from widget (higher priority, has labels)
        if @manifest && @manifest["routes"]
          @manifest["routes"].each do |r|
            routes_by_path[r["path"]] = {
              path: r["path"],
              method: r["method"] || "GET",
              label: r["label"],
              parentPath: r["parentPath"],
              source: "manifest"
            }
          end
        end

        # 3. RouteIntrospector routes (highest priority for Rails apps)
        if @route_introspector_data
          @route_introspector_data.each do |r|
            routes_by_path[r[:path]] = r.merge(source: "introspector")
          end
        end

        return "No application routes detected." if routes_by_path.empty?

        lines = routes_by_path.values
          .select { |r| r[:method] == "GET" }
          .map do |r|
            parent_note = r[:parentPath] ? " (under #{r[:parentPath]})" : ""
            label = r[:label] || r[:path].split("/").last&.capitalize || "Page"
            "- #{r[:path]} \u2014 #{label}#{parent_note}"
          end

        "## Available Application Pages\n#{lines.join("\n")}"
      end
    end
  end
end
