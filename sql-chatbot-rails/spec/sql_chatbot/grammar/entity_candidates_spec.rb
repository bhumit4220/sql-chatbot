# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/entity_candidates"

RSpec.describe SqlChatbot::Grammar::EntityCandidates do
  let(:registry) do
    entities = {
      "user"      => SqlChatbot::Grammar::Entity.new(name: "user",      table: "users",      row_count: 100),
      "order"     => SqlChatbot::Grammar::Entity.new(name: "order",     table: "orders",     row_count: 500),
      "product"   => SqlChatbot::Grammar::Entity.new(name: "product",   table: "products",   row_count: 50),
      "account"   => SqlChatbot::Grammar::Entity.new(name: "account",   table: "accounts",   row_count: 10),
      "setting"   => SqlChatbot::Grammar::Entity.new(name: "setting",   table: "settings",   row_count: 5),
      "audit_log" => SqlChatbot::Grammar::Entity.new(name: "audit_log", table: "audit_logs", row_count: 10_000),
    }
    SqlChatbot::Grammar::Registry.new(
      framework: "rails",
      entities: entities,
      aliases: { "customers" => "user", "folks" => "user" }
    )
  end

  it "matches exact entity name in question" do
    candidates = described_class.select(question: "how many users", registry: registry, top_n: 5)
    expect(candidates.first.name).to eq("user")
  end

  it "resolves alias" do
    candidates = described_class.select(question: "how many customers", registry: registry, top_n: 5)
    expect(candidates.first.name).to eq("user")
  end

  it "returns up to top-N by match strength" do
    candidates = described_class.select(question: "orders and products", registry: registry, top_n: 3)
    expect(candidates.first(2).map(&:name).sort).to eq(["order", "product"])
    expect(candidates.length).to be <= 3
  end

  it "falls back to highest-rowCount entities when no match" do
    candidates = described_class.select(question: "hello there", registry: registry, top_n: 3)
    expect(candidates.first.name).to eq("audit_log")
  end

  it "Taiga regression: prefers projects_project over projects_projecttemplate" do
    entities = {
      "projects_project"          => SqlChatbot::Grammar::Entity.new(name: "projects_project",          table: "projects_project",          row_count: 0),
      "projects_projecttemplate"  => SqlChatbot::Grammar::Entity.new(name: "projects_projecttemplate",  table: "projects_projecttemplate",  row_count: 2),
    }
    r = SqlChatbot::Grammar::Registry.new(framework: "django", entities: entities, aliases: {})
    candidates = described_class.select(question: "how many projects", registry: r, top_n: 5)
    expect(candidates.first.name).to eq("projects_project")
  end

  it "token match: question 'users' matches users_user entity" do
    entities = {
      "users_user"      => SqlChatbot::Grammar::Entity.new(name: "users_user",      table: "users_user",      row_count: 4),
      "auth_permission" => SqlChatbot::Grammar::Entity.new(name: "auth_permission", table: "auth_permission", row_count: 100),
    }
    r = SqlChatbot::Grammar::Registry.new(framework: "django", entities: entities, aliases: {})
    candidates = described_class.select(question: "how many users", registry: r, top_n: 5)
    expect(candidates.first.name).to eq("users_user")
  end
end
