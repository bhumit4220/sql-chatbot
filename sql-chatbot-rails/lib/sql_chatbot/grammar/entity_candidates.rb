# frozen_string_literal: true

require "sql_chatbot/grammar/registry"

module SqlChatbot
  module Grammar
    module EntityCandidates
      def self.select(question:, registry:, top_n:)
        q = question.to_s.downcase
        scores = registry.entities.values.map do |entity|
          score = 0
          singular = entity.name.to_s.downcase
          plural = entity.table.to_s.downcase
          score += 10 if q.include?(" #{singular} ") || q.start_with?("#{singular} ") || q.end_with?(" #{singular}")
          score += 10 if q.include?(plural)
          score += 5 if q.include?(singular)
          registry.aliases.each do |alias_term, target|
            next unless target == entity.name
            score += 8 if q.include?(alias_term.to_s.downcase)
          end
          [entity, score]
        end

        sorted = scores.sort_by { |_, s| -s }
        if sorted.first&.last == 0
          return registry.entities.values.sort_by { |e| -e.row_count }.first(top_n)
        end
        sorted.first(top_n).map(&:first)
      end
    end
  end
end
