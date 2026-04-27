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
          modifiers = Array(intent[:modifiers])
          primitive_sym = intent[:primitive].to_s
          rank_field = intent[:rank_field]
          limit_n    = intent[:n]

          # TOP_N has its own ORDER BY + LIMIT baked in. If the intent also
          # includes order_by / limit modifiers, they describe how TOP_N should
          # rank — absorb them into the primitive instead of appending, which
          # would produce duplicate ORDER BY / LIMIT clauses.
          if primitive_sym == "TOP_N"
            order_mod = modifiers.find { |m| (m[:kind] || m["kind"]).to_s == "order_by" }
            limit_mod = modifiers.find { |m| (m[:kind] || m["kind"]).to_s == "limit" }
            if order_mod
              rank_field ||= order_mod[:field] || order_mod["field"]
              modifiers = modifiers.reject { |m| m.equal?(order_mod) }
            end
            if limit_mod
              limit_n ||= limit_mod[:value] || limit_mod["value"]
              modifiers = modifiers.reject { |m| m.equal?(limit_mod) }
            end
          end

          sql = Primitives.build(
            primitive:  intent[:primitive],
            entity:     entity,
            field:      intent[:field],
            which:      intent[:which],
            n:          limit_n,
            rank_field: rank_field,
            group_by:   intent[:group_by]
          )

          modifiers.each do |m|
            sql = Modifiers.apply(sql, m, entity)
          end

          deleted_col = entity.timestamps["deleted"] || entity.timestamps[:deleted]
          if deleted_col
            sql = with_soft_delete(sql, entity, deleted_col)
          end

          unless sql =~ /LIMIT \d+/i || primitive_sym == "COUNT" || sql =~ /COUNT\(/i
            sql = "#{sql} LIMIT 100"
          end

          { ok: true, sql: sql }
        rescue => e
          { ok: false, reason: e.message }
        end
      end

      def self.with_soft_delete(sql, entity, col)
        quoted_ref = Primitives.qc(entity.table, col)
        clause = "#{quoted_ref} IS NULL"

        # Skip if already filtered on this column (match either quoted or unquoted form for safety)
        return sql if sql.include?(quoted_ref)
        return sql if /\b#{Regexp.escape(entity.table)}\.#{Regexp.escape(col)}\b/i.match?(sql)

        if /\bWHERE\b/i.match?(sql)
          return sql.sub(/\bWHERE\b/i) { "WHERE #{clause} AND " }
        end

        before_match = sql.match(/ (GROUP BY|ORDER BY|LIMIT) /i)
        if before_match
          return sql.sub(before_match[0]) { " WHERE #{clause}#{before_match[0]}" }
        end

        "#{sql} WHERE #{clause}"
      end
    end
  end
end
