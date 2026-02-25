require 'spec_helper'

RSpec.describe ChatbotAgent::Configuration do
  subject(:config) { described_class.new }

  it 'stores api_key' do
    config.api_key = 'test-key'
    expect(config.api_key).to eq('test-key')
  end

  it 'has default auth_check that returns true' do
    expect(config.auth_check).to be_a(Proc)
    expect(config.auth_check.call(nil)).to be true
  end

  it 'stores optional custom_context with 2000 char limit' do
    config.custom_context = 'x' * 2001
    expect(config.custom_context.length).to eq(2000)
  end

  it 'defaults codebase_path to nil (resolved at runtime to Rails.root)' do
    expect(config.codebase_path).to be_nil
  end

  it 'defaults cloud_url from env or fallback' do
    expect(config.cloud_url).to be_a(String)
    expect(config.cloud_url).not_to be_empty
  end

  it 'allows setting a custom auth_check' do
    custom_check = ->(request) { request == 'admin' }
    config.auth_check = custom_check
    expect(config.auth_check.call('admin')).to be true
    expect(config.auth_check.call('user')).to be false
  end
end

RSpec.describe ChatbotAgent do
  after { ChatbotAgent.configuration = nil }

  it 'supports block-style configuration' do
    ChatbotAgent.configure do |config|
      config.api_key = 'block-key'
      config.cloud_url = 'http://localhost:3100'
    end
    expect(ChatbotAgent.config.api_key).to eq('block-key')
    expect(ChatbotAgent.config.cloud_url).to eq('http://localhost:3100')
  end

  it 'returns a default config when not configured' do
    expect(ChatbotAgent.config).to be_a(ChatbotAgent::Configuration)
    expect(ChatbotAgent.config.api_key).to be_nil
  end
end
