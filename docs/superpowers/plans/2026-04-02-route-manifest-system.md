# Route Manifest System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chatbot complete knowledge of ALL application routes and frontend code, regardless of deployment architecture (monolith or distributed).

**Architecture:** Two-pronged approach: (1) New `sql-chatbot-manifest` npm package with Vite/Webpack plugins that scan frontend route definitions and source files at build time, generating a `chatbot-manifest.json`. (2) New `RouteIntrospector` service in the Rails gem that reads `Rails.application.routes` at boot. Both feed into the same orchestrator pipeline via a shared manifest format. The widget fetches the manifest and POSTs it once to the backend.

**Tech Stack:** TypeScript (npm plugin), Ruby (gem service), Vite/Webpack plugin APIs, regex-based route extraction, React Router / Vue Router / Next.js / Nuxt / SvelteKit route detection.

**Master design doc:** `memory/project_manifest_system.md`

---

## File Structure

### New npm package: `packages/manifest/`

```
packages/manifest/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                    — Public exports: vitePlugin, webpackPlugin
    types.ts                    — Manifest, ManifestRoute, ManifestFile, PluginOptions interfaces
    scanner.ts                  — Core route scanner: auto-detect framework, scan files, build manifest
    frameworks/
      react-router.ts           — Regex-based React Router route extraction
      vue-router.ts             — Regex-based Vue Router route extraction
      filesystem.ts             — File-system router detection (Next.js, Nuxt, SvelteKit)
    file-indexer.ts             — Scans all source files (mirrors CodeIndexer logic)
    vite-plugin.ts              — Vite plugin wrapper
    webpack-plugin.ts           — Webpack plugin wrapper
    __tests__/
      scanner.test.ts           — Core scanner tests
      react-router.test.ts      — React Router extraction tests
      vue-router.test.ts        — Vue Router extraction tests
      filesystem.test.ts        — File-system router tests
      file-indexer.test.ts      — File indexer tests
      vite-plugin.test.ts       — Vite plugin integration tests
      webpack-plugin.test.ts    — Webpack plugin integration tests
```

### Modified files in `packages/agent/` (npm backend)

```
packages/agent/
  src/
    services/orchestrator.ts    — Add setManifest(), merge routes into prompts
    middleware.ts               — Add POST /api/manifest endpoint
    prompts/classify.ts         — Include route list in system prompt
    prompts/answer.ts           — Include route list for nav/guidance answers
  widget-src/
    ChatWidget.tsx              — Fetch manifest on mount, POST to backend
  src/__tests__/
    orchestrator.test.ts        — Tests for manifest merging
    middleware.test.ts          — Tests for POST /api/manifest
    prompts/classify.test.ts    — Tests for route injection
    prompts/answer.test.ts      — Tests for route injection
```

### Modified/new files in `sql-chatbot-rails/` (gem backend)

```
sql-chatbot-rails/
  lib/sql_chatbot/
    services/route_introspector.rb     — NEW: reads Rails.application.routes
    services/orchestrator.rb           — Add set_manifest(), merge routes
    prompts/classify.rb                — Include route list in system prompt
    prompts/answer.rb                  — Include route list for nav/guidance
  app/controllers/sql_chatbot/
    chatbot_controller.rb              — Add manifest action
  config/routes.rb                     — Add POST api/manifest route
  lib/sql_chatbot_rails.rb             — Wire RouteIntrospector into boot
  spec/sql_chatbot/
    services/route_introspector_spec.rb — NEW: RouteIntrospector tests
    services/orchestrator_spec.rb       — Manifest merging tests
    prompts/classify_spec.rb            — Route injection tests
    prompts/answer_spec.rb              — Route injection tests
```

---

## Phase 1: Rails Gem — RouteIntrospector (Tasks 1-4)

### Task 1: RouteIntrospector Service — Tests

**Files:**
- Create: `sql-chatbot-rails/spec/sql_chatbot/services/route_introspector_spec.rb`

- [ ] **Step 1: Write the failing tests**

```ruby
# spec/sql_chatbot/services/route_introspector_spec.rb
# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/services/route_introspector"

RSpec.describe SqlChatbot::Services::RouteIntrospector do
  let(:introspector) { described_class.new }

  describe "#introspect" do
    context "when Rails routes are available" do
      before do
        # Stub Rails.application.routes.routes
        route1 = double("route",
          path: double(spec: double(to_s: "/admin/users(.:format)")),
          verb: /^GET$/,
          defaults: { controller: "admin/users", action: "index" },
          internal: false
        )
        route2 = double("route",
          path: double(spec: double(to_s: "/admin/users/:id(.:format)")),
          verb: /^GET$/,
          defaults: { controller: "admin/users", action: "show" },
          internal: false
        )
        route3 = double("route",
          path: double(spec: double(to_s: "/admin/users(.:format)")),
          verb: /^POST$/,
          defaults: { controller: "admin/users", action: "create" },
          internal: false
        )
        routes_collection = double("routes", routes: [route1, route2, route3])
        app = double("application", routes: routes_collection)
        allow(Rails).to receive(:application).and_return(app)
      end

      it "returns all non-internal routes" do
        result = introspector.introspect
        expect(result).to be_an(Array)
        expect(result.length).to eq(3)
      end

      it "normalizes path by removing format suffix" do
        result = introspector.introspect
        paths = result.map { |r| r[:path] }
        expect(paths).to include("/admin/users")
        expect(paths).to include("/admin/users/:id")
        expect(paths).not_to include("/admin/users(.:format)")
      end

      it "extracts HTTP method from verb regex" do
        result = introspector.introspect
        methods = result.map { |r| r[:method] }
        expect(methods).to include("GET", "POST")
      end

      it "derives human-readable labels from controller/action" do
        result = introspector.introspect
        index_route = result.find { |r| r[:path] == "/admin/users" && r[:method] == "GET" }
        expect(index_route[:label]).to eq("Users")

        show_route = result.find { |r| r[:path] == "/admin/users/:id" }
        expect(show_route[:label]).to eq("User Detail")
      end

      it "derives parent paths from route hierarchy" do
        result = introspector.introspect
        users_route = result.find { |r| r[:path] == "/admin/users" && r[:method] == "GET" }
        expect(users_route[:parentPath]).to eq("/admin")

        show_route = result.find { |r| r[:path] == "/admin/users/:id" }
        expect(show_route[:parentPath]).to eq("/admin/users")
      end
    end

    context "filtering internal routes" do
      before do
        internal_route = double("route",
          path: double(spec: double(to_s: "/rails/active_storage/blobs/:id(.:format)")),
          verb: /^GET$/,
          defaults: { controller: "active_storage/blobs", action: "show" },
          internal: true
        )
        chatbot_route = double("route",
          path: double(spec: double(to_s: "/chatbot/api/ask(.:format)")),
          verb: /^POST$/,
          defaults: { controller: "sql_chatbot/chatbot", action: "ask" },
          internal: false
        )
        action_mailbox = double("route",
          path: double(spec: double(to_s: "/rails/action_mailbox/inbound_emails(.:format)")),
          verb: /^POST$/,
          defaults: { controller: "action_mailbox/inbound_emails", action: "create" },
          internal: false
        )
        normal_route = double("route",
          path: double(spec: double(to_s: "/api/health(.:format)")),
          verb: /^GET$/,
          defaults: { controller: "health", action: "check" },
          internal: false
        )
        routes_collection = double("routes", routes: [internal_route, chatbot_route, action_mailbox, normal_route])
        app = double("application", routes: routes_collection)
        allow(Rails).to receive(:application).and_return(app)
      end

      it "excludes routes marked as internal" do
        result = introspector.introspect
        paths = result.map { |r| r[:path] }
        expect(paths).not_to include("/rails/active_storage/blobs/:id")
      end

      it "excludes sql_chatbot engine routes" do
        result = introspector.introspect
        paths = result.map { |r| r[:path] }
        expect(paths).not_to include("/chatbot/api/ask")
      end

      it "excludes rails internal controllers" do
        result = introspector.introspect
        paths = result.map { |r| r[:path] }
        expect(paths).not_to include("/rails/action_mailbox/inbound_emails")
      end

      it "keeps normal application routes" do
        result = introspector.introspect
        paths = result.map { |r| r[:path] }
        expect(paths).to include("/api/health")
      end
    end

    context "when Rails is not available" do
      before do
        allow(Rails).to receive(:application).and_return(nil)
      end

      it "returns an empty array" do
        result = introspector.introspect
        expect(result).to eq([])
      end
    end

    context "label derivation edge cases" do
      before do
        root_route = double("route",
          path: double(spec: double(to_s: "/(.:format)")),
          verb: /^GET$/,
          defaults: { controller: "dashboard", action: "index" },
          internal: false
        )
        nested_route = double("route",
          path: double(spec: double(to_s: "/admin/settings/notifications(.:format)")),
          verb: /^GET$/,
          defaults: { controller: "admin/settings/notifications", action: "index" },
          internal: false
        )
        routes_collection = double("routes", routes: [root_route, nested_route])
        app = double("application", routes: routes_collection)
        allow(Rails).to receive(:application).and_return(app)
      end

      it "labels root route as Dashboard from controller name" do
        result = introspector.introspect
        root = result.find { |r| r[:path] == "/" }
        expect(root[:label]).to eq("Dashboard")
      end

      it "handles deeply nested controllers" do
        result = introspector.introspect
        nested = result.find { |r| r[:path] == "/admin/settings/notifications" }
        expect(nested[:label]).to eq("Notifications")
        expect(nested[:parentPath]).to eq("/admin/settings")
      end
    end
  end

  describe "#format_route_list" do
    before do
      route1 = double("route",
        path: double(spec: double(to_s: "/admin/users(.:format)")),
        verb: /^GET$/,
        defaults: { controller: "admin/users", action: "index" },
        internal: false
      )
      route2 = double("route",
        path: double(spec: double(to_s: "/admin/settings(.:format)")),
        verb: /^GET$/,
        defaults: { controller: "admin/settings", action: "index" },
        internal: false
      )
      routes_collection = double("routes", routes: [route1, route2])
      app = double("application", routes: routes_collection)
      allow(Rails).to receive(:application).and_return(app)
    end

    it "formats routes as a prompt-friendly string" do
      result = introspector.format_route_list
      expect(result).to include("/admin/users")
      expect(result).to include("Users")
      expect(result).to include("/admin/settings")
      expect(result).to include("Settings")
    end

    it "returns empty message when no routes" do
      allow(Rails).to receive(:application).and_return(nil)
      result = introspector.format_route_list
      expect(result).to eq("No application routes detected.")
    end
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/route_introspector_spec.rb`
Expected: FAIL — `cannot load such file -- sql_chatbot/services/route_introspector`

