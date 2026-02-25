require 'sqlite3'
require 'set'

module ChatbotAgent
  module Code
    class Indexer
      CHUNK_MIN = 50
      CHUNK_MAX = 150
      CHUNK_OVERLAP = 10
      MAX_FILE_SIZE = 1_000_000

      INDEXED_EXTENSIONS = Set.new(%w[
        .rb .py .js .ts .go .java .php .ex .rs .cs
        .erb .html .jsx .tsx .vue .blade.php .ejs .hbs
        .sql .graphql .md
      ]).freeze

      EXCLUDED_PATHS = %w[
        .env .git/ node_modules/ vendor/ venv/ __pycache__/ .bundle/
        *.log *.lock package-lock.json yarn.lock
        docker-compose *.sqlite3 *.db
        credentials. secrets. master.key config/master.key
        *.pem *.key *.p12 *.pfx *.cert *.crt
        id_rsa id_ed25519 authorized_keys known_hosts
        database.yml database.yml.enc
      ].freeze

      SECRET_PATTERNS = [
        /password\s*=/i, /api_key\s*=/i, /secret_key\s*=/i,
        /private_key\s*=/i, /access_token\s*=/i,
        /AWS_SECRET/i, /STRIPE_SECRET/i, /GITHUB_TOKEN/i,
        /BEGIN RSA PRIVATE KEY/, /BEGIN OPENSSH PRIVATE KEY/,
        /connection_string\s*=/i, /DATABASE_URL\s*=/i,
      ].freeze

      BOUNDARY_PATTERNS = [
        /^\s*(?:def|class|module)\s+\w+/,                          # Ruby/Python
        /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|module)\s+/, # JS/TS
        /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/, # JS arrow
        /^\s*(?:public|private|protected|static)\s+/,              # Java/C#
        /^\s*(?:fn|impl|struct|trait|pub)\s+/,                     # Rust
        /^\s*(?:func)\s+/,                                         # Go
      ].freeze

      class << self
        def index_directory(dir, db_path: nil)
          db = init_database(db_path)
          db.execute('DELETE FROM code_chunks')

          files = walk_dir(dir, dir)
          files_indexed = 0
          chunks_created = 0

          db.transaction do
            files.each do |file_path|
              begin
                next if File.size(file_path) > MAX_FILE_SIZE

                content = File.read(file_path, encoding: 'UTF-8')
                next if contains_secrets?(content)

                rel_path = file_path.sub("#{dir}/", '')
                chunks = chunk_file(rel_path, content)

                chunks.each do |chunk|
                  tokens = tokenize(chunk[:content])
                  db.execute(
                    'INSERT INTO code_chunks (file, line_start, line_end, content, tokens) VALUES (?, ?, ?, ?, ?)',
                    [chunk[:file], chunk[:line_start], chunk[:line_end], chunk[:content], tokens]
                  )
                  chunks_created += 1
                end
                files_indexed += 1
              rescue => _e
                # Skip unreadable files
              end
            end
          end

          db.close
          { files_indexed: files_indexed, chunks_created: chunks_created }
        end

        def init_database(db_path)
          db = SQLite3::Database.new(db_path)
          db.execute('PRAGMA journal_mode = WAL')
          db.execute('PRAGMA synchronous = NORMAL')
          db.execute(<<~SQL)
            CREATE TABLE IF NOT EXISTS code_chunks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              file TEXT NOT NULL,
              line_start INTEGER NOT NULL,
              line_end INTEGER NOT NULL,
              content TEXT NOT NULL,
              tokens TEXT NOT NULL
            )
          SQL
          db.execute('CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file)')
          db
        end

        private

        def walk_dir(dir, root_dir)
          files = []
          return files unless Dir.exist?(dir)

          Dir.entries(dir).sort.each do |entry|
            next if entry == '.' || entry == '..'

            full_path = File.join(dir, entry)
            rel_path = full_path.sub("#{root_dir}/", '')

            next if excluded_path?(rel_path)

            if File.directory?(full_path)
              files.concat(walk_dir(full_path, root_dir))
            elsif File.file?(full_path)
              ext = File.extname(entry).downcase
              files << full_path if INDEXED_EXTENSIONS.include?(ext)
            end
          end

          files
        end

        def excluded_path?(rel_path)
          lower = rel_path.downcase
          EXCLUDED_PATHS.any? do |pattern|
            if pattern.end_with?('/')
              lower.include?(pattern) || lower.include?(pattern.chomp('/'))
            elsif pattern.start_with?('*.')
              lower.end_with?(pattern[1..])
            else
              lower.include?(pattern)
            end
          end
        end

        def contains_secrets?(content)
          SECRET_PATTERNS.any? { |p| p.match?(content) }
        end

        def boundary_line?(line)
          BOUNDARY_PATTERNS.any? { |p| p.match?(line) }
        end

        def chunk_file(file_path, content)
          lines = content.split("\n")
          return [{ file: file_path, line_start: 1, line_end: lines.length, content: content }] if lines.length <= CHUNK_MAX

          chunks = []
          start = 0

          while start < lines.length
            end_idx = [start + CHUNK_MAX, lines.length].min

            # Try to find a boundary near the end for clean splits
            if end_idx < lines.length
              (end_idx).downto(start + CHUNK_MIN) do |i|
                if boundary_line?(lines[i])
                  end_idx = i
                  break
                end
              end
            end

            chunks << {
              file: file_path,
              line_start: start + 1,
              line_end: end_idx,
              content: lines[start...end_idx].join("\n"),
            }

            break if end_idx >= lines.length

            start = end_idx - CHUNK_OVERLAP
            break if start >= lines.length
          end

          chunks
        end

        def tokenize(content)
          content.downcase.split(/[^a-z0-9_]+/).select { |t| t.length > 1 }.join(' ')
        end
      end
    end
  end
end
