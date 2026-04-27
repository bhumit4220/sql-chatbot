# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/modifiers"

RSpec.describe SqlChatbot::Grammar::Modifiers do
  let(:entity) do
    SqlChatbot::Grammar::Entity.new(
      name: "user", table: "users", display_label: "User", row_count: 10,
      primary_key: "id", timestamps: { "created" => "created_at", "deleted" => "deleted_at" },
      fields: {
        "status" => SqlChatbot::Grammar::Field.new(
          column: "status", type: :enum, nullable: false, searchable: false,
          enum_values: { "active" => 1, "banned" => 2 }
        ),
        "created_at" => SqlChatbot::Grammar::Field.new(
          column: "created_at", type: :timestamp, nullable: false, searchable: false
        ),
      },
      scopes: {}, associations: {}, ranking_candidates: []
    )
  end

  it "applies WHERE with enum value resolution (quoted)" do
    m = { kind: :where, field: "status", op: "eq", value: "active" }
    out = described_class.apply('SELECT COUNT(*) FROM "users"', m, entity)
    expect(out).to eq('SELECT COUNT(*) FROM "users" WHERE "users"."status" = 1')
  end

  it "rejects unknown enum value" do
    m = { kind: :where, field: "status", op: "eq", value: "pending" }
    expect { described_class.apply('SELECT COUNT(*) FROM "users"', m, entity) }
      .to raise_error(/enum value.*not.*registry/i)
  end

  it "applies TIME last_30_days (quoted)" do
    m = { kind: :time, field: "created_at", window: "last_30_days" }
    out = described_class.apply('SELECT COUNT(*) FROM "users"', m, entity)
    expect(out).to eq(%(SELECT COUNT(*) FROM "users" WHERE "users"."created_at" >= NOW() - INTERVAL '30 days'))
  end

  it "chains multiple modifiers with AND" do
    sql = 'SELECT COUNT(*) FROM "users"'
    sql = described_class.apply(sql, { kind: :where, field: "status", op: "eq", value: "active" }, entity)
    sql = described_class.apply(sql, { kind: :time, field: "created_at", window: "last_30_days" }, entity)
    expect(sql).to include('WHERE "users"."status" = 1')
    expect(sql).to include('AND "users"."created_at" >=')
  end

  it "applies JOIN using association join_clause (quoted)" do
    with_assoc = SqlChatbot::Grammar::Entity.new(
      name: entity.name, table: entity.table, display_label: entity.display_label,
      row_count: entity.row_count, primary_key: entity.primary_key, timestamps: entity.timestamps,
      fields: entity.fields, scopes: entity.scopes, ranking_candidates: entity.ranking_candidates,
      associations: {
        "orders" => SqlChatbot::Grammar::Association.new(
          name: "orders", kind: :has_many, target_entity: "order",
          join_clause: "users.id = orders.user_id"
        )
      }
    )
    out = described_class.apply('SELECT COUNT(*) FROM "users"', { kind: :join, association: "orders" }, with_assoc)
    expect(out).to include('JOIN "orders" ON "users"."id" = "orders"."user_id"')
  end

  it "applies GROUP BY (quoted)" do
    e2 = SqlChatbot::Grammar::Entity.new(
      name: entity.name, table: entity.table, display_label: entity.display_label,
      row_count: entity.row_count, primary_key: entity.primary_key, timestamps: entity.timestamps,
      fields: entity.fields.merge(
        "country" => SqlChatbot::Grammar::Field.new(column: "country", type: :text, nullable: false, searchable: true)
      ),
      scopes: entity.scopes, associations: entity.associations, ranking_candidates: entity.ranking_candidates
    )
    out = described_class.apply('SELECT COUNT(*) FROM "users"', { kind: :group_by, field: "country" }, e2)
    expect(out).to include('GROUP BY "users"."country"')
  end

  it "HAVING requires GROUP BY" do
    expect { described_class.apply('SELECT 1 FROM "users"', { kind: :having, field: "c", op: "gt", value: 5 }, entity) }
      .to raise_error(/GROUP BY/)
  end

  it "applies ORDER BY (quoted)" do
    out = described_class.apply('SELECT * FROM "users"', { kind: :order_by, field: "created_at", direction: "desc" }, entity)
    expect(out).to include('ORDER BY "users"."created_at" DESC')
  end

  it "applies LIMIT" do
    out = described_class.apply("SELECT * FROM users", { kind: :limit, value: 25 }, entity)
    expect(out).to include("LIMIT 25")
  end

  it "applies DISTINCT" do
    out = described_class.apply("SELECT email FROM users", { kind: :distinct }, entity)
    expect(out).to eq("SELECT DISTINCT email FROM users")
  end
end