---

### Task 2: RouteIntrospector Service — Implementation

**Files:**
- Create: `sql-chatbot-rails/lib/sql_chatbot/services/route_introspector.rb`

- [ ] **Step 1: Implement RouteIntrospector**

```ruby
# lib/sql_chatbot/services/route_introspector.rb
# frozen_string_literal: true

module SqlChatbot
  module Services
    class RouteIntrospector
      INTERNAL_CONTROLLERS = %w[
        active_storage/ action_mailbox/ action_cable/ rails/
        sql_chatbot/
      ].freeze

      ACTION_LABELS = {
        "index"   => nil,       # Use controller name
        "show"    => "Detail",
        "new"     => "New",
        "create"  => "Create",
        "edit"    => "Edit",
        "update"  => "Update",
        "destroy" => "Delete",
      }.freeze

      def introspect
        return [] unless defined?(Rails) && Rails.application

        Rails.application.routes.routes.filter_map do |route|
          next if route.internal
          next if internal_controller?(route)

          path = normalize_path(route)
          next if path.nil? || path.empty?

          {
            path: path,
            method: extract_method(route),
            label: derive_label(route),
            parentPath: derive_parent(path),
          }
        end
      end

      def format_route_list
        routes = introspect
        return "No application routes detected." if routes.empty?

        lines = routes.select { |r| r[:method] == "GET" }.map do |r|
          parent_note = r[:parentPath] ? " (under #{r[:parentPath]})" : ""
          "- #{r[:path]} \u2014 #{r[:label]}#{parent_note}"
        end

        "## Available Application Pages\n#{lines.join("\n")}"
      end

      private

      def internal_controller?(route)
        controller = route.defaults[:controller].to_s
        INTERNAL_CONTROLLERS.any? { |prefix| controller.start_with?(prefix) }
      end

      def normalize_path(route)
        path = route.path.spec.to_s
        path = path.sub("(.:format)", "")
        path = path.sub(/\(\..+\)$/, "")  # Remove any remaining optional segments
        path = "/" if path.empty?
        path
      end

      def extract_method(route)
        verb = route.verb
        case verb
        when Regexp
          match = verb.source.gsub(/[\^$]/, "")
          match.empty? ? "GET" : match.split("|").first
        when String
          verb.empty? ? "GET" : verb
        else
          "GET"
        end
      end

      def derive_label(route)
        controller = route.defaults[:controller].to_s
        action = route.defaults[:action].to_s

        # Get the last segment of the controller name
        # "admin/users" -> "users", "admin/settings/notifications" -> "notifications"
        base_name = controller.split("/").last.to_s

        # Humanize: "users" -> "Users", "user_profiles" -> "User Profiles"
        humanized = base_name.split("_").map(&:capitalize).join(" ")

        # Singularize for show/edit/new/destroy
        singular = singularize(humanized)

        case action
        when "index"
          humanized
        when "show"
          "#{singular} Detail"
        when "new", "create"
          "New #{singular}"
        when "edit", "update"
          "Edit #{singular}"
        when "destroy"
          "Delete #{singular}"
        else
          # Custom action — use action name
          "#{humanized} #{action.split("_").map(&:capitalize).join(" ")}"
        end
      end

      def derive_parent(path)
        segments = path.split("/").reject(&:empty?)
        return nil if segments.length <= 1

        # Remove last segment (including :param segments above it)
        parent_segments = segments[0...-1]
        # If parent ends with a :param, remove that too
        parent_segments.pop while parent_segments.last&.start_with?(":")
        return nil if parent_segments.empty?

        "/#{parent_segments.join("/")}"
      end

      def singularize(word)
        # Simple singularization — covers common cases
        if word.end_with?("ies")
          word[0...-3] + "y"
        elsif word.end_with?("ses")
          word[0...-2]
        elsif word.end_with?("s") && !word.end_with?("ss")
          word[0...-1]
        else
          word
        end
      end
    end
  end
end
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/route_introspector_spec.rb -f doc`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add sql-chatbot-rails/lib/sql_chatbot/services/route_introspector.rb sql-chatbot-rails/spec/sql_chatbot/services/route_introspector_spec.rb
git commit -m "feat(rails): add RouteIntrospector service for Rails route scanning"
```

---

### Task 3: Wire RouteIntrospector into Gem Boot + Orchestrator

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot_rails.rb` (boot sequence, ~line 47)
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/orchestrator.rb` (add manifest support)
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/orchestrator_spec.rb` (add manifest tests)

- [ ] **Step 1: Write failing orchestrator tests for manifest support**

Add to `spec/sql_chatbot/services/orchestrator_spec.rb`:

```ruby
describe "#set_manifest" do
  it "stores manifest routes" do
    manifest = {
      "version" => 1,
      "routes" => [
        { "path" => "/admin/users", "method" => "GET", "label" => "Users" },
        { "path" => "/admin/settings", "method" => "GET", "label" => "Settings" },
      ]
    }
    orchestrator.set_manifest(manifest)
    expect(orchestrator.route_list).to include("/admin/users")
    expect(orchestrator.route_list).to include("Users")
  end
end

describe "#route_list" do
  context "with both manifest and code indexer routes" do
    it "merges and deduplicates routes" do
      allow(code_indexer).to receive(:get_route_summary).and_return(
        "Routes detected:\nGET /admin/users -> app/controllers/admin/users_controller.rb\nGET /api/health -> app/controllers/health_controller.rb"
      )
      manifest = {
        "version" => 1,
        "routes" => [
          { "path" => "/admin/users", "method" => "GET", "label" => "Users" },
          { "path" => "/dashboard", "method" => "GET", "label" => "Dashboard" },
        ]
      }
      orchestrator.set_manifest(manifest)
      list = orchestrator.route_list
      # Manifest routes should be present with labels
      expect(list).to include("Users")
      expect(list).to include("Dashboard")
      # Should not duplicate /admin/users
      expect(list.scan("/admin/users").length).to eq(1)
    end
  end

  context "without manifest" do
    it "falls back to code indexer route summary" do
      allow(code_indexer).to receive(:get_route_summary).and_return(
        "Routes detected:\nGET /admin/users -> controllers/admin/users_controller.rb"
      )
      expect(orchestrator.route_list).to include("/admin/users")
    end
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/orchestrator_spec.rb`
Expected: FAIL — `undefined method 'set_manifest'`

- [ ] **Step 3: Add manifest support to orchestrator**

In `sql-chatbot-rails/lib/sql_chatbot/services/orchestrator.rb`, add after `def initialize` block (after line 18):

```ruby
      def set_manifest(manifest)
        @manifest = manifest
      end

      def route_list
        build_route_list
      end
```

Add private method `build_route_list` at bottom of private section:

```ruby
      def build_route_list
        routes_by_path = {}

        # 1. Code indexer routes (lowest priority)
        @code_indexer.get_routes.each do |r|
          routes_by_path[r[:path]] ||= { path: r[:path], method: r[:method], label: nil, source: "code_indexer" }
        end

        # 2. Manifest routes from widget (higher priority, has labels)
        if @manifest && @manifest["routes"]
          @manifest["routes"].each do |r|
            routes_by_path[r["path"]] = {
              path: r["path"],
              method: r["method"] || "GET",
              label: r["label"],
              parentPath: r["parentPath"],
              source: "manifest"
            }
          end
        end

        # 3. RouteIntrospector routes (highest priority for Rails apps)
        if @route_introspector_data
          @route_introspector_data.each do |r|
            routes_by_path[r[:path]] = r.merge(source: "introspector")
          end
        end

        return "No application routes detected." if routes_by_path.empty?

        lines = routes_by_path.values
          .select { |r| r[:method] == "GET" }
          .map do |r|
            parent_note = r[:parentPath] ? " (under #{r[:parentPath]})" : ""
            label = r[:label] || r[:path].split("/").last&.capitalize || "Page"
            "- #{r[:path]} \u2014 #{label}#{parent_note}"
          end

        "## Available Application Pages\n#{lines.join("\n")}"
      end
```

- [ ] **Step 4: Update handle_navigation to use route_list**

In `orchestrator.rb`, replace the `handle_navigation` method:

```ruby
      def handle_navigation(yielder, question, type, page_context, history)
        merged_routes = build_route_list
        nav_links = merged_routes == "No application routes detected." ? nil : [merged_routes]

        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: type,
          page_context: page_context,
          navigation_links: nav_links,
          history: history
        )

        @llm.stream(answer_messages) do |chunk|
          yielder.yield({ type: "token", content: chunk })
        end
      end
```

- [ ] **Step 5: Wire RouteIntrospector into boot sequence**

In `sql-chatbot-rails/lib/sql_chatbot_rails.rb`, add after the ModelIntrospector block (~line 61) and before the CodeIndexer:

```ruby
        # Introspect Rails routes for navigation context
        route_introspector = Services::RouteIntrospector.new
        route_data = route_introspector.introspect
```

And pass it to the orchestrator constructor. Update orchestrator `initialize` to accept it:

In `orchestrator.rb`, update initialize:

```ruby
      def initialize(llm_client:, schema_service:, code_indexer:, route_introspector_data: nil)
        @llm = llm_client
        @schema = schema_service
        @code_indexer = code_indexer
        @route_introspector_data = route_introspector_data
        @manifest = nil
      end
```

In `sql_chatbot_rails.rb`, update orchestrator creation:

```ruby
        @orchestrator = Services::Orchestrator.new(
          llm_client: llm_client,
          schema_service: @schema_service,
          code_indexer: @code_indexer,
          route_introspector_data: route_data,
        )
```

