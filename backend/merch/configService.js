import pool from '../db/pool.js';

class ConfigService {
    async getIntegration(service, regionCode = null) {
        const query = regionCode 
            ? `SELECT i.config 
               FROM integrations i
               JOIN regions r ON r.id = i.region_id
               WHERE i.service = $1 
               AND r.code = $2 
               AND i.is_active = true`
            : `SELECT config 
               FROM integrations 
               WHERE service = $1 
               AND region_id IS NULL 
               AND is_active = true`;
        
        const params = regionCode ? [service, regionCode] : [service];
        const result = await pool.query(query, params);
        return result.rows[0]?.config || null;
    }

    async getAllRegions() {
        const result = await pool.query(
            'SELECT id, code, name FROM regions WHERE is_active = true ORDER BY code'
        );
        return result.rows;
    }

    async getRegionByCode(code) {
        const result = await pool.query(
            'SELECT id, code, name FROM regions WHERE code = $1 AND is_active = true',
            [code]
        );
        return result.rows[0] || null;
    }
}

export default new ConfigService();
