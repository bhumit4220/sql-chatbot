# frozen_string_literal: true

require "sql_chatbot/grammar/registry"

module SqlChatbot
  module Services
    class RegistryBuilder
      SOFT_DELETE_COLS = %w[deleted_at discarded_at archived_at removed_at].freeze

      def build
        entities = {}
        discover_models.each do |model|
          entity_name = model.name.underscore
          entities[entity_name] = build_entity(model, entity_name)
        end
        Grammar::Registry.new(framework: "rails", entities: entities)
      end

      private

      def discover_models
        return [] unless defined?(ActiveRecord::Base)
        eager_load_models!
        ActiveRecord::Base.descendants.select do |m|
          !m.abstract_class? && m.respond_to?(:table_name) && safe_table_exists?(m)
        end
      end

      def eager_load_models!
        return unless defined?(Rails) && Rails.respond_to?(:application) && Rails.application
        return if Rails.application.config.eager_load
        if defined?(Zeitwerk) && Rails.autoloaders.respond_to?(:main)
          Rails.application.paths["app/models"]&.to_a&.each do |p|
            abs = Rails.root.join(p).to_s
            Rails.autoloaders.main.eager_load_dir(abs) if Dir.exist?(abs)
          end
        else
          Rails.application.eager_load!
        end
      rescue => e
        warn "[SqlChatbot] RegistryBuilder eager_load: #{e.message}"
      end

      def safe_table_exists?(model)
        model.table_exists?
      rescue
        false
      end

      def build_entity(model, entity_name)
        Grammar::Entity.new(
          name: entity_name,
          table: model.table_name,
          display_label: model.name,
          row_count: safe_row_count(model),
          primary_key: model.primary_key.to_s,
          timestamps: detect_timestamps(model),
          fields: build_fields(model),
          scopes: {},                           # scope extraction handled in Task 6
          associations: build_associations(model),
          ranking_candidates: ranking_candidates_for(model)
        )
      end

      def safe_row_count(model)
        model.count
      rescue
        0
      end

      def detect_timestamps(model)
        cols = model.columns_hash.keys
        ts = {}
        ts[:created] = "created_at" if cols.include?("created_at")
        ts[:updated] = "updated_at" if cols.include?("updated_at")
        soft = SOFT_DELETE_COLS.find { |c| cols.include?(c) }
        ts[:deleted] = soft if soft
        ts
      end

      def build_fields(model)
        enums = model.defined_enums
        model.columns_hash.each_with_object({}) do |(col, info), h|
          enum_vals = enums[col]
          type = enum_vals ? :enum : map_type(info.type)
          h[col] = Grammar::Field.new(
            column: col,
            type: type,
            nullable: info.null,
            enum_values: enum_vals,
            fk_to: nil,
            user_facing_label: col.humanize,
            searchable: type == :text
          )
        end
      end

      def build_associations(model)
        model.reflect_on_all_associations.each_with_object({}) do |refl, h|
          begin
            next unless refl.klass
            target = refl.klass.name.underscore
            h[refl.name.to_s] = Grammar::Association.new(
              name: refl.name.to_s,
              kind: refl.macro,
              target_entity: target,
              join_clause: join_clause_for(refl),
              through_entity: refl.options[:through]&.to_s
            )
          rescue
            # skip associations pointing to missing models
          end
        end
      end

      def join_clause_for(refl)
        owner_table = refl.active_record.table_name
        target_table = refl.klass.table_name
        case refl.macro
        when :belongs_to
          "#{owner_table}.#{refl.foreign_key} = #{target_table}.#{refl.association_primary_key}"
        when :has_many, :has_one
          "#{owner_table}.#{refl.active_record.primary_key} = #{target_table}.#{refl.foreign_key}"
        else
          ""
        end
      end

      def ranking_candidates_for(model)
        model.columns_hash.select { |_, c| [:integer, :decimal, :float, :datetime].include?(c.type) }.keys
      end

      def map_type(ar_type)
        case ar_type
        when :integer, :bigint then :int
        when :string, :text then :text
        when :boolean then :bool
        when :datetime, :date, :time then :timestamp
        when :decimal, :float then :decimal
        when :json, :jsonb then :jsonb
        when :uuid then :uuid
        else :text
        end
      end
    end
  end
end
