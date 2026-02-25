module ChatbotAgent
  module Middleware
    class Auth
      def authorized?(request)
        ChatbotAgent.config.auth_check.call(request)
      rescue => e
        false
      end
    end
  end
end
