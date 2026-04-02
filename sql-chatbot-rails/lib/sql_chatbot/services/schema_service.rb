# frozen_string_literal: true

module SqlChatbot
  module Services
    class SchemaService
      # Columns that indicate soft-delete patterns
      SOFT_DELETE_COLUMNS = %w[deleted_at discarded_at archived_at removed_at].freeze

      # Word-boundary patterns for sensitive columns — must match as whole "word segments"
      # separated by underscores or string boundaries, to avoid false positives like
      # "pinned_at" matching "pin".
      SENSITIVE_PATTERNS = %w[
        password passwd secret token ssn social_security
        credit_card card_number cvv pin encrypted hash
        salt private_key api_key auth_key access_key
      ].freeze

      # Maps PostgreSQL data_type strings to concise labels used in the schema summary
      TYPE_MAP = {
        "character varying"            => "VARCHAR",
        "integer"                      => "INT",
        "bigint"                       => "BIGINT",
        "smallint"                     => "SMALLINT",
        "timestamp without time zone"  => "TIMESTAMP",
        "timestamp with time zone"     => "TIMESTAMPTZ",
        "numeric"                      => "DECIMAL",
        "boolean"                      => "BOOL",
        "text"                         => "TEXT",
        "date"                         => "DATE",
        "double precision"             => "DOUBLE",
        "real"                         => "REAL",
        "uuid"                         => "UUID",
        "jsonb"                        => "JSONB",
        "json"                         => "JSON",
      }.freeze

      # -------------------------------------------------------------------
      # Class-level helpers
      # -------------------------------------------------------------------

      # Returns true if the column name matches any sensitive pattern using
      # word-boundary matching: pattern must appear between start-of-string /
      # underscore boundaries. This avoids false positives like "pinned_at"
      # matching "pin".
      def self.sensitive?(column_name)
        lower = column_name.downcase
        SENSITIVE_PATTERNS.any? do |pattern|
          lower.match?(/(?:^|_)#{Regexp.escape(pattern)}(?:$|_)/)
        end
      end

      # Map a PostgreSQL data_type to a concise label; unknown types are uppercased.
      def self.map_type(pg_type)
        TYPE_MAP[pg_type] || pg_type.upcase
      end

      # -------------------------------------------------------------------
      # Instance
      # -------------------------------------------------------------------

      attr_reader :table_count

      def initialize
        @summary_text = ""
        @tables = []
      end

      def summary
        @summary_text
      end

      def table_count
        @tables.length
      end

      # Inject model-level annotations (from ModelIntrospector) into the schema summary.
      # annotations_by_table: Hash of table_name => [annotation_strings]
      # Each annotation is inserted after the TABLE line and any existing annotations.
      def append_model_annotations(annotations_by_table)
        return if annotations_by_table.nil? || annotations_by_table.empty?

        lines = @summary_text.split("\n")
        result = []
        current_table = nil

        lines.each do |line|
          if line.start_with?("TABLE ")
            # Before moving to next table, flush pending annotations for previous table
            if current_table && annotations_by_table.key?(current_table)
              annotations_by_table[current_table].each { |ann| result << ann }
            end
            current_table = line.match(/^TABLE (\S+)/)[1]
          end
          result << line
        end

        # Flush annotations for the last table
        if current_table && annotations_by_table.key?(current_table)
          annotations_by_table[current_table].each { |ann| result << ann }
        end

        @summary_text = result.join("\n")
      end

      # Introspect the database and build a schema summary string with enrichment
      # annotations (soft delete, polymorphic, lookup values, enums, check constraints).
      # Requires ActiveRecord::Base.connection to be available.
      def discover
        conn = ActiveRecord::Base.connection

        # Run all introspection queries
        table_names   = query_tables(conn)
        columns_rows  = query_columns(conn)
        pk_rows       = query_primary_keys(conn)
        fk_rows       = query_foreign_keys(conn)
        enum_rows     = query_enums(conn)
        check_rows    = query_check_constraints(conn)

        # Index primary keys: Set of "table.column"
        pk_set = Set.new(pk_rows.map { |r| "#{r['table_name']}.#{r['column_name']}" })

        # Index foreign keys: Hash of "from_table.from_column" => "to_table.to_column"
        fk_map = fk_rows.each_with_object({}) do |r, h|
          h["#{r['from_table']}.#{r['from_column']}"] = "#{r['to_table']}.#{r['to_column']}"
        end

        # Index enum types: enum_name => [ordered values]
        enum_map = enum_rows.each_with_object({}) do |r, h|
          (h[r["enum_name"]] ||= []) << r["enum_value"]
        end

        # Parse check constraints for IN (...) or ANY(ARRAY[...]) patterns
        check_enum_map = {}
        check_rows.each do |r|
          result = parse_check_constraint(r["check_def"])
          next unless result

          col_name, values = result
          check_enum_map["#{r['table_name']}.#{col_name}"] = values
        end

        # Group columns by table
        columns_by_table = columns_rows.each_with_object({}) do |col, h|
          (h[col["table_name"]] ||= []) << col
        end

        # Collect FK target tables for lookup value detection
        fk_target_tables = Set.new(fk_rows.map { |r| r["to_table"] })

        # Convention-based references: *_id columns => plural table names
        table_name_set = Set.new(table_names)
        columns_by_table.each_value do |cols|
          cols.each do |col|
            col_name = col["column_name"]
            next unless col_name.end_with?("_id")
            next if pk_set.include?("#{col['table_name']}.#{col_name}")

            base = col_name[0..-4] # remove '_id'
            candidates = [
              "#{base}s",
              "#{base.sub(/y$/, 'ie')}s",
              "#{base}es",
              base,
            ]
            candidates.each do |candidate|
              if table_name_set.include?(candidate)
                fk_target_tables.add(candidate)
                break
              end
            end
          end
        end

        # Discover lookup values for small referenced tables
        lookup_values = discover_lookup_values(conn, fk_target_tables, columns_by_table, pk_set)

        # Build summary lines
        lines = []
        table_names.each do |table|
          columns = columns_by_table[table] || []
          col_parts = []
          annotations = []
          col_name_types = {} # column_name => mapped_type (for polymorphic detection)

          columns.each do |col|
            next if self.class.sensitive?(col["column_name"])

            key = "#{table}.#{col['column_name']}"

            # Resolve enum values: PG native enum or check-constraint enum
            enum_values = if col["data_type"] == "USER-DEFINED" && col["udt_name"]
                           enum_map[col["udt_name"]]
                         end
            enum_values ||= check_enum_map[key]

            mapped_type = if enum_values
                           "ENUM(#{enum_values.join(',')})"
                         else
                           self.class.map_type(col["data_type"])
                         end

            part = "#{col['column_name']} #{mapped_type}"
            part += " PK" if pk_set.include?(key)
            part += " FK=>#{fk_map[key]}" if fk_map.key?(key)

            col_parts << part
            col_name_types[col["column_name"]] = mapped_type

            # Defer soft delete annotation (applied after model introspection)
            if SOFT_DELETE_COLUMNS.include?(col["column_name"])
              (@deferred_soft_deletes ||= {})[table] ||= []
              @deferred_soft_deletes[table] << col["column_name"]
            end

            # Enum value annotation
            if enum_values
              annotations << "  -- ENUM: #{col['column_name']} values: #{enum_values.join(', ')}"
            end
          end

          # Polymorphic association detection
          col_name_types.each do |col_name, col_type|
            next unless col_name.end_with?("_type") && %w[VARCHAR TEXT].include?(col_type)

            prefix = col_name[0..-6] # remove '_type'
            id_col = "#{prefix}_id"
            id_type = col_name_types[id_col]
            if id_type && %w[INT BIGINT].include?(id_type)
              annotations << "  -- POLYMORPHIC: #{col_name} + #{id_col} (join target depends on type value)"
            end
          end

          # Lookup values annotation
          if lookup_values.key?(table)
            annotations << "  -- VALUES: #{lookup_values[table]}"
          end

          lines << "TABLE #{table} (#{col_parts.join(', ')})"
          annotations.each { |ann| lines << ann }
        end

        @tables = table_names
        @summary_text = lines.join("\n")
      end

      # Re-discover schema (alias for discover)
      def refresh
        discover
      end

      # Move "-- VALUES:" annotations from lookup tables to the FK columns that reference them.
      # After this, LLMs see lookup values next to the FK column (e.g., category_id) instead of
      # on the lookup table itself, preventing confusion between unrelated integer columns.
      def relocate_lookup_annotations
        lines = @summary_text.split("\n")

        # Step 1: Extract VALUES annotations and their tables
        lookup_values = {} # table_name => values_string
        lines_without_values = []
        current_table = nil

        lines.each do |line|
          if line.start_with?("TABLE ")
            current_table = line.match(/^TABLE (\S+)/)[1]
          end

          if line.strip.start_with?("-- VALUES:")
            lookup_values[current_table] = line.strip.sub("-- VALUES: ", "") if current_table
          else
            lines_without_values << line
          end
        end

        return if lookup_values.empty?

        # Step 2: Build convention-based table name patterns for matching
        convention_map = {} # "singular_id" => lookup_table
        lookup_values.each_key do |table|
          singular = if table.end_with?("ies")
                       table[0..-4] + "y"
                     elsif table.end_with?("ses")
                       table[0..-3]
                     elsif table.end_with?("s")
                       table[0..-2]
                     else
                       table
                     end
          convention_map["#{singular}_id"] = table
        end

        # Step 3: Find FK columns and inject FK LOOKUP annotations
        result = []
        lines_without_values.each do |line|
          result << line

          if line.start_with?("TABLE ")
            # Match explicit FK references: "column_name INT FK=>target_table.target_column"
            lookup_values.each do |lookup_table, values|
              line.scan(/(\w+)\s+\w+\s+FK=>#{Regexp.escape(lookup_table)}\.(\w+)/).each do |fk_col, _target_col|
                result << "  -- FK LOOKUP: #{fk_col} (use this to filter by #{fk_col.chomp('_id')}) values: #{values}"
              end
            end

            # Match convention-based references: "category_id INT" (no FK=> marker)
            convention_map.each do |fk_col_name, lookup_table|
              # Skip if already matched by explicit FK above
              next if line.include?("#{fk_col_name} ") && line.include?("FK=>#{lookup_table}")
              if line.match?(/\b#{Regexp.escape(fk_col_name)}\s+\w+(?!\s+FK)/)
                result << "  -- FK LOOKUP: #{fk_col_name} (use this to filter by #{fk_col_name.chomp('_id')}) values: #{lookup_values[lookup_table]}"
              end
            end
          end
        end

        @summary_text = result.join("\n")
      end

      # Apply soft delete annotations conditionally based on model introspection results.
      # - Tables using a soft delete gem (paranoia, discard): always add SOFT DELETE annotation
      # - Tables with enum soft delete but no gem: suppress SOFT DELETE (enum is the real mechanism)
      # - Tables with neither: add SOFT DELETE annotation (assume column is used)
      def apply_soft_delete_annotations(soft_delete_tables:, enum_soft_delete_tables:)
        return if @deferred_soft_deletes.nil? || @deferred_soft_deletes.empty?

        new_annotations = {}
        @deferred_soft_deletes.each do |table, columns|
          if soft_delete_tables.include?(table)
            # Gem manages this column — keep the annotation
            columns.each do |col|
              (new_annotations[table] ||= []) << "  -- SOFT DELETE: filter #{col} IS NULL for active records"
            end
          elsif enum_soft_delete_tables.include?(table)
            # Enum is the real soft delete, column is likely unused — suppress
            next
          else
            # No competing mechanism — assume column is used
            columns.each do |col|
              (new_annotations[table] ||= []) << "  -- SOFT DELETE: filter #{col} IS NULL for active records"
            end
          end
        end

        append_model_annotations(new_annotations) unless new_annotations.empty?
      end

      private

      # Detect polymorphic associations: _type VARCHAR/TEXT + _id INT/BIGINT pairs.
      # Returns array of prefix strings (e.g., ["commentable", "taggable"]).
      def detect_polymorphic(columns)
        col_types = {}
        columns.each do |col|
          col_types[col["column_name"]] = self.class.map_type(col["data_type"])
        end

        prefixes = []
        col_types.each do |col_name, col_type|
          next unless col_name.end_with?("_type") && %w[VARCHAR TEXT].include?(col_type)

          prefix = col_name[0..-6] # remove '_type'
          id_col = "#{prefix}_id"
          id_type = col_types[id_col]
          prefixes << prefix if id_type && %w[INT BIGINT].include?(id_type)
        end

        prefixes
      end

      # Detect soft-delete column. Returns the column name or nil.
      def detect_soft_delete(columns)
        columns.each do |col|
          return col["column_name"] if SOFT_DELETE_COLUMNS.include?(col["column_name"])
        end
        nil
      end

      # Parse a check constraint definition for IN (...) or ANY(ARRAY[...]) enum patterns.
      # Returns [column_name, [values]] or nil.
      def parse_check_constraint(check_def)
        # Format 1: ((col)::text = ANY ((ARRAY['a'::varchar, 'b'::varchar])::text[]))
        match = check_def.match(/\(\((\w+)\)::\w+\s*=\s*ANY\s*\(\(?ARRAY\[([^\]]+)\]/i)
        # Format 2: (col IN ('a', 'b', 'c'))
        match ||= check_def.match(/\((\w+)\s+IN\s*\(([^)]+)\)/i)
        return nil unless match

        col_name = match[1]
        values_str = match[2]
        return nil if values_str.nil? || values_str.empty?

        values = values_str.split(",").map do |v|
          v.strip.sub(/^'([^']*)'(?:::\w+.*)?$/, '\1').strip
        end.reject(&:empty?)

        values.empty? ? nil : [col_name, values]
      end

      # -------------------------------------------------------------------
      # SQL query helpers (require ActiveRecord::Base.connection)
      # -------------------------------------------------------------------

      def query_tables(conn)
        rows = conn.exec_query(<<~SQL)
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name
        SQL
        rows.map { |r| r["table_name"] }
      end

      def query_columns(conn)
        conn.exec_query(<<~SQL).to_a
          SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position
        SQL
      end

      def query_primary_keys(conn)
        conn.exec_query(<<~SQL).to_a
          SELECT kcu.table_name, kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
        SQL
      end

      def query_foreign_keys(conn)
        conn.exec_query(<<~SQL).to_a
          SELECT
            kcu.table_name AS from_table,
            kcu.column_name AS from_column,
            ccu.table_name AS to_table,
            ccu.column_name AS to_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
            AND tc.constraint_schema = ccu.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        SQL
      end

      def query_enums(conn)
        conn.exec_query(<<~SQL).to_a
          SELECT t.typname AS enum_name, e.enumlabel AS enum_value
          FROM pg_enum e
          JOIN pg_type t ON e.enumtypid = t.oid
          ORDER BY t.typname, e.enumsortorder
        SQL
      end

      def query_check_constraints(conn)
        conn.exec_query(<<~SQL).to_a
          SELECT conrelid::regclass AS table_name, pg_get_constraintdef(oid) AS check_def
          FROM pg_constraint
          WHERE contype = 'c' AND connamespace = 'public'::regnamespace
        SQL
      end

      # Query lookup values for small FK-target tables.
      # Returns Hash of table_name => "id1=name1, id2=name2, ..."
      def discover_lookup_values(conn, fk_target_tables, columns_by_table, pk_set)
        result = {}
        return result if fk_target_tables.empty?

        # Get approximate row counts
        stats_rows = conn.exec_query(<<~SQL).to_a
          SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'public'
        SQL

        row_counts = stats_rows.each_with_object({}) do |r, h|
          h[r["relname"]] = r["n_live_tup"].to_i
        end

        fk_target_tables.each do |table|
          count = row_counts[table]
          next if count.nil? || count >= 50

          columns = columns_by_table[table]
          next unless columns

          # Find PK column
          pk_col = columns.find { |c| pk_set.include?("#{table}.#{c['column_name']}") }
          next unless pk_col

          # Find first VARCHAR/TEXT non-PK column as display value
          display_col = columns.find do |c|
            next false if pk_set.include?("#{table}.#{c['column_name']}")

            mapped = self.class.map_type(c["data_type"])
            %w[VARCHAR TEXT].include?(mapped)
          end
          next unless display_col

          pk_name = pk_col["column_name"]
          display_name = display_col["column_name"]

          begin
            values_rows = conn.exec_query(
              "SELECT #{conn.quote_column_name(pk_name)}, #{conn.quote_column_name(display_name)} " \
              "FROM #{conn.quote_table_name(table)} " \
              "ORDER BY #{conn.quote_column_name(pk_name)} LIMIT 50"
            ).to_a

            if values_rows.any?
              pairs = values_rows.map { |r| "#{r[pk_name]}=#{r[display_name]}" }
              result[table] = pairs.join(", ")
            end
          rescue StandardError
            # Skip tables that fail (e.g., permission issues)
          end
        end

        result
      end
    end
  end
end
