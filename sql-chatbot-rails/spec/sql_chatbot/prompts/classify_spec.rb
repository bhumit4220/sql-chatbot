require "spec_helper"
require "sql_chatbot/prompts/classify"

RSpec.describe SqlChatbot::Prompts::Classify do
  describe ".build_messages" do
    it "returns system and user messages" do
      messages = described_class.build_messages(
        question: "How many users?",
        schema_summary: "TABLE users (id INT PK, name VARCHAR)"
      )

      expect(messages.length).to eq(2)
      expect(messages[0][:role]).to eq("system")
      expect(messages[1][:role]).to eq("user")
    end

    it "includes all 7 question types in system prompt" do
      messages = described_class.build_messages(question: "test", schema_summary: "")
      system = messages[0][:content]

      %w[data data_with_code code navigation guidance greeting unsafe].each do |type|
        expect(system).to include(%("#{type}"))
      end
    end

    it "includes schema in user message" do
      messages = described_class.build_messages(
        question: "test",
        schema_summary: "TABLE users (id INT)"
      )
      expect(messages[1][:content]).to include("TABLE users (id INT)")
    end

    it "includes conversation history when provided" do
      messages = described_class.build_messages(
        question: "how many?",
        schema_summary: "",
        history: [{ role: "user", content: "show users" }, { role: "assistant", content: "here are users" }]
      )
      expect(messages[1][:content]).to include("Conversation history:")
      expect(messages[1][:content]).to include("show users")
    end

    it "includes page context when provided" do
      messages = described_class.build_messages(
        question: "test",
        schema_summary: "",
        page_context: "/admin/users"
      )
      expect(messages[1][:content]).to include("/admin/users")
    end

    it "limits history to last 4 messages" do
      history = 6.times.map { |i| { role: "user", content: "msg#{i}" } }
      messages = described_class.build_messages(question: "test", schema_summary: "", history: history)
      content = messages[1][:content]
      expect(content).not_to include("msg0")
      expect(content).not_to include("msg1")
      expect(content).to include("msg2")
      expect(content).to include("msg5")
    end
  end
end
