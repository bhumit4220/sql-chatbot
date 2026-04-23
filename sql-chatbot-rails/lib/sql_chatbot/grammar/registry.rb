# frozen_string_literal: true

require "time"

module SqlChatbot
  module Grammar
    Entity = Struct.new(:name, :table, :display_label, :row_count, :primary_key,
                        :timestamps, :fields, :scopes, :associations, :ranking_candidates,
                        keyword_init: true) do
      def initialize(**kwargs)
        super(
          name: kwargs[:name],
          table: kwargs[:table],
          display_label: kwargs[:display_label] || kwargs[:name]&.capitalize,
          row_count: kwargs[:row_count] || 0,
          primary_key: kwargs[:primary_key] || "id",
          timestamps: kwargs[:timestamps] || {},
          fields: kwargs[:fields] || {},
          scopes: kwargs[:scopes] || {},
          associations: kwargs[:associations] || {},
          ranking_candidates: kwargs[:ranking_candidates] || []
        )
      end
    end

    Field = Struct.new(:column, :type, :nullable, :enum_values, :fk_to,
                       :user_facing_label, :searchable, keyword_init: true)

    Scope = Struct.new(:name, :where_clause, :param_slots, keyword_init: true)

    Association = Struct.new(:name, :kind, :target_entity, :join_clause,
                             :through_entity, keyword_init: true)

    class Registry
      attr_reader :entities, :aliases, :version, :generated_at, :framework

      def initialize(framework:, entities: {}, aliases: {})
        @framework = framework
        @entities = entities
        @aliases = aliases
        @version = 1
        @generated_at = Time.now.utc.iso8601
      end

      def find_entity(name)
        @entities[name.to_s]
      end

      def resolve_alias(term)
        return @aliases[term.to_s] if @aliases.key?(term.to_s)
        return term.to_s if @entities.key?(term.to_s)
        nil
      end
    end
  end
end
