# spec/sql_chatbot/services/route_introspector_spec.rb
# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/services/route_introspector"

RSpec.describe SqlChatbot::Services::RouteIntrospector do
  let(:introspector) { described_class.new }

  describe "#introspect" do
    context "when Rails routes are available" do
      before do
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
        stub_const("Rails", Module.new)
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
        stub_const("Rails", Module.new)
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
        stub_const("Rails", Module.new)
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
        stub_const("Rails", Module.new)
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
      stub_const("Rails", Module.new)
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
