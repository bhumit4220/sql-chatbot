# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/services/code_indexer"
require "tmpdir"
require "fileutils"

RSpec.describe SqlChatbot::Services::CodeIndexer do
  let(:indexer) { described_class.new }
  let(:tmpdir) { Dir.mktmpdir }

  after { FileUtils.rm_rf(tmpdir) }

  describe "SUPPORTED_EXTENSIONS" do
    it "includes all expected extensions from the Node.js reference" do
      expected = %w[.js .ts .jsx .tsx .rb .py .erb .vue .php .java .go .cs .ex .exs .svelte .kt .rs .dart .scala]
      expected.each do |ext|
        expect(described_class::SUPPORTED_EXTENSIONS).to include(ext)
      end
    end
  end

  describe "SKIP_DIRS" do
    it "includes all expected directories from the Node.js reference" do
      expected = %w[node_modules .git dist build vendor tmp __pycache__ .next .svelte-kit .nuxt target bin obj deps _build]
      expected.each do |dir|
        expect(described_class::SKIP_DIRS).to include(dir)
      end
    end
  end

  describe "DEFAULT_MAX_FILES" do
    it "equals 2000" do
      expect(described_class::DEFAULT_MAX_FILES).to eq(2000)
    end
  end

  describe "#index" do
    it "indexes supported files" do
      File.write(File.join(tmpdir, "test.rb"), "class User; end")
      File.write(File.join(tmpdir, "test.txt"), "ignored")
      indexer.index([tmpdir])
      expect(indexer.file_count).to eq(1)
    end

    it "indexes files with various supported extensions" do
      %w[app.js server.ts component.jsx page.tsx model.rb script.py template.erb].each do |name|
        File.write(File.join(tmpdir, name), "content for #{name}")
      end
      indexer.index([tmpdir])
      expect(indexer.file_count).to eq(7)
    end

    it "skips files in SKIP_DIRS" do
      node_dir = File.join(tmpdir, "node_modules")
      FileUtils.mkdir_p(node_dir)
      File.write(File.join(node_dir, "test.js"), "module.exports = {}")
      indexer.index([tmpdir])
      expect(indexer.file_count).to eq(0)
    end

    it "skips files in nested SKIP_DIRS" do
      nested_dir = File.join(tmpdir, "src", "vendor", "lib")
      FileUtils.mkdir_p(nested_dir)
      File.write(File.join(nested_dir, "gem.rb"), "class Gem; end")
      indexer.index([tmpdir])
      expect(indexer.file_count).to eq(0)
    end

    it "indexes files from multiple code paths" do
      dir_a = File.join(tmpdir, "project_a")
      dir_b = File.join(tmpdir, "project_b")
      FileUtils.mkdir_p(dir_a)
      FileUtils.mkdir_p(dir_b)
      File.write(File.join(dir_a, "a.rb"), "class A; end")
      File.write(File.join(dir_b, "b.rb"), "class B; end")
      indexer.index([dir_a, dir_b])
      expect(indexer.file_count).to eq(2)
    end

    it "clears previous index on re-index" do
      File.write(File.join(tmpdir, "test.rb"), "class Test; end")
      indexer.index([tmpdir])
      expect(indexer.file_count).to eq(1)
      indexer.index([])
      expect(indexer.file_count).to eq(0)
    end

    it "respects max_files option" do
      10.times { |i| File.write(File.join(tmpdir, "file#{i}.rb"), "class F#{i}; end") }
      limited_indexer = described_class.new(max_files: 5)
      limited_indexer.index([tmpdir])
      expect(limited_indexer.file_count).to eq(5)
    end

    it "handles unreadable directories gracefully" do
      # Non-existent path should not raise
      expect { indexer.index(["/non/existent/path"]) }.not_to raise_error
      expect(indexer.file_count).to eq(0)
    end

    it "recursively scans subdirectories" do
      sub = File.join(tmpdir, "app", "models")
      FileUtils.mkdir_p(sub)
      File.write(File.join(sub, "user.rb"), "class User; end")
      indexer.index([tmpdir])
      expect(indexer.file_count).to eq(1)
    end
  end

  describe "#search" do
    it "returns matching files with context" do
      File.write(File.join(tmpdir, "user.rb"), "class User\n  def admin?\n    role == 'admin'\n  end\nend")
      indexer.index([tmpdir])
      results = indexer.search(["admin"])
      expect(results.length).to be >= 1
      expect(results.first[:content]).to include("admin")
    end

    it "returns empty for no matches" do
      File.write(File.join(tmpdir, "user.rb"), "class User; end")
      indexer.index([tmpdir])
      results = indexer.search(["nonexistent_term_xyz"])
      expect(results).to be_empty
    end

    it "is case-insensitive" do
      File.write(File.join(tmpdir, "model.rb"), "class Admin; end")
      indexer.index([tmpdir])
      results = indexer.search(["admin"])
      expect(results.length).to eq(1)
      expect(results.first[:content]).to include("Admin")
    end

    it "includes surrounding context lines (+-10 lines)" do
      lines = (0..30).map { |i| "line_#{i}" }
      # Put the match term at line 15
      lines[15] = "MATCH_TARGET_KEYWORD"
      File.write(File.join(tmpdir, "context.rb"), lines.join("\n"))
      indexer.index([tmpdir])
      results = indexer.search(["MATCH_TARGET_KEYWORD"])
      expect(results.length).to eq(1)
      content = results.first[:content]
      # Should include lines 5-25 (+-10 around line 15)
      expect(content).to include("line_5")
      expect(content).to include("line_25")
    end

    it "limits snippet to 50 lines max" do
      lines = (0..100).map { |i| "line_#{i}" }
      # Place matches far apart to generate many context lines
      lines[10] = "KEYWORD_A"
      lines[40] = "KEYWORD_A"
      lines[70] = "KEYWORD_A"
      lines[95] = "KEYWORD_A"
      File.write(File.join(tmpdir, "big.rb"), lines.join("\n"))
      indexer.index([tmpdir])
      results = indexer.search(["KEYWORD_A"])
      snippet_lines = results.first[:content].split("\n")
      expect(snippet_lines.length).to be <= 50
    end

    it "sorts results by match_count descending" do
      File.write(File.join(tmpdir, "one_match.rb"), "alpha something")
      File.write(File.join(tmpdir, "two_matches.rb"), "alpha beta")
      indexer.index([tmpdir])
      results = indexer.search(["alpha", "beta"])
      expect(results.first[:file]).to include("two_matches.rb")
    end

    it "returns at most 10 results" do
      15.times do |i|
        File.write(File.join(tmpdir, "file#{i}.rb"), "keyword content #{i}")
      end
      indexer.index([tmpdir])
      results = indexer.search(["keyword"])
      expect(results.length).to be <= 10
    end

    it "includes match_count in results" do
      File.write(File.join(tmpdir, "model.rb"), "alpha beta gamma")
      indexer.index([tmpdir])
      results = indexer.search(["alpha", "beta", "gamma"])
      expect(results.first[:match_count]).to eq(3)
    end

    it "returns relative file path" do
      sub = File.join(tmpdir, "app", "models")
      FileUtils.mkdir_p(sub)
      File.write(File.join(sub, "user.rb"), "class User; end")
      indexer.index([tmpdir])
      results = indexer.search(["User"])
      expect(results.first[:file]).to eq("app/models/user.rb")
    end
  end

  describe "#get_route_summary" do
    it "returns 'No routes detected.' when no routes found" do
      File.write(File.join(tmpdir, "model.rb"), "class User; end")
      indexer.index([tmpdir])
      expect(indexer.get_route_summary).to eq("No routes detected.")
    end

    context "Rails routes" do
      it "detects resources declarations" do
        routes_content = <<~RUBY
          Rails.application.routes.draw do
            resources :users
            resources :posts
          end
        RUBY
        File.write(File.join(tmpdir, "routes.rb"), routes_content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("Routes detected:")
        expect(summary).to include("/users")
        expect(summary).to include("/posts")
      end

      it "detects get routes" do
        routes_content = <<~RUBY
          Rails.application.routes.draw do
            get '/admin', to: 'admin#index'
          end
        RUBY
        File.write(File.join(tmpdir, "routes.rb"), routes_content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/admin")
      end

      it "detects post routes" do
        routes_content = <<~RUBY
          Rails.application.routes.draw do
            post '/login', to: 'sessions#create'
          end
        RUBY
        File.write(File.join(tmpdir, "routes.rb"), routes_content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("POST")
        expect(summary).to include("/login")
      end

      it "detects root route" do
        routes_content = <<~RUBY
          Rails.application.routes.draw do
            root 'home#index'
          end
        RUBY
        File.write(File.join(tmpdir, "routes.rb"), routes_content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/")
      end

      it "detects put and delete routes" do
        routes_content = <<~RUBY
          Rails.application.routes.draw do
            put '/users/:id', to: 'users#update'
            delete '/users/:id', to: 'users#destroy'
          end
        RUBY
        File.write(File.join(tmpdir, "routes.rb"), routes_content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("PUT")
        expect(summary).to include("DELETE")
      end
    end

    context "Express routes" do
      it "detects app.get/post/put/delete" do
        content = <<~JS
          const express = require('express');
          const app = express();
          app.get('/api/users', (req, res) => {});
          app.post('/api/users', (req, res) => {});
          router.put('/api/users/:id', (req, res) => {});
        JS
        File.write(File.join(tmpdir, "server.js"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/api/users")
        expect(summary).to include("POST")
        expect(summary).to include("PUT")
      end
    end

    context "Django routes" do
      it "detects path() in urls.py" do
        content = <<~PY
          from django.urls import path
          urlpatterns = [
              path('users/', views.user_list),
              path('users/<int:pk>/', views.user_detail),
          ]
        PY
        File.write(File.join(tmpdir, "urls.py"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("/users/")
      end
    end

    context "Laravel routes" do
      it "detects Route::get/post" do
        content = <<~PHP
          <?php
          Route::get('/users', [UserController::class, 'index']);
          Route::post('/users', [UserController::class, 'store']);
          Route::resource('posts', PostController::class);
        PHP
        File.write(File.join(tmpdir, "web.php"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/users")
        expect(summary).to include("POST")
        expect(summary).to include("/posts")
      end
    end

    context "NestJS routes" do
      it "detects @Controller + @Get/@Post decorators" do
        content = <<~TS
          @Controller('users')
          export class UsersController {
            @Get('list')
            findAll() {}

            @Post('create')
            create() {}

            @Delete()
            remove() {}
          }
        TS
        File.write(File.join(tmpdir, "users.controller.ts"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/users/list")
        expect(summary).to include("POST")
        expect(summary).to include("/users/create")
        expect(summary).to include("DELETE")
        expect(summary).to include("/users")
      end
    end

    context "Sinatra routes" do
      it "detects get/post with do blocks" do
        content = <<~RUBY
          get '/hello' do
            "Hello World"
          end

          post '/data' do
            "Created"
          end
        RUBY
        File.write(File.join(tmpdir, "app.rb"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/hello")
        expect(summary).to include("POST")
        expect(summary).to include("/data")
      end

      it "does not detect sinatra-style routes in routes.rb (handled as Rails)" do
        content = <<~RUBY
          get '/hello' do
            "Hello"
          end
        RUBY
        # This is a routes.rb file, so it should be treated as Rails, not Sinatra
        File.write(File.join(tmpdir, "routes.rb"), content)
        indexer.index([tmpdir])
        routes = indexer.get_routes
        # The Rails detector will pick up the get route, but Sinatra should skip routes.rb
        rails_routes = routes.select { |r| r[:file].end_with?("routes.rb") }
        expect(rails_routes).not_to be_empty
      end
    end

    context "FastAPI routes" do
      it "detects @app.get/@router.post decorators" do
        content = <<~PY
          from fastapi import FastAPI
          app = FastAPI()

          @app.get("/items")
          def read_items():
              return []

          @router.post("/items")
          def create_item():
              pass
        PY
        File.write(File.join(tmpdir, "main.py"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/items")
        expect(summary).to include("POST")
      end
    end

    context "Flask routes" do
      it "detects @app.route with methods" do
        content = <<~PY
          from flask import Flask
          app = Flask(__name__)

          @app.route('/users', methods=['GET', 'POST'])
          def users():
              pass

          @app.route('/health')
          def health():
              pass
        PY
        File.write(File.join(tmpdir, "app.py"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("/users")
        expect(summary).to include("/health")
      end
    end

    context "Phoenix routes" do
      it "detects get/post in router.ex" do
        content = <<~EX
          defmodule MyApp.Router do
            use Phoenix.Router

            get "/users", UserController, :index
            post "/users", UserController, :create
          end
        EX
        File.write(File.join(tmpdir, "router.ex"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/users")
        expect(summary).to include("POST")
      end
    end

    context "Spring Boot routes" do
      it "detects @GetMapping/@PostMapping with @RequestMapping prefix" do
        content = <<~JAVA
          @RequestMapping("/api")
          public class UserController {
            @GetMapping("/users")
            public List<User> list() {}

            @PostMapping("/users")
            public User create() {}
          }
        JAVA
        File.write(File.join(tmpdir, "UserController.java"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/api/users")
        expect(summary).to include("POST")
      end
    end

    context "ASP.NET routes" do
      it "detects MapGet/MapPost and attribute routing" do
        content = <<~CS
          app.MapGet("/api/items", () => Results.Ok());
          app.MapPost("/api/items", (Item item) => Results.Created());

          [HttpGet("items/{id}")]
          public ActionResult Get(int id) {}

          [Route("api/[controller]")]
          public class ItemsController {}
        CS
        File.write(File.join(tmpdir, "Program.cs"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/api/items")
        expect(summary).to include("POST")
      end
    end

    context "Go framework routes" do
      it "detects Gin/Echo/Fiber route patterns" do
        content = <<~GO
          func main() {
            r := gin.Default()
            r.GET("/users", getUsers)
            r.POST("/users", createUser)
            e.Delete("/users/:id", deleteUser)
          }
        GO
        File.write(File.join(tmpdir, "main.go"), content)
        indexer.index([tmpdir])
        summary = indexer.get_route_summary
        expect(summary).to include("GET")
        expect(summary).to include("/users")
        expect(summary).to include("POST")
        expect(summary).to include("DELETE")
      end
    end
  end

  describe "#get_routes" do
    it "returns array of route hashes" do
      routes_content = "Rails.application.routes.draw do\n  resources :users\nend"
      File.write(File.join(tmpdir, "routes.rb"), routes_content)
      indexer.index([tmpdir])
      routes = indexer.get_routes
      expect(routes).to be_an(Array)
      expect(routes.first).to include(:method, :path, :file)
    end

    it "returns a copy (not the internal array)" do
      routes_content = "Rails.application.routes.draw do\n  resources :users\nend"
      File.write(File.join(tmpdir, "routes.rb"), routes_content)
      indexer.index([tmpdir])
      routes1 = indexer.get_routes
      routes2 = indexer.get_routes
      expect(routes1).not_to be(routes2)
    end
  end
end