- [ ] **Step 6: Add require for route_introspector**

In `sql-chatbot-rails/lib/sql_chatbot_rails.rb`, add after line 13:

```ruby
require "sql_chatbot/services/route_introspector"
```

- [ ] **Step 7: Run all orchestrator tests**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/orchestrator_spec.rb -f doc`
Expected: All tests PASS

- [ ] **Step 8: Run full gem test suite**

Run: `cd sql-chatbot-rails && bundle exec rspec`
Expected: All tests PASS (existing + new)

- [ ] **Step 9: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add sql-chatbot-rails/lib/sql_chatbot_rails.rb sql-chatbot-rails/lib/sql_chatbot/services/orchestrator.rb sql-chatbot-rails/spec/sql_chatbot/services/orchestrator_spec.rb
git commit -m "feat(rails): wire RouteIntrospector into boot and orchestrator"
```

---

### Task 4: Gem — Manifest Endpoint + Route Injection into Prompts

**Files:**
- Modify: `sql-chatbot-rails/app/controllers/sql_chatbot/chatbot_controller.rb`
- Modify: `sql-chatbot-rails/config/routes.rb`
- Modify: `sql-chatbot-rails/lib/sql_chatbot/prompts/classify.rb`
- Modify: `sql-chatbot-rails/lib/sql_chatbot/prompts/answer.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/prompts/classify_spec.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/prompts/answer_spec.rb`

- [ ] **Step 1: Add POST /api/manifest route**

In `sql-chatbot-rails/config/routes.rb`, add after line 8:

```ruby
  post "api/manifest", to: "chatbot#receive_manifest"
```

- [ ] **Step 2: Add manifest controller action**

In `sql-chatbot-rails/app/controllers/sql_chatbot/chatbot_controller.rb`, add after the `refresh` method:

```ruby
    def receive_manifest
      return render_unauthorized unless authorized?
      ensure_initialized!

      manifest = params[:manifest]
      if manifest.present?
        SqlChatbot.orchestrator.set_manifest(manifest.to_unsafe_h)
        render json: { status: "received", routeCount: manifest["routes"]&.length || 0 }
      else
        render json: { error: "manifest is required" }, status: 400
      end
    rescue => e
      render json: { status: "error", message: e.message }, status: 500
    end
```

- [ ] **Step 3: Add route list injection to classify prompt**

In `sql-chatbot-rails/lib/sql_chatbot/prompts/classify.rb`, update `build_messages` to accept `route_list`:

Change the method signature on line 34 to:

```ruby
      def self.build_messages(question:, schema_summary:, page_context: nil, history: nil, route_list: nil)
```

After line 44 (`user_content += "\n\nCurrent page context:\n#{page_context}" if page_context`), add:

```ruby
        user_content += "\n\n#{route_list}" if route_list && route_list != "No application routes detected."
```

- [ ] **Step 4: Add route list injection to answer prompt for all types**

In `sql-chatbot-rails/lib/sql_chatbot/prompts/answer.rb`, update `build_messages` signature on line 160 to add `route_list:`:

```ruby
      def self.build_messages(question:, type:, history: [], sql_result: nil, sql_query: nil, code_snippets: nil, page_context: nil, navigation_links: nil, route_list: nil)
```

After the navigation_links block (after line 195), add:

```ruby
        if route_list && route_list != "No application routes detected." && (type == "navigation" || type == "guidance")
          user_content += "\n\n#{route_list}"
        end
```

- [ ] **Step 5: Update orchestrator to pass route_list to prompts**

In `orchestrator.rb`, update the classify call inside `handle_question` to pass route_list:

```ruby
            classify_messages = Prompts::Classify.build_messages(
              question: question,
              schema_summary: schema_summary,
              page_context: page_context,
              history: history,
              route_list: build_route_list
            )
```

Update `handle_navigation` to pass route_list:

```ruby
      def handle_navigation(yielder, question, type, page_context, history)
        merged_routes = build_route_list

        answer_messages = Prompts::Answer.build_messages(
          question: question,
          type: type,
          page_context: page_context,
          route_list: merged_routes,
          history: history
        )

        @llm.stream(answer_messages) do |chunk|
          yielder.yield({ type: "token", content: chunk })
        end
      end
```

- [ ] **Step 6: Write tests for prompt route injection**

Add to `spec/sql_chatbot/prompts/classify_spec.rb`:

```ruby
  context "with route_list" do
    it "includes route list in user content" do
      messages = described_class.build_messages(
        question: "where is the users page?",
        schema_summary: "TABLE users (id INT)",
        route_list: "## Available Application Pages\n- /admin/users — Users"
      )
      user_content = messages.last[:content]
      expect(user_content).to include("Available Application Pages")
      expect(user_content).to include("/admin/users")
    end

    it "excludes empty route list" do
      messages = described_class.build_messages(
        question: "how many users?",
        schema_summary: "TABLE users (id INT)",
        route_list: "No application routes detected."
      )
      user_content = messages.last[:content]
      expect(user_content).not_to include("application routes")
    end
  end
```

Add to `spec/sql_chatbot/prompts/answer_spec.rb`:

```ruby
  context "with route_list for navigation" do
    it "includes route list for navigation type" do
      messages = described_class.build_messages(
        question: "where is settings?",
        type: "navigation",
        route_list: "## Available Application Pages\n- /admin/settings — Settings"
      )
      user_content = messages.last[:content]
      expect(user_content).to include("Available Application Pages")
      expect(user_content).to include("/admin/settings")
    end

    it "does not include route list for data type" do
      messages = described_class.build_messages(
        question: "how many users?",
        type: "data",
        route_list: "## Available Application Pages\n- /admin/users — Users"
      )
      user_content = messages.last[:content]
      expect(user_content).not_to include("Available Application Pages")
    end
  end
```

- [ ] **Step 7: Run full gem test suite**

Run: `cd sql-chatbot-rails && bundle exec rspec`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add sql-chatbot-rails/config/routes.rb sql-chatbot-rails/app/controllers/sql_chatbot/chatbot_controller.rb sql-chatbot-rails/lib/sql_chatbot/prompts/classify.rb sql-chatbot-rails/lib/sql_chatbot/prompts/answer.rb sql-chatbot-rails/lib/sql_chatbot/services/orchestrator.rb sql-chatbot-rails/spec/sql_chatbot/prompts/classify_spec.rb sql-chatbot-rails/spec/sql_chatbot/prompts/answer_spec.rb
git commit -m "feat(rails): add manifest endpoint and route injection into prompts"
```

---

## Phase 2: NPM Backend — Manifest Support (Tasks 5-6)

### Task 5: NPM Orchestrator — Manifest Support

**Files:**
- Modify: `packages/agent/src/services/orchestrator.ts`
- Modify: `packages/agent/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/agent/src/__tests__/orchestrator.test.ts`:

```typescript
describe('manifest support', () => {
  it('stores manifest via setManifest', async () => {
    const schema = createMockSchemaService();
    const codeIndexer = createMockCodeIndexer();
    const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });

    orch.setManifest({
      version: 1,
      routes: [
        { path: '/admin/users', method: 'GET', label: 'Users' },
        { path: '/dashboard', method: 'GET', label: 'Dashboard' },
      ],
      files: [],
    });

    expect(orch.getRouteList()).toContain('/admin/users');
    expect(orch.getRouteList()).toContain('Users');
    expect(orch.getRouteList()).toContain('Dashboard');
  });

  it('merges manifest routes with code indexer routes', async () => {
    const schema = createMockSchemaService();
    const codeIndexer = createMockCodeIndexer();
    (codeIndexer.getRoutes as ReturnType<typeof vi.fn>).mockReturnValue([
      { method: 'GET', path: '/admin/users', file: 'routes.tsx' },
      { method: 'GET', path: '/api/health', file: 'server.ts' },
    ]);

    const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });
    orch.setManifest({
      version: 1,
      routes: [
        { path: '/admin/users', method: 'GET', label: 'Users', parentPath: '/admin' },
        { path: '/dashboard', method: 'GET', label: 'Dashboard' },
      ],
      files: [],
    });

    const list = orch.getRouteList();
    // Manifest label wins over code indexer
    expect(list).toContain('Users');
    expect(list).toContain('Dashboard');
    // No duplicate for /admin/users
    const matches = list.match(/\/admin\/users/g);
    expect(matches?.length).toBe(1);
  });

  it('returns fallback message without manifest or routes', async () => {
    const schema = createMockSchemaService();
    const codeIndexer = createMockCodeIndexer();
    (codeIndexer.getRoutes as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });
    expect(orch.getRouteList()).toBe('No application routes detected.');
  });

  it('merges manifest files into search', async () => {
    const schema = createMockSchemaService();
    const codeIndexer = createMockCodeIndexer();
    (codeIndexer.search as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });
    orch.setManifest({
      version: 1,
      routes: [],
      files: [
        { path: 'src/pages/Users.tsx', content: 'export function UsersPage() { return <UserTable users={data} /> }' },
        { path: 'src/components/UserTable.tsx', content: 'export function UserTable({ users }) { ... }' },
      ],
    });

    const results = orch.searchManifestFiles(['UserTable']);
    expect(results.length).toBe(2);
    expect(results[0].file).toBe('src/components/UserTable.tsx');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && npx vitest run src/__tests__/orchestrator.test.ts`
Expected: FAIL — `orch.setManifest is not a function`

- [ ] **Step 3: Add manifest types and methods to orchestrator**

In `packages/agent/src/services/orchestrator.ts`, add interfaces after the existing interfaces:

```typescript
export interface ManifestRoute {
  path: string;
  method: string;
  label?: string;
  component?: string;
  parentPath?: string;
}

export interface ManifestFile {
  path: string;
  content: string;
}

export interface Manifest {
  version: number;
  routes: ManifestRoute[];
  files: ManifestFile[];
}
```

Add to the Orchestrator class:

```typescript
  private manifest: Manifest | null = null;

  setManifest(manifest: Manifest): void {
    this.manifest = manifest;
  }

  getRouteList(): string {
    return this.buildRouteList();
  }

  searchManifestFiles(terms: string[]): SearchResult[] {
    if (!this.manifest?.files?.length) return [];

    const lowerTerms = terms.map(t => t.toLowerCase());
    const results: SearchResult[] = [];

    for (const file of this.manifest.files) {
      const lowerContent = file.content.toLowerCase();
      const matchCount = lowerTerms.filter(term => lowerContent.includes(term)).length;
      if (matchCount === 0) continue;

      results.push({ file: file.path, content: file.content, matchCount });
    }

    return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, 10);
  }

  private buildRouteList(): string {
    const routesByPath: Map<string, { path: string; method: string; label?: string; parentPath?: string }> = new Map();

    // 1. Code indexer routes (lowest priority)
    for (const r of this.codeIndexer.getRoutes()) {
      routesByPath.set(r.path, { path: r.path, method: r.method });
    }

    // 2. Manifest routes (higher priority, has labels)
    if (this.manifest?.routes) {
      for (const r of this.manifest.routes) {
        routesByPath.set(r.path, { path: r.path, method: r.method, label: r.label, parentPath: r.parentPath });
      }
    }

    if (routesByPath.size === 0) return 'No application routes detected.';

    const lines = Array.from(routesByPath.values())
      .filter(r => r.method === 'GET')
      .map(r => {
        const parentNote = r.parentPath ? ` (under ${r.parentPath})` : '';
        const label = r.label || r.path.split('/').filter(Boolean).pop() || 'Page';
        return `- ${r.path} \u2014 ${label}${parentNote}`;
      });

    return `## Available Application Pages\n${lines.join('\n')}`;
  }
