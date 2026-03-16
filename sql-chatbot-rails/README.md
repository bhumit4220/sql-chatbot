# sql-chatbot-rails

AI chatbot for any Rails app — auto-discovers schema, indexes code, executes SQL, streams answers via chat widget.

## Installation

Add to your Gemfile:

```ruby
gem 'sql-chatbot-rails'
```

Then run:

```bash
bundle install
rails generate sql_chatbot:install
```

See the generated `config/initializers/sql_chatbot.rb` for configuration options.
