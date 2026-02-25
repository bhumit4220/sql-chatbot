require 'spec_helper'
require 'tmpdir'
require 'chatbot_agent/discovery/model_parser'

RSpec.describe ChatbotAgent::Discovery::ModelParser do
  describe '.parse' do
    context 'belongs_to associations' do
      it 'extracts simple belongs_to' do
        code = "class Job < ApplicationRecord\n  belongs_to :customer\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to include(
          { type: :belongs_to, name: 'customer', options: {} }
        )
      end

      it 'extracts belongs_to with foreign_key option' do
        code = "class Job < ApplicationRecord\n  belongs_to :customer, foreign_key: :created_by\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to include(
          { type: :belongs_to, name: 'customer', options: { foreign_key: 'created_by' } }
        )
      end

      it 'extracts belongs_to with class_name option' do
        code = "class Job < ApplicationRecord\n  belongs_to :creator, class_name: 'Customer', foreign_key: :created_by\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to include(
          { type: :belongs_to, name: 'creator', options: { class_name: 'Customer', foreign_key: 'created_by' } }
        )
      end

      it 'extracts belongs_to with optional: true' do
        code = "class Job < ApplicationRecord\n  belongs_to :contractor, optional: true\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to include(
          { type: :belongs_to, name: 'contractor', options: { optional: 'true' } }
        )
      end
    end

    context 'has_many associations' do
      it 'extracts simple has_many' do
        code = "class Customer < ApplicationRecord\n  has_many :jobs\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to include(
          { type: :has_many, name: 'jobs', options: {} }
        )
      end

      it 'extracts has_many with dependent option' do
        code = "class Customer < ApplicationRecord\n  has_many :properties, dependent: :destroy\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to include(
          { type: :has_many, name: 'properties', options: { dependent: 'destroy' } }
        )
      end
    end

    context 'has_one associations' do
      it 'extracts has_one' do
        code = "class Customer < ApplicationRecord\n  has_one :wallet\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to include(
          { type: :has_one, name: 'wallet', options: {} }
        )
      end
    end

    context 'enum definitions' do
      it 'extracts hash-style enum' do
        code = <<~RUBY
          class Job < ApplicationRecord
            enum status: { active: 1, inactive: 2, deleted: 3 }
          end
        RUBY
        result = described_class.parse(code)

        expect(result[:enums]).to include(
          { name: 'status', values: { 'active' => '1', 'inactive' => '2', 'deleted' => '3' } }
        )
      end

      it 'extracts enum with suffix option' do
        code = <<~RUBY
          class Job < ApplicationRecord
            enum status: { active: 1, inactive: 2 }, _suffix: true
          end
        RUBY
        result = described_class.parse(code)

        expect(result[:enums]).to include(
          { name: 'status', values: { 'active' => '1', 'inactive' => '2' } }
        )
      end

      it 'extracts enum with string keys' do
        code = <<~RUBY
          class Job < ApplicationRecord
            enum status: { 'Active': 1, 'Inactive': 2 }
          end
        RUBY
        result = described_class.parse(code)

        expect(result[:enums]).to include(
          { name: 'status', values: { 'Active' => '1', 'Inactive' => '2' } }
        )
      end
    end

    context 'default_scope' do
      it 'detects default_scope with where.not' do
        code = "class Job < ApplicationRecord\n  default_scope { where.not(status: 3) }\nend"
        result = described_class.parse(code)

        expect(result[:default_scopes]).to include('where.not(status: 3)')
      end

      it 'detects default_scope with where' do
        code = "class Job < ApplicationRecord\n  default_scope { where(active: true) }\nend"
        result = described_class.parse(code)

        expect(result[:default_scopes]).to include('where(active: true)')
      end

      it 'detects lambda default_scope' do
        code = "class Job < ApplicationRecord\n  default_scope -> { where(deleted: false) }\nend"
        result = described_class.parse(code)

        expect(result[:default_scopes]).to include('where(deleted: false)')
      end
    end

    context 'soft delete detection' do
      it 'detects acts_as_paranoid' do
        code = "class Customer < ApplicationRecord\n  acts_as_paranoid\nend"
        result = described_class.parse(code)

        expect(result[:soft_delete]).to be true
      end

      it 'detects include Paranoia' do
        code = "class Customer < ApplicationRecord\n  include Paranoia\nend"
        result = described_class.parse(code)

        expect(result[:soft_delete]).to be true
      end

      it 'returns false when no soft delete' do
        code = "class Customer < ApplicationRecord\nend"
        result = described_class.parse(code)

        expect(result[:soft_delete]).to be false
      end
    end

    context 'concerns/includes' do
      it 'detects include statements' do
        code = "class Job < ApplicationRecord\n  include MyEnums\n  include Filterable\nend"
        result = described_class.parse(code)

        expect(result[:includes]).to contain_exactly('MyEnums', 'Filterable')
      end
    end

    context 'full model parsing' do
      it 'parses a realistic MSP-style model' do
        code = <<~RUBY
          class Job < ApplicationRecord
            include MyEnums
            acts_as_paranoid

            belongs_to :customer, foreign_key: :created_by
            belongs_to :contractor, optional: true
            belongs_to :property
            has_many :job_images, dependent: :destroy

            enum status: { 'Active': 1, 'Inactive': 2, 'Deleted': 3 }, _suffix: true
            enum service_type: { 'Quoted': 1, 'Bid': 2, 'Houlry': 3 }, _suffix: true

            default_scope { where.not(status: 3) }
          end
        RUBY

        result = described_class.parse(code)

        expect(result[:associations].length).to eq(4)
        expect(result[:enums].length).to eq(2)
        expect(result[:default_scopes].length).to eq(1)
        expect(result[:soft_delete]).to be true
        expect(result[:includes]).to include('MyEnums')
      end
    end

    context 'empty or minimal models' do
      it 'returns empty structures for empty model' do
        code = "class Empty < ApplicationRecord\nend"
        result = described_class.parse(code)

        expect(result[:associations]).to be_empty
        expect(result[:enums]).to be_empty
        expect(result[:default_scopes]).to be_empty
        expect(result[:soft_delete]).to be false
        expect(result[:includes]).to be_empty
      end
    end
  end

  describe '.parse_directory' do
    it 'parses all .rb files in a directory' do
      dir = Dir.mktmpdir
      File.write(File.join(dir, 'job.rb'), <<~RUBY)
        class Job < ApplicationRecord
          belongs_to :customer
          enum status: { active: 1, inactive: 2 }
        end
      RUBY
      File.write(File.join(dir, 'customer.rb'), <<~RUBY)
        class Customer < ApplicationRecord
          has_many :jobs
        end
      RUBY

      results = described_class.parse_directory(dir)

      expect(results.keys).to contain_exactly('job', 'customer')
      expect(results['job'][:associations].length).to eq(1)
      expect(results['job'][:enums].length).to eq(1)
      expect(results['customer'][:associations].length).to eq(1)
    ensure
      FileUtils.remove_entry(dir)
    end

    it 'handles nested directories' do
      dir = Dir.mktmpdir
      FileUtils.mkdir_p(File.join(dir, 'concerns'))
      File.write(File.join(dir, 'job.rb'), "class Job < ApplicationRecord\nend")
      File.write(File.join(dir, 'concerns', 'my_enums.rb'), "module MyEnums\nend")

      results = described_class.parse_directory(dir)

      expect(results.keys).to include('job', 'concerns/my_enums')
    ensure
      FileUtils.remove_entry(dir)
    end
  end
end