```

- [ ] **Step 4: Update handleNavigationOrGuidance to use buildRouteList**

Replace the existing `handleNavigationOrGuidance` method:

```typescript
  private async *handleNavigationOrGuidance(
    input: AskInput,
    type: string,
    history: ChatMessage[],
  ): AsyncGenerator<SSEEvent> {
    const routeList = this.buildRouteList();

    const answerMessages = buildAnswerMessages({
      question: input.question,
      type: type as QuestionType,
      history,
      pageContext: input.pageContext,
      routeList: routeList !== 'No application routes detected.' ? routeList : undefined,
    });

    for await (const chunk of streamLLM(answerMessages)) {
      yield { type: 'token', content: chunk };
    }
  }
```

- [ ] **Step 5: Update handleDataWithCode to merge manifest file search**

In `handleDataWithCode`, after the code indexer search, add manifest file search:

```typescript
    // Also search manifest files (frontend code from build plugin)
    const manifestResults = this.searchManifestFiles(searchTerms);
    const allCodeResults = [...codeResults, ...manifestResults]
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, 10);
```

Use `allCodeResults` instead of `codeResults` for the rest of the method.

- [ ] **Step 6: Run tests**

Run: `cd packages/agent && npx vitest run src/__tests__/orchestrator.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/agent/src/services/orchestrator.ts packages/agent/src/__tests__/orchestrator.test.ts
git commit -m "feat(npm): add manifest support to orchestrator"
```

---

### Task 6: NPM Middleware + Prompt Route Injection

**Files:**
- Modify: `packages/agent/src/middleware.ts`
- Modify: `packages/agent/src/prompts/classify.ts`
- Modify: `packages/agent/src/prompts/answer.ts`
- Modify: `packages/agent/src/__tests__/middleware.test.ts`
- Modify: `packages/agent/src/__tests__/prompts/classify.test.ts`
- Modify: `packages/agent/src/__tests__/prompts/answer.test.ts`

- [ ] **Step 1: Add POST /api/manifest endpoint to middleware**

In `packages/agent/src/middleware.ts`, after the `/api/ask` route handler, add:

```typescript
  router.post('/api/manifest', async (req, res) => {
    if (!requireAuth(req, res)) return;
    try {
      await ensureInit();
      const { manifest } = req.body;
      if (!manifest || !manifest.routes) {
        res.status(400).json({ error: 'manifest with routes is required' });
        return;
      }
      orchestrator.setManifest(manifest);
      res.json({ status: 'received', routeCount: manifest.routes.length });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process manifest' });
      }
    }
  });
```

- [ ] **Step 2: Update classify prompt to accept routeList**

In `packages/agent/src/prompts/classify.ts`, update `ClassifyInput`:

```typescript
export interface ClassifyInput {
  question: string;
  schemaSummary: string;
  pageContext?: string;
  history?: ChatMessage[];
  routeList?: string;
}
```

In `buildClassifyMessages`, after the pageContext line, add:

```typescript
  if (input.routeList) {
    userContent += `\n\n${input.routeList}`;
  }
```

- [ ] **Step 3: Update answer prompt to accept routeList**

In `packages/agent/src/prompts/answer.ts`, update `AnswerInput`:

```typescript
export interface AnswerInput {
  question: string;
  type: QuestionType;
  history: ChatMessage[];
  sqlResult?: Record<string, unknown>[];
  sqlQuery?: string;
  codeSnippets?: CodeSnippet[];
  pageContext?: string;
  navigationLinks?: string[];
  routeList?: string;
}
```

In `buildAnswerMessages`, after the navigationLinks block, add:

```typescript
  if (input.routeList && (input.type === 'navigation' || input.type === 'guidance')) {
    userContent += `\n\n${input.routeList}`;
  }
```

- [ ] **Step 4: Update orchestrator to pass routeList to classify**

In the orchestrator's `handleQuestion`, update the classify call:

```typescript
    const routeList = this.buildRouteList();
    const classifyMessages = buildClassifyMessages({
      question: input.question,
      schemaSummary,
      pageContext: input.pageContext,
      history,
      routeList: routeList !== 'No application routes detected.' ? routeList : undefined,
    });
```

- [ ] **Step 5: Write tests for middleware manifest endpoint**

Add to `packages/agent/src/__tests__/middleware.test.ts`:

```typescript
describe('POST /api/manifest', () => {
  it('accepts a valid manifest', async () => {
    const res = await request(app).post('/chatbot/api/manifest').send({
      manifest: {
        version: 1,
        routes: [{ path: '/users', method: 'GET', label: 'Users' }],
        files: [],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('received');
    expect(res.body.routeCount).toBe(1);
  });

  it('rejects missing manifest', async () => {
    const res = await request(app).post('/chatbot/api/manifest').send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: Write tests for prompt route injection**

Add to `packages/agent/src/__tests__/prompts/classify.test.ts`:

```typescript
it('includes routeList in user content when provided', () => {
  const messages = buildClassifyMessages({
    question: 'where are the settings?',
    schemaSummary: 'TABLE users (id INT)',
    routeList: '## Available Application Pages\n- /settings — Settings',
  });
  const userContent = messages[1].content as string;
  expect(userContent).toContain('Available Application Pages');
  expect(userContent).toContain('/settings');
});

it('omits routeList when not provided', () => {
  const messages = buildClassifyMessages({
    question: 'how many users?',
    schemaSummary: 'TABLE users (id INT)',
  });
  const userContent = messages[1].content as string;
  expect(userContent).not.toContain('Available Application Pages');
});
```

Add to `packages/agent/src/__tests__/prompts/answer.test.ts`:

```typescript
it('includes routeList for navigation type', () => {
  const messages = buildAnswerMessages({
    question: 'where is settings?',
    type: 'navigation',
    history: [],
    routeList: '## Available Application Pages\n- /settings — Settings',
  });
  const userContent = messages[1].content as string;
  expect(userContent).toContain('Available Application Pages');
});

it('excludes routeList for data type', () => {
  const messages = buildAnswerMessages({
    question: 'how many users?',
    type: 'data',
    history: [],
    routeList: '## Available Application Pages\n- /users — Users',
  });
  const userContent = messages[1].content as string;
  expect(userContent).not.toContain('Available Application Pages');
});
```

- [ ] **Step 7: Run full npm test suite**

Run: `cd packages/agent && npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/agent/src/middleware.ts packages/agent/src/prompts/classify.ts packages/agent/src/prompts/answer.ts packages/agent/src/services/orchestrator.ts packages/agent/src/__tests__/middleware.test.ts packages/agent/src/__tests__/prompts/classify.test.ts packages/agent/src/__tests__/prompts/answer.test.ts
git commit -m "feat(npm): add manifest endpoint and route injection into prompts"
```

---

## Phase 3: Widget — Manifest Fetch + Send (Task 7)

### Task 7: Widget Manifest Integration

**Files:**
- Modify: `packages/agent/widget-src/ChatWidget.tsx`

- [ ] **Step 1: Add manifest fetch on mount**

In `ChatWidget.tsx`, add state/ref for manifest tracking after the existing state declarations (~line 117):

```tsx
  const manifestRef = useRef<any>(null)
  const manifestSentRef = useRef(false)
```

Add useEffect to fetch manifest on mount:

```tsx
  useEffect(() => {
    // Try to fetch build-time manifest from the frontend's own origin
    fetch(`${window.location.origin}/chatbot-manifest.json`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(manifest => {
        if (manifest) {
          manifestRef.current = manifest
          // Send manifest to backend once
          fetch(`${baseUrl}/api/manifest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ manifest }),
          }).then(() => {
            manifestSentRef.current = true
          }).catch(() => {
            // Silent failure — manifest is a nice-to-have
          })
        }
      })
  }, [baseUrl])
```

- [ ] **Step 2: Build widget**

Run: `cd packages/agent && npm run build:widget`
Expected: widget.js built successfully to packages/agent/widget/

- [ ] **Step 3: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/agent/widget-src/ChatWidget.tsx
git commit -m "feat(widget): fetch and send manifest to backend on mount"
```

---

## Phase 4: NPM Manifest Plugin Package (Tasks 8-14)

### Task 8: Package Scaffold + Types

