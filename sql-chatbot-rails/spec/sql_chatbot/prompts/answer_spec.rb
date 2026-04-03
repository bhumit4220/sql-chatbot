# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/prompts/answer"

RSpec.describe SqlChatbot::Prompts::Answer do
  describe ".build_messages" do
    %w[data data_with_code code navigation guidance greeting unsafe].each do |type|
      it "builds messages for #{type} type" do
        messages = described_class.build_messages(question: "test", type: type)
        expect(messages.length).to eq(2)
        expect(messages[0][:role]).to eq("system")
      end
    end

    it "includes SQL results for data type" do
      messages = described_class.build_messages(
        question: "how many?",
        type: "data",
        sql_result: [{ "count" => 42 }],
        sql_query: "SELECT COUNT(*) FROM users"
      )
      expect(messages[1][:content]).to include("SELECT COUNT(*)")
      expect(messages[1][:content]).to include("42")
    end

    it "includes code snippets for code type" do
      messages = described_class.build_messages(
        question: "how does pricing work?",
        type: "code",
        code_snippets: [{ file_path: "app/models/order.rb", content: "def total; price * qty; end" }]
      )
      expect(messages[1][:content]).to include("order.rb")
      expect(messages[1][:content]).to include("price * qty")
    end

    it "includes navigation links" do
      messages = described_class.build_messages(
        question: "where is settings?",
        type: "navigation",
        navigation_links: ["GET /settings → settings/index"]
      )
      expect(messages[1][:content]).to include("/settings")
    end

    context "with route_list for navigation" do
      it "includes route list for navigation type" do
        messages = described_class.build_messages(
          question: "where is settings?",
          type: "navigation",
          route_list: "## Available Application Pages\n- /admin/settings — Settings"
        )
        user_content = messages.last[:content]
        expect(user_content).to include("Available Application Pages")
        expect(user_content).to include("/admin/settings")
      end

      it "does not include route list for data type" do
        messages = described_class.build_messages(
          question: "how many users?",
          type: "data",
          route_list: "## Available Application Pages\n- /admin/users — Users"
        )
        user_content = messages.last[:content]
        expect(user_content).not_to include("Available Application Pages")
      end
    end
  end

  describe ".format_sql_result" do
    it "formats rows as table" do
      rows = [{ "name" => "Alice", "age" => 30 }, { "name" => "Bob", "age" => 25 }]
      result = described_class.format_sql_result(rows)
      expect(result).to include("name | age")
      expect(result).to include("Alice | 30")
    end

    it "returns zero results directive for empty rows" do
      expect(described_class.format_sql_result([])).to eq("[ZERO RESULTS] No matching records exist.")
    end
  end
end
