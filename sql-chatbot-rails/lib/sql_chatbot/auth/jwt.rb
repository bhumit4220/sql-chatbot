# frozen_string_literal: true

require "jwt"

module SqlChatbot
  module Auth
    module Jwt
      class TokenExpired < StandardError; end
      class TokenInvalid < StandardError; end

      ALGORITHM = "HS256"
      DEFAULT_LIFETIME = 900 # 15 minutes

      def self.generate_token(secret:, sub: nil, origin: nil, lifetime_seconds: DEFAULT_LIFETIME)
        now = Time.now.to_i
        payload = {
          "iat" => now,
          "exp" => now + lifetime_seconds
        }
        payload["sub"] = sub if sub
        payload["origin"] = origin if origin
        ::JWT.encode(payload, secret, ALGORITHM)
      end

      def self.verify_token(token:, secret:)
        ::JWT.decode(token, secret, true, algorithm: ALGORITHM).first
      rescue ::JWT::ExpiredSignature
        raise TokenExpired, "Token expired"
      rescue ::JWT::DecodeError
        raise TokenInvalid, "Invalid token"
      end
    end
  end
end
