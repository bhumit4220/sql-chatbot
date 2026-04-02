# frozen_string_literal: true

module SqlChatbot
  class Configuration
    PROVIDER_PRESETS = {
      "openai"     => { base_url: "https://api.openai.com/v1",      model: "gpt-4o-mini" },
      "openrouter" => { base_url: "https://openrouter.ai/api/v1",   model: "openrouter/free" },
      "groq"       => { base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
      "ollama"     => { base_url: "http://localhost:11434/v1",       model: "llama3.1:8b" },
    }.freeze

    attr_accessor :llm_api_key, :llm_provider, :llm_model, :llm_base_url,
                  :secret, :code_paths, :custom_context,
                  :allowed_origins,  # Array of allowed cross-origin domains
                  :token_lifetime,   # JWT lifetime in seconds (default: 900)
                  :token_secret      # JWT signing secret (auto-generated if nil)

    def initialize
      @llm_provider = "openrouter"
      @code_paths = ["./app"]
      @token_lifetime = 900
      @_resolved_token_secret = nil
    end

    def resolved_token_secret
      @_resolved_token_secret ||= (@token_secret || ENV["CHATBOT_TOKEN_SECRET"] || SecureRandom.hex(32))
    end

    def resolved_base_url
      llm_base_url || PROVIDER_PRESETS.dig(llm_provider, :base_url) || PROVIDER_PRESETS["openrouter"][:base_url]
    end

    def resolved_model
      llm_model || PROVIDER_PRESETS.dig(llm_provider, :model) || PROVIDER_PRESETS["openrouter"][:model]
    end

    def resolved_api_key
      llm_api_key ||
        ENV["LLM_API_KEY"] ||
        ENV["OPENROUTER_API_KEY"] ||
        ENV["OPENAI_API_KEY"] ||
        ENV["GROQ_API_KEY"] ||
        (llm_provider == "ollama" ? "ollama" : nil)
    end
  end
end
