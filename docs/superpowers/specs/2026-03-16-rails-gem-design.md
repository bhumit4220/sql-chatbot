# SQL Chatbot Rails Gem — Design Spec

## Problem

The current `sql-chatbot-agent` npm package requires a separate Node.js process, separate port, and reverse proxy configuration. This makes it impractical for non-Node.js projects and adds DevOps overhead. We want to install it as a native package inside the project — like any other gem — with zero server-level configuration.

## Solution

Build a Ruby gem (`sql-chatbot-rails`) that embeds the chatbot directly into a Rails application as a Rails Engine. Same port, same process, no external dependencies beyond the gem itself.

## Customer Experience

### Installation

```ruby
# Gemfile
gem 'sql-chatbot-rails'
```

```bash
bundle install
rails generate sql_chatbot:install
```

The generator creates:
- `config/initializers/sql_chatbot.rb` — configuration file

### Configuration

```ruby
# config/initializers/sql_chatbot.rb
SqlChatbot.configure do |c|
  c.llm_api_key = ENV['OPENAI_API_KEY']
  c.llm_provider = 'openai'           # openai, openrouter, groq, ollama
  c.llm_model = 'gpt-4o-mini'         # optional, has defaults per provider
  c.llm_base_url = nil                 # optional, override provider's default URL
  c.secret = ENV['CHATBOT_SECRET']     # optional, enables auth
  c.code_paths = ['./app', './lib']    # optional, defaults to ['./app']
end
```

### Mounting

```ruby
# config/routes.rb
mount SqlChatbot::Engine, at: '/chatbot'
```

### Frontend

```erb
<!-- In any layout/view -->
<script src="/chatbot/widget.js"></script>
```

Done. No separate port, no PM2, no Apache/Nginx config.

## Architecture

### Rails Engine

The gem is a Rails Engine that provides:

| Route | Method | Purpose |
|-------|--------|---------|
| `/widget.js` | GET | Serves the chat widget JS bundle + sets auth cookie |
| `/api/health` | GET | Health check — tables count, code files count |
| `/api/ask` | POST | Main chat endpoint — SSE streaming |
| `/api/refresh` | POST | Re-discover schema + re-index code |

### API Contract

**POST /api/ask** request body:
```json
{
  "question": "How many users signed up this month?",
  "pageContext": "/admin/users",
  "history": [
    { "role": "user", "content": "previous question" },
    { "role": "assistant", "content": "previous answer" }
  ]
}
```

**SSE event types** (same protocol as Node.js — widget depends on these):
| Event type | Payload | When |
|------------|---------|------|
| `classifying` | `{}` | Starting classification |
| `classified` | `{ questionType, confidence }` | Classification complete |
| `sql` | `{ sql }` | SQL generated |
| `executing` | `{}` | Running SQL query |
| `token` | `{ content }` | Streaming answer token |
| `error` | `{ message }` | Error occurred |
| `done` | `{}` | Response complete |

### Components (mirroring Node.js package)

```
lib/sql_chatbot/
  engine.rb              — Rails Engine setup + routes
  configuration.rb       — Config DSL (configure block)
  llm/
    client.rb            — OpenAI Ruby SDK wrapper (chat, stream)
  prompts/
    classify.rb          — Question classification prompt (7 types + searchTerms)
    generate_sql.rb      — SQL generation prompt (17 rules)
    answer.rb            — Answer generation prompt (type-specific)
  services/
    schema_service.rb    — PostgreSQL introspection + enrichment
    code_indexer.rb       — File scanning, route detection, search
    sql_executor.rb      — SQL validation + execution (read-only)
    orchestrator.rb      — Central pipeline (classify -> SQL -> execute -> answer)
  controllers/
    chatbot_controller.rb — Handles all HTTP endpoints
```

### Key Dependencies

| Gem | Purpose |
|-----|---------|
| `ruby-openai` | OpenAI SDK (supports OpenAI, OpenRouter, Groq, Ollama via base_url) |
| `pg` | PostgreSQL queries (already in most Rails apps) |
| `rails` (>= 6.0) | Engine support |

No other external dependencies. Lightweight.

### Database Connection Strategy

Uses `ActiveRecord::Base.connection` — the host Rails app's existing database connection. No separate `database_url` config needed.

Implications:
- Shares the app's connection pool — no extra connections to manage
- Schema discovery and SQL execution use `connection.execute(sql)` wrapped in read-only transactions
- The `sql_executor` wraps every query in `SET TRANSACTION READ ONLY` to prevent writes even if the SQL validator is bypassed
- For streaming responses, connections are checked out for the duration of the stream — see Puma thread pool considerations below

