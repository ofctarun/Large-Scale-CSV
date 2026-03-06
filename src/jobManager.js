const { v4: uuidv4 } = require('uuid');

// In-memory job store
const jobs = new Map();

// Concurrency control
const MAX_CONCURRENT = 5;
let activeWorkers = 0;
const queue = [];

/**
 * Create a new export job
 */
function createJob(options = {}) {
    const exportId = uuidv4();
    const now = new Date().toISOString();

    const job = {
        exportId,
        status: 'pending',
        progress: {
            totalRows: 0,
            processedRows: 0,
            percentage: 0,
        },
        filters: options.filters || {},
        columns: options.columns || null,
        delimiter: options.delimiter || ',',
        quoteChar: options.quoteChar || '"',
        filePath: null,
        error: null,
        createdAt: now,
        completedAt: null,
        cancelled: false,
    };

    jobs.set(exportId, job);
    return job;
}

/**
 * Get a job by ID
 */
function getJob(exportId) {
    return jobs.get(exportId) || null;
}

/**
 * Update a job
 */
function updateJob(exportId, updates) {
    const job = jobs.get(exportId);
    if (!job) return null;

    Object.assign(job, updates);
    return job;
}

/**
 * Delete a job
 */
function deleteJob(exportId) {
    return jobs.delete(exportId);
}

/**
 * Enqueue a worker function with concurrency control
 */
function enqueueWorker(workerFn) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            activeWorkers++;
            try {
                const result = await workerFn();
                resolve(result);
            } catch (err) {
                reject(err);
            } finally {
                activeWorkers--;
                // Process next queued worker
                if (queue.length > 0) {
                    const next = queue.shift();
                    next();
                }
            }
        };

        if (activeWorkers < MAX_CONCURRENT) {
            run();
        } else {
            queue.push(run);
        }
    });
}

module.exports = {
    createJob,
    getJob,
    updateJob,
    deleteJob,
    enqueueWorker,
};
