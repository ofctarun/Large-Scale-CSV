const express = require('express');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { createJob, getJob, updateJob, deleteJob, enqueueWorker } = require('./jobManager');
const { runExport } = require('./exportWorker');

const router = express.Router();

// Valid column names to prevent SQL injection
const VALID_COLUMNS = [
    'id',
    'name',
    'email',
    'signup_date',
    'country_code',
    'subscription_tier',
    'lifetime_value',
];

/**
 * POST /exports/csv - Initiate a CSV export job
 */
router.post('/exports/csv', (req, res) => {
    try {
        // Parse filter parameters
        const filters = {};
        if (req.query.country_code) {
            filters.country_code = req.query.country_code;
        }
        if (req.query.subscription_tier) {
            filters.subscription_tier = req.query.subscription_tier;
        }
        if (req.query.min_ltv !== undefined) {
            filters.min_ltv = parseFloat(req.query.min_ltv);
            if (isNaN(filters.min_ltv)) {
                return res
                    .status(400)
                    .json({ error: 'min_ltv must be a valid number' });
            }
        }

        // Parse column selection
        let columns = null;
        if (req.query.columns) {
            columns = req.query.columns.split(',').map((c) => c.trim());
            // Validate columns
            for (const col of columns) {
                if (!VALID_COLUMNS.includes(col)) {
                    return res
                        .status(400)
                        .json({ error: `Invalid column: ${col}. Valid columns: ${VALID_COLUMNS.join(', ')}` });
                }
            }
        }

        // Parse CSV formatting options
        let delimiter = req.query.delimiter || ',';
        // Handle tab delimiter
        if (delimiter === '\\t') {
            delimiter = '\t';
        }
        const quoteChar = req.query.quoteChar || '"';

        // Create job
        const job = createJob({
            filters,
            columns,
            delimiter,
            quoteChar,
        });

        // Return 202 Accepted immediately (always show 'pending' in response)
        res.status(202).json({
            exportId: job.exportId,
            status: 'pending',
        });

        // Enqueue background worker AFTER response is sent (fire-and-forget)
        process.nextTick(() => {
            enqueueWorker(() => runExport(job)).catch((err) => {
                console.error(`Worker error for export ${job.exportId}:`, err.message);
            });
        });
    } catch (err) {
        console.error('Error initiating export:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /exports/:exportId/status - Check export job status
 */
router.get('/exports/:exportId/status', (req, res) => {
    const job = getJob(req.params.exportId);

    if (!job) {
        return res.status(404).json({ error: 'Export not found' });
    }

    res.json({
        exportId: job.exportId,
        status: job.status,
        progress: {
            totalRows: job.progress.totalRows,
            processedRows: job.progress.processedRows,
            percentage: job.progress.percentage,
        },
        error: job.error,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
    });
});

/**
 * GET /exports/:exportId/download - Download exported CSV file
 */
router.get('/exports/:exportId/download', (req, res) => {
    const job = getJob(req.params.exportId);

    if (!job) {
        return res.status(404).json({ error: 'Export not found' });
    }

    if (job.status !== 'completed') {
        return res.status(425).json({
            error: 'Export is not yet completed',
            status: job.status,
        });
    }

    if (!job.filePath || !fs.existsSync(job.filePath)) {
        return res.status(404).json({ error: 'Export file not found' });
    }

    const stat = fs.statSync(job.filePath);
    const fileSize = stat.size;
    const filename = `export_${job.exportId}.csv`;

    // Check if client supports gzip
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const supportsGzip = acceptEncoding.includes('gzip');

    // Check for Range header (resumable downloads)
    const rangeHeader = req.headers['range'];

    if (rangeHeader && !supportsGzip) {
        // Handle Range request for resumable downloads
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end) {
            res.status(416).set('Content-Range', `bytes */${fileSize}`);
            return res.end();
        }

        const chunkSize = end - start + 1;

        res.status(206);
        res.set({
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
        });

        const readStream = fs.createReadStream(job.filePath, { start, end });
        readStream.pipe(res);
    } else if (supportsGzip) {
        // Gzip compressed response
        res.set({
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Encoding': 'gzip',
            'Transfer-Encoding': 'chunked',
        });

        const readStream = fs.createReadStream(job.filePath);
        const gzipStream = zlib.createGzip();

        readStream.pipe(gzipStream).pipe(res);

        readStream.on('error', (err) => {
            console.error('Read stream error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading export file' });
            }
        });
    } else {
        // Normal download with support for resumable downloads
        res.set({
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Accept-Ranges': 'bytes',
            'Content-Length': fileSize,
        });

        const readStream = fs.createReadStream(job.filePath);
        readStream.pipe(res);

        readStream.on('error', (err) => {
            console.error('Read stream error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading export file' });
            }
        });
    }
});

/**
 * DELETE /exports/:exportId - Cancel an export job
 */
router.delete('/exports/:exportId', (req, res) => {
    const job = getJob(req.params.exportId);

    if (!job) {
        return res.status(404).json({ error: 'Export not found' });
    }

    // If job is still running, signal cancellation
    if (job.status === 'pending' || job.status === 'processing') {
        job.cancelled = true;
        updateJob(job.exportId, { status: 'cancelled' });
    }

    // Clean up file if it exists
    if (job.filePath && fs.existsSync(job.filePath)) {
        try {
            fs.unlinkSync(job.filePath);
        } catch (err) {
            console.error('Error deleting export file:', err.message);
        }
    }

    // Remove job from store
    deleteJob(job.exportId);

    res.status(204).end();
});

/**
 * GET /health - Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

module.exports = router;
