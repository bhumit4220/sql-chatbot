# frozen_string_literal: true

module SqlChatbot
  module Prompts
    module GenerateSql
      SYSTEM_PROMPT = <<~PROMPT.freeze
        You are a PostgreSQL query generator. Given a database schema and a user question, generate a single SELECT query to answer the question.

        CRITICAL: When tables have "-- SOFT DELETE: filter deleted_at IS NULL" annotations, you MUST add deleted_at IS NULL for EVERY such table in the query — including all JOINed tables, not just the FROM table.
        Example: SELECT t.name, COUNT(r.id) FROM titles t JOIN reviews r ON r.title_id = t.id WHERE t.deleted_at IS NULL AND r.deleted_at IS NULL GROUP BY t.name
        Wrong:   SELECT t.name, COUNT(r.id) FROM titles t JOIN reviews r ON r.title_id = t.id WHERE t.deleted_at IS NULL GROUP BY t.name  (MISSING r.deleted_at IS NULL)

        RULES:
        1. ONLY generate SELECT statements — never INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, or any data-modifying statement
        2. Always add LIMIT 100 unless the user explicitly asks for all results or the query is a COUNT/aggregation
        3. Use JOINs to return human-readable names instead of raw IDs where possible
        4. Use appropriate WHERE clauses to filter data as requested
        5. For date filters, use PostgreSQL date functions (NOW(), INTERVAL, DATE_TRUNC, etc.)
        6. Prefer COUNT, SUM, AVG for aggregate questions
        7. Use ILIKE for case-insensitive text searches
        8. Always qualify column names with table aliases when using JOINs to avoid ambiguity
        9. Return useful columns — don't SELECT * unless the user asks to "show everything"
        10. Order results meaningfully (most recent first for dates, highest first for counts, alphabetical for names)
        11. For "top N" or "most recent" queries, ALWAYS include relevant dates (created_at, updated_at, release_date) and key attributes (name, title, status, type) — give enough context for a meaningful answer
        12. NEVER return just IDs or a single column when additional context columns are available — the answer should be self-contained
        13. Use COALESCE for nullable date/number columns to provide fallback values where sensible
        14a. ROUND decimals: Always use ROUND(AVG(...), 2) or ROUND(value, 2) for averages and calculated decimals. Never return raw floating-point precision.
        14b. STATUS FILTERING: Only filter by specific status values when the user explicitly mentions a status (e.g., "active", "inactive", "completed", "disputed"). For example, "top contractors by rating" should NOT add WHERE status = 1. But "active contractors" MUST use the exact enum value for Active (e.g., WHERE status = 1). IMPORTANT: This rule does NOT override ENUM SOFT DELETE (rule 21) — always exclude soft-deleted records regardless.
        15. SOFT DELETE (column-based): When a table has "-- SOFT DELETE: filter <column> IS NULL" annotation, add WHERE <column> IS NULL to exclude deleted records, unless the user explicitly asks about deleted items. IMPORTANT: Apply this filter to EVERY table in the query that has a soft-delete column, including JOINed tables — not just the primary table.
        16. POLYMORPHIC JOINS: When a table has "-- POLYMORPHIC: X_type + X_id", join using both: WHERE X_type = 'ModelName' AND X_id = target.id.
        17. FK LOOKUP VALUES: When a table has "-- FK LOOKUP: column values: id=name, ..." annotation, use these exact IDs in WHERE clauses for that specific column.
        18. ENUM VALUES: When a column has "-- ENUM: column values: X, Y, Z" annotation, use ONLY these exact values (case-sensitive). Never guess enum values.
        19. RAILS ENUM VALUES: When a table has "-- RAILS ENUM: column values: Label=N, ..." annotation, the database stores the NUMERIC value N. Use WHERE column = N.
        20. MODEL FOREIGN KEYS: When a table has "-- MODEL FK: column -> target_table.id" annotation, use this column for JOINs even if it doesn't follow standard naming.
        21. ENUM SOFT DELETE: When a table has "-- ENUM SOFT DELETE: column != N to exclude <label> records" annotation, ALWAYS add WHERE column != N to exclude those records by default.

        Respond with JSON only: {"sql": "<the SQL query>", "explanation": "<brief explanation of what the query does>"}
      PROMPT

      def self.build_messages(question:, schema:, code_context: nil, lookup_hints: nil, history: [])
        system = SYSTEM_PROMPT.dup
        if code_context && !code_context.empty?
          system += "\n\nRELEVANT CODE CONTEXT (use this to understand business logic, calculations, or field meanings):\n#{code_context}"
        end

        # Inject custom domain context if configured
        custom = SqlChatbot.config&.custom_context
        if custom && !custom.empty?
          system += "\n\nADDITIONAL DOMAIN CONTEXT (IMPORTANT — use this for non-standard patterns):\n#{custom}"
        end

        user_content = ""

        # Inject lookup hints before the question so the LLM sees them first
        if lookup_hints && !lookup_hints.empty?
          user_content += "IMPORTANT LOOKUP HINTS (use these exact columns and IDs):\n"
          lookup_hints.each { |hint| user_content += "- #{hint}\n" }
          user_content += "\n"
        end

        if history && !history.empty?
          recent = history.last(4)
          history_text = recent.map { |m| "#{m[:role]}: #{m[:content]}" }.join("\n")
          user_content += "Conversation history:\n#{history_text}\n\n"
        end
        user_content += "Question: #{question}\n\nDatabase schema:\n#{schema}"

        [
          { role: "system", content: system },
          { role: "user", content: user_content },
        ]
      end
    end
  end
end