**Files:**
- Create: `packages/manifest/package.json`
- Create: `packages/manifest/tsconfig.json`
- Create: `packages/manifest/vitest.config.ts`
- Create: `packages/manifest/src/types.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "sql-chatbot-manifest",
  "version": "1.0.0",
  "description": "Build-time manifest plugin for sql-chatbot — scans frontend routes and code for the chatbot to understand your app's navigation and codebase.",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./vite": "./dist/vite-plugin.js",
    "./webpack": "./dist/webpack-plugin.js"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/bhumit4220/sql-chatbot.git",
    "directory": "packages/manifest"
  },
  "keywords": [
    "sql-chatbot",
    "vite-plugin",
    "webpack-plugin",
    "route-manifest",
    "chatbot"
  ],
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0",
    "vite": "^6.0.0"
  },
  "peerDependencies": {
    "vite": ">=4.0.0",
    "webpack": ">=5.0.0"
  },
  "peerDependenciesMeta": {
    "vite": { "optional": true },
    "webpack": { "optional": true }
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 4: Create types.ts**

```typescript
// src/types.ts

export interface ManifestRoute {
  path: string;
  method: string;
  label: string;
  component?: string;
  parentPath?: string;
}

export interface ManifestFile {
  path: string;
  content: string;
}

export interface Manifest {
  version: number;
  generatedAt: string;
  framework: string;
  routes: ManifestRoute[];
  files: ManifestFile[];
}

export interface PluginOptions {
  /** Where to write the manifest. Default: 'public/chatbot-manifest.json' */
  output?: string;
  /** Framework hint. Auto-detected from package.json if not specified. */
  framework?: 'react-router' | 'vue-router' | 'next-pages' | 'next-app' | 'nuxt' | 'sveltekit';
  /** Extra glob patterns for source files to scan. */
  include?: string[];
  /** Directories to skip when scanning. Default: node_modules, dist, build, .git, etc. */
  exclude?: string[];
}

export type DetectedFramework = PluginOptions['framework'] | 'unknown';
```

- [ ] **Step 5: Install deps and verify build**

Run: `cd packages/manifest && npm install && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/manifest/package.json packages/manifest/tsconfig.json packages/manifest/vitest.config.ts packages/manifest/src/types.ts
git commit -m "feat(manifest): scaffold package with types"
```

---

### Task 9: File Indexer

**Files:**
- Create: `packages/manifest/src/file-indexer.ts`
- Create: `packages/manifest/src/__tests__/file-indexer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/file-indexer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { indexFiles } from '../file-indexer.js';

