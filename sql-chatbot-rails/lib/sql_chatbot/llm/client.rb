# frozen_string_literal: true

require "openai"

module SqlChatbot
  module LLM
    class Client
      def initialize(api_key:, base_url:, model:)
        @client = OpenAI::Client.new(access_token: api_key, uri_base: base_url)
        @model = model
      end

      MAX_RETRIES = 3
      RETRY_BASE_DELAY = 2 # seconds

      def call(messages, json_mode: false, temperature: 0.1, model: nil)
        params = {
          model: model || @model,
          messages: messages,
          temperature: temperature,
        }
        params[:response_format] = { type: "json_object" } if json_mode

        with_retry do
          response = @client.chat(parameters: params)
          response.dig("choices", 0, "message", "content") || ""
        end
      end

      def stream(messages, temperature: 0.3, model: nil, &block)
        params = {
          model: model || @model,
          messages: messages,
          temperature: temperature,
          stream: proc do |chunk, _bytesize|
            content = chunk.dig("choices", 0, "delta", "content")
            block.call(content) if content && !content.empty?
          end,
        }

        with_retry do
          @client.chat(parameters: params)
        end
      end

      private

      def with_retry(retries = MAX_RETRIES)
        attempts = 0
        begin
          yield
        rescue Faraday::TooManyRequestsError => e
          attempts += 1
          if attempts <= retries
            delay = RETRY_BASE_DELAY * attempts
            warn "[SqlChatbot] Rate limited (429), retrying in #{delay}s (attempt #{attempts}/#{retries})"
            sleep(delay)
            retry
          end
          raise e
        end
      end

      public

      def stream_enum(messages, **opts)
        queue = Queue.new

        Thread.new do
          stream(messages, **opts) { |chunk| queue.push(chunk) }
          queue.push(:done)
        rescue => e
          queue.push(e)
        end

        Enumerator.new do |yielder|
          loop do
            item = queue.pop
            break if item == :done
            raise item if item.is_a?(Exception)
            yielder.yield(item)
          end
        end
      end
    end
  end
end
