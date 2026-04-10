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
  # #relocate_lookup_annotations
  # ---------------------------------------------------------------------------
  describe "#relocate_lookup_annotations" do
    let(:service) { described_class.new }

    it "annotates explicit FK columns instead of lookup tables" do
      service.instance_variable_set(:@summary_text, [
        "TABLE categories (id INT PK, name VARCHAR)",
        "  -- VALUES: 1=Tv Shows, 2=Movie",
        "TABLE titles (id INT PK, name VARCHAR, category_id INT FK=>categories.id, status INT)",
      ].join("\n"))

      service.relocate_lookup_annotations

      expect(service.summary).to include("FK LOOKUP: category_id values: 1=Tv Shows, 2=Movie")
      expect(service.summary).not_to include("-- VALUES:")
    end

    it "annotates convention-based FK columns (no explicit FK marker)" do
      service.instance_variable_set(:@summary_text, [
        "TABLE categories (id INT PK, name VARCHAR)",
        "  -- VALUES: 1=Tv Shows, 2=Movie",
        "TABLE titles (id INT PK, name VARCHAR, category_id INT, status INT)",
      ].join("\n"))

      service.relocate_lookup_annotations

      expect(service.summary).to include("FK LOOKUP: category_id values: 1=Tv Shows, 2=Movie")
      expect(service.summary).not_to include("-- VALUES:")
    end

    it "annotates multiple FK columns referencing the same lookup table" do
      service.instance_variable_set(:@summary_text, [
        "TABLE categories (id INT PK, name VARCHAR)",
        "  -- VALUES: 1=Tv Shows, 2=Movie",
        "TABLE titles (id INT PK, category_id INT FK=>categories.id)",
        "TABLE posts (id INT PK, category_id INT)",
      ].join("\n"))

      service.relocate_lookup_annotations

      expect(service.summary).not_to include("-- VALUES:")
      lines = service.summary.split("\n")
      fk_lookups = lines.select { |l| l.include?("FK LOOKUP") }
      expect(fk_lookups.length).to eq(2)
    end

    it "does nothing when no VALUES annotations exist" do
      original = "TABLE titles (id INT PK, name VARCHAR)"
      service.instance_variable_set(:@summary_text, original)

      service.relocate_lookup_annotations

      expect(service.summary).to eq(original)
    end
  end

  # ---------------------------------------------------------------------------
  # #table_names
  # ---------------------------------------------------------------------------
  describe "#table_names" do
    it "returns empty string before discover" do
      expect(service.table_names).to eq("")
    end

    it "returns comma-separated list of table names after indexes are set" do
      service.instance_variable_set(:@tables, %w[customers jobs job_types])
      result = service.table_names
      expect(result).to eq("Available tables: customers, jobs, job_types")
    end

    it "includes all tables in the list" do
      service.instance_variable_set(:@tables, %w[customers jobs job_types invoices])
      result = service.table_names
      %w[customers jobs job_types invoices].each do |t|
        expect(result).to include(t)
      end
    end
  end

  # ---------------------------------------------------------------------------
  # #select_schema
  # ---------------------------------------------------------------------------
  describe "#select_schema" do
    # Set up a minimal fake schema with 4 tables:
    #   customers — stand-alone hub with many FKs pointing to it
    #   jobs      — has customer_id (FK to customers) and job_type_id (FK to job_types)
    #   job_types — lookup table referenced by jobs
    #   invoices  — has customer_id (FK to customers), has a rating column
    #
    # FK graph (bidirectional):
    #   customers <-> jobs (via jobs.customer_id)
    #   job_types <-> jobs (via jobs.job_type_id)
    #   customers <-> invoices (via invoices.customer_id)

    let(:per_table_schemas) do
      {
        "customers" => "TABLE customers (id BIGINT PK, name VARCHAR, email VARCHAR)\n  -- SOFT DELETE: filter deleted_at IS NULL for active records",
        "jobs"      => "TABLE jobs (id BIGINT PK, customer_id BIGINT FK=>customers.id, job_type_id BIGINT FK=>job_types.id, status VARCHAR)\n  -- RAILS ENUM: status values: Active=1, Closed=2",
        "job_types" => "TABLE job_types (id BIGINT PK, name VARCHAR)\n  -- VALUES: 1=Plumbing, 2=HVAC",
        "invoices"  => "TABLE invoices (id BIGINT PK, customer_id BIGINT FK=>customers.id, rating INT, total DECIMAL)",
      }
    end

    let(:table_index) do
      {
        "id"           => %w[customers jobs job_types invoices],
        "name"         => %w[customers job_types],
        "email"        => ["customers"],
        "customer_id"  => %w[jobs invoices],
        "job_type_id"  => ["jobs"],
        "status"       => ["jobs"],
        "total"        => ["invoices"],
        "rating"       => ["invoices"],
      }
    end

    let(:fk_graph) do
      {
        "customers" => [
          { from_col: "id", to_table: "jobs",     to_col: "customer_id" },
          { from_col: "id", to_table: "invoices", to_col: "customer_id" },
        ],
        "jobs" => [
          { from_col: "customer_id",  to_table: "customers", to_col: "id" },
          { from_col: "job_type_id",  to_table: "job_types", to_col: "id" },
        ],
        "job_types" => [
          { from_col: "id", to_table: "jobs", to_col: "job_type_id" },
        ],
        "invoices" => [
          { from_col: "customer_id", to_table: "customers", to_col: "id" },
        ],
      }
    end

    before do
      service.instance_variable_set(:@tables, %w[customers jobs job_types invoices])
      service.instance_variable_set(:@per_table_schemas, per_table_schemas)
      service.instance_variable_set(:@table_index, table_index)
      service.instance_variable_set(:@fk_graph, fk_graph)
    end

    context "single table match" do
      it "returns only the customers table when searching for 'customers'" do
        result = service.select_schema(["customers"])
        expect(result).to include("TABLE customers")
        expect(result).not_to include("TABLE jobs")
        expect(result).not_to include("TABLE invoices")
      end

      it "does not include unrelated tables" do
        result = service.select_schema(["job_types"])
        expect(result).to include("TABLE job_types")
        expect(result).not_to include("TABLE customers")
        expect(result).not_to include("TABLE invoices")
      end
    end

    context "two directly connected tables" do
      it "returns jobs and job_types without extra tables when they are directly connected" do
        result = service.select_schema(%w[jobs job_types])
        expect(result).to include("TABLE jobs")
        expect(result).to include("TABLE job_types")
        expect(result).not_to include("TABLE customers")
        expect(result).not_to include("TABLE invoices")
      end
    end

    context "bridge table discovery" do
      it "includes jobs as bridge when searching for customers and job_types" do
        result = service.select_schema(%w[customers job_types])
        expect(result).to include("TABLE customers")
        expect(result).to include("TABLE job_types")
        expect(result).to include("TABLE jobs")
      end
    end

    context "column name matching" do
      it "returns invoices when searching by column name 'rating'" do
        result = service.select_schema(["rating"])
        expect(result).to include("TABLE invoices")
      end

      it "returns all tables with 'name' column when searching by 'name'" do
        result = service.select_schema(["name"])
        expect(result).to include("TABLE customers")
        expect(result).to include("TABLE job_types")
      end
    end

    context "singular/plural variant matching" do
      it "matches 'customer' (singular) to 'customers' table" do
        result = service.select_schema(["customer"])
        expect(result).to include("TABLE customers")
      end

      it "matches plural term that resolves to the table" do
        result = service.select_schema(["job_type"])
        expect(result).to include("TABLE job_types")
      end
    end

    context "fallback to hub tables" do
      it "returns something when no terms match" do
        result = service.select_schema(["completely_unknown_xyz"])
        expect(result).not_to be_empty
        expect(result).to include("TABLE")
      end

      it "prefers tables with most FK edges as hub tables" do
        # customers has 2 edges, jobs has 2 edges, job_types has 1, invoices has 1
        result = service.select_schema(["completely_unknown_xyz"])
        # customers and jobs should appear (highest edge counts)
        expect(result).to include("TABLE customers").or include("TABLE jobs")
      end
    end

    context "annotations are preserved" do
      it "includes SOFT DELETE annotation for selected table" do
        result = service.select_schema(["customers"])
        expect(result).to include("SOFT DELETE: filter deleted_at IS NULL")
      end

      it "includes RAILS ENUM annotation for selected table" do
        result = service.select_schema(["jobs"])
        expect(result).to include("RAILS ENUM: status values")
      end

      it "includes VALUES annotation for selected lookup table" do
        result = service.select_schema(["job_types"])
        expect(result).to include("VALUES: 1=Plumbing, 2=HVAC")
      end
    end

    context "before discover is called" do
      it "returns full summary_text as fallback" do
        fresh = described_class.new
        full = "TABLE customers (id BIGINT PK, name VARCHAR)"
        fresh.instance_variable_set(:@summary_text, full)
        expect(fresh.select_schema(["customers"])).to eq(full)
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Private: build_per_table_schemas
  # ---------------------------------------------------------------------------
  describe "#build_per_table_schemas (private)" do
    it "splits lines into per-table chunks keyed by table name" do
      lines = [
        "TABLE customers (id BIGINT PK, name VARCHAR)",
        "  -- SOFT DELETE: filter deleted_at IS NULL for active records",
        "TABLE jobs (id BIGINT PK, status INT)",
        "  -- RAILS ENUM: status values: Active=1",
      ]
      service.send(:build_per_table_schemas, lines)
      schemas = service.instance_variable_get(:@per_table_schemas)

      expect(schemas.keys).to contain_exactly("customers", "jobs")
      expect(schemas["customers"]).to include("TABLE customers")
      expect(schemas["customers"]).to include("SOFT DELETE")
      expect(schemas["jobs"]).to include("TABLE jobs")
      expect(schemas["jobs"]).to include("RAILS ENUM")
      expect(schemas["customers"]).not_to include("TABLE jobs")
    end
  end

  # ---------------------------------------------------------------------------
  # Private: build_table_index
  # ---------------------------------------------------------------------------
  describe "#build_table_index (private)" do
    it "maps column names to tables" do
      columns_by_table = {
        "customers" => [
          { "column_name" => "id",    "data_type" => "bigint" },
          { "column_name" => "email", "data_type" => "character varying" },
        ],
        "jobs" => [
          { "column_name" => "id",          "data_type" => "bigint" },
          { "column_name" => "customer_id", "data_type" => "bigint" },
        ],
      }
      service.send(:build_table_index, columns_by_table)
      idx = service.instance_variable_get(:@table_index)

      expect(idx["id"]).to contain_exactly("customers", "jobs")
      expect(idx["email"]).to eq(["customers"])
      expect(idx["customer_id"]).to eq(["jobs"])
    end

    it "skips sensitive column names" do
      columns_by_table = {
        "users" => [
          { "column_name" => "id",       "data_type" => "bigint" },
          { "column_name" => "password", "data_type" => "character varying" },
          { "column_name" => "api_key",  "data_type" => "character varying" },
        ],
      }
      service.send(:build_table_index, columns_by_table)
      idx = service.instance_variable_get(:@table_index)

      expect(idx.keys).to include("id")
      expect(idx.keys).not_to include("password")
      expect(idx.keys).not_to include("api_key")
    end
  end

  # ---------------------------------------------------------------------------
  # Private: build_fk_graph
  # ---------------------------------------------------------------------------
  describe "#build_fk_graph (private)" do
    let(:fk_rows) do
      [
        { "from_table" => "jobs", "from_column" => "customer_id",
          "to_table" => "customers", "to_column" => "id" },
      ]
    end

    let(:columns_by_table) do
      {
        "jobs" => [
          { "column_name" => "id",          "data_type" => "bigint" },
          { "column_name" => "customer_id", "data_type" => "bigint" },
          { "column_name" => "job_type_id", "data_type" => "bigint" },
        ],
      }
    end

    let(:table_name_set) { Set.new(%w[customers jobs job_types]) }

    it "adds forward and reverse edges for explicit FKs" do
      service.send(:build_fk_graph, fk_rows, columns_by_table, table_name_set)
      graph = service.instance_variable_get(:@fk_graph)

      # Forward: jobs -> customers
      expect(graph["jobs"]).to include(a_hash_including(from_col: "customer_id", to_table: "customers"))
      # Reverse: customers -> jobs
      expect(graph["customers"]).to include(a_hash_including(to_table: "jobs"))
    end

    it "adds convention-based edges for _id columns" do
      service.send(:build_fk_graph, [], columns_by_table, table_name_set)
      graph = service.instance_variable_get(:@fk_graph)

      # job_type_id should resolve to job_types table
      expect(graph["jobs"]).to include(a_hash_including(from_col: "job_type_id", to_table: "job_types"))
    end
  end

  # ---------------------------------------------------------------------------
  # Private: find_join_path
  # ---------------------------------------------------------------------------
  describe "#find_join_path (private)" do
    before do
      service.instance_variable_set(:@fk_graph, {
        "customers" => [
          { from_col: "id", to_table: "jobs",     to_col: "customer_id" },
        ],
        "jobs" => [
          { from_col: "customer_id",  to_table: "customers", to_col: "id" },
          { from_col: "job_type_id",  to_table: "job_types", to_col: "id" },
        ],
        "job_types" => [
          { from_col: "id", to_table: "jobs", to_col: "job_type_id" },
        ],
      })
    end

    it "returns [] for directly connected tables" do
      expect(service.send(:find_join_path, "customers", "jobs")).to eq([])
    end

    it "returns [] for directly connected tables in reverse direction" do
      expect(service.send(:find_join_path, "jobs", "customers")).to eq([])
    end

    it "returns bridge table for depth-2 path" do
      result = service.send(:find_join_path, "customers", "job_types")
      expect(result).to eq(["jobs"])
    end

    it "returns nil when no path exists within depth 2" do
      service.instance_variable_set(:@fk_graph, {
        "customers" => [{ from_col: "id", to_table: "invoices", to_col: "customer_id" }],
        "invoices"  => [{ from_col: "customer_id", to_table: "customers", to_col: "id" }],
      })
      result = service.send(:find_join_path, "customers", "job_types")
      expect(result).to be_nil
    end

    it "returns [] for same table" do
      expect(service.send(:find_join_path, "customers", "customers")).to eq([])
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

  # ---------------------------------------------------------------------------
  # #find_lookup_hints — RAILS ENUM support
  # ---------------------------------------------------------------------------
  describe "#find_lookup_hints with RAILS ENUM" do
    let(:schema_with_enums) do
      <<~SCHEMA
        TABLE contractors
          id INT PK
          name VARCHAR
          status INT
          -- RAILS ENUM: status values: Active=1, Inactive=2, Deleted=3, Suspended=13
        TABLE jobs
          id INT PK
          status INT
          -- RAILS ENUM: status values: Active=1, Completed=11, Canceled=12, Disputed=15, Finished=16
          -- FK LOOKUP: job_type_id values: 1=Snow Removal, 2=Lawn Mowing
      SCHEMA
    end

    before do
      service.instance_variable_set(:@summary_text, schema_with_enums)
    end

    it "matches RAILS ENUM values by keyword" do
      hints = service.find_lookup_hints("show me active contractors")
      expect(hints).to include(a_string_matching(/status = 1.*Active/))
    end

    it "matches 'disputed' to the enum value" do
      hints = service.find_lookup_hints("how many disputed jobs?")
      expect(hints).to include(a_string_matching(/status = 15.*Disputed/))
    end

    it "matches 'completed' to the enum value" do
      hints = service.find_lookup_hints("show completed jobs")
      expect(hints).to include(a_string_matching(/status = 11.*Completed/))
    end

    it "matches 'inactive' to the enum value" do
      hints = service.find_lookup_hints("how many inactive contractors?")
      expect(hints).to include(a_string_matching(/status = 2.*Inactive/))
    end

    it "returns both FK LOOKUP and RAILS ENUM hints" do
      hints = service.find_lookup_hints("show completed snow removal jobs")
      expect(hints).to include(a_string_matching(/status = 11.*Completed/))
      expect(hints).to include(a_string_matching(/job_type_id = 1.*Snow Removal/))
    end

    it "returns empty for unrelated questions" do
      hints = service.find_lookup_hints("how many customers?")
      expect(hints).to be_empty
    end
  end

  # ---------------------------------------------------------------------------
  # #extract_enum_context
  # ---------------------------------------------------------------------------
  describe "#extract_enum_context" do
    let(:schema_with_enums) do
      <<~SCHEMA
        TABLE contractors
          id INT PK
          status INT
          -- RAILS ENUM: status values: Active=1, Inactive=2, Deleted=3
        TABLE jobs
          id INT PK
          status INT
          -- RAILS ENUM: status values: Active=1, Completed=11, Finished=16
          -- FK LOOKUP: job_type_id values: 1=Snow, 2=Lawn
      SCHEMA
    end

    before do
      service.instance_variable_set(:@summary_text, schema_with_enums)
    end

    it "extracts RAILS ENUM annotations as table.column: values format" do
      result = service.extract_enum_context
      expect(result).to include("contractors.status: Active=1, Inactive=2, Deleted=3")
      expect(result).to include("jobs.status: Active=1, Completed=11, Finished=16")
    end

    it "does not include FK LOOKUP annotations" do
      result = service.extract_enum_context
      expect(result).not_to include("FK LOOKUP")
      expect(result).not_to include("job_type_id")
    end

    it "accepts a schema string parameter" do
      custom = "TABLE foo\n  -- RAILS ENUM: bar values: X=1, Y=2"
      result = service.extract_enum_context(custom)
      expect(result).to eq("foo.bar: X=1, Y=2")
    end

    it "returns empty string when no enums" do
      result = service.extract_enum_context("TABLE foo\n  id INT PK")
      expect(result).to eq("")
    end
  end
end
