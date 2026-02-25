require 'chatbot_agent/orchestration/status_reporter'

module ChatbotAgent
  class StatusController < ApplicationController
    skip_before_action :authenticate_chatbot_user!

    def show
      reporter = ChatbotAgent::Orchestration::StatusReporter.new(
        pipeline: ChatbotAgent.pipeline,
      )
      render json: reporter.status
    end
  end
end
