require 'net/http'
require 'json'
require 'uri'

module ChatbotAgent
  class CloudClient
    class AuthError < StandardError; end
    class ServerError < StandardError; end
    class TimeoutError < StandardError; end

    CONNECT_TIMEOUT = 5
    READ_TIMEOUT = 30

    def initialize(cloud_url: nil, api_key: nil)
      @cloud_url = cloud_url || ChatbotAgent.config.cloud_url
      @api_key = api_key || ChatbotAgent.config.api_key
    end

    def classify(question:, schema_summary:, page_context: nil)
      body = {
        question: question,
        schemaSummary: schema_summary,
      }
      body[:pageContext] = page_context if page_context

      post_json('/api/v1/classify', body)
    end

    def generate_sql(question:, schema:, enums:, discovered_context:, history:, code_context: nil, retry_context: nil)
      body = {
        question: question,
        schema: schema,
        enums: enums,
        discoveredContext: discovered_context,
        history: history,
      }
      body[:codeContext] = code_context if code_context
      if retry_context
        body[:retryWithContext] = {
          originalSql: retry_context[:original_sql],
          rejectionReason: retry_context[:rejection_reason],
        }
      end

      post_json('/api/v1/generate-sql', body)
    end

    def stream_answer(question:, question_type:, history:, sql_result: nil, code_snippets: nil, page_context: nil, &block)
      body = {
        question: question,
        questionType: question_type,
        history: history,
      }
      body[:sqlResult] = sql_result if sql_result
      body[:codeSnippets] = code_snippets if code_snippets
      body[:pageContext] = page_context if page_context

      post_sse('/api/v1/answer', body, &block)
    end

    private

    def post_json(path, body)
      uri = URI("#{@cloud_url}#{path}")
      response = make_request(uri, body)

      case response.code.to_i
      when 200..299
        JSON.parse(response.body)
      when 401
        error_msg = begin
          JSON.parse(response.body)['error']
        rescue
          'Unauthorized'
        end
        raise AuthError, error_msg
      when 400..499
        error_msg = begin
          JSON.parse(response.body)['error']
        rescue
          "Client error: #{response.code}"
        end
        raise StandardError, error_msg
      else
        raise ServerError, "Cloud service error: #{response.code}"
      end
    end

    def post_sse(path, body, &block)
      uri = URI("#{@cloud_url}#{path}")
      response = make_request(uri, body)

      case response.code.to_i
      when 200..299
        parse_sse(response.body, &block)
      when 401
        raise AuthError, 'Unauthorized'
      else
        raise ServerError, "Cloud service error: #{response.code}"
      end
    end

    def make_request(uri, body)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == 'https'
      http.open_timeout = CONNECT_TIMEOUT
      http.read_timeout = READ_TIMEOUT

      request = Net::HTTP::Post.new(uri.path)
      request['Content-Type'] = 'application/json'
      request['Authorization'] = "Bearer #{@api_key}"
      request.body = JSON.generate(body)

      http.request(request)
    rescue Net::OpenTimeout, Net::ReadTimeout => e
      raise TimeoutError, "Cloud service timeout: #{e.message}"
    end

    def parse_sse(body)
      body.each_line do |line|
        line = line.strip
        next if line.empty?
        next unless line.start_with?('data: ')

        data = line.sub('data: ', '')
        break if data == '[DONE]'

        begin
          parsed = JSON.parse(data)
          yield parsed['token'] if parsed['token']
        rescue JSON::ParserError
          # skip malformed SSE events
        end
      end
    end
  end
end
