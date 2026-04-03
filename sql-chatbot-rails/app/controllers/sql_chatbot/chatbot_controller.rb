# frozen_string_literal: true

module SqlChatbot
  class ChatbotController < ActionController::Base
    include ActionController::Live
    skip_forgery_protection
    before_action :handle_cors

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

    def receive_manifest
      return render_unauthorized unless authorized?
      ensure_initialized!

      manifest = params[:manifest]
      if manifest.present?
        manifest_data = manifest.respond_to?(:to_unsafe_h) ? manifest.to_unsafe_h : manifest.to_h
        SqlChatbot.orchestrator.set_manifest(manifest_data)
        render json: { status: "received", routeCount: manifest["routes"]&.length || 0 }
      else
        render json: { error: "manifest is required" }, status: 400
      end
    rescue => e
      render json: { status: "error", message: e.message }, status: 500
    end

    def create_session
      origin = request.headers["Origin"]

      # Validate origin
      allowed_origins = SqlChatbot.config&.allowed_origins
      if origin && !Auth::Cors.origin_allowed?(origin, allowed_origins)
        return render json: { error: "Origin not allowed" }, status: 403
      end

      # Check auth
      unless authorized?
        return render_unauthorized
      end

      config = SqlChatbot.config
      token = Auth::Jwt.generate_token(
        secret: config.resolved_token_secret,
        origin: origin,
        lifetime_seconds: config.token_lifetime
      )

      render json: { token: token, expires_in: config.token_lifetime }
    end

    def preflight
      head :no_content
    end

    private

    def authorized?
      return true unless SqlChatbot.config&.secret

      auth_header = request.headers["Authorization"]
      if auth_header
        scheme, token = auth_header.split(" ", 2)
        if scheme == "Bearer" && token
          # Try JWT verification first
          begin
            Auth::Jwt.verify_token(token: token, secret: SqlChatbot.config.resolved_token_secret)
            return true
          rescue Auth::Jwt::TokenExpired, Auth::Jwt::TokenInvalid
            # Not a JWT, try secret match
          end

          # Try secret match (existing behavior)
          return true if token == SqlChatbot.config.secret
        end
      end

      # Check cookie (existing behavior)
      return true if cookies[:chatbot_token] == SqlChatbot.config.secret

      false
    end

    def render_unauthorized
      render json: { error: "Unauthorized" }, status: 401
    end

    def handle_cors
      origin = request.headers["Origin"]
      return unless origin

      allowed_origins = SqlChatbot.config&.allowed_origins
      if Auth::Cors.origin_allowed?(origin, allowed_origins)
        Auth::Cors.set_headers(response, origin)
      end
    end

    def ensure_initialized!
      SqlChatbot.ensure_initialized!
    end
  end
end
