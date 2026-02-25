require 'spec_helper'
require 'chatbot_agent/middleware/auth'

RSpec.describe ChatbotAgent::Middleware::Auth do
  let(:auth_middleware) { described_class.new }

  describe '#authorized?' do
    it 'returns true when auth_check returns true' do
      ChatbotAgent.configure { |c| c.auth_check = ->(_req) { true } }
      expect(auth_middleware.authorized?(mock_request)).to be true
    end

    it 'returns false when auth_check returns false' do
      ChatbotAgent.configure { |c| c.auth_check = ->(_req) { false } }
      expect(auth_middleware.authorized?(mock_request)).to be false
    end

    it 'returns true with default config (development mode)' do
      ChatbotAgent.configuration = nil
      expect(auth_middleware.authorized?(mock_request)).to be true
    end

    it 'passes the request object to auth_check' do
      received_request = nil
      ChatbotAgent.configure do |c|
        c.auth_check = ->(req) { received_request = req; true }
      end
      request = mock_request
      auth_middleware.authorized?(request)
      expect(received_request).to eq(request)
    end
  end

  after { ChatbotAgent.configuration = nil }

  private

  def mock_request
    double('request', env: {}, headers: {})
  end
end
