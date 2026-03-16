require "spec_helper"
require "sql_chatbot/services/sql_executor"

RSpec.describe SqlChatbot::Services::SqlExecutor do
  describe ".validate_sql" do
    it "allows valid SELECT" do
      result = described_class.validate_sql("SELECT * FROM users")
      expect(result[:valid]).to be true
      expect(result[:sql]).to include("LIMIT 500")
    end

    it "rejects non-SELECT" do
      result = described_class.validate_sql("DELETE FROM users")
      expect(result[:valid]).to be false
      expect(result[:reason]).to include("Only SELECT")
    end

    it "rejects INSERT keyword" do
      result = described_class.validate_sql("SELECT * FROM users; INSERT INTO users VALUES (1)")
      expect(result[:valid]).to be false
    end

    it "rejects multiple statements" do
      result = described_class.validate_sql("SELECT 1; SELECT 2")
      expect(result[:valid]).to be false
      expect(result[:reason]).to include("single statement")
    end

    %w[INSERT UPDATE DELETE DROP ALTER CREATE TRUNCATE GRANT REVOKE EXECUTE COPY INTO].each do |keyword|
      it "blocks #{keyword} keyword" do
        result = described_class.validate_sql("SELECT #{keyword} FROM test")
        expect(result[:valid]).to be false
        expect(result[:reason]).to include("Blocked keyword")
      end
    end

    %w[pg_read_file pg_read_binary_file dblink pg_terminate_backend lo_import lo_export pg_sleep set_config current_setting].each do |fn|
      it "blocks #{fn} function" do
        result = described_class.validate_sql("SELECT #{fn}('test')")
        expect(result[:valid]).to be false
        expect(result[:reason]).to include("Blocked function")
      end
    end

    %w[pg_shadow pg_roles pg_authid pg_user information_schema].each do |catalog|
      it "blocks #{catalog} catalog" do
        result = described_class.validate_sql("SELECT * FROM #{catalog}")
        expect(result[:valid]).to be false
        expect(result[:reason]).to include("Blocked system catalog")
      end
    end

    it "does not add LIMIT to aggregate queries" do
      result = described_class.validate_sql("SELECT COUNT(*) FROM users")
      expect(result[:valid]).to be true
      expect(result[:sql]).not_to include("LIMIT")
    end

    it "adds LIMIT 500 to non-aggregate queries" do
      result = described_class.validate_sql("SELECT name FROM users")
      expect(result[:valid]).to be true
      expect(result[:sql]).to include("LIMIT 500")
    end

    it "does not add LIMIT if already present" do
      result = described_class.validate_sql("SELECT name FROM users LIMIT 10")
      expect(result[:valid]).to be true
      expect(result[:sql]).not_to include("LIMIT 500")
    end

    it "strips SQL comments" do
      result = described_class.validate_sql("SELECT * FROM users -- comment")
      expect(result[:valid]).to be true
    end

    it "fixes missing space after SELECT" do
      result = described_class.validate_sql("SELECTCOUNT(*) FROM users")
      expect(result[:valid]).to be true
      expect(result[:sql]).to start_with("SELECT COUNT")
    end
  end
end
