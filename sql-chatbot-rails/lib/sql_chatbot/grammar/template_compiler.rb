# frozen_string_literal: true

require "sql_chatbot/grammar/registry"
require "sql_chatbot/grammar/primitives"
require "sql_chatbot/grammar/modifiers"

module SqlChatbot
  module Grammar
    module TemplateCompiler
      def self.compile(intent, registry)
        return { ok: false, reason: "unmatched: #{intent[:reason]}" } if intent[:status].to_s == "unmatched"

        entity_name = registry.aliases[intent[:entity]] || intent[:entity]
        entity = registry.entities[entity_name]
        return { ok: false, reason: "entity '#{intent[:entity]}' not in registry" } unless entity

        begin
          sql = Primitives.build(
            primitive:  intent[:primitive],
            entity:     entity,
            field:      intent[:field],
            which:      intent[:which],
            n:          intent[:n],
            rank_field: intent[:rank_field],
            group_by:   intent[:group_by]
          )

          Array(intent[:modifiers]).each do |m|
            sql = Modifiers.apply(sql, m, entity)
          end

          deleted_col = entity.timestamps["deleted"] || entity.timestamps[:deleted]
          if deleted_col
            sql = with_soft_delete(sql, entity, deleted_col)
          end

          primitive_sym = intent[:primitive].to_s
          unless sql =~ /LIMIT \d+/i || primitive_sym == "COUNT" || sql =~ /COUNT\(/i
            sql = "#{sql} LIMIT 100"
          end

          { ok: true, sql: sql }
        rescue => e
          { ok: false, reason: e.message }
        end
      end

      def self.with_soft_delete(sql, entity, col)
        clause = "#{entity.table}.#{col} IS NULL"

        # Skip if already filtered on this column
        return sql if /#{Regexp.escape(entity.table)}\.#{Regexp.escape(col)}/i.match?(sql)

        if /\bWHERE\b/i.match?(sql)
          # Inject after WHERE keyword
          return sql.sub(/\bWHERE\b/i) { "WHERE #{clause} AND " }
        end

        # No WHERE: inject before GROUP BY / ORDER BY / LIMIT, or append
        before_match = sql.match(/ (GROUP BY|ORDER BY|LIMIT) /i)
        if before_match
          return sql.sub(before_match[0]) { " WHERE #{clause}#{before_match[0]}" }
        end

        "#{sql} WHERE #{clause}"
      end
    end
  end
end
