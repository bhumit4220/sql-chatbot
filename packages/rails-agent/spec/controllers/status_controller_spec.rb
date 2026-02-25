require 'spec_helper'
require 'tmpdir'
require 'fileutils'
require 'chatbot_agent/orchestration/status_reporter'

RSpec.describe ChatbotAgent::Orchestration::StatusReporter do
  let(:tmpdir) { Dir.mktmpdir }
  let(:cache_path) { File.join(tmpdir, 'cache.sqlite3') }
  let(:index_path) { File.join(tmpdir, 'code_index.sqlite3') }

  after { FileUtils.remove_entry(tmpdir) }

  let(:schema_data) do
    [{ table: 'jobs', columns: [{ name: 'id', type: 'integer' }] }]
  end

  def build_pipeline(run: false)
    pipeline = ChatbotAgent::Discovery::Pipeline.new(
      cache_path: cache_path,
      index_path: index_path,
      schema_inspector: -> { schema_data },
      enum_sampler: ->(**_opts) { [] },
      label_inference: ->(candidates, _models_path) { candidates },
      model_parser: ->(_dir) { {} },
      models_path: tmpdir,
      app_path: tmpdir,
    )
    pipeline.run(async_code_index: false) if run
    pipeline
  end

  describe '#status' do
    it 'returns ready status when pipeline is complete' do
      pipeline = build_pipeline(run: true)
      reporter = described_class.new(pipeline: pipeline)

      result = reporter.status

      expect(result[:status]).to eq('ready')
      expect(result[:version]).to match(/\d+\.\d+\.\d+/)
    end

    it 'returns not_ready status when pipeline has not run' do
      pipeline = build_pipeline(run: false)
      reporter = described_class.new(pipeline: pipeline)

      result = reporter.status

      expect(result[:status]).to eq('not_ready')
    end

    it 'includes discovery state' do
      pipeline = build_pipeline(run: true)
      reporter = described_class.new(pipeline: pipeline)

      result = reporter.status

      expect(result[:discoveryState]).to eq({
        schema: 'completed',
        enums: 'completed',
        models: 'completed',
        code: 'completed',
      })
    end

    it 'includes auth_required flag' do
      pipeline = build_pipeline(run: true)
      reporter = described_class.new(pipeline: pipeline)

      result = reporter.status

      expect(result).to have_key(:authRequired)
    end
  end

  describe '#rediscover' do
    it 'triggers pipeline rediscovery' do
      pipeline = build_pipeline(run: true)
      reporter = described_class.new(pipeline: pipeline)

      # After rediscover, state should be completed again
      reporter.rediscover

      expect(pipeline.state[:schema]).to eq('completed')
    end

    it 'returns updated status after rediscovery' do
      pipeline = build_pipeline(run: true)
      reporter = described_class.new(pipeline: pipeline)

      result = reporter.rediscover

      expect(result[:status]).to eq('ready')
      expect(result[:message]).to include('Rediscovery')
    end
  end
end
