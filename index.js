console.log(">>> SPAUŠTĚNÍ WEB UI V13 (ANILIST METADATA) <<<");

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v13";
const CACHE_MAX_AGE = 4 * 60 * 60; 
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';
const ANILIST_API = 'https://graphql.anilist.co';

// Cache pro metadata, abychom nezahltili API
const metadataCache = new Map();

// --- MANIFEST OBJEKT ---
const manifestObj = {
    id: 'community.subsplease.rd.v13',
    version: '4.0.0',
    name: ADDON_NAME,
    description: 'SubsPlease + Real-Debrid Addon s AniList metadaty',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['series', 'movie'], // Přidány types
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [{ type: 'series', id: 'subsplease-feed', name: 'Nejnovější epizody' }],
    behaviorHints: {
        // Nastavení pro lepší zobrazení v seznamu
        configurable: false
    }
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

// --- ANILIST INTEGRACE ---
async function getAniListMeta(title) {
    // Pokud už máme data v cache, vrátíme je
    if (metadataCache.has(title)) {
        return metadataCache.get(title);
    }

    try {
        // Příprava GraphQL dotazu
        // Hledáme anime podle názvu (AniList fuzzy search umí zpracovat "One Piece 1093")
        const query = `
            query ($search: String) {
              Media(search: $search, type: ANIME) {
                id
                title { romaji english }
                description
                coverImage { extraLarge large }
                bannerImage
                genres
                status
                seasonYear
                averageScore
              }
            }
        `;

        const response = await axios.post(ANILIST_API, {
            query,
            variables: { search: title }
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        const media = response.data.data.Media;
        if (media) {
            metadataCache.set(title, media);
            return media;
        }
        return null;
    } catch (error) {
        console.error("AniList API Error:", error.response?.status, error.response?.statusText);
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
    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        // Mapování položek s načítáním metadat
        const metas = await Promise.all(items.map(async (item) => {
            const title = item.title?.[0] || "Unknown";
            const pubDate = item.pubDate?.[0] || "";
            const descHtml = item.description?.[0] || "";
            const match = descHtml.match(/href="([^"]+)"/);
            const magnetLink = match ? match[1] : null;
            
            // Generování ID (stejné jako předtím pro kompatibilitu streamů)
            const id = `subsplease:${Buffer.from(title).toString('base64').substring(0, 20)}`;

            // Získání metadat z AniList
            const aniData = await getAniListMeta(title);

            // Vrácení meta objektu se sloučením dat
            return {
                id: id,
                type: 'series', // Změna z movie na series pro lepší metadata
                name: aniData ? (aniData.title.english || aniData.title.romaji) : title,
                poster: aniData ? aniData.coverImage.extraLarge : `https://picsum.photos/seed/${encodeURIComponent(title)}/200/300`,
                background: aniData ? aniData.bannerImage : `https://picsum.photos/seed/bg/${encodeURIComponent(title)}/1200/600`,
                description: aniData 
                    ? aniData.description.replace(/<[^>]*>/g, '').substring(0, 500) + "..." 
                    : `Vydáno: ${new Date(pubDate).toLocaleString()} (SubsPlease)`,
                genres: aniData ? aniData.genres : ['Anime'],
                // Uložíme magnet do custom vlastnosti pro stream handler
                subsplease_magnet: magnetLink,
                originalTitle: title
            };
        }));
        return { metas };
    } catch (error) {
        console.error("RSS Error:", error.message);
        return { metas: [] };
    }
};

const metaHandler = async (id, extra) => {
    const decodedTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
    
    try {
        // Zkusíme znovu najít v RSS kvůli magnetu, ale hlavní informace vezmeme z AniList
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        const item = items.find(i => (i.title?.[0] || "").startsWith(decodedTitle.substring(0, 15)));
        if (!item) throw new Error("Item nenalezen.");

        const title = item.title[0];
        const aniData = await getAniListMeta(title);

        return { 
            meta: {
                id: id,
                type: 'series',
                name: aniData ? (aniData.title.english || aniData.title.romaji) : title,
                poster: aniData ? aniData.coverImage.extraLarge : '',
                background: aniData ? aniData.bannerImage : '',
                description: aniData ? aniData.description : '',
                genres: aniData ? aniData.genres : [],
                videos: aniData ? [{ title: title, released: new Date().toISOString() }] : []
            }
        };
    } catch (error) {
        console.error("Meta Error:", error);
        return { meta: null };
    }
};

const streamHandler = async (id, extra) => {
    const rdToken = extra.rd_token;
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
    console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
});