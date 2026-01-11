console.log(">>> SPAUŠTĚNÍ WEB UI V18 (DEBUG & SAFE DESC) <<<");

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v18";
const CACHE_MAX_AGE = 4 * 60 * 60; 
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';
const ANILIST_API = 'https://graphql.anilist.co';

// CACHE & PROMĚNNÉ
let rssItems = [];
let metadataCache = new Map(); 

// --- MANIFEST OBJEKT ---
const manifestObj = {
    id: 'community.subsplease.rd.v18',
    version: '8.0.0',
    name: ADDON_NAME,
    description: 'SubsPlease Addon - Debug Version',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['series'],
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [{ type: 'series', id: 'subsplease-feed', name: 'Nejnovější epizody' }],
    behaviorHints: { configurable: false }
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

const getReqConfig = (req) => {
    if (req.query.token) return { rd_token: req.query.token };
    if (req.query.config) try { return JSON.parse(req.query.config); } catch (e) {}
    if (req.query.extra) try { return JSON.parse(req.query.extra); } catch (e) {}
    return {};
};

const getRdKey = (req) => {
    const config = getReqConfig(req);
    return config.rd_token || null;
};

// Aktualizace RSS
async function updateRssCache() {
    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        rssItems = result.rss?.channel?.[0]?.item || [];
        console.log(`RSS Cache aktualizována. Načteno ${rssItems.length} položek.`);
    } catch (error) {
        console.error("Chyba aktualizace RSS Cache:", error.message);
    }
}
updateRssCache();
setInterval(updateRssCache, 5 * 60 * 1000);

// Extrakt názvu
function extractSeriesName(fullTitle) {
    let clean = fullTitle.replace(/\[.*?\]/g, '').trim();
    const parts = clean.split(/\s+-\s+/);
    return parts[0].trim();
}

// --- ANILIST INTEGRACE ---
async function getAniListMeta(fullTitle) {
    const seriesName = extractSeriesName(fullTitle);
    if (metadataCache.has(seriesName)) return metadataCache.get(seriesName);

    const query = `
        query ($search: String) {
          Media(search: $search, type: ANIME) {
            id
            title { romaji english native }
            description
            coverImage { extraLarge large }
            bannerImage
            genres
          }
        }
    `;

    try {
        const response = await axios.post(ANILIST_API, {
            query,
            variables: { search: seriesName }
        }, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });

        const media = response.data?.data?.Media;
        if (media) {
            console.log(`AniList nalezeno: ${seriesName}`);
            metadataCache.set(seriesName, media);
            return media;
        } else {
            console.log(`AniList nenašl: ${seriesName}`);
        }
        return null;
    } catch (error) {
        console.error(`AniList Error pro ${seriesName}:`, error.response?.status, error.message);
        return null;
    }
}

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

// --- HANDLERS ---

const catalogHandler = async (config) => {
    if (rssItems.length === 0) await new Promise(r => setTimeout(r, 1000));

    const metas = rssItems.map(item => {
        const title = item.title?.[0] || "Unknown";
        const pubDate = item.pubDate?.[0] || "";
        const descHtml = item.description?.[0] || "";
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;
        const id = `subsplease:${Buffer.from(title).toString('base64')}`;
        const seriesName = extractSeriesName(title);
        const poster = `https://ui-avatars.com/api/?name=${encodeURIComponent(seriesName)}&background=6c5ce7&color=fff&size=300&font-size=0.3`;

        return {
            id: id,
            type: 'series',
            name: title,
            poster: poster,
            background: `https://picsum.photos/seed/bg/${encodeURIComponent(seriesName)}/1200/600`,
            description: `Vydáno: ${new Date(pubDate).toLocaleString()}\nSeriál: ${seriesName}`,
            subsplease_magnet: magnetLink,
            originalTitle: title
        };
    });
    return { metas };
};

const metaHandler = async (id, extra) => {
    console.log(`--- DEBUG META START ---`);
    try {
        const originalTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
        console.log(`Step 1: Decoded Title: ${originalTitle}`);
        
        const aniData = await getAniListMeta(originalTitle);
        console.log(`Step 2: AniList Data: ${aniData ? 'OK' : 'NULL'}`);
        
        const seriesName = extractSeriesName(originalTitle);
        console.log(`Step 3: Series Name: ${seriesName}`);
        
        // BEZPEČNÉ ZÍSKÁNÍ DAT
        const safeTitle = (aniData?.title?.english || aniData?.title?.romaji || originalTitle).substring(0, 200);
        const safePoster = aniData?.coverImage?.extraLarge || aniData?.coverImage?.large || `https://ui-avatars.com/api/?name=${encodeURIComponent(seriesName)}&background=6c5ce7&color=fff&size=300&font-size=0.3`;
        const safeBanner = aniData?.bannerImage || `https://picsum.photos/seed/bg/${encodeURIComponent(seriesName)}/1200/600`;
        
        // Zjednodušení popisku - odstranění regex replace kvůli pádům
        let safeDesc = "";
        if (aniData && aniData.description && typeof aniData.description === 'string') {
            // Použijeme jen substring, nebudeme dělat regex replace
            safeDesc = aniData.description.substring(0, 500) + "...";
        } else {
            safeDesc = `Seriál: ${seriesName}`;
        }
        console.log(`Step 4: Data prepared.`);
        
        const resultMeta = {
            id: id,
            type: 'series',
            name: safeTitle,
            poster: safePoster,
            background: safeBanner,
            description: safeDesc,
            genres: aniData?.genres || ['Anime'],
            videos: [{ title: originalTitle, released: new Date().toISOString() }]
        };
        
        console.log(`Step 5: Returning Meta.`);
        console.log(`--- DEBUG META END ---`);
        
        return { meta: resultMeta };
    } catch (error) {
        console.error("!!! META CRASH !!!", error.message);
        console.error(error.stack);
        return { meta: null };
    }
};

const streamHandler = async (id, extra) => {
    const rdToken = extra.rd_token;
    if (!rdToken) throw new Error("Chybí RD token.");

    try {
        const originalTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
        const item = rssItems.find(i => (i.title?.[0] || "") === originalTitle);
        
        if (!item || !item.description?.[0]) {
            throw new Error("Epizoda nenalezena v RSS cache.");
        }
        const descHtml = item.description[0];
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;

        if (!magnetLink) throw new Error("Magnet nenalezen.");
        const rdLink = await getRdStreamLink(magnetLink, rdToken);
        return { streams: [{ title: `RD 1080p`, url: rdLink }] };
    } catch (error) {
        console.error("Stream Error:", error.message);
        throw error;
    }
};

// --- ROUTING ---

app.get('/manifest.json', (req, res) => {
    console.log("GET /manifest.json");
    res.json(manifestObj);
});

app.get('/catalog/:type/:id.json', async (req, res) => {
    console.log(`GET /catalog/${req.params.type}/${req.params.id}.json`);
    try {
        const config = getReqConfig(req);
        const data = await catalogHandler(config);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/meta/:type/:id.json', async (req, res) => {
    console.log(`GET /meta/${req.params.type}/${req.params.id}.json`);
    let id = req.params.id;
    if (id.endsWith('.json')) id = id.substring(0, id.length - 5);
    
    try {
        const extra = getReqConfig(req);
        const data = await metaHandler(id, extra);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    console.log(`GET /stream/${req.params.type}/${req.params.id}.json`);
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

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/ui.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server běží na portu: ${PORT}`);
});