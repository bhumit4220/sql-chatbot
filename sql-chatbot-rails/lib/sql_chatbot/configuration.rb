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
                  :secret, :code_paths

    def initialize
      @llm_provider = "openrouter"
      @code_paths = ["./app"]
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
