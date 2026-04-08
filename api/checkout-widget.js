// This file is intentionally empty.
// The checkout widget is served as a static file from /public/checkout-widget.js
// Vercel serves static files from public/ automatically — no serverless function needed.
// If this endpoint is called, redirect to the static file.

module.exports = (req, res) => {
  res.redirect(301, '/checkout-widget.js');
};
