# frozen_string_literal: true

require "json"
require "sql_chatbot/grammar/entity_candidates"

module SqlChatbot
  module Grammar
    module IntentExtractor
      PRIMITIVE_DESCRIPTIONS = <<~TEXT.strip
        COUNT — how many rows of X
        LIST — show/list rows of X
        SUM — total of numeric field on X
        AVG — average of numeric field on X
        MIN_MAX — lowest/highest value of field on X
        TOP_N — top N rows of X ordered by a ranking field
        RANK — window-ranked rows of X within groups
      TEXT

      MODIFIER_DESCRIPTIONS = <<~TEXT.strip
        where     — filter by a field value (op: eq/neq/lt/lte/gt/gte/like/in)
        time      — filter by time window on a timestamp field (today/yesterday/last_7_days/last_30_days/this_month/this_year)
        join      — include a related entity via association
        group_by  — group results by field
        having    — filter grouped results by aggregate op+value
        order_by  — order results by field (asc/desc)
        limit     — cap result count
        distinct  — deduplicate rows
      TEXT

      # call_llm: a proc/lambda taking Array<Hash{role:, content:}> and returning the raw LLM string.
      # Returns a Hash with :status and related keys (mirrors TS Intent discriminated union).
      def self.extract(question:, registry:, history:, call_llm:, confidence_threshold: 0.7)
        candidates = EntityCandidates.select(question: question, registry: registry, top_n: 5)
        messages = [
          { role: "system", content: build_system_prompt },
          { role: "user", content: build_user_prompt(question, candidates, history) },
        ]
        raw =
          begin
            call_llm.call(messages)
          rescue => e
            return { status: "unmatched", confidence: 0, reason: "llm_error: #{e.message}" }
          end

        parsed =
          begin
            JSON.parse(raw)
          rescue JSON::ParserError
            return { status: "unmatched", confidence: 0, reason: "malformed_json" }
          end

        if parsed["status"] == "unmatched"
          return {
            status: "unmatched",
            confidence: parsed["confidence"] || 0,
            reason: parsed["reason"] || "unmatched",
          }
        end

        conf = parsed["confidence"]
        if !conf.is_a?(Numeric) || conf < confidence_threshold
          return { status: "unmatched", confidence: conf || 0, reason: "low_confidence:#{conf}" }
        end

        # Normalize keys to symbols for consumers
        {
          status: "matched",
          primitive: parsed["primitive"]&.to_sym,
          entity: parsed["entity"],
          modifiers: (parsed["modifiers"] || []).map { |m| m.transform_keys(&:to_sym) },
          field: parsed["field"],
          which: parsed["which"]&.to_sym,
          n: parsed["n"],
          rank_field: parsed["rankField"] || parsed["rank_field"],
          group_by: parsed["groupBy"] || parsed["group_by"],
          confidence: conf,
        }.compact
      end

      def self.build_system_prompt
        <<~PROMPT.strip
          You are an intent classifier for a SQL chatbot. Given a user question and a list of available entities, extract a structured intent.

          Primitives:
          #{PRIMITIVE_DESCRIPTIONS}

          Modifiers:
          #{MODIFIER_DESCRIPTIONS}

          You MUST output JSON. If the question doesn't fit any primitive cleanly, set status=unmatched.

          Output shape:
          {"status":"matched","primitive":"COUNT","entity":"user","modifiers":[{"kind":"where","field":"status","op":"eq","value":"active"}],"confidence":0.92}
          or
          {"status":"unmatched","confidence":0.3,"reason":"question requires compare-to-average, no primitive covers this"}

          Rules:
          - Only reference entities from the provided candidates. Never invent.
          - Only use fields listed under the chosen entity.
          - For enum filters, pass the enum key (e.g. "active"), NOT the underlying integer.
          - Set confidence honestly: 0.9+ only when every slot has a clear mapping.
          - When in doubt, return unmatched.
        PROMPT
      end

      def self.build_user_prompt(question, candidates, history)
        history_text = (history || []).last(2).map { |m| "#{m[:role] || m['role']}: #{m[:content] || m['content']}" }.join("\n")
        entity_blocks = candidates.map { |e| format_entity_brief(e) }.join("\n\n")
        "History:\n#{history_text}\n\nEntity candidates:\n#{entity_blocks}\n\nQuestion: #{question}"
      end

      def self.format_entity_brief(e)
        fields = e.fields.first(15).map do |n, f|
          enum_part = f.enum_values ? " enum=#{JSON.generate(f.enum_values)}" : ""
          "  #{n}: #{f.type}#{enum_part}"
        end.join("\n")
        assocs = e.associations.keys.first(8).join(", ")
        assocs = "(none)" if assocs.empty?
        scopes = e.scopes.keys.first(8).join(", ")
        scopes = "(none)" if scopes.empty?
        "Entity: #{e.name} (table=#{e.table}, rows=#{e.row_count})\nFields:\n#{fields}\nAssociations: #{assocs}\nScopes: #{scopes}"
      end
    end
  end
end
