# frozen_string_literal: true

require "sql_chatbot/grammar/intent_extractor"
require "sql_chatbot/grammar/template_compiler"
require "sql_chatbot/grammar/miss_logger"

module SqlChatbot
  module Services
    class GrammarPipeline
      def initialize(registry:, call_llm:, confidence_threshold: 0.7, miss_log_path: nil)
        @registry = registry
        @call_llm = call_llm
        @confidence_threshold = confidence_threshold
        @miss_log_path = miss_log_path
      end

      def try(question:, history: [])
        intent = Grammar::IntentExtractor.extract(
          question: question,
          registry: @registry,
          history: history,
          call_llm: @call_llm,
          confidence_threshold: @confidence_threshold
        )
        result = Grammar::TemplateCompiler.compile(intent, @registry)
        if result[:ok]
          result.merge(intent: intent)
        else
          log_miss(question, result[:reason], intent)
          result.merge(intent: intent)
        end
      rescue => e
        log_miss(question, "grammar_exception: #{e.message}", nil)
        { ok: false, reason: "grammar_exception: #{e.message}" }
      end

      private

      def log_miss(question, reason, extracted)
        return unless @miss_log_path
        Grammar::MissLogger.log(@miss_log_path, { question: question, reason: reason, extracted: extracted })
      end
    end
  end
end
