# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/template_compiler"

RSpec.describe SqlChatbot::Grammar::TemplateCompiler do
  let(:registry) do
    entity = SqlChatbot::Grammar::Entity.new(
      name: "user", table: "users", display_label: "User", row_count: 10,
      primary_key: "id",
      timestamps: { "deleted" => "deleted_at" },
      fields: {
        "status" => SqlChatbot::Grammar::Field.new(
          column: "status", type: :enum, nullable: false, searchable: false,
          enum_values: { "active" => 1, "banned" => 2 }
        ),
        "created_at" => SqlChatbot::Grammar::Field.new(
          column: "created_at", type: :timestamp, nullable: false, searchable: false
        ),
        "deleted_at" => SqlChatbot::Grammar::Field.new(
          column: "deleted_at", type: :timestamp, nullable: true, searchable: false
        ),
      },
      scopes: {}, associations: {}, ranking_candidates: []
    )
    SqlChatbot::Grammar::Registry.new(
      framework: "rails",
      entities: { "user" => entity },
      aliases: { "customers" => "user" }
    )
  end

  it "compiles COUNT + where + time + auto soft-delete" do
    intent = {
      status: :matched,
      primitive: :COUNT,
      entity: "user",
      modifiers: [
        { kind: :where, field: "status", op: "eq", value: "active" },
        { kind: :time, field: "created_at", window: "last_30_days" },
      ],
      confidence: 0.9,
    }
    out = described_class.compile(intent, registry)
    expect(out[:ok]).to be true
    expect(out[:sql]).to include("SELECT COUNT(*) FROM users")
    expect(out[:sql]).to include("users.status = 1")
    expect(out[:sql]).to include("users.created_at >= NOW() - INTERVAL '30 days'")
    expect(out[:sql]).to include("users.deleted_at IS NULL")
  end

  it "returns {ok: false} when entity not in registry" do
    intent = { status: :matched, primitive: :COUNT, entity: "ghost", modifiers: [], confidence: 0.9 }
    out = described_class.compile(intent, registry)
    expect(out[:ok]).to be false
    expect(out[:reason]).to match(/entity/)
  end

  it "returns {ok: false} when intent is unmatched" do
    intent = { status: :unmatched, confidence: 0.2, reason: "nope" }
    out = described_class.compile(intent, registry)
    expect(out[:ok]).to be false
  end
end
