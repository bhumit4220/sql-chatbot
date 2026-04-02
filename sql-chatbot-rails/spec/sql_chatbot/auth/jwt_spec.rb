# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/auth/jwt"

RSpec.describe SqlChatbot::Auth::Jwt do
  let(:secret) { "test-secret-key-at-least-32-chars!!" }

  describe ".generate_token" do
    it "generates a valid JWT string" do
      token = described_class.generate_token(secret: secret)
      expect(token).to be_a(String)
      expect(token.split(".").length).to eq(3)
    end

    it "includes origin in payload when provided" do
      token = described_class.generate_token(secret: secret, origin: "https://example.com")
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["origin"]).to eq("https://example.com")
    end

    it "includes sub in payload when provided" do
      token = described_class.generate_token(secret: secret, sub: "user_123")
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["sub"]).to eq("user_123")
    end

    it "defaults to 900 seconds (15 min) lifetime" do
      token = described_class.generate_token(secret: secret)
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["exp"] - decoded["iat"]).to eq(900)
    end

    it "respects custom lifetime_seconds" do
      token = described_class.generate_token(secret: secret, lifetime_seconds: 60)
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["exp"] - decoded["iat"]).to eq(60)
    end
  end

  describe ".verify_token" do
    it "returns decoded payload for valid token" do
      token = described_class.generate_token(secret: secret)
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded).to be_a(Hash)
      expect(decoded["iat"]).to be_a(Integer)
      expect(decoded["exp"]).to be_a(Integer)
    end

    it "raises TokenExpired for expired token" do
      token = described_class.generate_token(secret: secret, lifetime_seconds: -1)
      expect {
        described_class.verify_token(token: token, secret: secret)
      }.to raise_error(SqlChatbot::Auth::Jwt::TokenExpired)
    end

    it "raises TokenInvalid for wrong secret" do
      token = described_class.generate_token(secret: secret)
      expect {
        described_class.verify_token(token: token, secret: "wrong-secret")
      }.to raise_error(SqlChatbot::Auth::Jwt::TokenInvalid)
    end

    it "raises TokenInvalid for malformed token" do
      expect {
        described_class.verify_token(token: "not-a-jwt", secret: secret)
      }.to raise_error(SqlChatbot::Auth::Jwt::TokenInvalid)
    end
  end
end
