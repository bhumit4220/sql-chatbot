# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/intent_extractor"

RSpec.describe SqlChatbot::Grammar::IntentExtractor do
  let(:user_entity) do
    SqlChatbot::Grammar::Entity.new(
      name: "user",
      table: "users",
      row_count: 100,
      primary_key: "id",
      timestamps: {},
      fields: {
        "status" => SqlChatbot::Grammar::Field.new(
          column: "status", type: "enum", nullable: false,
          enum_values: { "active" => 1 }, searchable: false
        )
      },
      scopes: {},
      associations: {},
      ranking_candidates: []
    )
  end

  let(:registry) do
    SqlChatbot::Grammar::Registry.new(
      framework: "rails",
      entities: { "user" => user_entity },
      aliases: {}
    )
  end

  it "parses matched intent from LLM JSON" do
    fake_llm = ->(_messages) do
      JSON.generate({
        status: "matched", primitive: "COUNT", entity: "user",
        modifiers: [{ kind: "where", field: "status", op: "eq", value: "active" }],
        confidence: 0.92
      })
    end
    result = described_class.extract(
      question: "how many active users",
      registry: registry,
      history: [],
      call_llm: fake_llm
    )
    expect(result[:status]).to eq("matched")
    expect(result[:primitive]).to eq(:COUNT)
  end

  it "returns unmatched when LLM confidence below threshold" do
    fake_llm = ->(_messages) do
      JSON.generate({ status: "matched", primitive: "COUNT", entity: "user", modifiers: [], confidence: 0.3 })
    end
    result = described_class.extract(
      question: "x",
      registry: registry,
      history: [],
      call_llm: fake_llm,
      confidence_threshold: 0.7
    )
    expect(result[:status]).to eq("unmatched")
  end

  it "returns unmatched when LLM returns malformed JSON" do
    fake_llm = ->(_messages) { "not json at all" }
    result = described_class.extract(
      question: "x",
      registry: registry,
      history: [],
      call_llm: fake_llm
    )
    expect(result[:status]).to eq("unmatched")
    expect(result[:reason]).to eq("malformed_json")
  end

  it "passes entity candidates into prompt" do
    captured_messages = nil
    fake_llm = ->(messages) do
      captured_messages = messages
      JSON.generate({ status: "unmatched", confidence: 0, reason: "x" })
    end
    described_class.extract(
      question: "users",
      registry: registry,
      history: [],
      call_llm: fake_llm
    )
    serialized = captured_messages.to_json
    expect(serialized).to include("user")
    expect(serialized).to include("COUNT")
  end
end
