# frozen_string_literal: true

require "spec_helper"
require "active_record"
require "sql_chatbot/services/registry_builder"

RSpec.describe SqlChatbot::Services::RegistryBuilder do
  before(:all) do
    ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
    ActiveRecord::Schema.define do
      create_table :users do |t|
        t.string :email
        t.integer :status, default: 0
        t.datetime :deleted_at
        t.timestamps
      end
      create_table :orders do |t|
        t.integer :user_id, null: false
        t.decimal :total, precision: 10, scale: 2
        t.timestamps
      end
    end
    class User < ActiveRecord::Base
      enum :status, { active: 0, banned: 1 }
      has_many :orders
    end
    class Order < ActiveRecord::Base
      belongs_to :user
    end
  end

  it "builds registry with entities for each model" do
    r = described_class.new.build
    expect(r.entities.keys).to include("user", "order")
  end

  it "extracts Rails enums into Field.enum_values" do
    r = described_class.new.build
    field = r.entities["user"].fields["status"]
    expect(field.enum_values).to eq({ "active" => 0, "banned" => 1 })
    expect(field.type).to eq(:enum)
  end

  it "records has_many associations" do
    r = described_class.new.build
    assoc = r.entities["user"].associations["orders"]
    expect(assoc.kind).to eq(:has_many)
    expect(assoc.target_entity).to eq("order")
    expect(assoc.join_clause).to eq("users.id = orders.user_id")
  end

  it "records belongs_to associations" do
    r = described_class.new.build
    assoc = r.entities["order"].associations["user"]
    expect(assoc.kind).to eq(:belongs_to)
    expect(assoc.target_entity).to eq("user")
    expect(assoc.join_clause).to eq("orders.user_id = users.id")
  end

  it "auto-detects soft-delete column into timestamps.deleted" do
    r = described_class.new.build
    expect(r.entities["user"].timestamps[:deleted]).to eq("deleted_at")
  end
end
