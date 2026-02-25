require 'chatbot_agent/configuration'

module ChatbotAgent
  class << self
    attr_accessor :configuration

    def configure
      self.configuration ||= Configuration.new
      yield(configuration)
    end

    def config
      configuration || Configuration.new
    end
  end
end

require 'chatbot_agent/engine' if defined?(Rails)
