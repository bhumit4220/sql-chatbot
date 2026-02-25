module ChatbotAgent
  module Middleware
    class MetaTag
      def initialize(app, mount_path: '/chatbot')
        @app = app
        @mount_path = mount_path
      end

      def call(env)
        status, headers, body = @app.call(env)

        content_type = headers['Content-Type'].to_s
        return [status, headers, body] unless content_type.include?('text/html')

        response_body = ''
        body.each { |part| response_body << part }
        body.close if body.respond_to?(:close)

        tag = %(<meta name="chatbot-agent" content="#{@mount_path}">)

        # Don't duplicate if already present
        unless response_body.include?(tag)
          # Inject before </head> (case-insensitive)
          response_body = response_body.sub(%r{</head>}i, "#{tag}\n</head>")
        end

        headers['Content-Length'] = response_body.bytesize.to_s

        [status, headers, [response_body]]
      end
    end
  end
end
