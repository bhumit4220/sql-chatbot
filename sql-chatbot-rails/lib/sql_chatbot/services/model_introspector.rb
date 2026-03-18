# frozen_string_literal: true

require "set"

module SqlChatbot
  module Services
    class ModelIntrospector
      # Returns Hash of table_name => [annotation_strings]
      # Annotations match the schema summary format: "  -- TYPE: details"
      def introspect
        annotations = Hash.new { |h, k| h[k] = Set.new }

        models = discover_models
        models.each do |model|
          table = model.table_name

          detect_enums(model, table, annotations)
          detect_associations(model, table, annotations)
        end

        # Convert Sets to Arrays (deduplication handles STI)
        annotations.transform_values(&:to_a)
      end

      private

      def discover_models
        return [] unless defined?(ActiveRecord::Base)

        load_models

        ActiveRecord::Base.descendants.select do |model|
          !model.abstract_class? &&
            model.respond_to?(:table_name) &&
            safe_table_exists?(model)
        end
      end

      def load_models
        return unless defined?(Rails) && Rails.respond_to?(:application) && Rails.application

        if Rails.application.config.eager_load
          return # Production: already loaded
        end

        # Development/test: load model files via Zeitwerk if available
        if defined?(Zeitwerk) && Rails.autoloaders.respond_to?(:main)
          model_paths = Rails.application.paths["app/models"]&.to_a || []
          model_paths.each do |path|
            abs_path = Rails.root.join(path).to_s
            Rails.autoloaders.main.eager_load_dir(abs_path) if Dir.exist?(abs_path)
          end
        else
          # Fallback for older Rails: eager_load everything
          Rails.application.eager_load!
        end
      rescue => e
        warn "[SqlChatbot] ModelIntrospector: Could not load models: #{e.message}"
      end

      def safe_table_exists?(model)
        model.table_exists?
      rescue => _e
        false
      end

      def detect_enums(model, table, annotations)
        return unless model.respond_to?(:defined_enums)

        model.defined_enums.each do |column, values|
          next if values.empty?

          formatted = values.map { |label, num| "#{label}=#{num}" }.join(", ")
          annotations[table].add("  -- RAILS ENUM: #{column} values: #{formatted}")
        end
      end

      def detect_associations(model, table, annotations)
        return unless model.respond_to?(:reflect_on_all_associations)

        model.reflect_on_all_associations(:belongs_to).each do |reflection|
          next if reflection.respond_to?(:polymorphic?) && reflection.polymorphic?

          fk = reflection.foreign_key.to_s
          target_class = reflection.class_name
          standard_fk = "#{reflection.name}_id"
          standard_class = reflection.name.to_s.split("_").map(&:capitalize).join

          non_standard_fk = (fk != standard_fk)
          non_standard_class = (target_class != standard_class)

          next unless non_standard_fk || non_standard_class

          target_table = resolve_table_name(target_class)

          detail = "belongs_to :#{reflection.name}"
          detail += ", class_name: \"#{target_class}\"" if non_standard_class
          detail += ", foreign_key: \"#{fk}\"" if non_standard_fk

          annotations[table].add("  -- MODEL FK: #{fk} -> #{target_table}.id (#{detail})")
        end
      end

      def resolve_table_name(class_name)
        class_name.constantize.table_name
      rescue NameError
        # Fallback: simple pluralization
        class_name.gsub(/([a-z])([A-Z])/, '\1_\2').downcase + "s"
      end
    end
  end
end
