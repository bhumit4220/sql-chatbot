# frozen_string_literal: true

Rails.application.routes.draw do
  mount SqlChatbot::Engine => "/chatbot"
end
