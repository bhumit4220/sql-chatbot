# frozen_string_literal: true

require "sql_chatbot/version"
require "sql_chatbot/configuration"
require "sql_chatbot/engine" if defined?(Rails)

module SqlChatbot
  class << self
    attr_accessor :config

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
    end
  end
end
