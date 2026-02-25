Gem::Specification.new do |spec|
  spec.name          = "chatbot_agent"
  spec.version       = "0.1.0"
  spec.authors       = ["SQL Chatbot Team"]
  spec.summary       = "AI chatbot middleware for Rails admin panels"
  spec.description   = "Mount in your Rails app to enable natural language database queries via Chrome extension"
  spec.license       = "MIT"
  spec.required_ruby_version = ">= 2.7.0"

  spec.files = Dir["lib/**/*", "app/**/*", "config/**/*", "LICENSE", "README.md"]

  spec.add_dependency "pg_query", ">= 4.0"
  spec.add_dependency "sqlite3", ">= 1.4", "< 1.7"
  spec.add_dependency "net-http"

  # Rails is a runtime dependency but not required for unit tests
  # The Engine and Railtie only load when Rails is defined

  spec.add_development_dependency "rspec", "~> 3.12"
  spec.add_development_dependency "webmock", "~> 3.19"
end
