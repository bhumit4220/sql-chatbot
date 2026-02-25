require 'spec_helper'
require 'chatbot_agent/db/sql_executor'

RSpec.describe ChatbotAgent::Db::SqlExecutor do
  let(:mock_connection) { double('connection') }

  before do
    allow(described_class).to receive(:connection).and_return(mock_connection)
  end

  describe '.execute' do
    it 'wraps query in READ ONLY transaction' do
      expect(mock_connection).to receive(:execute).with('BEGIN').ordered
      expect(mock_connection).to receive(:execute).with('SET TRANSACTION READ ONLY').ordered
      expect(mock_connection).to receive(:execute)
        .with('SELECT COUNT(*) FROM customers')
        .and_return([{ 'count' => 42 }])
        .ordered
      expect(mock_connection).to receive(:execute).with('COMMIT').ordered

      result = described_class.execute('SELECT COUNT(*) FROM customers')
      expect(result[:success]).to be true
      expect(result[:rows]).to eq([{ 'count' => 42 }])
    end

    it 'rolls back on error' do
      expect(mock_connection).to receive(:execute).with('BEGIN').ordered
      expect(mock_connection).to receive(:execute).with('SET TRANSACTION READ ONLY').ordered
      expect(mock_connection).to receive(:execute)
        .with('SELECT * FROM nonexistent')
        .and_raise(StandardError, 'relation "nonexistent" does not exist')
        .ordered
      expect(mock_connection).to receive(:execute).with('ROLLBACK').ordered

      result = described_class.execute('SELECT * FROM nonexistent')
      expect(result[:success]).to be false
      expect(result[:error]).to include('nonexistent')
    end

    it 'returns column names and row count' do
      allow(mock_connection).to receive(:execute).with('BEGIN')
      allow(mock_connection).to receive(:execute).with('SET TRANSACTION READ ONLY')
      allow(mock_connection).to receive(:execute).with('COMMIT')

      mock_result = [
        { 'id' => 1, 'name' => 'Alice' },
        { 'id' => 2, 'name' => 'Bob' },
      ]
      allow(mock_connection).to receive(:execute)
        .with('SELECT id, name FROM customers LIMIT 2')
        .and_return(mock_result)

      result = described_class.execute('SELECT id, name FROM customers LIMIT 2')
      expect(result[:success]).to be true
      expect(result[:columns]).to eq(%w[id name])
      expect(result[:rows].length).to eq(2)
    end
  end
end
