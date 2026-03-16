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

  # Optional: inject domain-specific context into SQL generation prompts
  # Use this for non-standard FK names, soft-delete conventions, etc.
  # c.custom_context = <<~CONTEXT
  #   jobs.created_by is FK to customers.id (not customer_id)
  #   status=3 means deleted across all tables
  # CONTEXT
end
