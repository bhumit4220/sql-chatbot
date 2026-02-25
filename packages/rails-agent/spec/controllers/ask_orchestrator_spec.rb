require 'spec_helper'
require 'tmpdir'
require 'fileutils'
require 'chatbot_agent/orchestration/ask_orchestrator'

RSpec.describe ChatbotAgent::Orchestration::AskOrchestrator do
  let(:tmpdir) { Dir.mktmpdir }
  let(:cache_path) { File.join(tmpdir, 'cache.sqlite3') }
  let(:index_path) { File.join(tmpdir, 'code_index.sqlite3') }

  after { FileUtils.remove_entry(tmpdir) }

  let(:schema_data) do
    [{ table: 'jobs', columns: [{ name: 'id', type: 'integer' }, { name: 'status', type: 'integer' }] }]
  end

  let(:enum_candidates) do
    [{ table: 'jobs', column: 'status', distinct_values: [1, 2, 3],
       labels: { '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' } }]
  end

  let(:model_data) do
    { 'job' => { associations: [], enums: [], default_scopes: [], soft_delete: false, includes: [] } }
  end

  # Mock cloud client
  let(:cloud_client) do
    client = double('CloudClient')
    allow(client).to receive(:classify).and_return({ 'type' => 'data', 'confidence' => 0.95 })
    allow(client).to receive(:generate_sql).and_return({ 'sql' => 'SELECT id, status FROM jobs LIMIT 10' })
    allow(client).to receive(:stream_answer) do |**_args, &block|
      if block
        block.call('Here')
        block.call(' are')
        block.call(' your results.')
      end
    end
    client
  end

  # Mock SQL validator
  let(:sql_validator) do
    ->(sql) { { valid: true, sql: sql, reason: nil } }
  end

  # Mock SQL executor
  let(:sql_executor) do
    ->(sql) { { success: true, columns: %w[id status], rows: [{ 'id' => 1, 'status' => 1 }], row_count: 1 } }
  end

  # Build a pipeline that's already run
  def build_ready_pipeline
    pipeline = ChatbotAgent::Discovery::Pipeline.new(
      cache_path: cache_path,
      index_path: index_path,
      schema_inspector: -> { schema_data },
      enum_sampler: ->(**_opts) { enum_candidates },
      label_inference: ->(candidates, **_opts) { candidates },
      model_parser: ->(_dir) { model_data },
      models_path: tmpdir,
      app_path: tmpdir,
    )
    pipeline.run(async_code_index: false)
    pipeline
  end

  def build_orchestrator(overrides = {})
    described_class.new(
      pipeline: overrides[:pipeline] || build_ready_pipeline,
      cloud_client: overrides[:cloud_client] || cloud_client,
      sql_validator: overrides[:sql_validator] || sql_validator,
      sql_executor: overrides[:sql_executor] || sql_executor,
    )
  end

  describe '#ask' do
    context 'when pipeline is not ready' do
      it 'returns a not-ready response' do
        unready_pipeline = ChatbotAgent::Discovery::Pipeline.new(
          cache_path: cache_path, index_path: index_path,
          schema_inspector: -> { schema_data },
          enum_sampler: ->(**_opts) { enum_candidates },
          label_inference: ->(candidates, **_opts) { candidates },
          model_parser: ->(_dir) { model_data },
          models_path: tmpdir, app_path: tmpdir,
        )
        orchestrator = build_orchestrator(pipeline: unready_pipeline)

        result = orchestrator.ask(question: 'How many jobs?', history: [])

        expect(result[:status]).to eq(:not_ready)
        expect(result[:message]).to include('still learning')
      end
    end

    context 'with data question type' do
      it 'classifies, generates SQL, validates, executes, and streams answer' do
        orchestrator = build_orchestrator
        tokens = []

        result = orchestrator.ask(question: 'How many active jobs?', history: []) do |token|
          tokens << token
        end

        expect(result[:status]).to eq(:success)
        expect(result[:type]).to eq('data')
        expect(tokens).to eq(['Here', ' are', ' your results.'])
      end

      it 'calls cloud classify with schema summary' do
        expect(cloud_client).to receive(:classify).with(
          question: 'How many jobs?',
          schema_summary: kind_of(String),
          page_context: nil,
        ).and_return({ 'type' => 'data', 'confidence' => 0.95 })

        orchestrator = build_orchestrator
        orchestrator.ask(question: 'How many jobs?', history: [])
      end

      it 'calls cloud generate_sql with schema, enums, and context' do
        expect(cloud_client).to receive(:generate_sql).with(
          question: 'How many jobs?',
          schema: kind_of(String),
          enums: kind_of(String),
          discovered_context: kind_of(String),
          history: [],
          code_context: nil,
          retry_context: nil,
        ).and_return({ 'sql' => 'SELECT count(*) FROM jobs' })

        orchestrator = build_orchestrator
        orchestrator.ask(question: 'How many jobs?', history: [])
      end

      it 'calls SQL executor with validated SQL' do
        executed_sql = nil
        executor = ->(sql) do
          executed_sql = sql
          { success: true, columns: ['count'], rows: [{ 'count' => 5 }], row_count: 1 }
        end

        orchestrator = build_orchestrator(sql_executor: executor)
        orchestrator.ask(question: 'How many jobs?', history: [])

        expect(executed_sql).to eq('SELECT id, status FROM jobs LIMIT 10')
      end

      it 'streams answer tokens via block' do
        tokens = []
        orchestrator = build_orchestrator
        orchestrator.ask(question: 'How many jobs?', history: []) { |t| tokens << t }

        expect(tokens.length).to eq(3)
      end
    end

    context 'with data_with_code question type' do
      it 'searches code index and passes context to generate_sql' do
        client = double('CloudClient')
        allow(client).to receive(:classify).and_return({ 'type' => 'data_with_code', 'confidence' => 0.9 })
        allow(client).to receive(:generate_sql).and_return({ 'sql' => 'SELECT id FROM jobs' })
        allow(client).to receive(:stream_answer) { |**_args, &block| block&.call('Answer') }

        # Need an actual code index for search
        repo = File.join(tmpdir, 'app')
        FileUtils.mkdir_p(repo)
        File.write(File.join(repo, 'model.rb'), "class Job; end")
        ChatbotAgent::Code::Indexer.index_directory(repo, db_path: index_path)

        orchestrator = build_orchestrator(cloud_client: client)
        result = orchestrator.ask(question: 'How does Job model work?', history: [])

        expect(result[:status]).to eq(:success)
        expect(result[:type]).to eq('data_with_code')
      end
    end

    context 'with code question type' do
      it 'searches code and streams answer without SQL' do
        client = double('CloudClient')
        allow(client).to receive(:classify).and_return({ 'type' => 'code', 'confidence' => 0.9 })
        allow(client).to receive(:stream_answer).and_yield('Code explanation')

        orchestrator = build_orchestrator(cloud_client: client)
        tokens = []
        result = orchestrator.ask(question: 'Show me the Job model', history: []) { |t| tokens << t }

        expect(result[:status]).to eq(:success)
        expect(result[:type]).to eq('code')
        expect(tokens).to eq(['Code explanation'])
      end
    end

    context 'with navigation/guidance question type' do
      it 'streams answer without SQL or code search' do
        client = double('CloudClient')
        allow(client).to receive(:classify).and_return({ 'type' => 'guidance', 'confidence' => 0.9 })
        allow(client).to receive(:stream_answer).and_yield('Go to Settings page')

        orchestrator = build_orchestrator(cloud_client: client)
        tokens = []
        result = orchestrator.ask(question: 'How do I change settings?', history: [], page_context: 'Dashboard') { |t| tokens << t }

        expect(result[:status]).to eq(:success)
        expect(result[:type]).to eq('guidance')
        expect(tokens).to eq(['Go to Settings page'])
      end
    end

    context 'SQL validation failure with retry' do
      it 'retries once when SQL validation fails' do
        call_count = 0
        client = double('CloudClient')
        allow(client).to receive(:classify).and_return({ 'type' => 'data', 'confidence' => 0.9 })
        allow(client).to receive(:generate_sql) do |**args|
          call_count += 1
          if call_count == 1
            { 'sql' => 'DELETE FROM jobs' }  # bad SQL
          else
            { 'sql' => 'SELECT count(*) FROM jobs' }  # good SQL on retry
          end
        end
        allow(client).to receive(:stream_answer) { |**_args, &block| block&.call('5 jobs') }

        validator = ->(sql) do
          if sql.downcase.include?('delete')
            { valid: false, sql: nil, reason: 'Only SELECT allowed' }
          else
            { valid: true, sql: sql, reason: nil }
          end
        end

        orchestrator = build_orchestrator(cloud_client: client, sql_validator: validator)
        result = orchestrator.ask(question: 'How many jobs?', history: [])

        expect(call_count).to eq(2)
        expect(result[:status]).to eq(:success)
      end

      it 'returns error after retry also fails validation' do
        client = double('CloudClient')
        allow(client).to receive(:classify).and_return({ 'type' => 'data', 'confidence' => 0.9 })
        allow(client).to receive(:generate_sql).and_return({ 'sql' => 'DELETE FROM jobs' })

        always_invalid = ->(_sql) { { valid: false, sql: nil, reason: 'Only SELECT allowed' } }

        orchestrator = build_orchestrator(cloud_client: client, sql_validator: always_invalid)
        result = orchestrator.ask(question: 'Delete all jobs', history: [])

        expect(result[:status]).to eq(:error)
        expect(result[:message]).to include('validation')
      end
    end

    context 'SQL execution failure' do
      it 'returns error when SQL execution fails' do
        failing_executor = ->(_sql) { { success: false, error: 'relation does not exist', columns: [], rows: [], row_count: 0 } }

        orchestrator = build_orchestrator(sql_executor: failing_executor)
        result = orchestrator.ask(question: 'How many jobs?', history: [])

        expect(result[:status]).to eq(:error)
        expect(result[:message]).to include('execution')
      end
    end

    context 'cloud client errors' do
      it 'returns error when classify fails' do
        client = double('CloudClient')
        allow(client).to receive(:classify).and_raise(ChatbotAgent::CloudClient::ServerError, 'Cloud down')

        orchestrator = build_orchestrator(cloud_client: client)
        result = orchestrator.ask(question: 'How many jobs?', history: [])

        expect(result[:status]).to eq(:error)
        expect(result[:message]).to include('Cloud')
      end
    end

    context 'with conversation history' do
      it 'passes history to cloud client' do
        history = [
          { role: 'user', content: 'How many jobs?' },
          { role: 'assistant', content: 'There are 5 jobs.' },
        ]

        expect(cloud_client).to receive(:generate_sql).with(
          hash_including(history: history)
        ).and_return({ 'sql' => 'SELECT count(*) FROM jobs' })

        orchestrator = build_orchestrator
        orchestrator.ask(question: 'What about active ones?', history: history)
      end
    end
  end

  describe '#build_schema_summary' do
    it 'produces a compact string of table names' do
      orchestrator = build_orchestrator
      summary = orchestrator.send(:build_schema_summary)

      expect(summary).to include('jobs')
    end
  end

  describe '#build_enum_string' do
    it 'formats enum candidates for the prompt' do
      orchestrator = build_orchestrator
      enum_str = orchestrator.send(:build_enum_string)

      expect(enum_str).to include('jobs.status')
      expect(enum_str).to include('Active')
    end
  end

  describe '#build_discovered_context' do
    it 'includes model association info' do
      pipeline = build_ready_pipeline
      pipeline.results[:models] = {
        'job' => {
          associations: [{ type: :belongs_to, name: 'customer', options: { foreign_key: 'created_by' } }],
          enums: [], default_scopes: ['where.not(status: 3)'], soft_delete: false, includes: [],
        },
      }

      orchestrator = build_orchestrator(pipeline: pipeline)
      context = orchestrator.send(:build_discovered_context)

      expect(context).to include('created_by')
      expect(context).to include('customer')
    end
  end
end
