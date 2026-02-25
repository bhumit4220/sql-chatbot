require 'spec_helper'
require 'chatbot_agent/db/schema_inspector'

RSpec.describe ChatbotAgent::Db::SchemaInspector do
  let(:mock_connection) { double('connection') }

  before do
    allow(described_class).to receive(:connection).and_return(mock_connection)
  end

  describe '.inspect_schema' do
    it 'returns tables with columns, PKs, and FKs' do
      # Mock tables query
      allow(mock_connection).to receive(:execute).with(/information_schema\.tables/).and_return([
        { 'table_name' => 'customers', 'comment' => 'Customer accounts' },
      ])

      # Mock columns query
      allow(mock_connection).to receive(:execute).with(/information_schema\.columns/).and_return([
        { 'column_name' => 'id', 'data_type' => 'integer', 'is_nullable' => 'NO', 'comment' => nil },
        { 'column_name' => 'name', 'data_type' => 'character varying', 'is_nullable' => 'YES', 'comment' => nil },
        { 'column_name' => 'status', 'data_type' => 'integer', 'is_nullable' => 'NO', 'comment' => nil },
        { 'column_name' => 'created_at', 'data_type' => 'timestamp', 'is_nullable' => 'NO', 'comment' => nil },
      ])

      # Mock PK query
      allow(mock_connection).to receive(:execute).with(/pg_index/).and_return([
        { 'attname' => 'id' },
      ])

      # Mock FK query
      allow(mock_connection).to receive(:execute).with(/FOREIGN KEY/).and_return([
        { 'column_name' => 'status', 'referred_table' => 'statuses', 'referred_column' => 'id' },
      ])

      tables = described_class.inspect_schema
      expect(tables.length).to eq(1)

      table = tables.first
      expect(table[:name]).to eq('customers')
      expect(table[:comment]).to eq('Customer accounts')
      expect(table[:columns].map { |c| c[:name] }).to eq(%w[id name status created_at])
      expect(table[:primary_keys]).to eq(['id'])
      expect(table[:foreign_keys].first[:column]).to eq('status')
      expect(table[:foreign_keys].first[:referred_table]).to eq('statuses')
    end

    it 'filters out sensitive columns' do
      allow(mock_connection).to receive(:execute).with(/information_schema\.tables/).and_return([
        { 'table_name' => 'users', 'comment' => nil },
      ])

      allow(mock_connection).to receive(:execute).with(/information_schema\.columns/).and_return([
        { 'column_name' => 'id', 'data_type' => 'integer', 'is_nullable' => 'NO', 'comment' => nil },
        { 'column_name' => 'email', 'data_type' => 'varchar', 'is_nullable' => 'NO', 'comment' => nil },
        { 'column_name' => 'password_digest', 'data_type' => 'varchar', 'is_nullable' => 'NO', 'comment' => nil },
        { 'column_name' => 'auth_token', 'data_type' => 'varchar', 'is_nullable' => 'YES', 'comment' => nil },
        { 'column_name' => 'stripe_customer_id', 'data_type' => 'varchar', 'is_nullable' => 'YES', 'comment' => nil },
        { 'column_name' => 'name', 'data_type' => 'varchar', 'is_nullable' => 'NO', 'comment' => nil },
      ])

      allow(mock_connection).to receive(:execute).with(/pg_index/).and_return([{ 'attname' => 'id' }])
      allow(mock_connection).to receive(:execute).with(/FOREIGN KEY/).and_return([])

      tables = described_class.inspect_schema
      col_names = tables.first[:columns].map { |c| c[:name] }
      expect(col_names).to include('id', 'name')
      expect(col_names).not_to include('password_digest', 'auth_token', 'stripe_customer_id')
    end
  end

  describe '.format_for_prompt' do
    it 'formats tables as TABLE name (col1, col2, ...)' do
      tables = [
        { name: 'customers', columns: [{ name: 'id' }, { name: 'name' }, { name: 'status' }] },
        { name: 'jobs', columns: [{ name: 'id' }, { name: 'title' }] },
      ]

      result = described_class.format_for_prompt(tables)
      expect(result).to include('TABLE customers (id, name, status)')
      expect(result).to include('TABLE jobs (id, title)')
    end
  end
end
