require 'chatbot_agent/orchestration/status_reporter'

module ChatbotAgent
  class RediscoverController < ApplicationController
    def create
      reporter = ChatbotAgent::Orchestration::StatusReporter.new(
        pipeline: ChatbotAgent.pipeline,
      )
      render json: reporter.rediscover
    end
  end
end
