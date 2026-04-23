# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/services/grammar_pipeline"
require "sql_chatbot/grammar/registry"
require "tempfile"

RSpec.describe SqlChatbot::Services::GrammarPipeline do
  let(:user_entity) do
    SqlChatbot::Grammar::Entity.new(
      name: "user", table: "users", display_label: "User", row_count: 100, primary_key: "id",
      timestamps: {}, fields: {
        "status" => SqlChatbot::Grammar::Field.new(
          column: "status", type: :enum, nullable: false,
          enum_values: { "active" => 1 }, searchable: false
        ),
      }, scopes: {}, associations: {}, ranking_candidates: []
    )
  end
  let(:registry) { SqlChatbot::Grammar::Registry.new(framework: "rails", entities: { "user" => user_entity }) }
  let(:log_path) { Tempfile.new(["grammar-miss", ".ndjson"]).path }

  it "returns {ok:true, sql:...} on matched intent" do
    call_llm = ->(_m) {
      JSON.generate({
        status: "matched",
        primitive: "COUNT",
        entity: "user",
        modifiers: [{ kind: "where", field: "status", op: "eq", value: "active" }],
        confidence: 0.95
      })
    }
    pipeline = described_class.new(registry: registry, call_llm: call_llm, miss_log_path: log_path)
    result = pipeline.try(question: "how many active users")
    expect(result[:ok]).to be true
    expect(result[:sql]).to include("COUNT(*)")
    expect(result[:sql]).to include("users")
  end

  it "returns {ok:false} and logs miss on unmatched intent" do
    call_llm = ->(_m) { JSON.generate({ status: "unmatched", confidence: 0.2, reason: "too vague" }) }
    pipeline = described_class.new(registry: registry, call_llm: call_llm, miss_log_path: log_path)
    result = pipeline.try(question: "anything weird")
    expect(result[:ok]).to be false
    expect(File.read(log_path)).to include("too vague")
  end
end
