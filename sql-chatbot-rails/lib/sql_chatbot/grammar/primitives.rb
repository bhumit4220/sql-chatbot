# frozen_string_literal: true

require "sql_chatbot/grammar/registry"

module SqlChatbot
  module Grammar
    module Primitives
      PREFERRED_DISPLAY_FIELDS = %w[id name title label email].freeze

      # Quote a single SQL identifier — wraps in double quotes and escapes
      # embedded quotes. Prevents PG reserved-word collisions ("user", "order"
      # etc.) which silently resolve to functions and corrupt counts.
      def self.q(name)
        %("#{name.to_s.gsub('"', '""')}")
      end

      # Qualified column reference: "table"."column"
      def self.qc(table, col)
        "#{q(table)}.#{q(col)}"
      end

      def self.build(primitive:, entity:, field: nil, which: nil, n: nil, rank_field: nil, group_by: nil)
        t = q(entity.table)
        case primitive
        when :COUNT
          "SELECT COUNT(*) FROM #{t}"
        when :LIST
          "SELECT #{pick_display_fields(entity).map { |c| q(c) }.join(", ")} FROM #{t}"
        when :SUM
          require_field!(entity, field, "SUM")
          "SELECT SUM(#{qc(entity.table, field)}) FROM #{t}"
        when :AVG
          require_field!(entity, field, "AVG")
          "SELECT ROUND(AVG(#{qc(entity.table, field)}), 2) FROM #{t}"
        when :MIN_MAX
          require_field!(entity, field, "MIN_MAX")
          raise "MIN_MAX requires which" unless %i[MIN MAX].include?(which)
          "SELECT #{which}(#{qc(entity.table, field)}) FROM #{t}"
        when :TOP_N
          rank = rank_field || entity.ranking_candidates.first
          raise "TOP_N requires rankField" unless rank
          limit = n || 10
          "SELECT #{pick_display_fields(entity).map { |c| q(c) }.join(", ")}, #{qc(entity.table, rank)} FROM #{t} ORDER BY #{qc(entity.table, rank)} DESC LIMIT #{limit}"
        when :RANK
          raise "RANK requires rankField and groupBy" unless rank_field && group_by
          "SELECT #{t}.*, DENSE_RANK() OVER (PARTITION BY #{qc(entity.table, group_by)} ORDER BY #{qc(entity.table, rank_field)} DESC) AS rank FROM #{t}"
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
