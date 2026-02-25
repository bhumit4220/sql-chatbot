require 'spec_helper'
require 'chatbot_agent/middleware/meta_tag'

RSpec.describe ChatbotAgent::Middleware::MetaTag do
  let(:meta_tag) { '<meta name="chatbot-agent" content="/chatbot">' }

  def build_app(body, content_type: 'text/html', status: 200)
    ->(_env) { [status, { 'Content-Type' => content_type }, [body]] }
  end

  def call_middleware(app, env = {})
    middleware = described_class.new(app)
    middleware.call(env)
  end

  describe 'HTML injection' do
    it 'injects meta tag before </head>' do
      app = build_app('<html><head><title>Test</title></head><body></body></html>')
      status, headers, body = call_middleware(app)

      response_body = body.first
      expect(response_body).to include(meta_tag)
      expect(response_body).to include("#{meta_tag}\n</head>")
    end

    it 'injects meta tag with case-insensitive </HEAD>' do
      app = build_app('<html><HEAD><title>Test</title></HEAD><body></body></html>')
      status, headers, body = call_middleware(app)

      response_body = body.first
      expect(response_body).to include(meta_tag)
    end

    it 'does not duplicate meta tag if already present' do
      html = "<html><head>#{meta_tag}<title>Test</title></head><body></body></html>"
      app = build_app(html)
      status, headers, body = call_middleware(app)

      response_body = body.first
      expect(response_body.scan(meta_tag).length).to eq(1)
    end

    it 'updates Content-Length header after injection' do
      original_html = '<html><head></head><body></body></html>'
      app = build_app(original_html)
      status, headers, body = call_middleware(app)

      response_body = body.first
      expect(headers['Content-Length'].to_i).to eq(response_body.bytesize)
    end
  end

  describe 'non-HTML responses' do
    it 'does not modify JSON responses' do
      json = '{"key": "value"}'
      app = build_app(json, content_type: 'application/json')
      status, headers, body = call_middleware(app)

      expect(body.first).to eq(json)
    end

    it 'does not modify plain text responses' do
      text = 'Hello World'
      app = build_app(text, content_type: 'text/plain')
      status, headers, body = call_middleware(app)

      expect(body.first).to eq(text)
    end

    it 'does not modify CSS responses' do
      css = 'body { color: red; }'
      app = build_app(css, content_type: 'text/css')
      status, headers, body = call_middleware(app)

      expect(body.first).to eq(css)
    end
  end

  describe 'edge cases' do
    it 'handles HTML without </head> tag gracefully' do
      html = '<html><body>No head tag</body></html>'
      app = build_app(html)
      status, headers, body = call_middleware(app)

      expect(body.first).to eq(html)
    end

    it 'handles empty body' do
      app = build_app('')
      status, headers, body = call_middleware(app)

      expect(body.first).to eq('')
    end

    it 'passes through non-200 status codes' do
      app = build_app('<html><head></head></html>', status: 302)
      status, headers, body = call_middleware(app)

      expect(status).to eq(302)
    end

    it 'handles text/html with charset' do
      app = build_app('<html><head></head><body></body></html>', content_type: 'text/html; charset=utf-8')
      status, headers, body = call_middleware(app)

      expect(body.first).to include(meta_tag)
    end
  end

  describe 'custom mount path' do
    it 'uses configured mount path in meta tag' do
      app = build_app('<html><head></head><body></body></html>')
      middleware = described_class.new(app, mount_path: '/admin/chatbot')
      status, headers, body = middleware.call({})

      expect(body.first).to include('content="/admin/chatbot"')
    end
  end
end
