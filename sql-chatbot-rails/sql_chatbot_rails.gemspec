# frozen_string_literal: true

require_relative "lib/sql_chatbot/version"

Gem::Specification.new do |spec|
  spec.name          = "sql-chatbot-rails"
  spec.version       = SqlChatbot::VERSION
  spec.authors       = ["Bhumit Patel"]
  spec.email         = ["bhumit4220@gmail.com"]
  spec.summary       = "AI chatbot for any Rails app — auto-discovers schema, indexes code, executes SQL, streams answers via chat widget."
  spec.description   = "Embed an AI-powered database chatbot into any Rails application. Auto-discovers your PostgreSQL schema, indexes your codebase, generates SQL from natural language, and streams answers through a chat widget. Zero configuration required."
  spec.homepage      = "https://github.com/bhumit4220/sql-chatbot"
  spec.license       = "MIT"
  spec.required_ruby_version = ">= 2.7.0"

  spec.files = Dir["lib/**/*", "app/**/*", "config/**/*", "vendor/**/*", "LICENSE", "README.md"]

  spec.add_dependency "rails", ">= 6.0"
  spec.add_dependency "ruby-openai", ">= 6.0"
  spec.add_dependency "pg", ">= 1.0"
  spec.add_dependency "jwt", "~> 2.7"

  spec.add_development_dependency "rspec-rails", "~> 6.0"
  spec.add_development_dependency "webmock", "~> 3.0"
end
