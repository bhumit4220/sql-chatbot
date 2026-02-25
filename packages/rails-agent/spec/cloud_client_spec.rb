require 'spec_helper'
require 'webmock/rspec'
require 'chatbot_agent/cloud_client'

RSpec.describe ChatbotAgent::CloudClient do
  let(:cloud_url) { 'http://localhost:3100' }
  let(:api_key) { 'test-api-key-123' }
  let(:client) { described_class.new(cloud_url: cloud_url, api_key: api_key) }

  before do
    WebMock.disable_net_connect!
  end

  after do
    WebMock.allow_net_connect!
  end

  describe '#classify' do
    it 'sends classify request and returns parsed response' do
      stub_request(:post, "#{cloud_url}/api/v1/classify")
        .with(
          headers: { 'Authorization' => "Bearer #{api_key}", 'Content-Type' => 'application/json' },
          body: hash_including('question' => 'How many customers?', 'schemaSummary' => 'TABLE customers (id)')
        )
        .to_return(
          status: 200,
          body: '{"type":"data","confidence":0.95}',
          headers: { 'Content-Type' => 'application/json' }
        )

      result = client.classify(question: 'How many customers?', schema_summary: 'TABLE customers (id)')
      expect(result['type']).to eq('data')
      expect(result['confidence']).to eq(0.95)
    end

    it 'raises on 401 unauthorized' do
      stub_request(:post, "#{cloud_url}/api/v1/classify")
        .to_return(status: 401, body: '{"error":"Invalid API key"}')

      expect {
        client.classify(question: 'test', schema_summary: 'TABLE t (id)')
      }.to raise_error(ChatbotAgent::CloudClient::AuthError, /Invalid API key/)
    end

    it 'raises on 500 server error' do
      stub_request(:post, "#{cloud_url}/api/v1/classify")
        .to_return(status: 500, body: '{"error":"Internal error"}')

      expect {
        client.classify(question: 'test', schema_summary: 'TABLE t (id)')
      }.to raise_error(ChatbotAgent::CloudClient::ServerError)
    end
  end

  describe '#generate_sql' do
    it 'sends generate-sql request and returns SQL' do
      stub_request(:post, "#{cloud_url}/api/v1/generate-sql")
        .with(headers: { 'Authorization' => "Bearer #{api_key}" })
        .to_return(
          status: 200,
          body: '{"sql":"SELECT COUNT(*) FROM customers WHERE status = 1"}',
          headers: { 'Content-Type' => 'application/json' }
        )

      result = client.generate_sql(
        question: 'How many active customers?',
        schema: 'TABLE customers (id, status)',
        enums: 'customers.status: 1=Active',
        discovered_context: '',
        history: []
      )
      expect(result['sql']).to include('SELECT')
    end

    it 'supports retry context' do
      stub_request(:post, "#{cloud_url}/api/v1/generate-sql")
        .with(body: hash_including('retryWithContext'))
        .to_return(
          status: 200,
          body: '{"sql":"SELECT * FROM users LIMIT 500"}',
          headers: { 'Content-Type' => 'application/json' }
        )

      result = client.generate_sql(
        question: 'Show all users',
        schema: 'TABLE users (id)',
        enums: '',
        discovered_context: '',
        history: [],
        retry_context: { original_sql: 'SELECT * FROM pg_roles', rejection_reason: 'Blocked' }
      )
      expect(result['sql']).to include('users')
    end
  end

  describe '#stream_answer' do
    it 'yields tokens from SSE stream' do
      sse_body = "data: {\"token\":\"Hello \"}\n\ndata: {\"token\":\"world!\"}\n\ndata: [DONE]\n\n"

      stub_request(:post, "#{cloud_url}/api/v1/answer")
        .with(headers: { 'Authorization' => "Bearer #{api_key}" })
        .to_return(
          status: 200,
          body: sse_body,
          headers: { 'Content-Type' => 'text/event-stream' }
        )

      tokens = []
      client.stream_answer(
        question: 'How many?',
        question_type: 'data',
        sql_result: '{"rows":[{"count":42}]}',
        history: []
      ) { |token| tokens << token }

      expect(tokens).to eq(['Hello ', 'world!'])
    end
  end
end
