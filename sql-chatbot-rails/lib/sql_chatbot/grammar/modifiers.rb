# frozen_string_literal: true

require "sql_chatbot/grammar/registry"
require "sql_chatbot/grammar/primitives"

module SqlChatbot
  module Grammar
    module Modifiers
      def self.q(name)
        Primitives.q(name)
      end

      def self.qc(table, col)
        Primitives.qc(table, col)
      end

      WINDOWS = {
        "today"       => "DATE_TRUNC('day', NOW())",
        "yesterday"   => "DATE_TRUNC('day', NOW() - INTERVAL '1 day')",
        "last_7_days" => "NOW() - INTERVAL '7 days'",
        "last_30_days" => "NOW() - INTERVAL '30 days'",
        "this_month"  => "DATE_TRUNC('month', NOW())",
        "this_year"   => "DATE_TRUNC('year', NOW())",
      }.freeze

      OPS = {
        "eq"  => "=",
        "neq" => "!=",
        "lt"  => "<",
        "lte" => "<=",
        "gt"  => ">",
        "gte" => ">=",
      }.freeze

      def self.apply(sql, modifier, entity)
        kind = modifier[:kind].to_s
        case kind
        when "where"    then apply_where(sql, modifier, entity)
        when "time"     then apply_time(sql, modifier, entity)
        when "join"     then apply_join(sql, modifier, entity)
        when "group_by" then apply_group_by(sql, modifier, entity)
        when "having"   then apply_having(sql, modifier, entity)
        when "order_by" then apply_order_by(sql, modifier, entity)
        when "limit"    then apply_limit(sql, modifier)
        when "distinct" then sql.sub(/^SELECT /, "SELECT DISTINCT ")
        else
          raise "unknown modifier kind #{kind}"
        end
      end

      def self.append_clause(sql, clause)
        if /\bWHERE\b/i.match?(sql)
          "#{sql} AND #{clause}"
        else
          "#{sql} WHERE #{clause}"
        end
      end

      def self.apply_where(sql, modifier, entity)
        field_name = modifier[:field].to_s
        field = entity.fields[field_name]
        raise "field '#{field_name}' not on entity #{entity.name}" unless field

        value = modifier[:value]
        if field.type.to_s == "enum"
          enum_values = field.enum_values || {}
          str_value = value.to_s
          unless enum_values.key?(str_value) || enum_values.key?(str_value.to_sym)
            raise "enum value '#{value}' not in registry for #{entity.name}.#{field_name}"
          end
          value = enum_values[str_value] || enum_values[str_value.to_sym]
        end

        op = OPS[modifier[:op].to_s] || "="
        formatted = value.is_a?(String) ? "'#{value.gsub("'", "''")}'" : value
        append_clause(sql, "#{qc(entity.table, field_name)} #{op} #{formatted}")
      end

      def self.apply_time(sql, modifier, entity)
        window_key = modifier[:window].to_s
        expr = WINDOWS[window_key]
        raise "unknown time window #{window_key}" unless expr
        append_clause(sql, "#{qc(entity.table, modifier[:field])} >= #{expr}")
      end

      def self.apply_join(sql, modifier, entity)
        assoc_name = modifier[:association].to_s
        assoc = entity.associations[assoc_name]
        raise "association '#{assoc_name}' not on entity #{entity.name}" unless assoc

        join_clause = assoc.join_clause
        # Re-emit the join clause with quoted identifiers.
        # joinClause format: "src_table.src_col = tgt_table.tgt_col"
        lhs, rhs = join_clause.split("=").map(&:strip)
        lt, lc = lhs.split(".")
        rt, rc = rhs.split(".")
        target_table = rt
        quoted_clause = "#{qc(lt, lc)} = #{qc(rt, rc)}"
        join_sql = " JOIN #{q(target_table)} ON #{quoted_clause}"

        if /\bWHERE\b/i.match?(sql)
          sql.sub(/\bWHERE\b/i) { "#{join_sql} WHERE " }
        else
          "#{sql}#{join_sql}"
        end
      end

      def self.apply_group_by(sql, modifier, entity)
        field_name = modifier[:field].to_s
        raise "group_by field '#{field_name}' not on entity #{entity.name}" unless entity.fields[field_name]
        "#{sql} GROUP BY #{qc(entity.table, field_name)}"
      end

      def self.apply_having(sql, modifier, entity)
        raise "HAVING requires GROUP BY" unless /GROUP BY/i.match?(sql)
        op = OPS[modifier[:op].to_s] || "="
        "#{sql} HAVING #{modifier[:field]} #{op} #{modifier[:value]}"
      end

      def self.apply_order_by(sql, modifier, entity)
        field_name = modifier[:field].to_s
        raise "order_by field '#{field_name}' not on entity #{entity.name}" unless entity.fields[field_name]
        direction = (modifier[:direction] || modifier["direction"] || "desc").to_s.upcase
        "#{sql} ORDER BY #{qc(entity.table, field_name)} #{direction}"
      end

      def self.apply_limit(sql, modifier)
        limit_val = modifier[:value]
        if /LIMIT \d+/i.match?(sql)
          sql.sub(/LIMIT \d+/i, "LIMIT #{limit_val}")
        else
          "#{sql} LIMIT #{limit_val}"
        end
      end
    end
  end
end
