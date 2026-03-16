# frozen_string_literal: true

ENV["RAILS_ENV"] = "test"

# Load Rails BEFORE sql_chatbot_rails so the Engine conditional fires
require_relative "dummy/config/application"
Rails.application.initialize!

require "rspec/rails"

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end
  config.infer_spec_type_from_file_location!
  config.use_transactional_fixtures = false
end
