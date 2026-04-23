# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/primitives"

RSpec.describe SqlChatbot::Grammar::Primitives do
  let(:user_entity) do
    SqlChatbot::Grammar::Entity.new(
      name: "user", table: "users", display_label: "User", row_count: 10,
      primary_key: "id", timestamps: {},
      fields: {
        "id"    => SqlChatbot::Grammar::Field.new(column: "id",    type: :int,  nullable: false, searchable: false),
        "name"  => SqlChatbot::Grammar::Field.new(column: "name",  type: :text, nullable: false, searchable: true),
        "email" => SqlChatbot::Grammar::Field.new(column: "email", type: :text, nullable: false, searchable: true),
      },
      scopes: {}, associations: {}, ranking_candidates: []
    )
  end

  def build_entity_with(base, extra_fields)
    SqlChatbot::Grammar::Entity.new(
      name: base.name, table: base.table, display_label: base.display_label,
      row_count: base.row_count, primary_key: base.primary_key, timestamps: base.timestamps,
      fields: base.fields.merge(extra_fields),
      scopes: base.scopes, associations: base.associations, ranking_candidates: base.ranking_candidates
    )
  end

  it "COUNT emits SELECT COUNT(*)" do
    expect(described_class.build(primitive: :COUNT, entity: user_entity))
      .to eq("SELECT COUNT(*) FROM users")
  end

  it "LIST picks sensible display fields" do
    expect(described_class.build(primitive: :LIST, entity: user_entity))
      .to eq("SELECT id, name, email FROM users")
  end

  it "SUM with field" do
    e = build_entity_with(user_entity, "balance" => SqlChatbot::Grammar::Field.new(column: "balance", type: :decimal, nullable: false, searchable: false))
    expect(described_class.build(primitive: :SUM, entity: e, field: "balance"))
      .to eq("SELECT SUM(users.balance) FROM users")
  end

  it "AVG rounds to 2 places" do
    e = build_entity_with(user_entity, "score" => SqlChatbot::Grammar::Field.new(column: "score", type: :decimal, nullable: false, searchable: false))
    expect(described_class.build(primitive: :AVG, entity: e, field: "score"))
      .to eq("SELECT ROUND(AVG(users.score), 2) FROM users")
  end

  it "MIN_MAX requires which" do
    e = build_entity_with(user_entity, "score" => SqlChatbot::Grammar::Field.new(column: "score", type: :decimal, nullable: false, searchable: false))
    expect { described_class.build(primitive: :MIN_MAX, entity: e, field: "score") }
      .to raise_error(/which/)
  end

  it "TOP_N uses provided rank_field" do
    e = build_entity_with(user_entity, "created_at" => SqlChatbot::Grammar::Field.new(column: "created_at", type: :timestamp, nullable: false, searchable: false))
    e = SqlChatbot::Grammar::Entity.new(
      name: e.name, table: e.table, display_label: e.display_label,
      row_count: e.row_count, primary_key: e.primary_key, timestamps: e.timestamps,
      fields: e.fields, scopes: e.scopes, associations: e.associations,
      ranking_candidates: ["created_at"]
    )
    expect(described_class.build(primitive: :TOP_N, entity: e, n: 5))
      .to include("ORDER BY users.created_at DESC LIMIT 5")
  end

  it "throws when SUM field not on entity" do
    expect { described_class.build(primitive: :SUM, entity: user_entity, field: "nope") }
      .to raise_error(/not in entity/)
  end
end
