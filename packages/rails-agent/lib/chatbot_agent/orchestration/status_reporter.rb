require 'chatbot_agent/discovery/pipeline'

module ChatbotAgent
  module Orchestration
    class StatusReporter
      VERSION = '1.0.0'

      def initialize(pipeline:)
        @pipeline = pipeline
      end

      def status
        {
          version: VERSION,
          status: @pipeline.ready? ? 'ready' : 'not_ready',
          discoveryState: @pipeline.state,
          authRequired: ChatbotAgent.config.auth_check != nil,
        }
      end

      def rediscover
        @pipeline.rediscover(async_code_index: true)
        @pipeline.wait_for_code_index

        {
          status: @pipeline.ready? ? 'ready' : 'not_ready',
          message: 'Rediscovery complete.',
          discoveryState: @pipeline.state,
        }
      end
    end
  end
end
