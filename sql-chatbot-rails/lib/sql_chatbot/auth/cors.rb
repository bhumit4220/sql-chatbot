# frozen_string_literal: true

module SqlChatbot
  module Auth
    module Cors
      ALLOWED_METHODS = "GET, POST, OPTIONS"
      ALLOWED_HEADERS = "Authorization, Content-Type"
      MAX_AGE = "86400"

      def self.origin_allowed?(origin, allowed_origins)
        return false if origin.nil?

        if allowed_origins.is_a?(Array) && allowed_origins.any?
          return allowed_origins.include?(origin)
        end

        # No allowlist: allow localhost in development/test only
        if Rails.env.development? || Rails.env.test?
          return origin.match?(/\Ahttps?:\/\/localhost(:\d+)?\z/)
        end

        false
      end

      def self.set_headers(response, origin)
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = ALLOWED_METHODS
        response.headers["Access-Control-Allow-Headers"] = ALLOWED_HEADERS
        response.headers["Access-Control-Max-Age"] = MAX_AGE
        existing_vary = response.headers["Vary"]
        response.headers["Vary"] = existing_vary ? "#{existing_vary}, Origin" : "Origin"
      end
    end
  end
end