### LLM Client

Uses the `ruby-openai` gem which supports custom base URLs — same pattern as our Node.js package:

```ruby
client = OpenAI::Client.new(
  access_token: config.llm_api_key,
  uri_base: config.llm_base_url || provider_base_url,
)
```

Provider presets (same as Node.js):
- OpenAI: `https://api.openai.com/v1` / `gpt-4o-mini`
- OpenRouter: `https://openrouter.ai/api/v1` / `openrouter/free`
- Groq: `https://api.groq.com/openai/v1` / `llama-3.3-70b-versatile`
- Ollama: `http://localhost:11434/v1` / `llama3.1:8b` (no API key required, uses dummy token)

**Streaming architecture:** The `ruby-openai` gem uses a callback-based streaming API (`client.chat(stream: proc { |chunk| ... })`), not an iterator. The orchestrator will bridge this using a `Thread` + `Queue` pattern:

```ruby
def stream_llm(messages)
  queue = Queue.new

  Thread.new do
    client.chat(
      parameters: { messages: messages, stream: proc { |chunk| queue.push(chunk) } }
    )
    queue.push(:done)
  end

  Enumerator.new do |yielder|
    loop do
      chunk = queue.pop
      break if chunk == :done
      content = chunk.dig("choices", 0, "delta", "content")
      yielder.yield(content) if content
    end
  end
end
```

This converts the callback into an `Enumerator` that the controller can iterate over.

### Schema Service

Same PostgreSQL introspection queries as Node.js version:
- `information_schema.tables` / `information_schema.columns` for tables + columns
- `pg_constraint` for foreign keys
- Schema enrichment:
  1. Soft delete detection (`deleted_at`, `discarded_at`, etc.)
  2. Polymorphic detection (`*_type` + `*_id` pairs)
  3. Lookup values (small tables < 50 rows)
  4. PG enum introspection (`pg_enum`)
  5. Check constraint enums (`CHECK(col IN (...))`)

Uses `ActiveRecord::Base.connection.execute(sql)` for all queries.

**Sensitive column filtering:** Columns matching patterns like `password`, `secret`, `token`, `api_key`, `private_key`, `credential`, etc. are excluded from the schema summary sent to the LLM. This prevents the chatbot from ever seeing or querying sensitive data. Uses word-boundary matching, same as Node.js version.

### Code Indexer

Same logic as Node.js:
- Recursively scans directories
- Supported extensions: `.rb`, `.py`, `.js`, `.ts`, `.jsx`, `.tsx`, `.erb`, `.vue`, `.php`, `.java`, `.go`, `.cs`, `.ex`, `.exs`, `.svelte`, `.kt`, `.rs`, `.dart`, `.scala`
- Skip dirs: `node_modules`, `.git`, `dist`, `build`, `vendor`, `tmp`, etc.
- Max 2000 files
- Route detection: Rails routes.rb, React Router, Express, Django urls.py, etc.
- Search: keyword matching with context snippets

### Prompts

Exact same prompt text as Node.js version. The prompts are the core IP — they must be identical to ensure consistent behavior across languages.

- **classify.rb**: 7 question types (data, data_with_code, code, navigation, guidance, greeting, unsafe) + searchTerms
- **generate_sql.rb**: 17 SQL generation rules (soft delete, polymorphic, enums, etc.)
- **answer.rb**: Type-specific answer prompts with streaming

### Orchestrator

Same flow as Node.js:
```
Question → Classify → Route by type:
  data/data_with_code → search code → generate SQL → execute → stream answer
  code → search code → stream answer
  navigation/guidance → get routes → stream answer
  greeting → stream answer
  unsafe → reject
```

Returns an `Enumerator` that yields SSE event hashes. The controller iterates and writes each event to the stream.

### SQL Executor — Security

Defense-in-depth, same as Node.js:

**1. SQL validation** — before execution, rejects queries containing:
- DDL keywords: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `EXECUTE`, `COPY`, `INTO`
- Dangerous functions: `pg_read_file`, `pg_read_binary_file`, `dblink`, `pg_terminate_backend`, `lo_import`, `lo_export`, `pg_sleep`, `set_config`, `current_setting`
- Catalog access: `pg_shadow`, `pg_roles`, `pg_authid`, `pg_user`, `information_schema`

**2. Read-only transaction** — every query is wrapped in:
```sql
SET statement_timeout = '10s';
BEGIN;
SET TRANSACTION READ ONLY;
-- user query here --
COMMIT;
```

