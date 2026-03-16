# frozen_string_literal: true

require "spec_helper"
require "webmock/rspec"
require "sql_chatbot/llm/client"

RSpec.describe SqlChatbot::LLM::Client do
  let(:client) { described_class.new(api_key: "sk-test", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini") }

  describe "#call" do
    it "sends messages and returns content" do
      stub_request(:post, "https://api.openai.com/v1/chat/completions")
        .to_return(status: 200, body: {
          choices: [{ message: { content: '{"type":"greeting"}' } }]
        }.to_json, headers: { "Content-Type" => "application/json" })

      result = client.call([{ role: "user", content: "hi" }])
      expect(result).to eq('{"type":"greeting"}')
    end

    it "supports json_mode option" do
      stub_request(:post, "https://api.openai.com/v1/chat/completions")
        .with(body: hash_including("response_format" => { "type" => "json_object" }))
        .to_return(status: 200, body: {
          choices: [{ message: { content: '{"type":"data"}' } }]
        }.to_json, headers: { "Content-Type" => "application/json" })

      result = client.call([{ role: "user", content: "test" }], json_mode: true)
      expect(result).to eq('{"type":"data"}')
    end
  end

  describe "#stream" do
    it "yields content chunks" do
      chunks = [
        "data: #{({ choices: [{ delta: { content: "Hello" } }] }).to_json}\n\n",
        "data: #{({ choices: [{ delta: { content: " world" } }] }).to_json}\n\n",
        "data: [DONE]\n\n",
      ].join

      stub_request(:post, "https://api.openai.com/v1/chat/completions")
        .to_return(status: 200, body: chunks, headers: { "Content-Type" => "text/event-stream" })

      tokens = []
      client.stream([{ role: "user", content: "hi" }]) { |chunk| tokens << chunk }
      expect(tokens).to eq(["Hello", " world"])
    end
  end
end
