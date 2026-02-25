require 'fileutils'
require 'chatbot_agent/configuration'
require 'chatbot_agent/middleware/auth'
require 'chatbot_agent/cloud_client'
require 'chatbot_agent/db/sql_validator'
require 'chatbot_agent/db/sql_executor'

module ChatbotAgent
  class << self
    attr_accessor :configuration, :pipeline

    def configure
      self.configuration ||= Configuration.new
      yield(configuration)
    end

    def config
      configuration || Configuration.new
    end

    def initialize_pipeline!
      require 'chatbot_agent/discovery/pipeline'
      require 'chatbot_agent/db/schema_inspector'
      require 'chatbot_agent/discovery/enum_sampler'
      require 'chatbot_agent/discovery/label_inference'
      require 'chatbot_agent/discovery/model_parser'

      rails_root = Rails.root.to_s
      cache_dir = File.join(rails_root, 'tmp', 'chatbot_agent')
      FileUtils.mkdir_p(cache_dir)

      self.pipeline = Discovery::Pipeline.new(
        cache_path: File.join(cache_dir, 'discovery_cache.json'),
        index_path: File.join(cache_dir, 'code_index.sqlite3'),
        schema_inspector: -> { Db::SchemaInspector.inspect_schema },
        enum_sampler: -> { Discovery::EnumSampler.detect_candidates },
        label_inference: ->(candidates, models_path) { Discovery::LabelInference.infer_labels(candidates, models_path: models_path) },
        model_parser: ->(path) { Discovery::ModelParser.parse_directory(path) },
        models_path: File.join(rails_root, 'app', 'models'),
        app_path: File.join(rails_root, 'app')
      )

      pipeline.run(async_code_index: true)
    end
  end
end

require 'chatbot_agent/engine' if defined?(Rails)
