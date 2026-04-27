# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/llm/client"
require "sql_chatbot/services/schema_service"
require "sql_chatbot/services/code_indexer"
require "sql_chatbot/services/orchestrator"

RSpec.describe SqlChatbot::Services::Orchestrator do
  let(:llm_client) { instance_double(SqlChatbot::LLM::Client) }
  let(:schema_service) do
    instance_double(SqlChatbot::Services::SchemaService,
      summary: "TABLE users (id INT, name VARCHAR)",
      table_names: "Available tables: users",
      select_schema: "TABLE users (id INT, name VARCHAR)",
      find_lookup_hints: [],
      extract_enum_context: "")
  end
  let(:code_indexer) { instance_double(SqlChatbot::Services::CodeIndexer, search: [], get_route_summary: "", get_routes: []) }
  let(:orchestrator) { described_class.new(llm_client: llm_client, schema_service: schema_service, code_indexer: code_indexer) }

  describe "#handle_question" do
    before do
      allow(schema_service).to receive(:table_names).and_return("Available tables: users")
      allow(schema_service).to receive(:select_schema).with(anything).and_return("TABLE users (id INT, name VARCHAR)")
      allow(schema_service).to receive(:extract_enum_context).with(anything).and_return("")
    end

    context "greeting questions" do
      it "emits classifying -> classified -> token -> done" do
        allow(llm_client).to receive(:call).and_return('{"type":"greeting","confidence":0.95}')
        allow(llm_client).to receive(:stream).and_yield("Hello!")

        events = orchestrator.handle_question(question: "hi").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified token done])
        expect(events.find { |e| e[:type] == "classified" }[:questionType]).to eq("greeting")
        expect(events.find { |e| e[:type] == "classified" }[:confidence]).to eq(0.95)
        expect(events.find { |e| e[:type] == "token" }[:content]).to eq("Hello!")
      end
    end

    context "data questions" do
      it "emits classifying -> classified -> sql -> executing -> token -> done" do
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data","confidence":0.9,"searchTerms":["users"]}',
          '{"sql":"SELECT COUNT(*) FROM users","explanation":"count users"}'
        )
        allow(llm_client).to receive(:stream).and_yield("There are 42 users.")
        allow(code_indexer).to receive(:search).with(["users"]).and_return([])
        allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql)
          .with("SELECT COUNT(*) FROM users")
          .and_return({ valid: true, sql: "SELECT COUNT(*) FROM users" })
        allow(SqlChatbot::Services::SqlExecutor).to receive(:execute_sql)
          .with("SELECT COUNT(*) FROM users")
          .and_return({ rows: [{ "count" => 42 }], columns: ["count"], row_count: 1 })

        events = orchestrator.handle_question(question: "How many users?").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified sql executing token done])
        expect(events.find { |e| e[:type] == "sql" }[:query]).to eq("SELECT COUNT(*) FROM users")
        expect(events.find { |e| e[:type] == "sql" }[:explanation]).to eq("count users")
      end

      it "emits error when SQL generation returns empty sql" do
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data","confidence":0.9,"searchTerms":[]}',
          '{"sql":"","explanation":"could not generate"}'
        )

        events = orchestrator.handle_question(question: "something weird").to_a
        types = events.map { |e| e[:type] }

        expect(types).to include("error")
        expect(events.find { |e| e[:type] == "error" }[:message]).to include("Failed to generate SQL")
      end

      it "emits error when SQL validation fails" do
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data","confidence":0.9,"searchTerms":[]}',
          '{"sql":"DROP TABLE users","explanation":"drop it"}'
        )
        allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql)
          .and_return({ valid: false, reason: "Only SELECT queries are allowed" })

        events = orchestrator.handle_question(question: "delete everything").to_a
        types = events.map { |e| e[:type] }

        expect(types).to include("error")
        expect(events.find { |e| e[:type] == "error" }[:message]).to include("SQL validation failed")
      end

      it "renders graceful message when SQL execution raises (no raw PG error to user)" do
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data","confidence":0.9,"searchTerms":[]}',
          '{"sql":"SELECT COUNT(*) FROM nonexistent","explanation":"count"}',
          '{"sql":"","explanation":""}' # retry returns nothing valid
        )
        allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql)
          .and_return({ valid: true, sql: "SELECT COUNT(*) FROM nonexistent" })
        allow(SqlChatbot::Services::SqlExecutor).to receive(:execute_sql)
          .and_raise(ActiveRecord::StatementInvalid.new("relation \"nonexistent\" does not exist"))

        events = orchestrator.handle_question(question: "count nonexistent").to_a
        types = events.map { |e| e[:type] }

        # No raw error event — graceful token instead (V1.2 #8)
        expect(types).not_to include("error")
        token_text = events.select { |e| e[:type] == "token" }.map { |e| e[:content] }.join
        expect(token_text).to match(/couldn't answer|rephrase/i)
      end
    end

    context "data_with_code questions" do
      it "searches code index and includes code context in SQL generation" do
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data_with_code","confidence":0.85,"searchTerms":["pricing","total"]}',
          '{"sql":"SELECT id, total FROM orders","explanation":"get order totals"}'
        )
        allow(code_indexer).to receive(:search).with(["pricing", "total"]).and_return([
          { file: "app/models/order.rb", content: "def total; subtotal * 1.1; end" }
        ])
        allow(llm_client).to receive(:stream).and_yield("Orders with totals.")
        allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql)
          .and_return({ valid: true, sql: "SELECT id, total FROM orders LIMIT 500" })
        allow(SqlChatbot::Services::SqlExecutor).to receive(:execute_sql)
          .and_return({ rows: [{ "id" => 1, "total" => 110 }], columns: %w[id total], row_count: 1 })

        events = orchestrator.handle_question(question: "How is the order total calculated?").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified sql executing token done])
        expect(code_indexer).to have_received(:search).with(["pricing", "total"])
      end
    end

    context "code questions" do
      it "searches code index and streams answer with code snippets" do
        allow(llm_client).to receive(:call).and_return('{"type":"code","confidence":0.9,"searchTerms":["pricing"]}')
        allow(code_indexer).to receive(:search).with(["pricing"]).and_return([
          { file: "app/models/order.rb", content: "def total; end" }
        ])
        allow(llm_client).to receive(:stream).and_yield("The pricing works like this.")

        events = orchestrator.handle_question(question: "how does pricing work?").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified token done])
        expect(code_indexer).to have_received(:search).with(["pricing"])
      end

      it "emits a fallback token when no code results found" do
        allow(llm_client).to receive(:call).and_return('{"type":"code","confidence":0.9,"searchTerms":["unknown"]}')
        allow(code_indexer).to receive(:search).with(["unknown"]).and_return([])

        events = orchestrator.handle_question(question: "how does unknown work?").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified token done])
        token_event = events.find { |e| e[:type] == "token" }
        expect(token_event[:content]).to include("couldn't find")
      end
    end

    context "navigation questions" do
      it "uses build_route_list and streams answer" do
        allow(llm_client).to receive(:call).and_return('{"type":"navigation","confidence":0.9}')
        allow(code_indexer).to receive(:get_routes).and_return([
          { method: "GET", path: "/admin/settings", file: "app/controllers/settings_controller.rb" }
        ])
        allow(llm_client).to receive(:stream).and_yield("Go to Settings.")

        events = orchestrator.handle_question(question: "where is settings?").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified token done])
        expect(code_indexer).to have_received(:get_routes).at_least(:once)
      end
    end

    context "guidance questions" do
      it "uses build_route_list and streams answer" do
        allow(llm_client).to receive(:call).and_return('{"type":"guidance","confidence":0.88}')
        allow(code_indexer).to receive(:get_routes).and_return([
          { method: "GET", path: "/admin/users", file: "app/controllers/users_controller.rb" }
        ])
        allow(llm_client).to receive(:stream).and_yield("Click the Add User button.")

        events = orchestrator.handle_question(question: "how do I add a user?").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified token done])
      end
    end

    context "unsafe questions" do
      it "emits a static refusal token" do
        allow(llm_client).to receive(:call).and_return('{"type":"unsafe","confidence":0.99}')

        events = orchestrator.handle_question(question: "DROP TABLE users").to_a
        types = events.map { |e| e[:type] }

        expect(types).to eq(%w[classifying classified token done])
        token_event = events.find { |e| e[:type] == "token" }
        expect(token_event[:content]).to include("can't help")
      end
    end

    context "with page_context and history" do
      it "passes page_context and history through the pipeline" do
        allow(llm_client).to receive(:call).and_return('{"type":"greeting","confidence":0.95}')
        allow(llm_client).to receive(:stream).and_yield("Hi there!")

        history = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]
        events = orchestrator.handle_question(
          question: "what can you do?",
          page_context: "Dashboard page",
          history: history
        ).to_a

        expect(events.map { |e| e[:type] }).to eq(%w[classifying classified token done])
      end
    end

    context "error handling" do
      it "emits error event when LLM call raises" do
        allow(llm_client).to receive(:call).and_raise(StandardError.new("API timeout"))

        events = orchestrator.handle_question(question: "test").to_a
        types = events.map { |e| e[:type] }

        expect(types).to include("classifying", "error")
        expect(events.find { |e| e[:type] == "error" }[:message]).to include("took too long")
      end

      it "emits error event when stream raises" do
        allow(llm_client).to receive(:call).and_return('{"type":"greeting","confidence":0.9}')
        allow(llm_client).to receive(:stream).and_raise(StandardError.new("stream failed"))

        events = orchestrator.handle_question(question: "hi").to_a
        types = events.map { |e| e[:type] }

        expect(types).to include("error")
        expect(events.find { |e| e[:type] == "error" }[:message]).to include("Something went wrong")
      end
    end

    context "returns an Enumerator" do
      it "returns an Enumerator that can be lazily consumed" do
        allow(llm_client).to receive(:call).and_return('{"type":"greeting","confidence":0.9}')
        allow(llm_client).to receive(:stream).and_yield("Hi!")

        result = orchestrator.handle_question(question: "hi")
        expect(result).to be_a(Enumerator)
      end
    end

    context "multiple streaming tokens" do
      it "yields multiple token events for chunked stream" do
        allow(llm_client).to receive(:call).and_return('{"type":"greeting","confidence":0.9}')
        allow(llm_client).to receive(:stream)
          .and_yield("Hello")
          .and_yield(", ")
          .and_yield("how can I help?")

        events = orchestrator.handle_question(question: "hi").to_a
        token_events = events.select { |e| e[:type] == "token" }

        expect(token_events.length).to eq(3)
        expect(token_events.map { |e| e[:content] }).to eq(["Hello", ", ", "how can I help?"])
      end
    end

    describe "SQL retry on execution error" do
      # Simulate ActiveRecord::StatementInvalid for unit tests
      let(:statement_invalid_class) do
        stub_const("ActiveRecord::StatementInvalid", Class.new(StandardError))
        ActiveRecord::StatementInvalid
      end

      it "retries with error feedback when SQL execution fails with column error" do
        error = statement_invalid_class.new("PG::UndefinedColumn: column name does not exist")
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data","confidence":0.9,"searchTerms":["users"]}',
          '{"sql":"SELECT name FROM users","explanation":"get names"}',
          '{"sql":"SELECT first_name FROM users","explanation":"get names corrected"}'
        )
        allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql)
          .and_return({ valid: true, sql: "SELECT name FROM users" }, { valid: true, sql: "SELECT first_name FROM users" })
        call_count = 0
        allow(SqlChatbot::Services::SqlExecutor).to receive(:execute_sql) do
          call_count += 1
          if call_count == 1
            raise error
          else
            { rows: [{ "first_name" => "Alice" }], columns: ["first_name"], row_count: 1 }
          end
        end
        allow(llm_client).to receive(:stream).and_yield("Alice")
        allow(code_indexer).to receive(:search).and_return([])

        events = orchestrator.handle_question(question: "show user names").to_a
        token_events = events.select { |e| e[:type] == "token" }
        error_events = events.select { |e| e[:type] == "error" }

        expect(token_events).not_to be_empty
        expect(error_events).to be_empty
        expect(llm_client).to have_received(:call).exactly(3).times
      end

      it "renders graceful message when both original and retry fail (V1.2 #8)" do
        error = statement_invalid_class.new("PG::UndefinedColumn: column bad does not exist")
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data","confidence":0.9,"searchTerms":["users"]}',
          '{"sql":"SELECT bad FROM users","explanation":"bad"}',
          '{"sql":"SELECT also_bad FROM users","explanation":"still bad"}'
        )
        allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql)
          .and_return({ valid: true, sql: "SELECT bad FROM users" }, { valid: true, sql: "SELECT also_bad FROM users" })
        allow(SqlChatbot::Services::SqlExecutor).to receive(:execute_sql)
          .and_raise(error)
        allow(code_indexer).to receive(:search).and_return([])

        events = orchestrator.handle_question(question: "show bad data").to_a
        error_events = events.select { |e| e[:type] == "error" }

        # No raw error to user — graceful token instead.
        expect(error_events).to be_empty
        token_text = events.select { |e| e[:type] == "token" }.map { |e| e[:content] }.join
        expect(token_text).to match(/couldn't answer|rephrase/i)
      end
    end

    describe "#try_fix_column" do
      it "replaces hallucinated 'name' with 'title' from schema" do
        error = "PG::UndefinedColumn: ERROR:  column jt.name does not exist"
        sql = "SELECT jt.id, jt.name FROM job_types jt WHERE jt.status != 3 ORDER BY jt.name"
        schema = "TABLE job_types (id BIGINT PK, title VARCHAR, status INT)"

        result = orchestrator.send(:try_fix_column, error, sql, schema)
        expect(result).to eq("SELECT jt.id, jt.title FROM job_types jt WHERE jt.status != 3 ORDER BY jt.title")
      end

      it "returns nil when column is not in error message" do
        result = orchestrator.send(:try_fix_column, "some other error", "SELECT 1", "TABLE t (id INT)")
        expect(result).to be_nil
      end

      it "returns nil when table alias not found in SQL" do
        error = "PG::UndefinedColumn: ERROR:  column x.name does not exist"
        result = orchestrator.send(:try_fix_column, error, "SELECT 1 FROM foo f", "TABLE foo (id INT, title VARCHAR)")
        expect(result).to be_nil
      end
    end

    describe "smart schema selection" do
      it "uses table_names for classify and select_schema for SQL generation" do
        allow(schema_service).to receive(:table_names).and_return("Available tables: users")
        allow(schema_service).to receive(:select_schema).with(["users"]).and_return("TABLE users (id INT PK, name VARCHAR)")
        allow(llm_client).to receive(:call).and_return(
          '{"type":"data","confidence":0.9,"searchTerms":["users"]}',
          '{"sql":"SELECT COUNT(*) FROM users","explanation":"count"}'
        )
        allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql).and_return({ valid: true, sql: "SELECT COUNT(*) FROM users" })
        allow(SqlChatbot::Services::SqlExecutor).to receive(:execute_sql).and_return({ rows: [{ "count" => 5 }], columns: ["count"], row_count: 1 })
        allow(llm_client).to receive(:stream).and_yield("5 users.")
        allow(code_indexer).to receive(:search).with(["users"]).and_return([])

        events = orchestrator.handle_question(question: "How many users?").to_a
        expect(schema_service).to have_received(:table_names)
        expect(schema_service).to have_received(:select_schema).with(["users"])
        expect(schema_service).not_to have_received(:summary)
      end
    end
  end

  describe "#parse_classification" do
    it "parses valid JSON classification" do
      result = orchestrator.send(:parse_classification, '{"type":"data","confidence":0.9,"searchTerms":["users"]}')
      expect(result[:type]).to eq("data")
      expect(result[:confidence]).to eq(0.9)
      expect(result[:searchTerms]).to eq(["users"])
    end

    it "falls back to data type on parse error" do
      result = orchestrator.send(:parse_classification, "not json")
      expect(result[:type]).to eq("data")
      expect(result[:confidence]).to eq(0.5)
      expect(result[:searchTerms]).to eq([])
    end

    it "falls back to data for invalid type" do
      result = orchestrator.send(:parse_classification, '{"type":"invalid","confidence":0.8}')
      expect(result[:type]).to eq("data")
    end

    it "defaults confidence to 0.5 when missing" do
      result = orchestrator.send(:parse_classification, '{"type":"greeting"}')
      expect(result[:confidence]).to eq(0.5)
    end

    it "defaults searchTerms to empty array when missing" do
      result = orchestrator.send(:parse_classification, '{"type":"code","confidence":0.8}')
      expect(result[:searchTerms]).to eq([])
    end

    it "accepts all valid question types" do
      %w[data data_with_code code navigation guidance greeting unsafe].each do |type|
        result = orchestrator.send(:parse_classification, %({"type":"#{type}","confidence":0.9}))
        expect(result[:type]).to eq(type), "Expected #{type} to be accepted"
      end
    end
  end

  describe "#set_manifest" do
    it "stores manifest routes" do
      manifest = {
        "version" => 1,
        "routes" => [
          { "path" => "/admin/users", "method" => "GET", "label" => "Users" },
          { "path" => "/admin/settings", "method" => "GET", "label" => "Settings" },
        ]
      }
      orchestrator.set_manifest(manifest)
      expect(orchestrator.route_list).to include("/admin/users")
      expect(orchestrator.route_list).to include("Users")
    end
  end

  describe "#route_list" do
    context "with both manifest and code indexer routes" do
      it "merges and deduplicates routes" do
        allow(code_indexer).to receive(:get_routes).and_return([
          { method: "GET", path: "/admin/users", file: "app/controllers/admin/users_controller.rb" },
          { method: "GET", path: "/api/health", file: "app/controllers/health_controller.rb" },
        ])
        manifest = {
          "version" => 1,
          "routes" => [
            { "path" => "/admin/users", "method" => "GET", "label" => "Users" },
            { "path" => "/dashboard", "method" => "GET", "label" => "Dashboard" },
          ]
        }
        orchestrator.set_manifest(manifest)
        list = orchestrator.route_list
        expect(list).to include("Users")
        expect(list).to include("Dashboard")
        expect(list.scan("/admin/users").length).to eq(1)
      end
    end

    context "without manifest" do
      it "falls back to code indexer routes" do
        allow(code_indexer).to receive(:get_routes).and_return([
          { method: "GET", path: "/admin/users", file: "controllers/admin/users_controller.rb" },
        ])
        expect(orchestrator.route_list).to include("/admin/users")
      end
    end
  end

  describe "#parse_sql_generation" do
    it "extracts sql and explanation" do
      result = orchestrator.send(:parse_sql_generation, '{"sql":"SELECT 1","explanation":"test"}')
      expect(result[:sql]).to eq("SELECT 1")
      expect(result[:explanation]).to eq("test")
    end

    it "returns empty sql on parse error" do
      result = orchestrator.send(:parse_sql_generation, "not json")
      expect(result[:sql]).to eq("")
      expect(result[:explanation]).to eq("")
    end

    it "returns empty sql when sql field is missing" do
      result = orchestrator.send(:parse_sql_generation, '{"explanation":"test"}')
      expect(result[:sql]).to eq("")
    end

    it "returns empty sql when sql is not a string" do
      result = orchestrator.send(:parse_sql_generation, '{"sql":123,"explanation":"test"}')
      expect(result[:sql]).to eq("")
    end

    it "defaults explanation to empty string when missing" do
      result = orchestrator.send(:parse_sql_generation, '{"sql":"SELECT 1"}')
      expect(result[:explanation]).to eq("")
    end
  end
end
