-- Enable PostGIS Extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Table: m_wilayah_poligon
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

-- Function: upsert_wilayah (Used for Sync)
DROP FUNCTION IF EXISTS upsert_wilayah(TEXT, TEXT, INT, JSONB);
DROP FUNCTION IF EXISTS upsert_wilayah(TEXT, TEXT, INT, JSON);

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

-- Function: get_wilayah_geojson (Used for Map)
-- Returns simplified GeoJSON for a given code prefix
CREATE OR REPLACE FUNCTION get_wilayah_geojson(p_code TEXT)
RETURNS TABLE (
    id TEXT,
    name TEXT,
    level INTEGER,
    geom JSON
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        kode_wilayah_kemendagri as id, 
        nama_wilayah_kemendagri as name, 
        m_wilayah_poligon.level, 
        ST_AsGeoJSON(geometry)::json as geom
    FROM m_wilayah_poligon
    WHERE kode_wilayah_kemendagri LIKE p_code || '%'
    -- Optimize: If fetching kab/kec/kel based on logic, we might need more specific queries.
    -- But for now, returning all matches is a start, or we can filter by level in the query.
    ;
END;
$$ LANGUAGE plpgsql;

-- Function: get_wilayah_by_level (Used for Map)
DROP FUNCTION IF EXISTS get_wilayah_by_level(INT, TEXT);

CREATE OR REPLACE FUNCTION get_wilayah_by_level(p_level INT, p_parent_code TEXT)
RETURNS TABLE (
    id TEXT,
    name TEXT,
    geom JSON
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m_wilayah_poligon.kode_wilayah_kemendagri::text, 
        m_wilayah_poligon.nama_wilayah_kemendagri::text, 
        ST_AsGeoJSON(m_wilayah_poligon.geometry)::json
    FROM m_wilayah_poligon
    WHERE m_wilayah_poligon.level = p_level 
    AND (
        (p_parent_code IS NULL) OR 
        (m_wilayah_poligon.kode_wilayah_kemendagri LIKE p_parent_code || '%')
    );
END;
$$ LANGUAGE plpgsql;

-- Function for Search
DROP FUNCTION IF EXISTS search_wilayah(TEXT);

CREATE OR REPLACE FUNCTION search_wilayah(p_query TEXT)
RETURNS TABLE (
    id TEXT,
    name TEXT,
    level INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m_wilayah_poligon.kode_wilayah_kemendagri::text, 
        m_wilayah_poligon.nama_wilayah_kemendagri::text, 
        m_wilayah_poligon.level
    FROM m_wilayah_poligon
    WHERE lower(m_wilayah_poligon.nama_wilayah_kemendagri) LIKE '%' || lower(p_query) || '%'
    ORDER BY m_wilayah_poligon.level ASC, m_wilayah_poligon.nama_wilayah_kemendagri ASC
    LIMIT 10;
END;
$$ LANGUAGE plpgsql;

-- Function for Status (Count by Level)
CREATE OR REPLACE FUNCTION get_wilayah_counts()
RETURNS TABLE (
    level INTEGER,
    count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT m_wilayah_poligon.level, count(*) 
    FROM m_wilayah_poligon 
    GROUP BY m_wilayah_poligon.level;
END;
$$ LANGUAGE plpgsql;
