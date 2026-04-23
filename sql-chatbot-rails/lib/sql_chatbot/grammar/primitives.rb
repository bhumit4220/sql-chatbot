# frozen_string_literal: true

require "sql_chatbot/grammar/registry"

module SqlChatbot
  module Grammar
    module Primitives
      PREFERRED_DISPLAY_FIELDS = %w[id name title label email].freeze

      def self.build(primitive:, entity:, field: nil, which: nil, n: nil, rank_field: nil, group_by: nil)
        case primitive
        when :COUNT
          "SELECT COUNT(*) FROM #{entity.table}"
        when :LIST
          "SELECT #{pick_display_fields(entity).join(", ")} FROM #{entity.table}"
        when :SUM
          require_field!(entity, field, "SUM")
          "SELECT SUM(#{entity.table}.#{field}) FROM #{entity.table}"
        when :AVG
          require_field!(entity, field, "AVG")
          "SELECT ROUND(AVG(#{entity.table}.#{field}), 2) FROM #{entity.table}"
        when :MIN_MAX
          require_field!(entity, field, "MIN_MAX")
          raise "MIN_MAX requires which" unless %i[MIN MAX].include?(which)
          "SELECT #{which}(#{entity.table}.#{field}) FROM #{entity.table}"
        when :TOP_N
          rank = rank_field || entity.ranking_candidates.first
          raise "TOP_N requires rankField" unless rank
          limit = n || 10
          "SELECT #{pick_display_fields(entity).join(", ")}, #{entity.table}.#{rank} FROM #{entity.table} ORDER BY #{entity.table}.#{rank} DESC LIMIT #{limit}"
        when :RANK
          raise "RANK requires rankField and groupBy" unless rank_field && group_by
          "SELECT #{entity.table}.*, DENSE_RANK() OVER (PARTITION BY #{entity.table}.#{group_by} ORDER BY #{entity.table}.#{rank_field} DESC) AS rank FROM #{entity.table}"
        else
          raise "unknown primitive #{primitive}"
        end
      end

      def self.pick_display_fields(entity)
        present = PREFERRED_DISPLAY_FIELDS.select { |p| entity.fields.key?(p) }
        return present.map { |p| entity.fields[p].column } if present.any?
        entity.fields.keys.first(4)
      end

      def self.require_field!(entity, field, name)
        raise "#{name} requires field" unless field
        raise "#{name} field '#{field}' not in entity" unless entity.fields.key?(field.to_s)
      end
    end
  end
end
