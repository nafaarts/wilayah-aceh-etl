const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));
app.use(express.json()); // Add body parser support

const GEOJSON_DIR = path.join(__dirname, 'geojson');

// Database configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/wilayah_aceh',
});

// Initialize Database Table
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS m_wilayah_poligon (
                kode_wilayah_kemendagri VARCHAR(255) PRIMARY KEY,
                nama_wilayah_kemendagri VARCHAR(255),
                level INTEGER,
                geometry GEOMETRY(MultiPolygon, 4326),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_wilayah_code ON m_wilayah_poligon(kode_wilayah_kemendagri);
            CREATE INDEX IF NOT EXISTS idx_wilayah_nama ON m_wilayah_poligon(lower(nama_wilayah_kemendagri));
        `);
        console.log("Database initialized successfully.");
    } catch (err) {
        console.error("Error initializing database (might be waiting for DB to start):", err.message);
    }
};

// Try to initialize DB on startup, but don't crash if it fails (allows local dev without DB)
initDB();

// Helper to transform properties
function transformProperties(feature, level) {
    const p = feature.properties;
    let kode = '';
    let nama = '';

    if (level === 1) { // Provinsi
        kode = p.kd_propinsi;
        nama = p.nm_propinsi;
    } else if (level === 2) { // Kabupaten
        kode = `${p.kd_propinsi}.${p.kd_dati2}`;
        nama = p.nm_dati2;
    } else if (level === 3) { // Kecamatan
        // Rule: kd_kecamatan ambil 2 digit belakang
        const kecCode = p.kd_kecamatan.slice(-2);
        kode = `${p.kd_propinsi}.${p.kd_dati2}.${kecCode}`;
        nama = p.nm_kecamatan;
    } else if (level === 4) { // Kelurahan
        // Rule: kd_kecamatan 2 digit belakang, kd_kelurahan tambah 2 di depan
        const kecCode = p.kd_kecamatan.slice(-2);
        const kelCode = `2${p.kd_kelurahan}`; // Assuming raw is 3 digits like '003' -> '2003'
        kode = `${p.kd_propinsi}.${p.kd_dati2}.${kecCode}.${kelCode}`;
        nama = p.nm_kelurahan;
    }

    return { kode, nama };
}

// Check status of data in DB
app.get('/api/db/status', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    try {
        const result = await pool.query(
            `SELECT level, COUNT(*) as count FROM m_wilayah_poligon WHERE kode_wilayah_kemendagri LIKE $1 GROUP BY level`,
            [`${code}%`]
        );

        const stats = {
            provinsi: 0,
            kabupaten: 0,
            kecamatan: 0,
            kelurahan: 0,
            available: result.rows.length > 0,
            fileAvailable: false
        };

        result.rows.forEach(row => {
            if (row.level === 1) stats.provinsi = parseInt(row.count);
            if (row.level === 2) stats.kabupaten = parseInt(row.count);
            if (row.level === 3) stats.kecamatan = parseInt(row.count);
            if (row.level === 4) stats.kelurahan = parseInt(row.count);
        });

        // Check if file exists in GEOJSON_DIR
        if (fs.existsSync(GEOJSON_DIR)) {
            const files = fs.readdirSync(GEOJSON_DIR);
            const hasFile = files.some(file => {
                if (code.length === 2 && file.match(new RegExp(`^${code}_[^_]+\.geojson$`))) return true;
                return file.startsWith(code) && file.endsWith('.geojson');
            });
            stats.fileAvailable = hasFile;
        }

        res.json(stats);
    } catch (err) {
        // If DB is not connected, return unavailable
        console.error("DB Error:", err.message);
        res.json({ available: false, error: "Database not connected" });
    }
});

// Search API
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 3) return res.json([]);

    try {
        const result = await pool.query(`
            SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, level
            FROM m_wilayah_poligon
            WHERE lower(nama_wilayah_kemendagri) LIKE $1
            ORDER BY level ASC, nama_wilayah_kemendagri ASC
            LIMIT 10
        `, [`%${query.toLowerCase()}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// Trigger ETL Process
app.post('/api/db/sync', async (req, res) => {
    const code = req.body.code;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    if (!fs.existsSync(GEOJSON_DIR)) {
        return res.status(500).json({ error: 'GEOJSON directory not found' });
    }

    const files = fs.readdirSync(GEOJSON_DIR).filter(file => file.startsWith(code) && file.endsWith('.geojson'));

    if (files.length === 0) {
        return res.status(404).json({ error: 'No source files found' });
    }

    // This is a long running process, but for simplicity we'll just await it
    // In production, use a job queue. Here we keep connection open.

    try {
        let totalProcessed = 0;

        for (const file of files) {
            const filePath = path.join(GEOJSON_DIR, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            let level = 2;
            if (file.endsWith('_kecamatan.geojson')) level = 3;
            else if (file.endsWith('_kelurahan.geojson')) level = 4;
            else if (file === '11_Aceh.geojson' || file.match(/^\d{2}_.+$/)) level = 1; // Provinsi detection

            for (const feature of data.features) {
                const { kode, nama } = transformProperties(feature, level);
                const geometry = JSON.stringify(feature.geometry);

                // Upsert Logic with Simplification
                // Note: ST_SimplifyPreserveTopology(ST_Force2D(ST_GeomFromGeoJSON($4)), 0.0001)
                await pool.query(`
                    INSERT INTO m_wilayah_poligon (kode_wilayah_kemendagri, nama_wilayah_kemendagri, level, geometry, updated_at)
                    VALUES ($1, $2, $3, ST_Multi(ST_SimplifyPreserveTopology(ST_Force2D(ST_GeomFromGeoJSON($4)), 0.0001)), NOW())
                    ON CONFLICT (kode_wilayah_kemendagri) 
                    DO UPDATE SET 
                        nama_wilayah_kemendagri = EXCLUDED.nama_wilayah_kemendagri,
                        geometry = EXCLUDED.geometry,
                        updated_at = NOW();
                `, [kode, nama, level, geometry]);

                totalProcessed++;
            }
        }

        res.json({ success: true, processed: totalProcessed });
    } catch (err) {
        console.error("ETL Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get Data from DB for Map
app.get('/api/db/geojson', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    try {
        const result = {
            provinsi: { data: null },
            kabupaten: { data: null },
            kecamatan: { data: null },
            kelurahan: { data: null }
        };

        const codeLen = code.length;

        // --- FETCH STRATEGY BASED ON CODE LEVEL ---

        // 1. PROVINSI (e.g. "11")
        if (codeLen === 2) {
            // Fetch Provinsi Boundary
            const provRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 1 AND kode_wilayah_kemendagri = $1
            `, [code]);
            if (provRes.rows.length > 0) result.provinsi.data = toFeatureCollection(provRes.rows);

            // Fetch All Kabupaten in Provinsi
            const kabRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 2 AND kode_wilayah_kemendagri LIKE $1
            `, [`${code}.%`]);
            if (kabRes.rows.length > 0) result.kabupaten.data = toFeatureCollection(kabRes.rows);
        }

        // 2. KABUPATEN (e.g. "11.01")
        else if (codeLen === 5) {
            // Fetch Parent Provinsi (Context)
            // const provRes = await pool.query(`SELECT ... WHERE level=1 AND code=$1`, [code.substring(0,2)]);
            // Optional: Skip Prov context to focus on Kab

            // Fetch Target Kabupaten
            const kabRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 2 AND kode_wilayah_kemendagri = $1
            `, [code]);
            if (kabRes.rows.length > 0) result.kabupaten.data = toFeatureCollection(kabRes.rows);

            // Fetch All Kecamatan in Kabupaten
            const kecRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 3 AND kode_wilayah_kemendagri LIKE $1
            `, [`${code}.%`]);
            if (kecRes.rows.length > 0) result.kecamatan.data = toFeatureCollection(kecRes.rows);

            // Fetch All Kelurahan (Might be heavy, limit or skip if needed)
            const kelRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 4 AND kode_wilayah_kemendagri LIKE $1
            `, [`${code}.%`]);
            if (kelRes.rows.length > 0) result.kelurahan.data = toFeatureCollection(kelRes.rows);
        }

        // 3. KECAMATAN (e.g. "11.01.01")
        else if (codeLen === 8) {
            // Fetch Parent Kabupaten (Context)
            const kabRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 2 AND kode_wilayah_kemendagri = $1
            `, [code.substring(0, 5)]);
            if (kabRes.rows.length > 0) result.kabupaten.data = toFeatureCollection(kabRes.rows);

            // Fetch Target Kecamatan
            const kecRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 3 AND kode_wilayah_kemendagri = $1
            `, [code]);
            if (kecRes.rows.length > 0) result.kecamatan.data = toFeatureCollection(kecRes.rows);

            // Fetch All Kelurahan in Kecamatan
            const kelRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 4 AND kode_wilayah_kemendagri LIKE $1
            `, [`${code}.%`]);
            if (kelRes.rows.length > 0) result.kelurahan.data = toFeatureCollection(kelRes.rows);
        }

        // 4. KELURAHAN (e.g. "11.01.01.2001")
        else if (codeLen >= 13) {
            // Fetch Parent Kecamatan (Context)
            const kecRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 3 AND kode_wilayah_kemendagri = $1
            `, [code.substring(0, 8)]);
            if (kecRes.rows.length > 0) result.kecamatan.data = toFeatureCollection(kecRes.rows);

            // Fetch Target Kelurahan
            const kelRes = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                FROM m_wilayah_poligon WHERE level = 4 AND kode_wilayah_kemendagri = $1
            `, [code]);
            if (kelRes.rows.length > 0) result.kelurahan.data = toFeatureCollection(kelRes.rows);
        }

        res.json(result);
    } catch (err) {
        console.error("DB Fetch Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// Helper for GeoJSON response
function toFeatureCollection(rows) {
    return {
        type: "FeatureCollection",
        features: rows.map(row => ({
            type: "Feature",
            properties: { name: row.name, id: row.id },
            geometry: JSON.parse(row.geom)
        }))
    };
}

// Original File-based API (kept for backward compatibility or fallback)
app.get('/api/geojson', (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).json({ error: 'Parameter code is required' });
    }

    try {
        if (!fs.existsSync(GEOJSON_DIR)) {
            return res.status(500).json({ error: 'GEOJSON directory not found' });
        }

        const files = fs.readdirSync(GEOJSON_DIR);
        // Filter files that start with the code and end with .geojson
        const matchedFiles = files.filter(file => {
            if (code.length === 2 && file.match(new RegExp(`^${code}_[^_]+\.geojson$`))) return true; // Match "11_Aceh.geojson"
            return file.startsWith(code) && file.endsWith('.geojson');
        });

        if (matchedFiles.length === 0) {
            return res.status(404).json({ error: 'No data found for this code' });
        }

        const result = {
            provinsi: { data: null, size: 0 },
            kabupaten: { data: null, size: 0 },
            kecamatan: { data: null, size: 0 },
            kelurahan: { data: null, size: 0 }
        };

        matchedFiles.forEach(file => {
            const filePath = path.join(GEOJSON_DIR, file);
            try {
                const fileStats = fs.statSync(filePath);
                const fileSizeInBytes = fileStats.size;
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                if (file.endsWith('_kecamatan.geojson')) {
                    result.kecamatan = { data: data, size: fileSizeInBytes };
                } else if (file.endsWith('_kelurahan.geojson')) {
                    result.kelurahan = { data: data, size: fileSizeInBytes };
                } else if (code.length === 2 && file.match(new RegExp(`^${code}_[^_]+\.geojson$`))) {
                    result.provinsi = { data: data, size: fileSizeInBytes };
                } else {
                    // Assuming the file matching the code but not ending in _kecamatan or _kelurahan is the kabupaten boundary
                    result.kabupaten = { data: data, size: fileSizeInBytes };
                }
            } catch (err) {
                console.error(`Error reading file ${file}:`, err);
            }
        });

        res.json(result);
    } catch (error) {
        console.error('Error reading files:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
