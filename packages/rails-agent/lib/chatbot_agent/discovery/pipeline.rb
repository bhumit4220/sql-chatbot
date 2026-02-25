require 'chatbot_agent/discovery/cache'
require 'chatbot_agent/code/indexer'
require 'chatbot_agent/code/search'

module ChatbotAgent
  module Discovery
    class Pipeline
      attr_reader :state, :results

      def initialize(cache_path:, index_path:, schema_inspector:, enum_sampler:,
                     label_inference:, model_parser:, models_path:, app_path:)
        @cache_path = cache_path
        @index_path = index_path
        @schema_inspector = schema_inspector
        @enum_sampler = enum_sampler
        @label_inference = label_inference
        @model_parser = model_parser
        @models_path = models_path
        @app_path = app_path

        @state = { schema: 'pending', enums: 'pending', models: 'pending', code: 'pending' }
        @results = { schema: nil, enums: nil, models: nil, code: nil }
        @code_thread = nil
      end

      def run(async_code_index: true)
        cache = Cache.new(@cache_path)

        run_schema_phase(cache)
        run_enum_phase(cache)
        run_model_phase(cache)
        run_code_phase(cache, async: async_code_index)
      end

      def rediscover(async_code_index: true)
        cache = Cache.new(@cache_path)
        cache.clear_all
        @state = { schema: 'pending', enums: 'pending', models: 'pending', code: 'pending' }
        @results = { schema: nil, enums: nil, models: nil, code: nil }
        run(async_code_index: async_code_index)
      end

      def ready?
        @state[:schema] == 'completed' && @state[:enums] == 'completed'
      end

      def wait_for_code_index
        @code_thread&.join
      end

      private

      def run_schema_phase(cache)
        @state[:schema] = 'running'
        cached = cache.get('schema')
        if cached
          @results[:schema] = cached
          @state[:schema] = 'completed'
          return
        end

        @results[:schema] = @schema_inspector.call
        cache.set('schema', @results[:schema])
        @state[:schema] = 'completed'
      rescue => _e
        @state[:schema] = 'error'
      end

      def run_enum_phase(cache)
        @state[:enums] = 'running'
        cached = cache.get('enums')
        if cached
          @results[:enums] = cached
          @state[:enums] = 'completed'
          return
        end

        candidates = @enum_sampler.call
        candidates = @label_inference.call(candidates)
        @results[:enums] = candidates
        cache.set('enums', candidates)
        @state[:enums] = 'completed'
      rescue => _e
        @state[:enums] = 'error'
      end

      def run_model_phase(cache)
        @state[:models] = 'running'
        cached = cache.get('models')
        if cached
          @results[:models] = cached
          @state[:models] = 'completed'
          return
        end

        @results[:models] = @model_parser.call(@models_path)
        cache.set('models', @results[:models])
        @state[:models] = 'completed'
      rescue => _e
        @state[:models] = 'error'
      end

      def run_code_phase(cache, async:)
        @state[:code] = 'running'
        if async
          @code_thread = Thread.new do
            begin
              Code::Indexer.index_directory(@app_path, db_path: @index_path)
              @state[:code] = 'completed'
            rescue => _e
              @state[:code] = 'error'
            end
          end
        else
          begin
            Code::Indexer.index_directory(@app_path, db_path: @index_path)
            @state[:code] = 'completed'
          rescue => _e
            @state[:code] = 'error'
          end
        end
      end
    end
  end
end
