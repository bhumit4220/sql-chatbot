# frozen_string_literal: true

module SqlChatbot
  module Services
    class RouteIntrospector
      INTERNAL_CONTROLLERS = %w[
        active_storage/ action_mailbox/ action_cable/ rails/
        sql_chatbot/
      ].freeze

      ACTION_LABELS = {
        "index"   => nil,
        "show"    => "Detail",
        "new"     => "New",
        "create"  => "Create",
        "edit"    => "Edit",
        "update"  => "Update",
        "destroy" => "Delete",
      }.freeze

      def introspect
        return [] unless defined?(Rails) && Rails.application

        Rails.application.routes.routes.filter_map do |route|
          next if route.internal
          next if internal_controller?(route)

          path = normalize_path(route)
          next if path.nil? || path.empty?

          {
            path: path,
            method: extract_method(route),
            label: derive_label(route),
            parentPath: derive_parent(path),
          }
        end
      end

      def format_route_list
        routes = introspect
        return "No application routes detected." if routes.empty?

        lines = routes.select { |r| r[:method] == "GET" }.map do |r|
          parent_note = r[:parentPath] ? " (under #{r[:parentPath]})" : ""
          "- #{r[:path]} \u2014 #{r[:label]}#{parent_note}"
        end

        "## Available Application Pages\n#{lines.join("\n")}"
      end

      private

      def internal_controller?(route)
        controller = route.defaults[:controller].to_s
        INTERNAL_CONTROLLERS.any? { |prefix| controller.start_with?(prefix) }
      end

      def normalize_path(route)
        path = route.path.spec.to_s
        path = path.sub("(.:format)", "")
        path = path.sub(/\(\..+\)$/, "")
        path = "/" if path.empty?
        path
      end

      def extract_method(route)
        verb = route.verb
        case verb
        when Regexp
          match = verb.source.gsub(/[\^$]/, "")
          match.empty? ? "GET" : match.split("|").first
        when String
          verb.empty? ? "GET" : verb
        else
          "GET"
        end
      end

      def derive_label(route)
        controller = route.defaults[:controller].to_s
        action = route.defaults[:action].to_s
        base_name = controller.split("/").last.to_s
        humanized = base_name.split("_").map(&:capitalize).join(" ")
        singular = singularize(humanized)

        case action
        when "index"
          humanized
        when "show"
          "#{singular} Detail"
        when "new", "create"
          "New #{singular}"
        when "edit", "update"
          "Edit #{singular}"
        when "destroy"
          "Delete #{singular}"
        else
          "#{humanized} #{action.split("_").map(&:capitalize).join(" ")}"
        end
      end

      def derive_parent(path)
        segments = path.split("/").reject(&:empty?)
        return nil if segments.length <= 1
        parent_segments = segments[0...-1]
        parent_segments.pop while parent_segments.last&.start_with?(":")
        return nil if parent_segments.empty?
        "/#{parent_segments.join("/")}"
      end

      def singularize(word)
        if word.end_with?("ies")
          word[0...-3] + "y"
        elsif word.end_with?("ses")
          word[0...-2]
        elsif word.end_with?("s") && !word.end_with?("ss")
          word[0...-1]
        else
          word
        end
      end
    end
  end
end
