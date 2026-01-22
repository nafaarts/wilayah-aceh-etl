const { createServerClient } = require('@supabase/ssr');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

/**
 * Create a Supabase client for Server-Side Rendering (SSR) context.
 * Useful for handling authentication with cookies in Express.
 * 
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 */
const createSupabaseClient = (req, res) => {
    return createServerClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
        {
            cookies: {
                getAll() {
                    return req.cookies;
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        res.cookie(name, value, options);
                    });
                },
            },
        }
    );
};

// Create a Supabase Admin Client for backend operations (bypasses RLS if using Service Key)
const supabaseAdmin = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

module.exports = { createSupabaseClient, supabaseAdmin };