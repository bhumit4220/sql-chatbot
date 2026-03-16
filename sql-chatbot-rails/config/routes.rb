# frozen_string_literal: true

SqlChatbot::Engine.routes.draw do
  get  "widget.js",    to: "chatbot#widget"
  get  "api/health",   to: "chatbot#health"
  post "api/ask",      to: "chatbot#ask"
  post "api/refresh",  to: "chatbot#refresh"
end
