# frozen_string_literal: true

module SqlChatbot
  module Generators
    class InstallGenerator < Rails::Generators::Base
      source_root File.expand_path("templates", __dir__)

      def copy_initializer
        template "initializer.rb", "config/initializers/sql_chatbot.rb"
      end

      def add_route
        route 'mount SqlChatbot::Engine, at: "/chatbot"'
      end

      def show_instructions
        say ""
        say "SQL Chatbot installed!", :green
        say "1. Edit config/initializers/sql_chatbot.rb with your API key"
        say '2. Add to your layout: <script src="/chatbot/widget.js"></script>'
        say ""
      end
    end
  end
end