describe('indexFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes .ts, .tsx, .js, .jsx files', () => {
    fs.writeFileSync(path.join(tmpDir, 'App.tsx'), 'export default function App() {}');
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), 'export function helper() {}');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), '.app { color: red }');

    const files = indexFiles(tmpDir);
    expect(files.length).toBe(2);
    expect(files.map(f => f.path)).toContain('App.tsx');
    expect(files.map(f => f.path)).toContain('utils.ts');
  });

  it('skips node_modules and dist directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.js'), 'module.exports = {}');
    fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'bundled');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export const x = 1');

    const files = indexFiles(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src.ts');
  });

  it('skips files larger than 100KB', () => {
    fs.writeFileSync(path.join(tmpDir, 'small.ts'), 'export const x = 1');
    fs.writeFileSync(path.join(tmpDir, 'large.ts'), 'x'.repeat(150_000));

    const files = indexFiles(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('small.ts');
  });

  it('caps at maxFiles', () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.ts`), `export const x${i} = ${i}`);
    }

    const files = indexFiles(tmpDir, { maxFiles: 5 });
    expect(files.length).toBe(5);
  });

  it('includes file content', () => {
    fs.writeFileSync(path.join(tmpDir, 'App.tsx'), 'export default function App() { return <div>Hello</div> }');

    const files = indexFiles(tmpDir);
    expect(files[0].content).toContain('export default function App()');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/manifest && npx vitest run src/__tests__/file-indexer.test.ts`
Expected: FAIL — `Cannot find module '../file-indexer.js'`

- [ ] **Step 3: Implement file-indexer.ts**

```typescript
// src/file-indexer.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestFile } from './types.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.svelte-kit', '__pycache__', 'coverage', '.turbo',
]);

const MAX_FILE_SIZE = 100_000; // 100KB
const DEFAULT_MAX_FILES = 2000;

interface IndexOptions {
  maxFiles?: number;
  include?: string[];
  exclude?: string[];
}

export function indexFiles(rootDir: string, options?: IndexOptions): ManifestFile[] {
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const extraExclude = new Set(options?.exclude ?? []);
  const files: ManifestFile[] = [];

  function scan(dir: string): void {
    if (files.length >= maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || extraExclude.has(entry.name)) continue;
        scan(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relativePath = path.relative(rootDir, fullPath);
          files.push({ path: relativePath, content });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  scan(rootDir);
  return files.slice(0, maxFiles);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/manifest && npx vitest run src/__tests__/file-indexer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/manifest/src/file-indexer.ts packages/manifest/src/__tests__/file-indexer.test.ts
git commit -m "feat(manifest): add file indexer for source code scanning"
```

---

### Task 10: Framework Auto-Detection + File-System Router Scanner

**Files:**
- Create: `packages/manifest/src/scanner.ts`
- Create: `packages/manifest/src/frameworks/filesystem.ts`
- Create: `packages/manifest/src/__tests__/scanner.test.ts`
- Create: `packages/manifest/src/__tests__/filesystem.test.ts`

- [ ] **Step 1: Write failing tests for framework detection**

```typescript
// src/__tests__/scanner.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectFramework } from '../scanner.js';

describe('detectFramework', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects react-router from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0' }
    }));
    expect(detectFramework(tmpDir)).toBe('react-router');
  });

  it('detects next-app when app/ directory exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'next': '^14.0.0' }
    }));
    fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'app', 'page.tsx'), 'export default function Home() {}');
    expect(detectFramework(tmpDir)).toBe('next-app');
  });

  it('detects next-pages when pages/ directory exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'next': '^13.0.0' }
    }));
    fs.mkdirSync(path.join(tmpDir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pages', 'index.tsx'), 'export default function Home() {}');
    expect(detectFramework(tmpDir)).toBe('next-pages');
  });

  it('detects vue-router', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'vue-router': '^4.0.0' }
    }));
    expect(detectFramework(tmpDir)).toBe('vue-router');
  });

  it('detects nuxt', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'nuxt': '^3.0.0' }
    }));
    expect(detectFramework(tmpDir)).toBe('nuxt');
  });

  it('detects sveltekit', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      devDependencies: { '@sveltejs/kit': '^2.0.0' }
    }));
    expect(detectFramework(tmpDir)).toBe('sveltekit');
  });

  it('returns unknown when no framework detected', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'lodash': '^4.0.0' }
    }));
    expect(detectFramework(tmpDir)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Write failing tests for filesystem router scanner**

```typescript
// src/__tests__/filesystem.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanNextAppRoutes, scanNextPagesRoutes, scanNuxtRoutes, scanSvelteKitRoutes } from '../frameworks/filesystem.js';

describe('scanNextAppRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-app-'));
    fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects root page', () => {
    fs.writeFileSync(path.join(tmpDir, 'app', 'page.tsx'), 'export default function Home() {}');
    const routes = scanNextAppRoutes(path.join(tmpDir, 'app'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/', label: 'Home' }));
  });

  it('detects nested pages', () => {
    fs.mkdirSync(path.join(tmpDir, 'app', 'admin', 'users'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'app', 'admin', 'users', 'page.tsx'), 'export default function Users() {}');
    const routes = scanNextAppRoutes(path.join(tmpDir, 'app'));
    expect(routes).toContainEqual(expect.objectContaining({
      path: '/admin/users',
      parentPath: '/admin',
    }));
  });

  it('converts [param] to :param', () => {
    fs.mkdirSync(path.join(tmpDir, 'app', 'users', '[id]'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'app', 'users', '[id]', 'page.tsx'), 'export default function User() {}');
    const routes = scanNextAppRoutes(path.join(tmpDir, 'app'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users/:id' }));
  });

  it('skips route groups (parentheses)', () => {
    fs.mkdirSync(path.join(tmpDir, 'app', '(marketing)', 'about'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'app', '(marketing)', 'about', 'page.tsx'), 'export default function About() {}');
    const routes = scanNextAppRoutes(path.join(tmpDir, 'app'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/about' }));
  });
});

describe('scanNextPagesRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-pages-'));
    fs.mkdirSync(path.join(tmpDir, 'pages'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects index page as root', () => {
    fs.writeFileSync(path.join(tmpDir, 'pages', 'index.tsx'), 'export default function Home() {}');
    const routes = scanNextPagesRoutes(path.join(tmpDir, 'pages'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
  });

  it('skips _app and _document', () => {
    fs.writeFileSync(path.join(tmpDir, 'pages', '_app.tsx'), 'export default function App() {}');
    fs.writeFileSync(path.join(tmpDir, 'pages', '_document.tsx'), 'export default function Doc() {}');
    fs.writeFileSync(path.join(tmpDir, 'pages', 'about.tsx'), 'export default function About() {}');
    const routes = scanNextPagesRoutes(path.join(tmpDir, 'pages'));
    expect(routes.length).toBe(1);
    expect(routes[0].path).toBe('/about');
  });

  it('converts [id] to :id', () => {
    fs.mkdirSync(path.join(tmpDir, 'pages', 'users'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pages', 'users', '[id].tsx'), 'export default function User() {}');
    const routes = scanNextPagesRoutes(path.join(tmpDir, 'pages'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users/:id' }));
  });
});

describe('scanNuxtRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuxt-'));
    fs.mkdirSync(path.join(tmpDir, 'pages'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects .vue pages', () => {
    fs.writeFileSync(path.join(tmpDir, 'pages', 'index.vue'), '<template><div>Home</div></template>');
    fs.writeFileSync(path.join(tmpDir, 'pages', 'about.vue'), '<template><div>About</div></template>');
    const routes = scanNuxtRoutes(path.join(tmpDir, 'pages'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/about' }));
  });

  it('converts [id] dynamic segments', () => {
    fs.mkdirSync(path.join(tmpDir, 'pages', 'users'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pages', 'users', '[id].vue'), '<template><div></div></template>');
    const routes = scanNuxtRoutes(path.join(tmpDir, 'pages'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users/:id' }));
  });
});

describe('scanSvelteKitRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'routes'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects +page.svelte files', () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'routes', '+page.svelte'), '<h1>Home</h1>');
    fs.mkdirSync(path.join(tmpDir, 'src', 'routes', 'about'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'routes', 'about', '+page.svelte'), '<h1>About</h1>');
    const routes = scanSvelteKitRoutes(path.join(tmpDir, 'src', 'routes'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/about' }));
  });

  it('converts [param] to :param', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'routes', 'blog', '[slug]'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'routes', 'blog', '[slug]', '+page.svelte'), '<h1>Post</h1>');
    const routes = scanSvelteKitRoutes(path.join(tmpDir, 'src', 'routes'));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/blog/:slug' }));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/manifest && npx vitest run`
Expected: FAIL — modules not found

- [ ] **Step 4: Create stub files for framework scanners (implemented in Tasks 11-12)**

```typescript
// src/frameworks/react-router.ts
import type { ManifestRoute } from '../types.js';

export function scanReactRouterRoutes(_rootDir: string): ManifestRoute[] {
  // Stub — full implementation in Task 11
  return [];
}
```

```typescript
// src/frameworks/vue-router.ts
import type { ManifestRoute } from '../types.js';

export function scanVueRouterRoutes(_rootDir: string): ManifestRoute[] {
  // Stub — full implementation in Task 12
  return [];
}
```

- [ ] **Step 5: Implement scanner.ts (framework detection)**

```typescript
// src/scanner.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DetectedFramework, Manifest, ManifestRoute, PluginOptions } from './types.js';
import { scanNextAppRoutes, scanNextPagesRoutes, scanNuxtRoutes, scanSvelteKitRoutes } from './frameworks/filesystem.js';
import { scanReactRouterRoutes } from './frameworks/react-router.js';
import { scanVueRouterRoutes } from './frameworks/vue-router.js';
import { indexFiles } from './file-indexer.js';

export function detectFramework(rootDir: string): DetectedFramework {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'unknown';

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (allDeps['next']) {
    // Check for app/ vs pages/ directory
    if (fs.existsSync(path.join(rootDir, 'app')) || fs.existsSync(path.join(rootDir, 'src', 'app'))) {
      return 'next-app';
    }
    return 'next-pages';
  }

  if (allDeps['nuxt']) return 'nuxt';
  if (allDeps['@sveltejs/kit']) return 'sveltekit';
  if (allDeps['vue-router']) return 'vue-router';
  if (allDeps['react-router-dom'] || allDeps['react-router']) return 'react-router';

  return 'unknown';
}

export function scanRoutes(rootDir: string, framework: DetectedFramework): ManifestRoute[] {
  switch (framework) {
    case 'next-app': {
      const appDir = fs.existsSync(path.join(rootDir, 'app'))
        ? path.join(rootDir, 'app')
        : path.join(rootDir, 'src', 'app');
      return scanNextAppRoutes(appDir);
    }
    case 'next-pages': {
      const pagesDir = fs.existsSync(path.join(rootDir, 'pages'))
        ? path.join(rootDir, 'pages')
        : path.join(rootDir, 'src', 'pages');
      return scanNextPagesRoutes(pagesDir);
    }
    case 'nuxt': {
      const pagesDir = path.join(rootDir, 'pages');
      return scanNuxtRoutes(pagesDir);
    }
    case 'sveltekit': {
      const routesDir = path.join(rootDir, 'src', 'routes');
      return scanSvelteKitRoutes(routesDir);
    }
    case 'react-router':
      return scanReactRouterRoutes(rootDir);
    case 'vue-router':
      return scanVueRouterRoutes(rootDir);
    default:
      return [];
  }
}

export function buildManifest(rootDir: string, options?: PluginOptions): Manifest {
  const framework = options?.framework ?? detectFramework(rootDir);
  const routes = scanRoutes(rootDir, framework);
  const files = indexFiles(rootDir, {
    maxFiles: 2000,
    exclude: options?.exclude,
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    framework,
    routes,
    files,
  };
}
```

- [ ] **Step 6: Implement filesystem.ts**

```typescript
// src/frameworks/filesystem.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestRoute } from '../types.js';

function deriveLabel(filePath: string): string {
  const name = path.basename(filePath, path.extname(filePath));
  if (name === 'page' || name === '+page' || name === 'index') {
    // Use parent directory name
    const parent = path.basename(path.dirname(filePath));
    if (parent === 'app' || parent === 'pages' || parent === 'routes') return 'Home';
    return humanize(parent);
  }
  return humanize(name);
}

function humanize(name: string): string {
  return name
    .replace(/[\[\]()]/g, '') // Remove brackets/parens
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function segmentToParam(segment: string): string {
  // [id] -> :id, [...slug] -> :slug*, [param] -> :param
  if (segment.startsWith('[') && segment.endsWith(']')) {
    const inner = segment.slice(1, -1);
    if (inner.startsWith('...')) return `:${inner.slice(3)}*`;
    return `:${inner}`;
  }
  return segment;
}

function deriveParent(routePath: string): string | undefined {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length <= 1) return undefined;
  const parent = '/' + segments.slice(0, -1).join('/');
  return parent;
}

// --- Next.js App Router ---

export function scanNextAppRoutes(appDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];
  if (!fs.existsSync(appDir)) return routes;

  function scan(dir: string, routeSegments: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && /^page\.(tsx?|jsx?)$/.test(entry.name)) {
        const filteredSegments = routeSegments.filter(s => !s.startsWith('('));
        const routePath = '/' + filteredSegments.map(segmentToParam).join('/');
        const normalizedPath = routePath === '/' ? '/' : routePath;

        routes.push({
          path: normalizedPath,
          method: 'GET',
          label: deriveLabel(fullPath),
          component: path.relative(path.dirname(appDir), fullPath),
          parentPath: deriveParent(normalizedPath),
        });
      }

      if (entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'node_modules') {
        scan(fullPath, [...routeSegments, entry.name]);
      }
    }
  }

  scan(appDir, []);
  return routes;
}

// --- Next.js Pages Router ---

const NEXT_SPECIAL_FILES = new Set(['_app', '_document', '_error', '404', '500']);

export function scanNextPagesRoutes(pagesDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];
  if (!fs.existsSync(pagesDir)) return routes;

  function scan(dir: string, routeSegments: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!['.tsx', '.ts', '.jsx', '.js'].includes(ext)) continue;

        const baseName = path.basename(entry.name, ext);
        if (NEXT_SPECIAL_FILES.has(baseName)) continue;
        if (baseName.startsWith('_')) continue;

        const segments = baseName === 'index'
          ? routeSegments
          : [...routeSegments, baseName];

        const routePath = '/' + segments.map(segmentToParam).join('/');

        routes.push({
          path: routePath || '/',
          method: 'GET',
          label: deriveLabel(fullPath),
          component: path.relative(path.dirname(pagesDir), fullPath),
          parentPath: deriveParent(routePath || '/'),
        });
      }

      if (entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'api' && entry.name !== 'node_modules') {
        scan(fullPath, [...routeSegments, entry.name]);
      }
    }
  }

  scan(pagesDir, []);
  return routes;
}

// --- Nuxt Pages ---

export function scanNuxtRoutes(pagesDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];
  if (!fs.existsSync(pagesDir)) return routes;

  function scan(dir: string, routeSegments: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.vue')) {
        const baseName = path.basename(entry.name, '.vue');
        const segments = baseName === 'index'
          ? routeSegments
          : [...routeSegments, baseName];

        const routePath = '/' + segments.map(segmentToParam).join('/');

        routes.push({
          path: routePath || '/',
          method: 'GET',
          label: deriveLabel(fullPath),
          component: path.relative(path.dirname(pagesDir), fullPath),
          parentPath: deriveParent(routePath || '/'),
        });
      }

      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        scan(fullPath, [...routeSegments, entry.name]);
      }
    }
  }

  scan(pagesDir, []);
  return routes;
}

// --- SvelteKit Routes ---

export function scanSvelteKitRoutes(routesDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];
  if (!fs.existsSync(routesDir)) return routes;

  function scan(dir: string, routeSegments: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name === '+page.svelte') {
        const filteredSegments = routeSegments.filter(s => !s.startsWith('('));
        const routePath = '/' + filteredSegments.map(segmentToParam).join('/');

        routes.push({
          path: routePath || '/',
          method: 'GET',
          label: deriveLabel(fullPath),
          component: path.relative(path.dirname(routesDir), fullPath),
          parentPath: deriveParent(routePath || '/'),
        });
      }

      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        scan(fullPath, [...routeSegments, entry.name]);
      }
    }
  }

  scan(routesDir, []);
  return routes;
}
```

- [ ] **Step 7: Run tests**

Run: `cd packages/manifest && npx vitest run src/__tests__/scanner.test.ts src/__tests__/filesystem.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/manifest/src/scanner.ts packages/manifest/src/frameworks/filesystem.ts packages/manifest/src/frameworks/react-router.ts packages/manifest/src/frameworks/vue-router.ts packages/manifest/src/__tests__/scanner.test.ts packages/manifest/src/__tests__/filesystem.test.ts
git commit -m "feat(manifest): add framework detection and filesystem router scanners"
```

---

### Task 11: React Router Scanner (regex-based)

**Files:**
- Create: `packages/manifest/src/frameworks/react-router.ts`
- Create: `packages/manifest/src/__tests__/react-router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/react-router.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanReactRouterRoutes } from '../frameworks/react-router.js';

describe('scanReactRouterRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-router-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0' }
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects JSX <Route path="..."> elements', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id" element={<UserDetail />} />
          </Routes>
        );
      }
    `);

    const routes = scanReactRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users', label: 'Users' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users/:id' }));
  });

  it('detects createBrowserRouter route configs', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'router.tsx'), `
      import { createBrowserRouter } from 'react-router-dom';
      export const router = createBrowserRouter([
        { path: '/', element: <Home /> },
        { path: '/dashboard', element: <Dashboard /> },
        {
          path: '/admin',
          children: [
            { path: 'users', element: <Users /> },
            { path: 'settings', element: <Settings /> },
          ],
        },
      ]);
    `);

    const routes = scanReactRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/dashboard' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/users', parentPath: '/admin' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/settings', parentPath: '/admin' }));
  });

  it('handles nested Route elements', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return (
          <Routes>
            <Route path="/admin">
              <Route path="users" element={<Users />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        );
      }
    `);

    const routes = scanReactRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/settings' }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/manifest && npx vitest run src/__tests__/react-router.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement react-router.ts**

```typescript
// src/frameworks/react-router.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestRoute } from '../types.js';

const ROUTE_FILE_PATTERNS = [
  /import\s+.*from\s+['"]react-router/,
  /createBrowserRouter|createHashRouter|useRoutes/,
  /<Route\s/,
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js']);

export function scanReactRouterRoutes(rootDir: string): ManifestRoute[] {
  const routeFiles = findRouteFiles(rootDir);
  const allRoutes: ManifestRoute[] = [];

  for (const filePath of routeFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(rootDir, filePath);

    // Extract JSX <Route path="..."> patterns
    extractJsxRoutes(content, relativePath, allRoutes);

    // Extract createBrowserRouter/useRoutes config objects
    extractConfigRoutes(content, relativePath, allRoutes);
  }

  // Deduplicate by path
  const seen = new Set<string>();
  return allRoutes.filter(r => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });
}

function findRouteFiles(rootDir: string): string[] {
  const files: string[] = [];

  function scan(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) scan(fullPath);
      } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (ROUTE_FILE_PATTERNS.some(p => p.test(content))) {
            files.push(fullPath);
          }
        } catch { /* skip */ }
      }
    }
  }

  scan(rootDir);
  return files;
}

