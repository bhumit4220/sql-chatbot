# frozen_string_literal: true

require "rails_helper"
require "sql_chatbot/auth/cors"

RSpec.describe SqlChatbot::Auth::Cors do
  describe ".origin_allowed?" do
    it "allows listed origins" do
      expect(described_class.origin_allowed?("https://admin.myapp.com", ["https://admin.myapp.com"])).to be true
    end

    it "rejects unlisted origins" do
      expect(described_class.origin_allowed?("https://evil.com", ["https://admin.myapp.com"])).to be false
    end

    it "allows localhost in development when no allowlist" do
      allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("development"))
      expect(described_class.origin_allowed?("http://localhost:5173", nil)).to be true
    end

    it "allows localhost with port in development" do
      allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("development"))
      expect(described_class.origin_allowed?("http://localhost:3000", nil)).to be true
    end

    it "rejects non-localhost in production when no allowlist" do
      allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("production"))
      expect(described_class.origin_allowed?("https://evil.com", nil)).to be false
    end

    it "returns false when origin is nil" do
      expect(described_class.origin_allowed?(nil, ["https://admin.myapp.com"])).to be false
    end
  end
end
