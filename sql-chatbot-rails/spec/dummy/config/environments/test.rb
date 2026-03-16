# frozen_string_literal: true

Rails.application.configure do
  config.cache_classes = true
  config.eager_load = false
  config.active_support.deprecation = :stderr
  config.consider_all_requests_local = true
end
