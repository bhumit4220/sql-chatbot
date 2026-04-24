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
        Grammar::Registry.new(framework: "rails", entities: entities, aliases: build_entity_aliases(entities))
      end

      # Build aliases that map common question phrasings to canonical entity names.
      # Rules (no clash with a real canonical entity name):
      #   multi-word form (spaces) → snake_case entity name
      #     "service areas" → "service_area"
      #   plural form → singular entity name
      #     "users" / "customers" → already handled by string-match scoring,
      #     but we also explicitly map plural-snake → canonical
      def build_entity_aliases(entities)
        aliases = {}
        entities.each_key do |name|
          # "service_area" → "service areas", "service area", "service_areas"
          spaced     = name.tr("_", " ")
          spaced_plu = pluralize_simple(spaced)
          snake_plu  = pluralize_simple(name)
          [spaced, spaced_plu, snake_plu].each do |alt|
            next if alt == name
            next if entities.key?(alt)
            next if aliases.key?(alt)
            aliases[alt] = name
          end
        end
        aliases
      end

      def pluralize_simple(word)
        return word + "es" if word.end_with?("s", "x", "ch", "sh")
        return word[0..-2] + "ies" if word.end_with?("y") && !%w[a e i o u].include?(word[-2])
        word + "s"
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
          scopes: build_scopes(model),
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
        fields = {}
        model.columns_hash.each do |col, info|
          enum_vals = enums[col]
          type = enum_vals ? :enum : map_type(info.type)
          fields[col] = Grammar::Field.new(
            column: col,
            type: type,
            nullable: info.null,
            enum_values: enum_vals,
            fk_to: nil,
            user_facing_label: col.humanize,
            searchable: type == :text
          )
        end
        # Add field aliases for common human phrasings. For each real column,
        # detect short synonyms and register alias keys pointing to the same
        # Field struct. Only register an alias if it doesn't clash with an
        # actual column and doesn't become ambiguous across two columns.
        add_field_aliases!(fields)
        fields
      end

      # Register alias keys on the fields hash so lookups like
      # fields["rating"] work when the real column is "avg_rating".
      # Rules:
      #   avg_X / X_avg → X           (e.g., avg_rating → rating)
      #   X_count       → count       (e.g., jobs_count → count)
      #   total_X / X_total → total   (e.g., total_amount → total)
      #   num_X         → X           (e.g., num_orders → orders)
      # An alias is only added if (a) no real column has that name and
      # (b) at most one existing field maps to that alias across the model.
      def add_field_aliases!(fields)
        alias_candidates = Hash.new { |h, k| h[k] = [] }
        fields.each do |col, field|
          synonyms_for(col).each { |syn| alias_candidates[syn] << field }
        end
        alias_candidates.each do |alias_key, matching_fields|
          next if fields.key?(alias_key)             # don't shadow real column
          next unless matching_fields.size == 1      # skip ambiguous aliases
          fields[alias_key] = matching_fields.first
        end
      end

      def synonyms_for(col)
        syns = []
        if col =~ /\Aavg_(.+)\z/        then syns << Regexp.last_match(1) end
        if col =~ /\A(.+)_avg\z/        then syns << Regexp.last_match(1) end
        if col =~ /\A(.+)_count\z/      then syns << "count"; syns << Regexp.last_match(1) end
        if col =~ /\Atotal_(.+)\z/      then syns << "total"; syns << Regexp.last_match(1) end
        if col =~ /\A(.+)_total\z/      then syns << "total" end
        if col =~ /\Anum_(.+)\z/        then syns << Regexp.last_match(1) end
        syns
      end

      def build_scopes(model)
        scopes = {}
        enum_generated = enum_generated_scope_names(model)

        model.singleton_methods(false).each do |method_name|
          next if enum_generated.include?(method_name)

          begin
            relation = model.send(method_name)
            next unless relation.is_a?(ActiveRecord::Relation)
            sql = relation.to_sql
            where_match = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s*$)/i)
            where_clause = where_match ? where_match[1].strip : ""

            scopes[method_name.to_s] = Grammar::Scope.new(
              name: method_name.to_s,
              where_clause: where_clause,
              param_slots: []
            )
          rescue
            # skip scopes that raise (e.g. require arguments or reference missing columns)
          end
        end

        scopes
      rescue => e
        warn "[SqlChatbot] scope extraction for #{model}: #{e.message}"
        {}
      end

      # Returns a Set of method names that AR auto-generates for enum columns
      # (e.g. :active, :not_active, :banned, :not_banned, :statuses).
      def enum_generated_scope_names(model)
        generated = Set.new
        model.defined_enums.each do |col, values|
          values.keys.each do |v|
            generated << v.to_sym
            generated << :"not_#{v}"
          end
          # AR adds a pluralized class accessor (e.g. User.statuses)
          generated << :"#{col}s"
        end
        generated
      rescue
        Set.new
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
