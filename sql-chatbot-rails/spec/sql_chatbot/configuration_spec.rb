# frozen_string_literal: true

require "spec_helper"

RSpec.describe SqlChatbot::Configuration do
  subject(:config) { described_class.new }

  describe "defaults" do
    it "defaults provider to openrouter" do
      expect(config.llm_provider).to eq("openrouter")
    end

    it "defaults code_paths to ['./app']" do
      expect(config.code_paths).to eq(["./app"])
    end

    it "defaults llm_model to nil (uses provider preset)" do
      expect(config.llm_model).to be_nil
    end
  end

  describe "provider presets" do
    it "returns correct base_url for openai" do
      config.llm_provider = "openai"
      expect(config.resolved_base_url).to eq("https://api.openai.com/v1")
    end

    it "returns correct base_url for openrouter" do
      config.llm_provider = "openrouter"
      expect(config.resolved_base_url).to eq("https://openrouter.ai/api/v1")
    end

    it "returns correct base_url for groq" do
      config.llm_provider = "groq"
      expect(config.resolved_base_url).to eq("https://api.groq.com/openai/v1")
    end

    it "returns correct base_url for ollama" do
      config.llm_provider = "ollama"
      expect(config.resolved_base_url).to eq("http://localhost:11434/v1")
    end

    it "allows llm_base_url override" do
      config.llm_provider = "openai"
      config.llm_base_url = "https://custom-proxy.com/v1"
      expect(config.resolved_base_url).to eq("https://custom-proxy.com/v1")
    end

    it "returns correct default model per provider" do
      config.llm_provider = "openai"
      expect(config.resolved_model).to eq("gpt-4o-mini")

      config.llm_provider = "groq"
      expect(config.resolved_model).to eq("llama-3.3-70b-versatile")
    end

    it "uses explicit model over provider default" do
      config.llm_provider = "openai"
      config.llm_model = "gpt-4o"
      expect(config.resolved_model).to eq("gpt-4o")
    end
  end

  describe "api key resolution" do
    # Clear ALL relevant env vars to prevent flaky tests
    around do |example|
      saved = %w[LLM_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY GROQ_API_KEY].map { |k| [k, ENV.delete(k)] }
      example.run
    ensure
      saved.each { |k, v| v ? ENV[k] = v : ENV.delete(k) }
    end

    it "uses llm_api_key when set" do
      config.llm_api_key = "sk-test"
      expect(config.resolved_api_key).to eq("sk-test")
    end

    it "falls back to LLM_API_KEY env var first" do
      ENV["LLM_API_KEY"] = "sk-llm"
      config.llm_api_key = nil
      expect(config.resolved_api_key).to eq("sk-llm")
    end

    it "falls back to OPENROUTER_API_KEY env var" do
      ENV["OPENROUTER_API_KEY"] = "sk-env"
      config.llm_api_key = nil
      expect(config.resolved_api_key).to eq("sk-env")
    end

    it "uses dummy key for ollama" do
      config.llm_provider = "ollama"
      config.llm_api_key = nil
      expect(config.resolved_api_key).to eq("ollama")
    end
  end

  describe "SqlChatbot.configure" do
    it "yields configuration" do
      SqlChatbot.configure do |c|
        c.llm_api_key = "test-key"
        c.llm_provider = "openai"
        c.secret = "my-secret"
        c.code_paths = ["./app", "./lib"]
      end

      expect(SqlChatbot.config.llm_api_key).to eq("test-key")
      expect(SqlChatbot.config.llm_provider).to eq("openai")
      expect(SqlChatbot.config.secret).to eq("my-secret")
      expect(SqlChatbot.config.code_paths).to eq(["./app", "./lib"])
    end

    after { SqlChatbot.reset! }
  end
end
