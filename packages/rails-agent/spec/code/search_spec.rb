require 'spec_helper'
require 'tmpdir'
require 'fileutils'
require 'chatbot_agent/code/indexer'
require 'chatbot_agent/code/search'

RSpec.describe ChatbotAgent::Code::Search do
  let(:tmpdir) { Dir.mktmpdir }
  let(:db_path) { File.join(tmpdir, 'test_index.sqlite3') }

  after { FileUtils.remove_entry(tmpdir) }

  def create_file(dir, name, content)
    path = File.join(dir, name)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, content)
  end

  def setup_indexed_repo
    repo = File.join(tmpdir, 'repo')
    FileUtils.mkdir_p(repo)
    create_file(repo, 'app/models/job.rb', <<~RUBY)
      class Job < ApplicationRecord
        belongs_to :customer, foreign_key: :created_by
        belongs_to :contractor, optional: true
        enum status: { 'Active': 1, 'Inactive': 2, 'Deleted': 3 }, _suffix: true
        enum service_type: { 'Quoted': 1, 'Bid': 2, 'Houlry': 3 }
        default_scope { where.not(status: 3) }
      end
    RUBY
    create_file(repo, 'app/models/customer.rb', <<~RUBY)
      class Customer < ApplicationRecord
        has_many :jobs
        has_many :properties
        enum status: { 'Active': 1, 'Inactive': 2, 'Deleted': 3 }
      end
    RUBY
    create_file(repo, 'app/services/job_services/create_job.rb', <<~RUBY)
      module JobServices
        class CreateJob
          def initialize(customer, params)
            @customer = customer
            @params = params
          end

          def call
            job = Job.new(@params)
            job.created_by = @customer.id
            job.save!
            { success: true, data: job }
          end
        end
      end
    RUBY

    ChatbotAgent::Code::Indexer.index_directory(repo, db_path: db_path)
    repo
  end

  describe '.search' do
    before { setup_indexed_repo }

    it 'finds chunks matching a query' do
      results = described_class.search('enum status', db_path: db_path)

      expect(results).not_to be_empty
      expect(results.first[:content]).to include('status')
    end

    it 'returns results sorted by relevance score' do
      results = described_class.search('enum status', db_path: db_path)

      scores = results.map { |r| r[:score] }
      expect(scores).to eq(scores.sort.reverse)
    end

    it 'respects the limit parameter' do
      results = described_class.search('class', limit: 1, db_path: db_path)

      expect(results.length).to eq(1)
    end

    it 'returns empty array for no matches' do
      results = described_class.search('xyzzy_nonexistent_term', db_path: db_path)

      expect(results).to be_empty
    end

    it 'returns empty array for empty query' do
      results = described_class.search('', db_path: db_path)

      expect(results).to be_empty
    end

    it 'returns results with file, line_start, line_end, content, score' do
      results = described_class.search('job', db_path: db_path)

      result = results.first
      expect(result).to have_key(:file)
      expect(result).to have_key(:line_start)
      expect(result).to have_key(:line_end)
      expect(result).to have_key(:content)
      expect(result).to have_key(:score)
      expect(result[:score]).to be > 0
    end

    it 'ranks more relevant chunks higher' do
      results = described_class.search('enum status', db_path: db_path)

      # The job model has both 'enum' and 'status' more prominently
      top_content = results.first[:content]
      expect(top_content).to include('enum')
      expect(top_content).to include('status')
    end

    it 'handles multi-word queries' do
      results = described_class.search('customer foreign_key created_by', db_path: db_path)

      expect(results).not_to be_empty
      expect(results.first[:content]).to include('created_by')
    end
  end

  describe '.search with empty database' do
    it 'returns empty array when no index exists' do
      # Create empty database
      ChatbotAgent::Code::Indexer.init_database(db_path)

      results = described_class.search('anything', db_path: db_path)

      expect(results).to be_empty
    end
  end
end
