module ChatbotAgent
  class Configuration
    attr_accessor :api_key, :auth_check, :codebase_path, :cloud_url

    def initialize
      @api_key = nil
      @auth_check = ->(_request) { true }  # default: allow all (development)
      @codebase_path = nil  # defaults to Rails.root at runtime
      @cloud_url = ENV['CHATBOT_CLOUD_URL'] || 'https://api.chatbot-agent.com'
      @custom_context = nil
    end

    def custom_context=(value)
      @custom_context = value&.to_s&.slice(0, 2000)
    end

    def custom_context
      @custom_context
    end
  end
end
