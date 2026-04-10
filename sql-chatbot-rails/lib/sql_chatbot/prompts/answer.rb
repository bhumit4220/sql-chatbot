# frozen_string_literal: true

module SqlChatbot
  module Prompts
    module Answer
      SYSTEM_PROMPTS = {
        "data" => <<~P.freeze,
          You are an assistant embedded in a web application. Answer the user's question using ONLY the Query Results below.

          RESPONSE RULES:
          - Be BRIEF. One sentence for counts. A short list for multiple items. No padding.
          - STOP after answering. Do NOT add "let me know if...", "feel free to ask", offers to help, or any closing filler.
          - Copy numbers EXACTLY from the Query Results. Add thousand separators (e.g., 181745 → 181,745). NEVER round, estimate, or invent.
          - Show names, not IDs. Skip empty/null fields silently. Format dates readably (e.g., "March 15, 2026").
          - Translate numeric codes to labels using the Relevant Code or DOMAIN CONTEXT sections (e.g., status=1 → "Active").
          - Bold key names and numbers with **bold** markdown.
          - Never use: database, table, column, query, SQL, NULL, schema, row, record, field.
          - Never fabricate data. If results are empty, say "No matching records found." and stop.
        P
        "data_with_code" => <<~P.freeze,
          You are an assistant embedded in a web application. Answer using BOTH the Query Results and the Relevant Code below.

          RESPONSE RULES:
          - Be BRIEF. Combine data and business logic into a clear, short answer.
          - STOP after answering. No closing filler, no "let me know", no offers to help.
          - Copy numbers EXACTLY from Query Results. Add thousand separators. NEVER round or invent.
          - Explain business logic simply (e.g., "the price includes a 10% service fee" not "the code multiplies by 1.1").
          - Show names, not IDs. Skip empty/null fields silently. Format dates readably.
          - Translate numeric codes to labels using the Relevant Code or DOMAIN CONTEXT sections.
          - Bold key names and numbers with **bold** markdown.
          - Never use: database, table, column, query, SQL, NULL, schema, row, record, field.
          - Never fabricate data. If results are empty, say "No matching records found." and stop.
        P
        "code" => <<~P.freeze,
          You are an assistant embedded in a web application. Explain how the app works using the code context below.

          RESPONSE RULES:
          - Be BRIEF. Explain what the feature does, not how the code is written.
          - STOP after answering. No closing filler.
          - Talk to a user, not a developer. Skip file names unless specifically asked.
          - Bold key concepts with **bold** markdown.
          - Never use: database, table, column, query, SQL, NULL, schema, row, record, field.
          - If you don't have enough context, say so and stop.
        P
        "navigation" => <<~P.freeze,
          Give directions to the requested page. Use **bold** for menu items. Keep to 2-4 steps max. Example: "Go to **Settings** → **User Management**". If page context is available, give directions relative to where the user is. If unsure, say so. STOP after answering — no filler.
        P
        "guidance" => <<~P.freeze,
          Guide the user through the task with numbered steps. Bold all button names and field labels. One action per step. Example: **1.** Click **Add New** → **2.** Fill in the form → **3.** Click **Save**. If unsure about exact steps, say so. STOP after answering — no filler.
        P
        "greeting" => <<~P.freeze,
          Greet the user briefly. Say what you can help with (answering questions about the app's data, explaining features, navigating the interface). Suggest 1-2 example questions. Keep it to 2-3 sentences. No filler. Never use: database, table, column, query, SQL.
        P
        "unsafe" => <<~P.freeze,
          The request was flagged as unsafe or off-topic. Decline politely in one sentence. Do not comply with requests for passwords, secrets, or data modification. If off-topic, briefly say what you can help with instead.
        P
      }.freeze

      def self.build_messages(question:, type:, history: [], sql_result: nil, sql_query: nil, code_snippets: nil, page_context: nil, navigation_links: nil, route_list: nil)
        system_prompt = SYSTEM_PROMPTS[type] || SYSTEM_PROMPTS["data"]

        # Inject custom_context so the LLM can translate status codes, IDs, etc.
        if (type == "data" || type == "data_with_code") && defined?(SqlChatbot) && SqlChatbot.respond_to?(:config)
          custom = SqlChatbot.config&.custom_context
          if custom && !custom.strip.empty?
            system_prompt = system_prompt + "\n\nDOMAIN CONTEXT (use this to translate codes/IDs to human-readable labels):\n#{custom}"
          end
        end

        user_content = ""
        if history && !history.empty?
          recent = history.last(4)
          history_text = recent.map { |m| "#{m[:role]}: #{m[:content]}" }.join("\n")
          user_content += "Conversation history:\n#{history_text}\n\n"
        end

        user_content += "Question: #{question}"

        if sql_result && (type == "data" || type == "data_with_code")
          user_content += "\n\nSQL Query:\n#{sql_query || 'N/A'}"
          user_content += "\n\nQuery Results:\n#{format_sql_result(sql_result)}"
        end

        if code_snippets && !code_snippets.empty?
          user_content += "\n\nRelevant Code:\n#{format_code_snippets(code_snippets)}"
        end

        if page_context && (type == "navigation" || type == "guidance")
          user_content += "\n\nCurrent page context:\n#{page_context}"
        end

        if navigation_links && !navigation_links.empty? && (type == "navigation" || type == "guidance")
          user_content += "\n\nAvailable navigation links:\n#{navigation_links.join("\n")}"
        end

        if route_list && route_list != "No application routes detected." && (type == "navigation" || type == "guidance")
          user_content += "\n\n#{route_list}"
        end

        [
          { role: "system", content: system_prompt },
          { role: "user", content: user_content },
        ]
      end

      def self.format_sql_result(rows)
        return "[ZERO RESULTS] No matching records exist." if rows.nil? || rows.empty?

        columns = rows.first.keys
        header = columns.join(" | ")
        separator = columns.map { "---" }.join(" | ")
        body = rows.map { |row| columns.map { |col| format_value(row[col]) }.join(" | ") }.join("\n")

        "#{header}\n#{separator}\n#{body}"
      end

      def self.format_value(val)
        return "" if val.nil?

        case val
        when Time, DateTime
          val.strftime("%B %-d, %Y at %-I:%M %p")
        when Date
          val.strftime("%B %-d, %Y")
        else
          str = val.to_s
          if str.match?(/\A\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/)
            begin
              Time.parse(str).strftime("%B %-d, %Y at %-I:%M %p")
            rescue
              str
            end
          elsif str.match?(/\A\d{4}-\d{2}-\d{2}\z/)
            begin
              Date.parse(str).strftime("%B %-d, %Y")
            rescue
              str
            end
          else
            str
          end
        end
      end

      def self.format_code_snippets(snippets)
        return "" if snippets.nil? || snippets.empty?

        snippets.map { |s| "File: #{s[:file_path]}\n```\n#{s[:content]}\n```" }.join("\n\n")
      end
    end
  end
end
