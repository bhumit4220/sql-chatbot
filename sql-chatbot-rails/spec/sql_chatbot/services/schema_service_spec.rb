# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/services/schema_service"

RSpec.describe SqlChatbot::Services::SchemaService do
  subject(:service) { described_class.new }

  # ---------------------------------------------------------------------------
  # Constants
  # ---------------------------------------------------------------------------
  describe "SENSITIVE_PATTERNS" do
    it "contains all expected patterns" do
      expected = %w[
        password passwd secret token ssn social_security
        credit_card card_number cvv pin encrypted hash
        salt private_key api_key auth_key access_key
      ]
      expected.each do |pattern|
        expect(described_class::SENSITIVE_PATTERNS).to include(pattern),
          "expected SENSITIVE_PATTERNS to include '#{pattern}'"
      end
    end
  end

  describe "TYPE_MAP" do
    it "maps integer types correctly" do
      expect(described_class::TYPE_MAP["integer"]).to eq("INT")
      expect(described_class::TYPE_MAP["bigint"]).to eq("BIGINT")
      expect(described_class::TYPE_MAP["smallint"]).to eq("SMALLINT")
    end

    it "maps string types correctly" do
      expect(described_class::TYPE_MAP["character varying"]).to eq("VARCHAR")
      expect(described_class::TYPE_MAP["text"]).to eq("TEXT")
    end

    it "maps timestamp types correctly" do
      expect(described_class::TYPE_MAP["timestamp without time zone"]).to eq("TIMESTAMP")
      expect(described_class::TYPE_MAP["timestamp with time zone"]).to eq("TIMESTAMPTZ")
    end

    it "maps numeric types correctly" do
      expect(described_class::TYPE_MAP["numeric"]).to eq("DECIMAL")
      expect(described_class::TYPE_MAP["double precision"]).to eq("DOUBLE")
      expect(described_class::TYPE_MAP["real"]).to eq("REAL")
    end

    it "maps boolean type correctly" do
      expect(described_class::TYPE_MAP["boolean"]).to eq("BOOL")
    end

    it "maps date/json/uuid types correctly" do
      expect(described_class::TYPE_MAP["date"]).to eq("DATE")
      expect(described_class::TYPE_MAP["jsonb"]).to eq("JSONB")
      expect(described_class::TYPE_MAP["json"]).to eq("JSON")
      expect(described_class::TYPE_MAP["uuid"]).to eq("UUID")
    end
  end

  describe "SOFT_DELETE_COLUMNS" do
    it "includes deleted_at" do
      expect(described_class::SOFT_DELETE_COLUMNS).to include("deleted_at")
    end

    it "includes discarded_at" do
      expect(described_class::SOFT_DELETE_COLUMNS).to include("discarded_at")
    end

    it "includes archived_at" do
      expect(described_class::SOFT_DELETE_COLUMNS).to include("archived_at")
    end

    it "includes removed_at" do
      expect(described_class::SOFT_DELETE_COLUMNS).to include("removed_at")
    end
  end

  # ---------------------------------------------------------------------------
  # .sensitive? — word-boundary matching
  # ---------------------------------------------------------------------------
  describe ".sensitive?" do
    # Columns that SHOULD be flagged as sensitive
    %w[
      password password_digest secret_key api_key access_token
      private_key encrypted_password auth_key
      card_number cvv_code ssn_last_four social_security_number
      pin_code hash_value salt_value
    ].each do |col|
      it "detects '#{col}' as sensitive" do
        expect(described_class.sensitive?(col)).to be true
      end
    end

    # Columns that should NOT be flagged (no false positives)
    %w[
      name email created_at status pinned_at description
      username first_name last_name phone_number address
      title body content category_id
    ].each do |col|
      it "does not flag '#{col}' as sensitive" do
        expect(described_class.sensitive?(col)).to be false
      end
    end

    it "is case-insensitive" do
      expect(described_class.sensitive?("PASSWORD")).to be true
      expect(described_class.sensitive?("Api_Key")).to be true
    end
  end

  # ---------------------------------------------------------------------------
  # .map_type
  # ---------------------------------------------------------------------------
  describe ".map_type" do
    it "maps known types via TYPE_MAP" do
      expect(described_class.map_type("character varying")).to eq("VARCHAR")
      expect(described_class.map_type("integer")).to eq("INT")
    end

    it "uppercases unknown types" do
      expect(described_class.map_type("citext")).to eq("CITEXT")
      expect(described_class.map_type("hstore")).to eq("HSTORE")
    end
  end

  # ---------------------------------------------------------------------------
  # Private: detect_polymorphic
  # ---------------------------------------------------------------------------
  describe "#detect_polymorphic" do
    it "detects type+id pairs as polymorphic" do
      columns = [
        { "column_name" => "commentable_type", "data_type" => "character varying" },
        { "column_name" => "commentable_id", "data_type" => "integer" },
        { "column_name" => "body", "data_type" => "text" },
      ]
      result = service.send(:detect_polymorphic, columns)
      expect(result).to include("commentable")
    end

    it "requires _type to be VARCHAR or TEXT" do
      columns = [
        { "column_name" => "commentable_type", "data_type" => "integer" },
        { "column_name" => "commentable_id", "data_type" => "integer" },
      ]
      result = service.send(:detect_polymorphic, columns)
      expect(result).to be_empty
    end

    it "requires _id to be INT or BIGINT" do
      columns = [
        { "column_name" => "commentable_type", "data_type" => "character varying" },
        { "column_name" => "commentable_id", "data_type" => "text" },
      ]
      result = service.send(:detect_polymorphic, columns)
      expect(result).to be_empty
    end

    it "detects multiple polymorphic associations" do
      columns = [
        { "column_name" => "commentable_type", "data_type" => "character varying" },
        { "column_name" => "commentable_id", "data_type" => "bigint" },
        { "column_name" => "taggable_type", "data_type" => "text" },
        { "column_name" => "taggable_id", "data_type" => "integer" },
      ]
      result = service.send(:detect_polymorphic, columns)
      expect(result).to contain_exactly("commentable", "taggable")
    end

    it "returns empty array when no polymorphic pairs exist" do
      columns = [
        { "column_name" => "name", "data_type" => "character varying" },
        { "column_name" => "status", "data_type" => "integer" },
      ]
      result = service.send(:detect_polymorphic, columns)
      expect(result).to be_empty
    end
  end

  # ---------------------------------------------------------------------------
  # Private: detect_soft_delete
  # ---------------------------------------------------------------------------
  describe "#detect_soft_delete" do
    it "detects deleted_at column" do
      columns = [
        { "column_name" => "id", "data_type" => "integer" },
        { "column_name" => "deleted_at", "data_type" => "timestamp without time zone" },
      ]
      result = service.send(:detect_soft_delete, columns)
      expect(result).to eq("deleted_at")
    end

    it "detects discarded_at column" do
      columns = [
        { "column_name" => "discarded_at", "data_type" => "timestamp without time zone" },
      ]
      result = service.send(:detect_soft_delete, columns)
      expect(result).to eq("discarded_at")
    end

    it "returns nil when no soft-delete column present" do
      columns = [
        { "column_name" => "id", "data_type" => "integer" },
        { "column_name" => "name", "data_type" => "character varying" },
      ]
      result = service.send(:detect_soft_delete, columns)
      expect(result).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # Private: parse_check_constraint
  # ---------------------------------------------------------------------------
  describe "#parse_check_constraint" do
    it "parses IN (...) format" do
      check_def = "(status IN ('active', 'inactive', 'pending'))"
      col, values = service.send(:parse_check_constraint, check_def)
      expect(col).to eq("status")
      expect(values).to eq(%w[active inactive pending])
    end

    it "parses ANY(ARRAY[...]) format" do
      check_def = "((role)::text = ANY ((ARRAY['admin'::character varying, 'user'::character varying])::text[]))"
      col, values = service.send(:parse_check_constraint, check_def)
      expect(col).to eq("role")
      expect(values).to eq(%w[admin user])
    end

    it "returns nil for non-enum check constraints" do
      check_def = "(age > 0)"
      result = service.send(:parse_check_constraint, check_def)
      expect(result).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # #summary and #table_count before discover
  # ---------------------------------------------------------------------------
  describe "#summary" do
    it "returns empty string before discover" do
      expect(service.summary).to eq("")
    end
  end

  describe "#table_count" do
    it "returns 0 before discover" do
      expect(service.table_count).to eq(0)
    end
  end

  # ---------------------------------------------------------------------------
  # #append_model_annotations
  # ---------------------------------------------------------------------------
  describe "#append_model_annotations" do
    let(:service) { described_class.new }

    before do
      # Set up a fake summary_text (bypass discover)
      service.instance_variable_set(:@summary_text, <<~SCHEMA.strip)
        TABLE users (id INT PK, name VARCHAR)
          -- SOFT DELETE: filter deleted_at IS NULL for active records
        TABLE jobs (id INT PK, created_by INT, status INT)
        TABLE transactions (id INT PK, type VARCHAR, amount DECIMAL)
          -- POLYMORPHIC: commentable_type + commentable_id
      SCHEMA
    end

    it "injects annotations after the correct table" do
      annotations = {
        "jobs" => ["  -- RAILS ENUM: status values: Active=1, Pending=2, Deleted=3"]
      }
      service.append_model_annotations(annotations)

      lines = service.summary.split("\n")
      jobs_idx = lines.index { |l| l.start_with?("TABLE jobs") }
      expect(lines[jobs_idx + 1]).to include("RAILS ENUM: status")
    end

    it "appends after existing annotations for a table" do
      annotations = {
        "users" => ["  -- RAILS ENUM: role values: Admin=0, User=1"]
      }
      service.append_model_annotations(annotations)

      lines = service.summary.split("\n")
      users_idx = lines.index { |l| l.start_with?("TABLE users") }
      # Existing annotation is at users_idx + 1
      expect(lines[users_idx + 1]).to include("SOFT DELETE")
      # New annotation at users_idx + 2
      expect(lines[users_idx + 2]).to include("RAILS ENUM: role")
    end

    it "handles multiple annotations for one table" do
      annotations = {
        "jobs" => [
          "  -- RAILS ENUM: status values: Active=1, Deleted=3",
          "  -- MODEL FK: created_by -> customers.id (belongs_to :creator)"
        ]
      }
      service.append_model_annotations(annotations)

      lines = service.summary.split("\n")
      jobs_idx = lines.index { |l| l.start_with?("TABLE jobs") }
      expect(lines[jobs_idx + 1]).to include("RAILS ENUM")
      expect(lines[jobs_idx + 2]).to include("MODEL FK")
    end

    it "handles annotations for the last table" do
      annotations = {
        "transactions" => ["  -- RAILS ENUM: kind values: Credit=0, Debit=1"]
      }
      service.append_model_annotations(annotations)

      lines = service.summary.split("\n")
      expect(lines.last).to include("RAILS ENUM: kind")
    end

    it "does nothing with empty annotations" do
      original = service.summary.dup
      service.append_model_annotations({})
      expect(service.summary).to eq(original)
    end

    it "does nothing with nil annotations" do
      original = service.summary.dup
      service.append_model_annotations(nil)
      expect(service.summary).to eq(original)
    end

    it "ignores annotations for tables not in the schema" do
      original = service.summary.dup
      service.append_model_annotations({ "nonexistent" => ["  -- RAILS ENUM: x values: A=1"] })
      expect(service.summary).to eq(original)
    end
  end

  # ---------------------------------------------------------------------------
  # #apply_soft_delete_annotations
  # ---------------------------------------------------------------------------
  describe "#apply_soft_delete_annotations" do
    let(:service) { described_class.new }

    before do
      service.instance_variable_set(:@summary_text, [
        "TABLE customers (id INT PK, name VARCHAR, status INT, deleted_at TIMESTAMP)",
        "TABLE posts (id INT PK, title VARCHAR, discarded_at TIMESTAMP)",
        "TABLE settings (id INT PK, key VARCHAR, deleted_at TIMESTAMP)",
      ].join("\n"))
      service.instance_variable_set(:@deferred_soft_deletes, {
        "customers" => ["deleted_at"],
        "posts" => ["discarded_at"],
        "settings" => ["deleted_at"],
      })
    end

    it "adds SOFT DELETE for tables with soft delete gem" do
      service.apply_soft_delete_annotations(
        soft_delete_tables: Set.new(["posts"]),
        enum_soft_delete_tables: Set.new
      )
      expect(service.summary).to include("SOFT DELETE: filter discarded_at IS NULL")
    end

    it "suppresses SOFT DELETE for tables with enum soft delete and no gem" do
      service.apply_soft_delete_annotations(
        soft_delete_tables: Set.new,
        enum_soft_delete_tables: Set.new(["customers"])
      )
      # customers should NOT have SOFT DELETE
      lines = service.summary.split("\n")
      customer_section = lines.select { |l| l.include?("customers") || (l.strip.start_with?("--") && lines.index(l) > 0 && lines[lines.index(l) - 1].include?("customers")) }
      expect(customer_section.join).not_to include("SOFT DELETE")
    end

    it "adds SOFT DELETE for tables with neither gem nor enum soft delete" do
      service.apply_soft_delete_annotations(
        soft_delete_tables: Set.new,
        enum_soft_delete_tables: Set.new
      )
      expect(service.summary).to include("SOFT DELETE: filter deleted_at IS NULL")
    end

    it "adds SOFT DELETE when table has both gem and enum soft delete (gem wins)" do
      service.apply_soft_delete_annotations(
        soft_delete_tables: Set.new(["customers"]),
        enum_soft_delete_tables: Set.new(["customers"])
      )
      expect(service.summary).to include("SOFT DELETE: filter deleted_at IS NULL")
    end

    it "does nothing when no deferred soft deletes exist" do
      service.instance_variable_set(:@deferred_soft_deletes, nil)
      original = service.summary.dup
      service.apply_soft_delete_annotations(
        soft_delete_tables: Set.new,
        enum_soft_delete_tables: Set.new
      )
      expect(service.summary).to eq(original)
    end
  end
end
