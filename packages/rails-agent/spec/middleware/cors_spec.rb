require 'spec_helper'
require 'chatbot_agent/middleware/cors'

RSpec.describe ChatbotAgent::Middleware::Cors do
  let(:app) { ->(env) { [200, { 'Content-Type' => 'text/html' }, ['OK']] } }
  let(:middleware) { described_class.new(app) }

  describe '#call' do
    it 'allows chrome-extension:// origins' do
      env = build_env('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef')
      status, headers, _body = middleware.call(env)
      expect(status).to eq(200)
      expect(headers['Access-Control-Allow-Origin']).to eq('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef')
      expect(headers['Access-Control-Allow-Credentials']).to eq('true')
    end

    it 'blocks non-chrome-extension origins by default' do
      env = build_env('https://evil.com')
      status, _headers, _body = middleware.call(env)
      expect(status).to eq(403)
    end

    it 'allows same-origin requests (no Origin header)' do
      env = build_env(nil)
      status, _headers, _body = middleware.call(env)
      expect(status).to eq(200)
    end

    it 'handles preflight OPTIONS requests' do
      env = build_env('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef', 'OPTIONS')
      status, headers, _body = middleware.call(env)
      expect(status).to eq(204)
      expect(headers['Access-Control-Allow-Methods']).to include('POST')
      expect(headers['Access-Control-Allow-Headers']).to include('Content-Type')
    end

    it 'allows configured allowed_origins' do
      middleware_with_origins = described_class.new(app, allowed_origins: ['https://admin.example.com'])
      env = build_env('https://admin.example.com')
      status, headers, _body = middleware_with_origins.call(env)
      expect(status).to eq(200)
      expect(headers['Access-Control-Allow-Origin']).to eq('https://admin.example.com')
    end
  end

  private

  def build_env(origin, method = 'POST')
    env = {
      'REQUEST_METHOD' => method,
      'PATH_INFO' => '/chatbot/ask',
      'CONTENT_TYPE' => 'application/json',
    }
    env['HTTP_ORIGIN'] = origin if origin
    env
  end
end
