require 'chatbot_agent/discovery/pipeline'
require 'chatbot_agent/discovery/enum_sampler'
require 'chatbot_agent/cloud_client'
require 'chatbot_agent/code/search'

module ChatbotAgent
  module Orchestration
    class AskOrchestrator
      MAX_SQL_RETRIES = 1

      def initialize(pipeline:, cloud_client:, sql_validator:, sql_executor:)
        @pipeline = pipeline
        @cloud_client = cloud_client
        @sql_validator = sql_validator
        @sql_executor = sql_executor
      end

      # Main entry point. Yields streaming tokens via block.
      # Returns { status:, type:, message:, sql:, data: }
      def ask(question:, history:, page_context: nil, &block)
        return not_ready_response unless @pipeline.ready?

        # Step 1: Classify the question
        classification = @cloud_client.classify(
          question: question,
          schema_summary: build_schema_summary,
          page_context: page_context,
        )
        question_type = classification['type']

        # Step 2: Branch by type
        case question_type
        when 'data'
          handle_data_question(question: question, history: history, page_context: page_context, &block)
        when 'data_with_code'
          handle_data_with_code_question(question: question, history: history, page_context: page_context, &block)
        when 'code'
          handle_code_question(question: question, history: history, page_context: page_context, &block)
        when 'navigation', 'guidance'
          handle_guidance_question(question: question, question_type: question_type, history: history, page_context: page_context, &block)
        else
          { status: :error, type: question_type, message: "Unknown question type: #{question_type}" }
        end
      rescue ChatbotAgent::CloudClient::ServerError, ChatbotAgent::CloudClient::TimeoutError => e
        { status: :error, type: nil, message: "Cloud service error: #{e.message}" }
      rescue => e
        { status: :error, type: nil, message: "Unexpected error: #{e.message}" }
      end

      private

      def handle_data_question(question:, history:, page_context:, code_context: nil, type_label: 'data', &block)
        # Generate SQL
        sql_response = generate_sql_with_retry(
          question: question, history: history, code_context: code_context,
        )
        return sql_response if sql_response[:status] == :error

        sql = sql_response[:sql]

        # Execute SQL
        exec_result = @sql_executor.call(sql)
        unless exec_result[:success]
          return { status: :error, type: type_label, message: "SQL execution failed: #{exec_result[:error]}" }
        end

        # Stream answer
        sql_result = {
          columns: exec_result[:columns],
          rows: exec_result[:rows],
          row_count: exec_result[:row_count],
        }

        @cloud_client.stream_answer(
          question: question,
          question_type: type_label,
          history: history,
          sql_result: sql_result,
          page_context: page_context,
          &block
        )

        { status: :success, type: type_label, sql: sql, data: exec_result }
      end

      def handle_data_with_code_question(question:, history:, page_context:, &block)
        code_context = search_code(question)

        handle_data_question(
          question: question, history: history, page_context: page_context,
          code_context: code_context, type_label: 'data_with_code', &block
        )
      end

      def handle_code_question(question:, history:, page_context:, &block)
        code_snippets = search_code(question)

        @cloud_client.stream_answer(
          question: question,
          question_type: 'code',
          history: history,
          code_snippets: code_snippets,
          page_context: page_context,
          &block
        )

        { status: :success, type: 'code' }
      end

      def handle_guidance_question(question:, question_type:, history:, page_context:, &block)
        @cloud_client.stream_answer(
          question: question,
          question_type: question_type,
          history: history,
          page_context: page_context,
          &block
        )

        { status: :success, type: question_type }
      end

      def generate_sql_with_retry(question:, history:, code_context:)
        retry_context = nil

        (MAX_SQL_RETRIES + 1).times do |attempt|
          sql_response = @cloud_client.generate_sql(
            question: question,
            schema: build_schema_summary,
            enums: build_enum_string,
            discovered_context: build_discovered_context,
            history: history,
            code_context: code_context,
            retry_context: retry_context,
          )

          generated_sql = sql_response['sql']
          validation = @sql_validator.call(generated_sql)

          if validation[:valid]
            return { status: :ok, sql: validation[:sql] }
          end

          # Set up retry context for next attempt
          retry_context = {
            original_sql: generated_sql,
            rejection_reason: validation[:reason],
          }
        end

        { status: :error, type: 'data', message: "SQL validation failed after retry: #{retry_context[:rejection_reason]}" }
      end

      def search_code(question)
        results = ChatbotAgent::Code::Search.search(
          question, limit: 5, db_path: @pipeline.send(:instance_variable_get, :@index_path)
        )
        return nil if results.empty?

        results.map { |r| { file: r[:file], content: r[:content] } }
      rescue => _e
        nil
      end

      def build_schema_summary
        schema = @pipeline.results[:schema]
        return '' unless schema

        schema.map do |table|
          cols = table[:columns]&.map { |c| c[:name] }&.join(', ') || ''
          "#{table[:table]}(#{cols})"
        end.join('; ')
      end

      def build_enum_string
        enums = @pipeline.results[:enums]
        return '' unless enums

        ChatbotAgent::Discovery::EnumSampler.format_for_prompt(enums)
      end

      def build_discovered_context
        models = @pipeline.results[:models]
        return '' unless models

        lines = []
        models.each do |model_name, info|
          next unless info.is_a?(Hash)

          associations = info[:associations] || []
          associations.each do |assoc|
            fk = assoc[:options]&.dig(:foreign_key)
            if fk
              lines << "#{model_name} belongs_to #{assoc[:name]} via foreign key '#{fk}'"
            end
          end

          scopes = info[:default_scopes] || []
          scopes.each do |scope|
            lines << "#{model_name} has default_scope: #{scope}"
          end

          if info[:soft_delete]
            lines << "#{model_name} uses soft delete (paranoia)"
          end
        end

        custom = ChatbotAgent.config.custom_context
        lines << "Custom context: #{custom}" if custom

        lines.join("\n")
      end

      def not_ready_response
        { status: :not_ready, type: nil, message: 'The chatbot is still learning about this application. Please try again in a moment.' }
      end
    end
  end
end
