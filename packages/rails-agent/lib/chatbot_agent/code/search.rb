require 'sqlite3'

module ChatbotAgent
  module Code
    class Search
      K1 = 1.5
      B = 0.75
      AVG_CHUNK_LENGTH = 100 # approximate average chunk token count

      class << self
        # BM25-inspired search over code chunks.
        # Returns [{ file:, line_start:, line_end:, content:, score: }]
        def search(query, limit: 10, db_path: nil)
          return [] if query.nil? || query.strip.empty?

          query_tokens = tokenize(query)
          return [] if query_tokens.empty?

          db = SQLite3::Database.new(db_path)
          db.results_as_hash = true

          begin
            total_docs = db.get_first_value('SELECT COUNT(*) FROM code_chunks').to_i
            return [] if total_docs == 0

            # Document frequency for each query token
            df_map = {}
            query_tokens.each do |token|
              df_map[token] = db.get_first_value(
                "SELECT COUNT(*) FROM code_chunks WHERE tokens LIKE ?", ["%#{token}%"]
              ).to_i
            end

            # Score all chunks
            rows = db.execute('SELECT * FROM code_chunks')
            scored = rows.map do |row|
              chunk_tokens = row['tokens'].split(' ')
              chunk_length = chunk_tokens.length

              score = 0.0
              query_tokens.each do |token|
                tf = chunk_tokens.count(token)
                df = df_map[token] || 1
                idf = Math.log((total_docs - df + 0.5) / (df + 0.5) + 1)
                tf_norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * chunk_length.to_f / AVG_CHUNK_LENGTH))
                score += idf * tf_norm
              end

              {
                file: row['file'],
                line_start: row['line_start'],
                line_end: row['line_end'],
                content: row['content'],
                score: score,
              }
            end

            scored
              .select { |c| c[:score] > 0 }
              .sort_by { |c| -c[:score] }
              .first(limit)
          ensure
            db.close
          end
        end

        private

        def tokenize(text)
          text.downcase.split(/[^a-z0-9_]+/).select { |t| t.length > 1 }
        end
      end
    end
  end
end