function extractJsxRoutes(content: string, component: string, routes: ManifestRoute[]): void {
  // Match <Route path="..." with optional nesting
  // First pass: collect all Route elements with their paths
  const routeRegex = /<Route\s+[^>]*path=["']([^"']+)["'][^>]*(?:\/>|>)/g;
  let match: RegExpExecArray | null;

  // Track nesting by finding nested Route patterns
  const nestedPattern = /<Route\s+[^>]*path=["']([^"']+)["'][^>]*>\s*(?:<Route\s+[^>]*path=["']([^"']+)["'])/gs;
  const parentPaths = new Map<string, string>();

  let nestedMatch: RegExpExecArray | null;
  while ((nestedMatch = nestedPattern.exec(content)) !== null) {
    parentPaths.set(nestedMatch[2], nestedMatch[1]);
  }

  while ((match = routeRegex.exec(content)) !== null) {
    const routePath = match[1];
    const parentPath = parentPaths.get(routePath);

    let fullPath: string;
    if (parentPath && !routePath.startsWith('/')) {
      fullPath = parentPath.endsWith('/') ? `${parentPath}${routePath}` : `${parentPath}/${routePath}`;
    } else {
      fullPath = routePath;
    }

    routes.push({
      path: fullPath,
      method: 'GET',
      label: deriveLabel(fullPath),
      component,
      parentPath: deriveParent(fullPath),
    });
  }
}

function extractConfigRoutes(content: string, component: string, routes: ManifestRoute[]): void {
  if (!content.match(/createBrowserRouter|createHashRouter|useRoutes/)) return;

  // Extract path values from route config objects
  // Match { path: '/something' } patterns, handling nesting
  const configPattern = /path:\s*['"]([^'"]+)['"]/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = configPattern.exec(content)) !== null) {
    paths.push(match[1]);
  }

  // Detect parent-child relationships via children: [...]
  // Simple heuristic: track indentation context for nested paths
  const childrenPattern = /path:\s*['"]([^'"]+)['"][^}]*children:\s*\[/gs;
  const parentMap = new Map<string, string>();

  let childMatch: RegExpExecArray | null;
  while ((childMatch = childrenPattern.exec(content)) !== null) {
    const parentPath = childMatch[1];
    // Find child paths within the next section
    const afterParent = content.slice(childMatch.index + childMatch[0].length);
    const childPathPattern = /path:\s*['"]([^'"]+)['"]/g;
    let cp: RegExpExecArray | null;
    // Only look until the closing bracket
    const closingIdx = findClosingBracket(afterParent);
    const childSection = afterParent.slice(0, closingIdx);

    while ((cp = childPathPattern.exec(childSection)) !== null) {
      parentMap.set(cp[1], parentPath);
    }
  }

  for (const routePath of paths) {
    const parent = parentMap.get(routePath);
    let fullPath: string;

    if (parent && !routePath.startsWith('/')) {
      fullPath = parent.endsWith('/') ? `${parent}${routePath}` : `${parent}/${routePath}`;
    } else {
      fullPath = routePath;
    }

    // Avoid duplicates from JSX extraction
    if (!routes.some(r => r.path === fullPath)) {
      routes.push({
        path: fullPath,
        method: 'GET',
        label: deriveLabel(fullPath),
        component,
        parentPath: parent ? (parent.startsWith('/') ? parent : `/${parent}`) : deriveParent(fullPath),
      });
    }
  }
}

function findClosingBracket(str: string): number {
  let depth = 1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '[') depth++;
    if (str[i] === ']') depth--;
    if (depth === 0) return i;
  }
  return str.length;
}

function deriveLabel(routePath: string): string {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length === 0) return 'Home';
  const last = segments[segments.length - 1];
  if (last.startsWith(':')) {
    // Use second-to-last segment + "Detail"
    const prev = segments.length > 1 ? segments[segments.length - 2] : 'Item';
    return humanize(prev).replace(/s$/, '') + ' Detail';
  }
  return humanize(last);
}

function humanize(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function deriveParent(routePath: string): string | undefined {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length <= 1) return undefined;
  return '/' + segments.slice(0, -1).join('/');
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/manifest && npx vitest run src/__tests__/react-router.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/manifest/src/frameworks/react-router.ts packages/manifest/src/__tests__/react-router.test.ts
git commit -m "feat(manifest): add React Router route scanner"
```

---

### Task 12: Vue Router Scanner

**Files:**
- Create: `packages/manifest/src/frameworks/vue-router.ts`
- Create: `packages/manifest/src/__tests__/vue-router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/vue-router.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanVueRouterRoutes } from '../frameworks/vue-router.js';

describe('scanVueRouterRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-router-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects routes from router config file', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'router'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'router', 'index.ts'), `
      import { createRouter, createWebHistory } from 'vue-router';
      const routes = [
        { path: '/', component: () => import('../views/Home.vue') },
        { path: '/about', component: () => import('../views/About.vue') },
        { path: '/users/:id', component: () => import('../views/UserDetail.vue') },
      ];
      export default createRouter({ history: createWebHistory(), routes });
    `);

    const routes = scanVueRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users/:id' }));
  });

  it('detects nested children routes', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'router'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'router', 'index.ts'), `
      import { createRouter } from 'vue-router';
      const routes = [
        {
          path: '/admin',
          children: [
            { path: 'users', component: () => import('../views/Users.vue') },
            { path: 'settings', component: () => import('../views/Settings.vue') },
          ],
        },
      ];
    `);

    const routes = scanVueRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/users', parentPath: '/admin' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/settings', parentPath: '/admin' }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/manifest && npx vitest run src/__tests__/vue-router.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement vue-router.ts**

```typescript
// src/frameworks/vue-router.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestRoute } from '../types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.nuxt', 'coverage']);
const EXTENSIONS = new Set(['.ts', '.js']);

export function scanVueRouterRoutes(rootDir: string): ManifestRoute[] {
  const routerFiles = findRouterFiles(rootDir);
  const allRoutes: ManifestRoute[] = [];

  for (const filePath of routerFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(rootDir, filePath);
    extractRoutes(content, relativePath, allRoutes, '');
  }

  const seen = new Set<string>();
  return allRoutes.filter(r => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });
}

function findRouterFiles(rootDir: string): string[] {
  const files: string[] = [];

  function scan(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) scan(fullPath);
      } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes('createRouter') || content.includes('vue-router')) {
            files.push(fullPath);
          }
        } catch { /* skip */ }
      }
    }
  }

  scan(rootDir);
  return files;
}

function extractRoutes(content: string, component: string, routes: ManifestRoute[], parentPrefix: string): void {
  // Extract top-level path values
  const pathPattern = /path:\s*['"]([^'"]+)['"]/g;
  const childrenPattern = /path:\s*['"]([^'"]+)['"][^}]*children:\s*\[/gs;
  const parentMap = new Map<string, string>();

  let childMatch: RegExpExecArray | null;
  while ((childMatch = childrenPattern.exec(content)) !== null) {
    const parentPath = childMatch[1];
    const afterParent = content.slice(childMatch.index + childMatch[0].length);
    const closingIdx = findClosingBracket(afterParent);
    const childSection = afterParent.slice(0, closingIdx);

    const childPathPattern = /path:\s*['"]([^'"]+)['"]/g;
    let cp: RegExpExecArray | null;
    while ((cp = childPathPattern.exec(childSection)) !== null) {
      parentMap.set(cp[1], parentPath);
    }
  }

  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(content)) !== null) {
    const routePath = match[1];
    const parent = parentMap.get(routePath);

    let fullPath: string;
    if (parent && !routePath.startsWith('/')) {
      fullPath = parent.endsWith('/') ? `${parent}${routePath}` : `${parent}/${routePath}`;
    } else {
      fullPath = routePath;
    }

    routes.push({
      path: fullPath,
      method: 'GET',
      label: deriveLabel(fullPath),
      component,
      parentPath: parent ? (parent.startsWith('/') ? parent : `/${parent}`) : deriveParent(fullPath),
    });
  }
}

function findClosingBracket(str: string): number {
  let depth = 1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '[') depth++;
    if (str[i] === ']') depth--;
    if (depth === 0) return i;
  }
  return str.length;
}

function deriveLabel(routePath: string): string {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length === 0) return 'Home';
  const last = segments[segments.length - 1];
  if (last.startsWith(':')) {
    const prev = segments.length > 1 ? segments[segments.length - 2] : 'Item';
    return humanize(prev).replace(/s$/, '') + ' Detail';
  }
  return humanize(last);
}

function humanize(name: string): string {
  return name.replace(/[-_]/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function deriveParent(routePath: string): string | undefined {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length <= 1) return undefined;
  return '/' + segments.slice(0, -1).join('/');
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/manifest && npx vitest run src/__tests__/vue-router.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/manifest/src/frameworks/vue-router.ts packages/manifest/src/__tests__/vue-router.test.ts
git commit -m "feat(manifest): add Vue Router route scanner"
```