Note: `statement_timeout` is set before `BEGIN` (session-level setting, ensures it applies even if BEGIN hangs).

**3. Row limit** — appends `LIMIT 500` if no limit is present.

### SSE Streaming

Rails controller streams via `ActionController::Live`:

```ruby
class SqlChatbot::ChatbotController < ActionController::Base
  include ActionController::Live
  skip_before_action :verify_authenticity_token, only: [:ask, :refresh]

  def ask
    return render_unauthorized unless authorized?

    ensure_initialized!

    response.headers['Content-Type'] = 'text/event-stream'
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['Connection'] = 'keep-alive'

    orchestrator.handle_question(question_params).each do |event|
      response.stream.write("data: #{event.to_json}\n\n")
    end
  rescue => e
    if response.stream.closed?
      # Client disconnected, nothing to do
    else
      response.stream.write("data: #{({ type: 'error', message: e.message }).to_json}\n\n")
    end
  ensure
    response.stream.close
  end
end
```

**CSRF:** `skip_before_action :verify_authenticity_token` is required for the POST endpoints because the widget sends requests from JavaScript without Rails CSRF tokens. Auth is handled by the chatbot's own cookie/bearer token system.

### Initialization

**Lazy initialization** — schema discovery and code indexing happen on the first request, not at boot time. This prevents Rails from crashing if the database is temporarily unavailable during startup.

```ruby
def ensure_initialized!
  return if @initialized
  @init_mutex.synchronize do
    return if @initialized
    SqlChatbot.schema_service.discover
    SqlChatbot.code_indexer.index(SqlChatbot.config.code_paths)
    SqlChatbot.orchestrator = Orchestrator.new(...)
    @initialized = true
  end
end
```

If initialization fails, it resets so the next request retries.

### Auth

Same cookie-based auth as Node.js:
- `/widget.js` sets `chatbot_token` cookie with the secret value (`httpOnly: true`, `sameSite: strict`)
- `/api/ask` and `/api/refresh` check the cookie or `Authorization: Bearer` header
- No auth if secret is not configured

### Widget

The same `widget.js` from the Node.js package — bundled as a static asset in the gem. The widget is framework-agnostic; it just calls `/chatbot/api/ask`.

## Puma Thread Pool Considerations

Each SSE streaming response ties up a Puma thread for the duration of the LLM generation (5-30 seconds). With Puma's default 5 threads, 5 concurrent chatbot users would saturate the server.

**Recommendations for the README:**
- Increase Puma threads if using the chatbot: `threads 5, 16`
- The chatbot is for internal admin panels, not public-facing — concurrent usage is typically low
- For high-concurrency scenarios, recommend running the chatbot on a separate Puma process

## Monorepo Support

Works with monorepo (frontend + backend in same Rails app):
```ruby
c.code_paths = ['./app', './lib', './frontend/src']
```

Also works with separate frontend if it's on the same server:
```ruby
c.code_paths = ['./app', '/path/to/frontend/src']
```

## What's NOT in this gem

- CLI mode (not needed — it's embedded)
- NestJS/Express adapters (separate packages)
- Cloud API (everything runs locally)

## Testing Strategy

1. **Unit tests** (RSpec) — for each service (schema, code indexer, orchestrator, prompts, LLM client)
2. **Integration test** — mount engine in a test Rails app, hit endpoints
3. **E2E test** — test with a real Rails project (to be decided)

## Gem Structure

```
sql-chatbot-rails/
  lib/
    sql_chatbot/
      engine.rb
      configuration.rb
      llm/client.rb
      prompts/classify.rb
      prompts/generate_sql.rb
      prompts/answer.rb
      services/schema_service.rb
      services/code_indexer.rb
      services/sql_executor.rb
      services/orchestrator.rb
    sql_chatbot_rails.rb          — main require file
  app/
    controllers/sql_chatbot/chatbot_controller.rb
    assets/javascripts/sql_chatbot/widget.js
  config/
    routes.rb                     — engine routes
  lib/generators/
    sql_chatbot/install_generator.rb
    sql_chatbot/templates/initializer.rb
  spec/                           — RSpec tests
  sql-chatbot-rails.gemspec
  Gemfile
  README.md
```

## Success Criteria

1. `bundle install` + 3 lines of config + mount = working chatbot
2. Same quality of answers as Node.js version (same prompts)
3. SSE streaming works
4. Widget loads and works
5. Auth works (cookie-based)
6. Code indexing works (monorepo and multi-path)
7. Schema enrichment works (all 5 types)
8. Works with Rails 6, 7, and 8
