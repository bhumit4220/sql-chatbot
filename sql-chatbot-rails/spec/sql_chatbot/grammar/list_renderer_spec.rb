# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/list_renderer"

RSpec.describe SqlChatbot::Grammar::ListRenderer do
  it "renders empty result programmatically" do
    r = described_class.try_render("LIST", "Label", [])
    expect(r[:ok]).to be true
    expect(r[:text]).to match(/no matching/i)
  end

  it "renders 5 labels (Chatwoot regression case)" do
    rows = [
      { "id" => 1, "title" => "bug" },
      { "id" => 2, "title" => "feature" },
      { "id" => 3, "title" => "urgent" },
      { "id" => 4, "title" => "billing" },
      { "id" => 5, "title" => "technical" },
    ]
    r = described_class.try_render("LIST", "Label", rows)
    expect(r[:ok]).to be true
    %w[bug feature urgent billing technical].each { |l| expect(r[:text]).to include(l) }
    expect(r[:text]).to match(/5 Labels/)
  end

  it "uses singular form for single item" do
    r = described_class.try_render("LIST", "Project", [{ "id" => 1, "name" => "alpha" }])
    expect(r[:ok]).to be true
    expect(r[:text]).to match(/Here is the Project/)
    expect(r[:text]).to include("alpha")
  end

  it "falls back when result count > 10" do
    rows = (1..11).map { |i| { "id" => i, "name" => "r#{i}" } }
    expect(described_class.try_render("LIST", "Item", rows)[:ok]).to be false
  end

  it "falls back when no readable label can be picked" do
    expect(described_class.try_render("LIST", "Item", [{ "id" => 1 }, { "id" => 2 }])[:ok]).to be false
  end

  it "skips non-LIST primitives" do
    expect(described_class.try_render("COUNT", "Item", [{ "count" => 5 }])[:ok]).to be false
  end

  it "prefers title over name and email" do
    r = described_class.try_render("LIST", "Order", [
      { "id" => 1, "name" => "fallback", "title" => "preferred", "email" => "e@e" },
    ])
    expect(r[:text]).to include("preferred")
    expect(r[:text]).not_to include("fallback")
    expect(r[:text]).not_to include("e@e")
  end
end