---

### Task 13: Vite Plugin

**Files:**
- Create: `packages/manifest/src/vite-plugin.ts`
- Create: `packages/manifest/src/__tests__/vite-plugin.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/vite-plugin.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sqlChatbotManifest } from '../vite-plugin.js';

describe('sqlChatbotManifest vite plugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-plugin-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0' }
    }));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return <Routes><Route path="/users" element={<div />} /></Routes>;
      }
    `);
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a valid Vite plugin object', () => {
    const plugin = sqlChatbotManifest();
    expect(plugin.name).toBe('sql-chatbot-manifest');
    expect(typeof plugin.buildStart).toBe('function');
  });

  it('generates manifest on buildStart', () => {
    const outputPath = path.join(tmpDir, 'public', 'chatbot-manifest.json');
    const plugin = sqlChatbotManifest({ output: outputPath });

    // Simulate Vite calling buildStart
    (plugin.buildStart as Function).call({ meta: { watchMode: false } });

    expect(fs.existsSync(outputPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(manifest.version).toBe(1);
    expect(manifest.routes).toBeDefined();
    expect(manifest.files).toBeDefined();
  });

  it('uses configResolved to determine root directory', () => {
    const plugin = sqlChatbotManifest();
    // Simulate Vite configResolved
    (plugin.configResolved as Function)({ root: tmpDir });

    const outputPath = path.join(tmpDir, 'public', 'chatbot-manifest.json');
    (plugin.buildStart as Function).call({ meta: { watchMode: false } });

    expect(fs.existsSync(outputPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/manifest && npx vitest run src/__tests__/vite-plugin.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement vite-plugin.ts**

```typescript
// src/vite-plugin.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginOptions } from './types.js';
import { buildManifest } from './scanner.js';

export function sqlChatbotManifest(options?: PluginOptions) {
  let rootDir = process.cwd();
  let outputPath = options?.output ?? '';

  return {
    name: 'sql-chatbot-manifest',

    configResolved(config: { root: string }) {
      rootDir = config.root;
      if (!outputPath) {
        outputPath = path.join(rootDir, 'public', 'chatbot-manifest.json');
      }
    },

    buildStart() {
      if (!outputPath) {
        outputPath = path.join(rootDir, 'public', 'chatbot-manifest.json');
      }
      generateManifest(rootDir, outputPath, options);
    },

    configureServer(server: { watcher: { on: (event: string, cb: (file: string) => void) => void } }) {
      // Watch mode: regenerate manifest when source files change
      server.watcher.on('change', (file: string) => {
        const ext = path.extname(file);
        if (['.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte'].includes(ext)) {
          generateManifest(rootDir, outputPath, options);
        }
      });

      server.watcher.on('add', (file: string) => {
        const ext = path.extname(file);
        if (['.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte'].includes(ext)) {
          generateManifest(rootDir, outputPath, options);
        }
      });
    },
  };
}

function generateManifest(rootDir: string, outputPath: string, options?: PluginOptions): void {
  try {
    const manifest = buildManifest(rootDir, options);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  } catch (err) {
    console.warn('[sql-chatbot-manifest] Failed to generate manifest:', (err as Error).message);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/manifest && npx vitest run src/__tests__/vite-plugin.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/manifest/src/vite-plugin.ts packages/manifest/src/__tests__/vite-plugin.test.ts
git commit -m "feat(manifest): add Vite plugin with watch mode"
```

---

### Task 14: Webpack Plugin + Package Index + Build

**Files:**
- Create: `packages/manifest/src/webpack-plugin.ts`
- Create: `packages/manifest/src/__tests__/webpack-plugin.test.ts`
- Create: `packages/manifest/src/index.ts`

- [ ] **Step 1: Write failing tests for webpack plugin**

```typescript
// src/__tests__/webpack-plugin.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqlChatbotManifestPlugin } from '../webpack-plugin.js';

describe('SqlChatbotManifestPlugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpack-plugin-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0' }
    }));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return <Routes><Route path="/dashboard" element={<div />} /></Routes>;
      }
    `);
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a plugin instance', () => {
    const plugin = new SqlChatbotManifestPlugin({ rootDir: tmpDir });
    expect(plugin).toBeInstanceOf(SqlChatbotManifestPlugin);
  });

  it('has an apply method for webpack', () => {
    const plugin = new SqlChatbotManifestPlugin({ rootDir: tmpDir });
    expect(typeof plugin.apply).toBe('function');
  });

  it('generates manifest when apply is called with a mock compiler', () => {
    const outputPath = path.join(tmpDir, 'public', 'chatbot-manifest.json');
    const plugin = new SqlChatbotManifestPlugin({
      rootDir: tmpDir,
      output: outputPath,
    });

    // Mock webpack compiler
    const tapFn: Function[] = [];
    const mockCompiler = {
      hooks: {
        beforeCompile: { tapAsync: (_name: string, fn: Function) => tapFn.push(fn) },
        watchRun: { tapAsync: (_name: string, _fn: Function) => {} },
      },
      context: tmpDir,
    };

    plugin.apply(mockCompiler as any);

    // Simulate webpack calling the hook
    tapFn[0]({}, () => {});

    expect(fs.existsSync(outputPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(manifest.version).toBe(1);
    expect(manifest.routes.some((r: any) => r.path === '/dashboard')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/manifest && npx vitest run src/__tests__/webpack-plugin.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement webpack-plugin.ts**

```typescript
// src/webpack-plugin.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginOptions } from './types.js';
import { buildManifest } from './scanner.js';

interface WebpackPluginOptions extends PluginOptions {
  rootDir?: string;
}

export class SqlChatbotManifestPlugin {
  private options: WebpackPluginOptions;

  constructor(options?: WebpackPluginOptions) {
    this.options = options ?? {};
  }

  apply(compiler: any): void {
    const rootDir = this.options.rootDir ?? compiler.context ?? process.cwd();
    const outputPath = this.options.output ?? path.join(rootDir, 'public', 'chatbot-manifest.json');

    // Generate on each build
    compiler.hooks.beforeCompile.tapAsync('SqlChatbotManifestPlugin', (_params: any, callback: Function) => {
      this.generate(rootDir, outputPath);
      callback();
    });

    // Also generate on watch re-builds
    compiler.hooks.watchRun.tapAsync('SqlChatbotManifestPlugin', (_compiler: any, callback: Function) => {
      this.generate(rootDir, outputPath);
      callback();
    });
  }

  private generate(rootDir: string, outputPath: string): void {
    try {
      const manifest = buildManifest(rootDir, this.options);
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.warn('[sql-chatbot-manifest] Failed to generate manifest:', (err as Error).message);
    }
  }
}
```

- [ ] **Step 4: Create index.ts (public exports)**

```typescript
// src/index.ts
export { sqlChatbotManifest } from './vite-plugin.js';
export { SqlChatbotManifestPlugin } from './webpack-plugin.js';
export { buildManifest, detectFramework, scanRoutes } from './scanner.js';
export type { Manifest, ManifestRoute, ManifestFile, PluginOptions, DetectedFramework } from './types.js';
```

- [ ] **Step 5: Run all manifest package tests**

Run: `cd packages/manifest && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Build the package**

Run: `cd packages/manifest && npx tsc`
Expected: Compiles without errors

- [ ] **Step 7: Commit**

```bash
cd "Ruby Projects/sql-chatbot"
git add packages/manifest/src/webpack-plugin.ts packages/manifest/src/__tests__/webpack-plugin.test.ts packages/manifest/src/index.ts
git commit -m "feat(manifest): add Webpack plugin and package exports"
```

---

## Phase 5: Integration Testing (Task 15)

### Task 15: E2E Integration Test with 2BNCHILL

**Context:** 2BNCHILL uses React (Vite at localhost:5173) + Rails API (localhost:3000). The manifest plugin should generate routes from the React app and the widget should send them to the Rails backend.

- [ ] **Step 1: Install manifest plugin in 2BNCHILL frontend**

In the 2BNCHILL React app's `vite.config.ts`:

```typescript
import { sqlChatbotManifest } from 'sql-chatbot-manifest/vite';

export default defineConfig({
  plugins: [
    react(),
    sqlChatbotManifest(),
  ],
});
```

- [ ] **Step 2: Run the 2BNCHILL frontend dev server**

Run: `cd /home/sotsys-322/2BNCHILL/2BNCHILL-DEV/admin-panel && npm run dev`
Expected: Dev server starts, `public/chatbot-manifest.json` is generated

- [ ] **Step 3: Verify manifest content**

Read `public/chatbot-manifest.json` and verify:
- Contains routes from the React Router config
- Contains file index of all source files
- Labels are human-readable
- Hierarchy (parentPath) is correct

- [ ] **Step 4: Start Rails API and test widget**

Open browser to `localhost:5173/react-app`
- Widget should load
- Open browser DevTools Network tab
- Widget should POST to `/api/manifest` on load
- Ask a navigation question: "where is the users page?"
- Chatbot should reference routes from the manifest

- [ ] **Step 5: Test on MSP (same-origin Rails monolith)**

Start MSP: `cd /home/sotsys-322/Ruby\ Projects/msp-web-copy && rails s`
- RouteIntrospector should run at boot (check Rails logs)
- Ask navigation question: "how do I get to settings?"
- Chatbot should reference routes from Rails.application.routes

- [ ] **Step 6: Run all test suites to verify no regressions**

```bash
cd "Ruby Projects/sql-chatbot"
cd packages/agent && npx vitest run
cd ../../sql-chatbot-rails && bundle exec rspec
cd ../packages/manifest && npx vitest run
```

Expected: All tests PASS across all 3 packages

- [ ] **Step 7: Commit any integration fixes**

```bash
git add -A
git commit -m "test: E2E integration validation for manifest system"
```
