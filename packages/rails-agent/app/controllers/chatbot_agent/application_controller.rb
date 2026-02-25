module ChatbotAgent
  class ApplicationController < ::ActionController::Base
    before_action :authenticate_chatbot_user!

    private

    def authenticate_chatbot_user!
      auth = ChatbotAgent::Middleware::Auth.new
      unless auth.authorized?(request)
        render json: { error: 'Unauthorized' }, status: :unauthorized
      end
    end
  end
end
