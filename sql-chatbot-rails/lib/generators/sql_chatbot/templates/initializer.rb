SqlChatbot.configure do |c|
  # LLM provider: "openrouter" (default, free), "openai", "groq", "ollama"
  c.llm_provider = "openrouter"
  c.llm_api_key = ENV["OPENROUTER_API_KEY"]

  # Optional: override model or base URL
  # c.llm_model = "gpt-4o-mini"
  # c.llm_base_url = "https://api.openai.com/v1"

  # Optional: restrict chatbot access (Bearer token or cookie)
  # c.secret = ENV["CHATBOT_SECRET"]

  # Optional: domain-specific context for better SQL generation
  # c.custom_context = "status=3 means Deleted, always exclude deleted records"

  # Cross-origin support (for distributed frontend/backend setups):
  # c.allowed_origins = ["https://your-frontend-domain.com"]
  # c.token_lifetime = 900  # JWT lifetime in seconds (default: 15 minutes)

  # Code paths to index (default: ["./app"])
  # c.code_paths = ["./app", "./lib"]
end
