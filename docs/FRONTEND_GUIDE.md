# SQL Chatbot Widget — Frontend Integration Guide

> **For:** Frontend developers who want to add the chat widget to their project.
> **Time:** 2 minutes. One line of HTML.

---

## What You Get

A chat bubble appears in the bottom-right corner of your page. Users can ask questions about the data in plain English — "How many users signed up this month?", "Show me top 10 orders", etc.

---

## Step 1: Add the Script Tag

Add **one line** before the closing `</body>` tag in your main HTML file:

### Cartaman — dev2.spaceo.in

```html
<script src="https://dev2.spaceo.in/sql-chatbot-cartaman-qa/chatbot/widget.js"></script>
```

### English Learning — dev1.spaceo.in

```html
<script src="https://dev1.spaceo.in/sql-chatbot-english-learning-qa/chatbot/widget.js"></script>
```

### Zendy Admin Panel  — dev1.spaceo.in

```html
<script src="https://dev1.spaceo.in/sql-chatbot-zendy-qa/chatbot/widget.js"></script>
```

### Zendy Merchant Panel — dev1.spaceo.in

```html
<script src="https://dev1.spaceo.in/sql-chatbot-zendy-qa/chatbot/widget.js"></script>
```

> Zendy Admin and Merchant panels share the same chatbot — same script tag URL for both.

### Mom Bucks— dev1.spaceo.in

```html
<script src="https://dev1.spaceo.in/sql-chatbot-mombucks-qa/chatbot/widget.js"></script>
```

### Gym App / Cardano - dev1.spaceo.in

```html
<script src="https://dev1.spaceo.in/sql-chatbot-qa/chatbot/widget.js"></script>
```

### Garbago — dev1.spaceo.in

```html
<script src="https://dev1.spaceo.in/sql-chatbot-garbago-qa/chatbot/widget.js"></script>
```

----

## Where to Add It (Framework Examples)

### React (index.html)

```html
<!-- public/index.html -->
<body>
  <div id="root"></div>
  <script src="https://dev1.spaceo.in/sql-chatbot-zendy-qa/chatbot/widget.js"></script>
</body>
```

### Next.js (layout.tsx)

```tsx
// app/layout.tsx
import Script from 'next/script'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script src="https://dev1.spaceo.in/sql-chatbot-zendy-qa/chatbot/widget.js" strategy="afterInteractive" />
      </body>
    </html>
  )
}
```

### Rails (application.html.erb)

```erb
<%# app/views/layouts/application.html.erb %>
  <%= javascript_include_tag "https://dev1.spaceo.in/sql-chatbot-zendy-qa/chatbot/widget.js" %>
</body>
```

### Vue / Nuxt (index.html)

```html
<!-- index.html -->
<body>
  <div id="app"></div>
  <script src="https://dev1.spaceo.in/sql-chatbot-zendy-qa/chatbot/widget.js"></script>
</body>
```

---

