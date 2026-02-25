require 'sqlite3'
require 'json'
require 'fileutils'

module ChatbotAgent
  module Discovery
    class Cache
      SCHEMA_TTL = 3600       # 1 hour
      CODE_INDEX_TTL = 86400  # 24 hours
      DEFAULT_TTL = 3600      # 1 hour

      TTL_MAP = {
        'schema' => SCHEMA_TTL,
        'enums' => SCHEMA_TTL,
        'models' => SCHEMA_TTL,
        'code' => CODE_INDEX_TTL,
      }.freeze

      def initialize(db_path)
        @db_path = db_path
        FileUtils.mkdir_p(File.dirname(db_path))
        init_database
      end

      def get(key)
        ttl = TTL_MAP[key] || DEFAULT_TTL
        row = @db.get_first_row(
          'SELECT value FROM discovery_cache WHERE key = ? AND expires_at > ?',
          [key, Time.now.to_i]
        )
        return nil unless row

        JSON.parse(row[0], symbolize_names: true)
      rescue JSON::ParserError
        nil
      end

      def set(key, value)
        ttl = TTL_MAP[key] || DEFAULT_TTL
        expires_at = Time.now.to_i + ttl
        json = JSON.generate(value)
        @db.execute(
          'INSERT OR REPLACE INTO discovery_cache (key, value, expires_at) VALUES (?, ?, ?)',
          [key, json, expires_at]
        )
      end

      def expire(key)
        @db.execute('UPDATE discovery_cache SET expires_at = 0 WHERE key = ?', [key])
      end

      def clear_all
        @db.execute('DELETE FROM discovery_cache')
      end

      private

      def init_database
        @db = SQLite3::Database.new(@db_path)
        @db.execute('PRAGMA journal_mode = WAL')
        @db.execute('PRAGMA synchronous = NORMAL')
        @db.execute(<<~SQL)
          CREATE TABLE IF NOT EXISTS discovery_cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          )
        SQL
      end
    end
  end
end
