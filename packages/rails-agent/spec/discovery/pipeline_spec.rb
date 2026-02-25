require 'spec_helper'
require 'tmpdir'
require 'fileutils'
require 'chatbot_agent/discovery/pipeline'
require 'chatbot_agent/discovery/cache'

RSpec.describe ChatbotAgent::Discovery::Pipeline do
  let(:tmpdir) { Dir.mktmpdir }
  let(:cache_path) { File.join(tmpdir, 'cache.sqlite3') }
  let(:index_path) { File.join(tmpdir, 'code_index.sqlite3') }

  after { FileUtils.remove_entry(tmpdir) }

  # Stubs for components that need ActiveRecord/PG
  let(:schema_data) do
    [
      { table: 'jobs', columns: [{ name: 'id', type: 'integer' }, { name: 'status', type: 'integer' }] },
      { table: 'customers', columns: [{ name: 'id', type: 'integer' }, { name: 'email', type: 'varchar' }] },
    ]
  end

  let(:enum_candidates) do
    [
      { table: 'jobs', column: 'status', distinct_values: [1, 2, 3], labels: {} },
    ]
  end

  let(:model_data) do
    {
      'job' => {
        associations: [{ type: :belongs_to, name: 'customer', options: { foreign_key: 'created_by' } }],
        enums: [{ name: 'status', values: { 'Active' => '1', 'Inactive' => '2', 'Deleted' => '3' } }],
        default_scopes: ['where.not(status: 3)'],
        soft_delete: false,
        includes: ['MyEnums'],
      },
    }
  end

  def build_pipeline(overrides = {})
    described_class.new(
      cache_path: cache_path,
      index_path: index_path,
      schema_inspector: overrides[:schema_inspector] || -> { schema_data },
      enum_sampler: overrides[:enum_sampler] || ->(**_opts) { enum_candidates },
      label_inference: overrides[:label_inference] || ->(candidates, _models_path) { candidates },
      model_parser: overrides[:model_parser] || ->(_dir) { model_data },
      models_path: overrides[:models_path] || File.join(tmpdir, 'models'),
      app_path: overrides[:app_path] || tmpdir,
    )
  end

  describe '#run' do
    it 'completes schema phase synchronously' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:schema]).to eq('completed')
    end

    it 'completes enum phase synchronously' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:enums]).to eq('completed')
    end

    it 'completes model parsing phase synchronously' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:models]).to eq('completed')
    end

    it 'completes code indexing when async_code_index is false' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:code]).to eq('completed')
    end

    it 'stores schema results' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      expect(pipeline.results[:schema]).to eq(schema_data)
    end

    it 'stores enum candidates with labels' do
      inference = ->(candidates, _models_path) do
        candidates.map { |c| c.merge(labels: { '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' }) }
      end
      pipeline = build_pipeline(label_inference: inference)
      pipeline.run(async_code_index: false)

      expect(pipeline.results[:enums].first[:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
    end

    it 'stores model parse results' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      expect(pipeline.results[:models]).to eq(model_data)
    end

    it 'calls schema inspector' do
      called = false
      inspector = -> { called = true; schema_data }
      pipeline = build_pipeline(schema_inspector: inspector)
      pipeline.run(async_code_index: false)

      expect(called).to be true
    end

    it 'calls enum sampler' do
      called = false
      sampler = ->(**_opts) { called = true; enum_candidates }
      pipeline = build_pipeline(enum_sampler: sampler)
      pipeline.run(async_code_index: false)

      expect(called).to be true
    end

    it 'calls model parser with models_path' do
      received_path = nil
      parser = ->(dir) { received_path = dir; model_data }
      models_path = File.join(tmpdir, 'app', 'models')
      pipeline = build_pipeline(model_parser: parser, models_path: models_path)
      pipeline.run(async_code_index: false)

      expect(received_path).to eq(models_path)
    end
  end

  describe '#run with async code indexing' do
    it 'starts code indexing in background' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: true)

      expect(%w[running completed]).to include(pipeline.state[:code])
      pipeline.wait_for_code_index # ensure thread completes before cleanup
    end

    it 'marks code as completed after thread finishes' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: true)
      pipeline.wait_for_code_index # wait for background thread

      expect(pipeline.state[:code]).to eq('completed')
    end
  end

  describe '#ready?' do
    it 'returns true when schema and enums are completed' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      expect(pipeline.ready?).to be true
    end

    it 'returns false before run' do
      pipeline = build_pipeline

      expect(pipeline.ready?).to be false
    end
  end

  describe '#state' do
    it 'starts with all phases pending' do
      pipeline = build_pipeline

      expect(pipeline.state).to eq({
        schema: 'pending',
        enums: 'pending',
        models: 'pending',
        code: 'pending',
      })
    end
  end

  describe 'error handling' do
    it 'marks phase as error when schema inspection fails' do
      failing_inspector = -> { raise 'PG connection failed' }
      pipeline = build_pipeline(schema_inspector: failing_inspector)
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:schema]).to eq('error')
    end

    it 'continues to enum phase even if schema fails' do
      failing_inspector = -> { raise 'PG connection failed' }
      pipeline = build_pipeline(schema_inspector: failing_inspector)
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:enums]).to eq('completed')
    end

    it 'marks enum phase as error when sampler fails' do
      failing_sampler = ->(**_opts) { raise 'sampling error' }
      pipeline = build_pipeline(enum_sampler: failing_sampler)
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:enums]).to eq('error')
    end

    it 'marks model phase as error when parser fails' do
      failing_parser = ->(_dir) { raise 'parse error' }
      pipeline = build_pipeline(model_parser: failing_parser)
      pipeline.run(async_code_index: false)

      expect(pipeline.state[:models]).to eq('error')
    end
  end

  describe 'caching' do
    it 'caches results after successful run' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      cache = ChatbotAgent::Discovery::Cache.new(cache_path)
      cached_schema = cache.get('schema')
      expect(cached_schema).not_to be_nil
    end

    it 'uses cached results when cache is fresh' do
      # First run — populates cache
      pipeline1 = build_pipeline
      pipeline1.run(async_code_index: false)

      # Second run — different inspector that would return different data
      call_count = 0
      counting_inspector = -> { call_count += 1; [{ table: 'different' }] }
      pipeline2 = build_pipeline(schema_inspector: counting_inspector)
      pipeline2.run(async_code_index: false)

      # Inspector should not have been called — cache was used
      expect(call_count).to eq(0)
      expect(pipeline2.results[:schema]).to eq(schema_data)
    end

    it 'refreshes cache when expired' do
      # First run
      pipeline1 = build_pipeline
      pipeline1.run(async_code_index: false)

      # Expire the cache
      cache = ChatbotAgent::Discovery::Cache.new(cache_path)
      cache.expire('schema')

      # Second run with different data
      new_schema = [{ table: 'new_table' }]
      pipeline2 = build_pipeline(schema_inspector: -> { new_schema })
      pipeline2.run(async_code_index: false)

      expect(pipeline2.results[:schema]).to eq(new_schema)
    end
  end

  describe '#rediscover' do
    it 'clears cache and re-runs all phases' do
      pipeline = build_pipeline
      pipeline.run(async_code_index: false)

      new_schema = [{ table: 'updated' }]
      pipeline2 = build_pipeline(schema_inspector: -> { new_schema })
      pipeline2.rediscover(async_code_index: false)

      expect(pipeline2.results[:schema]).to eq(new_schema)
    end
  end
end
