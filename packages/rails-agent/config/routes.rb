ChatbotAgent::Engine.routes.draw do
  post 'ask', to: 'ask#create'
  get  'status', to: 'status#show'
  post 'rediscover', to: 'rediscover#create'
end
