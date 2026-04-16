# sql-chatbot

AI-powered database chatbot for any PostgreSQL web app. Auto-discovers your schema, indexes your codebase, generates SQL, and streams answers through a chat widget.

Works with **any framework** -- Rails, Express, Django, Laravel, Phoenix, Spring Boot, and more. Two packages, one goal: let your users ask questions about your data in plain English.

## Packages

| Package | For | Install |
|---------|-----|---------|
| [**sql-chatbot-agent**](packages/agent/) | Node.js / Express / Standalone CLI | `npm install sql-chatbot-agent` |
| [**sql-chatbot-rails**](sql-chatbot-rails/) | Ruby on Rails (gem) | `gem 'sql-chatbot-rails'` |

## How It Works

1. **Schema Discovery** -- Introspects your PostgreSQL database: tables, columns, types, foreign keys, indexes, soft-delete patterns, enums, and lookup values
2. **Code Indexing** -- Scans your codebase for routes, model-level enums, constants, and business logic
3. **Question Classification** -- Determines if a user question is about data, code, navigation, or something else
4. **SQL Generation** -- Builds safe, read-only SQL with soft-delete filtering, enum translation, and JOIN handling
5. **Streaming Answers** -- Executes the query and streams a natural language answer via SSE

## Quick Start

### Node.js / Any Framework (npm)

```bash
npx sql-chatbot-agent --db postgresql://localhost/mydb --key sk-or-v1-xxx --code ./src
```

Open `http://localhost:3456` -- the chat widget is ready.

### Rails

```ruby
# Gemfile
gem 'sql-chatbot-rails'
```

```bash
bundle install
rails generate sql_chatbot:install
```

Edit `config/initializers/sql_chatbot.rb` with your LLM provider, then visit any page -- the widget loads automatically.

### Express Middleware

```js
import { sqlChatbot } from 'sql-chatbot-agent';

app.use('/chatbot', sqlChatbot({
  databaseUrl: process.env.DATABASE_URL,
  llmApiKey: process.env.OPENAI_API_KEY,
  codePaths: ['./src'],
}));
```

Add `<script src="/chatbot/widget.js"></script>` to your HTML.

## Features

- **Zero config** -- auto-discovers schema, enums, soft deletes, polymorphic associations
- **Multi-provider LLM** -- OpenRouter (free), Groq, Ollama, OpenAI via OpenAI SDK
- **Read-only SQL** -- defense-in-depth: validates queries, blocks mutations, enforces timeouts
- **Schema enrichment** -- detects soft-delete columns, PG enums, check constraint enums, lookup tables, polymorphic types
- **Code-aware** -- surfaces Rails enums, Django choices, TypeORM decorators, framework routes
- **Follow-up context** -- maintains conversation history with SQL for multi-turn queries
- **SQL retry** -- auto-fixes column name errors and retries failed queries
- **Chat widget** -- closed Shadow DOM, works on any page, streams responses
- **Auth** -- optional Bearer token / cookie / JWT authentication
- **Cross-origin** -- JWT-based session tokens for distributed frontend/backend setups

## LLM Providers

| Provider | Type | Default Model | Cost |
|----------|------|---------------|------|
| **OpenRouter** | Cloud | Free models | Free (50 req/day) |
| **Groq** | Cloud | llama-3.3-70b-versatile | Free tier |
| **Ollama** | Local | llama3.1:8b | Free (self-hosted) |
| **OpenAI** | Cloud | gpt-4o-mini | Pay-per-use |

## Repo Structure

```
sql-chatbot/
  packages/agent/       # npm package (Express middleware + CLI)
  sql-chatbot-rails/    # Ruby gem (Rails engine)
  docs/                 # Architecture docs and plans
```

## Documentation

- [npm package README](packages/agent/README.md) -- CLI flags, config, providers, Express middleware API
- [Rails gem README](sql-chatbot-rails/README.md) -- installation, configuration, initializer options

## License

MIT
