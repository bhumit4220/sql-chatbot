Gem::Specification.new do |spec|
  spec.name          = "chatbot_agent"
  spec.version       = "0.1.0"
  spec.authors       = ["SQL Chatbot Team"]
  spec.summary       = "AI chatbot middleware for Rails admin panels"
  spec.description   = "Mount in your Rails app to enable natural language database queries via Chrome extension"
  spec.license       = "MIT"
  spec.required_ruby_version = ">= 2.7.0"

  spec.files = Dir["lib/**/*", "app/**/*", "config/**/*", "LICENSE", "README.md"]

  spec.add_dependency "rails", ">= 5.2"
  spec.add_dependency "pg_query", ">= 4.0"
  spec.add_dependency "sqlite3", ">= 1.4"
  spec.add_dependency "net-http"

  spec.add_development_dependency "rspec-rails"
  spec.add_development_dependency "webmock"
end
