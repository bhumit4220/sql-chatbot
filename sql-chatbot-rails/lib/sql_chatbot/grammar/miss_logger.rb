# frozen_string_literal: true

require "json"
require "fileutils"
require "time"

module SqlChatbot
  module Grammar
    module MissLogger
      def self.log(log_path, entry)
        FileUtils.mkdir_p(File.dirname(log_path))
        line = JSON.generate({ ts: Time.now.utc.iso8601 }.merge(entry)) + "\n"
        File.open(log_path, "a") { |f| f.write(line) }
      end
    end
  end
end
