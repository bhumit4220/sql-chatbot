# frozen_string_literal: true

require "sql_chatbot/grammar/registry"

module SqlChatbot
  module Grammar
    module EntityCandidates
      # Score an entity against the question.
      # Tokenizes name on '_' so e.g. `projects_project` token "project" matches
      # the question "how many projects". Tie-breakers: fewer name segments,
      # then higher row count.
      def self.score_entity(question, entity, registry)
        q = question.to_s.downcase
        singular = entity.name.to_s.downcase
        plural = entity.table.to_s.downcase
        score = 0

        score += 12 if q.include?(" #{singular} ") || q.start_with?("#{singular} ") || q.end_with?(" #{singular}")
        score += 10 if q.include?(plural)
        score += 5 if q.include?(singular)

        registry.aliases.each do |alias_term, target|
          next unless target == entity.name
          score += 8 if q.include?(alias_term.to_s.downcase)
        end

        # Token-level matching for compound names like `projects_project`.
        tokens = singular.split("_").select { |t| t.length >= 3 }
        tokens.each do |tok|
          tok_plural = pluralize_simple(tok)
          if q =~ /\b(#{Regexp.escape(tok)}|#{Regexp.escape(tok_plural)})\b/
            score += 4
          end
        end

        # Whitespace-collapsed match — length-weighted so longer matches win.
        q_compact = q.gsub(/\s+/, "")
        best_len = 0
        tokens.each do |tok|
          next if tok.length < 5
          [tok, pluralize_simple(tok)].each do |c|
            best_len = c.length if q_compact.include?(c) && c.length > best_len
          end
        end
        score += best_len

        score
      end

      def self.pluralize_simple(word)
        return word + "es" if word.end_with?("s", "x", "ch", "sh")
        return word[0..-2] + "ies" if word.end_with?("y") && !%w[a e i o u].include?(word[-2])
        word + "s"
      end

      def self.name_segments(entity)
        entity.name.to_s.split("_").length
      end

      def self.select(question:, registry:, top_n:)
        rows = registry.entities.values.map do |entity|
          {
            entity: entity,
            score: score_entity(question, entity, registry),
            segments: name_segments(entity),
            row_count: entity.row_count,
          }
        end

        rows.sort_by! { |r| [-r[:score], r[:segments], -r[:row_count]] }

        if rows.first && rows.first[:score] == 0
          return registry.entities.values.sort_by { |e| -e.row_count }.first(top_n)
        end
        rows.first(top_n).map { |r| r[:entity] }
      end
    end
  end
end
