module ChatbotAgent
  module Middleware
    class Cors
      CHROME_EXTENSION_PATTERN = /\Achrome-extension:\/\/[a-z]{32}\z/

      def initialize(app, allowed_origins: [])
        @app = app
        @allowed_origins = allowed_origins
      end

      def call(env)
        origin = env['HTTP_ORIGIN']

        # No origin header = same-origin request, allow through
        return @app.call(env) unless origin

        unless allowed_origin?(origin)
          return [403, { 'Content-Type' => 'application/json' }, ['{"error":"Origin not allowed"}']]
        end

        # Handle preflight
        if env['REQUEST_METHOD'] == 'OPTIONS'
          return preflight_response(origin)
        end

        # Normal request — add CORS headers
        status, headers, body = @app.call(env)
        headers.merge!(cors_headers(origin))
        [status, headers, body]
      end

      private

      def allowed_origin?(origin)
        return true if origin.match?(CHROME_EXTENSION_PATTERN)
        @allowed_origins.include?(origin)
      end

      def cors_headers(origin)
        {
          'Access-Control-Allow-Origin' => origin,
          'Access-Control-Allow-Credentials' => 'true',
          'Vary' => 'Origin',
        }
      end

      def preflight_response(origin)
        headers = cors_headers(origin).merge(
          'Access-Control-Allow-Methods' => 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers' => 'Content-Type, Authorization, X-Requested-With',
          'Access-Control-Max-Age' => '86400',
        )
        [204, headers, []]
      end
    end
  end
end
