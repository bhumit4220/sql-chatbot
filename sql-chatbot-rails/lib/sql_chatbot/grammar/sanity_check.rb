# frozen_string_literal: true

module SqlChatbot
  module Grammar
    # Post-execution sanity check for grammar-generated SQL.
    #
    # Catches "plausible but wrong" results where the SQL ran without error
    # but the value disagrees with the registry's known row count. Concrete
    # case: Gitea's `user` reserved-word table returned 1 instead of 9.
    module SanityCheck
      # Returns { ok: true } when result matches expectations,
      # or { ok: false, reason: "..." } when there's a mismatch.
      def self.check_count(primitive, entity, result_rows)
        return { ok: true } unless primitive.to_s == "COUNT"
        return { ok: true } unless result_rows.is_a?(Array) && result_rows.length == 1

        row = result_rows.first
        v = row.is_a?(Hash) ? row.values.first : nil
        got = Integer(v.to_s) rescue nil
        return { ok: true } unless got

        expected = entity.row_count.to_i
        # Trust the registry only when it has a non-trivial value.
        # Tables with reltuples == 0 might just be stats-stale.
        return { ok: true } if expected <= 5

        if got < expected / 3 || got > expected * 3
          return {
            ok: false,
            reason: "count_mismatch: SQL returned #{got}, registry has ~#{expected} rows in #{entity.table}",
          }
        end
        { ok: true }
      end
    end
  end
end
