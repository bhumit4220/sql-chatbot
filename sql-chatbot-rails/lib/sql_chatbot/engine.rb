# frozen_string_literal: true

module SqlChatbot
  class Engine < ::Rails::Engine
    isolate_namespace SqlChatbot

    initializer "sql_chatbot.build_registry", after: :eager_load! do |_app|
      begin
        require "sql_chatbot/services/registry_builder"
        SqlChatbot.registry = SqlChatbot::Services::RegistryBuilder.new.build
      rescue => e
        Rails.logger&.warn("[sql-chatbot] registry_build_failed: #{e.message}")
        SqlChatbot.registry = nil
      end
    end
  end
end
