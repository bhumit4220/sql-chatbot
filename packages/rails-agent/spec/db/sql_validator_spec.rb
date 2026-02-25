require 'spec_helper'
require 'chatbot_agent/db/sql_validator'

RSpec.describe ChatbotAgent::Db::SqlValidator do
  describe '.validate' do
    # Valid queries
    it 'allows simple SELECT' do
      result = described_class.validate('SELECT COUNT(*) FROM contractors WHERE status = 1')
      expect(result[:valid]).to be true
    end

    it 'allows SELECT with JOIN' do
      sql = 'SELECT c.first_name, COUNT(j.id) FROM contractors c JOIN jobs j ON c.id = j.contractor_id GROUP BY c.first_name'
      result = described_class.validate(sql)
      expect(result[:valid]).to be true
    end

    it 'allows SELECT with subquery' do
      sql = 'SELECT * FROM contractors WHERE id IN (SELECT contractor_id FROM jobs WHERE status = 11)'
      result = described_class.validate(sql)
      expect(result[:valid]).to be true
    end

    it 'adds LIMIT 500 when no LIMIT present' do
      result = described_class.validate('SELECT * FROM contractors')
      expect(result[:valid]).to be true
      expect(result[:sql]).to include('LIMIT 500')
    end

    it 'preserves existing LIMIT' do
      result = described_class.validate('SELECT * FROM contractors LIMIT 10')
      expect(result[:valid]).to be true
      expect(result[:sql]).not_to include('LIMIT 500')
    end

    # Blocked mutations
    it 'rejects INSERT' do
      result = described_class.validate("INSERT INTO contractors (first_name) VALUES ('hack')")
      expect(result[:valid]).to be false
      expect(result[:reason]).to include('SELECT')
    end

    it 'rejects UPDATE' do
      result = described_class.validate('UPDATE contractors SET status = 3')
      expect(result[:valid]).to be false
    end

    it 'rejects DELETE' do
      result = described_class.validate('DELETE FROM contractors')
      expect(result[:valid]).to be false
    end

    it 'rejects DROP TABLE' do
      result = described_class.validate('DROP TABLE contractors')
      expect(result[:valid]).to be false
    end

    # CTE mutations
    it 'rejects CTE with DELETE' do
      sql = 'WITH deleted AS (DELETE FROM contractors RETURNING *) SELECT * FROM deleted'
      result = described_class.validate(sql)
      expect(result[:valid]).to be false
    end

    # SELECT INTO
    it 'rejects SELECT INTO' do
      result = described_class.validate('SELECT * INTO new_table FROM contractors')
      expect(result[:valid]).to be false
    end

    # Multiple statements
    it 'rejects multiple statements' do
      result = described_class.validate('SELECT 1; DROP TABLE contractors;')
      expect(result[:valid]).to be false
    end

    # Dangerous functions
    it 'rejects pg_read_file' do
      result = described_class.validate("SELECT pg_read_file('/etc/passwd')")
      expect(result[:valid]).to be false
      expect(result[:reason]).to include('pg_read_file')
    end

    it 'rejects pg_sleep' do
      result = described_class.validate('SELECT pg_sleep(10)')
      expect(result[:valid]).to be false
    end

    it 'rejects dblink' do
      result = described_class.validate("SELECT * FROM dblink('host=evil', 'SELECT 1')")
      expect(result[:valid]).to be false
    end

    # System catalog access
    it 'rejects pg_stat_activity' do
      result = described_class.validate('SELECT * FROM pg_stat_activity')
      expect(result[:valid]).to be false
    end

    it 'rejects information_schema' do
      result = described_class.validate('SELECT * FROM information_schema.tables')
      expect(result[:valid]).to be false
    end

    # Syntax errors
    it 'rejects invalid SQL syntax' do
      result = described_class.validate('SELEKT * FROM oops')
      expect(result[:valid]).to be false
      expect(result[:reason]).to include('parse')
    end
  end
end
