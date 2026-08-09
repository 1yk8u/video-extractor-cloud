// Vercel serverless function entry point
// Exports the Express app for Vercel's @vercel/node runtime
const app = require('../server.js');
module.exports = app;
