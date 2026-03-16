SqlChatbot.configure do |c|
  # LLM provider: "openai", "openrouter" (default), "groq", "ollama"
  c.llm_provider = "openrouter"

  # API key (or set OPENROUTER_API_KEY / OPENAI_API_KEY env var)
  c.llm_api_key = ENV["OPENROUTER_API_KEY"]

  # Optional: override model (defaults per provider)
  # c.llm_model = "gpt-4o-mini"

  # Optional: auth secret (enables cookie-based auth for widget)
  # c.secret = ENV["CHATBOT_SECRET"]

  # Code paths to index (defaults to ["./app"])
  # c.code_paths = ["./app", "./lib"]
end
