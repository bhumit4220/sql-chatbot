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
        @per_table_schemas = {}
        @table_index = {}
        @fk_graph = {}
      end

      def summary
        @summary_text
      end

      def table_count
        @tables.length
      end

      # Scan FK LOOKUP and RAILS ENUM annotations for values that match words in the question.
      # Returns array of hint strings like:
      #   "The user mentions 'movies'. In the titles table, use WHERE category_id = 2 (Movie)."
      #   "The user mentions 'active'. In the contractors table, use WHERE status = 1 (Active)."
      def find_lookup_hints(question)
        return [] if @summary_text.empty?

        # Filter out stop words that would match too broadly
        stop_words = Set.new(%w[a an the is are was were be been being have has had do does did will would shall should may might can could how what when where who which why not and or but if then else for from by with at in on to of it its this that these those])
        words = question.downcase.split(/\W+/).reject { |w| w.empty? || w.length < 2 || stop_words.include?(w) }
        hints = []
        current_table = nil

        @summary_text.split("\n").each do |line|
          if line.start_with?("TABLE ")
            current_table = line.match(/^TABLE (\S+)/)[1]
          elsif line.include?("FK LOOKUP:") && current_table
            match = line.match(/FK LOOKUP:\s+(\S+).*?values:\s+(.+)/)
            next unless match

            fk_col = match[1]
            pairs = match[2].split(",").map(&:strip)
            pairs.each do |pair|
              id, name = pair.split("=", 2)
              next unless name
              clean_name = name.strip
              next if clean_name.empty? || clean_name.length < 2  # Skip empty/tiny names

              name_words = clean_name.downcase.split(/\W+/).reject(&:empty?)
              matched_word = words.find do |w|
                name_words.include?(w) ||
                  clean_name.downcase == w ||
                  (clean_name.length >= 3 && clean_name.downcase.start_with?(w)) ||
                  (w.length >= 3 && w.start_with?(clean_name.downcase))
              end
              if matched_word
                hints << "The user mentions \"#{matched_word}\". In the #{current_table} table, use WHERE #{fk_col} = #{id.strip} (#{clean_name})."
              end
            end
          elsif line.include?("RAILS ENUM:") && current_table
            match = line.match(/RAILS ENUM:\s+(\S+)\s+values:\s+(.+)/)
            next unless match

            col = match[1]
            pairs = match[2].split(",").map(&:strip)
            pairs.each do |pair|
              label, num = pair.split("=", 2)
              next unless label && num
              clean_label = label.strip
              next if clean_label.empty? || clean_label.length < 2

              label_words = clean_label.downcase.split(/\W+/).reject(&:empty?)
              matched_word = words.find do |w|
                label_words.include?(w) ||
                  clean_label.downcase == w ||
                  (clean_label.length >= 3 && clean_label.downcase.start_with?(w)) ||
                  (w.length >= 3 && w.start_with?(clean_label.downcase))
              end
              if matched_word
                hints << "The user mentions \"#{matched_word}\". In the #{current_table} table, use WHERE #{col} = #{num.strip} (#{clean_label})."
              end
            end
          end
        end

        hints.uniq.first(15)  # Cap at 15 hints to avoid drowning the LLM
      end

      # Extract RAILS ENUM annotations from a schema string for the answer prompt.
      # Returns a string like:
      #   "contractors.status: Active=1, Inactive=2, Deleted=3\njobs.status: Active=1, ..."
      def extract_enum_context(schema_text = nil)
        source = schema_text || @summary_text
        return "" if source.empty?

        lines = []
        current_table = nil

        source.split("\n").each do |line|
          if line.start_with?("TABLE ")
            current_table = line.match(/^TABLE (\S+)/)[1]
          elsif line.include?("RAILS ENUM:") && current_table
            match = line.match(/RAILS ENUM:\s+(\S+)\s+values:\s+(.+)/)
            next unless match
            lines << "#{current_table}.#{match[1]}: #{match[2]}"
          end
        end

        lines.join("\n")
      end

      # Returns a short string listing all known table names.
      # Used by the classify prompt so the LLM can see available tables without
      # the full schema (~500 tokens vs ~275K chars for the full schema).
      def table_names
        return "" if @tables.empty?

        "Available tables: #{@tables.join(', ')}"
      end

      # Given an array of search terms (e.g. ["customers"] or ["jobs", "job_types"]),
      # returns a schema string containing ONLY the matching tables plus any tables
      # needed to join them (bridge tables via FK paths, max depth 2).
      #
      # Falls back to hub tables (top 10 by FK edge count) when no terms match.
      def select_schema(terms)
        # If indexes are empty (discover not yet called), return full summary
        return @summary_text if @per_table_schemas.empty?

        selected = match_tables(terms)
        selected = hub_tables(10) if selected.empty?

        # Find join paths between all pairs to include bridge tables
        table_set = Set.new(selected)
        selected.to_a.combination(2).each do |from, to|
          bridge = find_join_path(from, to)
          table_set.merge(bridge) unless bridge.nil?
        end

        # Build schema string from selected tables (preserve original order)
        result_lines = []
        @tables.each do |table|
          next unless table_set.include?(table)

          schema_chunk = @per_table_schemas[table]
          result_lines << schema_chunk if schema_chunk
        end

        result_lines.join("\n")
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

        # Also update per-table schemas so select_schema() includes the annotations
        annotations_by_table.each do |table, annotations|
          next unless @per_table_schemas.key?(table)
          annotations.each do |ann|
            @per_table_schemas[table] += "\n#{ann}"
          end
        end
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

        build_per_table_schemas(lines)
        build_table_index(columns_by_table)
        build_fk_graph(fk_rows, columns_by_table, table_name_set)
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
                result << "  -- FK LOOKUP: #{fk_col} values: #{values}"
              end
            end

            # Match convention-based references: "category_id INT" (no FK=> marker)
            convention_map.each do |fk_col_name, lookup_table|
              # Skip if already matched by explicit FK above
              next if line.include?("#{fk_col_name} ") && line.include?("FK=>#{lookup_table}")
              if line.match?(/\b#{Regexp.escape(fk_col_name)}\s+\w+(?!\s+FK)/)
                result << "  -- FK LOOKUP: #{fk_col_name} values: #{lookup_values[lookup_table]}"
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

      # -------------------------------------------------------------------
      # Smart schema index builders (called at end of discover)
      # -------------------------------------------------------------------

      # Parse the lines array produced by discover() and split into per-table chunks.
      # Each entry in @per_table_schemas is the full multi-line string for one table,
      # including its TABLE header line and all annotation lines.
      def build_per_table_schemas(lines)
        @per_table_schemas = {}
        current_table = nil
        current_lines = []

        lines.each do |line|
          if line.start_with?("TABLE ")
            # Flush previous table
            if current_table
              @per_table_schemas[current_table] = current_lines.join("\n")
            end
            current_table = line.match(/^TABLE (\S+)/)[1]
            current_lines = [line]
          else
            current_lines << line if current_table
          end
        end

        # Flush last table
        if current_table
          @per_table_schemas[current_table] = current_lines.join("\n")
        end
      end

      # Build an inverted index: column_name => [table_names].
      # Skips sensitive columns so they can't be used as search hints.
      def build_table_index(columns_by_table)
        @table_index = {}
        columns_by_table.each do |table, columns|
          columns.each do |col|
            col_name = col["column_name"]
            next if self.class.sensitive?(col_name)

            (@table_index[col_name] ||= []) << table
          end
        end
      end

      # Build a bidirectional FK graph: table_name => [{from_col:, to_table:, to_col:}]
      # Includes both explicit FK constraints and convention-based _id columns.
      def build_fk_graph(fk_rows, columns_by_table, table_name_set)
        @fk_graph = {}

        # Explicit FK constraints (both directions)
        fk_rows.each do |r|
          from_table = r["from_table"]
          to_table   = r["to_table"]
          from_col   = r["from_column"]
          to_col     = r["to_column"]

          # Forward: from_table -> to_table
          (@fk_graph[from_table] ||= []) << { from_col: from_col, to_table: to_table, to_col: to_col }
          # Reverse: to_table -> from_table
          (@fk_graph[to_table] ||= []) << { from_col: to_col, to_table: from_table, to_col: from_col }
        end

        # Convention-based: *_id columns that resolve to a table name
        columns_by_table.each do |table, columns|
          columns.each do |col|
            col_name = col["column_name"]
            next unless col_name.end_with?("_id")

            base = col_name[0..-4] # remove '_id'
            candidates = [
              "#{base}s",
              "#{base.sub(/y$/, 'ie')}s",
              "#{base}es",
              base,
            ]
            candidates.each do |candidate|
              next unless table_name_set.include?(candidate)

              # Add forward edge if not already present from explicit FKs
              existing = (@fk_graph[table] ||= [])
              already = existing.any? { |e| e[:from_col] == col_name && e[:to_table] == candidate }
              unless already
                existing << { from_col: col_name, to_table: candidate, to_col: "id" }
                (@fk_graph[candidate] ||= []) << { from_col: "id", to_table: table, to_col: col_name }
              end
              break
            end
          end
        end
      end

      # Match an array of search terms to table names.
      # Tries (in order): exact table name, singular/plural variants, column name match,
      # substring match on column names.
      # Returns a Set of matching table names.
      def match_tables(terms)
        matched = Set.new
        table_set = Set.new(@tables)

        terms.each do |term|
          t = term.to_s.downcase.strip
          next if t.empty?

          # 1. Exact table name match
          if table_set.include?(t)
            matched.add(t)
            next
          end

          # 2. Singular/plural variants
          variants = [
            "#{t}s",
            "#{t.sub(/y$/, 'ie')}s",
            "#{t}es",
            t.sub(/ies$/, 'y'),
            t.sub(/s$/, ''),
          ]
          variant_match = variants.find { |v| table_set.include?(v) }
          matched.add(variant_match) if variant_match

          # 3. Prefix match on table names (e.g., "job" also matches "job_types", "job_offers")
          @tables.each do |tbl|
            matched.add(tbl) if tbl.start_with?("#{t}_")
          end

          # 4. Column name exact match (skip if we already found tables)
          next unless matched.empty? || !variant_match

          if @table_index.key?(t)
            @table_index[t].each { |tbl| matched.add(tbl) }
            next
          end

          # 5. Substring match on column names
          @table_index.each do |col_name, tables|
            if col_name.include?(t) || t.include?(col_name)
              tables.each { |tbl| matched.add(tbl) }
            end
          end
        end

        matched
      end

      # Return the top N tables by FK edge count (most-connected = hub tables).
      # Used as fallback when no search terms match any table.
      def hub_tables(limit)
        sorted = @tables.sort_by { |t| -(@fk_graph[t]&.length || 0) }
        Set.new(sorted.first(limit))
      end

      # BFS to find shortest FK join path between two tables (max depth 2).
      # Returns:
      #   []   — tables are directly connected (no bridge needed)
      #   [t]  — one bridge table t is needed
      #   nil  — no path found within max depth
      def find_join_path(from, to)
        return [] if from == to

        # Depth 1: direct edge
        neighbors_from = (@fk_graph[from] || []).map { |e| e[:to_table] }
        return [] if neighbors_from.include?(to)

        # Depth 2: one bridge table
        neighbors_from.each do |bridge|
          bridge_neighbors = (@fk_graph[bridge] || []).map { |e| e[:to_table] }
          return [bridge] if bridge_neighbors.include?(to)
        end

        nil
      end

      # -------------------------------------------------------------------
      # Legacy detection helpers (also called from discover loop above)
      # -------------------------------------------------------------------

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
