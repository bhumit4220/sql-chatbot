# frozen_string_literal: true

module SqlChatbot
  module Services
    class CodeIndexer
      SUPPORTED_EXTENSIONS = Set.new(%w[
        .js .ts .jsx .tsx .rb .py .erb .vue .php .java .go .cs .ex .exs .svelte .kt .rs .dart .scala
      ]).freeze

      SKIP_DIRS = Set.new(%w[
        node_modules .git dist build vendor tmp __pycache__ .next .svelte-kit .nuxt target bin obj deps _build
      ]).freeze

      DEFAULT_MAX_FILES = 2000
      MAX_FILE_SIZE = 100_000  # 100KB — skip vendor/minified JS libraries
      CONTEXT_LINES = 10
      MAX_SNIPPET_LINES = 50
      MAX_RESULTS = 10

      IndexedFile = Struct.new(:relative_path, :content)
      RouteInfo = Struct.new(:method, :path, :file, keyword_init: true)

      attr_reader :file_count

      def initialize(max_files: DEFAULT_MAX_FILES)
        @max_files = max_files
        @files = []
        @routes = []
        @file_count = 0
      end

      def index(code_paths)
        @files = []
        @routes = []

        code_paths.each do |code_path|
          break if @files.length >= @max_files
          scan_directory(code_path, code_path)
        end

        if @files.length > @max_files
          @files = @files.first(@max_files)
          warn "CodeIndexer: file cap reached (#{@max_files}). Some files were not indexed."
        end

        @file_count = @files.length
        detect_routes
      end

      def search(terms)
        lower_terms = terms.map(&:downcase)
        results = []

        @files.each do |file|
          lower_content = file.content.downcase
          match_count = lower_terms.count { |term| lower_content.include?(term) }
          next if match_count == 0

          lines = file.content.split("\n")
          matched_line_indices = Set.new

          lower_terms.each do |term|
            lines.each_with_index do |line, i|
              matched_line_indices.add(i) if line.downcase.include?(term)
            end
          end

          # Build snippet with context (+-10 lines around each match, max ~50 lines)
          include_lines = Set.new
          matched_line_indices.each do |idx|
            start_line = [0, idx - CONTEXT_LINES].max
            end_line = [lines.length - 1, idx + CONTEXT_LINES].min
            (start_line..end_line).each { |i| include_lines.add(i) }
          end

          sorted_lines = include_lines.to_a.sort.first(MAX_SNIPPET_LINES)
          snippet = sorted_lines.map { |i| lines[i] }.join("\n")

          results << {
            file: file.relative_path,
            content: snippet,
            match_count: match_count
          }
        end

        # Sort by match_count descending, take top 10
        results.sort_by! { |r| -r[:match_count] }
        results.first(MAX_RESULTS)
      end

      def get_routes
        @routes.map { |r| { method: r.method, path: r.path, file: r.file } }
      end

      def get_route_summary
        return "No routes detected." if @routes.empty?

        lines = @routes.map { |r| "#{r.method} #{r.path} -> #{r.file}" }
        "Routes detected:\n#{lines.join("\n")}"
      end

      private

      def scan_directory(dir, base_path)
        return if @files.length >= @max_files

        entries = begin
          Dir.entries(dir)
        rescue SystemCallError
          return
        end

        entries.sort.each do |entry|
          break if @files.length >= @max_files
          next if entry == "." || entry == ".."

          full_path = File.join(dir, entry)

          if File.directory?(full_path)
            next if SKIP_DIRS.include?(entry)
            scan_directory(full_path, base_path)
          elsif File.file?(full_path)
            ext = File.extname(entry)
            next unless SUPPORTED_EXTENSIONS.include?(ext)

            # Skip large files (vendor/minified libraries)
            begin
              next if File.size(full_path) > MAX_FILE_SIZE
            rescue SystemCallError
              next
            end

            relative_path = compute_relative_path(full_path, base_path)
            begin
              content = File.read(full_path, encoding: "utf-8")
              @files << IndexedFile.new(relative_path, content)
            rescue SystemCallError, Encoding::InvalidByteSequenceError
              # skip unreadable files
            end
          end
        end
      end

      def compute_relative_path(full_path, base_path)
        # Ensure base_path ends with separator for clean relative path
        base = base_path.end_with?("/") ? base_path : "#{base_path}/"
        full_path.start_with?(base) ? full_path[base.length..] : full_path
      end

      def detect_routes
        @files.each do |file|
          detect_method_call_routes(file)
          detect_react_router_routes(file)
          detect_rails_routes(file)
          detect_config_routes(file)
          detect_decorator_routes(file)
          detect_sinatra_routes(file)
        end
      end

      # --- Route detection methods ---

      def detect_method_call_routes(file)
        ext = File.extname(file.relative_path)

        if %w[.js .ts .jsx .tsx].include?(ext)
          # Express, Fastify, Hono, Koa
          file.content.scan(/(?:app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/i) do |method, path|
            @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
          end
        elsif ext == ".go"
          # Gin, Echo, Fiber
          file.content.scan(/\w+\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/i) do |method, path|
            @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
          end
        end
      end

      def detect_react_router_routes(file)
        # <Route ... path="/something" ... />
        file.content.scan(/<Route\b.*?path=["']([^"']+)["']/im) do |path,|
          @routes << RouteInfo.new(method: "GET", path: path, file: file.relative_path)
        end

        # path: '/something' in route config objects (only if file has route-related imports)
        if file.content.match?(/useRoutes|createBrowserRouter|createRoutesFromElements/i)
          file.content.scan(/path:\s*['"`]([^'"`]+)['"`]/i) do |path,|
            @routes << RouteInfo.new(method: "GET", path: path, file: file.relative_path)
          end
        end
      end

      def detect_rails_routes(file)
        return unless file.relative_path.end_with?("routes.rb")

        content = file.content

        # root 'controller#action'
        if content.match?(/root\s+['"]/)
          @routes << RouteInfo.new(method: "GET", path: "/", file: file.relative_path)
        end

        # resources :name
        content.scan(/resources\s+:(\w+)/i) do |name,|
          @routes << RouteInfo.new(method: "GET", path: "/#{name}", file: file.relative_path)
        end

        # get '/path', to: 'controller#action'
        content.scan(/get\s+['"]([^'"]+)['"]/i) do |path,|
          @routes << RouteInfo.new(method: "GET", path: path, file: file.relative_path)
        end

        # post '/path', to: 'controller#action'
        content.scan(/post\s+['"]([^'"]+)['"]/i) do |path,|
          @routes << RouteInfo.new(method: "POST", path: path, file: file.relative_path)
        end

        # put '/path', to: 'controller#action'
        content.scan(/put\s+['"]([^'"]+)['"]/i) do |path,|
          @routes << RouteInfo.new(method: "PUT", path: path, file: file.relative_path)
        end

        # delete '/path', to: 'controller#action'
        content.scan(/delete\s+['"]([^'"]+)['"]/i) do |path,|
          @routes << RouteInfo.new(method: "DELETE", path: path, file: file.relative_path)
        end
      end

      def detect_config_routes(file)
        ext = File.extname(file.relative_path)
        filename = File.basename(file.relative_path)

        # Django: urls.py with path(), re_path(), url()
        if filename == "urls.py" || (ext == ".py" && file.content.include?("urlpatterns"))
          file.content.scan(/(?:path|re_path|url)\(\s*['"]([^'"]*)['"]/i) do |path,|
            cleaned = "/" + path.sub(/^\^/, "").sub(/\$$/, "")
            @routes << RouteInfo.new(method: "ALL", path: cleaned, file: file.relative_path)
          end
        end

        # Laravel: Route::get('/path', ...), Route::resource('name', ...)
        if ext == ".php"
          file.content.scan(/Route::(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/i) do |method, path|
            @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
          end
          file.content.scan(/Route::resource\(\s*['"]([^'"]+)['"]/i) do |name,|
            @routes << RouteInfo.new(method: "GET", path: "/#{name}", file: file.relative_path)
          end
        end

        # ASP.NET minimal APIs: app.MapGet("/path", ...)
        if ext == ".cs"
          file.content.scan(/app\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/i) do |method, path|
            @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
          end

          # ASP.NET attribute routing: [HttpGet("path")], [Route("path")]
          file.content.scan(/\[Http(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"\s*\)\]/i) do |method, path|
            @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
          end
          file.content.scan(/\[Route\(\s*"([^"]+)"\s*\)\]/i) do |path,|
            @routes << RouteInfo.new(method: "ALL", path: path, file: file.relative_path)
          end
        end

        # Phoenix: get "/path", Controller, :action
        if filename == "router.ex" || (ext == ".ex" && file.content.include?("Phoenix.Router"))
          file.content.scan(/(get|post|put|patch|delete)\s+"([^"]+)"/i) do |method, path|
            @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
          end
        end
      end

      def detect_decorator_routes(file)
        ext = File.extname(file.relative_path)

        # NestJS: @Controller('prefix') + @Get('subpath')
        if %w[.ts .js].include?(ext)
          controller_match = file.content.match(/@Controller\(\s*['"]([^'"]*)['"]\s*\)/)
          if controller_match
            prefix = controller_match[1]
            file.content.scan(/@(Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]*)['"]\s*\)/i) do |method, subpath|
              full_path = "/" + [prefix, subpath].reject(&:empty?).join("/")
              @routes << RouteInfo.new(method: method.upcase, path: full_path, file: file.relative_path)
            end
            # Match decorators with no path argument: @Get()
            file.content.scan(/@(Get|Post|Put|Patch|Delete)\(\s*\)/i) do |method,|
              @routes << RouteInfo.new(method: method.upcase, path: "/#{prefix}", file: file.relative_path)
            end
          end
        end

        # FastAPI: @app.get("/path") / @router.post("/path")
        if ext == ".py" && !file.content.include?("urlpatterns")
          file.content.scan(/@(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/i) do |method, path|
            @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
          end
        end

        # Flask: @app.route('/path', methods=['GET', 'POST'])
        if ext == ".py"
          file.content.scan(/@app\.route\(\s*['"]([^'"]+)['"](?:,\s*methods=\[([^\]]+)\])?\s*\)/i) do |route_path, methods_str|
            if methods_str
              methods = methods_str.gsub(/['"]/, "").split(/\s*,\s*/)
              methods.each do |method|
                @routes << RouteInfo.new(method: method.strip.upcase, path: route_path, file: file.relative_path)
              end
            else
              @routes << RouteInfo.new(method: "GET", path: route_path, file: file.relative_path)
            end
          end
        end

        # Spring Boot: @GetMapping("/path") + class-level @RequestMapping("/prefix")
        if ext == ".java"
          request_mapping_match = file.content.match(/@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/)
          prefix = request_mapping_match ? request_mapping_match[1] : ""

          file.content.scan(/@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/i) do |method, subpath|
            full_path = prefix.empty? ? subpath : prefix + subpath
            @routes << RouteInfo.new(method: method.upcase, path: full_path, file: file.relative_path)
          end
        end
      end

      def detect_sinatra_routes(file)
        return unless file.relative_path.end_with?(".rb")
        # Exclude Rails routes.rb files (handled by detect_rails_routes)
        return if file.relative_path.end_with?("routes.rb")

        file.content.scan(/(get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s+do/i) do |method, path|
          @routes << RouteInfo.new(method: method.upcase, path: path, file: file.relative_path)
        end
      end
    end
  end
end
