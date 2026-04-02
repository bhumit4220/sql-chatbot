# frozen_string_literal: true

SqlChatbot::Engine.routes.draw do
  get  "widget.js",    to: "chatbot#widget"
  get  "api/health",   to: "chatbot#health"
  post "api/ask",      to: "chatbot#ask"
  post "api/refresh",  to: "chatbot#refresh"
  post "api/session",  to: "chatbot#create_session"
  match "api/*path",   to: "chatbot#preflight", via: :options
end
