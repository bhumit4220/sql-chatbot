# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/grammar/miss_logger"
require "tmpdir"

RSpec.describe SqlChatbot::Grammar::MissLogger do
  it "appends ndjson entries with timestamp" do
    f = File.join(Dir.tmpdir, "grammar-miss-#{Time.now.to_i}.ndjson")
    described_class.log(f, { question: "x", reason: "unmatched", extracted: nil })
    described_class.log(f, { question: "y", reason: "unknown_entity", extracted: { entity: "ghost" } })
    lines = File.read(f).strip.split("\n")
    expect(lines.length).to eq(2)
    parsed = JSON.parse(lines[0])
    expect(parsed["question"]).to eq("x")
    expect(parsed["ts"]).to be_a(String)
  ensure
    File.delete(f) if File.exist?(f)
  end

  it "creates parent directory if missing" do
    dir = File.join(Dir.tmpdir, "grammar-miss-#{Time.now.to_i}-#{rand(9999)}")
    f = File.join(dir, "nested", "miss.ndjson")
    described_class.log(f, { question: "z", reason: "x", extracted: nil })
    expect(File.exist?(f)).to be true
  ensure
    FileUtils.rm_rf(dir) if defined?(dir) && Dir.exist?(dir)
  end
end
