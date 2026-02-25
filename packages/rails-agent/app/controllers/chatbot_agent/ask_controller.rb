require 'chatbot_agent/orchestration/ask_orchestrator'

module ChatbotAgent
  class AskController < ApplicationController
    include ActionController::Live

    def create
      question = params[:question]
      history = (params[:history] || []).map { |h| h.respond_to?(:to_unsafe_h) ? h.to_unsafe_h : h.to_h }
      page_context = params[:pageContext]

      unless question.present?
        render json: { error: 'question is required' }, status: :bad_request
        return
      end

      orchestrator = ChatbotAgent::Orchestration::AskOrchestrator.new(
        pipeline: ChatbotAgent.pipeline,
        cloud_client: ChatbotAgent::CloudClient.new,
        sql_validator: ->(sql) { ChatbotAgent::Db::SqlValidator.validate(sql) },
        sql_executor: ->(sql) { ChatbotAgent::Db::SqlExecutor.execute(sql) },
      )

      response.headers['Content-Type'] = 'text/event-stream'
      response.headers['Cache-Control'] = 'no-cache'
      response.headers['X-Accel-Buffering'] = 'no'

      result = orchestrator.ask(
        question: question,
        history: history,
        page_context: page_context,
      ) do |token|
        response.stream.write("data: #{JSON.generate(token: token)}\n\n")
      end

      if result[:status] == :not_ready
        response.stream.write("data: #{JSON.generate(error: result[:message])}\n\n")
      elsif result[:status] == :error
        response.stream.write("data: #{JSON.generate(error: result[:message])}\n\n")
      end

      response.stream.write("data: [DONE]\n\n")
    ensure
      response.stream.close
    end
  end
end
