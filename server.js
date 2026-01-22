const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const pool = require('./lib/postgres'); // Use the new library
const { supabaseAdmin } = require('./lib/supabase'); // Import Supabase Admin
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));
app.use(express.json()); // Add body parser support
app.use(cookieParser()); // Add cookie parser for Supabase SSR

const GEOJSON_DIR = path.join(__dirname, 'geojson');

// Database configuration is now handled in lib/postgres.js

// Initialize Database Table
const initDB = async () => {
    // Skip InitDB for Supabase (User must run init_db.sql manually)
    if (process.env.DB_PROVIDER === 'SUPABASE') {
        console.log("Supabase Provider selected. Skipping auto-init. Please ensure you have run 'init_db.sql' in your Supabase SQL Editor.");
        return;
    }

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

            -- Create Helper Function for Upsert (Useful for Supabase RPC)
            CREATE OR REPLACE FUNCTION upsert_wilayah(
                p_kode TEXT,
                p_nama TEXT,
                p_level INT,
                p_geojson JSONB
            ) RETURNS VOID AS $$
            BEGIN
                INSERT INTO m_wilayah_poligon (kode_wilayah_kemendagri, nama_wilayah_kemendagri, level, geometry, updated_at)
                VALUES (p_kode, p_nama, p_level, ST_Multi(ST_SimplifyPreserveTopology(ST_Force2D(ST_GeomFromGeoJSON(p_geojson)), 0.0001)), NOW())
                ON CONFLICT (kode_wilayah_kemendagri) 
                DO UPDATE SET 
                    nama_wilayah_kemendagri = EXCLUDED.nama_wilayah_kemendagri,
                    geometry = EXCLUDED.geometry,
                    updated_at = NOW();
            END;
            $$ LANGUAGE plpgsql;
        `);
        console.log("Database initialized successfully.");
    } catch (err) {
        console.error("Error initializing database (might be waiting for DB to start):", err.message);
        if (process.env.DB_PROVIDER === 'SUPABASE' && !process.env.DATABASE_URL) {
            console.warn("WARNING: You have selected SUPABASE as provider but DATABASE_URL is missing.");
            console.warn("Please set DATABASE_URL in .env to your Supabase connection string (Transaction Mode/Port 6543 recommended) to initialize the schema.");
        }
    }
};

// Try to initialize DB on startup, but don't crash if it fails (allows local dev without DB)
initDB().then(() => seedInitialData());

// Helper to upsert feature (abstracting provider)
async function upsertFeature(kode, nama, level, geometryObject) {
    if (process.env.DB_PROVIDER === 'SUPABASE') {
        if (!supabaseAdmin) throw new Error("Supabase Admin client is not initialized. Check SUPABASE_URL and SUPABASE_SERVICE_KEY in .env");

        const { error } = await supabaseAdmin.rpc('upsert_wilayah', {
            p_kode: kode,
            p_nama: nama,
            p_level: level,
            p_geojson: geometryObject // Pass object, Supabase handles serialization
        });

        if (error) throw new Error(`Supabase RPC Error: ${error.message}`);
    } else {
        // Default: POSTGRES (Direct Connection)
        const geometryStr = JSON.stringify(geometryObject);
        await pool.query(`
            INSERT INTO m_wilayah_poligon (kode_wilayah_kemendagri, nama_wilayah_kemendagri, level, geometry, updated_at)
            VALUES ($1, $2, $3, ST_Multi(ST_SimplifyPreserveTopology(ST_Force2D(ST_GeomFromGeoJSON($4)), 0.0001)), NOW())
            ON CONFLICT (kode_wilayah_kemendagri) 
            DO UPDATE SET 
                nama_wilayah_kemendagri = EXCLUDED.nama_wilayah_kemendagri,
                geometry = EXCLUDED.geometry,
                updated_at = NOW();
        `, [kode, nama, level, geometryStr]);
    }
}

// Seed Initial Data
const seedInitialData = async () => {
    console.log("Checking for initial data...");
    let exists = false;
    try {
        if (process.env.DB_PROVIDER === 'SUPABASE') {
            if (!supabaseAdmin) {
                console.warn("Supabase Admin not ready, skipping seed check.");
                return;
            }
            // Check if any Provinsi (level 1) exists
            const { count, error } = await supabaseAdmin
                .from('m_wilayah_poligon')
                .select('*', { count: 'exact', head: true })
                .eq('level', 1);

            if (error) {
                // Ignore error if table doesn't exist yet (init_db.sql not run)
                // console.error("Error checking seed status:", error.message);
                return;
            }
            exists = count > 0;
        } else {
            const res = await pool.query('SELECT 1 FROM m_wilayah_poligon WHERE level = 1 LIMIT 1');
            exists = res.rows.length > 0;
        }
    } catch (e) {
        console.error("Error checking initial data:", e.message);
        return;
    }

    if (!exists) {
        console.log("No initial data found. Seeding 11_Aceh.geojson...");
        const filePath = path.join(GEOJSON_DIR, '11_Aceh.geojson');
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                console.log(`Found ${data.features.length} features in 11_Aceh.geojson`);

                let processed = 0;
                for (const feature of data.features) {
                    const { kode, nama } = transformProperties(feature, 1);
                    await upsertFeature(kode, nama, 1, feature.geometry);
                    processed++;
                }
                console.log(`Seeding complete. Inserted ${processed} features.`);
            } catch (e) {
                console.error("Seeding error:", e);
            }
        } else {
            console.warn(`File not found for seeding: ${filePath}`);
        }
    } else {
        console.log("Initial data already exists. Skipping seed.");
    }
};

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
        const stats = {
            provinsi: 0,
            kabupaten: 0,
            kecamatan: 0,
            kelurahan: 0,
            available: false,
            fileAvailable: false
        };

        if (process.env.DB_PROVIDER === 'SUPABASE') {
            if (!supabaseAdmin) throw new Error("Supabase Admin not initialized");

            // Use RPC for counts (efficient) or just assume 0 if function missing
            // We use get_wilayah_counts created in init_db.sql
            // Note: get_wilayah_counts returns global counts. We need to filter by code?
            // The SQL function I wrote earlier was global.
            // Let's rely on client side filtering or improved SQL later.
            // For now, let's use a simple query if function not available.

            const { data, error } = await supabaseAdmin.from('m_wilayah_poligon')
                .select('level, kode_wilayah_kemendagri');
            // Fetching all IDs is heavy but allows accurate counting.
            // Better: Use RPC with filter.

            // Actually, let's use the RPC 'get_wilayah_counts' if available, but it doesn't filter by code.
            // Let's implement a filter logic here.

            // Alternative: Count using multiple queries (slow but works)
            // Or assume if DB is connected, we check availability differently.

            // For this specific requirement "jika data belum ada di database", we need to know if THIS area exists.

            const { count, error: countErr } = await supabaseAdmin
                .from('m_wilayah_poligon')
                .select('*', { count: 'exact', head: true })
                .ilike('kode_wilayah_kemendagri', `${code}%`);

            if (!countErr) {
                stats.available = count > 0;
                // If available, we might want detailed counts per level.
                // We can do this with a second query or RPC.
                // Let's use RPC if possible, but I can't update SQL easily from here.

                // Let's use a simple aggregation if data is small enough or just basic check.
                if (stats.available) {
                    const { data: levels } = await supabaseAdmin
                        .from('m_wilayah_poligon')
                        .select('level')
                        .ilike('kode_wilayah_kemendagri', `${code}%`);

                    if (levels) {
                        levels.forEach(r => {
                            if (r.level === 1) stats.provinsi++;
                            if (r.level === 2) stats.kabupaten++;
                            if (r.level === 3) stats.kecamatan++;
                            if (r.level === 4) stats.kelurahan++;
                        });
                    }
                }
            }

        } else {
            // Postgres Logic
            const result = await pool.query(
                `SELECT level, COUNT(*) as count FROM m_wilayah_poligon WHERE kode_wilayah_kemendagri LIKE $1 GROUP BY level`,
                [`${code}%`]
            );

            result.rows.forEach(row => {
                if (row.level === 1) stats.provinsi = parseInt(row.count);
                if (row.level === 2) stats.kabupaten = parseInt(row.count);
                if (row.level === 3) stats.kecamatan = parseInt(row.count);
                if (row.level === 4) stats.kelurahan = parseInt(row.count);
            });

            stats.available = result.rows.length > 0;
        }

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
        res.json({ available: false, error: "Database error or not connected" });
    }
});

// Search API
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 3) return res.json([]);

    try {
        if (process.env.DB_PROVIDER === 'SUPABASE') {
            // Use RPC 'search_wilayah'
            const { data, error } = await supabaseAdmin.rpc('search_wilayah', { p_query: query });

            if (error) {
                // Fallback: If RPC not exists, try simple select
                console.warn("RPC search_wilayah failed, trying direct select:", error.message);
                const { data: fallbackData, error: fallbackError } = await supabaseAdmin
                    .from('m_wilayah_poligon')
                    .select('kode_wilayah_kemendagri, nama_wilayah_kemendagri, level')
                    .ilike('nama_wilayah_kemendagri', `%${query}%`)
                    .order('level', { ascending: true })
                    .order('nama_wilayah_kemendagri', { ascending: true })
                    .limit(10);

                if (fallbackError) throw new Error(fallbackError.message);

                // Map to expected format
                const mapped = fallbackData.map(d => ({
                    id: d.kode_wilayah_kemendagri,
                    name: d.nama_wilayah_kemendagri,
                    level: d.level
                }));
                return res.json(mapped);
            }

            res.json(data);
        } else {
            const result = await pool.query(`
                SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, level
                FROM m_wilayah_poligon
                WHERE lower(nama_wilayah_kemendagri) LIKE $1
                ORDER BY level ASC, nama_wilayah_kemendagri ASC
                LIMIT 10
            `, [`%${query.toLowerCase()}%`]);
            res.json(result.rows);
        }
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

                // Use Helper Function
                await upsertFeature(kode, nama, level, feature.geometry);

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

        // Helper to fetch data abstracting provider
        const fetchGeoData = async (targetLevel, codePrefix) => {
            console.log(`Fetching GeoData: L${targetLevel}, CodePrefix: ${codePrefix}`);
            if (process.env.DB_PROVIDER === 'SUPABASE') {
                const { data, error } = await supabaseAdmin.rpc('get_wilayah_by_level', {
                    p_level: targetLevel,
                    p_parent_code: codePrefix
                });
                if (error) {
                    console.error(`Supabase RPC Error (L${targetLevel}, ${codePrefix}):`, error.message);
                    return [];
                }
                console.log(`Supabase RPC Success (L${targetLevel}, ${codePrefix}): Found ${data ? data.length : 0} rows`);
                return data;
            } else {
                const res = await pool.query(`
                    SELECT kode_wilayah_kemendagri as id, nama_wilayah_kemendagri as name, ST_AsGeoJSON(geometry) as geom 
                    FROM m_wilayah_poligon 
                    WHERE level = $1 AND kode_wilayah_kemendagri LIKE $2
                `, [targetLevel, `${codePrefix}%`]);
                return res.rows;
            }
        };

        // --- FETCH STRATEGY BASED ON CODE LEVEL ---

        // 1. PROVINSI (e.g. "11")
        if (codeLen === 2) {
            // Fetch Provinsi Boundary
            const provRows = await fetchGeoData(1, code);
            if (provRows.length > 0) result.provinsi.data = toFeatureCollection(provRows);

            // Fetch All Kabupaten in Provinsi
            const kabRows = await fetchGeoData(2, code);
            if (kabRows.length > 0) result.kabupaten.data = toFeatureCollection(kabRows);
        }

        // 2. KABUPATEN (e.g. "11.01")
        else if (codeLen === 5) {
            // Fetch Target Kabupaten
            const kabRows = await fetchGeoData(2, code);
            if (kabRows.length > 0) result.kabupaten.data = toFeatureCollection(kabRows);

            // Fetch All Kecamatan in Kabupaten
            const kecRows = await fetchGeoData(3, code);
            if (kecRows.length > 0) result.kecamatan.data = toFeatureCollection(kecRows);

            // Fetch All Kelurahan (Optional/Heavy)
            const kelRows = await fetchGeoData(4, code);
            if (kelRows.length > 0) result.kelurahan.data = toFeatureCollection(kelRows);
        }

        // 3. KECAMATAN (e.g. "11.01.01")
        else if (codeLen === 8) {
            // Fetch Parent Kabupaten (Context)
            const kabRows = await fetchGeoData(2, code.substring(0, 5));
            if (kabRows.length > 0) result.kabupaten.data = toFeatureCollection(kabRows);

            // Fetch Target Kecamatan
            const kecRows = await fetchGeoData(3, code);
            if (kecRows.length > 0) result.kecamatan.data = toFeatureCollection(kecRows);

            // Fetch All Kelurahan in Kecamatan
            const kelRows = await fetchGeoData(4, code);
            if (kelRows.length > 0) result.kelurahan.data = toFeatureCollection(kelRows);
        }

        // 4. KELURAHAN (e.g. "11.01.01.2001")
        else if (codeLen >= 13) {
            // Fetch Parent Kecamatan (Context)
            const kecRows = await fetchGeoData(3, code.substring(0, 8));
            if (kecRows.length > 0) result.kecamatan.data = toFeatureCollection(kecRows);

            // Fetch Target Kelurahan
            const kelRows = await fetchGeoData(4, code);
            if (kelRows.length > 0) result.kelurahan.data = toFeatureCollection(kelRows);
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
        features: rows.map(row => {
            let geometry = row.geom;
            if (typeof geometry === 'string') {
                try {
                    geometry = JSON.parse(geometry);
                } catch (e) {
                    console.error("Failed to parse geometry string:", e);
                    geometry = null;
                }
            }
            return {
                type: "Feature",
                properties: { name: row.name, id: row.id },
                geometry: geometry
            };
        })
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
