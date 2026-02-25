require 'spec_helper'
require 'tmpdir'
require 'fileutils'
require 'chatbot_agent/code/indexer'

RSpec.describe ChatbotAgent::Code::Indexer do
  let(:tmpdir) { Dir.mktmpdir }
  let(:db_path) { File.join(tmpdir, 'test_index.sqlite3') }

  after { FileUtils.remove_entry(tmpdir) }

  def create_file(dir, name, content)
    path = File.join(dir, name)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, content)
  end

  describe '.index_directory' do
    it 'indexes .rb files and stores chunks in SQLite' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'app/models/job.rb', "class Job\n  def call\n    true\n  end\nend")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:files_indexed]).to be >= 1
      expect(result[:chunks_created]).to be >= 1
    end

    it 'indexes multiple file types' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'model.rb', "class Model; end")
      create_file(repo, 'script.py', "def func(): pass")
      create_file(repo, 'app.js', "function run() {}")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:files_indexed]).to eq(3)
    end

    it 'excludes non-indexed extensions' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'image.png', "binary data")
      create_file(repo, 'data.csv', "a,b,c")
      create_file(repo, 'real.rb', "class Real; end")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:files_indexed]).to eq(1)
    end

    it 'excludes paths matching exclusion patterns' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'app/model.rb', "class Model; end")
      create_file(repo, 'node_modules/lib.js', "var x = 1;")
      create_file(repo, '.git/config', "ref")
      create_file(repo, 'vendor/bundle/gem.rb', "module Gem; end")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:files_indexed]).to eq(1)
    end

    it 'skips files containing secret patterns' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'config.rb', "password = 'hunter2'\nclass Config; end")
      create_file(repo, 'safe.rb', "class Safe; end")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:files_indexed]).to eq(1)
    end

    it 'skips files larger than 1MB' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'big.rb', "x" * 1_100_000)
      create_file(repo, 'small.rb', "class Small; end")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:files_indexed]).to eq(1)
    end

    it 'chunks large files at code boundaries' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)

      # Create a file with 200 lines and a class boundary at line 100
      lines = (1..200).map { |i| i == 100 ? "class SecondPart" : "  x = #{i}" }
      create_file(repo, 'big.rb', lines.join("\n"))

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:chunks_created]).to be >= 2
    end

    it 'stores small files as single chunks' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'small.rb', "class Small\n  def call\n    true\n  end\nend")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:chunks_created]).to eq(1)
    end

    it 'clears existing index before re-indexing' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, 'a.rb', "class A; end")

      described_class.index_directory(repo, db_path: db_path)
      create_file(repo, 'b.rb', "class B; end")
      result = described_class.index_directory(repo, db_path: db_path)

      # Should have 2 files, not 3 (no duplicates from first run)
      expect(result[:files_indexed]).to eq(2)
      expect(result[:chunks_created]).to eq(2)
    end

    it 'skips .env files' do
      repo = File.join(tmpdir, 'repo')
      FileUtils.mkdir_p(repo)
      create_file(repo, '.env', "SECRET_KEY=abc")
      create_file(repo, '.env.production', "DB_URL=xxx")
      create_file(repo, 'safe.rb', "class Safe; end")

      result = described_class.index_directory(repo, db_path: db_path)

      expect(result[:files_indexed]).to eq(1)
    end
  end
end
