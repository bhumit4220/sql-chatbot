# frozen_string_literal: true

module SqlChatbot
  module Grammar
    # Programmatic renderer for the grammar's LIST primitive when the result
    # is small. Bypasses the answer-stream LLM so it can't drop or truncate.
    module ListRenderer
      THRESHOLD = 10

      PREFERRED_LABEL_KEYS = %w[title name label subject email username].freeze

      # Returns { ok: true, text: "..." } when conditions met, else { ok: false }.
      def self.try_render(primitive, entity_display_label, rows)
        return { ok: false } unless primitive.to_s == "LIST"
        return { ok: false } unless rows.is_a?(Array)
        return { ok: true, text: "No matching records found." } if rows.empty?
        return { ok: false } if rows.length > THRESHOLD

        labels = []
        rows.each do |row|
          return { ok: false } unless row.is_a?(Hash)
          lbl = pick_label(row)
          return { ok: false } unless lbl
          labels << lbl
        end

        noun = if entity_display_label
                 entity_display_label.to_s + (rows.length == 1 ? "" : "s")
               else
                 "item" + (rows.length == 1 ? "" : "s")
               end

        intro = rows.length == 1 ? "Here is the #{noun}:" : "Here are the #{rows.length} #{noun}:"
        lines = labels.map { |l| "- #{l}" }.join("\n")
        { ok: true, text: "#{intro}\n#{lines}" }
      end

      def self.pick_label(row)
        PREFERRED_LABEL_KEYS.each do |k|
          v = row[k] || row[k.to_sym]
          return v.strip if v.is_a?(String) && !v.strip.empty?
        end
        row.each do |k, v|
          next if k.to_s == "id"
          return v.strip if v.is_a?(String) && !v.strip.empty?
        end
        nil
      end
    end
  end
end
