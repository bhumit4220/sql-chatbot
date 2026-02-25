require 'spec_helper'
require 'chatbot_agent/discovery/enum_sampler'

RSpec.describe ChatbotAgent::Discovery::EnumSampler do
  let(:mock_connection) { double('connection') }

  before do
    allow(described_class).to receive(:connection).and_return(mock_connection)
  end

  describe '.detect_candidates' do
    it 'detects integer columns with low cardinality as enum candidates' do
      # Mock row count check — small table
      allow(mock_connection).to receive(:execute).with(/pg_class/).and_return([
        { 'tablename' => 'customers', 'row_estimate' => 5000 },
        { 'tablename' => 'jobs', 'row_estimate' => 10000 },
      ])

      # Mock integer columns query
      allow(mock_connection).to receive(:execute).with(/information_schema\.columns/).and_return([
        { 'table_name' => 'customers', 'column_name' => 'status' },
        { 'table_name' => 'customers', 'column_name' => 'login_type' },
        { 'table_name' => 'jobs', 'column_name' => 'service_type' },
      ])

      # Mock statement_timeout
      allow(mock_connection).to receive(:execute).with(/statement_timeout/)

      # Mock distinct value queries
      allow(mock_connection).to receive(:execute).with(/DISTINCT.*"status"/).and_return([
        { 'val' => 1 }, { 'val' => 2 }, { 'val' => 3 },
      ])
      allow(mock_connection).to receive(:execute).with(/DISTINCT.*"login_type"/).and_return([
        { 'val' => 1 }, { 'val' => 2 }, { 'val' => 3 }, { 'val' => 4 }, { 'val' => 5 },
      ])
      allow(mock_connection).to receive(:execute).with(/DISTINCT.*"service_type"/).and_return([
        { 'val' => 1 }, { 'val' => 2 }, { 'val' => 3 },
      ])

      # Mock reset timeout
      allow(mock_connection).to receive(:execute).with(/statement_timeout.*0/)

      candidates = described_class.detect_candidates(
        exclude_pks: Set.new(['customers.id', 'jobs.id']),
        exclude_fks: Set.new(['jobs.customer_id'])
      )

      expect(candidates.length).to eq(3)
      expect(candidates.first[:table]).to eq('customers')
      expect(candidates.first[:column]).to eq('status')
      expect(candidates.first[:distinct_values]).to eq([1, 2, 3])
    end

    it 'skips columns with too many distinct values (> 30)' do
      allow(mock_connection).to receive(:execute).with(/pg_class/).and_return([
        { 'tablename' => 'events', 'row_estimate' => 100 },
      ])

      allow(mock_connection).to receive(:execute).with(/information_schema\.columns/).and_return([
        { 'table_name' => 'events', 'column_name' => 'event_code' },
      ])

      allow(mock_connection).to receive(:execute).with(/statement_timeout/)

      # 31 distinct values — too many for enum
      allow(mock_connection).to receive(:execute).with(/DISTINCT.*"event_code"/).and_return(
        (1..31).map { |i| { 'val' => i } }
      )

      candidates = described_class.detect_candidates
      expect(candidates).to be_empty
    end

    it 'skips tables with > 1M estimated rows' do
      allow(mock_connection).to receive(:execute).with(/pg_class/).and_return([
        { 'tablename' => 'huge_table', 'row_estimate' => 2_000_000 },
      ])

      allow(mock_connection).to receive(:execute).with(/information_schema\.columns/).and_return([
        { 'table_name' => 'huge_table', 'column_name' => 'status' },
      ])

      # Should not query distinct values for huge table
      expect(mock_connection).not_to receive(:execute).with(/DISTINCT/)

      candidates = described_class.detect_candidates
      expect(candidates).to be_empty
    end

    it 'excludes PK and FK columns' do
      allow(mock_connection).to receive(:execute).with(/pg_class/).and_return([
        { 'tablename' => 'jobs', 'row_estimate' => 500 },
      ])

      allow(mock_connection).to receive(:execute).with(/information_schema\.columns/).and_return([
        { 'table_name' => 'jobs', 'column_name' => 'id' },
        { 'table_name' => 'jobs', 'column_name' => 'customer_id' },
        { 'table_name' => 'jobs', 'column_name' => 'status' },
      ])

      allow(mock_connection).to receive(:execute).with(/statement_timeout/)
      allow(mock_connection).to receive(:execute).with(/DISTINCT.*"status"/).and_return([
        { 'val' => 1 }, { 'val' => 2 },
      ])

      candidates = described_class.detect_candidates(
        exclude_pks: Set.new(['jobs.id']),
        exclude_fks: Set.new(['jobs.customer_id'])
      )

      expect(candidates.length).to eq(1)
      expect(candidates.first[:column]).to eq('status')
    end
  end

  describe '.format_for_prompt' do
    it 'formats candidates with labels as column: value=Label' do
      candidates = [
        { table: 'customers', column: 'status', distinct_values: [1, 2, 3],
          labels: { 1 => 'Active', 2 => 'Inactive', 3 => 'Deleted' } },
        { table: 'jobs', column: 'service_type', distinct_values: [1, 2, 3],
          labels: { 1 => 'Quoted', 2 => 'Bid', 3 => 'Houlry' } },
      ]

      result = described_class.format_for_prompt(candidates)
      expect(result).to include('customers.status: 1=Active, 2=Inactive, 3=Deleted')
      expect(result).to include('jobs.service_type: 1=Quoted, 2=Bid, 3=Houlry')
    end

    it 'uses numeric labels when no label inference available' do
      candidates = [
        { table: 'users', column: 'role', distinct_values: [0, 1, 2], labels: {} },
      ]

      result = described_class.format_for_prompt(candidates)
      expect(result).to include('users.role: 0, 1, 2')
    end
  end
end
