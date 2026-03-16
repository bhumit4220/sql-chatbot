# frozen_string_literal: true

require "rails"
require "action_controller/railtie"
require "sql_chatbot_rails"

module Dummy
  class Application < Rails::Application
    config.load_defaults 7.1
    config.eager_load = false
    config.active_support.deprecation = :stderr

    # No database needed for these integration tests
    config.secret_key_base = "test-secret-key-base-for-dummy-app-only"
  end
end
