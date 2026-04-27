# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/sanity_check"
require "sql_chatbot/grammar/registry"

RSpec.describe SqlChatbot::Grammar::SanityCheck do
  let(:entity) do
    SqlChatbot::Grammar::Entity.new(
      name: "user", table: "users", display_label: "User", row_count: 9,
      primary_key: "id", timestamps: {}, fields: {}, scopes: {}, associations: {},
      ranking_candidates: []
    )
  end

  it "passes when COUNT matches registry" do
    expect(described_class.check_count("COUNT", entity, [{ "count" => 9 }])).to eq(ok: true)
  end

  it "passes within 3x tolerance" do
    expect(described_class.check_count("COUNT", entity, [{ "count" => 5 }])).to eq(ok: true)
  end

  it "FLAGS Gitea-style silent corruption (got 1, registry has 9)" do
    r = described_class.check_count("COUNT", entity, [{ "count" => 1 }])
    expect(r[:ok]).to be false
    expect(r[:reason]).to match(/count_mismatch/)
  end

  it "FLAGS implausibly large result" do
    r = described_class.check_count("COUNT", entity, [{ "count" => 1000 }])
    expect(r[:ok]).to be false
  end

  it "skips check on tiny tables" do
    tiny = SqlChatbot::Grammar::Entity.new(name: "x", table: "x", row_count: 3)
    expect(described_class.check_count("COUNT", tiny, [{ "count" => 1 }])).to eq(ok: true)
  end

  it "skips non-COUNT primitives" do
    expect(described_class.check_count("LIST", entity, [{ "count" => 1 }])).to eq(ok: true)
  end
end
