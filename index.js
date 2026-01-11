console.log(">>> SPAUŠTĚNÍ WEB UI V11 (NO SDK - MANUAL ROUTING) <<<");

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v11";
const CACHE_MAX_AGE = 4 * 60 * 60; 
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';

// --- MANIFEST OBJEKT (Manuální definice) ---
const manifestObj = {
    id: 'community.subsplease.rd.v11',
    version: '3.0.0',
    name: ADDON_NAME,
    description: 'SubsPlease + Real-Debrid Addon v11 (No SDK)',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['movie', 'series'],
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [{ type: 'movie', id: 'subsplease-feed', name: 'Nejnovější epizody' }],
    // behaviorHints: { configurationRequired: false } 
};

// --- MIDDLEWARE ---
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.writeHead(204).end();
    }
    next();
});

// --- POMOCNÉ FUNKCE ---

// Parsování configu z query parametrů (např. ?token=...)
const getReqConfig = (req) => {
    // 1. Přímý parametr z instalace
    if (req.query.token) return { rd_token: req.query.token };
    
    // 2. JSON parametr 'extra'
    if (req.query.extra) {
        try {
            const parsed = JSON.parse(req.query.extra);
            return parsed;
        } catch (e) {
            console.error("Chyba parsování extra:", e);
        }
    }
    
    // 3. JSON parametr 'config'
    if (req.query.config) {
        try {
            return JSON.parse(req.query.config);
        } catch (e) {}
    }
    return {};
};

const getRdKey = (req) => {
    const config = getReqConfig(req);
    if (config.rd_token) return config.rd_token;
    return null;
};

// --- REAL-DEBRID API ---
async function getRdStreamLink(magnetLink, rdToken) {
    try {
        const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        const torrentId = addRes.data.id;
        
        const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        let files = infoRes.data.files || [];
        let fileId = "all";
        if (files.length > 0) {
            const videoFiles = files.filter(f => f.path.match(/\.(mp4|mkv|avi)$/i));
            if (videoFiles.length > 0) {
                videoFiles.sort((a, b) => b.bytes - a.bytes);
                fileId = videoFiles[0].id;
            }
        }
        
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
            `files=${fileId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        
        const linksRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        
        if (linksRes.data.links && linksRes.data.links.length > 0) {
            return linksRes.data.links[0];
        } else {
            throw new Error("Link není připraven.");
        }
    } catch (error) {
        console.error("RD Error:", error.response?.data || error.message);
        throw error;
    }
}

// --- HANDLERS (Jako samostatné funkce) ---

const catalogHandler = async (config) => {
    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        const metas = items.map(item => {
            const title = item.title?.[0] || "Unknown";
            const pubDate = item.pubDate?.[0] || "";
            const descHtml = item.description?.[0] || "";
            const match = descHtml.match(/href="([^"]+)"/);
            const magnetLink = match ? match[1] : null;
            const id = `subsplease:${Buffer.from(title).toString('base64').substring(0, 20)}`;
            return {
                id: id,
                type: 'movie',
                name: title,
                poster: `https://picsum.photos/seed/${encodeURIComponent(title)}/200/300`,
                description: `Vydáno: ${new Date(pubDate).toLocaleString()}`,
                subsplease_magnet: magnetLink 
            };
        });
        return { metas };
    } catch (error) {
        console.error("RSS Error:", error.message);
        return { metas: [] };
    }
};

const streamHandler = async (id, extra) => {
    const rdToken = extra.rd_token; // Používáme extra z requestu
    if (!rdToken) throw new Error("Chybí RD token.");

    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        const decodedTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
        const item = items.find(i => (i.title?.[0] || "").startsWith(decodedTitle.substring(0, 15)));
        
        if (!item || !item.description?.[0]) throw new Error("Item nenalezen.");
        const descHtml = item.description[0];
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;

        if (!magnetLink) throw new Error("Magnet nenalezen.");

        const rdLink = await getRdStreamLink(magnetLink, rdToken);
        return { streams: [{ title: `RD 1080p`, url: rdLink }] };
    } catch (error) {
        console.error(error);
        throw error;
    }
};

// --- ROUTING (MANUÁLNÍ - BEZ SDK) ---

// 1. Manifest
app.get('/manifest.json', (req, res) => {
    console.log("GET /manifest.json");
    res.json(manifestObj);
});

// 2. Catalog (Stremio volá např. /catalog/catalog/movie/subsplease-feed.json)
app.get('/catalog/catalog/movie/subsplease-feed.json', async (req, res) => {
    console.log("GET /catalog");
    try {
        const config = getReqConfig(req);
        const data = await catalogHandler(config);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Stream (Stremio volá např. /stream/movie/someId.json)
app.get('/stream/movie/:id', async (req, res) => {
    console.log("GET /stream");
    // Express zachytí ID i s koncovkou .json nebo bez, musíme ji případně očistit
    let id = req.params.id;
    if (id.endsWith('.json')) id = id.substring(0, id.length - 5);

    try {
        const extra = getReqConfig(req);
        const data = await streamHandler(id, extra);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Web UI
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/ui.html');
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server běží na portu: ${PORT}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
});