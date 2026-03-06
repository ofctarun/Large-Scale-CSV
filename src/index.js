require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const routes = require('./routes');

const app = express();
const PORT = process.env.API_PORT || 8080;

// Ensure exports directory exists
const exportDir = process.env.EXPORT_STORAGE_PATH || '/app/exports';
if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
}

// Middleware
app.use(express.json());

// Mount routes
app.use('/', routes);

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`CSV Export Service running on port ${PORT}`);
    console.log(`Export storage path: ${exportDir}`);
});

module.exports = app;
