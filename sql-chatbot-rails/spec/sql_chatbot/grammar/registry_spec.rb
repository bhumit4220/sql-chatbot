require "spec_helper"
require "sql_chatbot/grammar/registry"

RSpec.describe SqlChatbot::Grammar::Registry do
  it "builds an empty registry" do
    r = described_class.new(framework: "rails")
    expect(r.entities).to eq({})
    expect(r.aliases).to eq({})
    expect(r.framework).to eq("rails")
    expect(r.version).to eq(1)
  end

  it "finds entity by name" do
    entity = SqlChatbot::Grammar::Entity.new(name: "user", table: "users")
    r = described_class.new(framework: "rails", entities: { "user" => entity })
    expect(r.find_entity("user").table).to eq("users")
    expect(r.find_entity("missing")).to be_nil
  end

  it "resolves alias to entity" do
    entity = SqlChatbot::Grammar::Entity.new(name: "user", table: "users")
    r = described_class.new(
      framework: "rails",
      entities: { "user" => entity },
      aliases: { "customer" => "user" }
    )
    expect(r.resolve_alias("customer")).to eq("user")
    expect(r.resolve_alias("user")).to eq("user")
    expect(r.resolve_alias("unknown")).to be_nil
  end
end
