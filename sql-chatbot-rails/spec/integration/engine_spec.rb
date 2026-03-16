# frozen_string_literal: true

require "rails_helper"

RSpec.describe "SqlChatbot Engine", type: :request do
  before do
    SqlChatbot.reset!
  end

  # ---------------------------------------------------------------------------
  # Health endpoint
  # ---------------------------------------------------------------------------
  describe "GET /chatbot/api/health" do
    context "when initialized successfully" do
      before do
        schema_service = double("SchemaService", table_count: 12)
        code_indexer = double("CodeIndexer", file_count: 42)

        allow(SqlChatbot).to receive(:ensure_initialized!)
        SqlChatbot.schema_service = schema_service
        SqlChatbot.code_indexer = code_indexer
      end

      it "returns 200 with status ok and counts" do
        get "/chatbot/api/health"

        expect(response).to have_http_status(:ok)
        body = JSON.parse(response.body)
        expect(body["status"]).to eq("ok")
        expect(body["tables"]).to eq(12)
        expect(body["codeFiles"]).to eq(42)
      end
    end

    context "when initialization fails" do
      before do
        allow(SqlChatbot).to receive(:ensure_initialized!).and_raise(
          RuntimeError, "Connection refused"
        )
      end

      it "returns 500 with error message" do
        get "/chatbot/api/health"

        expect(response).to have_http_status(:internal_server_error)
        body = JSON.parse(response.body)
        expect(body["status"]).to eq("error")
        expect(body["message"]).to eq("Connection refused")
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Widget endpoint
  # ---------------------------------------------------------------------------
  describe "GET /chatbot/widget.js" do
    let(:widget_path) do
      File.join(SqlChatbot::Engine.root, "vendor", "assets", "widget.js")
    end

    it "returns 200 with application/javascript content type" do
      get "/chatbot/widget.js"

      expect(response).to have_http_status(:ok)
      expect(response.content_type).to include("application/javascript")
    end

    it "returns the widget.js file content" do
      get "/chatbot/widget.js"

      expected_content = File.read(widget_path)
      expect(response.body).to eq(expected_content)
    end

    context "when secret is configured" do
      before do
        SqlChatbot.configure { |c| c.secret = "test-secret-123" }
      end

      it "sets chatbot_token cookie" do
        get "/chatbot/widget.js"

        expect(response.cookies["chatbot_token"]).to eq("test-secret-123")
      end
    end

    context "when no secret is configured" do
      it "does not set chatbot_token cookie" do
        get "/chatbot/widget.js"

        expect(response.cookies["chatbot_token"]).to be_nil
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Ask endpoint (auth tests)
  # ---------------------------------------------------------------------------
  describe "POST /chatbot/api/ask" do
    let(:mock_orchestrator) do
      double("Orchestrator", handle_question: [
        { type: "answer", content: "test response" },
      ].each)
    end

    before do
      allow(SqlChatbot).to receive(:ensure_initialized!)
      SqlChatbot.orchestrator = mock_orchestrator
    end

    context "when no secret is configured" do
      it "succeeds without authentication" do
        post "/chatbot/api/ask", params: { question: "How many users?" }

        expect(response).to have_http_status(:ok)
        expect(response.media_type).to eq("text/event-stream")
        expect(response.body).to include("data: ")
        expect(response.body).to include("test response")
      end
    end

    context "when question is missing" do
      it "returns 400 with error" do
        post "/chatbot/api/ask", params: {}

        expect(response).to have_http_status(:bad_request)
        body = JSON.parse(response.body)
        expect(body["error"]).to eq("question is required")
      end
    end

    context "when secret is configured" do
      before do
        SqlChatbot.configure { |c| c.secret = "my-secret" }
      end

      it "returns 401 without authentication" do
        post "/chatbot/api/ask", params: { question: "How many users?" }

        expect(response).to have_http_status(:unauthorized)
        body = JSON.parse(response.body)
        expect(body["error"]).to eq("Unauthorized")
      end

      it "succeeds with correct Bearer token" do
        post "/chatbot/api/ask",
             params: { question: "How many users?" },
             headers: { "Authorization" => "Bearer my-secret" }

        expect(response).to have_http_status(:ok)
        expect(response.body).to include("test response")
      end

      it "returns 401 with wrong Bearer token" do
        post "/chatbot/api/ask",
             params: { question: "How many users?" },
             headers: { "Authorization" => "Bearer wrong-secret" }

        expect(response).to have_http_status(:unauthorized)
      end

      it "succeeds with valid cookie authentication" do
        # First get the widget to set the cookie
        get "/chatbot/widget.js"
        cookie = response.cookies["chatbot_token"]
        expect(cookie).to eq("my-secret")

        # Then use the cookie for the ask request
        post "/chatbot/api/ask",
             params: { question: "How many users?" },
             headers: { "Cookie" => "chatbot_token=#{cookie}" }

        expect(response).to have_http_status(:ok)
        expect(response.body).to include("test response")
      end
    end

    context "when orchestrator raises an error" do
      before do
        SqlChatbot.reset!
        allow(SqlChatbot).to receive(:ensure_initialized!)
        orchestrator = double("orchestrator")
        allow(orchestrator).to receive(:handle_question).and_raise(RuntimeError, "LLM timeout")
        allow(SqlChatbot).to receive(:orchestrator).and_return(orchestrator)
      end

      it "streams an error event" do
        post "/chatbot/api/ask", params: { question: "test" }
        expect(response.body).to include("error")
        expect(response.body).to include("LLM timeout")
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Refresh endpoint
  # ---------------------------------------------------------------------------
  describe "POST /chatbot/api/refresh" do
    let(:mock_schema_service) { double("SchemaService", discover: true) }
    let(:mock_code_indexer) { double("CodeIndexer", index: true) }

    before do
      allow(SqlChatbot).to receive(:ensure_initialized!)
      SqlChatbot.schema_service = mock_schema_service
      SqlChatbot.code_indexer = mock_code_indexer
      SqlChatbot.configure { |c| c.code_paths = ["./app"] }
    end

    context "when no secret is configured" do
      it "succeeds and returns refreshed status" do
        post "/chatbot/api/refresh"

        expect(response).to have_http_status(:ok)
        body = JSON.parse(response.body)
        expect(body["status"]).to eq("refreshed")
        expect(mock_schema_service).to have_received(:discover)
        expect(mock_code_indexer).to have_received(:index)
      end
    end

    context "when secret is configured" do
      before do
        SqlChatbot.configure { |c| c.secret = "refresh-secret" }
      end

      it "returns 401 without authentication" do
        post "/chatbot/api/refresh"

        expect(response).to have_http_status(:unauthorized)
      end

      it "succeeds with correct Bearer token" do
        post "/chatbot/api/refresh",
             headers: { "Authorization" => "Bearer refresh-secret" }

        expect(response).to have_http_status(:ok)
        body = JSON.parse(response.body)
        expect(body["status"]).to eq("refreshed")
      end

      it "returns 401 with wrong Bearer token" do
        post "/chatbot/api/refresh",
             headers: { "Authorization" => "Bearer wrong" }

        expect(response).to have_http_status(:unauthorized)
      end
    end
  end
end
