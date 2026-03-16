# frozen_string_literal: true

module SqlChatbot
  class ChatbotController < ActionController::Base
    include ActionController::Live
    skip_before_action :verify_authenticity_token, only: [:ask, :refresh]

    def widget
      if SqlChatbot.config&.secret
        cookies[:chatbot_token] = {
          value: SqlChatbot.config.secret,
          httponly: true,
          same_site: :strict,
        }
      end
      widget_path = File.join(SqlChatbot::Engine.root, "vendor", "assets", "widget.js")
      render body: File.read(widget_path), content_type: "application/javascript"
    end

    def health
      ensure_initialized!
      render json: {
        status: "ok",
        tables: SqlChatbot.schema_service.table_count,
        codeFiles: SqlChatbot.code_indexer.file_count,
      }
    rescue => e
      render json: { status: "error", message: e.message }, status: 500
    end

    def ask
      return render_unauthorized unless authorized?
      ensure_initialized!

      question = params[:question]
      return render json: { error: "question is required" }, status: 400 if question.blank?

      response.headers["Content-Type"] = "text/event-stream"
      response.headers["Cache-Control"] = "no-cache"
      response.headers["Connection"] = "keep-alive"

      SqlChatbot.orchestrator.handle_question(
        question: question,
        page_context: params[:pageContext],
        history: params[:history],
      ).each do |event|
        response.stream.write("data: #{event.to_json}\n\n")
      end
    rescue => e
      unless response.stream.closed?
        response.stream.write("data: #{({ type: "error", message: e.message }).to_json}\n\n")
      end
    ensure
      response.stream.close
    end

    def refresh
      return render_unauthorized unless authorized?
      ensure_initialized!
      SqlChatbot.schema_service.discover
      SqlChatbot.code_indexer.index(SqlChatbot.config.code_paths)
      render json: { status: "refreshed" }
    rescue => e
      render json: { status: "error", message: e.message }, status: 500
    end

    private

    def authorized?
      return true unless SqlChatbot.config&.secret
      auth_header = request.headers["Authorization"]
      if auth_header
        scheme, token = auth_header.split(" ", 2)
        return true if scheme == "Bearer" && token == SqlChatbot.config.secret
      end
      return true if cookies[:chatbot_token] == SqlChatbot.config.secret
      false
    end

    def render_unauthorized
      render json: { error: "Unauthorized" }, status: 401
    end

    def ensure_initialized!
      SqlChatbot.ensure_initialized!
    end
  end
end
