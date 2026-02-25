module ChatbotAgent
  class Engine < ::Rails::Engine
    isolate_namespace ChatbotAgent

    initializer 'chatbot_agent.pipeline' do
      config.after_initialize do
        if ChatbotAgent.config.api_key.present?
          ChatbotAgent.initialize_pipeline!
          Rails.logger.info "[ChatbotAgent] Discovery pipeline initialized"
        else
          Rails.logger.warn "[ChatbotAgent] No API key configured, skipping pipeline initialization"
        end
      end
    end

    initializer 'chatbot_agent.meta_tag_middleware' do |app|
      require 'chatbot_agent/middleware/meta_tag'
      app.middleware.use ChatbotAgent::Middleware::MetaTag
    end
  end
end
