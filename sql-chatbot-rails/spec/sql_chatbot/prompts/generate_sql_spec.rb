require "spec_helper"
require "sql_chatbot/prompts/generate_sql"

RSpec.describe SqlChatbot::Prompts::GenerateSql do
  describe ".build_messages" do
    it "returns system and user messages" do
      messages = described_class.build_messages(
        question: "How many users?",
        schema: "TABLE users (id INT PK)"
      )
      expect(messages.length).to eq(2)
      expect(messages[0][:role]).to eq("system")
    end

    it "includes all 17 rules in system prompt" do
      messages = described_class.build_messages(question: "test", schema: "")
      system = messages[0][:content]
      (1..17).each { |n| expect(system).to include("#{n}.") }
    end

    it "appends code context when provided" do
      messages = described_class.build_messages(
        question: "test",
        schema: "",
        code_context: "enum status: [:active, :inactive]"
      )
      expect(messages[0][:content]).to include("RELEVANT CODE CONTEXT")
      expect(messages[0][:content]).to include("enum status")
    end

    it "includes history" do
      messages = described_class.build_messages(
        question: "how many?",
        schema: "",
        history: [{ role: "user", content: "show users" }]
      )
      expect(messages[1][:content]).to include("show users")
    end

    context "with custom_context configured" do
      before do
        SqlChatbot.configure do |c|
          c.custom_context = "jobs.created_by is the FK to customers.id, NOT customer_id"
        end
      end

      after { SqlChatbot.reset! }

      it "includes custom context in system prompt" do
        messages = described_class.build_messages(question: "test", schema: "tables")
        system_msg = messages.find { |m| m[:role] == "system" }
        expect(system_msg[:content]).to include("ADDITIONAL DOMAIN CONTEXT")
        expect(system_msg[:content]).to include("jobs.created_by is the FK to customers.id")
      end
    end

    context "without custom_context configured" do
      before { SqlChatbot.reset! }

      it "does not include domain context section" do
        messages = described_class.build_messages(question: "test", schema: "tables")
        system_msg = messages.find { |m| m[:role] == "system" }
        expect(system_msg[:content]).not_to include("ADDITIONAL DOMAIN CONTEXT")
      end
    end
  end
end
