const fs = require('fs');
const path = require('path');
const pool = require('./db');
const Cursor = require('pg-cursor');
const { updateJob } = require('./jobManager');

const FETCH_SIZE = 5000;

/**
 * Format a single value for CSV output
 */
function formatCsvValue(value, quoteChar, delimiter) {
    if (value === null || value === undefined) {
        return '';
    }

    const str = String(value);

    // Quote if the value contains delimiter, quote char, or newline
    if (
        str.includes(delimiter) ||
        str.includes(quoteChar) ||
        str.includes('\n') ||
        str.includes('\r')
    ) {
        const escaped = str.replace(
            new RegExp(quoteChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
            quoteChar + quoteChar
        );
        return quoteChar + escaped + quoteChar;
    }

    return str;
}

/**
 * Format an array of rows into CSV string
 */
function formatRowsToCsv(rows, columns, delimiter, quoteChar) {
    let csv = '';
    for (const row of rows) {
        const values = columns.map((col) =>
            formatCsvValue(row[col], quoteChar, delimiter)
        );
        csv += values.join(delimiter) + '\n';
    }
    return csv;
}

/**
 * Build the SQL query and params based on filters
 */
function buildQuery(filters, columns) {
    const selectedColumns =
        columns && columns.length > 0 ? columns.join(', ') : '*';

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (filters.country_code) {
        conditions.push(`country_code = $${paramIndex++}`);
        params.push(filters.country_code);
    }

    if (filters.subscription_tier) {
        conditions.push(`subscription_tier = $${paramIndex++}`);
        params.push(filters.subscription_tier);
    }

    if (filters.min_ltv !== undefined && filters.min_ltv !== null) {
        conditions.push(`lifetime_value >= $${paramIndex++}`);
        params.push(parseFloat(filters.min_ltv));
    }

    const whereClause =
        conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    return {
        query: `SELECT ${selectedColumns} FROM users${whereClause} ORDER BY id`,
        countQuery: `SELECT COUNT(*) AS total FROM users${whereClause}`,
        params,
    };
}

/**
 * Run the export worker
 */
async function runExport(job) {
    const exportDir = process.env.EXPORT_STORAGE_PATH || '/app/exports';
    const filePath = path.join(exportDir, `export_${job.exportId}.csv`);

    // Ensure export directory exists
    if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
    }

    let client;
    let writeStream;

    try {
        // Update status to processing
        updateJob(job.exportId, { status: 'processing', filePath });

        client = await pool.connect();

        // Get total row count for progress tracking
        const { countQuery, params, query } = buildQuery(
            job.filters,
            job.columns
        );

        const countResult = await client.query(countQuery, params);
        const totalRows = parseInt(countResult.rows[0].total, 10);

        updateJob(job.exportId, {
            progress: {
                totalRows,
                processedRows: 0,
                percentage: 0,
            },
        });

        // If no rows match, create empty file with just headers
        if (totalRows === 0) {
            const allColumns = job.columns || [
                'id',
                'name',
                'email',
                'signup_date',
                'country_code',
                'subscription_tier',
                'lifetime_value',
            ];
            const headerLine =
                allColumns
                    .map((col) => formatCsvValue(col, job.quoteChar, job.delimiter))
                    .join(job.delimiter) + '\n';
            fs.writeFileSync(filePath, headerLine);

            updateJob(job.exportId, {
                status: 'completed',
                completedAt: new Date().toISOString(),
                progress: { totalRows: 0, processedRows: 0, percentage: 100 },
            });
            return;
        }

        // Open write stream
        writeStream = fs.createWriteStream(filePath, { highWaterMark: 64 * 1024 });

        // Write CSV header
        // Determine columns from first cursor fetch or from provided columns
        const allColumns = job.columns || [
            'id',
            'name',
            'email',
            'signup_date',
            'country_code',
            'subscription_tier',
            'lifetime_value',
        ];

        const headerLine =
            allColumns
                .map((col) => formatCsvValue(col, job.quoteChar, job.delimiter))
                .join(job.delimiter) + '\n';

        writeStream.write(headerLine);

        // Use cursor for memory-efficient fetching
        const cursor = client.query(new Cursor(query, params));

        let processedRows = 0;

        // Fetch loop
        while (true) {
            // Check cancellation
            if (job.cancelled) {
                cursor.close(() => { });
                writeStream.end();
                // Cleanup file
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                updateJob(job.exportId, {
                    status: 'cancelled',
                    filePath: null,
                });
                return;
            }

            // Fetch next batch
            const rows = await new Promise((resolve, reject) => {
                cursor.read(FETCH_SIZE, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });

            // No more rows
            if (rows.length === 0) break;

            // Format batch as CSV
            const csvChunk = formatRowsToCsv(
                rows,
                allColumns,
                job.delimiter,
                job.quoteChar
            );

            // Write with backpressure handling
            const canContinue = writeStream.write(csvChunk);

            if (!canContinue) {
                // Wait for drain before continuing
                await new Promise((resolve) => writeStream.once('drain', resolve));
            }

            processedRows += rows.length;
            const percentage =
                totalRows > 0
                    ? Math.min(100, Math.round((processedRows / totalRows) * 100))
                    : 0;

            updateJob(job.exportId, {
                progress: {
                    totalRows,
                    processedRows,
                    percentage,
                },
            });
        }

        // Close cursor
        await new Promise((resolve, reject) => {
            cursor.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // End write stream
        await new Promise((resolve, reject) => {
            writeStream.end(() => resolve());
            writeStream.on('error', reject);
        });

        // Mark completed
        updateJob(job.exportId, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            progress: {
                totalRows,
                processedRows,
                percentage: 100,
            },
        });

        console.log(
            `Export ${job.exportId} completed. ${processedRows} rows exported.`
        );
    } catch (err) {
        console.error(`Export ${job.exportId} failed:`, err.message);

        // Cleanup partial file
        if (writeStream) {
            writeStream.destroy();
        }
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (_) { }
        }

        updateJob(job.exportId, {
            status: 'failed',
            error: err.message,
            filePath: null,
        });
    } finally {
        if (client) {
            client.release();
        }
    }
}

module.exports = { runExport };
