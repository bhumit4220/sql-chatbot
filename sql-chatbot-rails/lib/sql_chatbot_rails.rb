# frozen_string_literal: true

require "sql_chatbot/version"
require "sql_chatbot/configuration"
require "sql_chatbot/llm/client"
require "sql_chatbot/prompts/classify"
require "sql_chatbot/prompts/generate_sql"
require "sql_chatbot/prompts/answer"
require "sql_chatbot/services/sql_executor"
require "sql_chatbot/services/schema_service"
require "sql_chatbot/services/code_indexer"
require "sql_chatbot/services/orchestrator"
require "sql_chatbot/services/model_introspector"
require "sql_chatbot/auth/jwt"
require "sql_chatbot/engine" if defined?(Rails)

module SqlChatbot
  class << self
    attr_accessor :config, :schema_service, :code_indexer, :orchestrator

    def configure
      self.config ||= Configuration.new
      yield(config) if block_given?
    end

    def reset!
      self.config = Configuration.new
      @schema_service = nil
      @code_indexer = nil
      @orchestrator = nil
      @initialized = false
      @init_mutex = Mutex.new
    end

    def ensure_initialized!
      return if @initialized
      @init_mutex ||= Mutex.new
      @init_mutex.synchronize do
        return if @initialized
        cfg = config || Configuration.new

        @schema_service = Services::SchemaService.new
        @schema_service.discover

        # Introspect Rails models for enums and non-standard FKs
        introspector = Services::ModelIntrospector.new
        model_annotations = introspector.introspect
        @schema_service.append_model_annotations(model_annotations)

        @code_indexer = Services::CodeIndexer.new
        @code_indexer.index(cfg.code_paths)

        llm_client = LLM::Client.new(
          api_key: cfg.resolved_api_key,
          base_url: cfg.resolved_base_url,
          model: cfg.resolved_model,
        )

        @orchestrator = Services::Orchestrator.new(
          llm_client: llm_client,
          schema_service: @schema_service,
          code_indexer: @code_indexer,
        )

        @initialized = true
      end
    rescue => e
      @initialized = false
      raise e
    end
  end
end
