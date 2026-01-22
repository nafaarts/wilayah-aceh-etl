const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
const isSupabase = process.env.DB_PROVIDER === 'SUPABASE';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/wilayah_aceh';

const pool = new Pool({
    connectionString: connectionString,
    ssl: isSupabase || (isProduction && !connectionString.includes('localhost'))
        ? { rejectUnauthorized: false }
        : false
});

module.exports = pool;