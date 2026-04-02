# frozen_string_literal: true

require "json"
require "sql_chatbot/prompts/classify"
require "sql_chatbot/prompts/generate_sql"
require "sql_chatbot/prompts/answer"
require "sql_chatbot/services/sql_executor"

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

            schema_summary = @schema.summary
            classify_messages = Prompts::Classify.build_messages(
              question: question,
              schema_summary: schema_summary,
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
              handle_data_with_code(yielder, question, classification, schema_summary, page_context, history)
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

      def handle_data_with_code(yielder, question, classification, schema_summary, page_context, history)
        # Search code index for context
        search_terms = classification[:searchTerms] || []
        code_results = search_terms.empty? ? [] : @code_indexer.search(search_terms)
        code_context = format_code_context(code_results)
        code_snippets = to_code_snippets(code_results)

        question_type = code_context.empty? ? "data" : "data_with_code"

        # Find lookup hints matching the question
        lookup_hints = @schema.find_lookup_hints(question)

        # Generate SQL
        gen_messages = Prompts::GenerateSql.build_messages(
          question: question,
          schema: schema_summary,
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

        # Execute SQL
        yielder.yield({ type: "executing" })

        begin
          result = SqlExecutor.execute_sql(validation[:sql])
        rescue => e
          log_error(e)
          yielder.yield({ type: "error", message: friendly_error_message(e) })
          return
        end

        # Stream answer
        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: question_type,
          sql_result: result[:rows],
          sql_query: validation[:sql],
          code_snippets: code_snippets.empty? ? nil : code_snippets,
          page_context: page_context,
          history: history
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
        route_summary = @code_indexer.get_route_summary
        nav_links = route_summary.is_a?(String) && !route_summary.empty? ? [route_summary] : []

        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: type,
          page_context: page_context,
          navigation_links: nav_links.empty? ? nil : nav_links,
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

      def log_error(exception)
        if defined?(Rails) && Rails.respond_to?(:logger) && Rails.logger
          Rails.logger.error("[SqlChatbot] #{exception.class}: #{exception.message}")
          Rails.logger.error(exception.backtrace&.first(5)&.join("\n")) if exception.backtrace
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
